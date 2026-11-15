import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FeishuAdapter, type FeishuDependencies } from '../src/adapters/feishu.js';
import { Store } from '../src/store.js';
import { configSchema } from '../src/config.js';
import { taskSchema } from '../src/domain.js';
import { ProjectRuntime } from '../src/project-runtime.js';
import { testExecution } from './test-config.js';

const options = { appId: 'app', appSecret: 'secret', userOpenId: 'owner' };
function api(capture: { message?: string }): NonNullable<FeishuDependencies['api']> {
  return {
    chat: { list: async () => ({ code: 0, data: { items: [], has_more: false } }), get: async () => ({ code: 0, data: {} }), create: async () => ({ code: 0, data: {} }) },
    message: {
      list: async () => ({ code: 0, data: { items: [], has_more: false } }),
      create: async input => { capture.message = input?.data.content; return { code: 0, data: { message_id: 'message-1' } }; },
    },
    messageResource: { get: async () => { throw new Error('not used'); } },
  } as NonNullable<FeishuDependencies['api']>;
}

test('project decision cards render Card JSON 2.0 and preserve a bounded delivery identity', async () => {
  const capture: { message?: string; card?: string } = {};
  const cardkit = {
    card: {
      create: async input => { capture.card = input?.data.data; return { code: 0, data: { card_id: 'card-1' } }; },
      settings: async () => ({ code: 0, data: {} }), idConvert: async () => ({ code: 0, data: { card_id: 'card-1' } }),
    },
    cardElement: { content: async () => ({ code: 0, data: {} }) },
  } as FeishuDependencies['cardkit'];
  const adapter = new FeishuAdapter(options, { api: api(capture), cardkit, cardkitNative: true });
  const delivery = await adapter.sendDecisionCard!({ id: 'card-request', projectId: 'project', coordinatorTaskId: 'coordinator', requestId: 'decision-1',
    key: 'strategy', prompt: 'Choose a rollout strategy.', options: ['A', 'B'], context: 'Safe summary only.', chatId: 'chat', ownerId: 'owner', expiresAt: Date.now() + 60_000 });
  assert.deepEqual(delivery, { kind: 'project_decision', requestId: 'decision-1', cardId: 'card-1', messageId: 'message-1', sequence: 0, uuid: delivery.uuid });
  const rendered = JSON.parse(capture.card ?? '{}');
  assert.equal(rendered.schema, '2.0');
  assert.match(capture.message ?? '', /card-1/);
  assert.doesNotMatch(capture.card ?? '', /secret|stdout|stderr|reasoning|provider/);
  await adapter.close();
});

test('decision callback accepts one preset or custom text, rejects non-owner and malformed choices', async () => {
  const capture: { message?: string } = {};
  let dispatcher: any;
  const adapter = new FeishuAdapter(options, { api: api(capture), socket: {
    start: async ({ eventDispatcher }) => { dispatcher = eventDispatcher; }, close() {},
  } });
  const delivery = await adapter.sendDecisionCard!({ id: 'card-request', projectId: 'project', coordinatorTaskId: 'coordinator', requestId: 'decision-1',
    key: 'strategy', prompt: 'Choose.', options: ['A', 'B'], chatId: 'chat', ownerId: 'owner', expiresAt: Date.now() + 60_000 });
  const card = JSON.parse(capture.message ?? '{}');
  const action = card.body.elements.find((element: any) => element.tag === 'action').actions[0];
  const submit = card.body.elements.find((element: any) => element.tag === 'form').elements.find((element: any) => element.tag === 'button');
  const received: any[] = [];
  await adapter.start(async () => {}, () => {}, undefined, undefined, async value => { received.push(value); });
  const invoke = (operator: string, value: Record<string, unknown>, form_value?: Record<string, unknown>) => dispatcher.invoke({ schema: '2.0', header: { event_type: 'card.action.trigger' },
    event: { operator: { open_id: operator }, context: { open_chat_id: 'chat', open_message_id: delivery.messageId }, action: { tag: 'button', value, form_value } } }, { needCheck: false });
  assert.equal((await invoke('owner', action.value)).toast.type, 'info');
  assert.equal(received[0].choice, 'A');
  assert.equal((await invoke('owner', submit.value, { agent_loop_custom_text: 'Use C.' })).toast.type, 'info');
  assert.equal(received[1].customText, 'Use C.');
  assert.equal((await invoke('other', action.value)).toast.type, 'warning');
  await assert.doesNotReject(invoke('owner', { ...action.value, agent_loop_choice: 'forged' }));
  assert.equal(received.length, 2);
  await adapter.close();
});

