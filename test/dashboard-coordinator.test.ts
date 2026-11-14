import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDashboard } from '../src/dashboard.js';
import { ProjectDashboardReader } from '../src/dashboard-reader.js';
import { Store } from '../src/store.js';
import { ProjectLedger } from '../src/project.js';
import { repositorySchema, taskSchema, type Task } from '../src/domain.js';

function task(id: string, title: string, purpose: 'execution' | 'intake' = 'execution', resources: Task['resources'] = []) {
  const now = Date.now();
  return taskSchema.parse({ id, sourceId: id + ':source', source: { kind: 'manual', message: {
    id: id + ':message', chatId: 'chat:' + id, senderId: 'owner', text: title, attachments: [], createdAt: now, chatType: 'group',
  } }, purpose, contextDirectory: '/tmp/' + id, resources, status: 'running', reason: null,
  prompt: title, promptHash: id, skillPath: null, chatId: 'chat:' + id, threadId: 'thread:' + id, turnId: 'turn:' + id,
  executionStatus: 'running', lastHandledTurnId: null, requests: [], recovery: { attempts: 0, nextAttemptAt: null, lastError: null, interruptedTurnId: null, lastUserInputSeq: null }, createdAt: now, updatedAt: now });
}

test('dashboard resource DTO keeps project card repositories usable by the client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-resource-dto-'));
  const store = new Store(root);
  const worker = task('worker', 'Implement dashboard', 'execution', [{
    id: 'worker-repository', kind: 'git-worktree',
    repository: repositorySchema.parse({ name: 'example/project', path: '/tmp/source', baseBranch: 'main' }),
    branch: 'agent-loop/worker', workspace: '/tmp/worker-workspace',
  }]);
  const coordinator = task('coordinator', 'Coordinate release');
  store.transaction(() => {
    store.saveTask(coordinator); store.saveTask(worker);
    const ledger = new ProjectLedger(store);
    ledger.create({ id: 'project-a', name: 'Project A', directory: root, repositories: [], instructions: '' }, coordinator.id);
    ledger.addMember('project-a', worker.id, 'worker');
  });
  const dashboard = await startDashboard({ dataDir: root, port: 0 });
  t.after(async () => { await dashboard.close(); store.close(); await rm(root, { recursive: true, force: true }); });

  const projects = await (await fetch(dashboard.url + '/api/projects')).json();
  const projectTask = projects[0].tasks.find((item: { id: string }) => item.id === worker.id);
  assert.ok(projectTask);
  assert.deepEqual(projectTask.resources, [{ repository: 'example/project', workspace: '/tmp/worker-workspace' }]);
  assert.equal(typeof projectTask.resources[0].repository, 'string');
  assert.doesNotThrow(() => projectTask.resources[0].repository.toLowerCase());

  const snapshot = await (await fetch(dashboard.url + '/api/snapshot')).json();
  const projectSnapshotTask = snapshot.projects[0].tasks.find((item: { id: string }) => item.id === worker.id);
  assert.ok(projectSnapshotTask);
  assert.deepEqual(projectSnapshotTask.resources, [{ repository: 'example/project', workspace: '/tmp/worker-workspace' }]);
  const snapshotTask = snapshot.tasks.find((item: { id: string }) => item.id === worker.id);
  assert.ok(snapshotTask);
  assert.deepEqual(snapshotTask.resources, [{ repository: 'example/project', workspace: '/tmp/worker-workspace' }]);
});

