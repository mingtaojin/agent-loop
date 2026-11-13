import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { CodexAppServer } from './helpers/codex.js';
import { UncertainOperationError } from '../src/domain.js';
import type { ProjectRequest } from '../src/ports.js';
import { projectActionSchema } from '../src/project.js';

const fixture = String.raw`
const { createInterface } = require('node:readline');
const fs = require('node:fs');
const settings = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const logFile = process.argv[2];
const stateFile = logFile + '.state';
const threads = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const persist = () => fs.writeFileSync(stateFile, JSON.stringify(threads));
let current;
let replies = 0;
const complete = () => {
  current.status = { type: 'idle' };
  current.turns.at(-1).status = 'completed';
  persist();
  send({ method: 'turn/completed', params: { threadId: current.id, turn: current.turns.at(-1) } });
};
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(logFile, JSON.stringify(message) + '\n');
  if (!message.method) {
    if (++replies === (settings.expectedReplies ?? 1)) complete();
    return;
  }
  const p = message.params;
  let result;
  switch (message.method) {
    case 'initialize': result = { userAgent: 'project-fixture' }; break;
    case 'initialized': return;
    case 'thread/start': {
      const id = 'thread-' + (Object.keys(threads).length + 1);
      current = { id, status: { type: 'idle' }, turns: [] };
      threads[id] = current;
      persist();
      result = { thread: current }; break;
    }
    case 'thread/resume':
      if (p.dynamicTools !== undefined) throw new Error('Resume must not retrofit tools');
      current = threads[p.threadId];
      if (!current) throw new Error('Unknown fixture thread');
      if (current.turns.at(-1)?.status === 'inProgress') {
        current.turns.at(-1).status = 'interrupted';
        current.status = { type: 'idle' };
      }
      persist();
      result = { thread: current }; break;
    case 'thread/read': {
      const thread = threads[p.threadId];
      result = { thread: { ...thread, turns: p.includeTurns ? thread.turns : [] } }; break;
    }
    case 'turn/start': {
      current = threads[p.threadId];
      replies = 0;
      const turn = { id: 'turn-' + (current.turns.length + 1), status: settings.completed ? 'completed' : 'inProgress', items: [
        { id: p.clientUserMessageId, type: 'userMessage', clientId: p.clientUserMessageId, content: p.input },
      ] };
      current.turns.push(turn);
      current.status = { type: settings.completed ? 'idle' : 'active' };
      persist();
      if (!settings.callsBeforeResponse) send({ id: message.id, result: { turn } });
      for (const [index, call] of (settings.calls ?? []).entries()) {
        const request = { id: call.rpcId ?? 'wire-' + index, method: 'item/tool/call', params: {
          threadId: current.id, turnId: turn.id, callId: 'call-' + index,
          tool: 'project_action', arguments: { action: 'status' }, ...call,
        } };
        send(request);
        if (settings.duplicate) send(request);
      }
      if (settings.callsBeforeResponse) send({ id: message.id, result: { turn } });
      return;
    }
    case 'turn/steer':
      if (p.clientUserMessageId === 'crash') process.exit(23);
      result = { turnId: p.expectedTurnId }; break;
    case 'turn/interrupt':
      current = threads[p.threadId];
      current.turns.at(-1).status = 'interrupted';
      current.status = { type: 'idle' };
      persist();
      result = {}; break;
    default: throw new Error('Unexpected project fixture method ' + message.method);
  }
  send({ id: message.id, result });
});
`;

const rowSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional() });
const toolResultSchema = z.object({ success: z.boolean(), contentItems: z.array(z.object({ type: z.literal('inputText'), text: z.string() })) });
const toolsSchema = z.object({ dynamicTools: z.array(z.object({ name: z.string(), type: z.literal('function'), inputSchema: z.record(z.string(), z.unknown()) })) });

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

