import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { CodexAppServer } from './helpers/codex.js';
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
const record = method => { if (mode.startsWith('recover') || mode.startsWith('paginated-start-')) fs.appendFileSync(stateFile + '.calls', method + '\n'); };
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
  if (mode.startsWith('paginated-start-') && historyReads < 3) { result = { thread: { ...thread(), status: { type: 'idle' }, turns: [] } }; break; }
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
  if (mode.startsWith('paginated-start-')) {
   record(p.itemsView);
   if (++historyReads < 3 || mode === 'paginated-start-timeout') { send({ id: m.id, error: { code: -32601, message: 'list_turns is not supported yet' } }); return; }
   if (turns.at(-1).status === 'inProgress') { send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: turns.at(-1).id } } }); complete(); }
  }
  if (mode === 'paginated-materializing' && ++historyReads < 3) { send({ id: m.id, error: { code: -32603, message: 'list_turns is not supported yet' } }); return; }
  if (!turns.length) { send({ id: m.id, error: { code: -32000, message: 'thread is not materialized yet' } }); return; }
  if (p.itemsView === 'summary' && p.sortDirection === 'desc' && p.limit === 1 && p.cursor === null) {
   result = { data: turns.slice(-1).map(turn => ({ ...turn, itemsView: 'summary', items: turn.items.filter(item => ['userMessage', 'agentMessage'].includes(item.type)) })), nextCursor: null }; break;
  }
  if (p.itemsView !== 'full' || p.sortDirection !== 'asc') throw new Error('partial history requested');
  result = { data: turns, nextCursor: null }; break;
 case 'turn/start':
  if (mode === 'instructions' && (p.additionalContext?.['agent-loop-runtime']?.kind !== 'application' || !p.additionalContext['agent-loop-runtime'].value.includes('Current runtime contract'))) throw new Error('missing trusted runtime context');
  if (p.outputSchema !== undefined || !p.clientUserMessageId) throw new Error('forced output contract or missing delivery id');
  turns.push({ id: 'turn-' + (turns.length + 1), status: 'inProgress', items: [inputItem(p)] });
  persist();
  result = { turn: turns.at(-1) };
  if (mode.startsWith('paginated-start-')) {
   result = { turn: { ...turns.at(-1), items: [], itemsView: 'notLoaded' } };
   if (mode === 'paginated-start-completed') { send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: turns.at(-1).id } } }); complete(); }
  }
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

