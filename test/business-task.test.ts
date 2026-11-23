import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import { Store } from '../src/store.js';
import { businessTaskSchema } from '../src/business-task.js';
import { projectActionSchema } from '../src/project.js';
import { submissionSchema, submissionSourceId } from '../src/domain.js';
import { CodexFake, FeishuFake, GitHubFake, issue } from './fakes.js';
import { seedSavedIntake } from './saved-intake.js';
import { testExecution } from './test-config.js';
import { startDashboard } from '../src/dashboard.js';
import type { DashboardOverview } from '../src/dashboard-reader.js';
import { ExecutionFixture } from './execution-fixture.js';

const created = z.object({ businessTask: businessTaskSchema });
const dispatched = z.object({ taskId: z.string(), businessTaskId: businessTaskSchema.shape.id });
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'business-task-')));
  const config = configSchema.parse({ execution: testExecution, dataDir: root, feishu: { userOpenId: 'owner' }, projects: [
    { id: 'app', name: 'Application', directory: root, repositories: [{ name: 'example/app', labelsAny: ['coordinate'] }] },
    { id: 'other', name: 'Other', directory: root, repositories: [] },
  ] });
  const codex = new CodexFake(), feishu = new FeishuFake(), github = new GitHubFake();
  const ports = { codex, feishu, github, workspace: { async ensure() { return root; }, async head() { return 'fixture-head'; } } };
  let loop = new AgentLoop(config, ports, new Store(root));
  await loop.projects.ensure();
  const coordinator = (project = 'app') => {
    const state = loop.projects.ledger.project(project); assert.ok(state); return state.coordinatorTaskId;
  };
  const action = (value: unknown, caller = coordinator()) => loop.projectAction(caller, projectActionSchema.parse(value));
  const original = (id = 'owner-goal', text = 'Build the original dashboard goal') => {
    const message = { id, text, chatId: 'project-chat', senderId: 'owner', chatType: 'group' as const, attachments: [], createdAt: 100 };
    loop.store.receive(coordinator(), message, 'user'); return message;
  };
  const create = async (requestId = 'register', inputId = 'owner-goal') => created.parse(await action({ action: 'create_business_task', requestId, source: { kind: 'input', inputId } })).businessTask;
  const dispatch = async (businessTaskId: string, requestId: string, extra = {}) => dispatched.parse(await action({ action: 'dispatch', requestId, businessTaskId,
    prompt: `Work ${requestId}`, execution: testExecution.worker, ...extra }));
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  return { root, config, codex, feishu, github, coordinator, action, original, create, dispatch, get loop() { return loop; },
    async restart() { await loop.close(); loop = new AgentLoop(config, ports, new Store(root)); await loop.projects.ensure(); } };
}

test('one original request owns independent Workers and an explicit versioned business lifecycle', async t => {
  const f = await fixture(t); f.original();
  const business = await f.create();
  assert.equal(business.source.kind, 'manual');
  const one = await f.dispatch(business.id, 'one'), two = await f.dispatch(business.id, 'two');
  assert.notEqual(one.taskId, two.taskId);
  assert.deepEqual(await f.dispatch(business.id, 'one'), one);
  assert.equal(f.loop.projects.businessTasks.get('app', business.id).version, 3);
  const source = f.loop.projects.businessTasks.get('app', business.id).source;
  f.original('later-goal', 'A separate original request');
  const other = await f.create('register-other', 'later-goal'); assert.notEqual(other.id, business.id);
  await assert.rejects(f.action({ action: 'assign_business_task', requestId: 'conflict', businessTaskId: other.id, taskId: one.taskId }), /already assigned/);
  const archived = created.parse(await f.action({ action: 'set_business_task_lifecycle', requestId: 'archive', businessTaskId: business.id,
    expectedVersion: 3, lifecycle: { kind: 'historical', outcome: 'delivered', summary: 'User accepted this business goal' } })).businessTask;
  assert.equal(archived.lifecycle.kind, 'historical');
  assert.equal(f.loop.closeout.read(one.taskId).lifecycle.kind, 'open');
  assert.deepEqual(await f.dispatch(business.id, 'one'), one);
  await assert.rejects(f.dispatch(business.id, 'after-archive'), /historical/);
  const dedup = await f.create('same-source'); assert.equal(dedup.id, business.id); assert.equal(dedup.lifecycle.kind, 'historical');
  await assert.rejects(f.action({ action: 'set_business_task_lifecycle', requestId: 'stale', businessTaskId: business.id,
    expectedVersion: 3, lifecycle: { kind: 'active', summary: 'Reopen' } }), /version conflict/);
  await f.action({ action: 'set_business_task_lifecycle', requestId: 'reopen', businessTaskId: business.id,
    expectedVersion: 4, lifecycle: { kind: 'active', summary: 'User requested another iteration' } });
  const three = await f.dispatch(business.id, 'three');
  await f.restart();
  const restored = f.loop.projects.businessTasks.get('app', business.id);
  assert.deepEqual(restored.source, source); assert.deepEqual(restored.workerTaskIds, [one.taskId, two.taskId, three.taskId]);
  assert.deepEqual(restored.history.map(event => event.version), [1, 2, 3, 4, 5, 6]);
  await assert.rejects(f.dispatch(business.id, 'one', { prompt: 'different' }), /different content/);
});

