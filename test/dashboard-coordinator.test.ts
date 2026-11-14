import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDashboard } from '../src/dashboard.js';
import { Store } from '../src/store.js';
import { ProjectLedger } from '../src/project.js';
import { taskSchema } from '../src/domain.js';

function task(id: string, title: string, purpose: 'execution' | 'intake' = 'execution') {
  const now = Date.now();
  return taskSchema.parse({ id, sourceId: id + ':source', source: { kind: 'manual', message: {
    id: id + ':message', chatId: 'chat:' + id, senderId: 'owner', text: title, attachments: [], createdAt: now, chatType: 'group',
  } }, purpose, contextDirectory: '/tmp/' + id, resources: [], workspaceSelection: { kind: 'pending' }, status: 'running', reason: null,
  prompt: title, promptHash: id, skillPath: null, chatId: 'chat:' + id, threadId: 'thread:' + id, turnId: 'turn:' + id,
  executionStatus: 'running', lastHandledTurnId: null, requests: [], recovery: { attempts: 0, nextAttemptAt: null, lastError: null, interruptedTurnId: null, lastUserInputSeq: null }, createdAt: now, updatedAt: now });
}

test('project dashboard uses ledger membership, reports, and redacted task events', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-coordinator-'));
  const store = new Store(root);
  const coordinator = task('coordinator', 'Coordinate release');
  const worker = task('worker', 'Implement dashboard');
  const verifier = task('verifier', 'Verify dashboard');
  const intake = task('intake', 'Routed request', 'intake');
  const foreign = task('foreign', 'Other project');
  store.transaction(() => {
    for (const value of [coordinator, worker, verifier, intake, foreign]) store.saveTask(value);
    const ledger = new ProjectLedger(store);
    ledger.create({ id: 'project-a', name: 'Project A', directory: root, repositories: [], instructions: '', models: { coordinator: 'gpt-6-astra', worker: 'gpt-6.1-sol' }, reasoningEfforts: { coordinator: 'high', worker: 'xhigh' } }, coordinator.id);
    ledger.addMember('project-a', worker.id, 'worker');
    ledger.addMember('project-a', verifier.id, 'verifier');
    store.setMeta('project-intake-route:' + intake.id, JSON.stringify({ projectId: 'project-a', coordinatorTaskId: coordinator.id }));
    const report = { id: 'report', chatId: 'chat:' + coordinator.id, senderId: 'runtime:project', text: 'Worker worker update. Added the reader.', attachments: [], createdAt: Date.now(), chatType: 'group' as const };
    store.receive(coordinator.id, report, 'source', { kind: 'agent', projectId: 'project-a', taskId: worker.id, eventId: 'report', category: 'update', currentStep: 'Reader', nextStep: 'Run tests', blockers: [], evidence: ['test/dashboard-coordinator.test.ts'] });
    store.recordExecutionEvent(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'agent', kind: 'agent_message', label: 'Agent', text: 'Visible progress', createdAt: Date.now() });
    store.recordExecutionEvent(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'tool', kind: 'tool_end', label: '命令 · completed · exit 0', text: '$ npm test', createdAt: Date.now() });
    store.recordExecutionEvent(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'tool', kind: 'tool_output', label: '工具输出', text: 'SECRET_OUTPUT', createdAt: Date.now() });
  });
  const dashboard = await startDashboard({ dataDir: root, port: 0 });
  t.after(async () => { await dashboard.close(); store.close(); await rm(root, { recursive: true, force: true }); });

  const projects = await (await fetch(dashboard.url + '/api/projects')).json();
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0].tasks.map((item: { id: string; role: string }) => [item.id, item.role]).sort(), [
    ['coordinator', 'coordinator'], ['worker', 'worker'], ['verifier', 'verifier'], ['intake', 'intake'],
  ].sort());
  assert.equal(projects[0].tasks.some((item: { id: string }) => item.id === 'foreign'), false);
  const workerCard = projects[0].tasks.find((item: { id: string }) => item.id === worker.id);
  assert.equal(workerCard.latestReport.currentStep, 'Reader');
  assert.match(workerCard.latestActivity.text, /npm test|Visible progress/);

  const detail = await (await fetch(dashboard.url + '/api/tasks/' + worker.id)).json();
  assert.equal(detail.projectId, 'project-a');
  assert.equal(detail.reports[0].nextStep, 'Run tests');
  assert.equal(detail.events.some((event: { kind: string }) => event.kind === 'tool_output'), false);
  assert.doesNotMatch(JSON.stringify(detail), /SECRET_OUTPUT/);
  assert.match(JSON.stringify(detail), /Visible progress/);

  const controller = new AbortController();
  const stream = await fetch(dashboard.url + '/api/events?taskId=' + worker.id, { signal: controller.signal });
  const chunk = await stream.body!.getReader().read();
  const streamText = new TextDecoder().decode(chunk.value);
  controller.abort();
  assert.doesNotMatch(streamText, /tool_output|SECRET_OUTPUT/);
  assert.match(streamText, /Visible progress/);
});
