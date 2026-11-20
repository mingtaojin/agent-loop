import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServer } from '../src/adapters/codex.js';
import type { CodexConnector } from '../src/adapters/codex-daemon.js';

function fixture(thread: unknown) {
  const calls: { method?: string; params?: unknown }[] = [];
  const connector: CodexConnector = async handlers => ({
    close: async () => {},
    send: async body => {
      const request = JSON.parse(body); calls.push(request);
      if (request.id === undefined) return;
      if (request.method !== 'initialize' && request.method !== 'thread/read') throw new Error('History read performed an execution operation');
      queueMicrotask(() => handlers.message(JSON.stringify({ id: request.id, result: request.method === 'initialize' ? {} : { thread } })));
    },
  });
  const adapter = new CodexAppServer({ approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 1000 }, connector);
  return { adapter, calls };
}
const turn = { id: 'turn', itemsView: 'full', status: 'failed', startedAt: null, completedAt: null, error: { message: 'Visible failure' }, items: [
  { id: 'private', type: 'reasoning', text: 'PRIVATE_REASONING' },
  { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'PRIVATE_PROMPT' }] },
  { id: 'message', type: 'agentMessage', phase: 'final_answer', text: 'Complete answer' },
  { id: 'command', type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'PRIVATE_OUTPUT', exitCode: 0, startedAtMs: 1234 },
] };

test('unloaded current Threads expose visible history without resume, ownership, native replies or synthetic time', async t => {
  const f = fixture({ id: 'thread', historyMode: 'paginated', status: { type: 'notLoaded' }, turns: [turn] });
  t.after(() => f.adapter.close());
  const first = await f.adapter.readHistory('thread'), second = await f.adapter.readHistory('thread');
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(event => [event.kind, event.text, event.createdAt]), [
    ['agent_message', 'Complete answer', null], ['tool_end', '$ npm test', 1234], ['turn_end', 'failed\nVisible failure', null],
  ]);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_/);
  assert.deepEqual(f.calls.filter(call => call.method !== 'initialize' && call.method !== 'initialized').map(call => [call.method, call.params]), [
    ['thread/read', { threadId: 'thread', includeTurns: true }], ['thread/read', { threadId: 'thread', includeTurns: true }],
  ]);
  assert.throws(() => f.adapter.assertThreadCompletionAllowed('thread'), /unavailable/);
});

for (const [name, thread] of [
  ['wrong Thread', { id: 'other', turns: [turn] }],
  ['incomplete items', { id: 'thread', turns: [{ ...turn, itemsView: 'summary' }] }],
  ['repeated turns', { id: 'thread', turns: [turn, turn] }],
  ['malformed visible item', { id: 'thread', turns: [{ ...turn, items: [{ type: 'agentMessage', id: 'bad', text: 123 }] }] }],
] as const) test(`history rejects ${name} instead of presenting incomplete history`, async t => {
  const f = fixture(thread); t.after(() => f.adapter.close()); await assert.rejects(f.adapter.readHistory('thread'));
});

test('active canonical assistant snapshots stay partial and retain actual turn time', async t => {
  const f = fixture({ id: 'thread', turns: [{ ...turn, status: 'inProgress', error: null, startedAt: 123, items: [{ type: 'agentMessage', id: 'partial', phase: 'commentary', text: 'hello' }] }] });
  t.after(() => f.adapter.close());
  const history = await f.adapter.readHistory('thread');
  assert.equal(history[0]?.kind, 'agent_delta'); assert.equal(history[0]?.createdAt, 123000);
});

for (const phase of ['commentary', 'final_answer']) {
  for (const completedAtMs of [null, 125000]) {
    test(`active ${phase} history uses item completion time ${completedAtMs}`, async t => {
      const f = fixture({ id: 'thread', turns: [{ ...turn, status: 'inProgress', error: null, startedAt: 123,
        items: [{ type: 'agentMessage', id: 'message', phase, text: 'hello', startedAtMs: 124000, completedAtMs }] }] });
      t.after(() => f.adapter.close());
      const history = await f.adapter.readHistory('thread');
      assert.equal(history[0]?.kind, completedAtMs === null ? 'agent_delta' : 'agent_message');
      assert.equal(history[0]?.createdAt, 124000);
    });
  }
}