async function adapter(t: TestContext, settings: object = {}) {
  const root = await mkdtemp('/tmp/agent-loop-project-codex-');
  const logFile = join(root, 'requests.jsonl');
  const settingsFile = join(root, 'settings.json');
  await writeFile(settingsFile, JSON.stringify(settings));
  const server = new CodexAppServer({ command: [process.execPath, '-e', fixture, settingsFile, logFile], approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 2000 });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const records = async () => (await readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => rowSchema.parse(JSON.parse(line)));
  const results = async (count = 1) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const replies = (await records()).filter(row => !row.method).map(row => toolResultSchema.parse(row.result));
      if (replies.length >= count) return replies;
      await delay(10);
    }
    throw new Error('Project fixture did not receive the expected tool replies');
  };
  const create = () => server.createThread({ cwd: root, instructions: 'Use poteto-mode for the assigned work.' });
  const start = async (existingThreadId?: string) => {
    const threadId = existingThreadId ?? await create();
    const turnId = await server.startTurn({ threadId, input: [{ kind: 'text', text: 'Project coordination' }], deliveryId: 'delivery' });
    return { threadId, turnId };
  };
  return { server, root, records, results, create, start };
}

test('project tools register only on new formal threads after a handler is installed', async t => {
  const f = await adapter(t);
  const original = await f.create();
  f.server.setProjectHandler(async () => ({ ok: true }));
  await f.server.inspect(original, 'Updated coordinator instructions');
  await f.create();
  const rows = await f.records();
  const registrations = rows.filter(row => row.method === 'thread/start').map(row => toolsSchema.parse(row.params));
  assert.deepEqual(registrations.map(row => row.dynamicTools.map(tool => tool.name)), [['ensure_workspace'], ['ensure_workspace', 'project_action']]);
  const resumed = rows.find(row => row.method === 'thread/resume');
  assert.ok(resumed);
  assert.equal(z.object({ dynamicTools: z.unknown().optional() }).parse(resumed.params).dynamicTools, undefined);
});

test('registered project JSON schema agrees with the authoritative action input schema', async t => {
  const f = await adapter(t);
  f.server.setProjectHandler(async () => null);
  await f.create();
  const start = (await f.records()).find(row => row.method === 'thread/start');
  assert.ok(start);
  const tool = toolsSchema.parse(start.params).dynamicTools.find(tool => tool.name === 'project_action');
  assert.ok(tool);
  const { $schema: _schema, ...expected } = z.toJSONSchema(projectActionSchema, { io: 'input' });
  assert.deepEqual(tool.inputSchema, expected);
});

test('project role model remains attached when guidance updates resume its Thread', async t => {
  const f = await adapter(t);
  const threadId = await f.server.createThread({ cwd: f.root, instructions: 'Verifier scope', model: 'configured-verifier' });
  await f.server.inspect(threadId, 'Updated verifier scope');
  const rows = await f.records();
  const configured = rows.filter(row => row.method === 'thread/start' || row.method === 'thread/resume');
  assert.equal(configured.length, 2);
  for (const row of configured) assert.equal(z.object({ model: z.string() }).parse(row.params).model, 'configured-verifier');
});

test('role reasoning is sent on Thread creation, resume and every new Turn', async t => {
  const f = await adapter(t, { completed: true });
  const threadId = await f.server.createThread({ cwd: f.root, instructions: 'Coordinator scope', model: 'gpt-6-astra', reasoningEffort: 'high' });
  await f.server.inspect(threadId, 'Updated coordinator scope');
  await f.server.startTurn({ threadId, input: [{ kind: 'text', text: 'First turn' }], deliveryId: 'first' });
  await f.server.startTurn({ threadId, input: [{ kind: 'text', text: 'Second turn' }], deliveryId: 'second' });
  const rows = await f.records();
  for (const row of rows.filter(row => row.method === 'thread/start' || row.method === 'thread/resume')) {
    assert.equal(z.object({ config: z.object({ model_reasoning_effort: z.string() }) }).parse(row.params).config.model_reasoning_effort, 'high');
  }
  const turns = rows.filter(row => row.method === 'turn/start'); assert.equal(turns.length, 2);
  for (const row of turns) assert.equal(z.object({ effort: z.string() }).parse(row.params).effort, 'high');
});

