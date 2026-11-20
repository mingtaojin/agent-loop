import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { taskSchema } from '../src/domain.js';
import { startDashboard } from '../src/dashboard.js';
import { LiveExecution } from '../src/live-execution.js';
import { executionKey } from '../src/execution-events.js';
import { ExecutionFixture } from './execution-fixture.js';

const task = () => taskSchema.parse({ id: 'task', sourceId: 'source', source: { kind: 'manual', message: { id: 'original', chatId: 'private', senderId: 'owner', text: 'Business question', attachments: [], createdAt: 1 } },
  contextDirectory: '/tmp', resources: [], status: 'running', reason: null, prompt: '', promptHash: '', skillPath: null, chatId: 'chat', threadId: 'thread', turnId: 'turn', executionStatus: 'running', lastHandledTurnId: null, requests: [], createdAt: 1, updatedAt: 1 });
const event = (text: string) => ({ threadId: 'thread', turnId: 'turn', itemId: 'item', kind: 'agent_message' as const, label: 'Agent', text, createdAt: 2 });

async function streamText(url: string): Promise<string> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 2000);
  try {
    const response = await fetch(url, { signal: abort.signal });
    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes('event: reset')) { const result = await reader.read(); if (result.done) break; text += new TextDecoder().decode(result.value); }
    return text;
  } finally { clearTimeout(timeout); abort.abort(); }
}

test('detail rehydrates from Codex across process restart, retains business records on outage and resets old SSE cursors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-history-'));
  const store = new Store(directory); store.saveTask(task());
  store.receive('task', { id: 'input', chatId: 'chat', chatType: 'group', senderId: 'owner', text: 'Business input', attachments: [], createdAt: 1 });
  store.enqueue('task', 'Business final output', 'output');
  const source = new ExecutionFixture(); source.publish('task', event('Codex owned historical text'));
  let dashboard = await startDashboard({ dataDir: directory, port: 0, host: '127.0.0.1', execution: source.execution });
  t.after(async () => { await dashboard.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  for (let i = 0; i < 3; i++) await fetch(dashboard.url + '/api/snapshot');
  assert.deepEqual(source.reads, []);
  const first = await (await fetch(dashboard.url + '/api/tasks/task')).json();
  assert.equal(first.history.kind, 'available'); assert.match(JSON.stringify(first.timeline), /Codex owned historical text/);
  await dashboard.close(); source.restart();
  dashboard = await startDashboard({ dataDir: directory, port: 0, host: '127.0.0.1', execution: source.execution });
  assert.deepEqual(source.execution.current('task'), []);
  const second = await (await fetch(dashboard.url + '/api/tasks/task')).json();
  assert.match(JSON.stringify(second.timeline), /Codex owned historical text/); assert.notEqual(first.cursor, second.cursor);
  assert.match(await streamText(dashboard.url + '/api/events?taskId=task&after=' + encodeURIComponent(first.cursor)), /event: reset/);
  source.unavailable = true;
  const unavailable = await (await fetch(dashboard.url + '/api/tasks/task')).json();
  assert.equal(unavailable.history.kind, 'unavailable');
  assert.equal(unavailable.inputs[0].text, 'Business input'); assert.equal(unavailable.outputs[0].text, 'Business final output');
  assert.match(JSON.stringify(unavailable.timeline), /Business input/);
});

test('task binding is revalidated after history awaits, and fetch-to-subscribe rotation requests reset', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-binding-'));
  const store = new Store(directory); store.saveTask(task());
  let release!: () => void, entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const execution = new LiveExecution({ readHistory: async threadId => {
    if (threadId === 'thread') { entered(); await new Promise<void>(resolve => { release = resolve; }); }
    const item = { ...event(threadId === 'thread' ? 'obsolete' : 'current'), threadId };
    return [{ ...item, key: executionKey(item) }];
  } });
  const dashboard = await startDashboard({ dataDir: directory, port: 0, host: '127.0.0.1', execution });
  t.after(async () => { await dashboard.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const request = fetch(dashboard.url + '/api/tasks/task'); await reading;
  store.saveTask({ ...task(), threadId: 'replacement' }); release();
  const detail = await (await request).json();
  assert.equal(detail.threadId, 'replacement'); assert.doesNotMatch(JSON.stringify(detail.timeline), /obsolete/);
  store.saveTask({ ...task(), threadId: 'newer' });
  assert.match(await streamText(dashboard.url + '/api/events?taskId=task&threadId=replacement&after=' + encodeURIComponent(detail.cursor)), /event: reset/);
});


test('an unbound subscription stays open and detaches synchronously when its task disappears', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-unbound-'));
  const store = new Store(directory); store.saveTask({ ...task(), threadId: null, turnId: null });
  const execution = new LiveExecution();
  const subscribe = execution.subscribe.bind(execution);
  let subscribed = 0, delivered = 0;
  execution.subscribe = listener => {
    subscribed++;
    const detach = subscribe(change => { delivered++; listener(change); });
    return () => { subscribed--; detach(); };
  };
  const dashboard = await startDashboard({ dataDir: directory, port: 0, host: '127.0.0.1', execution });
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await dashboard.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const response = await fetch(dashboard.url + '/api/events?taskId=task&threadId=&after=' + encodeURIComponent(execution.cursor), { signal: abort.signal });
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.doesNotMatch(first, /event: reset/);
  assert.equal(subscribed, 1);
  const db = new DatabaseSync(join(directory, 'tasks.sqlite'));
  try { db.exec('DELETE FROM tasks'); } finally { db.close(); }
  execution.publish('other', event('one'));
  assert.equal(subscribed, 0);
  execution.publish('other', event('two'));
  assert.equal(delivered, 1);
  const rest = new TextDecoder().decode((await reader.read()).value);
  assert.match(rest, /event: reset/);
  assert.equal((await reader.read()).done, true);
});

test('a task removed during a history read returns not found', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-removed-'));
  const store = new Store(directory); store.saveTask(task());
  let release!: () => void, entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const execution = new LiveExecution({ readHistory: async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return []; } });
  const dashboard = await startDashboard({ dataDir: directory, port: 0, host: '127.0.0.1', execution });
  t.after(async () => { await dashboard.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const request = fetch(dashboard.url + '/api/tasks/task'); await reading;
  const db = new DatabaseSync(join(directory, 'tasks.sqlite'));
  try { db.exec('DELETE FROM tasks'); } finally { db.close(); }
  release();
  assert.equal((await request).status, 404);
});
