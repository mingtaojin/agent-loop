import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectCatalog } from '../src/project-catalog.js';
import { discoverProjects } from '../src/project-discovery.js';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { configSchema } from '../src/config.js';
import { taskSchema, criteriaSchema } from '../src/domain.js';
import { AgentLoop } from '../src/loop.js';
import { WorkspaceProvider } from '../src/workspace.js';
import type { WorkspacePort } from '../src/ports.js';
import { projectConfigSchema, type ProjectAction } from '../src/project.js';
import { CodexFake, FeishuFake, GitHubFake, issue } from './fakes.js';
import { seedSavedIntake } from './saved-intake.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'intake-claim-'));
  await mkdir(join(root, 'app')); await mkdir(join(root, 'other'));
  const config = configSchema.parse({ dataDir: join(root, 'data'), feishu: { userOpenId: 'owner' }, projects: [
    { id: 'app', name: 'App', directory: join(root, 'app'), repositories: [] },
    { id: 'other', name: 'Other', directory: join(root, 'other'), repositories: [{ name: 'owner/other', labelsAny: ['bug'] }] },
  ] });
  const codex = new CodexFake(), feishu = new FeishuFake();
  const ports = { codex, feishu, github: new GitHubFake(), workspace: { async ensure(input: Parameters<WorkspacePort['ensure']>[0]) {
    if (input.kind !== 'project-directory') throw new Error('Only the fixture project is available');
    return input.directory;
  }, async head() { return 'fixture-head'; } } };
  let loop = new AgentLoop(config, ports);
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  await loop.collect(); await loop.tick();
  const coordinator = (projectId = 'app') => loop.store.task(loop.projects.ledger.project(projectId)!.coordinatorTaskId);
  const saved = (id = 'saved-private') => seedSavedIntake(loop, { id, chatId: 'historical-private', chatType: 'p2p', senderId: 'owner',
    text: 'PRIVATE ORIGINAL MATERIAL', attachments: [{ key: 'old-file', kind: 'file', name: 'private.log' }], createdAt: Date.now() });
  async function decision(id: string, projectId = 'app') {
    const caller = coordinator(projectId); assert.ok(caller.chatId);
    await loop.receive({ id, chatId: caller.chatId, chatType: 'group', senderId: 'owner', text: 'This identified saved request belongs to this project.', attachments: [], createdAt: Date.now() });
    return id;
  }
  return { root, config, ports, codex, feishu, saved, coordinator, decision, get loop() { return loop; },
    async reopen() { await loop.close(); loop = new AgentLoop(config, ports); await loop.projects.ensure(); } };
}

test('empty discovery initializes only explicitly registered project groups', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-bootstrap-')); const projectRoot = join(root, 'projects');
  await mkdir(join(projectRoot, 'app'), { recursive: true }); await mkdir(join(projectRoot, 'other'));
  const config = configSchema.parse({ dataDir: join(root, 'data'), engineering: { projectRoot }, feishu: { userOpenId: 'owner' } });
  const feishu = new FeishuFake(), codex = new CodexFake();
  const ports = { feishu, codex, github: new GitHubFake(), workspace: { async ensure() { throw new Error('No worker should acquire resources'); }, async head() { return 'unused'; } } };
  let loop = new AgentLoop(config, ports); t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  await loop.collect(); await loop.tick();
  assert.equal(feishu.groups.size, 0); assert.equal(loop.tasks().length, 0); assert.equal(codex.created.length, 0);
  await loop.close();
  config.projects.push(projectConfigSchema.parse({ id: 'app', name: 'App', directory: join(projectRoot, 'app'), repositories: [] }));
  loop = new AgentLoop(config, ports); await loop.collect(); await loop.tick();
  assert.equal(loop.tasks().length, 1); assert.equal(feishu.groups.size, 1);
  const coordinator = loop.tasks()[0]; assert.ok(coordinator);
  assert.equal(loop.projects.ledger.membership(coordinator.id)?.role, 'coordinator');
});

test('claim preserves the saved Task and all materials without execution, then explicit dispatch promotes it once', async t => {
  const f = await fixture(t), task = f.saved(), coordinator = f.coordinator();
  f.feishu.resources.set('old-file', Buffer.from('saved evidence\n'));
  const messageId = await f.decision('claim-owner');
  const before = f.loop.store.task(task.id), inputs = f.loop.store.inputs(task.id), threads = f.codex.created.length;
  const action = { action: 'claim_intake', requestId: 'claim-one', taskId: task.id, messageId } satisfies ProjectAction;
  const receipt = await f.loop.projectAction(coordinator.id, action);
  assert.deepEqual(f.loop.store.task(task.id), before); assert.deepEqual(f.loop.store.inputs(task.id), inputs);
  assert.equal(f.codex.created.length, threads); assert.equal(f.codex.replies.length, 0); assert.equal(f.feishu.groups.size, 2);
  assert.deepEqual(await f.loop.projectAction(coordinator.id, action), receipt);
  await assert.rejects(f.loop.projectAction(coordinator.id, { ...action, messageId: 'changed' }), /content|conflict/i);
  await f.loop.tick();
  assert.equal(f.loop.store.task(task.id).threadId, null); assert.equal(f.loop.store.task(task.id).chatId, null);
  assert.ok(f.loop.store.meta(`project-intake-material:${task.id}`));
  const delegated = { action: 'dispatch', requestId: 'dispatch-claimed', intakeTaskId: task.id, role: 'worker', prompt: 'Preserve original scope.' } satisfies ProjectAction;
  assert.deepEqual(await f.loop.projectAction(coordinator.id, delegated), { taskId: task.id });
  await f.loop.tick();
  const worker = f.loop.store.task(task.id); assert.ok(worker.threadId); assert.equal(worker.chatId, null);
  assert.deepEqual(worker.source, before.source); assert.equal(worker.sourceId, before.sourceId);
  assert.deepEqual(f.loop.store.inputs(task.id).map(input => input.message), inputs.map(input => input.message));
  assert.deepEqual(await f.loop.projectAction(coordinator.id, delegated), { taskId: task.id });
  assert.equal(f.codex.created.length, threads + 1); assert.equal(f.feishu.groups.size, 2);
});