const validActions = [
  { action: 'control', requestId: 'pause-worker', taskId: 'task-1', operation: 'pause' },
  { action: 'control', requestId: 'resume-worker', taskId: 'task-1', operation: 'resume' },
  { action: 'status' },
  ...['overview', 'issues', 'comments', 'records', 'tasks'].map(section => ({ action: 'status', section, offset: 2, limit: 10 })),
  { action: 'dispatch', requestId: 'dispatch-default', prompt: 'Investigate within the assigned scope.' },
  { action: 'dispatch', requestId: 'dispatch-verifier', prompt: 'Verify the fixed artifact.', issueId: 'issue-1', role: 'verifier' },
  { action: 'send', requestId: 'send-1', taskId: 'task-1', text: 'Additional evidence' },
  { action: 'report', requestId: 'report-result', kind: 'result', text: 'Artifact and validation evidence' },
  { action: 'report', requestId: 'report-question', kind: 'question', text: 'A business decision is required.' },
  { action: 'report', requestId: 'report-update', kind: 'update', text: 'Investigation continues.' },
  { action: 'record', requestId: 'record-1', key: 'decision', text: 'Confirmed scope', expectedVersion: 0 },
  { action: 'rotate', requestId: 'rotate-1', checkpoint: 'Pending tasks and evidence' },
  { action: 'release_workspace', requestId: 'release-1', resourceId: 'resource-1' },
];

test('every project action reaches only its handler with validated caller scope and returns its result', async t => {
  const f = await adapter(t, { calls: validActions.map(arguments_ => ({ arguments: arguments_ })), expectedReplies: validActions.length });
  const requests: ProjectRequest[] = [];
  f.server.setWorkspaceHandler(async () => { throw new Error('Project actions reached workspace provisioning'); });
  f.server.setProjectHandler(async request => {
    requests.push(request);
    assert.equal((await f.server.inspect(request.threadId)).status, 'running');
    return { accepted: request.action.action, callId: request.callId };
  });
  const active = await f.start();
  const replies = await f.results(validActions.length);
  assert.deepEqual(requests, validActions.map((action, index) => ({ ...active, connectionEpoch: requests[0]?.connectionEpoch, callId: 'call-' + index, action: projectActionSchema.parse(action) })));
  assert.ok(replies.every(reply => reply.success));
  assert.deepEqual(replies.map(reply => JSON.parse(reply.contentItems[0]?.text ?? 'null')), validActions.map((action, index) => ({ accepted: action.action, callId: 'call-' + index })));
});

const invalidCalls = [
  { name: 'unknown thread', call: { threadId: 'unknown-thread' }, error: /unknown thread/ },
  { name: 'stale turn', call: { turnId: 'previous-turn' }, error: /inactive turn/ },
  { name: 'namespaced project tool', call: { namespace: 'invented' }, error: /Unsupported dynamic tool/ },
  { name: 'unknown tool', call: { tool: 'invented' }, error: /Unsupported dynamic tool/ },
  { name: 'unknown action', call: { arguments: { action: 'invented' } } },
  { name: 'project identity spoofing', call: { arguments: { action: 'status', projectId: 'other-project' } } },
  { name: 'caller identity spoofing', call: { arguments: { action: 'status', taskId: 'another-caller' } } },
  { name: 'unknown status section', call: { arguments: { action: 'status', section: 'secrets' } } },
  { name: 'negative status offset', call: { arguments: { action: 'status', offset: -1 } } },
  { name: 'fractional status offset', call: { arguments: { action: 'status', offset: 0.5 } } },
  { name: 'zero status limit', call: { arguments: { action: 'status', limit: 0 } } },
  { name: 'oversized status page', call: { arguments: { action: 'status', limit: 101 } } },
  { name: 'missing request ID', call: { arguments: { action: 'dispatch', prompt: 'Work' } } },
  { name: 'empty dispatch prompt', call: { arguments: { action: 'dispatch', requestId: 'request', prompt: '' } } },
  { name: 'blank dispatch prompt', call: { arguments: { action: 'dispatch', requestId: 'request', prompt: ' \n\t' } } },
  { name: 'blank request ID', call: { arguments: { action: 'dispatch', requestId: '  ', prompt: 'Work' } } },
  { name: 'control character in request ID', call: { arguments: { action: 'dispatch', requestId: 'request\u0000', prompt: 'Work' } } },
  { name: 'invalid worker role', call: { arguments: { action: 'dispatch', requestId: 'request', prompt: 'Work', role: 'coordinator' } } },
  { name: 'invalid report kind', call: { arguments: { action: 'report', requestId: 'request', kind: 'approval', text: 'Approve' } } },
  { name: 'negative record version', call: { arguments: { action: 'record', requestId: 'request', key: 'key', text: 'text', expectedVersion: -1 } } },
  { name: 'fractional record version', call: { arguments: { action: 'record', requestId: 'request', key: 'key', text: 'text', expectedVersion: 0.5 } } },
  { name: 'oversized request ID', call: { arguments: { action: 'send', requestId: 'x'.repeat(10001), taskId: 'task', text: 'text' } } },
  { name: 'oversized text', call: { arguments: { action: 'report', requestId: 'request', kind: 'update', text: 'x'.repeat(1000001) } } },
];

