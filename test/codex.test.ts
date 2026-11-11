import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { CodexAppServer } from '../src/adapters/codex.js';
import { RejectedInputError, TurnChangedError, UncertainOperationError, type WorkspaceRequest } from '../src/domain.js';

const fixture = String.raw`
const { createInterface } = require('node:readline');
const mode = process.argv[1];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const report = { status: 'waiting_user', summary: 'Reproduced', question: 'Proceed?', prUrl: null, validation: ['fixture evidence'], limitations: [] };
let initialized = false;
const stateFile = process.argv[2];
const fs = require('node:fs');
let turns = mode.startsWith('recover') && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : [];
const persist = () => { if (mode.startsWith('recover')) fs.writeFileSync(stateFile, JSON.stringify(turns)); };
const record = method => { if (mode.startsWith('recover')) fs.appendFileSync(stateFile + '.calls', method + '\n'); };
let receivedReply;
let metadataReads = 0;
let historyReads = 0;
let unpublishedReads = 0;
const thread = () => ({ id: 'thread-1', historyMode: mode.startsWith('paginated') ? 'paginated' : 'legacy', status: { type: mode !== 'orphaned' && turns.at(-1)?.status === 'inProgress' ? 'active' : 'idle' }, turns });
const inputItem = p => ({ id: 'user-' + p.clientUserMessageId, type: 'userMessage', clientId: mode === 'marker' ? null : p.clientUserMessageId, content: p.input });
const complete = () => {
 const turn = turns.at(-1);
 turn.status = 'completed';
 turn.items.push({ id: 'agent-final', type: 'agentMessage', text: mode === 'invalid-report' ? 'done' : JSON.stringify(report), phase: mode === 'commentary-report' ? 'commentary' : 'final_answer' });
 send({ method: 'turn/completed', params: { threadId: 'thread-1', turn } });
};
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line);
 if (m.method) record(m.method);
 if (!m.method) {
   receivedReply = m;
   if (mode === 'lost-approval') process.exit(24);
   if (mode === 'duplicate-approval') { send({ id: 'wire-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: turns.at(-1).id, itemId: 'item-1', startedAtMs: Date.now(), command: 'echo safe' } }); return; }
   if (mode.startsWith('workspace')) {
     if (!['workspace', 'workspace-loss', 'workspace-project'].includes(mode)) { if (m.result.success !== false) throw new Error('invalid tool succeeded'); complete(); return; }
     if (m.id !== 'workspace-wire' || !m.result.success || JSON.parse(m.result.contentItems[0].text).workspace !== '/tmp/owned-workspace') throw new Error('incorrect workspace result');
     complete(); return;
   }
   if (m.id !== 'wire-approval') throw new Error('wrong native request ID');
   if ((mode === 'approval' || mode === 'file-approval') && m.result.decision !== 'accept') throw new Error('wrong approval');
   if (mode === 'permissions' && (m.result.scope !== 'turn' || m.result.permissions.network.enabled !== true)) throw new Error('wrong permission grant');
   if (mode === 'question' && m.result.answers.root.answers[0] !== 'the answer') throw new Error('wrong answer');
   if (mode === 'multi-question' && (m.result.answers.root.answers[0] !== 'one' || m.result.answers.next.answers[0] !== 'two')) throw new Error('wrong multiple answers');
   if (mode !== 'unconfirmed-approval') send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'wire-approval' } });
   if (mode !== 'unconfirmed-approval') complete(); return;
 }
 if (m.method === 'initialized') { initialized = true; return; }
 if (mode === 'timeout') return;
 if (m.method === 'initialize') { send({ id: m.id, result: { userAgent: 'fixture' } }); return; }
 if (!initialized) throw new Error('missing initialized notification');
 const p = m.params;
 let result;
 switch(m.method) {
 case 'thread/start':
  if (p.dynamicTools?.[0]?.name !== 'ensure_workspace' || p.dynamicTools[0].type !== 'function' || !p.dynamicTools[0].inputSchema?.anyOf?.some(target => target.properties?.repository) || !p.dynamicTools[0].inputSchema?.anyOf?.some(target => target.properties?.projectId)) throw new Error('missing dynamic workspace tool targets');
  if (p.ephemeral !== false || p.approvalsReviewer !== 'user') throw new Error('missing durable or approval configuration');
  result = { thread: thread() }; break;
 case 'thread/resume':
  if (mode === 'instructions' && p.developerInstructions !== 'Current runtime contract') throw new Error('historical developer instructions were not replaced');
  if (mode.startsWith('recover') && turns.at(-1)?.status === 'inProgress') { turns.at(-1).status = 'interrupted'; persist(); }
  if (p.threadId !== 'thread-1') throw new Error('wrong original thread');
  if (mode === 'resume') turns = [{ id: 'turn-1', status: 'completed', items: [{ id: 'old-user', type: 'userMessage', clientId: 'old-delivery', content: [] }, { id: 'old-final', type: 'agentMessage', text: JSON.stringify(report) }] }];
  if (mode === 'external-active-history') turns = [{ id: 'turn-1', status: 'inProgress', items: [] }];
  if (mode === 'orphaned') turns = [{ id: 'turn-1', status: 'inProgress', items: [] }];
  result = { thread: thread() }; break;
 case 'thread/read':
  if (mode === 'external-active-history' && ++unpublishedReads < 5) { result = { thread: { ...thread(), status: { type: 'active' }, turns: [] } }; break; }
  if (mode === 'start-status-race' && ++unpublishedReads < 5) { result = { thread: { ...thread(), status: { type: 'idle' }, turns: p.includeTurns ? turns : [] } }; break; }
  if (mode === 'start-history-race' && ++unpublishedReads < 5) { result = { thread: { ...thread(), status: { type: 'idle' }, turns: [] } }; break; }
  if (mode === 'graceful-close' && p.includeTurns && turns.at(-1)?.status === 'interrupted') require('node:fs').writeFileSync(process.argv[2], 'terminal history confirmed');
  if (mode === 'missing-history') { send({ id: m.id, error: { code: -32000, message: 'history unavailable' } }); return; }
  if (mode === 'completion-race' && !p.includeTurns && ++metadataReads === 1) {
   result = { thread: { ...thread(), turns: [] } }; complete();
  } else result = { thread: { ...thread(), turns: p.includeTurns ? turns : [] } };
  break;
 case 'thread/turns/list':
  if (mode === 'paginated-materializing' && ++historyReads < 3) { send({ id: m.id, error: { code: -32603, message: 'list_turns is not supported yet' } }); return; }
  if (!turns.length) { send({ id: m.id, error: { code: -32000, message: 'thread is not materialized yet' } }); return; }
  if (p.itemsView !== 'full' || p.sortDirection !== 'asc') throw new Error('partial history requested');
  result = { data: turns, nextCursor: null }; break;
 case 'turn/start':
  if (mode === 'instructions' && (p.additionalContext?.['agent-loop-runtime']?.kind !== 'application' || !p.additionalContext['agent-loop-runtime'].value.includes('Current runtime contract'))) throw new Error('missing trusted runtime context');
  if (p.outputSchema !== undefined || !p.clientUserMessageId) throw new Error('forced output contract or missing delivery id');
  turns.push({ id: 'turn-' + (turns.length + 1), status: 'inProgress', items: [inputItem(p)] });
  persist();
  result = { turn: turns.at(-1) };
  if (mode === 'workspace-completed') turns.at(-1).status = 'completed';
  if (mode.startsWith('workspace')) send({ id: 'workspace-wire', method: 'item/tool/call', params: { threadId: mode === 'workspace-unknown' ? 'unknown-thread' : 'thread-1', turnId: mode === 'workspace-stale' ? 'old-turn' : turns.at(-1).id, callId: 'workspace-call', tool: 'ensure_workspace', arguments: mode === 'workspace-project' ? { projectId: 'project-fixture' } : mode === 'workspace-ambiguous' ? { projectId: 'project-fixture', repository: 'example/one' } : mode === 'workspace-project-path' ? { projectId: 'project-fixture', path: '/invented/path' } : { repository: 'example/one' } } });
  if (mode === 'outputs') {
    const item = { id: 'progress-1', type: 'agentMessage', phase: 'commentary', text: 'Complete progress sentence.' };
    turns.at(-1).items.push(item, { id: 'reasoning-1', type: 'reasoning', text: 'private reasoning' }, { id: 'tool-1', type: 'commandExecution', text: 'raw tool log' }, { id: 'incomplete-1', type: 'agentMessage', phase: 'final_answer', text: 'partial' });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: turns.at(-1).id, itemId: 'incomplete-1', delta: 'partial' } });
    send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: turns.at(-1).id, item } });
  }
  if (['approval', 'file-approval', 'permissions', 'question', 'multi-question', 'unsupported', 'mcp-unsupported', 'expired', 'nonblocking-question', 'unconfirmed-approval', 'lost-approval', 'duplicate-approval', 'recover-request'].includes(mode)) {
   let method = 'item/commandExecution/requestApproval';
   let params = { threadId: 'thread-1', turnId: turns.at(-1).id, itemId: 'item-1', startedAtMs: Date.now(), command: 'echo safe', cwd: '/tmp', reason: 'fixture' };
   if (mode === 'file-approval') method = 'item/fileChange/requestApproval';
   if (mode === 'permissions') { method = 'item/permissions/requestApproval'; params.permissions = { network: { enabled: true }, fileSystem: { read: ['/tmp/logs'] } }; }
   if (mode === 'question' || mode === 'multi-question' || mode === 'nonblocking-question') {
    method = 'item/tool/requestUserInput'; params.isBlocking = mode !== 'nonblocking-question';
    params.questions = [{ id: 'root', header: 'Root', question: 'What happened?', options: null }];
    if (mode === 'multi-question') params.questions.push({ id: 'next', header: 'Next', question: 'What next?', options: null });
   }
   if (mode === 'unsupported') { method = 'item/tool/call'; delete params.itemId; params.callId = 'call-1'; params.tool = 'unknown'; params.arguments = {}; }
   if (mode === 'mcp-unsupported') { method = 'mcpServer/elicitation/request'; delete params.itemId; delete params.turnId; params.serverName = 'unknown'; }
   send({ id: 'wire-approval', method, params });
  }
  break;
 case 'turn/steer':
  if (mode === 'instructions' && (p.additionalContext?.['agent-loop-runtime']?.kind !== 'application' || !p.additionalContext['agent-loop-runtime'].value.includes('Current runtime contract'))) throw new Error('missing trusted steer context');
  if ((mode.startsWith('recover') || mode === 'workspace-loss') && p.clientUserMessageId === 'crash') { persist(); process.exit(23); }
  if (mode === 'outputs') { turns.at(-1).items = turns.at(-1).items.filter(item => item.id !== 'incomplete-1'); complete(); }
  if (p.expectedTurnId !== turns.at(-1)?.id || mode === 'turn-changed') { send({ id: m.id, error: { code: -32602, message: 'expected turn id does not match active turn' } }); return; }
  if (mode === 'other-error') { send({ id: m.id, error: { code: -32602, message: 'invalid input' } }); return; }
  if (p.input.some(i => i.type === 'localImage') && !p.input.some(i => i.type === 'skill')) throw new Error('input lost skill');
  turns.at(-1).items.push(inputItem(p)); result = { turnId: p.expectedTurnId }; break;
 case 'turn/interrupt':
  if (p.turnId !== turns.at(-1).id) throw new Error('wrong interrupt turn');
  if (mode === 'graceful-close') { setTimeout(() => { turns.at(-1).status = 'interrupted'; }, 100); result = {}; break; }
  turns.at(-1).status = 'interrupted'; result = {}; break;
 default: throw new Error('unexpected method ' + m.method);
 }
 send({ id: m.id, result });
 if (m.method === 'turn/start' && ['invalid-report', 'commentary-report', 'complete', 'start-history-race'].includes(mode)) complete();
 if (m.method === 'turn/start' && mode === 'expired') send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'wire-approval' } });
});
`;