const settledFixture = String.raw`
const { createInterface } = require('node:readline');
const fs = require('node:fs');
const mode = process.argv[1];
const logFile = process.argv[2];
const generation = fs.existsSync(logFile) ? 2 : 1;
const user = (id, delivery) => ({ id, type: 'userMessage', clientId: null, content: [{ type: 'text', text: '[agent-loop-delivery:' + delivery + ']\n[agent-loop-batch:' + encodeURIComponent(JSON.stringify(['batch-' + delivery])) + ']' }] });
let turns = [
 { id: 'old', status: 'completed', error: null, items: [user('user-old', 'old'), { id: 'tool', type: 'commandExecution', aggregatedOutput: 'x'.repeat(100000) }, { id: 'old-final', type: 'agentMessage', text: 'Previous answer', phase: 'final_answer' }] },
 { id: 'latest', status: 'completed', error: null, items: [user('user-latest', 'latest'), { id: 'latest-final', type: 'agentMessage', text: 'Current answer', phase: 'final_answer' }] },
];
if (fs.existsSync(logFile + '.state')) turns = JSON.parse(fs.readFileSync(logFile + '.state', 'utf8'));
if (mode.startsWith('state-')) turns.at(-1).status = mode.slice(6);
let metadataReads = 0;
let summaryReads = 0;
let fullReads = 0;
let heldHead;
let heldMutation;
const thread = () => ({ id: 'thread-1', updatedAt: 100, historyMode: mode === 'legacy' ? 'legacy' : 'paginated', status: { type: mode === 'system-error' ? 'systemError' : turns.at(-1).status === 'inProgress' ? 'active' : 'idle' }, turns: [] });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const respond = (m, result) => {
 fs.appendFileSync(logFile, JSON.stringify({ method: m.method, params: m.params, bytes: Buffer.byteLength(JSON.stringify(result)) }) + '\n');
 send({ id: m.id, result });
};
const fail = (m, code, message) => { fs.appendFileSync(logFile, JSON.stringify({ method: m.method, params: m.params, bytes: 0 }) + '\n'); send({ id: m.id, error: { code, message } }); };
const summary = () => {
 const latest = turns.at(-1);
 return { data: [{ ...latest, itemsView: 'summary', items: latest.items.filter(item => ['userMessage', 'agentMessage'].includes(item.type)) }], nextCursor: null };
};
const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reorder(entry)])) : value;
const notify = () => send({ method: mode === 'event-unscoped' ? 'error' : 'thread/status/changed', params: mode === 'event-unscoped' ? { error: { message: 'thread changed' } } : { threadId: mode === 'event-other' ? 'another-thread' : 'thread-1', status: { type: 'idle' } } });
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'initialized') return;
 switch (m.method) {
 case 'initialize': respond(m, {}); break;
 case 'thread/resume': respond(m, { thread: thread() }); break;
 case 'thread/read':
  if (!m.params.includeTurns) metadataReads++;
  if (mode === 'head-change' && metadataReads === 2) { turns.at(-1).items[0] = user('user-latest', 'changed'); turns.at(-1).items[1].text = 'Changed answer'; }
  if (mode === 'event-metadata' && metadataReads === 2) notify();
  if (mode.startsWith('recover') && generation === 1 && metadataReads === (mode === 'recover-unsupported' ? 3 : 2)) {
   turns[0].items.push(user('recovered-user', 'recovered'));
   fs.writeFileSync(logFile + '.state', JSON.stringify(turns)); process.exit(23);
  }
  if (mode === 'native-request' && metadataReads === 4) send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'pending' } });
  respond(m, { thread: { ...thread(), turns: m.params.includeTurns ? turns : [] } }); break;
 case 'thread/turns/list': {
  const p = m.params;
  if (p.itemsView === 'summary') {
   if (p.sortDirection !== 'desc' || p.cursor !== null || p.limit !== 1) throw new Error('incorrect newest summary request');
   summaryReads++;
   if (mode === 'unsupported-method' || mode === 'recover-unsupported' && generation === 1) { fail(m, -32601, 'method not found'); break; }
   if (mode === 'unsupported-params') { fail(m, -32602, 'unknown variant summary'); break; }
   if (['transient', 'materializing', 'materializing-method'].includes(mode) && summaryReads === 2) { fail(m, mode === 'transient' ? -32000 : mode === 'materializing-method' ? -32601 : -32603, mode === 'transient' ? 'history unavailable' : 'list_turns is not supported yet'); break; }
   if (mode.startsWith('mutation-') && summaryReads === 2) {
    heldHead = { m, result: summary() };
    fs.appendFileSync(logFile, JSON.stringify({ method: 'head-held', bytes: 0 }) + '\n'); break;
   }
   if (['event-head', 'event-unscoped', 'event-other'].includes(mode) && summaryReads === 2) notify();
   if (mode === 'native-request' && summaryReads === 2) send({ id: 'pending', method: 'mcpServer/elicitation/request', params: { threadId: 'thread-1', serverName: 'fixture' } });
   respond(m, mode === 'reordered' && summaryReads % 2 === 0 ? reorder(summary()) : summary());
  } else {
   if (p.itemsView !== 'full' || p.sortDirection !== 'asc') throw new Error('incorrect full history request');
   const first = p.cursor === null;
   if (!first && p.cursor !== 'next') throw new Error('incorrect history cursor');
   fullReads++;
   if (mode === 'event-full' && fullReads === 2) notify();
   if (mode === 'head-disagrees' && fullReads === 1) turns.at(-1).items[1].text = 'Changed during full read';
   if (mode === 'incomplete') { respond(m, { data: summary().data, nextCursor: null }); break; }
   if (heldMutation) {
    const { m: pending, turn, ambiguous } = heldMutation; heldMutation = undefined;
    if (ambiguous) fail(pending, -32000, 'delivery acknowledgement uncertain');
    else respond(pending, pending.method === 'turn/steer' ? { turnId: turn.id } : { turn });
   }
   respond(m, { data: first ? turns.slice(0, 1) : turns.slice(1), nextCursor: first ? 'next' : null });
  }
  break;
 }
 case 'turn/start':
 case 'turn/steer': {
  const p = m.params;
  if (!heldHead) throw new Error('mutation must race an awaited summary');
  const item = { id: 'new-user', type: 'userMessage', clientId: p.clientUserMessageId, content: p.input };
  if (m.method === 'turn/start') turns.push({ id: 'next', status: 'completed', error: null, items: [item] });
  else turns.at(-1).items.push(item);
  heldMutation = { m, turn: turns.at(-1), ambiguous: mode.includes('ambiguous') };
  respond(heldHead.m, heldHead.result); heldHead = undefined;
  break;
 }
 case 'turn/interrupt': turns.at(-1).status = 'interrupted'; respond(m, {}); break;
 default: throw new Error('unexpected method ' + m.method);
 }
});
`;

