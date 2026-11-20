import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configSchema } from '../src/config.js';
import { ConfigCredential, credentialSafeLogger, publicJson, redactCredentials } from '../src/credentials.js';
import { errorMessage, taskSchema } from '../src/domain.js';
import { Store } from '../src/store.js';
import { ProjectLedger } from '../src/project.js';
import { startDashboard } from '../src/dashboard.js';
import { ExecutionFixture } from './execution-fixture.js';
import { testExecution } from './test-config.js';

const secrets = ['synthetic-redaction-app-id', 'synthetic-redaction-app-secret-"\\\n-end', 'synthetic-redaction-github-token'];
const payload = secrets.join(' | ');
const config = () => configSchema.parse({ execution: testExecution, github: { token: secrets[2] },
  feishu: { appId: secrets[0], appSecret: secrets[1], userOpenId: 'owner' } });
function assertRedacted(text: string) {
  for (const value of secrets) {
    assert.equal(text.includes(value), false);
    assert.equal(text.includes(JSON.stringify(value).slice(1, -1)), false);
    assert.equal(text.includes(encodeURIComponent(value)), false);
  }
  assert.match(text, /REDACTED/);
}

test('parsed credentials stay usable by clients and serialize safely in config exports and errors', () => {
  const value = config();
  assert.equal(value.feishu.appId.require('feishu.appId'), secrets[0]);
  assert.equal(value.feishu.appSecret.require('feishu.appSecret'), secrets[1]?.trim());
  assertRedacted(JSON.stringify(value));
  assertRedacted(JSON.stringify({ ...value.feishu }));
  assertRedacted(inspect(value, { depth: 10 }));
  assertRedacted(String(value.feishu.appSecret));
  assertRedacted(publicJson({ nested: payload, encoded: encodeURIComponent(secrets[0]!) }));
  assertRedacted(errorMessage(new Error(payload)));
});

test('URI and form encodings and object keys are redacted in storage and SDK logs', async t => {
  const secret = 'synthetic?a~b +/文!()';
  new ConfigCredential(secret);
  const variants = [secret, encodeURI(secret), encodeURIComponent(secret), new URLSearchParams({ secret }).toString().slice(7)];
  variants.push(...variants.map(value => value.replace(/%[0-9A-F]{2}/g, code => code.toLowerCase())));
  const root = await mkdtemp(join(tmpdir(), 'encoded-redaction-'));
  const store = new Store(root);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const logging = t.mock.method(process.stderr, 'write', () => true);
  for (const value of variants) {
    assert.equal(redactCredentials(value), '[REDACTED]');
    const json = publicJson({ [value]: { text: `credential=${value}` } });
    assert.deepEqual(JSON.parse(json), { '[REDACTED]': { text: 'credential=[REDACTED]' } });
    store.diagnostic('encoding', value);
    store.setMeta('encoded-report', JSON.stringify({ [value]: value }));
    assert.deepEqual(JSON.parse(store.meta('encoded-report')!), { '[REDACTED]': '[REDACTED]' });
    credentialSafeLogger.error({ [value]: value });
  }
  assert.ok(store.diagnostics().every(row => row.message === '[REDACTED]'));
  for (const call of logging.mock.calls) {
    const text = String(call.arguments[0]);
    for (const value of variants) assert.equal(text.includes(value), false);
    assert.match(text, /REDACTED/);
  }
});

test('credential substrings preserve ordinary persisted words and JSON structure', async t => {
  new ConfigCredential('alpha');
  assert.equal(redactCredentials('prefix alpha suffix'), 'prefix alpha suffix');
  assert.equal(redactCredentials('alphabet'), 'alphabet');
  assert.deepEqual(JSON.parse(publicJson({ alphabet: 'alphabet alphanumeric alpha_suffix', exact: 'alpha', sentence: 'token=alpha' })), {
    alphabet: 'alphabet alphanumeric alpha_suffix', exact: '[REDACTED]', sentence: 'token=[REDACTED]',
  });
  const root = await mkdtemp(join(tmpdir(), 'collision-redaction-'));
  const store = new Store(root);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.setMeta('normal-state', JSON.stringify({ alphabet: 'alphabet' }));
  store.diagnostic('alphabet', 'alphabet');
  assert.equal(store.meta('normal-state'), '{"alphabet":"alphabet"}');
  assert.equal(store.diagnostics()[0]?.message, 'alphabet');
  assert.equal(store.diagnostics()[0]?.scope, 'alphabet');
  const shared = ['alphabet'];
  const date = new Date('2026-11-20T00:00:00Z');
  assert.equal(publicJson({ shared, again: shared, date }), JSON.stringify({ shared, again: shared, date }));
});