for (const invalid of invalidCalls) test(`project tool rejects ${invalid.name} before invoking a handler`, async t => {
  const f = await adapter(t, { calls: [invalid.call] });
  let calls = 0;
  f.server.setProjectHandler(async () => { calls++; return null; });
  f.server.setWorkspaceHandler(async () => { calls++; throw new Error('Unknown tool reached workspace handler'); });
  await f.start();
  if (invalid.name === 'unknown thread') {
    await delay(50);
    assert.equal((await f.records()).filter(row => !row.method).length, 0);
    assert.equal(calls, 0);
    return;
  }
  const reply = (await f.results())[0];
  assert.ok(reply);
  assert.equal(reply.success, false);
  if (invalid.error) assert.match(reply.contentItems[0]?.text ?? '', invalid.error);
  assert.equal(calls, 0);
});

test('project tool rejects a completed turn before invoking a handler', async t => {
  const f = await adapter(t, { completed: true, calls: [{}] });
  let calls = 0;
  f.server.setProjectHandler(async () => { calls++; return null; });
  await f.start();
  assert.equal((await f.results())[0]?.success, false);
  assert.equal(calls, 0);
});

test('an unsolicited project call fails when project coordination is unavailable', async t => {
  const f = await adapter(t, { calls: [{}] });
  await f.start();
  const reply = (await f.results())[0];
  assert.ok(reply);
  assert.equal(reply.success, false);
  assert.match(reply.contentItems[0]?.text ?? '', /coordination is unavailable/);
});

test('workspace calls keep their handler when project coordination is enabled', async t => {
  const f = await adapter(t, { calls: [{ tool: 'ensure_workspace', arguments: { projectId: 'workspace-project' } }] });
  const requests: unknown[] = [];
  f.server.setProjectHandler(async () => { throw new Error('Workspace request reached project coordination'); });
  f.server.setWorkspaceHandler(async request => {
    requests.push(request);
    return { kind: 'project', id: 'resource-1', workspace: '/tmp/project', project: {
      kind: 'project', id: 'workspace-project', name: 'project', entryPath: '/tmp/project', canonicalPath: '/tmp/project',
    } };
  });
  const active = await f.start();
  const reply = (await f.results())[0];
  assert.ok(reply);
  assert.equal(reply.success, true);
  assert.equal(JSON.parse(reply.contentItems[0]?.text ?? 'null').workspace, '/tmp/project');
  assert.deepEqual(requests, [{ ...active, connectionEpoch: z.object({ connectionEpoch: z.string().min(1) }).parse(requests[0]).connectionEpoch, callId: 'call-0', projectId: 'workspace-project' }]);
});

