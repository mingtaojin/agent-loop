import { ExecutionFixture } from './execution-fixture.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDashboard } from '../src/dashboard.js';
import { ProjectDashboardReader, type ProjectDashboard, type ProjectTaskCard } from '../src/dashboard-reader.js';
import { Store } from '../src/store.js';
import { ProjectLedger } from '../src/project.js';
import { repositorySchema, taskSchema, type Task } from '../src/domain.js';
import { taskCloseoutSchema } from '../src/task-closeout.js';

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
  const store = new Store(root); const source = new ExecutionFixture();
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
  const dashboard = await startDashboard({ execution: source.execution, dataDir: root, port: 0 });
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

test('overview retains every explicit coordinator, open task state and formal completion outcome', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-overview-lifecycle-'));
  const store = new Store(root), source = new ExecutionFixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const coordinator = { ...task('coordinator', 'Coordinator A'), status: 'idle', executionStatus: 'idle' } satisfies Task;
  const empty = { ...task('empty-coordinator', 'Coordinator B'), status: 'paused', executionStatus: 'unknown' } satisfies Task;
  const states = [
    { id: 'pending', status: 'pending', executionStatus: 'unbound' },
    { id: 'running', status: 'running', executionStatus: 'running' },
    { id: 'idle', status: 'idle', executionStatus: 'idle' },
    { id: 'paused', status: 'paused', executionStatus: 'interrupted' },
    { id: 'failed', status: 'failed', executionStatus: 'failed' },
    { id: 'turn-complete', status: 'idle', executionStatus: 'completed' },
    { id: 'unknown', status: 'idle', executionStatus: 'unknown' },
  ] satisfies Pick<Task, 'id' | 'status' | 'executionStatus'>[];
  const ledger = new ProjectLedger(store);
  store.saveTask(coordinator); store.saveTask(empty);
  ledger.create({ id: 'project-a', name: 'Project A', directory: root, repositories: [], instructions: '' }, coordinator.id);
  ledger.create({ id: 'project-b', name: 'Project B', directory: root, repositories: [], instructions: '' }, empty.id);
  for (const state of states) {
    store.saveTask({ ...task(state.id, state.id), ...state });
    ledger.addMember('project-a', state.id, 'worker');
  }
  for (const outcome of ['delivered', 'terminated'] as const) {
    const value = task(outcome, outcome); store.saveTask(value); ledger.addMember('project-a', value.id, 'worker');
    store.setMeta('task-closeout:' + value.id, JSON.stringify(taskCloseoutSchema.parse({ taskId: value.id, projectId: 'project-a',
      lifecycle: { kind: 'completed', outcome, summary: outcome + ' fact', deliveryReferences: [outcome + ' reference'], at: 20, operationId: 'closeout-' + outcome }, scopes: [], operations: [], predecessorTaskId: null })));
  }
  store.saveTask(task('unassociated', 'Same directory, no membership'));
  const dashboard = await startDashboard({ execution: source.execution, dataDir: root, port: 0, host: '127.0.0.1' });
  t.after(() => dashboard.close());
  const snapshot: { tasks: ProjectTaskCard[]; projects: ProjectDashboard[] } = await (await fetch(dashboard.url + '/api/snapshot')).json();
  assert.deepEqual(snapshot.projects.map(project => project.coordinatorTaskId).sort(), [coordinator.id, empty.id].sort());
  assert.deepEqual(snapshot.projects.find(project => project.id === 'project-b')?.tasks.map(value => value.id), [empty.id]);
  const project = snapshot.projects.find(project => project.id === 'project-a'); assert.ok(project);
  for (const state of states) {
    const card: ProjectTaskCard | undefined = project.tasks.find(value => value.id === state.id); assert.ok(card);
    assert.equal(card.status, state.status); assert.equal(card.executionStatus, state.executionStatus);
    assert.deepEqual(card.lifecycle, { kind: 'open' });
    assert.deepEqual(snapshot.tasks.find(value => value.id === card.id), card);
  }
  for (const outcome of ['delivered', 'terminated'] as const) {
    const card: ProjectTaskCard | undefined = project.tasks.find(value => value.id === outcome); assert.ok(card?.lifecycle.kind === 'completed');
    assert.equal(card.lifecycle.outcome, outcome); assert.equal(card.lifecycle.at, 20);
    const detail = await (await fetch(dashboard.url + '/api/tasks/' + outcome)).json();
    assert.deepEqual(detail.task.lifecycle, card.lifecycle);
  }
  const unassociated = snapshot.tasks.find(value => value.id === 'unassociated'); assert.ok(unassociated);
  assert.equal(unassociated.projectId, null); assert.equal(unassociated.role, null);
  assert.equal(snapshot.projects.some(value => value.tasks.some(card => card.id === unassociated.id)), false);
  assert.deepEqual(source.reads.sort(), ['thread:delivered', 'thread:terminated'].sort());
});

