import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { FeishuAdapter, type FeishuDependencies } from '../src/adapters/feishu.js';
import { Store } from '../src/store.js';
import { configSchema } from '../src/config.js';
import { taskSchema, type IncomingMessage } from '../src/domain.js';
import { ProjectLedger } from '../src/project.js';
import { testExecution } from './test-config.js';

const options = { appId: 'app', appSecret: 'secret', userOpenId: 'owner' };

function historicalToken(): string {
  const key = createHash('sha256').update('agent-loop:approval:v1:app:').update('secret').digest();
  const nonce = Buffer.alloc(12, 1);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ kind: 'project_decision', id: 'card-request', projectId: 'project',
    coordinatorTaskId: 'coordinator', requestId: 'decision-1', key: 'strategy', chatId: 'chat', senderId: 'owner',
    expiresAt: Date.now() + 60_000, epoch: 'expiry', options: ['A', 'B'] }), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}

test('historical preset, custom and mixed callbacks are read-only before native handling or CardKit writes', async t => {
  const effects: string[] = [];
  const unexpected = async (): Promise<never> => { effects.push('api'); throw new Error('Unexpected API request'); };
  const api: NonNullable<FeishuDependencies['api']> = {
    chat: { list: unexpected, get: unexpected, create: unexpected },
    message: { list: unexpected, create: unexpected }, messageResource: { get: unexpected },
  };
  let dispatcher: EventDispatcher | undefined;
  const adapter = new FeishuAdapter(options, { api, cardkitNative: true,
    cardkit: { card: { create: unexpected, settings: unexpected, idConvert: unexpected }, cardElement: { content: unexpected } },
    socket: { start: async input => { dispatcher = input.eventDispatcher; }, close() {} },
  });
  t.after(() => adapter.close());
  await adapter.start(async () => { effects.push('message'); }, () => { effects.push('error'); }, async () => { effects.push('approval'); });
  assert.ok(dispatcher);
  const token = historicalToken();
  const callbacks = [
    { value: { agent_loop_card: token, agent_loop_choice: 'A' } },
    { form_value: { agent_loop_card: token, agent_loop_custom_text: 'Use C.' } },
    { value: { agent_loop_card: token, agent_loop_approval: 'native-token' } },
    { value: { agent_loop_approval: 'native-token' }, form_value: { agent_loop_card: token } },
    { value: { agent_loop_card: null } },
  ];
  for (const action of callbacks) {
    const response = z.object({ toast: z.object({ type: z.string(), content: z.string() }), card: z.unknown().optional() })
      .parse(await dispatcher.invoke({ schema: '2.0', header: { event_type: 'card.action.trigger' }, event: {
        operator: { open_id: 'owner' }, context: { open_chat_id: 'chat', open_message_id: 'old-message' }, action: { tag: 'button', ...action },
      } }, { needCheck: false }));
    assert.equal(response.toast.type, 'warning');
    assert.match(response.toast.content, /已停用.*历史/);
    assert.equal(response.card, undefined);
  }
  assert.deepEqual(effects, []);
});

test('project card, inbox provenance and ledger history survive restart without rewriting statuses or receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-cards-'));
  try {
    let store = new Store(root);
    const task = taskSchema.parse({ id: 'coordinator', sourceId: 'manual', source: { kind: 'manual', message: { id: 'initial', chatId: 'chat', senderId: 'owner',
      text: 'coordinate', attachments: [], createdAt: 1 } }, purpose: 'execution', contextDirectory: root, resources: [], status: 'paused', reason: 'Operator paused',
      prompt: 'coordinate', promptHash: 'hash', skillPath: null, chatId: 'chat', threadId: null, turnId: null, executionStatus: 'idle', lastHandledTurnId: null,
      requests: [], recovery: { attempts: 0, nextAttemptAt: null, lastError: null, interruptedTurnId: null, lastUserInputSeq: null }, createdAt: 1, updatedAt: 1 });
    store.saveTask(task);
    const config = configSchema.parse({ dataDir: root, execution: testExecution, feishu: { userOpenId: 'owner' }, projects: [{ id: 'project', name: 'Project', directory: root, repositories: [] }] });
    let ledger = new ProjectLedger(store);
    ledger.create(config.projects[0]!, task.id);
    ledger.record('project', { requestId: 'feishu-decision:project:decision', key: 'strategy', text: 'Ship in two stages.', authorTaskId: task.id,
      expectedVersion: ledger.project('project')!.version, scope: { kind: 'project' } });
    ledger.saveReceipt('project', task.id, 'old-request', 'old-fingerprint', { accepted: true });
    for (const status of ['pending', 'confirmed', 'uncertain'] as const) {
      store.saveFeishuCard({ id: `project:coordinator:${status}`, kind: 'project_decision', requestId: status, taskId: task.id, projectId: 'project',
        chatId: 'chat', ownerId: 'owner', cardId: `card-${status}`, messageId: `message-${status}`, sequence: 3, uuid: `uuid-${status}`, status, expiresAt: 100,
        fingerprint: 'request-fingerprint', receipt: status === 'confirmed' ? 'old-receipt' : null, updatedAt: 2 });
      const message: IncomingMessage = { id: `input-${status}`, chatId: 'chat', chatType: 'group', senderId: 'owner', text: 'Ship in two stages.', attachments: [], createdAt: 2 };
      store.receive(task.id, message, 'user', { kind: 'project_decision_card', projectId: 'project', cardId: `card-${status}`, messageId: `message-${status}`,
        requestId: status, ownerId: 'owner', value: message.text });
      store.markInput(message.id, status === 'confirmed' ? 'delivered' : status, 'Historical outcome');
    }
    const before = { task: store.task(task.id), cards: store.feishuCards(), inputs: store.inputs(task.id), project: ledger.project('project'), receipt: ledger.receipt('project', task.id, 'old-request') };
    store.close(); store = new Store(root); ledger = new ProjectLedger(store);
    assert.deepEqual({ task: store.task(task.id), cards: store.feishuCards(), inputs: store.inputs(task.id), project: ledger.project('project'), receipt: ledger.receipt('project', task.id, 'old-request') }, before);
    assert.equal(store.hasInputs(task.id, { statuses: ['pending', 'uncertain'] }), true);
    assert.equal(store.hasActiveInputs(task.id, { statuses: ['pending', 'uncertain'] }), false);
    assert.deepEqual(store.activeInputs(task.id), []);
    const ordinary: IncomingMessage = { id: 'ordinary', chatId: 'chat', chatType: 'group', senderId: 'owner', text: 'agent_loop_card is ordinary text', attachments: [], createdAt: 3 };
    store.receive(task.id, ordinary);
    const database = new DatabaseSync(join(root, 'tasks.sqlite'));
    database.prepare('UPDATE inbox SET payload=? WHERE id=?').run(JSON.stringify(ordinary), ordinary.id);
    database.close();
    assert.deepEqual(store.activeInputs(task.id).map(input => input.message), [ordinary]);
    assert.equal(store.hasActiveInputs(task.id, { statuses: ['pending'] }), true);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
