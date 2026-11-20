import { ExecutionFixture } from './execution-fixture.js';
import { testExecution } from './test-config.js';
import { SurfaceCodex, testProject, restoreSurface, tickSurface } from './coordinated-surfaces.js';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { configSchema } from '../src/config.js';
import { taskSchema, type Task } from '../src/domain.js';
import type { ExecutionEvent } from '../src/execution-events.js';
import { FeishuProgressPublisher, progressPublicationSchema } from '../src/feishu-progress.js';
import { FeishuAdapter } from '../src/adapters/feishu.js';
import { AgentLoop } from '../src/loop.js';
import { TaskGroupUnavailable, type FeishuProgressPort } from '../src/ports.js';
import { Store } from '../src/store.js';
import { CodexFake, FeishuFake, GitHubFake } from './fakes.js';

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
class Transport implements FeishuProgressPort {
  readonly cards = new Map<string, { content: string; streaming: boolean; sequence: number }>();
  readonly messages = new Map<string, { id: string; cardId: string; chatId: string }>();
  readonly lookups: { chatId: string; cardId: string; since: number }[] = [];
  readonly calls: { kind: string; cardId: string; sequence?: number; uuid?: string; enabled?: boolean; content?: string }[] = [];
  loseCreate = false;
  loseSend = false;
  rejectSend = false;
  rejectLookup = false;
  loseContent = false;
  loseSettings = false;
  rejectCreate = false;
  hold: { cardId: string; gate: ReturnType<typeof gate> } | null = null;
  beforeWrite: ((cardId: string, sequence: number) => void) | undefined;
  async createProgressCard(input: Parameters<FeishuProgressPort['createProgressCard']>[0]): Promise<string> {
    const cardId = `card-${this.cards.size + 1}`;
    this.calls.push({ kind: 'create', cardId, content: input.content });
    if (this.rejectCreate) throw new Error('permission denied');
    this.cards.set(cardId, { content: input.content, streaming: true, sequence: 0 });
    if (this.loseCreate) { this.loseCreate = false; throw new Error('create ACK lost'); }
    return cardId;
  }
  async sendProgressCard(input: Parameters<FeishuProgressPort['sendProgressCard']>[0]): Promise<string> {
    this.calls.push({ kind: 'send', ...input });
    if (this.rejectSend) throw new Error('send failed before delivery');
    if ([...this.messages.values()].some(message => message.cardId === input.cardId)) {
      throw new Error('230099 ext200780 card binding biz count over limit');
    }
    const message = { id: `message-${this.messages.size + 1}`, cardId: input.cardId, chatId: input.chatId };
    this.messages.set(input.uuid, message);
    if (this.loseSend) { this.loseSend = false; throw new Error('send ACK lost'); }
    return message.id;
  }
  async findProgressMessage(input: Parameters<FeishuProgressPort['findProgressMessage']>[0]): Promise<string | null> {
    this.lookups.push(input);
    if (this.rejectLookup) throw new Error('message scan incomplete');
    return [...this.messages.values()].find(message => message.chatId === input.chatId && message.cardId === input.cardId)?.id ?? null;
  }
  private async write(cardId: string, sequence: number) {
    this.beforeWrite?.(cardId, sequence);
    if (this.hold?.cardId === cardId) await this.hold.gate.promise;
    const card = this.cards.get(cardId);
    assert.ok(card);
    if (sequence <= card.sequence) throw new Error('300317 sequence rejected');
    card.sequence = sequence;
    return card;
  }
  async updateProgressContent(input: Parameters<FeishuProgressPort['updateProgressContent']>[0]): Promise<void> {
    this.calls.push({ kind: 'content', ...input });
    const card = await this.write(input.cardId, input.sequence);
    assert.equal(card.streaming, true);
    card.content = input.content;
    if (this.loseContent) { this.loseContent = false; throw new Error('content ACK lost'); }
  }
  async setProgressStreaming(input: Parameters<FeishuProgressPort['setProgressStreaming']>[0]): Promise<void> {
    this.calls.push({ kind: 'settings', ...input });
    const card = await this.write(input.cardId, input.sequence);
    card.streaming = input.enabled;
    if (this.loseSettings) { this.loseSettings = false; throw new Error('200770 UUID consumed'); }
  }
}
function task(id = 'task', turnId = 'turn'): Task {
  return taskSchema.parse({ id, sourceId: id, source: { kind: 'manual', message: { id, chatId: 'chat', senderId: 'owner', text: 'Discuss', attachments: [], createdAt: 1 } },
    contextDirectory: '/tmp', resources: [], status: 'running', reason: null, prompt: '', promptHash: '', skillPath: null,
    chatId: `chat-${id}`, threadId: `thread-${id}`, turnId, executionStatus: 'running', lastHandledTurnId: null, requests: [], createdAt: 1, updatedAt: 1 });
}
async function fixture(t: TestContext, initialize = true, adapter?: FeishuProgressPort) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'feishu-progress-')));
  let store = new Store(directory);
  const transport = new Transport();
  const source = new ExecutionFixture();
  let now = Date.UTC(2026, 10, 7);
  let publisher = new FeishuProgressPublisher({ store, execution: source.execution, transport: adapter ?? transport, now: () => now });
  t.after(async () => { await publisher.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  if (initialize) await publisher.poll();
  const event = (kind: ExecutionEvent['kind'], text: string, changes: Partial<ExecutionEvent> = {}, taskId = 'task') => {
    source.publish(taskId, { threadId: `thread-${taskId}`, turnId: 'turn', itemId: 'item', kind, label: kind, text, createdAt: now, ...changes });
  };
  return { source, directory, transport, event, get store() { return store; }, get publisher() { return publisher; }, get now() { return now; },
    advance(ms: number) { now += ms; },
    async pump(count = 1) { for (let i = 0; i < count; i++) { await publisher.poll(); now += 1000; } },
    async restart() { await publisher.close(); store.close(); store = new Store(directory); source.restart(); publisher = new FeishuProgressPublisher({ store, execution: source.execution, transport, now: () => now }); },
    publication(taskId = 'task', turnId = 'turn') { return progressPublicationSchema.parse(store.progressRecord(taskId, turnId)); },
  };
}

test('progress is opt-in and validates its interval and explicit dashboard URL', () => {
  assert.deepEqual(configSchema.parse({ execution: testExecution, feishu: { userOpenId: 'owner' } }).feishu.progress, { enabled: false, surface: 'card', intervalMs: 1000, maxLines: 3000 });
  assert.throws(() => configSchema.parse({ execution: testExecution, feishu: { userOpenId: 'owner', progress: { intervalMs: 1 } } }));
  assert.throws(() => configSchema.parse({ execution: testExecution, feishu: { userOpenId: 'owner', progress: { dashboardUrl: 'file:///etc/passwd' } } }));
});

test('actual publisher redacts cached execution text in CardKit creation and streaming updates', async t => {
  const secret = 'synthetic-publisher-app-secret?value~end';
  configSchema.parse({ execution: testExecution, feishu: { userOpenId: 'owner', appSecret: secret } });
  const requests: unknown[] = [];
  const unused = async (): Promise<never> => { throw new Error('Unexpected Feishu request'); };
  const adapter = new FeishuAdapter({ appId: 'synthetic-publisher-app', appSecret: secret, userOpenId: 'owner' }, {
    api: { chat: { list: unused, get: unused, create: unused }, messageResource: { get: unused },
      message: { list: unused, create: async input => { requests.push(input); return { code: 0, data: { message_id: 'message' } }; } } },
    cardkit: { card: {
      create: async input => { requests.push(input); return { code: 0, data: { card_id: 'card' } }; },
      settings: async input => { requests.push(input); return { code: 0, data: {} }; }, idConvert: unused,
    }, cardElement: { content: async input => { requests.push(input); return { code: 0, data: {} }; } } },
  });
  t.after(() => adapter.close());
  const f = await fixture(t, true, adapter);
  f.store.saveTask(task());
  f.event('agent_message', `First credential=${secret}`);
  await f.pump(4);
  f.event('agent_message', `Changed credential=${encodeURIComponent(secret)}`);
  await f.pump(3);
  const serialized = JSON.stringify(requests);
  assert.doesNotMatch(serialized, /synthetic-publisher-app-secret/);
  assert.equal(serialized.includes(encodeURIComponent(secret)), false);
  assert.match(serialized, /First credential=\[REDACTED\]/);
  assert.match(serialized, /Changed credential=\[REDACTED\]/);
  assert.deepEqual(f.store.diagnostics(), []);
});

test('saved cards stop publishing after group removal and recreated groups get a fresh card and UUID', async t => {
  const f = await fixture(t); f.store.saveTask(task()); await f.pump(3);
  const original = f.publication(), calls = f.transport.calls.length;
  f.store.saveTask({ ...f.store.task('task'), chatId: null });
  await f.pump(3);
  assert.equal(f.publication().delivery.kind, 'disabled');
  assert.equal(f.transport.calls.length, calls);
  f.store.saveTask({ ...f.store.task('task'), chatId: 'replacement' });
  await f.pump(3);
  assert.equal(f.publication().chatId, 'replacement');
  assert.notEqual(f.publication().uuid, original.uuid);
  assert.equal(f.transport.cards.size, 2);
  assert.ok([...f.transport.messages.values()].some(message => message.chatId === 'replacement'));
});

test('one card coalesces deltas, replaces completed assistant items, and closes at completion', async t => {
  const f = await fixture(t); f.store.saveTask(task());
  f.event('turn_start', 'running');
  for (const text of ['hel', 'lo', ' there']) f.event('agent_delta', text);
  f.event('agent_message', 'hello there');
  await f.pump(3);
  assert.equal(f.transport.messages.size, 1);
  assert.equal(f.transport.cards.size, 1);
  assert.equal(f.transport.calls.filter(call => call.kind === 'content').length, 1);
  assert.equal(f.transport.cards.get('card-1')?.content.match(/hello there/g)?.length, 1);
  const content = f.transport.cards.get('card-1')?.content;
  f.advance(60_000); await f.pump();
  assert.equal(f.transport.cards.get('card-1')?.content, content, 'polling must not claim new execution activity');
  f.event('turn_end', 'completed'); await f.pump(2);
  assert.match(f.transport.cards.get('card-1')?.content ?? '', /已完成/);
  assert.equal(f.transport.cards.get('card-1')?.streaming, false);
});

test('initial enable skips completed history and resumes the current active turn', async t => {
  const f = await fixture(t, false);
  for (let i = 0; i < 20; i++) {
    const old = task(`old-${i}`); old.executionStatus = 'completed'; old.status = 'idle'; f.store.saveTask(old);
    f.event('turn_end', 'completed', {}, old.id);
  }
  f.store.saveTask(task()); f.event('agent_delta', 'current active output');
  await f.pump(4);
  assert.equal(f.transport.messages.size, 1);
  assert.match(f.transport.cards.get('card-1')?.content ?? '', /current active output/);
  await f.restart(); await f.pump(2);
  assert.equal(f.transport.messages.size, 1);
});

test('discovery retains fast turns between polls and old terminal state after task advances', async t => {
  const f = await fixture(t); f.store.saveTask(task('task', 'next'));
  f.event('turn_start', 'running'); f.event('agent_delta', 'short turn'); f.event('turn_end', 'failed\nreason');
  f.event('turn_start', 'running', { turnId: 'next' });
  await f.pump(6);
  assert.equal(f.transport.messages.size, 2);
  const old = f.publication(); assert.equal(old.delivery.kind, 'closed'); assert.match(f.transport.cards.get('card-1')?.content ?? '', /失败/);
  assert.match(f.transport.cards.get('card-2')?.content ?? '', /执行中/);
  await f.restart(); await f.pump(2); assert.equal(f.transport.messages.size, 2);
});

test('native waiting status wins over interrupted or idle snapshots and tool errors are not terminal', async t => {
  const f = await fixture(t); const current = task(); f.store.saveTask(current);
  f.event('tool_end', 'exit 1'); f.event('error', 'temporary tool failure'); await f.pump(3);
  assert.match(f.transport.cards.get('card-1')?.content ?? '', /执行中/);
  assert.match(f.transport.cards.get('card-1')?.content ?? '', /temporary tool failure/);
  f.event('agent_delta', 'execution resumed'); await f.pump();
  assert.doesNotMatch(f.transport.cards.get('card-1')?.content ?? '', /temporary tool failure/);
  const request = { id: 'question', threadId: current.threadId!, turnId: 'turn', kind: 'question' as const, prompt: 'Question', method: 'input', payload: {}, isBlocking: true, connectionEpoch: 'epoch' };
  current.executionStatus = 'interrupted'; current.requests = [request]; f.store.saveTask(current);
  await f.pump(); assert.match(f.transport.cards.get('card-1')?.content ?? '', /等待输入/);
  current.executionStatus = 'idle'; current.requests = [{ ...request, kind: 'approval' }]; f.store.saveTask(current);
  await f.pump(); assert.match(f.transport.cards.get('card-1')?.content ?? '', /等待审批/);
  current.status = 'paused'; current.requests = []; f.store.saveTask(current);
  await f.pump(2); assert.match(f.transport.cards.get('card-1')?.content ?? '', /已暂停/);
  assert.equal(f.transport.cards.get('card-1')?.streaming, false);
});

test('restart retains card and sequence; stale streaming is renewed and then closed', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.event('agent_delta', 'first'); await f.pump(3);
  const before = f.publication().sequence;
  await f.restart(); f.advance(9 * 60_000);
  f.event('agent_delta', ' second'); await f.pump(2);
  assert.equal(f.publication().sequence, before, 'unknown suffix position waits for canonical completion');
  f.event('agent_message', 'first second'); await f.pump(4);
  assert.equal(f.transport.cards.size, 1); assert.equal(f.transport.messages.size, 1);
  assert.ok(f.publication().sequence > before);
  assert.ok(f.transport.calls.some(call => call.kind === 'settings' && call.enabled));
  f.event('turn_end', 'completed'); await f.pump(2);
  assert.equal(f.transport.cards.get('card-1')?.streaming, false);
  const writes = f.transport.calls.flatMap(call => call.sequence === undefined ? [] : [call.sequence]);
  assert.deepEqual(writes, [...new Set(writes)].sort((a, b) => a - b));
});

