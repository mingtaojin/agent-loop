import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { configSchema } from '../src/config.js';
import { incomingSchema, submissionRequestIdSchema, taskSchema, type Task } from '../src/domain.js';
import type { ExecutionEvent } from '../src/execution-events.js';
import { FeishuDocumentProgressPublisher, documentPublicationSchema } from '../src/feishu-document-progress.js';
import { documentChunks } from '../src/feishu-document-text.js';
import { DocumentRequestRejected, TaskGroupUnavailable, type FeishuDocumentProgressPort, type FeishuProgressPort } from '../src/ports.js';
import { Store } from '../src/store.js';
import { AgentLoop } from '../src/loop.js';
import { CodexFake, FeishuFake, GitHubFake } from './fakes.js';

const baseUrl = 'https://tenant.feishu.cn';
type Input<K extends keyof FeishuDocumentProgressPort> = Parameters<FeishuDocumentProgressPort[K]>[0];
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
class Documents implements FeishuDocumentProgressPort {
  readonly documents: string[] = [];
  readonly blocks = new Map<string, string>();
  readonly children = new Map<string, string[]>();
  readonly tabs = new Map<string, string>();
  readonly grants = new Set<string>();
  readonly calls: { kind: string; input: unknown }[] = [];
  fail: { kind: string; when: 'before' | 'after'; error: Error } | null = null;
  hold: { kind: string; gate: ReturnType<typeof gate> } | null = null;
  before: ((kind: string) => void) | undefined;
  private async effect<T>(kind: string, input: unknown, action: () => T): Promise<T> {
    this.calls.push({ kind, input: structuredClone(input) }); this.before?.(kind);
    const failure = this.fail?.kind === kind ? this.fail : null;
    if (failure) this.fail = null;
    if (failure?.when === 'before') throw failure.error;
    if (this.hold?.kind === kind) await this.hold.gate.promise;
    const result = action();
    if (failure?.when === 'after') throw failure.error;
    return result;
  }
  createDocument(input: Input<'createDocument'>) { return this.effect('document', input, () => { const id = `doc-${this.documents.length + 1}`; this.documents.push(id); return id; }); }
  createBlock(input: Input<'createBlock'>) { return this.effect('block', input, () => {
    const id = input.parentBlockId ? `child-${this.blocks.size}` : `block-${input.documentId}`;
    this.blocks.set(id, input.text);
    if (input.parentBlockId) {
      const children = this.children.get(input.parentBlockId) ?? [];
      children.splice(input.index ?? children.length, 0, id); this.children.set(input.parentBlockId, children);
    }
    return id;
  }); }
  findBlock(input: Input<'findBlock'>) { return this.effect('findBlock', input, () => {
    const id = input.parentBlockId ? (this.children.get(input.parentBlockId) ?? [])[input.index ?? 0] : `block-${input.documentId}`;
    return id && this.blocks.get(id) === input.text ? id : null;
  }); }
  removeBlocks(input: Input<'removeBlocks'>) { return this.effect('remove', input, () => {
    this.children.set(input.parentBlockId, (this.children.get(input.parentBlockId) ?? []).filter(id => !input.blockIds.includes(id)));
    for (const id of input.blockIds) this.blocks.delete(id);
  }); }
  readBlock(input: Input<'readBlock'>) { return this.effect('read', input, () => { const text = this.blocks.get(input.blockId); assert.notEqual(text, undefined); return text!; }); }
  replaceContent(input: Input<'replaceContent'>) { return this.effect('write', input, () => { this.blocks.set(input.blockId, input.text); }); }
  grantGroupRead(input: Input<'grantGroupRead'>) { return this.effect('grant', input, () => { this.grants.add(JSON.stringify(input)); }); }
  hasGroupRead(input: Input<'hasGroupRead'>) { return this.effect('members', input, () => this.grants.has(JSON.stringify(input))); }
  findTab(input: Input<'findTab'>) { return this.effect('findTab', input, () => this.tabs.get(JSON.stringify(input)) ?? null); }
  createTab(input: Input<'createTab'>) { return this.effect('tab', input, () => { const id = `tab-${this.tabs.size + 1}`; this.tabs.set(JSON.stringify(input), id); return id; }); }
  count(kind: string) { return this.calls.filter(call => call.kind === kind).length; }
  text() { return [...this.blocks].filter(([id]) => id.startsWith('block-')).map(([id, text]) =>
    text + (this.children.get(id) ?? []).map(child => this.blocks.get(child) ?? '').join('')).join('\n'); }
}
function task(id = 'task', turnId = 'turn'): Task {
  return taskSchema.parse({ id, sourceId: id, source: { kind: 'manual', message: { id, chatId: 'private', senderId: 'owner', text: 'Discuss', attachments: [], createdAt: 1 } },
    contextDirectory: '/tmp', resources: [], status: 'running', reason: null, prompt: '', promptHash: '', skillPath: null,
    chatId: `chat-${id}`, threadId: `thread-${id}`, turnId, executionStatus: 'running', lastHandledTurnId: null, requests: [], createdAt: 1, updatedAt: 1 });
}
async function fixture(t: TestContext, initialize = true) {
  const directory = await mkdtemp(join(tmpdir(), 'document-progress-'));
  let store = new Store(directory), now = Date.UTC(2026, 10, 7);
  const transport = new Documents();
  let publisher = new FeishuDocumentProgressPublisher({ store, transport, documentBaseUrl: baseUrl, intervalMs: 1000, now: () => now });
  t.after(async () => { await publisher.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  if (initialize) await publisher.poll();
  return { directory, transport, get store() { return store; }, get publisher() { return publisher; },
    event(kind: ExecutionEvent['kind'], text: string, changes: Partial<ExecutionEvent> = {}) {
      store.recordExecutionEvent('task', { threadId: 'thread-task', turnId: 'turn', itemId: 'item', kind, text, label: kind, createdAt: now, ...changes });
    },
    advance(ms = 3000) { now += ms; },
    async pump(count = 1) { for (let i = 0; i < count; i++) { await publisher.poll(); now += 3000; } },
    record(id = 'task') { return documentPublicationSchema.parse(store.documentProgressRecord(id)); },
    async restart(options: { maxLines?: number } = {}) { await publisher.close(); store.close(); store = new Store(directory); publisher = new FeishuDocumentProgressPublisher({ store, transport, documentBaseUrl: baseUrl, now: () => now, ...options }); },
  };
}

test('document config requires an explicit HTTPS origin only when enabled', () => {
  const parse = (progress: unknown) => configSchema.parse({ feishu: { userOpenId: 'owner', progress } }).feishu.progress;
  assert.equal(parse({}).surface, 'card');
  assert.equal(parse({}).maxLines, 3000);
  assert.equal(parse({ maxLines: 100 }).maxLines, 100);
  for (const maxLines of [0, -1, 1.5, 100_001]) assert.throws(() => parse({ maxLines }));
  assert.equal(parse({ surface: 'document' }).enabled, false);
  assert.throws(() => parse({ enabled: true, surface: 'document' }));
  assert.equal(parse({ enabled: true, surface: 'document', documentBaseUrl: baseUrl + '/' }).documentBaseUrl, baseUrl);
  for (const url of ['http://tenant.feishu.cn', 'https://user:pass@tenant.feishu.cn', baseUrl + '/docx/id', baseUrl + '?x=1', baseUrl + '#x', baseUrl + ':443/path']) {
    assert.throws(() => parse({ documentBaseUrl: url }), url);
  }
});

test('one task reuses its document and tab across turns, completion and restart; visible text has no internal IDs', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.event('agent_delta', 'First progress');
  await f.pump(5);
  assert.equal(f.record().delivery.kind, 'ready');
  assert.equal(f.transport.documents.length, 1); assert.equal(f.transport.tabs.size, 1);
  assert.deepEqual(f.transport.calls.find(call => call.kind === 'document')?.input, { title: '执行进度' });
  assert.match([...f.transport.blocks.values()][0]!, /First progress/);
  assert.doesNotMatch([...f.transport.blocks.values()][0]!, /task|agent-loop|[a-f0-9]{8}-[a-f0-9]{4}/);
  f.store.saveTask({ ...task(), executionStatus: 'completed', status: 'idle' }); await f.pump();
  await f.restart(); f.store.saveTask(task('task', 'second'));
  f.event('agent_message', 'Second progress', { turnId: 'second' });
  f.event('turn_end', 'failed', { turnId: 'turn' });
  await f.pump(3);
  assert.equal(f.record().turnId, 'second');
  assert.match([...f.transport.blocks.values()][0]!, /Second progress/);
  assert.match(f.transport.text(), /First progress/);
  assert.match(f.transport.text(), /Second progress[\s\S]*First progress/);
  assert.equal(f.transport.count('document'), 1); assert.equal(f.transport.count('block'), 1); assert.equal(f.transport.count('tab'), 1);
});

test('first enable excludes completed history across restart, but captures fast new turns and pre-snapshot events', async t => {
  const f = await fixture(t, false);
  f.store.saveTask({ ...task(), executionStatus: 'completed', status: 'idle' });
  f.event('agent_message', 'Historical'); await f.pump(); await f.restart();
  f.event('turn_status', 'completed'); await f.pump();
  assert.equal(f.transport.calls.length, 0);
  f.event('agent_message', 'Fast current', { turnId: 'fast' }); await f.pump();
  f.store.saveTask({ ...task('task', 'fast'), executionStatus: 'completed', status: 'idle' }); await f.pump(5);
  assert.match([...f.transport.blocks.values()][0]!, /Fast current/);
  assert.equal(f.record().view.status, 'completed');
});

test('pending native requests win stale completion/running events and task snapshot states', async t => {
  const f = await fixture(t);
  f.store.saveTask({ ...task(), executionStatus: 'completed', requests: [{ id: 'request', threadId: 'thread-task', turnId: 'turn', kind: 'approval',
    method: 'item/commandExecution/requestApproval', prompt: 'permission', isBlocking: true, connectionEpoch: 'epoch', payload: {} }] });
  f.event('turn_end', 'completed'); await f.pump();
  assert.equal(f.record().view.status, 'waiting_approval');
});

test('unknown create is durably pending before dispatch and never creates again after restart', async t => {
  const f = await fixture(t); f.store.saveTask(task());
  f.transport.before = kind => { if (kind === 'document') assert.deepEqual(f.record().delivery, { kind: 'document', title: '执行进度', pending: true }); };
  f.transport.fail = { kind: 'document', when: 'after', error: new Error('timeout') };
  await f.pump(); await f.restart(); await f.pump(30);
  assert.equal(f.transport.documents.length, 1); assert.equal(f.transport.count('document'), 1); assert.equal(f.transport.count('block'), 0);
});

test('explicit rejection backs off and retries; known document ID is durable before block writes', async t => {
  const f = await fixture(t); f.store.saveTask(task());
  f.transport.fail = { kind: 'document', when: 'before', error: new DocumentRequestRejected('permission') };
  await f.publisher.poll(); await f.publisher.poll(); assert.equal(f.transport.count('document'), 1);
  f.advance(); await f.pump(); await f.restart();
  f.transport.before = kind => { if (kind === 'block') { const d = f.record().delivery; assert.equal(d.kind, 'block'); assert.ok('documentId' in d && d.documentId === 'doc-1'); } };
  await f.pump(4); assert.equal(f.transport.documents.length, 1); assert.equal(f.record().delivery.kind, 'ready');
});

for (const kind of ['block', 'grant', 'tab']) {
  test(`unknown ${kind} adopts the exact remote effect after restart without duplicate mutations`, async t => {
    const f = await fixture(t); f.store.saveTask(task()); f.event('agent_message', 'Initial text');
    f.transport.fail = { kind, when: 'after', error: new Error('lost ACK') };
    await f.pump(kind === 'block' ? 2 : kind === 'grant' ? 3 : 4); await f.restart();
    f.event('agent_message', 'Newer text'); await f.pump(8);
    assert.equal(f.record().delivery.kind, 'ready'); assert.equal(f.transport.count(kind), 1);
    assert.match([...f.transport.blocks.values()][0]!, /Newer text/);
  });
  test(`unknown absent ${kind} never blindly retries`, async t => {
    const f = await fixture(t); f.store.saveTask(task());
    f.transport.fail = { kind, when: 'before', error: new Error('transport disconnected') };
    await f.pump(5); await f.restart(); await f.pump(30);
    assert.equal(f.transport.count(kind), 1); assert.notEqual(f.record().delivery.kind, 'ready');
  });
}

test('new events and turn resets during writes survive stale acknowledgement; updates coalesce at >=3 seconds', async t => {
  const f = await fixture(t); f.store.saveTask(task()); await f.pump(5);
  f.event('agent_message', 'Sending old view');
  const hold = gate(); f.transport.hold = { kind: 'write', gate: hold };
  const sending = f.publisher.poll();
  await Promise.resolve();
  f.store.saveTask(task('task', 'second')); f.event('agent_message', 'Newest view', { turnId: 'second' });
  await f.publisher.poll();
  const revision = f.record().projectionRevision;
  assert.notEqual(revision, null);
  hold.resolve(); await sending; f.transport.hold = null;
  assert.deepEqual(f.record().projectionRevision, revision);
  assert.match(f.record().text, /Newest view[\s\S]*Sending old view/);
  const count = f.transport.count('write'); await f.publisher.poll(); f.advance(2999); await f.publisher.poll();
  assert.equal(f.transport.count('write'), count);
  f.advance(1); await f.pump();
  assert.match([...f.transport.blocks.values()][0]!, /Newest view/);
});

for (const when of ['before', 'after'] as const) {
  test(`lost content ACK ${when} effect resolves saved payload before new version`, async t => {
    const f = await fixture(t); f.store.saveTask(task()); await f.pump(5);
    f.event('agent_message', 'Saved payload'); f.transport.fail = { kind: 'write', when, error: new Error('lost') };
    await f.pump(); const sent = f.transport.calls.filter(call => call.kind === 'write').at(-1);
    await f.restart(); f.event('agent_message', 'Newest payload'); await f.pump();
    const writes = f.transport.calls.filter(call => call.kind === 'write');
    if (when === 'before') assert.deepEqual(writes.at(-1), sent);
    else assert.equal(writes.length, 2, 'readback avoids repeating an acknowledged effect');
    await f.pump(); assert.match([...f.transport.blocks.values()][0]!, /Newest payload/);
  });
}

test('publisher bounds in-flight tasks and fairly schedules other tasks after release', async t => {
  const f = await fixture(t); for (let i = 0; i < 7; i++) f.store.saveTask(task(`task-${i}`));
  const hold = gate(); f.transport.hold = { kind: 'document', gate: hold };
  const running = f.publisher.poll(); await Promise.resolve(); await f.publisher.poll();
  assert.equal(f.transport.count('document'), 2);
  hold.resolve(); await running; f.transport.hold = null;
  await f.pump(4); assert.equal(f.transport.count('document'), 7);
});

test('line-bounded document retains recent Unicode dialogue and excludes tools', async t => {
  const f = await fixture(t); f.store.saveTask(task());
  f.event('agent_delta', '文😀\\\n'.repeat(20_000));
  f.event('tool_output', '<at user_id="all">@all</at> [link](https://invalid) 😀'.repeat(20_000));
  await f.pump(12);
  const text = f.transport.text();
  assert.equal(text.split('\n').length, 3000); assert.match(text, /较早内容已省略/);
  assert.doesNotMatch(text, /<at|工具/); assert.match(text, /文😀/);
});

test('historical bootstrap reads beyond event pages and tools cannot evict dialogue', async t => {
  const f = await fixture(t); f.store.saveTask(task());
  f.event('agent_message', 'Old first answer', { itemId: 'old', turnId: 'old-turn' });
  for (let i = 0; i < 650; i++) f.event('tool_output', 'PRIVATE_TOOL_NOISE');
  for (let i = 0; i < 6; i++) f.event('agent_message', `Answer ${i}`, { itemId: `answer-${i}` });
  const message = { id: 'user-reply', chatId: 'chat-task', senderId: 'owner', text: 'Original user reply', attachments: [], createdAt: Date.UTC(2026, 10, 7), chatType: 'group' as const };
  f.store.receive('task', message);
  await f.pump(5); await f.restart(); await f.pump();
  const text = f.transport.text();
  assert.match(text, /Old first answer/); assert.match(text, /Original user reply/); assert.doesNotMatch(text, /PRIVATE_TOOL_NOISE/);
  for (let i = 0; i < 6; i++) assert.ok(text.includes(`Answer ${i}`));
});

for (const when of ['before', 'after'] as const) {
  test(`overflow append with lost ${when} ACK preserves history and cannot duplicate after restart`, async t => {
    const f = await fixture(t); f.store.saveTask(task()); await f.pump(5);
    const long = '长文本😀'.repeat(5000);
    f.event('agent_message', long);
    await f.pump();
    f.transport.fail = { kind: 'block', when, error: new Error('lost child ACK') };
    await f.pump(); await f.restart(); await f.pump(12);
    const record = f.record(); assert.equal(record.delivery.kind, 'ready');
    if (record.delivery.kind !== 'ready') return;
    if (when === 'after') {
      assert.ok(f.transport.text().includes(long));
      assert.equal(f.transport.count('block'), documentChunks(record.text).length);
      f.event('agent_message', 'Short replacement'); await f.pump(8);
      assert.ok(f.transport.text().includes('Short replacement'));
      assert.equal(f.transport.children.get('block-doc-1')?.length, 0);
    } else {
      assert.equal(f.transport.count('block'), 2);
      assert.equal(record.delivery.operation?.kind, 'append');
      assert.equal(record.delivery.operation?.sent, true);
    }
  });
}

test('legacy pending content is reconciled before conversation history replaces it', async t => {
  const f = await fixture(t); f.store.saveTask(task()); await f.pump(5);
  const record = f.record(); assert.equal(record.delivery.kind, 'ready');
  if (record.delivery.kind !== 'ready') return;
  const legacy = { ...record, delivery: { ...record.delivery, write: { clientToken: 'legacy-token', text: 'Legacy pending text', sent: true } } };
  f.store.saveDocumentProgressRecord('task', legacy);
  f.event('agent_message', 'Restored conversation');
  await f.restart(); await f.pump(5);
  assert.match(f.transport.text(), /Restored conversation/);
  assert.equal(f.transport.count('document'), 1);
  assert.ok(f.transport.calls.some(call => call.kind === 'write' && JSON.stringify(call.input).includes('legacy-token')));
});

test('legacy publications rebuild once and unchanged publications skip history across restart', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.event('agent_message', 'Retained answer');
  await f.pump(5);
  const before = f.record();
  const { projectionRevision, ...legacy } = before;
  assert.notEqual(projectionRevision, null);
  assert.equal(documentPublicationSchema.parse(legacy).projectionRevision, null);
  f.store.saveDocumentProgressRecord('task', legacy);
  await f.restart();
  const events = t.mock.method(f.store, 'documentConversationEvents');
  const inputs = t.mock.method(f.store, 'inputs');
  await f.pump(3);
  assert.equal(events.mock.callCount(), 1); assert.equal(inputs.mock.callCount(), 1);
  assert.deepEqual(f.record(), before);
  f.store.saveTask({ ...task(), updatedAt: 12345, prompt: 'Changed engineering guidance', promptHash: 'changed' });
  await f.pump();
  assert.equal(events.mock.callCount(), 1); assert.equal(inputs.mock.callCount(), 1);
  await f.restart();
  const restartedEvents = t.mock.method(f.store, 'documentConversationEvents');
  const restartedInputs = t.mock.method(f.store, 'inputs');
  await f.pump(2);
  assert.equal(restartedEvents.mock.callCount(), 0); assert.equal(restartedInputs.mock.callCount(), 0);
  assert.deepEqual(f.record(), before);
});