test('work summaries use published current Thread events, reports, reasons and no record without inventing times', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-work-summary-'));
  const store = new Store(root), source = new ExecutionFixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const coordinator = task('coordinator', 'Coordinator'); store.saveTask(coordinator);
  const ledger = new ProjectLedger(store);
  ledger.create({ id: 'project-a', name: 'Project A', directory: root, repositories: [], instructions: '' }, coordinator.id);
  const workers = ['live', 'report', 'reason', 'empty', 'historical', 'plain-report'].map(id => task(id, id));
  for (const worker of workers) { store.saveTask(worker); ledger.addMember('project-a', worker.id, 'worker'); }
  const historical = workers.find(worker => worker.id === 'historical'); assert.ok(historical?.threadId);
  source.publish(historical.id, { threadId: historical.threadId, turnId: 'old-turn', itemId: 'history', kind: 'agent_message', label: 'Agent', text: 'Canonical history only', createdAt: 10 });
  source.restart();
  for (const id of ['live', 'report', 'plain-report']) store.receive(coordinator.id, {
    id: 'report-' + id, chatId: coordinator.chatId!, chatType: 'group', senderId: 'runtime:project', text: id + ' report body', attachments: [], createdAt: 15,
  }, 'source', { kind: 'agent', projectId: 'project-a', taskId: id, eventId: 'report:' + id, category: 'update',
    ...(id === 'plain-report' ? {} : { currentStep: 'Review reader', nextStep: 'Verify browser', blockers: ['Waiting on review'], evidence: ['PR reference'] }) });
  const live = store.task('live'); live.status = 'paused'; live.reason = 'Operator pause'; live.updatedAt = 9000; store.saveTask(live);
  const reason = store.task('reason'); reason.reason = 'Needs input'; reason.updatedAt = 8000; store.saveTask(reason);
  source.publish('live', { threadId: live.threadId!, turnId: live.turnId, itemId: 'live', kind: 'tool_end', label: '命令 · completed', text: '$ npm test\nPRIVATE_OUTPUT', createdAt: 21 });
  source.publish('report', { threadId: 'previous-thread', turnId: 'previous-turn', itemId: 'old', kind: 'agent_message', label: 'Agent', text: 'Obsolete Thread event', createdAt: 99 });
  const reader = new ProjectDashboardReader(store, source.execution);
  const card = (id: string) => { const result = reader.overview().tasks.find(value => value.id === id); assert.ok(result); return result; };
  assert.deepEqual(source.reads, []);
  const liveCard = card('live'); assert.equal(liveCard.workSummary.kind, 'event');
  if (liveCard.workSummary.kind === 'event') {
    assert.equal(liveCard.workSummary.event.createdAt, 21);
    assert.equal(liveCard.workSummary.event.text, '$ npm test');
  }
  assert.equal(liveCard.status, 'paused'); assert.equal(liveCard.waitingReason, 'Operator pause');
  assert.equal(liveCard.latestReport?.nextStep, 'Verify browser');
  assert.deepEqual(liveCard.latestReport?.blockers, ['Waiting on review']);
  assert.deepEqual(liveCard.latestReport?.evidence, ['PR reference']);
  assert.equal(card('report').workSummary.kind, 'report'); assert.equal(card('report').latestActivity, null);
  const plain = card('plain-report').workSummary; assert.equal(plain.kind, 'report');
  if (plain.kind === 'report') { assert.equal(plain.report.text, 'plain-report report body'); assert.equal(plain.report.currentStep, undefined); assert.equal(plain.report.createdAt, 15); }
  assert.deepEqual(card('reason').workSummary, { kind: 'waiting', text: 'Needs input', createdAt: null });
  assert.deepEqual(card('empty').workSummary, { kind: 'no-record' });
  assert.deepEqual(card('historical').workSummary, { kind: 'no-record' });
  const detail = await reader.taskDetail(historical.id); assert.ok(detail);
  assert.match(JSON.stringify(detail.timeline), /Canonical history only/);
  assert.deepEqual(card('historical').workSummary, { kind: 'no-record' });
  assert.equal(card('historical').latestActivity, null);
  const rebound = store.task('live'); rebound.threadId = 'replacement'; store.saveTask(rebound);
  assert.equal(card('live').workSummary.kind, 'report');
  source.execution.reset();
  assert.equal(card('live').workSummary.kind, 'report');
  assert.deepEqual(source.reads, [historical.threadId]);
});