test('Feishu card identity and terminal uncertain state survive Store restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-cards-'));
  try {
    let store = new Store(root);
    store.saveFeishuCard({ id: 'project:coordinator:decision', kind: 'project_decision', requestId: 'decision', taskId: 'coordinator', projectId: 'project',
      chatId: 'chat', ownerId: 'owner', cardId: 'card-1', messageId: 'message-1', sequence: 3, uuid: 'uuid-1', status: 'uncertain', expiresAt: Date.now() + 60_000,
      fingerprint: 'request-fingerprint', receipt: null, updatedAt: Date.now() });
    store.close(); store = new Store(root);
    const card = store.feishuCardForRequest('decision');
    assert.equal(card?.cardId, 'card-1');
    assert.equal(card?.sequence, 3);
    assert.equal(card?.status, 'uncertain');
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('project decision submission is a one-shot project record and coordinator input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-decision-runtime-'));
  try {
    const store = new Store(root);
    const task = taskSchema.parse({ id: 'coordinator', sourceId: 'manual', source: { kind: 'manual', message: { id: 'initial', chatId: 'chat', senderId: 'owner',
      text: 'coordinate', attachments: [], createdAt: 1 } }, purpose: 'execution', contextDirectory: root, resources: [], status: 'idle', reason: null,
      prompt: 'coordinate', promptHash: 'hash', skillPath: null, chatId: 'chat', threadId: null, turnId: null, executionStatus: 'idle', lastHandledTurnId: null,
      requests: [], recovery: { attempts: 0, nextAttemptAt: null, lastError: null, interruptedTurnId: null, lastUserInputSeq: null }, createdAt: 1, updatedAt: 1 });
    store.saveTask(task);
    const config = configSchema.parse({ dataDir: root, execution: testExecution, feishu: { userOpenId: 'owner' }, projects: [{ id: 'project', name: 'Project', directory: root, repositories: [] }] });
    const runtime = new ProjectRuntime(config, store, { closeout: { assertOpen() {}, completed() { return false; } } as any, makeTask: async () => { throw new Error('not used'); },
      releaseWorkspace: async () => undefined, control: async () => undefined, openGroup: async () => 'chat', announce: async () => undefined,
      groupCleanup: async () => undefined });
    runtime.ledger.create(config.projects[0]!, task.id);
    const action = { kind: 'project_decision' as const, id: 'card:decision', projectId: 'project', coordinatorTaskId: task.id, requestId: 'decision-1', key: 'strategy',
      customText: 'Ship in two stages.', chatId: 'chat', senderId: 'owner', cardId: 'card-1', messageId: 'message-1', sequence: 0, epoch: 'expiry', expiresAt: Date.now() + 60_000 };
    const first = await runtime.acceptProjectDecision(action);
    const duplicate = await runtime.acceptProjectDecision(action);
    assert.deepEqual(duplicate, first);
    await assert.rejects(runtime.acceptProjectDecision({ ...action, customText: 'Ship all at once.', id: 'card:decision:other' }), /conflicts/);
    const state = runtime.ledger.project('project');
    assert.equal(state?.records[0]?.text, 'Ship in two stages.');
    assert.equal(store.inputs(task.id).find(input => input.provenance.kind === 'project_decision_card')?.message.text.includes('Ship in two stages.'), true);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