test('input-only changes retain original provenance, attachments and CLI submissions without execution events', async t => {
  const f = await fixture(t); f.store.saveTask(task()); await f.pump(5);
  assert.deepEqual(f.store.documentConversationPosition('task'), { eventSeq: 0, inputSeq: 0 });
  const original = incomingSchema.parse({ id: 'reply', chatId: 'chat-task', senderId: 'owner', text: 'Original directory reply',
    attachments: [{ key: 'file-key', kind: 'file', name: 'evidence.txt' }], createdAt: 2 });
  f.store.receive('task', { ...original, text: 'PRIVATE_EXPANDED_PROMPT', attachments: [] }, 'user',
    { kind: 'user', message: original }, 'workspace-selection');
  await f.pump();
  assert.match(f.transport.text(), /Original directory reply\n附件：evidence.txt/);
  assert.doesNotMatch(f.transport.text(), /PRIVATE_EXPANDED_PROMPT|file-key/);
  const userRevision = f.record().projectionRevision;
  f.store.receive('task', { ...original, id: 'cli', text: 'CLI continuation', attachments: [], createdAt: 3 }, 'initial',
    { kind: 'cli', requestId: submissionRequestIdSchema.parse('00000000-0000-4000-8000-000000000001') });
  await f.pump();
  assert.match(f.transport.text(), /CLI 提交[^\n]*\nCLI continuation/);
  assert.notDeepEqual(f.record().projectionRevision, userRevision);
  assert.equal(f.record().projectionRevision?.eventSeq, 0);
  f.store.markInput('reply', 'delivered'); f.store.markSelectionHandled('reply', 'task');
  const reads = t.mock.method(f.store, 'documentConversationEvents');
  await f.pump(); assert.equal(reads.mock.callCount(), 0);
});