test('diagnostics, task snapshots, reports, dashboard detail and SSE do not disclose configured credentials', async t => {
  config();
  const root = await mkdtemp(join(tmpdir(), 'redaction-store-'));
  const store = new Store(root), source = new ExecutionFixture();
  let storeClosed = false;
  const now = Date.now();
  const task = taskSchema.parse({ id: 'worker', sourceId: 'redaction-source', source: { kind: 'manual', message: {
    id: 'redaction-message', chatId: 'chat', senderId: 'owner', text: payload, attachments: [], createdAt: now, chatType: 'group',
  } }, purpose: 'execution', contextDirectory: root, resources: [], status: 'running', reason: payload, prompt: payload,
  promptHash: 'hash', skillPath: null, chatId: 'chat', threadId: 'thread', turnId: 'turn', executionStatus: 'running',
  lastHandledTurnId: null, requests: [], recovery: { attempts: 0, nextAttemptAt: null, lastError: null, interruptedTurnId: null, lastUserInputSeq: null }, createdAt: now, updatedAt: now });
  store.saveTask(task);
  const ledger = new ProjectLedger(store);
  ledger.create({ id: 'project', name: 'Project', directory: root, repositories: [], instructions: '' }, task.id);
  store.receive(task.id, { id: 'report', chatId: 'chat', senderId: 'runtime:project', text: payload, attachments: [], createdAt: now, chatType: 'group' },
    'source', { kind: 'agent', projectId: 'project', taskId: task.id, eventId: 'report:worker:result', category: 'result', routing: 'final' });
  store.setMeta('project-report-test', JSON.stringify({ text: payload }));
  store.diagnostic('redaction', payload);
  const outputId = store.enqueue(task.id, payload, 'redaction-output');
  store.markOutput(outputId, 'uncertain', payload);
  assertRedacted(JSON.stringify(store.diagnostics()));
  assertRedacted(JSON.stringify(store.task(task.id)));
  assertRedacted(JSON.stringify(store.outputs(task.id)));
  assertRedacted(store.meta('project-report-test') ?? '');
  const dashboard = await startDashboard({ execution: source.execution, dataDir: root, port: 0 });
  t.after(async () => { await dashboard.close(); if (!storeClosed) store.close(); await rm(root, { recursive: true, force: true }); });
  for (const path of ['/api/snapshot', '/api/projects', `/api/tasks/${task.id}`]) {
    const response = await fetch(dashboard.url + path);
    assert.equal(response.status, 200); assertRedacted(await response.text());
  }
  assert.equal((await fetch(dashboard.url + '/api/config')).status, 404);
  const before = source.execution.cursor;
  source.publish(task.id, { threadId: 'thread', turnId: 'turn', itemId: 'error', kind: 'error', label: payload, text: payload, createdAt: now });
  const abort = new AbortController();
  const response = await fetch(dashboard.url + `/api/events?taskId=${task.id}&after=${before}`, { signal: abort.signal });
  const reader = response.body!.getReader();
  let stream = '';
  try {
    while (!stream.includes('event: execution')) {
      const item = await reader.read(); assert.equal(item.done, false); stream += new TextDecoder().decode(item.value);
    }
    assertRedacted(stream);
  } finally { abort.abort(); await reader.cancel().catch(() => undefined); }
  store.close(); storeClosed = true;
  for (const name of ['tasks.sqlite', 'tasks.sqlite-wal']) {
    const bytes = await readFile(join(root, name)).catch(() => Buffer.alloc(0));
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret.trim())), false);
  }
});