test('lost send ACK reconciles the original message on restart without replaying the bound card', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.transport.loseSend = true;
  await f.pump(2);
  const sending = f.publication().delivery; assert.equal(sending.kind, 'sending');
  assert.equal(f.transport.lookups.length, 0, 'first send needs no lookup');
  await f.restart(); f.event('agent_delta', 'recovered output'); await f.pump(2);
  const published = f.publication().delivery; assert.equal(published.kind, 'published');
  if (published.kind !== 'published' || sending.kind !== 'sending') throw new Error('Unexpected publication state');
  assert.equal(published.cardId, sending.cardId); assert.equal(published.messageId, 'message-1');
  assert.deepEqual(f.transport.lookups, [{ chatId: 'chat-task', cardId: sending.cardId, since: sending.firstAttemptAt }]);
  assert.equal(f.transport.messages.size, 1); assert.equal(f.transport.cards.size, 1);
  assert.equal(f.transport.calls.filter(call => call.kind === 'send').length, 1);
  assert.match(f.transport.cards.get(sending.cardId)?.content ?? '', /recovered output/);
  await assert.rejects(f.transport.sendProgressCard({ chatId: 'chat-task', cardId: sending.cardId, uuid: f.publication().uuid }), /230099 ext200780/);
});

test('reconciliation after one hour recovers the original message and resumes updates', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.transport.loseSend = true; await f.pump(2);
  f.advance(61 * 60_000); await f.restart(); await f.pump(3);
  assert.equal(f.publication().delivery.kind, 'published');
  assert.equal(f.transport.messages.size, 1); assert.equal(f.transport.cards.size, 1);
  assert.equal(f.transport.calls.filter(call => call.kind === 'send').length, 1);
  assert.ok(f.transport.calls.some(call => call.kind === 'settings' && call.enabled));
  assert.ok(f.transport.calls.some(call => call.kind === 'content'));
});