test('status, turn and thread identity changes invalidate projection without new events', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.event('turn_end', 'completed'); await f.pump(5);
  assert.equal(f.record().view.status, 'completed');
  const reads = t.mock.method(f.store, 'documentConversationEvents');
  await f.pump(); assert.equal(reads.mock.callCount(), 0, 'terminal event and running snapshot remain stable');
  f.store.saveTask({ ...task(), status: 'paused' }); await f.pump(2);
  assert.equal(f.record().view.status, 'paused'); assert.equal(reads.mock.callCount(), 1);
  f.store.saveTask(task('task', 'second')); await f.pump(2);
  assert.equal(f.record().turnId, 'second'); assert.equal(f.record().view.status, 'running');
  assert.equal(reads.mock.callCount(), 2);
  f.store.saveTask({ ...task(), threadId: 'new-thread' }); await f.pump(2);
  assert.equal(f.record().view.status, 'running'); assert.equal(reads.mock.callCount(), 3);
});

test('manual source changes invalidate projection and a new chat binding creates a separate document', async t => {
  const f = await fixture(t); const current = task(); f.store.saveTask(current); await f.pump(5);
  assert.equal(current.source.kind, 'manual'); if (current.source.kind !== 'manual') return;
  f.store.saveTask({ ...current, source: { kind: 'manual', message: { ...current.source.message, text: 'Revised original question' } } });
  await f.pump(); assert.match(f.transport.text(), /Revised original question/); assert.doesNotMatch(f.transport.text(), /Discuss/);
  const before = f.record();
  f.store.saveTask({ ...f.store.task('task'), chatId: 'other-chat' });
  await f.pump();
  assert.equal(f.record().chatId, 'other-chat');
  assert.equal(f.transport.documents.length, 2);
  assert.equal(f.store.meta('retired-document-progress:task:chat-task'), JSON.stringify(before));
});