function adapter(mode = 'normal', timeout = 2000) {
  return new CodexAppServer({ command: [process.execPath, '-e', fixture, mode], approvalPolicy: 'on-request', sandbox: 'workspace-write', requestTimeoutMs: timeout });
}
async function start(server: CodexAppServer) {
  const threadId = await server.createThread({ cwd: '/tmp', instructions: 'Wait for reproduction confirmation' });
  const turnId = await server.startTurn({ threadId, input: [{ kind: 'text', text: 'Investigate' }], deliveryId: 'delivery-1' });
  return { threadId, turnId };
}

test('start and steer preserve the original thread, delivery IDs, image and skill inputs', async t => {
  const server = adapter(); t.after(() => server.close());
  const { threadId, turnId } = await start(server);
  await server.steer({ threadId, turnId, deliveryId: 'delivery-2', input: [{ kind: 'image', path: '/tmp/screenshot.png' }, { kind: 'skill', path: '/tmp/SKILL.md', name: 'investigate' }] });
  const snapshot = await server.inspect(threadId);
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.turnId, turnId);
  assert.deepEqual(snapshot.seenInputIds, ['delivery-1', 'delivery-2']);
  assert.deepEqual(snapshot.outputs, []);
  await server.interrupt({ threadId, turnId });
  assert.equal((await server.inspect(threadId)).status, 'interrupted');
});