test('a complete absent lookup retries only the original UUID inside the safe window', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.transport.rejectSend = true; await f.pump(2);
  const original = f.publication();
  await f.restart(); await f.pump();
  assert.deepEqual(f.publication().delivery, original.delivery, 'retry must retain the original firstAttemptAt');
  f.transport.rejectSend = false; f.advance(3000); await f.pump();
  assert.equal(f.publication().delivery.kind, 'published');
  assert.equal(f.transport.messages.size, 1); assert.equal(f.transport.cards.size, 1);
  assert.deepEqual(new Set(f.transport.calls.filter(call => call.kind === 'send').map(call => call.uuid)), new Set([original.uuid]));
  assert.equal(f.transport.lookups.length, 2);
});

test('a stale absent lookup followed by 230099 does not acknowledge the send', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.transport.loseSend = true; await f.pump(2);
  const original = f.publication().delivery;
  const lookup = f.transport.findProgressMessage.bind(f.transport);
  f.transport.findProgressMessage = async () => null;
  await f.restart(); await f.pump();
  assert.deepEqual(f.publication().delivery, original);
  assert.ok(f.store.diagnostics().some(row => row.scope === 'task' && row.message.includes('card.')));
  assert.equal(f.transport.messages.size, 1);
  f.transport.findProgressMessage = lookup; f.advance(3000); await f.pump();
  assert.equal(f.publication().delivery.kind, 'published');
  assert.equal(f.transport.calls.filter(call => call.kind === 'send').length, 2);
});