test('dissolved and absent chats stop saved document publications without affecting execution', async t => {
  const f = await fixture(t); f.store.saveTask(task()); await f.pump(2);
  const before = f.transport.calls.length;
  f.store.saveTask({ ...f.store.task('task'), chatId: null });
  await f.pump(5);
  assert.equal(f.transport.calls.length, before);
  f.store.saveTask({ ...f.store.task('task'), chatId: 'chat-task' });
  f.transport.fail = { kind: 'members', when: 'before', error: new TaskGroupUnavailable(232009, 'dissolved') };
  await f.pump(4);
  assert.equal(f.store.task('task').chatId, null);
  assert.equal(f.store.task('task').status, 'running');
  const stopped = f.transport.calls.length;
  await f.pump(5); assert.equal(f.transport.calls.length, stopped);
});

test('retiring a task group during unknown-write readback prevents a later write to its document', async t => {
  const f = await fixture(t); f.store.saveTask(task()); await f.pump(5);
  f.event('agent_message', 'Changed document content');
  f.transport.fail = { kind: 'write', when: 'before', error: new Error('write outcome unknown') };
  await f.pump();
  const writes = f.transport.count('write');
  const hold = gate(); f.transport.hold = { kind: 'read', gate: hold };
  const reading = f.publisher.poll();
  await Promise.resolve();
  assert.ok(f.transport.count('read') > 0);
  f.store.saveTask({ ...f.store.task('task'), chatId: null });
  hold.resolve(); await reading; f.transport.hold = null;
  assert.equal(f.transport.count('write'), writes, 'detaching during readback must stop the old publication');
});

