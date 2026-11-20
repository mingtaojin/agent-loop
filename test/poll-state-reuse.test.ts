import { ExecutionFixture } from './execution-fixture.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { incomingSchema, taskSchema } from '../src/domain.js';
import { Store } from '../src/store.js';
import { TaskCloseout, taskCloseoutSchema } from '../src/task-closeout.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'poll-state-'));
  const store = new Store(root);
  const task = taskSchema.parse({ id: 'task', sourceId: 'source',
    source: { kind: 'manual', message: { id: 'source', chatId: 'chat', senderId: 'owner', text: 'Original', attachments: [], createdAt: 1 } },
    contextDirectory: root, resources: [], status: 'idle', reason: null, prompt: '', promptHash: '', skillPath: null,
    chatId: 'chat', threadId: 'thread', turnId: null, executionStatus: 'idle', lastHandledTurnId: null, requests: [], createdAt: 1, updatedAt: 1 });
  store.saveTask(task);
  const db = new DatabaseSync(join(root, 'tasks.sqlite'));
  t.after(async () => { db.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, task, db, get closeout() { return new TaskCloseout(store, { usage: async () => null, protectedPaths: () => [] }); } };
}

test('repeated task snapshots reuse validation and isolate caller mutations', async t => {
  const { store, task } = await fixture(t);
  assert.equal(typeof taskSchema.safeParse, 'function');
  const parsing = t.mock.method(taskSchema, 'safeParse');
  const first = store.task(task.id);
  assert.equal(first.source.kind, 'manual');
  if (first.source.kind === 'manual') first.source.message.text = 'Unsaved change';
  first.recovery.lastError = 'Unsaved error';
  for (const value of [store.task(task.id), store.tasks()[0], store.taskForSource(task.sourceId), store.taskForChat('chat'), store.taskForThread('thread')]) {
    assert.deepEqual(value, task);
  }
  assert.equal(parsing.mock.callCount(), 1);
  store.saveTask({ ...task, reason: 'Saved change' });
  assert.equal(store.task(task.id).reason, 'Saved change');
  assert.equal(parsing.mock.callCount(), 2);
});