test('absent message outside the safe window disables without another send', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.transport.rejectSend = true; await f.pump(2);
  f.transport.rejectSend = false; f.advance(61 * 60_000); await f.restart(); await f.pump(3);
  assert.equal(f.publication().delivery.kind, 'disabled');
  assert.equal(f.transport.lookups.length, 1);
  assert.equal(f.transport.calls.filter(call => call.kind === 'send').length, 1);
  assert.equal(f.transport.messages.size, 0); assert.equal(f.transport.cards.size, 1);
});

test('ambiguous lookup remains sending across expiry and isolates other tasks', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.transport.loseSend = true; await f.pump(2);
  const original = f.publication().delivery;
  f.transport.rejectLookup = true; await f.restart(); await f.pump();
  assert.deepEqual(f.publication().delivery, original);
  f.store.saveTask(task('other')); f.advance(61 * 60_000); await f.pump(3);
  assert.deepEqual(f.publication().delivery, original);
  assert.equal(f.publication('other').delivery.kind, 'published');
  assert.equal(f.transport.calls.filter(call => call.kind === 'send').length, 2);
  f.transport.rejectLookup = false; f.advance(30_000); await f.pump(3);
  assert.equal(f.publication().delivery.kind, 'published');
  assert.equal(f.transport.calls.filter(call => call.kind === 'send').length, 2);
});