test('competing project claims commit one immutable route and expose no original material through discovery', async t => {
  const f = await fixture(t), task = f.saved();
  const appMessage = await f.decision('app-claim'), otherMessage = await f.decision('other-claim', 'other');
  f.saved('second-unassigned');
  const page = z.object({ items: z.array(z.object({ taskId: z.string(), sourceKind: z.string(), status: z.string(), createdAt: z.number() }).strict()), nextOffset: z.number().nullable() });
  const result = page.parse(await f.loop.projectAction(f.coordinator().id, { action: 'status', section: 'unassigned_intakes', limit: 1 }));
  assert.deepEqual(result.items.map(item => item.taskId), [task.id]); assert.equal(result.nextOffset, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private.log|historical-private|materialPath/);
  const outcomes = await Promise.allSettled([
    f.loop.projectAction(f.coordinator().id, { action: 'claim_intake', requestId: 'app-race', taskId: task.id, messageId: appMessage }),
    f.loop.projectAction(f.coordinator('other').id, { action: 'claim_intake', requestId: 'other-race', taskId: task.id, messageId: otherMessage }),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
  assert.ok(f.loop.projects.intakeRoute(task.id)); assert.equal(f.loop.store.task(task.id).purpose, 'intake');
  assert.equal(f.loop.projects.ledger.membership(task.id), null); assert.equal(f.loop.store.inputs(task.id).length, 1);
});

test('claim route, source decision and receipt roll back together and survive reopening after success', async t => {
  const f = await fixture(t), task = f.saved(), callerId = f.coordinator().id;
  const action = { action: 'claim_intake', requestId: 'atomic-claim', taskId: task.id, messageId: await f.decision('atomic-owner') } satisfies ProjectAction;
  const save = f.loop.projects.ledger.saveReceipt.bind(f.loop.projects.ledger);
  f.loop.projects.ledger.saveReceipt = () => { throw new Error('Receipt persistence failed'); };
  await assert.rejects(f.loop.projectAction(callerId, action), /Receipt persistence/);
  assert.equal(f.loop.projects.intakeRoute(task.id), null); assert.equal(f.loop.store.meta(`project-intake-claim:${task.id}`), null);
  assert.equal(f.loop.store.meta(`project-action-intent:${JSON.stringify(['app', callerId, action.requestId])}`), null);
  assert.equal(f.loop.store.task(task.id).purpose, 'intake'); assert.equal(f.loop.store.inputs(task.id).length, 1);
  f.loop.projects.ledger.saveReceipt = save;
  const receipt = await f.loop.projectAction(callerId, action); await f.reopen();
  assert.deepEqual(await f.loop.projectAction(callerId, action), receipt);
  assert.deepEqual(f.loop.projects.intakeRoute(task.id), { projectId: 'app', coordinatorTaskId: callerId });
  assert.equal(f.loop.store.task(task.id).threadId, null);
});

test('claims reject non-owner decisions, Worker callers, paused, bound and foreign-catalog requests', async t => {
  const f = await fixture(t), caller = f.coordinator(), task = f.saved();
  const messageId = await f.decision('authorized-claim');
  const base = { action: 'claim_intake', taskId: task.id, messageId } satisfies Omit<Extract<ProjectAction, { action: 'claim_intake' }>, 'requestId'>;
  await assert.rejects(f.loop.projectAction(caller.id, { ...base, requestId: 'no-decision', messageId: 'not-a-user-message' }));
  await assert.rejects(f.loop.projectAction(f.coordinator('other').id, { ...base, requestId: 'wrong-group' }));
  const paused = taskSchema.parse({ ...task, status: 'paused', reason: 'Operator paused' }); f.loop.store.saveTask(paused);
  await assert.rejects(f.loop.projectAction(caller.id, { ...base, requestId: 'paused' }), /paused/);
  assert.deepEqual(f.loop.store.task(task.id), paused);
  f.loop.store.saveTask(taskSchema.parse({ ...task, threadId: 'saved-formal' }));
  await assert.rejects(f.loop.projectAction(caller.id, { ...base, requestId: 'formal' }));
  f.loop.store.saveTask(task);
  const foreign = f.saved('foreign-source'); f.loop.store.saveTask(taskSchema.parse({ ...foreign, sourceId: 'foreign-issue',
    source: { kind: 'github', issue: issue(99, { repository: 'owner/other' }), repository: { name: 'owner/other', criteria: criteriaSchema.parse({}) }, collectionReason: 'saved' } }));
  await assert.rejects(f.loop.projectAction(caller.id, { ...base, taskId: foreign.id, requestId: 'foreign' }));
  const page = await f.loop.projectAction(caller.id, { action: 'status', section: 'unassigned_intakes' });
  assert.ok(!JSON.stringify(page).includes(foreign.id));
  const receipt = z.object({ taskId: z.string() }).parse(await f.loop.projectAction(caller.id,
    { action: 'dispatch', requestId: 'fixture-worker', prompt: 'Do not execute external actions.', role: 'worker' }));
  await assert.rejects(f.loop.projectAction(receipt.taskId, { ...base, requestId: 'worker-claim' }), /coordinator/i);
  await assert.rejects(f.loop.projectAction(receipt.taskId, { action: 'status', section: 'unassigned_intakes' }), /coordinator/i);
  assert.equal(f.loop.projects.intakeRoute(task.id), null);
});

test('a concurrent open action cannot reuse a claiming request identity for different content', async t => {
  const f = await fixture(t), caller = f.coordinator();
  const worker = z.object({ taskId: z.string() }).parse(await f.loop.projectAction(caller.id,
    { action: 'dispatch', requestId: 'existing-worker', prompt: 'Only preserve this fixture.', role: 'worker' }));
  const task = f.saved(), messageId = await f.decision('collision-owner');
  const outcomes = await Promise.allSettled([
    f.loop.projectAction(caller.id, { action: 'claim_intake', requestId: 'same-identity', taskId: task.id, messageId }),
    f.loop.projectAction(caller.id, { action: 'open_group', requestId: 'same-identity', taskId: worker.taskId }),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
  const saved = f.loop.projects.ledger.receipt('app', caller.id, 'same-identity'); assert.ok(saved);
  assert.equal(f.loop.projects.intakeRoute(task.id) !== null, outcomes[0]?.status === 'fulfilled');
  assert.equal(saved.fingerprint, f.loop.store.meta(`project-action-intent:${JSON.stringify(['app', caller.id, 'same-identity'])}`));
});

test('claiming an unbound GitHub intake delivers original material without changing repository-wide ownership', async t => {
  const f = await fixture(t), caller = f.coordinator(), task = f.saved('saved-github');
  f.feishu.resources.set('old-file', Buffer.from('historical evidence\n'));
  const repository = configSchema.parse({ feishu: { userOpenId: 'owner' }, repositories: [{ name: 'owner/unbound', criteria: {} }] }).repositories[0]; assert.ok(repository);
  f.config.repositories.push(repository);
  const source = { kind: 'github' as const, issue: issue(909, { repository: 'owner/unbound' }), repository, collectionReason: 'historical request' };
  f.loop.store.saveTask(taskSchema.parse({ ...task, sourceId: source.issue.id, source }));
  const bindings = f.loop.store.meta('project-catalog:repositories');
  const messageId = await f.decision('github-owner');
  await f.loop.projectAction(caller.id, { action: 'claim_intake', requestId: 'claim-github', taskId: task.id, messageId });
  await f.loop.tick();
  assert.ok(f.loop.store.meta(`project-intake-material:${task.id}`));
  assert.equal(f.loop.store.task(task.id).purpose, 'intake'); assert.equal(f.loop.store.task(task.id).threadId, null);
  assert.deepEqual(f.loop.store.task(task.id).source, source);
  assert.equal(f.loop.store.meta('project-catalog:repositories'), bindings);
  assert.ok(f.loop.store.inputs(caller.id).some(input => input.provenance.kind === 'agent'
    && input.provenance.taskId === task.id && input.provenance.category === 'intake_request'));
});


test('a hard process exit inside claim cannot commit its route without its receipt', async t => {
  const f = await fixture(t), task = f.saved('hard-crash'), callerId = f.coordinator().id;
  const action = { action: 'claim_intake', requestId: 'crash-claim', taskId: task.id, messageId: await f.decision('crash-owner') } satisfies ProjectAction;
  const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
  const script = `
    import { AgentLoop } from ${JSON.stringify(new URL('../src/loop.' + extension, import.meta.url).href)};
    import { Store } from ${JSON.stringify(new URL('../src/store.' + extension, import.meta.url).href)};
    import { CodexFake, FeishuFake, GitHubFake } from ${JSON.stringify(new URL('./fakes.' + extension, import.meta.url).href)};
    class CrashStore extends Store {
      setMeta(key, value) {
        super.setMeta(key, value);
        if (key === ${JSON.stringify('project-intake-claim:' + task.id)}) process.exit(42);
      }
    }
    const config = ${JSON.stringify(f.config)};
    const loop = new AgentLoop(config, { codex: new CodexFake(), feishu: new FeishuFake(), github: new GitHubFake(),
      workspace: { async ensure() { throw new Error('Claim must not execute'); }, async head() { return 'unused'; } } }, new CrashStore(config.dataDir));
    await loop.projects.ensure();
    await loop.projectAction(${JSON.stringify(callerId)}, ${JSON.stringify(action)});
    throw new Error('Expected process exit inside transaction');
  `;
  await f.loop.close();
  const child = spawn(process.execPath, [...(extension === 'ts' ? ['--import', import.meta.resolve('tsx')] : []), '--input-type=module', '--eval', script],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
  assert.equal(code, 42, stderr);
  await f.reopen();
  assert.equal(f.loop.projects.intakeRoute(task.id), null);
  assert.equal(f.loop.store.meta(`project-intake-claim:${task.id}`), null);
  assert.equal(f.loop.projects.ledger.receipt('app', callerId, action.requestId), null);
  const receipt = await f.loop.projectAction(callerId, action); await f.reopen();
  assert.deepEqual(await f.loop.projectAction(callerId, action), receipt);
  assert.equal(f.loop.store.task(task.id).threadId, null);
});


test('foreign repository ownership cannot be hidden by a saved workspace inside the claimant directory', async t => {
  const f = await fixture(t), task = f.saved('foreign-resource');
  const other = f.loop.projects.projectConfig('other'); assert.ok(other);
  const app = f.loop.projects.projectConfig('app'); assert.ok(app);
  const workspace = join(app.directory, 'saved-foreign-worktree');
  f.loop.store.saveTask(taskSchema.parse({ ...task, resources: [{ id: 'foreign', kind: 'git-worktree', branch: 'saved-foreign', workspace,
    repository: { name: 'owner/other', path: other.directory, baseBranch: 'main', criteria: criteriaSchema.parse({}) } }] }));
  const messageId = await f.decision('foreign-resource-owner');
  await assert.rejects(f.loop.projectAction(f.coordinator().id, { action: 'claim_intake', requestId: 'foreign-resource-claim', taskId: task.id, messageId }));
  const discovery = await f.loop.projectAction(f.coordinator().id, { action: 'status', section: 'unassigned_intakes' });
  assert.ok(!JSON.stringify(discovery).includes(task.id));
  assert.equal(f.loop.projects.intakeRoute(task.id), null);
});

test('a late project question cannot overwrite the workspace selected by an intervening claim and dispatch', async t => {
  const f = await fixture(t), task = f.saved('late-question');
  f.feishu.resources.set('old-file', Buffer.from('historical evidence\n'));
  const messageId = await f.decision('late-question-owner');
  f.codex.selectionResults.push({ kind: 'question', question: 'Old selection question' });
  let entered = () => {}, release = () => {};
  const started = new Promise<void>(done => { entered = done; }), gate = new Promise<void>(done => { release = done; });
  const resolve = f.loop.projects.resolveSelection.bind(f.loop.projects);
  f.loop.projects.resolveSelection = async (...args) => { entered(); await gate; return resolve(...args); };
  const pending = f.loop.tick();
  try {
    await started;
    await f.loop.projectAction(f.coordinator().id, { action: 'claim_intake', requestId: 'late-claim', taskId: task.id, messageId });
    await f.loop.projectAction(f.coordinator().id, { action: 'dispatch', requestId: 'late-dispatch', intakeTaskId: task.id, role: 'worker', prompt: 'Use the confirmed project and original scope.' });
    const delegated = f.loop.store.task(task.id); assert.equal(delegated.workspaceSelection.kind, 'selected');
    release(); await pending; await f.loop.tick();
    const worker = f.loop.store.task(task.id);
    assert.equal(worker.purpose, 'execution'); assert.deepEqual(worker.workspaceSelection, delegated.workspaceSelection);
    assert.ok(worker.threadId); assert.notEqual(worker.status, 'failed'); assert.equal(worker.reason, null);
  } finally { release(); await pending; }
});

test('a stale selection cannot bind its repository after a competing claim has committed another route', async t => {
  const f = await fixture(t), task = f.saved('binding-race');
  f.feishu.resources.set('old-file', Buffer.from('historical evidence\n'));
  const projectRoot = join(f.root, 'discovered'); await mkdir(join(projectRoot, 'candidate'), { recursive: true });
  f.config.engineering = { projectRoot };
  const repository = configSchema.parse({ feishu: { userOpenId: 'owner' }, repositories: [{ name: 'owner/unbound', criteria: {} }] }).repositories[0]; assert.ok(repository);
  f.config.repositories.push(repository);
  f.loop.store.saveTask(taskSchema.parse({ ...task, sourceId: 'binding-race-source', source: {
    kind: 'github', issue: issue(808, { repository: 'owner/unbound' }), repository, collectionReason: 'historical' } }));
  const candidate = (await discoverProjects(projectRoot))[0]; assert.ok(candidate);
  f.codex.selectionResults.push({ kind: 'project', projectId: candidate.id, reason: 'Old selection' });
  const messageId = await f.decision('binding-owner');
  let entered = () => {}, release = () => {};
  const started = new Promise<void>(done => { entered = done; }), gate = new Promise<void>(done => { release = done; });
  const bind = ProjectCatalog.prototype.bindRepository;
  t.mock.method(ProjectCatalog.prototype, 'bindRepository', async function(this: ProjectCatalog, ...args: Parameters<ProjectCatalog['bindRepository']>) {
    entered(); await gate; return bind.apply(this, args);
  });
  const pending = f.loop.tick();
  try {
    await started;
    await f.loop.projectAction(f.coordinator().id, { action: 'claim_intake', requestId: 'binding-claim', taskId: task.id, messageId });
    release(); await pending;
    assert.deepEqual(f.loop.projects.intakeRoute(task.id), { projectId: 'app', coordinatorTaskId: f.coordinator().id });
    assert.ok(!f.loop.store.meta('project-catalog:repositories')?.includes('owner/unbound'));
    await f.loop.tick();
    assert.ok(f.loop.store.meta(`project-intake-material:${task.id}`));
    assert.equal(f.loop.store.task(task.id).threadId, null); assert.notEqual(f.loop.store.task(task.id).status, 'failed');
  } finally { release(); await pending; }
});

for (const initialStatus of ['running', 'paused'] satisfies Array<'running' | 'paused'>) test(`an existing ${initialStatus} Thread is adopted without resuming an operator or migration pause`, async t => {
  const f = await fixture(t), task = f.saved('legacy-migration');
  f.feishu.resources.set('old-file', Buffer.from('saved evidence\n'));
  const app = f.loop.projects.projectConfig('app'); assert.ok(app);
  const threadId = await f.codex.createThread({ cwd: app.directory, instructions: 'Saved legacy instructions.' });
  const turnId = await f.codex.startTurn({ threadId, deliveryId: 'legacy-start', input: [{ kind: 'text', text: 'Saved running discussion.' }] });
  const legacy = taskSchema.parse({ ...task, purpose: 'legacy', threadId, turnId, status: initialStatus, reason: initialStatus === 'paused' ? 'Operator paused' : null, executionStatus: 'running' });
  f.loop.store.saveTask(legacy);
  f.codex.selectionResults.push({ kind: 'project', projectId: 'coordinated:app', reason: 'Confirm old Thread project.' });
  const starts = f.codex.starts.length;
  await f.loop.tick();
  assert.deepEqual(f.loop.projects.ledger.membership(task.id), { projectId: 'app', role: 'worker' });
  const adopted = f.loop.store.task(task.id);
  assert.equal(adopted.threadId, threadId); assert.equal(adopted.turnId, turnId); assert.equal(adopted.status, 'paused');
  if (initialStatus === 'paused') assert.equal(adopted.reason, 'Operator paused');
  assert.equal(f.codex.starts.length, starts); assert.ok(f.codex.interrupts.some(input => input.threadId === threadId));
  assert.deepEqual(adopted.resources, legacy.resources); assert.deepEqual(adopted.source, legacy.source);
});

test('an unresolved project question cannot erase Operator pause or resume a retained Thread on adoption', async t => {
  const f = await fixture(t), task = f.saved('paused-question');
  f.feishu.resources.set('old-file', Buffer.from('saved evidence\n'));
  const app = f.loop.projects.projectConfig('app'); assert.ok(app);
  const threadId = await f.codex.createThread({ cwd: app.directory, instructions: 'Saved paused legacy instructions.' });
  const turnId = await f.codex.startTurn({ threadId, deliveryId: 'legacy-paused-start', input: [{ kind: 'text', text: 'Saved legacy turn.' }] });
  f.loop.store.saveTask(taskSchema.parse({ ...task, purpose: 'legacy', threadId, turnId, status: 'paused', reason: 'Operator paused',
    legacy: { status: 'paused', prUrl: null }, executionStatus: 'running' }));
  f.codex.selectionResults.push({ kind: 'question', question: 'Which project owns this old task?' },
    { kind: 'project', projectId: 'coordinated:app', reason: 'Confirmed existing project.' });
  const starts = f.codex.starts.length;
  await f.loop.tick();
  const pauseReason = f.loop.store.task(task.id).reason;
  f.loop.store.receive(task.id, { id: 'saved-project-answer', text: 'Use the original App project.', chatId: '', chatType: 'group',
    senderId: 'owner', attachments: [], createdAt: Date.now() }, 'user', undefined, 'workspace-selection');
  await f.loop.tick();
  assert.equal(f.codex.starts.length, starts, 'Migration and project clarification must not resume an Operator-paused Thread');
  assert.equal(pauseReason, 'Operator paused');
  const adopted = f.loop.store.task(task.id);
  assert.equal(adopted.status, 'paused'); assert.equal(adopted.reason, 'Operator paused'); assert.equal(adopted.threadId, threadId);
  assert.deepEqual(f.loop.projects.ledger.membership(task.id), { projectId: 'app', role: 'worker' });
  assert.ok(f.loop.store.meta(`project-intake-question:${task.id}`)?.includes('Which project owns this old task?'));
});

for (const oldChoice of ['question', 'other-project']) test(`queued Operator pause and group input survive a stale ${oldChoice} selection result`, async t => {
  const f = await fixture(t), task = f.saved(`queued-${oldChoice}`);
  f.feishu.resources.set('old-file', Buffer.from('saved evidence\n'));
  const app = f.loop.projects.projectConfig('app'); assert.ok(app);
  const chatId = await f.feishu.ensureGroup({ taskId: task.id, title: 'Saved legacy group', sourceUrl: '' });
  const threadId = await f.codex.createThread({ cwd: app.directory, instructions: 'Saved legacy instructions.' });
  const turnId = await f.codex.startTurn({ threadId, deliveryId: 'queued-start', input: [{ kind: 'text', text: 'Saved old turn.' }] });
  f.loop.store.saveTask(taskSchema.parse({ ...task, purpose: 'legacy', chatId, threadId, turnId, status: 'running',
    reason: null, legacy: { status: 'paused', prUrl: null }, executionStatus: 'running' }));
  f.codex.selectionResults.push(oldChoice === 'question' ? { kind: 'question', question: 'Obsolete project question' }
    : { kind: 'project', projectId: 'coordinated:other', reason: 'Obsolete project choice' },
    { kind: 'project', projectId: 'coordinated:app', reason: 'Current input belongs to App' });
  let entered = () => {}, release = () => {};
  const started = new Promise<void>(done => { entered = done; }), gate = new Promise<void>(done => { release = done; });
  const resolve = f.loop.projects.resolveSelection.bind(f.loop.projects); let first = true;
  f.loop.projects.resolveSelection = async (...args) => {
    if (first) { first = false; entered(); await gate; }
    return resolve(...args);
  };
  const starts = f.codex.starts.filter(call => call.threadId === threadId).length;
  const steers = f.codex.steers.filter(call => call.threadId === threadId).length;
  const replies = f.codex.replies.filter(call => call.request.threadId === threadId).length, threads = f.codex.created.length;
  const pending = f.loop.tick();
  let pausing: Promise<void> | undefined, incoming: Promise<void> | undefined;
  try {
    await started;
    pausing = f.loop.control(task.id, 'pause');
    incoming = f.loop.receive({ id: `queued-owner-${oldChoice}`, chatId, chatType: 'group', senderId: 'owner',
      text: 'Keep the App scope and preserve local work.', attachments: [], createdAt: Date.now() });
    release(); await Promise.all([pending, pausing, incoming]); await f.loop.tick();
    const adopted = f.loop.store.task(task.id);
    assert.deepEqual(f.loop.projects.ledger.membership(task.id), { projectId: 'app', role: 'worker' });
    assert.equal(adopted.status, 'paused'); assert.equal(adopted.reason, 'Operator paused');
    assert.equal(adopted.threadId, threadId); assert.equal(adopted.turnId, turnId); assert.equal(adopted.chatId, chatId);
    assert.equal(f.codex.starts.filter(call => call.threadId === threadId).length, starts);
    assert.equal(f.codex.steers.filter(call => call.threadId === threadId).length, steers);
    assert.equal(f.codex.replies.filter(call => call.request.threadId === threadId).length, replies); assert.equal(f.codex.created.length, threads);
    assert.deepEqual(adopted.source, task.source); assert.deepEqual(adopted.resources, task.resources);
    const held = f.loop.store.inputs(task.id).find(input => input.id === `queued-owner-${oldChoice}`);
    assert.ok(held); assert.equal(held.status, 'held');
    assert.equal(held.message.text, 'Keep the App scope and preserve local work.');
    assert.ok(!f.loop.store.meta(`project-intake-question:${task.id}`)?.includes('Obsolete project question'));
  } finally { release(); await Promise.allSettled([pending, pausing, incoming].filter(item => item !== undefined)); }
});


function latch() {
  let release = () => {};
  const promise = new Promise<void>(done => { release = done; });
  return { promise, release };
}

test('independent handoff race: a valid claim during acceptIntake awaits must not fail the intake', async t => {
  const f = await fixture(t), task = f.saved('claim-during-material');
  f.feishu.resources.set('old-file', Buffer.from('original bytes'));
  const decision = await f.decision('takeover-other', 'other');
  f.codex.selectionResults.push({ kind: 'project', projectId: 'coordinated:app', reason: 'Old selection App' });
  const entered = latch(), held = latch();
  let accepting = false, once = true;
  const accept = f.loop.projects.acceptIntake.bind(f.loop.projects);
  f.loop.projects.acceptIntake = async (...args) => {
    if (args[0] === task.id) accepting = true;
    return accept(...args);
  };
  const byId = ProjectCatalog.prototype.byId;
  t.mock.method(ProjectCatalog.prototype, 'byId', async function(this: ProjectCatalog, id: string) {
    if (accepting && id === 'app' && once) { once = false; entered.release(); await held.promise; }
    return byId.call(this, id);
  });
  const pending = f.loop.tick(); await entered.promise;
  try {
    await f.loop.projectAction(f.coordinator('other').id, {
      action: 'claim_intake', requestId: 'other-claims-late', taskId: task.id, messageId: decision,
    });
  } finally { held.release(); }
  await pending; await f.loop.tick();
  const after = f.loop.store.task(task.id);
  assert.notEqual(after.status, 'failed', 'successful owner-authorized claim must reconcile stale selected-project handoff');
  assert.equal(f.loop.projects.intakeRoute(task.id)?.projectId, 'other');
  const delivered = (projectId: string) => f.loop.store.inputs(f.coordinator(projectId).id)
    .filter(input => input.provenance.kind === 'agent' && input.provenance.taskId === task.id && input.provenance.category === 'intake_request');
  assert.equal(delivered('app').length, 0);
  assert.equal(delivered('other').length, 1);
  const [event] = delivered('other'); assert.ok(event);
  assert.match(event.message.text, /PRIVATE ORIGINAL MATERIAL/);
});

test('independent handoff race: a late owner restriction must reach the coordinator under a distinct material identity', async t => {
  const f = await fixture(t), task = f.saved('late-material-restriction');
  f.feishu.resources.set('old-file', Buffer.from('old bytes'));
  const chatId = await f.feishu.ensureGroup({ taskId: task.id, title: 'saved old group', sourceUrl: '' });
  f.loop.store.saveTask({ ...task, chatId });
  f.codex.selectionResults.push({ kind: 'project', projectId: 'coordinated:app', reason: 'App owns it' });
  const entered = latch(), held = latch();
  let accepting = false, once = true;
  const accept = f.loop.projects.acceptIntake.bind(f.loop.projects);
  f.loop.projects.acceptIntake = async (...args) => {
    if (args[0] === task.id) accepting = true;
    return accept(...args);
  };
  const byId = ProjectCatalog.prototype.byId;
  t.mock.method(ProjectCatalog.prototype, 'byId', async function(this: ProjectCatalog, id: string) {
    if (accepting && id === 'app' && once) { once = false; entered.release(); await held.promise; }
    return byId.call(this, id);
  });
  const pending = f.loop.tick(); await entered.promise;
  const message = { id: 'late-scope', chatId, chatType: 'group' as const, senderId: 'owner',
    text: 'LATE_SCOPE_DO_NOT_DEPLOY', attachments: [], createdAt: Date.now() };
  const incoming = f.loop.receive(message);
  assert.ok(f.loop.store.inputs(task.id).some(input => input.id === message.id));
  held.release(); await Promise.all([pending, incoming]); await f.loop.tick();
  const events = f.loop.store.inputs(f.coordinator().id).filter(input => input.provenance.kind === 'agent'
    && input.provenance.taskId === task.id && input.provenance.category === 'intake_request');
  assert.ok(events.some(input => input.message.text.includes(message.text)),
    'late owner scope must be delivered, not deduplicated under an older payload');
  assert.equal(events.length, 1, 'stale material must not reserve the complete payload identity');
  assert.deepEqual(f.loop.store.inputs(task.id).find(input => input.id === message.id)?.message, message);
});

test('independent threadless legacy pause keeps the Operator reason when existing selected project permits coordinator handoff', async t => {
  const f = await fixture(t), saved = f.saved('threadless-legacy-pause');
  f.feishu.resources.set('old-file', Buffer.from('retained evidence'));
  const app = f.loop.projects.projectConfig('app'); assert.ok(app);
  const project = { kind: 'project' as const, id: 'coordinated:app', name: 'App', entryPath: app.directory, canonicalPath: app.directory };
  const original = taskSchema.parse({ ...saved, purpose: 'legacy', status: 'paused', reason: 'Operator paused',
    legacy: { status: 'paused', prUrl: null }, workspaceSelection: { kind: 'selected', temporaryThreadId: 'saved-selection',
      inputIds: [], choice: { kind: 'project', projectId: project.id, reason: 'Original project', project } } });
  f.loop.store.saveTask(original);
  const coordinators = new Set([f.coordinator().threadId, f.coordinator('other').threadId]);
  const effects = () => ({ created: f.codex.created.length,
    starts: f.codex.starts.filter(call => !coordinators.has(call.threadId)).length,
    steers: f.codex.steers.filter(call => !coordinators.has(call.threadId)).length,
    replies: f.codex.replies.filter(call => !coordinators.has(call.request.threadId)).length,
    approvals: f.codex.approvals.filter(call => !coordinators.has(call.request.threadId)).length });
  const before = effects();
  await f.loop.tick(); await f.loop.tick();
  const after = f.loop.store.task(saved.id);
  assert.equal(after.status, 'paused'); assert.equal(after.threadId, null);
  assert.deepEqual(effects(), before, 'the paused request creates or executes no Worker; normal coordinator delivery is allowed');
  assert.deepEqual(after.source, original.source); assert.deepEqual(after.resources, original.resources);
  assert.equal(after.reason, 'Operator paused', 'coordinator handoff must not erase the Operator pause marker');
  assert.equal(f.loop.projects.intakeRoute(saved.id)?.projectId, 'app');
  const events = f.loop.store.inputs(f.coordinator().id).filter(input => input.provenance.kind === 'agent'
    && input.provenance.taskId === saved.id && input.provenance.category === 'intake_request');
  assert.equal(events.length, 1);
  const [event] = events; assert.ok(event); assert.match(event.message.text, /PRIVATE ORIGINAL MATERIAL/);
  await assert.rejects(f.loop.projectAction(f.coordinator().id, { action: 'dispatch', requestId: 'paused-handoff-dispatch',
    intakeTaskId: saved.id, role: 'worker', prompt: 'Must not execute a paused request.' }), /paused/);
});

async function retainedResource(t: TestContext, options: { changed: boolean; status: 'idle' | 'paused' }) {
  const f = await fixture(t), saved = f.saved('unassigned-retained-resource');
  f.feishu.resources.set('old-file', Buffer.from('original pending material'));
  const entry = join(f.root, 'saved-workspace'), wrong = join(f.root, 'different-workspace');
  await mkdir(entry); await mkdir(wrong);
  const canonical = await realpath(entry);
  const project = { kind: 'project' as const, id: 'retained-project', name: 'Retained project', entryPath: entry, canonicalPath: canonical };
  const resource = { kind: 'project' as const, id: 'retained-resource', project, workspace: canonical };
  const threadId = await f.codex.createThread({ cwd: canonical, instructions: 'Saved original Thread.' });
  const turnId = await f.codex.startTurn({ threadId, deliveryId: 'retained-initial', input: [{ kind: 'text', text: 'Original turn.' }] });
  f.codex.complete(threadId, null);
  const original = taskSchema.parse({ ...saved, purpose: 'legacy', threadId, turnId, status: options.status,
    reason: options.status === 'paused' ? 'Operator paused' : null, executionStatus: 'completed', resources: [resource],
    workspaceSelection: { kind: 'selected', temporaryThreadId: 'retained-choice', inputIds: [],
      choice: { kind: 'project', projectId: project.id, project, reason: 'Saved original workspace' } } });
  f.loop.store.saveTask(original);
  if (options.changed) { await rm(entry, { recursive: true }); await symlink(wrong, entry); }
  const actual = await realpath(entry);
  if (options.changed) assert.notEqual(actual, canonical);
  else assert.equal(actual, canonical);
  const provider = new WorkspaceProvider(f.config.dataDir);
  let validations = 0;
  f.loop.ports.workspace = { ensure: async input => {
    if (input.resourceId === resource.id) validations++;
    return provider.ensure(input);
  }, head: workspace => provider.head(workspace) };
  f.codex.selectionResults.push({ kind: 'project', projectId: 'coordinated:app', reason: 'Confirm App ownership of saved work' });
  const starts = () => f.codex.starts.filter(call => call.threadId === threadId).length;
  return { ...f, original, threadId, starts, get validations() { return validations; } };
}

test('independent migration recovery validates preserved project resources before a newly adopted idle Thread can execute', async t => {
  const f = await retainedResource(t, { changed: true, status: 'idle' }), before = f.starts();
  await f.loop.recover();
  const after = f.loop.store.task(f.original.id);
  assert.equal(after.threadId, f.threadId); assert.deepEqual(after.resources, f.original.resources);
  assert.equal(f.starts(), before, 'unresolved legacy resources must be validated before selection-based adoption can execute pending input');
  assert.ok(f.validations > 0, 'actual WorkspaceProvider must validate the retained resource');
});

test('selection during a normal tick validates retained resources before adopting and executing an old Thread', async t => {
  const f = await retainedResource(t, { changed: true, status: 'idle' }), before = f.starts();
  await f.loop.tick(); await f.loop.tick();
  assert.equal(f.starts(), before); assert.ok(f.validations > 0);
  assert.equal(f.loop.projects.ledger.membership(f.original.id), null);
  assert.deepEqual(f.loop.store.task(f.original.id).resources, f.original.resources);
});

test('valid retained resources still permit selection, same-Thread adoption and pending input execution', async t => {
  const f = await retainedResource(t, { changed: false, status: 'idle' }), before = f.starts();
  await f.loop.recover();
  const after = f.loop.store.task(f.original.id);
  assert.equal(after.threadId, f.threadId); assert.deepEqual(after.resources, f.original.resources);
  assert.equal(f.starts(), before + 1); assert.ok(f.validations > 0);
  assert.deepEqual(f.loop.projects.ledger.membership(after.id), { projectId: 'app', role: 'worker' });
});

test('failed retained resource validation preserves Operator pause and records the recovery error separately', async t => {
  const f = await retainedResource(t, { changed: true, status: 'paused' }), before = f.starts();
  await f.loop.recover();
  const after = f.loop.store.task(f.original.id);
  assert.equal(after.status, 'paused'); assert.equal(after.reason, 'Operator paused');
  assert.match(after.recovery.lastError ?? '', /association changed/);
  assert.equal(f.starts(), before); assert.ok(f.validations > 0);
  assert.equal(after.threadId, f.threadId); assert.deepEqual(after.resources, f.original.resources);
});

test('explicit resume validates unassigned saved resources before clearing Operator pause', async t => {
  const f = await retainedResource(t, { changed: true, status: 'paused' }), before = f.starts();
  await assert.rejects(f.loop.control(f.original.id, 'resume'), /association changed/);
  const after = f.loop.store.task(f.original.id);
  assert.equal(after.status, 'paused'); assert.equal(after.reason, 'Operator paused');
  assert.equal(f.starts(), before); assert.ok(f.validations > 0);
  assert.equal(after.threadId, f.threadId); assert.deepEqual(after.resources, f.original.resources);
});
