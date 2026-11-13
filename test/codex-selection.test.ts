import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { CodexAppServer } from './helpers/codex.js';
import type { WorkspaceSelectionRequest } from '../src/domain.js';

const recordSchema = z.object({ pid: z.number(), method: z.string().optional(), params: z.unknown().optional() });
async function fixture(t: TestContext, mode = 'repository') {
  const root = await mkdtemp('/tmp/agent-loop-selector-');
  const recordPath = join(root, 'requests.jsonl');
  const server = new CodexAppServer({ command: [process.execPath, resolve('test/fixtures/workspace-selection-codex.mjs'), mode, recordPath], approvalPolicy: 'on-request', sandbox: 'danger-full-access', requestTimeoutMs: 1000 });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const input: WorkspaceSelectionRequest = { taskId: 'task-1', cwd: root, candidates: [{ name: 'example/project', path: '/configured/repository', workspace: { kind: 'project-directory', path: '/configured/project' } }], input: [{ kind: 'text', text: 'Original task evidence' }], answers: [{ inputId: 'reply-1', text: 'Previously confirmed directory answer' }] };
  const records = async () => (await readFile(recordPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => recordSchema.parse(JSON.parse(line)));
  const waitForTurn = async () => {
    for (let attempt = 0; attempt < 100; attempt++) { if ((await records()).some(row => row.method === 'turn/start')) return; await delay(10); }
    throw new Error('Selector did not start its fixture turn');
  };
  return { root, server, input, records, waitForTurn };
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

for (const mode of ['repository', 'none', 'question', 'early-completion']) test(`isolated selector returns ${mode} from completion events and releases its process`, async t => {
  const f = await fixture(t, mode);
  const result = await f.server.selectWorkspace(f.input);
  assert.equal(result.choice.kind, mode === 'none' || mode === 'question' ? mode : 'repository');
  assert.match(result.temporaryThreadId, /^temporary-/);
  const rows = await f.records();
  assert.equal(new Set(rows.map(row => row.pid)).size, 1);
  assert.ok(rows.every(row => !['thread/resume', 'thread/turns/list'].includes(row.method ?? '')));
  assert.equal(alive(rows[0]!.pid), false);
  const started = rows.find(row => row.method === 'turn/start'); assert.ok(started);
  assert.match(JSON.stringify(started.params), /Original task evidence/);
  assert.match(JSON.stringify(started.params), /Previously confirmed directory answer/);
});

for (const mode of ['wrong-cwd', 'wrong-policy', 'wrong-sandbox', 'malformed', 'unknown-repository', 'failed', 'crash', 'approval']) test(`selector rejects ${mode} and releases its process`, async t => {
  const f = await fixture(t, mode);
  await assert.rejects(f.server.selectWorkspace(f.input));
  const rows = await f.records(); assert.ok(rows[0]);
  assert.equal(alive(rows[0].pid), false);
});

test('temporary selection does not enter formal events, history, output or directory configuration', async t => {
  const f = await fixture(t);
  const eventTexts: string[] = [];
  f.server.setEventHandler(event => { eventTexts.push(event.text); });
  const threadId = await f.server.createThread({ cwd: f.root, instructions: 'Formal task instructions' });
  await f.server.startTurn({ threadId, input: [{ kind: 'text', text: 'Formal task' }], deliveryId: 'formal-input' });
  const before = await f.server.inspect(threadId);
  const result = await f.server.selectWorkspace(f.input);
  assert.notEqual(result.temporaryThreadId, threadId);
  assert.deepEqual(await f.server.inspect(threadId), before);
  assert.equal(eventTexts.some(text => text.includes('Temporary directory selection')), false);
  assert.ok(before.outputs.some(output => output.text === 'Formal task result'));
  const rows = await f.records();
  const starts = rows.filter(row => row.method === 'thread/start'); assert.equal(starts.length, 2);
  const params = starts.map(row => z.object({ ephemeral: z.boolean(), sandbox: z.string(), approvalPolicy: z.string() }).parse(row.params));
  assert.deepEqual(params, [{ ephemeral: false, sandbox: 'danger-full-access', approvalPolicy: 'on-request' }, { ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' }]);
});

test('aborting an active selector rejects promptly and releases only its child process', async t => {
  const f = await fixture(t, 'slow'); const controller = new AbortController();
  const pending = f.server.selectWorkspace({ ...f.input, signal: controller.signal });
  const rejected = assert.rejects(pending, /abort/i);
  await f.waitForTurn(); controller.abort(); await rejected;
  assert.equal(alive((await f.records())[0]!.pid), false);
  const formalId = await f.server.createThread({ cwd: f.root, instructions: 'Formal thread remains available' });
  assert.match(formalId, /^formal-/);
});

test('closing the owner cancels active selectors by interrupting their owned ephemeral turn', async t => {
  const f = await fixture(t, 'slow');
  const pending = f.server.selectWorkspace(f.input);
  const rejected = assert.rejects(pending, /closed|closing/i);
  await f.waitForTurn(); await f.server.close(); await rejected;
  const rows = await f.records(); assert.equal(alive(rows[0]!.pid), false);
  assert.ok(rows.some(row => row.method === 'turn/interrupt'));
});

test('an already aborted selection does not start a protocol process', async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.server.selectWorkspace({ ...f.input, signal: controller.signal }));
  assert.deepEqual(await f.records(), []);
});

test('temporary selection uses the configured selection model while the formal thread keeps the main model', async t => {
  const root = await mkdtemp('/tmp/agent-loop-selector-model-');
  const recordPath = join(root, 'requests.jsonl');
  const server = new CodexAppServer({
    command: [process.execPath, resolve('test/fixtures/workspace-selection-codex.mjs'), 'repository', recordPath],
    model: 'main-model', selectionModel: 'selection-model',
    approvalPolicy: 'on-request', sandbox: 'danger-full-access', requestTimeoutMs: 1000,
  });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const threadId = await server.createThread({ cwd: root, instructions: 'Formal task instructions' });
  assert.match(threadId, /^formal-/);
  await server.selectWorkspace({
    taskId: 'task-model', cwd: root,
    candidates: [{ name: 'example/project', path: '/configured/repository' }],
    input: [{ kind: 'text', text: 'Original task evidence' }], answers: [],
  });
  const rows = (await readFile(recordPath, 'utf8')).trim().split('\n').filter(Boolean)
    .map(line => z.object({ method: z.string().optional(), params: z.unknown().optional() }).parse(JSON.parse(line)));
  const models = rows.filter(row => row.method === 'thread/start')
    .map(row => z.object({ ephemeral: z.boolean(), model: z.string() }).parse(row.params))
    .map(start => ({ ephemeral: start.ephemeral, model: start.model }));
  assert.deepEqual(models, [{ ephemeral: false, model: 'main-model' }, { ephemeral: true, model: 'selection-model' }]);
});

for (const mode of ['project', 'unknown-project', 'project-path']) test(`isolated selector validates ${mode} against exact project candidates and releases its process`, async t => {
  const f = await fixture(t, mode);
  f.input.candidates = [{ kind: 'project', id: 'project-fixture', name: 'example/project', entryPath: f.root, canonicalPath: f.root }];
  if (mode === 'project') {
    const result = await f.server.selectWorkspace(f.input);
    assert.deepEqual(result.choice, { kind: 'project', projectId: 'project-fixture', reason: 'Matches task evidence' });
  } else await assert.rejects(f.server.selectWorkspace(f.input));
  const rows = await f.records(); assert.ok(rows[0]);
  assert.equal(alive(rows[0].pid), false);
  assert.ok(rows.every(row => !['thread/resume', 'thread/turns/list'].includes(row.method ?? '')));
});

test('a repository name cannot select a discovered project with the same display name', async t => {
  const f = await fixture(t, 'repository');
  f.input.candidates = [{ kind: 'project', id: 'project-fixture', name: 'example/project', entryPath: f.root, canonicalPath: f.root }];
  await assert.rejects(f.server.selectWorkspace(f.input), /unconfigured repository/);
});
