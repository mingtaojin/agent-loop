import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { CodexAppServer } from '../src/adapters/codex.js';
import { UncertainOperationError } from '../src/domain.js';

const fixture = String.raw`
const fs = require('node:fs');
const { createInterface } = require('node:readline');
const root = process.argv[1];
const statePath = root + '/state.json';
const threads = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const persist = () => fs.writeFileSync(statePath, JSON.stringify(threads));
const record = value => fs.appendFileSync(root + '/wire.jsonl', JSON.stringify({ pid: process.pid, ...value }) + '\n');
record({ method: 'boot' });
let heldResume;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  record(m);
  const settings = JSON.parse(fs.readFileSync(root + '/settings.json', 'utf8'));
  if (heldResume && settings.releaseResume) {
    send({ id: heldResume.id, result: { thread: threads[heldResume.params.threadId] } });
    heldResume = undefined;
  }
  if (!m.method) {
    if (m.id !== 'approval') throw new Error('Unexpected native reply');
    send({ method: 'serverRequest/resolved', params: { threadId: 'thread-2', requestId: m.id } });
    return;
  }
  const p = m.params;
  let result;
  switch (m.method) {
    case 'initialize': result = {}; break;
    case 'initialized': return;
    case 'thread/start': {
      const id = 'thread-' + (Object.keys(threads).length + 1);
      threads[id] = { id, status: { type: 'idle' }, turns: [] };
      persist(); result = { thread: threads[id] }; break;
    }
    case 'thread/resume': {
      if (settings.missingThread === p.threadId) { send({ id: m.id, error: { code: -32000, message: 'Thread not found' } }); return; }
      if (settings.blockResume === p.threadId) { heldResume = m; return; }
      const thread = threads[p.threadId];
      if (!thread) throw new Error('Unknown thread');
      if (thread.turns.at(-1)?.status === 'inProgress') { thread.turns.at(-1).status = 'interrupted'; thread.status = { type: 'idle' }; }
      persist(); result = { thread }; break;
    }
    case 'thread/read': {
      if (settings.blockRead === p.threadId) return;
      const thread = threads[p.threadId];
      result = { thread: { ...thread, turns: p.includeTurns ? thread.turns : [] } }; break;
    }
    case 'turn/start': {
      const thread = threads[p.threadId];
      const turn = { id: p.threadId + '-turn-' + (thread.turns.length + 1), status: 'inProgress', items: [
        { id: p.clientUserMessageId, type: 'userMessage', clientId: p.clientUserMessageId, content: p.input },
      ] };
      thread.turns.push(turn); thread.status = { type: 'active' }; persist();
      if (settings.omitStartResponse !== p.threadId) send({ id: m.id, result: { turn } });
      if (p.threadId === 'thread-2') send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {
        threadId: thread.id, turnId: turn.id, itemId: 'approved-command', startedAtMs: Date.now(), command: 'echo fixture',
      } });
      return;
    }
    case 'turn/steer': {
      if (p.clientUserMessageId === 'crash') process.exit(23);
      const thread = threads[p.threadId];
      thread.turns.at(-1).items.push({ id: p.clientUserMessageId, type: 'userMessage', clientId: p.clientUserMessageId, content: p.input });
      persist(); result = { turnId: p.expectedTurnId }; break;
    }
    case 'turn/interrupt': {
      const thread = threads[p.threadId];
      thread.turns.at(-1).status = 'interrupted'; thread.status = { type: 'idle' }; persist();
      send({ method: 'turn/completed', params: { threadId: thread.id, turn: thread.turns.at(-1) } });
      result = {}; break;
    }
    default: throw new Error('Unexpected method ' + m.method);
  }
  send({ id: m.id, result });
});
`;