test('a project handler rejection becomes a failed tool result without breaking the transport', async t => {
  const f = await adapter(t, { calls: [{}] });
  f.server.setProjectHandler(async () => { throw new Error('Caller does not belong to this project'); });
  const active = await f.start();
  const reply = (await f.results())[0];
  assert.ok(reply);
  assert.equal(reply.success, false);
  assert.match(reply.contentItems[0]?.text ?? '', /does not belong/);
  assert.equal((await f.server.inspect(active.threadId)).status, 'completed');
});

test('duplicate native RPC requests invoke the project handler once', async t => {
  const f = await adapter(t, { calls: [{}], duplicate: true });
  let calls = 0;
  f.server.setProjectHandler(async () => { calls++; return { ok: true }; });
  await f.start();
  assert.equal((await f.results()).length, 1);
  assert.equal(calls, 1);
});

test('project action bounds accept the largest valid identifiers, text, and status page', async t => {
  const actions = [
    { action: 'dispatch', requestId: 'r'.repeat(512), prompt: 'p'.repeat(131_072) },
    { action: 'status', section: 'records', offset: Number.MAX_SAFE_INTEGER, limit: 100 },
  ];
  const f = await adapter(t, { calls: actions.map(action => ({ arguments: action })), expectedReplies: actions.length });
  const requests: ProjectRequest[] = [];
  f.server.setProjectHandler(async request => { requests.push(request); return null; });
  await f.start();
  assert.ok((await f.results(actions.length)).every(reply => reply.success));
  assert.deepEqual(requests.map(request => request.action), actions.map(action => projectActionSchema.parse(action)));
});

test('workspace selection remains isolated from an installed project handler', async t => {
  const root = await mkdtemp('/tmp/agent-loop-project-selector-');
  const logFile = join(root, 'requests.jsonl');
  const server = new CodexAppServer({ command: [process.execPath, resolve('test/fixtures/workspace-selection-codex.mjs'), 'none', logFile], approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 2000 });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  let calls = 0;
  server.setProjectHandler(async () => { calls++; throw new Error('Selector reached project handler'); });
  const selection = await server.selectWorkspace({ taskId: 'task', cwd: root, candidates: [], input: [{ kind: 'text', text: 'Discussion only' }], answers: [] });
  assert.equal(selection.choice.kind, 'none');
  const starts = (await readFile(logFile, 'utf8')).trim().split('\n').map(line => rowSchema.parse(JSON.parse(line))).filter(row => row.method === 'thread/start');
  assert.equal(starts.length, 1);
  assert.deepEqual(toolsSchema.parse(starts[0]?.params).dynamicTools, []);
  assert.equal(calls, 0);
});

test('a project callback from a lost connection cannot answer its replacement transport', async t => {
  const f = await adapter(t, { calls: [{}] });
  const entered = signal();
  const held = signal();
  const returned = signal();
  t.after(() => held.resolve());
  let calls = 0;
  f.server.setProjectHandler(async () => {
    const generation = ++calls;
    if (generation === 1) {
      entered.resolve();
      await held.promise;
      returned.resolve();
    }
    return { generation };
  });
  const active = await f.start();
  await entered.promise;
  await assert.rejects(f.server.steer({ ...active, deliveryId: 'crash', input: [] }), UncertainOperationError);
  await f.server.recover();
  await f.start(active.threadId);
  held.resolve();
  await returned.promise;
  const replies = await f.results();
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.contentItems[0]?.text, JSON.stringify({ generation: 2 }));
  assert.equal(calls, 2);
  const rows = await f.records();
  assert.equal(rows.filter(row => row.method === 'thread/start').length, 1);
  assert.equal(rows.filter(row => row.method === 'thread/resume').length, 1);
});

test('dynamic project callbacks validate the active turn without reading full history', async t => {
  const f = await adapter(t, { calls: [{}] });
  let calls = 0;
  f.server.setProjectHandler(async () => { calls++; return { accepted: true }; });
  await f.start();
  assert.equal((await f.results())[0]?.success, true);
  assert.equal(calls, 1);
  const full = (await f.records()).filter(row => row.method === 'thread/read'
    && z.object({ includeTurns: z.boolean() }).parse(row.params).includeTurns);
  assert.equal(full.length, 0, 'active tool validation must not request complete history');
});