const wireCallSchema = z.object({ method: z.string(), params: z.object({ itemsView: z.string().optional(), includeTurns: z.boolean().optional() }).passthrough().optional(), bytes: z.number() });

async function settledAdapter(t: TestContext, mode = 'settled') {
  const directory = await mkdtemp('/tmp/agent-loop-settled-');
  const logFile = `${directory}/wire.jsonl`;
  const server = new CodexAppServer({ command: [process.execPath, '-e', settledFixture, mode, logFile], approvalPolicy: 'on-request', sandbox: 'read-only', requestTimeoutMs: 2000 });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const wire = async () => (await readFile(logFile, 'utf8')).trim().split('\n').map(line => wireCallSchema.parse(JSON.parse(line)));
  const headHeld = async () => {
    while (!(await wire()).some(call => call.method === 'head-held')) await delay(5, undefined, { signal: t.signal });
  };
  const fullReads = async () => (await wire()).filter(call => call.params?.itemsView === 'full' || call.params?.includeTurns).length;
  return { server, wire, headHeld, fullReads };
}

test('repeated settled inspections preserve complete snapshots without full history calls or bytes', async t => {
  const { server, wire } = await settledAdapter(t);
  const first = await server.inspect('thread-1');
  assert.deepEqual(first, {
    threadId: 'thread-1', turnId: 'latest', status: 'completed', error: null, requests: [],
    seenInputIds: ['old', 'batch-old', 'latest', 'batch-latest'],
    outputs: [
      { id: 'thread-1:old:old-final', threadId: 'thread-1', turnId: 'old', phase: 'final', text: 'Previous answer' },
      { id: 'thread-1:latest:latest-final', threadId: 'thread-1', turnId: 'latest', phase: 'final', text: 'Current answer' },
    ],
  });
  const initial = await wire();
  for (let i = 0; i < 3; i++) assert.deepEqual(await server.inspect('thread-1'), first);
  const repeated = (await wire()).slice(initial.length);
  const full = (calls: typeof initial) => calls.filter(call => call.params?.itemsView === 'full');
  assert.equal(full(initial).length, 2);
  assert.equal(full(repeated).length, 0, 'settled polling must not reread full tool history');
  assert.equal(repeated.filter(call => call.method === 'thread/read').length, 3);
  assert.equal(repeated.filter(call => call.params?.itemsView === 'summary').length, 3);
  assert.ok(repeated.every(call => call.bytes < 2000), 'every repeated response must stay compact');
  t.diagnostic(JSON.stringify({ initialFullBytes: full(initial).reduce((sum, call) => sum + call.bytes, 0), repeatedFullBytes: full(repeated).reduce((sum, call) => sum + call.bytes, 0), repeatedResponseBytes: repeated.reduce((sum, call) => sum + call.bytes, 0) }));
});

test('summary digests are stable across native JSON property order', async t => {
  const { server, fullReads } = await settledAdapter(t, 'reordered');
  const first = await server.inspect('thread-1');
  for (let i = 0; i < 3; i++) assert.deepEqual(await server.inspect('thread-1'), first);
  assert.equal(await fullReads(), 2);
});

test('changed summary content without notifications or timestamp changes restores full input and output evidence', async t => {
  const { server, fullReads } = await settledAdapter(t, 'head-change');
  await server.inspect('thread-1');
  const changed = await server.inspect('thread-1');
  assert.equal(changed.turnId, 'latest');
  assert.deepEqual(changed.seenInputIds, ['old', 'batch-old', 'changed', 'batch-changed']);
  assert.equal(changed.outputs.at(-1)?.text, 'Changed answer');
  assert.equal(await fullReads(), 4);
  assert.deepEqual(await server.inspect('thread-1'), changed);
  assert.equal(await fullReads(), 4);
});

for (const mode of ['event-metadata', 'event-head', 'event-unscoped', 'event-full']) test(`${mode} invalidates the observation during awaited reads`, async t => {
  const { server, fullReads } = await settledAdapter(t, mode);
  const first = await server.inspect('thread-1');
  assert.deepEqual(await server.inspect('thread-1'), first);
  assert.equal(await fullReads(), 4);
  assert.deepEqual(await server.inspect('thread-1'), first);
  assert.equal(await fullReads(), mode === 'event-full' ? 4 : 6);
  assert.deepEqual(await server.inspect('thread-1'), first);
  assert.equal(await fullReads(), mode === 'event-full' ? 4 : 6);
});