test('source selectors preserve canonical original identity and reject synthetic, discarded and foreign inputs', async t => {
  const f = await fixture(t); const message = f.original(); const business = await f.create();
  const intake = seedSavedIntake(f.loop, message);
  await f.loop.projects.acceptIntake(intake.id, 'app', { text: message.text, version: 'fixture-source-v1' });
  const fromTask = created.parse(await f.action({ action: 'create_business_task', requestId: 'by-task', source: { kind: 'task-source', taskId: intake.id } })).businessTask;
  assert.equal(fromTask.id, business.id);
  const worker = await f.dispatch(business.id, 'generated');
  for (const taskId of [worker.taskId, f.coordinator()]) await assert.rejects(f.action({ action: 'create_business_task', requestId: 'bad:' + taskId,
    source: { kind: 'task-source', taskId } }), /not an original CLI/);
  await assert.rejects(f.action({ action: 'create_business_task', requestId: 'foreign', source: { kind: 'input', inputId: message.id } }, f.coordinator('other')), /available original/);
  f.original('dropped'); f.loop.store.markInput('dropped', 'dropped');
  await assert.rejects(f.create('dropped-register', 'dropped'), /available original/);
  for (const [id, provenance] of [
    ['reminder', { kind: 'reminder', projectId: 'app', taskId: f.coordinator(), reminderId: 'wake', dueAt: 1 }],
    ['recovery', { kind: 'recovery', previousTurnId: 'old' }],
    ['wrapper', { kind: 'agent', projectId: 'app', taskId: intake.id, eventId: 'intake', category: 'intake' }],
    ['native', { kind: 'project_decision_card', projectId: 'app', cardId: 'card', requestId: 'native', ownerId: 'owner', value: 'approve' }],
  ] as const) {
    f.loop.store.receive(f.coordinator(), { ...message, id }, 'source', provenance);
    await assert.rejects(f.create('reject:' + id, id), /not an original/);
  }
  const cli = seedSavedIntake(f.loop, { ...message, id: 'cli-intake' });
  const submission = submissionSchema.parse({ requestId: 'f98dfc47-f6ba-41ee-a412-5a68db4e6b6e', prompt: 'Original CLI goal' });
  cli.source = { kind: 'cli', ...submission, submittedAt: 110 }; cli.sourceId = submissionSourceId(submission.requestId); f.loop.store.saveTask(cli);
  await f.loop.projects.acceptIntake(cli.id, 'app', { text: submission.prompt, version: 'cli-v1' });
  const cliBusiness = created.parse(await f.action({ action: 'create_business_task', requestId: 'cli-goal', source: { kind: 'task-source', taskId: cli.id } })).businessTask;
  assert.equal(cliBusiness.source.kind, 'cli');
  await f.action({ action: 'record', requestId: 'goal-record', key: 'goal', text: 'Coordinator authored a bounded goal', expectedVersion: 0, scope: { kind: 'coordinator' } });
  const record = created.parse(await f.action({ action: 'create_business_task', requestId: 'record-goal', source: { kind: 'project-record', version: 1, key: 'goal' } })).businessTask;
  assert.equal(record.source.kind, 'coordinator-goal');
  await f.loop.projectCall(worker.taskId, { tool: 'send_agent_message', arguments: { requestId: 'received-goal', taskId: f.coordinator(), text: 'Worker proposes a follow-up goal' } });
  const input = f.loop.store.inputs(f.coordinator()).find(input => input.provenance.kind === 'agent_message'); assert.ok(input);
  assert.equal((await f.create('received', input.id)).source.kind, 'received-goal');
});