for (const mode of ['marker', 'paginated', 'paginated-materializing']) test(`${mode} history proves delivery without in-memory acceptance assumptions`, async t => {
  const server = adapter(mode); t.after(() => server.close());
  const { threadId } = await start(server);
  assert.deepEqual((await server.inspect(threadId)).seenInputIds, ['delivery-1']);
});

test('persisted first-turn batch markers prove every original message without native client IDs', async t => {
  const server = adapter('marker'); t.after(() => server.close());
  const threadId = await server.createThread({ cwd: '/tmp', instructions: 'Respect the user scope' });
  await server.startTurn({ threadId, input: [{ kind: 'text', text: 'Original task and scope clarification' }], deliveryId: 'initial', additionalDeliveryIds: ['directory-answer', 'answer:%[]\n2'] });
  assert.deepEqual((await server.inspect(threadId)).seenInputIds, ['initial', 'directory-answer', 'answer:%[]\n2']);
});

test('a newly created thread can be inspected before its first user turn', async t => {
  const server = adapter('paginated'); t.after(() => server.close());
  const threadId = await server.createThread({ cwd: '/tmp', instructions: '' });
  assert.equal((await server.inspect(threadId)).status, 'idle');
});

test('resuming restores original output and delivery evidence from history', async t => {
  const server = adapter('resume'); t.after(() => server.close());
  const snapshot = await server.inspect('thread-1');
  assert.equal(snapshot.status, 'completed');
  assert.ok(snapshot.outputs[0]?.text.includes('waiting_user'));
  assert.deepEqual(snapshot.seenInputIds, ['old-delivery']);
  assert.deepEqual(snapshot.requests, []);
});