test('unacknowledged creation is an unsent orphan and retry only publishes the saved entity', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.transport.loseCreate = true;
  await f.pump(); await f.restart(); await f.pump(3);
  assert.equal(f.transport.cards.size, 2); assert.equal(f.transport.messages.size, 1);
  assert.equal([...f.transport.messages.values()][0]?.cardId, 'card-2');
});

test('unknown content/settings outcomes converge with new durable sequences and current full content', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.event('agent_delta', 'first');
  await f.pump(2);
  f.transport.beforeWrite = (_cardId, sequence) => {
    const record = f.publication(); assert.equal(record.sequence, sequence);
    assert.equal(record.delivery.kind, 'published');
    if (record.delivery.kind === 'published') assert.equal(record.delivery.pending?.sequence, sequence);
  };
  f.transport.loseContent = true; await f.pump(); await f.restart();
  f.event('agent_message', 'newest complete message'); f.transport.loseSettings = true;
  await f.pump(5);
  assert.match(f.transport.cards.get('card-1')?.content ?? '', /newest complete message/);
  assert.equal(f.transport.messages.size, 1);
  f.event('turn_end', 'completed'); f.transport.loseSettings = true; await f.pump(6);
  assert.equal(f.transport.cards.get('card-1')?.streaming, false);
  assert.equal(f.publication().delivery.kind, 'closed');
});

test('slow card does not block another card, and output arriving in-flight survives delivery commits', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.store.saveTask(task('other')); await f.pump(3);
  const blocked = gate(); f.transport.hold = { cardId: 'card-1', gate: blocked };
  f.event('agent_delta', 'old'); const slow = f.publisher.poll();
  await Promise.resolve();
  f.event('agent_delta', ' newest'); f.event('agent_delta', 'other moves', {}, 'other');
  await f.pump();
  assert.match(f.transport.cards.get('card-2')?.content ?? '', /other moves/);
  assert.equal(f.transport.calls.filter(call => call.cardId === 'card-1' && call.kind === 'content').length, 2);
  blocked.resolve(); await slow; f.transport.hold = null; await f.pump();
  assert.match(f.transport.cards.get('card-1')?.content ?? '', /old newest/);
});

test('bounded discovery and UTF-8/JSON projections preserve latest inert tool output', async t => {
  const f = await fixture(t); f.store.saveTask(task());
  for (let i = 0; i < 650; i++) f.event('agent_delta', `${i} `);
  f.event('tool_output', '<at id=all>unsafe</at>\n' + '中文🙂\\"\n'.repeat(8000) + 'LATEST_OUTPUT');
  await f.pump(5);
  const card = f.transport.cards.get('card-1'); assert.ok(card);
  assert.doesNotMatch(card.content, /LATEST_OUTPUT/); assert.match(card.content, /已截断/);
  assert.match(card.content, /649/);
  assert.ok(Buffer.byteLength(JSON.stringify(card.content)) < 24_000);
  assert.ok(Buffer.byteLength(JSON.stringify(f.publication())) < 20_000);
});

test('fair scheduler bounds publisher operation rate and concurrent card operations', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 17; i++) f.store.saveTask(task(`task-${i}`));
  for (let i = 0; i < 20; i++) await f.publisher.poll();
  assert.equal(f.transport.calls.length, 12, 'twelve publisher operations maximum in any rolling second');
  await f.pump(20); assert.equal(f.transport.messages.size, 17);
  assert.equal(f.transport.cards.size, 17);
});

