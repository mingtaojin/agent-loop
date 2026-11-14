import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
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


test('Dashboard v1 timeline exposes typed visible events and omits private tool output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-v1-timeline-'));
  const store = new Store(root); const saved = task(root); store.saveTask(saved);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.recordExecutionEvent(saved.id, event('turn_start', 'inProgress', 10));
  store.recordExecutionEvent(saved.id, { ...event('agent_message', 'Visible output', 11), label: '最终回答' });
  store.recordExecutionEvent(saved.id, event('tool_output', 'PRIVATE_OUTPUT', 12));
  const dashboard = await startDashboard({ dataDir: root, port: 0, host: '127.0.0.1' });
  t.after(async () => dashboard.close());
  const detail = await (await fetch(dashboard.url + '/api/tasks/' + saved.id)).json();
  assert.ok(detail.timeline.some((entry: { type: string }) => entry.type === 'PHASE'));
  assert.ok(detail.timeline.some((entry: { type: string }) => entry.type === 'OUTPUT'));
  assert.equal(detail.timeline.some((entry: { text: string }) => entry.text.includes('PRIVATE_OUTPUT')), false);
});

test('Dashboard v1 API remains under the 500 ms interface budget with a retained event fixture', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-v1-api-'));
  const store = new Store(root); const saved = task(root); store.saveTask(saved);
  for (let index = 0; index < 500; index++) store.recordExecutionEvent(saved.id, event('turn_status', 'running', index + 1));
  const dashboard = await startDashboard({ dataDir: root, port: 0, host: '127.0.0.1' });
  t.after(async () => { await dashboard.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const samples: number[] = [];
  for (let index = 0; index < 12; index++) {
    const started = performance.now();
    const response = await fetch(dashboard.url + (index % 2 ? '/api/projects' : '/api/snapshot'));
    await response.arrayBuffer();
    assert.equal(response.status, 200);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
  console.log(JSON.stringify({ benchmark: 'dashboard-v1-interface', count: samples.length, p50Ms: Number(samples[Math.floor(samples.length / 2)]!.toFixed(3)), p95Ms: Number(p95.toFixed(3)), maxMs: Number(samples.at(-1)!.toFixed(3)), thresholdMs: 500 }));
  assert.ok(p95 < 500, `dashboard p95 ${p95.toFixed(3)}ms exceeded 500ms`);
});