test('maxLines and renderer revision changes re-render unchanged histories once', async t => {
  const f = await fixture(t); f.store.saveTask(task());
  f.event('agent_message', Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n')); await f.pump(5);
  await f.restart({ maxLines: 8 });
  const reads = t.mock.method(f.store, 'documentConversationEvents');
  await f.pump(2);
  assert.equal(f.record().text.split('\n').length, 8); assert.equal(f.record().projectionRevision?.maxLines, 8);
  assert.equal(reads.mock.callCount(), 1); assert.equal(f.transport.text(), f.record().text);
  const before = f.record(); assert.ok(before.projectionRevision);
  f.store.saveDocumentProgressRecord('task', { ...before, projectionRevision: { ...before.projectionRevision, rendererVersion: 0 } });
  await f.pump(2);
  assert.equal(reads.mock.callCount(), 2); assert.deepEqual(f.record(), before);
});

test('source positions are per task and include tool events without moving the conversation cursor', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.store.saveTask(task('other'));
  f.event('agent_message', 'Answer'); await f.pump(5);
  const before = f.record(); f.event('tool_output', 'PRIVATE_TOOL');
  f.store.recordExecutionEvent('other', { kind: 'agent_message', threadId: 'thread-other', turnId: 'turn', itemId: 'other', text: 'Other', label: 'message', createdAt: 10 });
  await f.pump();
  assert.equal(f.record().projectionRevision?.eventSeq, 2);
  assert.equal(f.store.documentConversationPosition('other').eventSeq, 3);
  assert.equal(f.record().view.cursor, before.view.cursor); assert.equal(f.record().text, before.text);
});