test('late final text updates the same closed card and never republishes its message', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.event('turn_end', 'completed'); await f.pump(4);
  assert.equal(f.publication().delivery.kind, 'closed');
  f.event('agent_message', 'late final text'); await f.pump(3);
  assert.equal(f.transport.messages.size, 1); assert.match(f.transport.cards.get('card-1')?.content ?? '', /late final text/);
  assert.equal(f.transport.cards.get('card-1')?.streaming, false);
});

test('whole runtime delivers final answer unchanged while progress API fails', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'feishu-runtime-')));
  const progress = new Transport(); progress.rejectCreate = true;
  const feishu = Object.assign(new FeishuFake(), { progress }); const codex = new SurfaceCodex();
  const loop = new AgentLoop(configSchema.parse({ execution: testExecution, dataDir: directory, projects: [testProject(directory)], feishu: { userOpenId: 'owner', progress: { enabled: true } } }), {
    feishu, codex, github: new GitHubFake(), workspace: { ensure: async () => directory, head: async () => 'head' },
  });
  t.after(async () => { await loop.close(); await rm(directory, { recursive: true, force: true }); });
  await loop.start();
  await restoreSurface(loop, { id: 'new', chatId: 'private', senderId: 'owner', chatType: 'p2p', text: 'test', attachments: [], createdAt: Date.now() });
  const current = loop.tasks().find(task => !task.sourceId.startsWith('project:')); assert.ok(current?.threadId);
  await setTimeout(1100);
  assert.ok(progress.calls.length > 0);
  codex.complete(current.threadId, 'The original final answer.'); await tickSurface(loop);
  assert.equal(feishu.sent.filter(message => message.text === 'The original final answer.').length, 1);
  assert.equal(loop.tasks().find(task => !task.sourceId.startsWith('project:'))?.status, 'idle');
  assert.ok(loop.store.diagnostics().some(row => row.scope === current.id && row.message.includes('card.')));
});

test('enabling progress after completed runtime history ignores recovery observations and publishes only new turns', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'feishu-enable-')));
  const progress = new Transport();
  const feishu = Object.assign(new FeishuFake(), { progress }); const codex = new SurfaceCodex();
  const readHistory = codex.readHistory.bind(codex);
  t.mock.method(codex, 'readHistory', async (threadId: string) => {
    const entries = await readHistory(threadId), snapshot = codex.snapshot(threadId);
    if (snapshot.turnId) entries.push({ threadId, turnId: snapshot.turnId, itemId: null, kind: snapshot.status === 'running' ? 'turn_start' : 'turn_end',
      label: 'turn', text: snapshot.status, createdAt: null, key: JSON.stringify([threadId, snapshot.turnId, null, 'turn']) });
    return entries;
  });
  const config = configSchema.parse({ execution: testExecution, dataDir: directory, projects: [testProject(directory)], feishu: { userOpenId: 'owner' } });
  const ports = { feishu, codex, github: new GitHubFake(), workspace: { ensure: async () => directory, head: async () => 'head' } };
  let loop = new AgentLoop(config, ports);
  t.after(async () => { await loop.close(); await rm(directory, { recursive: true, force: true }); });
  await restoreSurface(loop, { id: 'old', chatId: 'private', senderId: 'owner', chatType: 'p2p', text: 'old discussion', attachments: [], createdAt: Date.now() });
  const current = loop.tasks().find(task => !task.sourceId.startsWith('project:')); assert.ok(current?.threadId); assert.ok(current.chatId);
  codex.complete(current.threadId, 'Historical final answer'); await tickSurface(loop); await loop.close();
  config.feishu.progress.enabled = true;
  loop = new AgentLoop(config, ports); await loop.start(); await setTimeout(1100);
  assert.equal(progress.calls.length, 0, 'recovery status observations cannot create a historical card');
  await loop.close(); loop = new AgentLoop(config, ports); await loop.start(); await setTimeout(1100);
  assert.equal(progress.calls.length, 0, 'history exclusion survives another restart');
  await restoreSurface(loop, { id: 'new-turn', chatId: current.chatId, senderId: 'owner', chatType: 'group', text: 'Continue now', attachments: [], createdAt: Date.now() });
  await setTimeout(2200);
  const workerMessages = [...progress.messages.values()].filter(message => message.chatId === current.chatId);
  assert.equal(workerMessages.length, 1);
  assert.ok(workerMessages.every(message => progress.cards.has(message.cardId)));
  assert.equal(feishu.sent.filter(message => message.text === 'Historical final answer').length, 1);
});