test('a scoped native event does not invalidate a different settled thread', async t => {
  const { server, fullReads } = await settledAdapter(t, 'event-other');
  const first = await server.inspect('thread-1');
  assert.deepEqual(await server.inspect('thread-1'), first);
  assert.equal(await fullReads(), 2);
});

test('a full-history head that disagrees with the checked summary is not cached', async t => {
  const { server, fullReads } = await settledAdapter(t, 'head-disagrees');
  const first = await server.inspect('thread-1');
  assert.equal(first.outputs.at(-1)?.text, 'Changed during full read');
  assert.deepEqual(await server.inspect('thread-1'), first);
  assert.equal(await fullReads(), 4);
  assert.deepEqual(await server.inspect('thread-1'), first);
  assert.equal(await fullReads(), 4);
});

for (const operation of ['start', 'steer']) for (const outcome of ['accepted', 'ambiguous']) test(`${operation} invalidates before its awaited ${outcome} mutation and reconciles delivery markers`, async t => {
  const { server, headHeld, fullReads } = await settledAdapter(t, `mutation-${operation}-${outcome}`);
  await server.inspect('thread-1');
  const polling = server.inspect('thread-1');
  await headHeld();
  const input = { threadId: 'thread-1', deliveryId: 'new-input', input: [{ kind: 'text', text: 'Continue this task' }] satisfies Parameters<CodexAppServer['startTurn']>[0]['input'] };
  const mutation = operation === 'start'
    ? server.startTurn({ ...input, additionalDeliveryIds: ['directory-answer'] })
    : server.steer({ ...input, turnId: 'latest' });
  const [snapshot] = await Promise.all([polling, outcome === 'ambiguous' ? assert.rejects(mutation, /delivery acknowledgement uncertain/) : mutation]);
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.turnId, operation === 'start' ? 'next' : 'latest');
  assert.deepEqual(snapshot.seenInputIds, ['old', 'batch-old', 'latest', 'batch-latest', 'new-input', ...(operation === 'start' ? ['directory-answer'] : [])]);
  assert.equal(await fullReads(), 4);
  const reconciled = await server.inspect('thread-1');
  assert.deepEqual(reconciled, snapshot);
  assert.equal(await fullReads(), 6);
  assert.deepEqual(await server.inspect('thread-1'), reconciled);
  assert.equal(await fullReads(), 6);
});

test('live unscoped-turn requests block compact history until native resolution', async t => {
  const { server, fullReads } = await settledAdapter(t, 'native-request');
  const first = await server.inspect('thread-1');
  for (let i = 0; i < 3; i++) assert.deepEqual(await server.inspect('thread-1'), first);
  assert.equal(await fullReads(), 8);
  assert.deepEqual(await server.inspect('thread-1'), first);
  assert.equal(await fullReads(), 10);
  assert.deepEqual(await server.inspect('thread-1'), first);
  assert.equal(await fullReads(), 10);
});

for (const mode of ['legacy', 'unsupported-method', 'unsupported-params']) test(`${mode} keeps complete history fallback and unsupported summary is sticky`, async t => {
  const { server, wire, fullReads } = await settledAdapter(t, mode);
  const first = await server.inspect('thread-1');
  for (let i = 0; i < 3; i++) assert.deepEqual(await server.inspect('thread-1'), first);
  assert.equal(await fullReads(), mode === 'legacy' ? 4 : 8);
  assert.equal((await wire()).filter(call => call.params?.itemsView === 'summary').length, mode === 'legacy' ? 0 : 1);
});

for (const mode of ['transient', 'materializing', 'materializing-method']) test(`${mode} summary failure preserves uncertainty and does not disable summary for the connection`, async t => {
  const { server, wire, fullReads } = await settledAdapter(t, mode);
  const first = await server.inspect('thread-1');
  await assert.rejects(server.inspect('thread-1'), mode === 'transient' ? /history unavailable/ : /list_turns is not supported yet/);
  assert.deepEqual(await server.inspect('thread-1'), first);
  assert.equal(await fullReads(), 4);
  assert.deepEqual(await server.inspect('thread-1'), first);
  assert.equal(await fullReads(), 4);
  assert.equal((await wire()).filter(call => call.params?.itemsView === 'summary').length, 4);
});