test('project dashboard uses ledger membership, reports, and redacted task events', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-coordinator-'));
  const store = new Store(root); const source = new ExecutionFixture();
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
    store.receive(coordinator.id, report, 'source', { kind: 'agent', projectId: 'project-a', taskId: worker.id, eventId: 'report:worker:update', category: 'update', routing: 'final', escalation: undefined, sources: [{ messageId: 'owner-message', chatId: worker.chatId!, senderId: 'owner' }], currentStep: 'Reader', nextStep: 'Run tests', blockers: [], evidence: ['test/dashboard-coordinator.test.ts'] });
    source.publish(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'agent', kind: 'agent_message', label: 'Agent', text: 'Visible progress', createdAt: Date.now() });
    source.publish(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'tool', kind: 'tool_end', label: '命令 · completed · exit 0', text: '$ npm test', createdAt: Date.now() });
    source.publish(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'legacy-tool', kind: 'tool_end', label: '命令 · completed · exit 0', text: '$ npm test\nSECRET_OUTPUT', createdAt: Date.now() });
    source.publish(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'tool', kind: 'tool_output', label: '工具输出', text: 'SECRET_OUTPUT', createdAt: Date.now() });
    for (let index = 0; index < 501; index++) source.publish(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'legacy-tool-' + index, kind: 'tool_output', label: '工具输出', text: 'OLD_OUTPUT_' + index, createdAt: Date.now() });
    source.publish(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'after-gap', kind: 'agent_message', label: '最终回答', text: 'VISIBLE_AFTER_GAP', createdAt: Date.now() });
    store.receive(worker.id, { id: 'long-input', chatId: worker.chatId!, senderId: 'owner', text: 'x'.repeat(40_000), attachments: [], createdAt: Date.now(), chatType: 'group' }, 'user');
  });
  const dashboard = await startDashboard({ execution: source.execution, dataDir: root, port: 0 });
  t.after(async () => { await dashboard.close(); store.close(); await rm(root, { recursive: true, force: true }); });

  const projects = await (await fetch(dashboard.url + '/api/projects')).json();
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0].tasks.map((item: { id: string; role: string }) => [item.id, item.role]).sort(), [
    ['coordinator', 'coordinator'], ['worker', 'worker'], ['second-worker', 'worker'], ['intake', 'intake'],
  ].sort());
  assert.equal(projects[0].tasks.some((item: { id: string }) => item.id === 'foreign'), false);
  const workerCard = projects[0].tasks.find((item: { id: string }) => item.id === worker.id);
  assert.equal(workerCard.latestReport.currentStep, 'Reader');
  assert.equal(workerCard.latestReport.routing, 'final');
  assert.deepEqual(workerCard.latestReport.sources, [{ messageId: 'owner-message', chatId: worker.chatId, senderId: 'owner' }]);
  assert.match(workerCard.latestActivity.text, /VISIBLE_AFTER_GAP/);

  const detail = await (await fetch(dashboard.url + '/api/tasks/' + worker.id)).json();
  assert.equal(detail.projectId, 'project-a');
  assert.equal(detail.reports[0].nextStep, 'Run tests');
  assert.equal(detail.reports[0].routing, 'final');
  assert.deepEqual(detail.reports[0].sources, [{ messageId: 'owner-message', chatId: worker.chatId, senderId: 'owner' }]);
  assert.equal(detail.inputs.find((input: { id: string }) => input.id === 'long-input').text.length, 32_770);
  assert.equal(detail.timeline.some((event: { kind: string }) => event.kind === 'tool_output'), false);
  assert.equal(detail.timeline.some((event: { type: string }) => event.type === 'INPUT'), true);
  assert.equal(detail.timeline.some((event: { type: string }) => event.type === 'NARRATIVE'), true);
  assert.equal(detail.timeline.some((event: { type: string }) => event.type === 'TOOL_CALL'), true);
  assert.equal(detail.timeline.some((event: { type: string }) => event.type === 'EVIDENCE'), true);
  assert.equal(detail.timeline.some((event: { type: string }) => event.type === 'OUTPUT'), true);
  assert.equal(detail.timeline.some((event: { type: string }) => event.type === 'WAITING'), false);
  assert.doesNotMatch(JSON.stringify(detail.timeline), /tool_output|SECRET_OUTPUT/);
  assert.doesNotMatch(JSON.stringify(detail), /SECRET_OUTPUT/);
  assert.match(JSON.stringify(detail), /VISIBLE_AFTER_GAP/);

  const controller = new AbortController();
  const cursor = source.execution.cursor;
  source.publish(worker.id, { threadId: worker.threadId!, turnId: worker.turnId, itemId: 'new', kind: 'agent_message', label: 'Agent', text: 'VISIBLE_AFTER_GAP', createdAt: Date.now() });
  const stream = await fetch(dashboard.url + '/api/events?taskId=' + worker.id + '&after=' + encodeURIComponent(cursor), { signal: controller.signal });
  const streamReader = stream.body!.getReader(); let streamText = '';
  for (let attempt = 0; attempt < 5 && !streamText.includes('VISIBLE_AFTER_GAP'); attempt++) {
    const chunk = await streamReader.read(); streamText += new TextDecoder().decode(chunk.value);
  }
  controller.abort();
  assert.doesNotMatch(streamText, /tool_output|SECRET_OUTPUT/);
  assert.match(streamText, /VISIBLE_AFTER_GAP/);
});