test('task snapshots observe external edits, rollback, invalid data and deletion', async t => {
  const { store, task, db } = await fixture(t);
  assert.deepEqual(store.task(task.id), task);
  db.prepare('UPDATE tasks SET payload=? WHERE id=?').run(JSON.stringify({ ...task, reason: 'External' }), task.id);
  assert.equal(store.task(task.id).reason, 'External');
  assert.throws(() => store.transaction(() => {
    store.saveTask({ ...task, reason: 'Uncommitted' });
    assert.equal(store.tasks()[0]?.reason, 'Uncommitted');
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(store.taskForChat('chat')?.reason, 'External');
  db.prepare('UPDATE tasks SET payload=? WHERE id=?').run('{}', task.id);
  assert.throws(() => store.task(task.id));
  db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
  assert.equal(store.taskForThread('thread'), null);
  assert.deepEqual(store.tasks(), []);
  assert.throws(() => store.task(task.id), /Unknown task/);
});

test('repeated polling reuses SQL preparation without retaining parameter bindings', async t => {
  const { store } = await fixture(t);
  store.setMeta('one', 'first'); store.setMeta('two', 'second');
  const preparing = t.mock.method(DatabaseSync.prototype, 'prepare');
  for (let i = 0; i < 10; i++) {
    assert.equal(store.meta('one'), 'first'); assert.equal(store.meta('two'), 'second'); assert.equal(store.meta('missing'), null);
  }
  assert.equal(preparing.mock.calls.filter(call => call.arguments[0] === 'SELECT value FROM meta WHERE key=?').length, 1);
});

test('document payload reuse avoids repeated blob reads and observes writes and rollback', async t => {
  const { store, task, db } = await fixture(t);
  store.saveDocumentProgressRecord(task.id, { text: 'Original' });
  const reads = t.mock.method(StatementSync.prototype, 'get');
  for (let i = 0; i < 10; i++) assert.equal(store.documentProgressPayload(task.id), '{"text":"Original"}');
  assert.equal(reads.mock.calls.filter(call => call.this instanceof StatementSync && call.this.sourceSQL === 'SELECT payload FROM feishu_document_progress WHERE task_id=?').length, 1);
  store.saveDocumentProgressRecord(task.id, { text: 'Saved' });
  assert.deepEqual(store.documentProgressRecord(task.id), { text: 'Saved' });
  assert.throws(() => store.transaction(() => {
    store.saveDocumentProgressRecord(task.id, { text: 'Uncommitted' });
    assert.deepEqual(store.documentProgressRecord(task.id), { text: 'Uncommitted' });
    throw new Error('rollback');
  }), /rollback/);
  assert.deepEqual(store.documentProgressRecord(task.id), { text: 'Saved' });
  db.prepare('UPDATE feishu_document_progress SET payload=? WHERE task_id=?').run('{"text":"External"}', task.id);
  store.metaRevision('unrelated');
  assert.deepEqual(store.documentProgressRecord(task.id), { text: 'External' });
  db.prepare('DELETE FROM feishu_document_progress WHERE task_id=?').run(task.id);
  assert.equal(store.documentProgressRecord(task.id), null);
  store.saveDocumentProgressRecord(task.id, { text: 'Recreated' });
  assert.deepEqual(store.documentProgressRecord(task.id), { text: 'Recreated' });
});

test('closeout status reuse observes writes, external edits, deletion and rollback', async t => {
  const { store, task, db, closeout } = await fixture(t);
  const key = `task-closeout:${task.id}`;
  const open = closeout.read(task.id);
  const completed = taskCloseoutSchema.parse({ ...open, lifecycle: { kind: 'completed', outcome: 'delivered', summary: 'Done', deliveryReferences: [], at: 1, operationId: 'done' } });
  store.setMeta(key, JSON.stringify(open));
  const parsing = t.mock.method(taskCloseoutSchema, 'parse');
  for (let i = 0; i < 10; i++) { assert.equal(closeout.completed(task.id), false); assert.equal(closeout.hasPendingCleanup(task.id), false); }
  assert.equal(parsing.mock.callCount(), 1);
  store.setMeta(key, JSON.stringify(completed));
  assert.equal(closeout.completed(task.id), true);
  assert.throws(() => store.transaction(() => {
    store.setMeta(key, JSON.stringify(open));
    assert.equal(closeout.completed(task.id), false);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(closeout.completed(task.id), true);
  db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(open), key);
  store.documentProgressPayload(task.id);
  assert.equal(closeout.completed(task.id), false);
  db.prepare('UPDATE meta SET value=? WHERE key=?').run('{}', key);
  assert.throws(() => closeout.completed(task.id));
  db.prepare('DELETE FROM meta WHERE key=?').run(key);
  assert.equal(closeout.completed(task.id), false);
});

test('read-only stores see changed cached records and reject reads after closing', async t => {
  const { root, store, task } = await fixture(t);
  store.saveDocumentProgressRecord(task.id, { text: 'First' });
  const reader = new Store(root, { readOnly: true });
  assert.deepEqual(reader.task(task.id), task);
  assert.deepEqual(reader.documentProgressRecord(task.id), { text: 'First' });
  store.saveTask({ ...task, reason: 'Changed' }); store.saveDocumentProgressRecord(task.id, { text: 'Second' });
  assert.equal(reader.task(task.id).reason, 'Changed');
  assert.deepEqual(reader.documentProgressRecord(task.id), { text: 'Second' });
  reader.close();
  assert.throws(() => reader.task(task.id));
  assert.throws(() => reader.documentProgressRecord(task.id));
});

test('closeout pending cleanup changes remain visible after status was cached', async t => {
  const { store, task, closeout } = await fixture(t);
  const key = `task-closeout:${task.id}`;
  const scope = { id: 'scope', allocationRequestId: null, location: { root: { path: '/tmp/example', dev: 1, ino: 1 }, ancestors: [] },
    createdAt: 1, sealed: true, resource: { kind: 'artifacts', label: 'Temporary' }, artifacts: [] };
  const ledger = taskCloseoutSchema.parse({ ...closeout.read(task.id), scopes: [scope], operations: [{
    id: 'cleanup', requestId: 'cleanup', callerId: task.id, projectId: 'project', fingerprint: 'hash', kind: 'scopes', createdAt: 1,
    targets: [{ scope, branchHead: null, disposalPath: '/tmp/disposed', state: 'pending', reason: null, directoryRemoved: false, branchRemoved: false }],
  }] });
  assert.equal(closeout.hasPendingCleanup(task.id), false);
  store.setMeta(key, JSON.stringify(ledger));
  assert.equal(closeout.hasPendingCleanup(task.id), true);
  ledger.operations[0]!.targets[0]!.state = 'removed';
  assert.equal(closeout.hasPendingCleanup(task.id), true);
  store.setMeta(key, JSON.stringify(ledger));
  assert.equal(closeout.hasPendingCleanup(task.id), false);
});

test('event and inbox polling reuse compiled validation and preserve ordered facts', async t => {
  const { store, task, db } = await fixture(t);
  const source = new ExecutionFixture();
  for (let i = 0; i < 12; i++) {
    source.publish(task.id, { threadId: 'thread', turnId: 'turn', itemId: `item-${i}`, kind: 'agent_message',
      label: 'Assistant', text: `Reply ${i}`, createdAt: i + 1 });
    const message = incomingSchema.parse({ id: `input-${i}`, chatId: 'chat', senderId: 'owner', text: `Request ${i}`, attachments: [], createdAt: i + 1 });
    assert.equal(store.receive(task.id, message), true);
  }
  const legacy = { id: 'legacy', chatId: 'chat', senderId: 'owner', text: 'Legacy request', attachments: [], createdAt: 13 };
  db.prepare("INSERT INTO inbox(id,task_id,payload,status,origin) VALUES(?,?,?,'pending','user')").run(legacy.id, task.id, JSON.stringify(legacy));
  const events = source.execution.current(task.id);
  const inputs = store.inputs(task.id);
  assert.deepEqual(events.map(event => event.text), Array.from({ length: 12 }, (_, i) => `Reply ${i}`));
  assert.deepEqual(inputs.map(input => input.message.text), [...Array.from({ length: 12 }, (_, i) => `Request ${i}`), 'Legacy request']);
  assert.ok(inputs.every(input => input.provenance.kind === 'user' && input.provenance.message.id === input.id));
  const compile = t.mock.method(globalThis, 'Function');
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(source.execution.current(task.id), events);
    assert.deepEqual(store.inputs(task.id), inputs);
  }
  assert.equal(compile.mock.callCount(), 0);
});