test('acknowledged cards keep only receipts and source outages never replace the full card after restart', async t => {
  const f = await fixture(t); f.store.saveTask(task());
  const sentinel = 'UNIQUE_CARD_TRANSCRIPT_879423';
  f.event('agent_message', sentinel); await f.pump(4);
  assert.doesNotMatch(JSON.stringify(f.publication()), /UNIQUE_CARD_TRANSCRIPT|assistant|content"|view"/);
  const full = f.transport.cards.get('card-1')!.content;
  await f.restart(); f.source.unavailable = true;
  f.event('agent_delta', 'only a suffix', { itemId: 'new-live' }); await f.pump(2);
  assert.equal(f.transport.cards.get('card-1')!.content, full);
  f.source.unavailable = false; await f.pump(3);
  assert.match(f.transport.cards.get('card-1')!.content, /UNIQUE_CARD_TRANSCRIPT_879423/);
  assert.match(f.transport.cards.get('card-1')!.content, /only a suffix/);
  f.store.saveTask({ ...f.store.task('task'), chatId: 'replacement-chat' }); await f.pump(4);
  assert.doesNotMatch(f.store.meta('retired-progress:task:chat-task:turn') ?? '', /UNIQUE_CARD_TRANSCRIPT/);
  const db = new DatabaseSync(join(f.directory, 'tasks.sqlite'));
  try {
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      const table = String(row.name); assert.match(table, /^[a-z_]+$/);
      assert.doesNotMatch(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()), new RegExp(sentinel));
    }
  } finally { db.close(); }
});

test('shutdown drains an outstanding history read without creating or writing a card afterwards', async t => {
  const f = await fixture(t); f.store.saveTask(task());
  const held = gate(), entered = gate(), read = f.source.execution.read.bind(f.source.execution);
  t.mock.method(f.source.execution, 'read', async (...args: Parameters<typeof read>) => { entered.resolve(); await held.promise; return read(...args); });
  const polling = f.publisher.poll(); await entered.promise;
  let closed = false; const closing = f.publisher.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  held.resolve(); await Promise.all([closing, polling]);
  assert.equal(f.transport.calls.length, 0); assert.equal(f.store.progressRecord('task', 'turn'), null);
});


test('first enable records the excluded head so completed turns during downtime are discovered', async t => {
  const f = await fixture(t, false);
  f.store.saveTask({ ...task(), status: 'idle', executionStatus: 'completed' });
  f.event('turn_end', 'completed'); await f.pump(); await f.publisher.close();
  for (const turnId of ['missed', 'latest']) {
    f.event('agent_message', turnId, { turnId }); f.event('turn_end', 'completed', { turnId });
  }
  f.store.saveTask({ ...task('task', 'latest'), status: 'idle', executionStatus: 'completed' });
  await f.restart(); await f.pump(8);
  assert.equal(f.store.progressRecord('task', 'turn'), null);
  assert.equal(f.publication('task', 'missed').delivery.kind, 'closed');
  assert.equal(f.publication('task', 'latest').delivery.kind, 'closed');
});

test('disabled and retired card receipts never retain an upstream body echo in raw SQLite', async t => {
  const f = await fixture(t); f.store.saveTask(task());
  const sentinel = 'PRIVATE_CARD_TRACE_98761'; f.event('agent_message', sentinel);
  f.transport.createProgressCard = async () => { throw new TaskGroupUnavailable(230002, sentinel); };
  await f.pump(); assert.equal(f.publication().delivery.kind, 'disabled');
  f.store.saveTask({ ...task(), chatId: 'replacement' }); await f.pump();
  const db = new DatabaseSync(join(f.directory, 'tasks.sqlite'));
  try {
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      const table = String(row.name); assert.match(table, /^[a-z_]+$/);
      assert.doesNotMatch(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()), new RegExp(sentinel));
    }
  } finally { db.close(); }
});


test('same-thread status changes during history read cannot publish a stale card', async t => {
  const f = await fixture(t); f.store.saveTask(task());
  const held = gate(), entered = gate(), read = f.source.execution.read.bind(f.source.execution);
  const mocked = t.mock.method(f.source.execution, 'read', async (...args: Parameters<typeof read>) => { entered.resolve(); await held.promise; return read(...args); });
  const polling = f.publisher.poll(); await entered.promise;
  f.store.saveTask({ ...task(), status: 'paused' }); held.resolve(); await polling;
  assert.equal(f.transport.cards.size, 0); mocked.mock.restore(); await f.pump(4);
  assert.match(f.transport.cards.get('card-1')?.content ?? '', /已暂停/);
});