test('project dashboard uses ledger membership, reports, and redacted task events', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-coordinator-'));
  const store = new Store(root);
  const coordinator = task('coordinator', 'Coordinate release');
  const worker = task('worker', 'Implement dashboard');
  const secondWorker = task('second-worker', 'Verify dashboard');
  const intake = task('intake', 'Routed request', 'intake');
  const foreign = task('foreign', 'Other project');
  store.transaction(() => {
    for (const value of [coordinator, worker, secondWorker, intake, foreign]) store.saveTask(value);
    const ledger = new ProjectLedger(store);
    ledger.create({ id: 'project-a', name: 'Project A', directory: root, repositories: [], instructions: '' }, coordinator.id);
    ledger.addMember('project-a', worker.id, 'worker');
    ledger.addMember('project-a', secondWorker.id, 'worker');
    store.setMeta('project-intake-route:' + intake.id, JSON.stringify({ projectId: 'project-a', coordinatorTaskId: coordinator.id }));
    const report = { id: 'report', chatId: 'chat:' + coordinator.id, senderId: 'runtime:project', text: 'Worker worker update. Added the reader.', attachments: [], createdAt: Date.now(), chatType: 'group' as const };
    store.receive(coordinator.id, report, 'source', { kind: 'agent', projectId: 'project-a', taskId: worker.id, eventId: 'report:worker:update', category: 'update', currentStep: 'Reader', nextStep: 'Run tests', blockers: [], evidence: ['test/dashboard-coordinator.test.ts'] });
    store.recordExecutionEvent(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'agent', kind: 'agent_message', label: 'Agent', text: 'Visible progress', createdAt: Date.now() });
    store.recordExecutionEvent(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'tool', kind: 'tool_end', label: '命令 · completed · exit 0', text: '$ npm test', createdAt: Date.now() });
    store.recordExecutionEvent(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'legacy-tool', kind: 'tool_end', label: '命令 · completed · exit 0', text: '$ npm test\nSECRET_OUTPUT', createdAt: Date.now() });
    store.recordExecutionEvent(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'tool', kind: 'tool_output', label: '工具输出', text: 'SECRET_OUTPUT', createdAt: Date.now() });
    for (let index = 0; index < 501; index++) store.recordExecutionEvent(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'legacy-tool-' + index, kind: 'tool_output', label: '工具输出', text: 'OLD_OUTPUT_' + index, createdAt: Date.now() });
    store.recordExecutionEvent(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'after-gap', kind: 'agent_message', label: '最终回答', text: 'VISIBLE_AFTER_GAP', createdAt: Date.now() });
    store.receive(worker.id, { id: 'long-input', chatId: worker.chatId!, senderId: 'owner', text: 'x'.repeat(40_000), attachments: [], createdAt: Date.now(), chatType: 'group' }, 'user');
  });
  const dashboard = await startDashboard({ dataDir: root, port: 0 });
  t.after(async () => { await dashboard.close(); store.close(); await rm(root, { recursive: true, force: true }); });

  const projects = await (await fetch(dashboard.url + '/api/projects')).json();
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0].tasks.map((item: { id: string; role: string }) => [item.id, item.role]).sort(), [
    ['coordinator', 'coordinator'], ['worker', 'worker'], ['second-worker', 'worker'], ['intake', 'intake'],
  ].sort());
  assert.equal(projects[0].tasks.some((item: { id: string }) => item.id === 'foreign'), false);
  const workerCard = projects[0].tasks.find((item: { id: string }) => item.id === worker.id);
  assert.equal(workerCard.latestReport.currentStep, 'Reader');
  assert.match(workerCard.latestActivity.text, /VISIBLE_AFTER_GAP/);

  const detail = await (await fetch(dashboard.url + '/api/tasks/' + worker.id)).json();
  assert.equal(detail.projectId, 'project-a');
  assert.equal(detail.reports[0].nextStep, 'Run tests');
  assert.equal(detail.inputs.find((input: { id: string }) => input.id === 'long-input').text.length, 32_770);
  assert.equal(detail.events.some((event: { kind: string }) => event.kind === 'tool_output'), false);
  assert.equal(detail.timeline.some((event: { type: string }) => event.type === 'INPUT'), true);
  assert.equal(detail.timeline.some((event: { type: string }) => event.type === 'NARRATIVE'), true);
  assert.equal(detail.timeline.some((event: { type: string }) => event.type === 'TOOL_CALL'), true);
  assert.equal(detail.timeline.some((event: { type: string }) => event.type === 'EVIDENCE'), true);
  assert.equal(detail.timeline.some((event: { type: string }) => event.type === 'OUTPUT'), true);
  assert.equal(detail.timeline.some((event: { type: string }) => event.type === 'WAITING'), false);
  assert.doesNotMatch(JSON.stringify(detail.timeline), /tool_output|SECRET_OUTPUT/);
  assert.doesNotMatch(JSON.stringify(detail), /SECRET_OUTPUT/);
  assert.match(JSON.stringify(detail), /VISIBLE_AFTER_GAP/);

  const reader = new ProjectDashboardReader(store);
  const hiddenStart = store.executionEvents(worker.id).find(event => event.itemId === 'legacy-tool-0')?.seq;
  assert.ok(hiddenStart);
  const firstPage = reader.events(worker.id, hiddenStart - 1);
  assert.equal(firstPage.events.some(event => event.text === 'VISIBLE_AFTER_GAP'), true);

  const controller = new AbortController();
  const stream = await fetch(dashboard.url + '/api/events?taskId=' + worker.id, { signal: controller.signal });
  const streamReader = stream.body!.getReader(); let streamText = '';
  for (let attempt = 0; attempt < 5 && !streamText.includes('VISIBLE_AFTER_GAP'); attempt++) {
    const chunk = await streamReader.read(); streamText += new TextDecoder().decode(chunk.value);
  }
  controller.abort();
  assert.doesNotMatch(streamText, /tool_output|SECRET_OUTPUT/);
  assert.match(streamText, /VISIBLE_AFTER_GAP/);
});