test('business writes are coordinator-only and Worker status exposes only its own assignment', async t => {
  const f = await fixture(t); f.original('private', 'Private coordinator goal text'); const business = await f.create('private-register', 'private');
  const one = await f.dispatch(business.id, 'one'), two = await f.dispatch(business.id, 'two');
  for (const action of [
    { action: 'create_business_task', requestId: 'worker-create', source: { kind: 'input', inputId: 'private' } },
    { action: 'assign_business_task', requestId: 'worker-assign', businessTaskId: business.id, taskId: two.taskId },
    { action: 'set_business_task_lifecycle', requestId: 'worker-archive', businessTaskId: business.id, expectedVersion: 3, lifecycle: { kind: 'historical', outcome: 'delivered', summary: 'No' } },
    { action: 'dispatch', requestId: 'worker-dispatch', businessTaskId: business.id, prompt: 'No', execution: testExecution.worker },
  ]) await assert.rejects(f.action(action, one.taskId), /Only the coordinator/);
  const view = await f.action({ action: 'status', section: 'business_tasks' }, one.taskId);
  assert.ok(JSON.stringify(view).includes(one.taskId));
  for (const hidden of [two.taskId, 'Private coordinator goal text', 'owner-goal']) assert.ok(!JSON.stringify(view).includes(hidden));
  await assert.rejects(f.action({ action: 'assign_business_task', requestId: 'coordinator-row', businessTaskId: business.id, taskId: f.coordinator() }), /Worker in this project/);
  await assert.rejects(f.action({ action: 'dispatch', requestId: 'foreign', businessTaskId: business.id, prompt: 'No', execution: testExecution.worker }, f.coordinator('other')), /not owned/);
});

test('new issue dispatch creates multiple Workers while legacy issue dispatch still reuses its first Worker', async t => {
  const f = await fixture(t);
  const source = issue(42, { id: 'github-node-42', repository: 'example/app', labels: ['coordinate'] });
  f.loop.projects.ledger.issue('app', source);
  const business = created.parse(await f.action({ action: 'create_business_task', requestId: 'issue', source: { kind: 'issue', issueId: source.id } })).businessTask;
  const one = await f.dispatch(business.id, 'issue-one'), two = await f.dispatch(business.id, 'issue-two');
  assert.notEqual(one.taskId, two.taskId);
  assert.ok(f.loop.projects.ledger.project('app')?.members.filter(member => [one.taskId, two.taskId].includes(member.taskId)).every(member => member.issueId === source.id));
  const legacy = await f.action({ action: 'dispatch', requestId: 'legacy', issueId: source.id, prompt: 'Legacy request', execution: testExecution.worker });
  assert.deepEqual(legacy, { taskId: one.taskId });
  await assert.rejects(f.dispatch(business.id, 'mismatch', { issueId: 'different' }), /conflicts/);
  f.loop.projects.ledger.issue('app', { ...source, state: 'closed', title: 'Changed upstream title' });
  assert.equal(f.loop.projects.businessTasks.get('app', business.id).lifecycle.kind, 'active');
  assert.equal(created.parse(await f.action({ action: 'create_business_task', requestId: 'closed-dedup', source: { kind: 'issue', issueId: source.id } })).businessTask.title, business.title);
});

test('intake promotion binds exactly once, preserves source and native facts, and later requests create fresh Workers', async t => {
  const f = await fixture(t); const message = f.original(); const business = await f.create();
  const intake = seedSavedIntake(f.loop, { ...message, id: 'different' });
  await f.loop.projects.acceptIntake(intake.id, 'app', { text: message.text, version: 'mismatch-v1' });
  await assert.rejects(f.dispatch(business.id, 'wrong-intake', { intakeTaskId: intake.id }), /source conflicts/);
  const matching = seedSavedIntake(f.loop, message);
  await f.loop.projects.acceptIntake(matching.id, 'app', { text: message.text, version: 'matching-v1' });
  const saved = f.loop.store.task(matching.id), inputs = f.loop.store.inputs(matching.id);
  const promoted = await f.dispatch(business.id, 'promote', { intakeTaskId: matching.id });
  assert.equal(promoted.taskId, matching.id);
  assert.deepEqual(f.loop.store.task(matching.id).source, saved.source); assert.deepEqual(f.loop.store.inputs(matching.id), inputs);
  assert.deepEqual(f.loop.store.task(matching.id).resources, saved.resources);
  assert.deepEqual(await f.dispatch(business.id, 'promote', { intakeTaskId: matching.id }), promoted);
  await assert.rejects(f.dispatch(business.id, 'promote-again', { intakeTaskId: matching.id }), /already been promoted/);
  assert.notEqual((await f.dispatch(business.id, 'fresh-worker')).taskId, matching.id);
});