for (const mode of ['recover', 'recover-unsupported']) test(`${mode} discards prior connection proof and retries summary on the new connection`, async t => {
  const { server, wire, fullReads } = await settledAdapter(t, mode);
  await server.inspect('thread-1');
  if (mode === 'recover-unsupported') await server.inspect('thread-1');
  const before = await fullReads();
  await assert.rejects(server.inspect('thread-1'), UncertainOperationError);
  await Promise.all([server.recover(), server.recover()]);
  const recovered = await server.inspect('thread-1');
  assert.deepEqual(recovered.seenInputIds, ['old', 'batch-old', 'recovered', 'batch-recovered', 'latest', 'batch-latest']);
  assert.equal(recovered.outputs.length, 2);
  assert.equal(await fullReads(), before + 2);
  assert.deepEqual(await server.inspect('thread-1'), recovered);
  assert.equal(await fullReads(), before + 2);
  assert.equal((await wire()).filter(call => call.method === 'initialize').length, 2);
  assert.equal((await wire()).filter(call => call.params?.itemsView === 'summary').length, 3);
});

for (const [mode, status] of [['state-inProgress', 'running'], ['state-failed', 'failed'], ['state-interrupted', 'interrupted'], ['system-error', 'failed']] as const) test(`${mode} never publishes a completed history cache`, async t => {
  const { server, fullReads } = await settledAdapter(t, mode);
  const first = await server.inspect('thread-1');
  assert.equal(first.status, status);
  assert.deepEqual(await server.inspect('thread-1'), first);
  assert.equal(await fullReads(), 4);
});

test('incomplete full pages cannot become a compact completed snapshot', async t => {
  const { server, fullReads } = await settledAdapter(t, 'incomplete');
  await assert.rejects(server.inspect('thread-1'), /history is incomplete/);
  await assert.rejects(server.inspect('thread-1'), /history is incomplete/);
  assert.equal(await fullReads(), 2);
});

test('instruction replacement invalidates a settled observation even with an unchanged head', async t => {
  const { server, fullReads } = await settledAdapter(t);
  const first = await server.inspect('thread-1', 'Original instructions');
  assert.deepEqual(await server.inspect('thread-1', 'New instructions'), first);
  assert.equal(await fullReads(), 4);
  assert.deepEqual(await server.inspect('thread-1', 'New instructions'), first);
  assert.equal(await fullReads(), 4);
});

test('interrupt invalidates completed proof before the native mutation', async t => {
  const { server, fullReads } = await settledAdapter(t);
  await server.inspect('thread-1');
  await server.interrupt({ threadId: 'thread-1', turnId: 'latest' });
  assert.equal((await server.inspect('thread-1')).status, 'interrupted');
  assert.equal(await fullReads(), 4);
});

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