test('invalid persisted events roll back all projections and discovery position until repaired', async t => {
  const f = await fixture(t); f.store.saveTask(task()); f.store.saveTask(task('other')); await f.pump(10);
  const before = f.store.documentProgressRecords(), discovery = f.store.meta('feishu-document-progress:discovery:v1');
  f.event('agent_message', 'New task answer');
  const valid = { kind: 'agent_message', threadId: 'thread-other', turnId: 'turn', itemId: 'other', text: 'New other answer', label: 'message', createdAt: 10 } satisfies ExecutionEvent;
  f.store.recordExecutionEvent('other', valid);
  const db = new DatabaseSync(join(f.directory, 'tasks.sqlite'));
  let badSequence: number | bigint;
  try {
    badSequence = db.prepare('INSERT INTO execution_events(task_id,created_at,payload) VALUES(?,?,?)')
      .run('other', 11, JSON.stringify({ ...valid, kind: 'agent_delta', text: 123 })).lastInsertRowid;
  } finally { db.close(); }
  const stream = f.store.documentConversationEvents('other');
  assert.deepEqual(stream.next(), { done: false, value: { ...valid, seq: 2, taskId: 'other' } });
  assert.throws(() => stream.next());
  const calls = f.transport.calls.length;
  await f.pump();
  assert.deepEqual(f.store.documentProgressRecords(), before);
  assert.equal(f.store.meta('feishu-document-progress:discovery:v1'), discovery);
  assert.equal(f.transport.calls.length, calls);
  assert.ok(f.store.diagnostics().some(row => row.scope === 'feishu-document-progress'));
  const repair = new DatabaseSync(join(f.directory, 'tasks.sqlite'));
  try { repair.prepare('DELETE FROM execution_events WHERE seq=?').run(badSequence); } finally { repair.close(); }
  await f.pump(2);
  assert.match(f.transport.text(), /New task answer/); assert.match(f.transport.text(), /New other answer/);
  assert.equal(f.record('other').projectionRevision?.eventSeq, 2);
});