test('receipt and allocation failures recover the same Task directory and artifact scope after restart', async t => {
  const f = await fixture(t); f.original(); const business = await f.create();
  const originalInitialize = f.loop.closeout.initialize.bind(f.loop.closeout);
  let once = true;
  f.loop.closeout.initialize = async (task, allocationId) => {
    await originalInitialize(task, allocationId);
    if (allocationId && once) { once = false; throw new Error('fixture lost allocation acknowledgement'); }
  };
  await assert.rejects(f.dispatch(business.id, 'recover'), /lost allocation/);
  const before = await readdir(join(f.root, 'tasks'));
  const closeouts = f.loop.store.metadata('task-closeout:');
  const allocated = closeouts.map(row => JSON.parse(row.value)).find(row => row.scopes.some((scope: { allocationRequestId: string | null }) => scope.allocationRequestId?.startsWith('default:')));
  assert.ok(allocated);
  await f.restart();
  const saveReceipt = f.loop.projects.ledger.saveReceipt.bind(f.loop.projects.ledger);
  f.loop.projects.ledger.saveReceipt = (...args) => { saveReceipt(...args); throw new Error('fixture receipt transaction failure'); };
  await assert.rejects(f.dispatch(business.id, 'recover'), /receipt transaction failure/);
  assert.deepEqual(f.loop.projects.businessTasks.get('app', business.id).workerTaskIds, []);
  assert.equal(f.loop.projects.ledger.project('app')?.members.length, 1);
  assert.equal(f.loop.store.tasks().length, 2);
  await f.restart();
  const result = await f.dispatch(business.id, 'recover');
  assert.equal(result.taskId, allocated.taskId);
  assert.deepEqual(await readdir(join(f.root, 'tasks')), before);
  assert.deepEqual(f.loop.closeout.read(result.taskId).scopes, allocated.scopes);
  assert.deepEqual(await readdir(f.loop.store.task(result.taskId).contextDirectory), ['artifacts-default']);
  assert.equal(f.loop.store.inputs(result.taskId).length, 1);
  assert.deepEqual(await f.dispatch(business.id, 'recover'), result);
});

test('business create and lifecycle failures roll back receipt and mutation together', async t => {
  const f = await fixture(t); f.original();
  const save = f.loop.projects.ledger.saveReceipt.bind(f.loop.projects.ledger);
  f.loop.projects.ledger.saveReceipt = (...args) => { save(...args); throw new Error('receipt failed'); };
  await assert.rejects(f.create(), /receipt failed/); assert.deepEqual(f.loop.projects.businessTasks.list('app'), []);
  f.loop.projects.ledger.saveReceipt = save;
  const business = await f.create();
  f.loop.projects.ledger.saveReceipt = (...args) => { save(...args); throw new Error('receipt failed'); };
  const action = { action: 'set_business_task_lifecycle', requestId: 'end', businessTaskId: business.id, expectedVersion: 1,
    lifecycle: { kind: 'historical', outcome: 'terminated', summary: 'Work stopped' } };
  await assert.rejects(f.action(action), /receipt failed/);
  assert.equal(f.loop.projects.businessTasks.get('app', business.id).lifecycle.kind, 'active');
  f.loop.projects.ledger.saveReceipt = save;
  await f.action(action); assert.equal(f.loop.projects.businessTasks.get('app', business.id).lifecycle.kind, 'historical');
});