for (const mode of ['paginated-start-idle', 'paginated-start-completed', 'paginated-start-timeout']) test(`${mode} retains accepted-turn uncertainty until native history materializes`, async t => {
  const directory = await mkdtemp('/tmp/agent-loop-materializing-');
  const stateFile = `${directory}/state`;
  const server = new CodexAppServer({ command: [process.execPath, '-e', fixture, mode, stateFile], approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 2000 });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const threadId = await server.createThread({ cwd: '/tmp', instructions: 'Wait for reproduction confirmation' });
  assert.equal((await server.inspect(threadId)).status, 'idle');
  const turnId = await server.startTurn({ threadId, input: [{ kind: 'text', text: 'Investigate' }], deliveryId: 'delivery-1' });
  assert.deepEqual(await server.activity(threadId), { kind: 'reconcile' });
  if (mode === 'paginated-start-timeout') {
    await assert.rejects(server.inspect(threadId), UncertainOperationError);
    await assert.rejects(server.inspect(threadId), UncertainOperationError);
  } else {
    const snapshot = await server.inspect(threadId);
    assert.equal(snapshot.turnId, turnId);
    assert.equal(snapshot.status, 'completed');
    assert.deepEqual(snapshot.seenInputIds, ['delivery-1']);
    assert.equal(snapshot.outputs.length, 1);
    const calls = (await readFile(`${stateFile}.calls`, 'utf8')).trim().split('\n');
    assert.equal(calls.filter(method => method === 'summary').length, 3);
    assert.equal(calls.filter(method => method === 'full').length, 1);
    assert.deepEqual(await server.inspect(threadId), snapshot);
    assert.deepEqual(await server.inspect(threadId), snapshot);
    const cachedCalls = (await readFile(`${stateFile}.calls`, 'utf8')).trim().split('\n');
    assert.equal(cachedCalls.filter(method => method === 'summary').length, 5);
    assert.equal(cachedCalls.filter(method => method === 'full').length, mode === 'paginated-start-idle' ? 2 : 1);
  }
  const calls = (await readFile(`${stateFile}.calls`, 'utf8')).trim().split('\n');
  assert.equal(calls.filter(method => method === 'turn/start').length, 1);
  assert.equal(calls.filter(method => method === 'turn/steer').length, 0);
  assert.equal(calls.filter(method => method === 'thread/resume').length, 0);
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
  const requests: WorkspaceRequest[] = [];
  server.setWorkspaceHandler(async request => {
    requests.push(request);
    assert.equal((await server.inspect(request.threadId)).threadId, 'thread-1');
    return { kind: 'git-worktree', id: 'resource-1', repository: { name: 'example/one', path: '/tmp/source', baseBranch: 'main', criteria: { states: ['open'], assigneesAny: [], taskTypes: ['feature'], labelsAll: [], labelsAny: [], labelsNone: [], nativeTypes: {}, typeLabels: {} } }, branch: 'task/one', workspace: '/tmp/owned-workspace' };
  });
  await start(server);
  let snapshot = await server.inspect('thread-1');
  for (let attempt = 0; snapshot.status === 'running' && attempt < 10; attempt++) snapshot = await server.inspect('thread-1');
  assert.equal(snapshot.status, 'completed');
  assert.ok(requests[0]?.connectionEpoch);
  assert.deepEqual(requests, [{ threadId: 'thread-1', turnId: 'turn-1', connectionEpoch: requests[0]?.connectionEpoch, callId: 'workspace-call', repository: 'example/one' }]);
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
  assert.ok(requests[0]?.connectionEpoch);
  assert.deepEqual(requests, [{ threadId: 'thread-1', turnId: 'turn-1', connectionEpoch: requests[0]?.connectionEpoch, callId: 'workspace-call', projectId: 'project-fixture' }]);
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

test('sealed execution usage probe reads status without resuming or starting a retained thread', async t => {
  const { server, wire } = await settledAdapter(t);
  assert.equal(await server.executionUse('thread-1'), 'idle');
  assert.equal(await server.executionUse('thread-1'), 'idle');
  const calls = await wire();
  assert.equal(calls.filter(call => call.method === 'thread/read').length, 2);
  assert.equal(calls.filter(call => ['thread/resume', 'thread/start', 'turn/start', 'turn/steer'].includes(call.method)).length, 0);
});

const nativePolicyFixture = String.raw`
const fs = require('node:fs');
const { createInterface } = require('node:readline');
const root = process.argv[1];
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const state = fs.existsSync(root + '/state.json') ? JSON.parse(fs.readFileSync(root + '/state.json', 'utf8')) : {};
const loaded = new Set();
let deniedWithClosedInput = false;
setInterval(() => {
  const file = root + '/deny-with-closed-stdin.json';
  if (deniedWithClosedInput || !fs.existsSync(file)) return;
  deniedWithClosedInput = true;
  const request = JSON.parse(fs.readFileSync(file, 'utf8'));
  process.stdin.destroy();
  try { fs.closeSync(0); } catch {}
  fs.writeFileSync(root + '/alive-pid', String(process.pid));
  send(request);
}, 10);
const persist = () => fs.writeFileSync(root + '/state.json', JSON.stringify(state));
const thread = (id, includeTurns = false) => ({ id, status: { type: !loaded.has(id) ? 'notLoaded' : state[id]?.at(-1)?.status === 'inProgress' ? 'active' : 'idle' }, turns: includeTurns ? state[id] || [] : [] });
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  fs.appendFileSync(root + '/wire.jsonl', JSON.stringify(m) + '\n');
  if (!m.method) {
    if (!fs.existsSync(root + '/unconfirmed')) send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: m.id } });
    return;
  }
  if (m.method === 'initialized') return;
  const p = m.params;
  let result;
  switch (m.method) {
    case 'initialize': result = { userAgent: 'native-policy-fixture' }; break;
    case 'thread/start': {
      const id = 'thread-' + (Object.keys(state).length + 1);
      state[id] = []; loaded.add(id); persist(); result = { thread: thread(id) }; break;
    }
    case 'thread/resume':
      loaded.add(p.threadId);
      for (const turn of state[p.threadId] || []) if (turn.status === 'inProgress') turn.status = 'interrupted';
      persist(); result = { thread: thread(p.threadId) }; break;
    case 'thread/read':
      if (fs.existsSync(root + '/queue.json')) {
        const frames = JSON.parse(fs.readFileSync(root + '/queue.json', 'utf8')); fs.unlinkSync(root + '/queue.json');
        for (const frame of frames) {
          if (frame.method === 'turn/completed') {
            const turn = state[frame.params.threadId].find(turn => turn.id === frame.params.turn.id);
            turn.status = 'completed'; persist();
          }
          send(frame);
        }
      }
      result = { thread: thread(p.threadId, p.includeTurns) }; break;
    case 'turn/start': {
      const turn = { id: 'turn-' + (state[p.threadId].length + 1), status: 'inProgress', items: [{ id: p.clientUserMessageId, type: 'userMessage', clientId: p.clientUserMessageId, content: [] }] };
      state[p.threadId].push(turn); persist(); result = { turn }; break;
    }
    case 'turn/steer':
      if (p.clientUserMessageId === 'crash') process.exit(23);
      result = { turnId: p.expectedTurnId }; break;
    case 'turn/interrupt': state[p.threadId].at(-1).status = 'interrupted'; persist(); result = {}; break;
    default: throw new Error('Unexpected method ' + m.method);
  }
  send({ id: m.id, result });
});
`;

const policyWireSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional() });
async function nativePolicyAdapter(t: TestContext) {
  const root = await mkdtemp('/tmp/agent-loop-native-policy-');
  const server = new CodexAppServer({ command: [process.execPath, '-e', nativePolicyFixture, root], approvalPolicy: 'on-request', sandbox: 'read-only', requestTimeoutMs: 1500 });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const completed = new Set<string>(); server.setThreadCompletionPolicy({ isCompleted: threadId => completed.has(threadId) });
  const active = await start(server), observer = await server.createThread({ cwd: '/tmp', instructions: 'Observe protocol only' });
  const wire = async () => (await readFile(`${root}/wire.jsonl`, 'utf8')).trim().split('\n').map(line => policyWireSchema.parse(JSON.parse(line)));
  const inject = async (frames: { id?: string; method: string; params: unknown }[]) => {
    await writeFile(`${root}/queue.json`, JSON.stringify(frames)); await server.executionUse(observer);
  };
  const responses = async (count: number) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const frames = (await wire()).filter(frame => !frame.method);
      if (frames.length >= count) return frames;
      await delay(10);
    }
    throw new Error(`Expected ${count} native responses`);
  };
  return { root, server, completed, active, observer, wire, inject, responses };
}