test('settled cards release projections without polling idle history and reject lagging partial history', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.event('agent_message', 'Full acknowledged card'); await f.pump(4);
  const full = f.transport.cards.get('card-1')!.content, history = structuredClone(f.source.history.get('thread-task')!);
  const reads = f.source.reads.length; await f.pump(5); assert.equal(f.source.reads.length, reads);
  await f.restart(); f.source.history.set('thread-task', history.map(event => ({ ...event, kind: 'agent_delta', text: 'suffix' })));
  await f.pump(4); assert.equal(f.transport.cards.get('card-1')!.content, full);
  const beforeRecovery = f.source.reads.length; f.source.history.set('thread-task', history); f.advance(60_000); await f.pump(3);
  assert.ok(f.source.reads.length > beforeRecovery); assert.equal(f.transport.cards.get('card-1')!.content, full);
});

test('more delayed turns than resident card capacity all rehydrate and publish', async t => {
  const f = await fixture(t); f.store.saveTask(task('task', 'turn-149'));
  for (let n = 0; n < 150; n++) {
    f.event('agent_message', `Output for ${n}`, { turnId: `turn-${n}` });
    f.event('turn_end', 'completed', { turnId: `turn-${n}` });
  }
  const views: unknown = Reflect.get(f.publisher, 'views'); assert.ok(views instanceof Map); assert.ok(views.size <= 128);
  await f.pump(180);
  assert.equal(f.transport.messages.size, 150);
  assert.ok([...f.transport.cards.values()].every(card => !card.streaming));
  assert.equal(views.size, 0);
});

test('lagging restart history cannot acknowledge an unseen head or skip intervening turns', async t => {
  const f = await fixture(t, false);
  f.store.saveTask({ ...task('task', 'before'), executionStatus: 'completed' });
  f.event('turn_end', 'completed', { turnId: 'before', itemId: null });
  await f.pump(); await f.restart();
  f.store.saveTask({ ...task('task', 'latest'), executionStatus: 'completed' });
  await f.pump(8);
  assert.equal(f.transport.cards.size, 0);
  const prior = f.source.history.get('thread-task')!;
  f.source.history.set('thread-task', [...prior,
    { ...prior[0]!, turnId: 'missed', key: JSON.stringify(['thread-task', 'missed', null, 'turn']) },
    { ...prior[0]!, turnId: 'latest', key: JSON.stringify(['thread-task', 'latest', null, 'turn']) },
  ]);
  await f.pump(60);
  assert.ok(f.store.progressRecord('task', 'missed'));
  assert.equal(f.transport.cards.size, 2);
});

test('transient retry errors do not prevent completed cards recovering after restart', async t => {
  const f = await fixture(t); f.store.saveTask(task());
  f.event('turn_start', 'inProgress', { itemId: null });
  f.source.execution.publish('task', { threadId: 'thread-task', turnId: 'turn', itemId: null, kind: 'error', text: 'temporary retry', label: 'retry', createdAt: f.now });
  await f.pump(4); assert.match(f.transport.cards.get('card-1')!.content, /temporary retry/);
  await f.restart();
  f.event('agent_message', 'Recovered completion'); f.event('turn_end', 'completed', { itemId: null });
  f.store.saveTask({ ...task(), executionStatus: 'completed' });
  await f.pump(12);
  assert.match(f.transport.cards.get('card-1')!.content, /Recovered completion/);
  assert.equal(f.transport.cards.get('card-1')!.streaming, false);
});

test('a live latest turn cannot advance discovery past missing canonical turns', async t => {
  const f = await fixture(t, false);
  f.store.saveTask({ ...task('task', 'before'), executionStatus: 'completed' });
  f.event('turn_end', 'completed', { turnId: 'before', itemId: null });
  await f.pump(); await f.restart();
  f.store.saveTask({ ...task('task', 'latest'), executionStatus: 'completed' });
  f.source.execution.publish('task', { threadId: 'thread-task', turnId: 'latest', itemId: null, kind: 'turn_end', text: 'completed', label: 'ended', createdAt: f.now });
  await f.pump(8);
  const prior = f.source.history.get('thread-task')!;
  f.source.history.set('thread-task', [...prior,
    { ...prior[0]!, turnId: 'missed', key: JSON.stringify(['thread-task', 'missed', null, 'turn']) },
    { ...prior[0]!, turnId: 'latest', key: JSON.stringify(['thread-task', 'latest', null, 'turn']) },
  ]);
  await f.pump(60);
  assert.ok(f.store.progressRecord('task', 'missed'));
  assert.equal(f.transport.cards.size, 2);
});