test('turn context is separate from stable instructions and delivery markers', async t => {
  const f = await adapter(t);
  const threadId = await f.create();
  const turnId = await f.server.startTurn({ threadId, input: [{ kind: 'text', text: 'Original input' }], deliveryId: 'original-id', additionalDeliveryIds: ['second-id'], additionalContext: 'START_RECORD_CONTEXT' });
  await f.server.steer({ threadId, turnId, input: [{ kind: 'text', text: 'Follow-up input' }], deliveryId: 'follow-up-id', additionalContext: 'STEER_RECORD_CONTEXT' });
  const rows = await f.records();
  assert.equal(rows.filter(row => row.method === 'thread/resume').length, 0);
  assert.doesNotMatch(JSON.stringify(rows.find(row => row.method === 'thread/start')), /RECORD_CONTEXT/);
  const turns = rows.filter(row => row.method === 'turn/start' || row.method === 'turn/steer').map(row =>
    z.object({ clientUserMessageId: z.string(), input: z.array(z.object({ text: z.string() })), additionalContext: z.object({
      'agent-loop-project-records': z.object({ kind: z.literal('application'), value: z.string() }),
    }) }).parse(row.params));
  assert.deepEqual(turns.map(turn => turn.additionalContext['agent-loop-project-records'].value), ['START_RECORD_CONTEXT', 'STEER_RECORD_CONTEXT']);
  assert.deepEqual(turns.map(turn => turn.clientUserMessageId), ['original-id', 'follow-up-id']);
  assert.equal(turns[0]?.input[1]?.text, 'Original input');
  assert.match(turns[0]?.input[0]?.text ?? '', /agent-loop-delivery:original-id.*\n\[agent-loop-batch:/);
  assert.doesNotMatch(JSON.stringify(turns.map(turn => turn.input)), /RECORD_CONTEXT/);
});


test('callbacks before the start response wait for exact turn evidence without loading history', async t => {
  const f = await adapter(t, { callsBeforeResponse: true, calls: [{}, { turnId: 'wrong-turn' }], expectedReplies: 2 });
  const requests: ProjectRequest[] = [];
  f.server.setProjectHandler(async request => { requests.push(request); return { accepted: true }; });
  const active = await f.start();
  const replies = await f.results(2);
  assert.equal(requests.length, 1); assert.equal(requests[0]?.turnId, active.turnId);
  assert.equal(replies.filter(reply => reply.success).length, 1);
  assert.equal(replies.filter(reply => !reply.success).length, 1);
  assert.ok(!(await f.records()).some(row => row.method === 'thread/read' && z.object({ includeTurns: z.boolean() }).parse(row.params).includeTurns));
});

test('activity returns no delivery evidence and refuses terminal or unproven turns', async t => {
  const f = await adapter(t);
  const threadId = await f.create();
  assert.deepEqual(await f.server.activity(threadId), { kind: 'reconcile' });
  const { turnId } = await f.start(threadId);
  const active = await f.server.activity(threadId);
  assert.equal(active.kind, 'running'); assert.ok(!('seenInputIds' in active));
  if (active.kind !== 'running') throw new Error('Expected active evidence');
  assert.equal(active.turnId, turnId); assert.equal(f.server.isActiveTurn(active), true);
  assert.equal(f.server.isActiveTurn({ ...active, connectionEpoch: 'old-epoch' }), false);
  assert.equal(f.server.isActiveTurn({ ...active, turnId: 'old-turn' }), false);
  await f.server.interrupt({ threadId, turnId });
  assert.deepEqual(await f.server.activity(threadId), { kind: 'reconcile' });
  assert.equal(f.server.isActiveTurn(active), false);
  assert.equal((await f.server.inspect(threadId)).status, 'interrupted');
});