test('explicit old Worker association preserves Thread, group, resources and native requests', async t => {
  const f = await fixture(t); f.original(); const business = await f.create();
  const receipt = z.object({ taskId: z.string() }).parse(await f.action({ action: 'dispatch', requestId: 'old-worker', prompt: 'Earlier unrelated delegation', execution: testExecution.worker }));
  await f.loop.tick();
  await f.action({ action: 'open_group', requestId: 'old-group', taskId: receipt.taskId });
  const worker = f.loop.store.task(receipt.taskId); assert.ok(worker.threadId && worker.turnId);
  worker.status = 'paused';
  worker.requests = [{ id: 'native', kind: 'approval', prompt: 'Keep pending approval', method: 'item/commandExecution/requestApproval',
    payload: { command: 'fixture' }, threadId: worker.threadId, turnId: worker.turnId, connectionEpoch: 'fixture', isBlocking: true }];
  f.loop.store.saveTask(worker);
  const before = f.loop.store.task(worker.id);
  await f.action({ action: 'assign_business_task', requestId: 'associate-old', businessTaskId: business.id, taskId: worker.id });
  assert.deepEqual(f.loop.store.task(worker.id), before);
  assert.deepEqual(f.loop.projects.businessTasks.get('app', business.id).workerTaskIds, [worker.id]);
  await f.restart();
  await assert.rejects(f.action({ action: 'dispatch', requestId: 'old-worker', prompt: 'Earlier unrelated delegation', execution: testExecution.worker,
    businessTaskId: business.id }), /different content/);
});

test('allocation metadata failure recovers a known artifact directory without creating another', async t => {
  const f = await fixture(t); f.original(); const business = await f.create();
  const setMeta = f.loop.store.setMeta.bind(f.loop.store); let failed = false;
  f.loop.store.setMeta = (key, value) => {
    if (!failed && key.startsWith('task-closeout:') && value.includes('default:')) { failed = true; throw new Error('scope save interrupted'); }
    setMeta(key, value);
  };
  await assert.rejects(f.dispatch(business.id, 'scope-failure'), /scope save interrupted/);
  const directories = await readdir(join(f.root, 'tasks'));
  await f.restart();
  const result = await f.dispatch(business.id, 'scope-failure');
  assert.deepEqual(await readdir(join(f.root, 'tasks')), directories);
  assert.deepEqual(await readdir(f.loop.store.task(result.taskId).contextDirectory), ['artifacts-default']);
  assert.equal(f.loop.closeout.read(result.taskId).scopes.length, 1);
});


test('Runtime registration and multiple dispatches produce one HTTP business card with independent lifecycle', async t => {
  const f = await fixture(t); f.original(); const business = await f.create();
  const one = await f.dispatch(business.id, 'http-one'), two = await f.dispatch(business.id, 'http-two'), three = await f.dispatch(business.id, 'http-three');
  const legacy = z.object({ taskId: z.string() }).parse(await f.action({ action: 'dispatch', requestId: 'legacy-unknown', prompt: 'Preserved legacy work', execution: testExecution.worker }));
  await f.loop.tick();
  const first = f.loop.store.task(one.taskId), second = f.loop.store.task(two.taskId), third = f.loop.store.task(three.taskId);
  assert.ok(first.threadId);
  first.status = 'running'; first.executionStatus = 'running'; f.loop.store.saveTask(first);
  second.status = 'paused'; second.executionStatus = 'interrupted'; second.reason = 'Operator paused'; f.loop.store.saveTask(second);
  third.status = 'idle'; third.executionStatus = 'completed'; f.loop.store.saveTask(third);
  const feed = new ExecutionFixture();
  feed.publish(first.id, { threadId: first.threadId, turnId: first.turnId, itemId: 'visible', kind: 'agent_message', label: 'Progress', text: 'Current visible work '.repeat(30), createdAt: 200 });
  const dashboard = await startDashboard({ dataDir: f.root, port: 0, host: '127.0.0.1', execution: feed.execution });
  t.after(() => dashboard.close());
  const read = async (): Promise<DashboardOverview> => (await fetch(dashboard.url + '/api/snapshot')).json();
  const snapshot = await read();
  assert.equal(snapshot.businessTasks.length, 1); const card = snapshot.businessTasks[0]; assert.ok(card);
  assert.equal(card.id, business.id); assert.equal(card.owner.taskId, f.coordinator());
  assert.deepEqual(card.workers.map(worker => worker.id), [one.taskId, two.taskId, three.taskId]);
  assert.deepEqual(card.counts.taskStatus, { pending: 0, running: 1, idle: 1, paused: 1, failed: 0 });
  assert.deepEqual(card.counts.executionStatus, { unbound: 0, idle: 0, running: 1, completed: 1, interrupted: 1, failed: 0, unknown: 0 });
  assert.deepEqual(card.counts.formalCompletion, { open: 3, delivered: 0, terminated: 0 });
  assert.ok(card.workers.every(worker => worker.role === 'worker' && worker.id !== f.coordinator()));
  assert.equal(card.workers[0]?.summary.kind, 'event'); assert.ok((card.workers[0]?.summary.text.length ?? 0) <= 241);
  assert.equal(card.workers[1]?.summary.kind, 'waiting'); assert.equal(card.workers[2]?.formalCompletion, 'open');
  assert.deepEqual(snapshot.unassociatedWorkers.map(worker => worker.id), [legacy.taskId]);
  assert.equal(snapshot.projects.length, 2); assert.ok(snapshot.projects.some(project => project.coordinatorTaskId === f.coordinator('other')));
  assert.ok(!('status' in card) && !('percentage' in card));
  assert.deepEqual(feed.reads, []);
  const before = { tasks: f.loop.store.tasks(), metadata: f.loop.store.metadata('') };
  feed.unavailable = true;
  const detail = await (await fetch(dashboard.url + '/api/tasks/' + first.id)).json();
  assert.equal(detail.task.id, first.id); assert.equal(detail.history.kind, 'unavailable');
  assert.deepEqual((await read()).businessTasks, snapshot.businessTasks);
  assert.deepEqual({ tasks: f.loop.store.tasks(), metadata: f.loop.store.metadata('') }, before);
  assert.equal((await fetch(dashboard.url + '/api/snapshot', { method: 'POST', body: '{}' })).status, 405);
  await f.action({ action: 'set_business_task_lifecycle', requestId: 'http-archive', businessTaskId: business.id, expectedVersion: 4,
    lifecycle: { kind: 'historical', outcome: 'delivered', summary: 'Business delivery accepted independently' } });
  const archived = await read(); assert.equal(archived.businessTasks[0]?.lifecycle.kind, 'historical');
  assert.deepEqual(archived.businessTasks[0]?.counts, card.counts);
  assert.deepEqual(archived.businessTasks[0]?.workers, card.workers);
});