async function adapter(t: TestContext) {
  const root = await mkdtemp('/tmp/agent-loop-isolation-');
  const settings = (value: object) => writeFile(join(root, 'settings.json'), JSON.stringify(value));
  await settings({});
  const server = new CodexAppServer({ command: [process.execPath, '-e', fixture, root], approvalPolicy: 'on-request', sandbox: 'read-only', requestTimeoutMs: 150 });
  t.after(async () => { await settings({}); await server.close(); await rm(root, { recursive: true, force: true }); });
  const rows = async () => (await readFile(join(root, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line =>
    z.object({ pid: z.number(), method: z.string().optional(), params: z.unknown().optional(), id: z.union([z.string(), z.number()]).optional() }).parse(JSON.parse(line)));
  const a = await server.createThread({ cwd: root, instructions: 'A instructions' });
  const b = await server.createThread({ cwd: root, instructions: 'B instructions' });
  const start = (threadId: string, deliveryId: string) => server.startTurn({ threadId, deliveryId, input: [{ kind: 'text', text: deliveryId }] });
  return { server, rows, settings, a, b, start };
}

test('a request timeout preserves another thread and its native approval on the same process and epoch', async t => {
  const f = await adapter(t);
  await f.start(f.a, 'a-input'); const bTurn = await f.start(f.b, 'b-input');
  const approval = (await f.server.inspect(f.b)).requests[0]; assert.ok(approval);
  const before = await f.rows();
  await f.settings({ blockRead: f.a });
  await assert.rejects(f.server.inspect(f.a), UncertainOperationError);
  const healthy = await f.server.inspect(f.b);
  assert.equal(healthy.status, 'running'); assert.deepEqual(healthy.requests, [approval]);
  await f.server.steer({ threadId: f.b, turnId: bTurn, deliveryId: 'healthy-followup', input: [] });
  assert.ok((await f.server.inspect(f.b)).seenInputIds.includes('healthy-followup'));
  assert.equal((await f.rows()).filter(row => !row.method).length, 0);
  assert.equal(await f.server.respondApproval({ request: approval, decision: 'approve' }), 'confirmed');
  assert.deepEqual([...new Set((await f.rows()).map(row => row.pid))], [...new Set(before.map(row => row.pid))]);
});

test('an uncertain resume is quarantined until its late original response without replaying it', async t => {
  const f = await adapter(t);
  await f.start(f.b, 'healthy-input');
  await f.settings({ blockResume: f.a });
  await assert.rejects(f.server.inspect(f.a, 'Updated A instructions'), UncertainOperationError);
  await assert.rejects(f.server.inspect(f.a, 'Another A instruction change'), UncertainOperationError);
  assert.equal((await f.server.inspect(f.b)).status, 'running');
  assert.equal((await f.rows()).filter(row => row.method === 'thread/resume').length, 1);
  await f.settings({ releaseResume: true });
  await f.server.inspect(f.b);
  assert.equal((await f.server.inspect(f.a, 'Updated A instructions')).status, 'idle');
  assert.equal((await f.rows()).filter(row => row.method === 'thread/resume').length, 1);
});

test('real transport recovery initializes once and loads each original thread only on demand', async t => {
  const f = await adapter(t);
  await f.start(f.a, 'a-input'); const bTurn = await f.start(f.b, 'b-input');
  const oldApproval = (await f.server.inspect(f.b)).requests[0]; assert.ok(oldApproval);
  await assert.rejects(f.server.steer({ threadId: f.b, turnId: bTurn, deliveryId: 'crash', input: [] }), UncertainOperationError);
  await f.settings({ missingThread: f.a });
  await Promise.all([f.server.recover(), f.server.recover()]);
  assert.equal((await f.rows()).filter(row => row.method === 'boot').length, 2);
  assert.equal((await f.rows()).filter(row => row.method === 'thread/resume').length, 0);
  const healthy = await f.server.inspect(f.b);
  assert.equal(healthy.threadId, f.b); assert.equal(healthy.status, 'interrupted');
  await assert.rejects(f.server.inspect(f.a), /Thread not found/);
  await f.start(f.b, 'after-recovery');
  const currentApproval = (await f.server.inspect(f.b)).requests[0]; assert.ok(currentApproval);
  assert.notEqual(currentApproval.connectionEpoch, oldApproval.connectionEpoch);
  await assert.rejects(f.server.respondApproval({ request: oldApproval, decision: 'approve' }), /expired/);
  assert.equal(await f.server.respondApproval({ request: currentApproval, decision: 'approve' }), 'confirmed');
  assert.equal((await f.rows()).filter(row => row.method === 'thread/start').length, 2);
});


test('a timed-out accepted start is reconciled from history without starting it again', async t => {
  const f = await adapter(t);
  await f.settings({ omitStartResponse: f.a });
  await assert.rejects(f.start(f.a, 'accepted-once'), UncertainOperationError);
  assert.deepEqual(await f.server.activity(f.a), { kind: 'reconcile' });
  const reconciled = await f.server.inspect(f.a);
  assert.equal(reconciled.status, 'running');
  assert.deepEqual(reconciled.seenInputIds, ['accepted-once']);
  await f.start(f.b, 'healthy-input');
  assert.equal((await f.server.inspect(f.b)).status, 'running');
  const starts = (await f.rows()).filter(row => row.method === 'turn/start'
    && z.object({ threadId: z.string() }).parse(row.params).threadId === f.a);
  assert.equal(starts.length, 1);
});


test('a definitive resume rejection can be retried after its cause clears without replacing healthy connections', async t => {
  const f = await adapter(t);
  await f.settings({ missingThread: f.a });
  await assert.rejects(f.server.inspect(f.a, 'Updated A instructions'), /Thread not found/);
  await f.settings({});
  assert.equal((await f.server.inspect(f.a, 'Updated A instructions')).status, 'idle');
  assert.equal((await f.rows()).filter(row => row.method === 'boot').length, 1);
  assert.equal((await f.rows()).filter(row => row.method === 'thread/resume').length, 2);
});