for (const mode of ['approval', 'file-approval', 'permissions', 'question', 'multi-question', 'nonblocking-question']) test(`${mode} replies use the live native request ID`, async t => {
  const server = adapter(mode); t.after(() => server.close());
  const { threadId } = await start(server);
  const request = (await server.inspect(threadId)).requests[0];
  assert.ok(request);
  assert.notEqual(request.id, 'wire-approval');
  if (mode === 'approval' || mode === 'permissions') await assert.rejects(server.reply({ request, text: 'sure' }));
  if (mode === 'multi-question') await assert.rejects(server.reply({ request, text: '{"answers":{"root":{"answers":["one"]}}}' }));
  const text = mode === 'question' || mode === 'nonblocking-question' ? 'the answer' : mode === 'multi-question' ? '{"answers":{"root":{"answers":["one"]},"next":{"answers":["two"]}}}' : 'accept';
  if (request.kind === 'question') {
    assert.equal(request.isBlocking, mode !== 'nonblocking-question');
    await server.reply({ request, text });
  } else {
    await assert.rejects(server.reply({ request, text: 'accept' }), RejectedInputError);
    assert.equal(await server.respondApproval({ request, decision: 'approve' }), 'confirmed');
  }
  const snapshot = await server.inspect(threadId);
  assert.ok(snapshot.outputs[0]?.text.includes('Reproduced'));
  assert.deepEqual(snapshot.requests, []);
  await assert.rejects(server.reply({ request, text }));
});