test('native completion admission sees authoritative nonblocking and unacknowledged requests', async t => {
  const f = await nativePolicyAdapter(t);
  assert.throws(() => f.server.assertThreadCompletionAllowed('unknown-thread'), /state is unavailable/);
  assert.doesNotThrow(() => f.server.assertThreadCompletionAllowed(f.active.threadId));
  const params = { ...f.active, itemId: 'question', isBlocking: false, questions: [{ id: 'target', header: 'Target', question: 'Which target?', options: null }] };
  await f.inject([{ id: 'existing-question', method: 'item/tool/requestUserInput', params }]);
  assert.throws(() => f.server.assertThreadCompletionAllowed(f.active.threadId), /native requests/);
  const request = (await f.server.inspect(f.active.threadId)).requests[0]; assert.ok(request); assert.equal(request.isBlocking, false);
  await writeFile(`${f.root}/unconfirmed`, 'lose resolution acknowledgement');
  await assert.rejects(f.server.reply({ request, text: 'the actual owner answer' }), /acknowledgement/);
  assert.throws(() => f.server.assertThreadCompletionAllowed(f.active.threadId), /native requests/);
  await f.inject([{ method: 'serverRequest/resolved', params: { threadId: f.active.threadId, requestId: 'existing-question' } }]);
  assert.doesNotThrow(() => f.server.assertThreadCompletionAllowed(f.active.threadId));
});

