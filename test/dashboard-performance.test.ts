import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { taskSchema } from '../src/domain.js';
import type { ExecutionEvent } from '../src/execution-events.js';
import { startDashboard } from '../src/dashboard.js';
import { Store, diagnosticRetentionLimit, executionEventRetentionLimit } from '../src/store.js';

function task(root: string) {
  const message = { id: 'source', chatId: 'chat', senderId: 'owner', text: 'Keep this user message', attachments: [], createdAt: 1, chatType: 'p2p' as const };
  return taskSchema.parse({
    id: 'task', sourceId: 'source', source: { kind: 'manual', message }, purpose: 'execution', contextDirectory: root, resources: [],
    status: 'idle', reason: null, prompt: 'Inspect', promptHash: 'hash', skillPath: null, chatId: 'chat', threadId: 'thread', turnId: 'turn',
    executionStatus: 'idle', lastHandledTurnId: null, requests: [], recovery: { attempts: 0, nextAttemptAt: null, lastError: null, interruptedTurnId: null, lastUserInputSeq: null }, createdAt: 1, updatedAt: 1,
  });
}

function event(kind: ExecutionEvent['kind'], text: string, createdAt = 10): ExecutionEvent {
  return { threadId: 'thread', turnId: 'turn', itemId: 'item', kind, label: kind, text, createdAt };
}

test('runtime event durability drops private output, samples deltas, and keeps durable messages after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-retention-'));
  const store = new Store(root); const saved = task(root); store.saveTask(saved);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.recordExecutionEvent(saved.id, event('agent_delta', 'first', 10));
  store.recordExecutionEvent(saved.id, event('agent_delta', 'second', 11));
  store.recordExecutionEvent(saved.id, event('tool_output', 'PRIVATE_OUTPUT'.repeat(5), 12));
  store.recordExecutionEvent(saved.id, event('agent_message', 'final answer', 13));
  assert.ok(store.executionEvents(saved.id).some(item => item.kind === 'tool_output'), 'ephemeral progress remains available in the owning process');
  const readOnly = new Store(root, { readOnly: true });
  assert.equal(readOnly.executionEvents(saved.id).some(item => item.kind === 'tool_output'), false);
  assert.equal(readOnly.executionEvents(saved.id).filter(item => item.kind === 'agent_delta').length, 1);
  assert.equal(readOnly.executionEvents(saved.id).find(item => item.kind === 'agent_message')?.text, 'final answer');
  readOnly.close();
});

test('diagnostics roll up duplicates and data_version invalidates the dashboard read model', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-cache-'));
  const store = new Store(root); const saved = task(root); store.saveTask(saved);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  for (let index = 0; index < diagnosticRetentionLimit + 100; index++) store.diagnostic('scope', 'same failure');
  assert.equal(store.diagnostics().filter(item => item.scope === 'scope' && item.message === 'same failure').length, 1);
  const dashboard = await startDashboard({ dataDir: root, port: 0, host: '127.0.0.1' });
  t.after(async () => { await dashboard.close(); });
  const first = await (await fetch(dashboard.url + '/api/snapshot')).json();
  saved.updatedAt = 2; saved.reason = 'changed'; store.saveTask(saved);
  const second = await (await fetch(dashboard.url + '/api/snapshot')).json();
  assert.equal(first.tasks[0].reason, null); assert.equal(second.tasks[0].reason, 'changed');
});

test('durable execution history compacts per task without exceeding its event budget', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-events-'));
  const store = new Store(root); const saved = task(root); store.saveTask(saved);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  for (let index = 0; index < 2_050; index++) store.recordExecutionEvent(saved.id, event('turn_status', 'running', index + 1));
  const readOnly = new Store(root, { readOnly: true });
  assert.ok(readOnly.executionEvents(saved.id).length <= executionEventRetentionLimit);
  readOnly.close();
});

test('retention trims the 2002-row final-plus-sampled-delta case to the exact durable budget', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-retention-bound-'));
  const store = new Store(root); const saved = task(root); store.saveTask(saved);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.recordExecutionEvent(saved.id, event('agent_delta', 'sampled delta', 10));
  store.recordExecutionEvent(saved.id, event('agent_message', 'final answer', 11));
  for (let index = 0; index < executionEventRetentionLimit; index++) store.recordExecutionEvent(saved.id, event('turn_status', 'running', index + 12));
  const db = new DatabaseSync(join(root, 'tasks.sqlite'));
  try {
    const count = (db.prepare('SELECT COUNT(*) AS count FROM execution_events WHERE task_id=?').get(saved.id) as { count: number }).count;
    assert.equal(count, executionEventRetentionLimit);
    const final = db.prepare("SELECT payload FROM execution_events WHERE task_id=? AND json_extract(payload,'$.kind')='agent_message'").get(saved.id) as { payload: string } | undefined;
    assert.equal(JSON.parse(final!.payload).text, 'final answer');
  } finally { db.close(); }
});