test('request IDs from a previous connection cannot approve a new native request', async t => {
  const first = adapter('approval');
  const { threadId } = await start(first);
  const old = (await first.inspect(threadId)).requests[0];
  assert.ok(old);
  await first.close();
  const second = adapter('approval'); t.after(() => second.close());
  await start(second);
  const current = (await second.inspect(threadId)).requests[0];
  assert.ok(current);
  assert.notEqual(old.id, current.id);
  await assert.rejects(second.respondApproval({ request: old, decision: 'approve' }), /previous connection/);
  assert.equal((await second.inspect(threadId)).requests.length, 1);
});

test('server-resolved requests disappear and unsupported requests cannot be answered', async t => {
  const expired = adapter('expired'); t.after(() => expired.close());
  await start(expired);
  assert.deepEqual((await expired.inspect('thread-1')).requests, []);
  for (const mode of ['mcp-unsupported']) {
    const unsupported = adapter(mode); t.after(() => unsupported.close());
    await start(unsupported);
    const request = (await unsupported.inspect('thread-1')).requests[0];
    assert.ok(request);
    assert.equal(request.kind, 'unsupported');
    await assert.rejects(unsupported.reply({ request, text: 'accept' }), /Only native questions/);
  }
});

test('ordinary final text completes without a report schema', async t => {
  const server = adapter('invalid-report'); t.after(() => server.close());
  const { threadId } = await start(server);
  const snapshot = await server.inspect(threadId);
  assert.equal(snapshot.status, 'completed');
  assert.deepEqual(snapshot.outputs, [{ id: `${threadId}:turn-1:agent-final`, threadId, turnId: 'turn-1', phase: 'final', text: 'done' }]);
});

test('commentary is user-facing progress even when it contains JSON', async t => {
  const server = adapter('commentary-report'); t.after(() => server.close());
  const { threadId } = await start(server);
  assert.equal((await server.inspect(threadId)).outputs[0]?.phase, 'progress');
});

test('completion between metadata and history reads is reconciled', async t => {
  const server = adapter('completion-race'); t.after(() => server.close());
  const { threadId } = await start(server);
  const snapshot = await server.inspect(threadId);
  assert.equal(snapshot.status, 'completed');
  assert.ok(snapshot.outputs[0]?.text.includes('waiting_user'));
});

test('unavailable history is not converted into an idle or completed snapshot', async t => {
  const server = adapter('missing-history'); t.after(() => server.close());
  await assert.rejects(server.inspect('thread-1'), /history unavailable/);
});

test('a persisted active turn without live execution is an interrupted snapshot for bounded recovery', async t => {
  const server = adapter('orphaned'); t.after(() => server.close());
  const snapshot = await server.inspect('thread-1');
  assert.equal(snapshot.status, 'interrupted');
  assert.match(snapshot.error ?? '', /Persisted active turn has no live execution/);
});