async function runtime(t: TestContext, enabled = true) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.UTC(2026, 10, 7) });
  const directory = await mkdtemp(join(tmpdir(), 'document-runtime-'));
  const documentProgress = new Documents(); let cards = 0;
  const rejectCard = async () => { cards++; throw new Error('card publisher must not run'); };
  const progress: FeishuProgressPort = { createProgressCard: rejectCard, sendProgressCard: rejectCard, findProgressMessage: rejectCard, updateProgressContent: rejectCard, setProgressStreaming: rejectCard };
  const feishu = Object.assign(new FeishuFake(), { progress, documentProgress }), codex = new CodexFake();
  const config = configSchema.parse({ dataDir: directory, executionPollMs: 600_000, pollIntervalMs: 600_000,
    feishu: { userOpenId: 'owner', progress: { enabled, surface: 'document', documentBaseUrl: baseUrl, intervalMs: 1000 } } });
  const ports = { feishu, codex, github: new GitHubFake(), workspace: { ensure: async () => directory, head: async () => 'head' } };
  let loop = new AgentLoop(config, ports);
  t.after(async () => { await loop.close(); t.mock.timers.reset(); await rm(directory, { recursive: true, force: true }); });
  const pump = async (count = 1) => { for (let i = 0; i < count; i++) { t.mock.timers.tick(3000); for (let n = 0; n < 30; n++) await Promise.resolve(); } };
  await loop.start();
  return { documentProgress, feishu, codex, config, pump, get loop() { return loop; }, get cards() { return cards; },
    async restart() { await loop.close(); loop = new AgentLoop(config, ports); await loop.start(); },
    async receive(id: string, text: string, chatId = 'private') {
      await loop.receive({ id, text, chatId, senderId: 'owner', chatType: chatId === 'private' ? 'p2p' : 'group', attachments: [], createdAt: Date.now() });
    } };
}