test('business HTTP rows use live event, report, reason, and no-record facts without reading Threads', async t => {
  const f = await fixture(t); f.original(); const business = await f.create();
  const workers = [];
  for (const id of ['live', 'report', 'reason', 'empty']) workers.push(await f.dispatch(business.id, id));
  await f.loop.tick();
  const feed = new ExecutionFixture();
  for (const [index, worker] of workers.entries()) {
    const task = f.loop.store.task(worker.taskId); assert.ok(task.threadId);
    if (index === 0) feed.publish(task.id, { threadId: task.threadId, turnId: task.turnId, itemId: 'command', kind: 'tool_end', label: '命令 · completed', text: '$ npm test\nRAW_PRIVATE_OUTPUT', createdAt: 20 });
    if (index < 2) f.loop.store.receive(f.coordinator(), { id: 'report:' + task.id, chatId: 'project-chat', senderId: 'runtime:project', chatType: 'group',
      text: 'Full report contains details', attachments: [], createdAt: 15 }, 'source', { kind: 'agent', projectId: 'app', taskId: task.id, eventId: 'report:' + task.id,
      category: 'update', currentStep: 'Current report step', nextStep: 'Next report step' });
    if (index === 2) { task.reason = 'Waiting for an explicit input'; f.loop.store.saveTask(task); }
  }
  const dashboard = await startDashboard({ dataDir: f.root, port: 0, execution: feed.execution }); t.after(() => dashboard.close());
  const snapshot: DashboardOverview = await (await fetch(dashboard.url + '/api/snapshot')).json();
  const rows = snapshot.businessTasks[0]?.workers; assert.ok(rows);
  assert.deepEqual(rows.map(row => row.summary.kind), ['event', 'report', 'waiting', 'no-record']);
  assert.equal(rows[0]?.summary.text, '$ npm test'); assert.equal(rows[0]?.summary.at, 20);
  assert.equal(rows[1]?.summary.text, 'Current report step'); assert.equal(rows[1]?.summary.at, 15);
  assert.equal(rows[2]?.summary.at, null); assert.equal(rows[3]?.summary.text, '');
  assert.ok(!JSON.stringify(rows).includes('RAW_PRIVATE_OUTPUT')); assert.ok(!JSON.stringify(rows).includes('Next report step'));
  assert.deepEqual(feed.reads, []);
});