test('steer distinguishes a proven turn mismatch from unrelated server rejection', async t => {
  const changed = adapter('turn-changed'); t.after(() => changed.close());
  const active = await start(changed);
  await assert.rejects(changed.steer({ ...active, deliveryId: 'next', input: [] }), TurnChangedError);
  const other = adapter('other-error'); t.after(() => other.close());
  const otherActive = await start(other);
  await assert.rejects(other.steer({ ...otherActive, deliveryId: 'next', input: [] }), error => error instanceof Error && !(error instanceof TurnChangedError));
});

test('timeout tears down transport and leaves side effects uncertain', async () => {
  const server = adapter('timeout', 50);
  await assert.rejects(server.createThread({ cwd: '/tmp', instructions: '' }), UncertainOperationError);
  await assert.rejects(server.inspect('thread-1'), UncertainOperationError);
  await server.close();
});

test('missing executable rejects initialization and closes cleanly', async () => {
  const server = new CodexAppServer({ command: ['/no/such/agent-loop-codex'], approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 100 });
  await assert.rejects(server.createThread({ cwd: '/tmp', instructions: '' }), /ENOENT/);
  await server.close();
});

test('close interrupts a live turn and reads terminal history before killing the process', async () => {
  const directory = await mkdtemp('/tmp/agent-loop-close-');
  const marker = `${directory}/terminal`;
  const server = new CodexAppServer({ command: [process.execPath, '-e', fixture, 'graceful-close', marker], approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 2000 });
  try {
    await start(server);
    await server.close();
    assert.equal(await readFile(marker, 'utf8'), 'terminal history confirmed');
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test('an approval without native resolution stays uncertain and cannot be replayed', async t => {
  const server = adapter('unconfirmed-approval', 2000); t.after(() => server.close());
  const { threadId } = await start(server);
  const request = (await server.inspect(threadId)).requests[0];
  assert.ok(request);
  assert.equal(await server.respondApproval({ request, decision: 'approve' }), 'uncertain');
  assert.equal((await server.inspect(threadId)).requests[0]?.id, request.id);
  await assert.rejects(server.respondApproval({ request, decision: 'approve' }), /already sent/);
});


test('completed progress survives repeated snapshots without leaking deltas, reasoning or tools', async t => {
  const server = adapter('outputs'); t.after(() => server.close());
  const active = await start(server);
  const first = await server.inspect(active.threadId);
  assert.deepEqual(first.outputs.map(output => [output.phase, output.text]), [['progress', 'Complete progress sentence.']]);
  assert.deepEqual((await server.inspect(active.threadId)).outputs, first.outputs);
  await server.steer({ ...active, deliveryId: 'complete', input: [] });
  const done = await server.inspect(active.threadId);
  assert.equal(done.outputs.length, 2);
  assert.deepEqual(done.outputs.map(output => output.id), ['thread-1:turn-1:progress-1', 'thread-1:turn-1:agent-final']);
  assert.equal(done.outputs[1]?.phase, 'final');
});

test('workspace provisioning remains asynchronous while an RPC and callback inspect are pending', async t => {
  const server = adapter('workspace'); t.after(() => server.close());
  const requests: unknown[] = [];
  server.setWorkspaceHandler(async request => {
    requests.push(request);
    assert.equal((await server.inspect(request.threadId)).threadId, 'thread-1');
    return { kind: 'git-worktree', id: 'resource-1', repository: { name: 'example/one', path: '/tmp/source', baseBranch: 'main', criteria: { states: ['open'], assigneesAny: [], taskTypes: ['feature'], labelsAll: [], labelsAny: [], labelsNone: [], nativeTypes: {}, typeLabels: {} } }, branch: 'task/one', workspace: '/tmp/owned-workspace' };
  });
  await start(server);
  let snapshot = await server.inspect('thread-1');
  for (let attempt = 0; snapshot.status === 'running' && attempt < 10; attempt++) snapshot = await server.inspect('thread-1');
  assert.equal(snapshot.status, 'completed');
  assert.deepEqual(requests, [{ threadId: 'thread-1', turnId: 'turn-1', callId: 'workspace-call', repository: 'example/one' }]);
});

test('dynamic project targets cross the adapter boundary with their exact Runtime identity', async t => {
  const server = adapter('workspace-project'); t.after(() => server.close());
  const requests: WorkspaceRequest[] = [];
  server.setWorkspaceHandler(async request => {
    requests.push(request);
    return { kind: 'project', id: 'resource-project', workspace: '/tmp/owned-workspace', project: {
      kind: 'project', id: 'project-fixture', name: 'local-project', entryPath: '/tmp/local-project', canonicalPath: '/tmp/owned-workspace',
    } };
  });
  await start(server);
  let snapshot = await server.inspect('thread-1');
  for (let attempt = 0; snapshot.status === 'running' && attempt < 10; attempt++) snapshot = await server.inspect('thread-1');
  assert.equal(snapshot.status, 'completed');
  assert.deepEqual(requests, [{ threadId: 'thread-1', turnId: 'turn-1', callId: 'workspace-call', projectId: 'project-fixture' }]);
});

test('inspection replaces historical developer instructions using the current runtime contract', async t => {
  const server = adapter('instructions'); t.after(() => server.close());
  const threadId = await server.createThread({ cwd: '/tmp', instructions: 'Old fixed report and reproduction gate' });
  assert.equal((await server.inspect(threadId, 'Current runtime contract')).status, 'idle');
  const turnId = await server.startTurn({ threadId, deliveryId: 'updated-contract', input: [] });
  await server.steer({ threadId, turnId, deliveryId: 'updated-steer', input: [] });
});

test('concurrent recovery replaces one transport and resumes the original thread without creating another', async () => {
  const directory = await mkdtemp('/tmp/agent-loop-recover-');
  const stateFile = `${directory}/state.json`;
  const server = new CodexAppServer({ command: [process.execPath, '-e', fixture, 'recover', stateFile], approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 2000 });
  try {
    const active = await start(server);
    await assert.rejects(server.steer({ ...active, deliveryId: 'crash', input: [] }), UncertainOperationError);
    await Promise.all([server.recover(), server.recover(), server.recover()]);
    const snapshot = await server.inspect(active.threadId);
    assert.equal(snapshot.status, 'interrupted');
    assert.equal(snapshot.threadId, active.threadId);
    assert.deepEqual(snapshot.seenInputIds, ['delivery-1']);
    await server.startTurn({ threadId: active.threadId, deliveryId: 'after-crash', input: [] });
    const calls = (await readFile(`${stateFile}.calls`, 'utf8')).trim().split('\n');
    assert.equal(calls.filter(method => method === 'initialize').length, 2);
    assert.equal(calls.filter(method => method === 'thread/start').length, 1);
    assert.equal(calls.filter(method => method === 'thread/resume').length, 1);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});


for (const mode of ['workspace-stale', 'workspace-unknown', 'workspace-completed', 'workspace-ambiguous', 'workspace-project-path']) test(`${mode} cannot create a workspace with an invalid native request`, async t => {
  const server = adapter(mode); t.after(() => server.close());
  let calls = 0;
  server.setWorkspaceHandler(async () => { calls++; throw new Error('must not provision'); });
  await start(server);
  for (let attempt = 0; attempt < 10; attempt++) await server.inspect('thread-1');
  assert.equal(calls, 0);
});

test('a repeated native request cannot reset an already submitted approval', async t => {
  const server = adapter('duplicate-approval', 2000); t.after(() => server.close());
  await start(server);
  const request = (await server.inspect('thread-1')).requests[0];
  assert.ok(request);
  assert.equal(await server.respondApproval({ request, decision: 'approve' }), 'uncertain');
  await assert.rejects(server.respondApproval({ request, decision: 'approve' }), /already sent/);
});

test('transport loss after approval write cannot become confirmation', async t => {
  const server = adapter('lost-approval'); t.after(() => server.close());
  await start(server);
  const request = (await server.inspect('thread-1')).requests[0];
  assert.ok(request);
  assert.equal(await server.respondApproval({ request, decision: 'approve' }), 'uncertain');
  await server.recover();
  await assert.rejects(server.respondApproval({ request, decision: 'approve' }), /previous connection/);
});

test('recover invalidates prior request epochs even when the native RPC ID is reused', async () => {
  const directory = await mkdtemp('/tmp/agent-loop-request-recover-');
  const server = new CodexAppServer({ command: [process.execPath, '-e', fixture, 'recover-request', `${directory}/state`], approvalPolicy: 'on-request', sandbox: 'read-only', requestTimeoutMs: 2000 });
  try {
    const active = await start(server);
    const old = (await server.inspect(active.threadId)).requests[0];
    assert.ok(old);
    await assert.rejects(server.steer({ ...active, deliveryId: 'crash', input: [] }), UncertainOperationError);
    await Promise.all([server.recover(), server.recover()]);
    await server.startTurn({ threadId: active.threadId, deliveryId: 'new-turn', input: [] });
    const current = (await server.inspect(active.threadId)).requests[0];
    assert.ok(current);
    assert.notEqual(current.connectionEpoch, old.connectionEpoch);
    assert.notEqual(current.id, old.id);
    await assert.rejects(server.respondApproval({ request: old, decision: 'approve' }), /previous connection/);
    assert.equal(await server.respondApproval({ request: current, decision: 'reject' }), 'confirmed');
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test('a workspace callback from the lost transport cannot answer the replacement transport', async t => {
  const server = adapter('workspace-loss'); t.after(() => server.close());
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  server.setWorkspaceHandler(async () => {
    calls++;
    if (calls === 1) { entered?.(); await held; }
    return { kind: 'git-worktree', id: 'one', repository: { name: 'example/one', path: '/tmp/source', baseBranch: 'main', criteria: { states: ['open'], assigneesAny: [], taskTypes: ['feature'], labelsAll: [], labelsAny: [], labelsNone: [], nativeTypes: {}, typeLabels: {} } }, branch: 'task/one', workspace: calls === 1 ? '/tmp/old-workspace' : '/tmp/owned-workspace' };
  });
  const active = await start(server);
  await started;
  await assert.rejects(server.steer({ ...active, deliveryId: 'crash', input: [] }), UncertainOperationError);
  await server.recover();
  release?.();
  await server.startTurn({ threadId: active.threadId, deliveryId: 'new-turn', input: [] });
  let snapshot = await server.inspect(active.threadId);
  for (let attempt = 0; snapshot.status === 'running' && attempt < 10; attempt++) snapshot = await server.inspect(active.threadId);
  assert.equal(snapshot.status, 'completed');
  assert.equal(calls, 2);
});


test('inspection waits for the accepted turn when native history temporarily still shows the previous state', async t => {
  const server = adapter('start-history-race'); t.after(() => server.close());
  const active = await start(server);
  const snapshot = await server.inspect(active.threadId);
  assert.equal(snapshot.turnId, active.turnId);
  assert.equal(snapshot.status, 'completed');
  assert.deepEqual(snapshot.seenInputIds, ['delivery-1']);
});


test('an accepted new turn is not mistaken for an orphan while native active status materializes', async t => {
  const server = adapter('start-status-race'); t.after(() => server.close());
  const active = await start(server);
  const snapshot = await server.inspect(active.threadId);
  assert.equal(snapshot.turnId, active.turnId);
  assert.equal(snapshot.status, 'running');
});


test('a resumed active turn waits for native history even without a local start receipt', async t => {
  const server = adapter('external-active-history'); t.after(() => server.close());
  const snapshot = await server.inspect('thread-1');
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.turnId, 'turn-1');
});