test('whole AgentLoop runs two turns and restart with one document/tab, zero progress messages and independent final/native delivery', async t => {
  const f = await runtime(t); await f.receive('new', 'Discuss');
  const current = f.loop.tasks()[0]!; assert.ok(current.threadId && current.chatId && current.turnId);
  await f.pump(5); assert.equal(f.documentProgress.tabs.size, 1);
  f.codex.complete(current.threadId, 'First final'); await f.loop.tick(); await f.pump(); await f.restart();
  await f.receive('next', 'Continue', current.chatId);
  const snapshot = f.codex.snapshot(current.threadId); assert.ok(snapshot.turnId);
  snapshot.requests = [{ id: 'native', threadId: current.threadId, turnId: snapshot.turnId, kind: 'approval', method: 'item/commandExecution/requestApproval',
    prompt: 'Permission', payload: {}, isBlocking: true, connectionEpoch: 'epoch' }];
  await f.loop.tick(); assert.equal(f.feishu.approvals.length, 1);
  f.codex.complete(current.threadId, 'Second final'); await f.loop.tick(); await f.pump(3);
  assert.equal(f.documentProgress.documents.length, 1); assert.equal(f.documentProgress.tabs.size, 1); assert.equal(f.cards, 0);
  assert.equal(f.feishu.sent.filter(message => message.text === 'First final').length, 1);
  assert.equal(f.feishu.sent.filter(message => message.text === 'Second final').length, 1);
  assert.ok(f.feishu.sent.every(message => !message.text.includes('执行进度')));
});

test('whole AgentLoop keeps final/native delivery working with missing document permission and no fallback', async t => {
  const f = await runtime(t); f.documentProgress.createDocument = async () => { throw new DocumentRequestRejected('99991672 Access denied'); };
  await f.receive('new', 'Discuss'); const current = f.loop.tasks()[0]!; assert.ok(current.threadId && current.turnId);
  await f.pump();
  const snapshot = f.codex.snapshot(current.threadId);
  snapshot.requests = [{ id: 'question', threadId: current.threadId, turnId: current.turnId, kind: 'question', method: 'item/tool/requestUserInput', prompt: 'Which value?', payload: {}, isBlocking: true, connectionEpoch: 'epoch' }];
  await f.loop.tick(); assert.ok(f.feishu.sent.some(message => message.text.includes('Which value?')));
  f.codex.complete(current.threadId, 'Unchanged final'); await f.loop.tick();
  assert.equal(f.feishu.sent.filter(message => message.text === 'Unchanged final').length, 1); assert.equal(f.cards, 0);
  assert.ok(f.loop.store.diagnostics().some(row => row.scope === 'feishu-document-progress'));
});

test('whole AgentLoop first enable does not backfill historical completed tasks', async t => {
  const f = await runtime(t, false); await f.receive('old', 'Old'); const current = f.loop.tasks()[0]!; assert.ok(current.threadId && current.chatId);
  f.codex.complete(current.threadId, 'Old final'); await f.loop.tick(); f.config.feishu.progress.enabled = true;
  await f.restart(); await f.pump(6); await f.restart(); await f.pump(3); assert.equal(f.documentProgress.calls.length, 0);
  await f.receive('new', 'New turn', current.chatId); f.codex.complete(current.threadId, 'Fast final'); await f.loop.tick(); await f.pump(6);
  assert.equal(f.documentProgress.documents.length, 1); assert.equal(f.documentProgress.tabs.size, 1); assert.equal(f.cards, 0);
});