test('completed native policy denies late requests without permissions, answers, tool handlers or new turns', async t => {
  const f = await nativePolicyAdapter(t); f.completed.add(f.active.threadId);
  let toolCalls = 0; f.server.setWorkspaceHandler(async () => { toolCalls++; throw new Error('Sealed handler reached'); });
  const params = { ...f.active, itemId: 'late', startedAtMs: 1, cwd: '/tmp', command: 'effect' };
  const before = (await f.wire()).length;
  await f.inject([
    { id: 'command', method: 'item/commandExecution/requestApproval', params },
    { id: 'file', method: 'item/fileChange/requestApproval', params },
    { id: 'permissions', method: 'item/permissions/requestApproval', params: { ...params, permissions: { network: { enabled: true } } } },
    { id: 'question', method: 'item/tool/requestUserInput', params: { ...params, isBlocking: false, questions: [{ id: 'q', header: 'Q', question: 'Continue?', options: null }] } },
    { id: 'unsupported', method: 'mcpServer/elicitation/request', params },
    { id: 'dynamic', method: 'item/tool/call', params: { ...params, callId: 'call', tool: 'ensure_workspace', arguments: { repository: 'example/app' } } },
  ]);
  const responses = await f.responses(6), byId = new Map(responses.map(frame => [frame.id, frame]));
  assert.deepEqual(byId.get('command')?.result, { decision: 'decline' }); assert.deepEqual(byId.get('file')?.result, { decision: 'decline' });
  assert.deepEqual(byId.get('permissions')?.result, { permissions: {}, scope: 'turn' });
  for (const id of ['question', 'unsupported']) { assert.equal(byId.get(id)?.error?.code, -32000); assert.equal(byId.get(id)?.result, undefined); }
  assert.deepEqual(byId.get('dynamic')?.result, { success: false, contentItems: [{ type: 'inputText', text: 'Task completed' }] });
  assert.equal(toolCalls, 0); assert.equal(await f.server.executionUse(f.active.threadId), 'busy');
  await assert.rejects(f.server.inspect(f.active.threadId), /sealed/);
  await assert.rejects(f.server.startTurn({ threadId: f.active.threadId, input: [], deliveryId: 'forbidden' }), /sealed/);
  await assert.rejects(f.server.steer({ ...f.active, input: [], deliveryId: 'forbidden' }), /sealed/);
  const after = (await f.wire()).slice(before);
  assert.equal(after.filter(frame => ['thread/resume', 'thread/start', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(frame.method ?? '')).length, 0);
  assert.equal(await f.server.executionUse(f.observer), 'idle');
});

test('unacknowledged late native denial stays busy and is never replayed before terminal evidence', async t => {
  const f = await nativePolicyAdapter(t); await writeFile(`${f.root}/unconfirmed`, 'lose denial acknowledgement');
  f.completed.add(f.active.threadId);
  const request = { id: 'late-question', method: 'item/tool/requestUserInput', params: { ...f.active, itemId: 'late', isBlocking: true, questions: [{ id: 'q', header: 'Q', question: 'Continue?', options: null }] } };
  await f.inject([request]); await f.responses(1); await delay(1550);
  assert.equal(await f.server.executionUse(f.active.threadId), 'busy');
  assert.throws(() => f.server.assertThreadCompletionAllowed(f.active.threadId), /native requests/);
  await f.inject([request]); assert.equal((await f.responses(1)).length, 1);
  await f.inject([{ method: 'turn/completed', params: { threadId: f.active.threadId, turn: { id: f.active.turnId } } }]);
  assert.equal(await f.server.executionUse(f.active.threadId), 'idle');
  assert.equal((await f.responses(1)).length, 1);
});

test('native completion policy excludes sealed threads from transport recovery and preserves unknown use', async t => {
  const f = await nativePolicyAdapter(t);
  const openTurn = await f.server.startTurn({ threadId: f.observer, input: [], deliveryId: 'open-task' });
  f.completed.add(f.active.threadId);
  await assert.rejects(f.server.steer({ threadId: f.observer, turnId: openTurn, input: [], deliveryId: 'crash' }), UncertainOperationError);
  await f.server.recover();
  assert.equal((await f.wire()).filter(frame => frame.method === 'thread/resume').length, 0);
  assert.throws(() => f.server.assertThreadCompletionAllowed(f.observer), /state is unavailable/);
  assert.equal(await f.server.executionUse(f.active.threadId), 'unknown');
  await assert.rejects(f.server.inspect(f.active.threadId), /sealed/);
  assert.equal((await f.server.inspect(f.observer)).status, 'interrupted');
  const resumed = (await f.wire()).filter(frame => frame.method === 'thread/resume').map(frame => z.object({ threadId: z.string() }).parse(frame.params).threadId);
  assert.deepEqual(resumed, [f.observer]);
});


test('late denial transport failure retains uncertainty without killing the shared app server', async t => {
  const f = await nativePolicyAdapter(t); f.completed.add(f.active.threadId);
  await writeFile(`${f.root}/deny-with-closed-stdin.json`, JSON.stringify({ id: 'late-broken-transport', method: 'item/commandExecution/requestApproval', params: { ...f.active, itemId: 'late', startedAtMs: 1, cwd: '/tmp', command: 'effect' } }));
  let pid: number | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const saved = await readFile(`${f.root}/alive-pid`, 'utf8').catch(() => '');
    if (saved) { pid = Number(saved); break; }
    await delay(10);
  }
  assert.ok(pid); await delay(100);
  assert.equal(await f.server.executionUse(f.active.threadId), 'busy');
  assert.doesNotThrow(() => process.kill(pid, 0));
  assert.throws(() => f.server.assertThreadCompletionAllowed(f.active.threadId), /native requests/);
  const wire = await f.wire();
  assert.equal(wire.filter(frame => frame.method === 'initialize').length, 1);
  assert.equal(wire.filter(frame => frame.id === 'late-broken-transport').length, 0);
});
