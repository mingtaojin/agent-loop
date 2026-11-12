import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { configSchema, type Config } from '../src/config.js';
import { criteriaSchema, taskSchema, type Task } from '../src/domain.js';
import { discoverProjects } from '../src/project-discovery.js';
import { ProjectCatalog } from '../src/project-catalog.js';
import { ProjectRuntime } from '../src/project-runtime.js';
import { Store } from '../src/store.js';
import { issue } from './fakes.js';

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'project-catalog-'));
  const root = await realpath(temporary);
  const engineering = join(root, 'engineering'), alpha = join(engineering, 'alpha'), beta = join(engineering, 'beta');
  await mkdir(alpha, { recursive: true }); await mkdir(beta);
  const config: Config = configSchema.parse({ dataDir: join(root, 'data'), feishu: { userOpenId: 'owner' },
    engineering: { projectRoot: engineering }, projects: [{ id: 'explicit-alpha', name: 'Alpha', directory: alpha,
      repositories: [{ name: 'owner/alpha', labelsAny: ['coordinate'] }] }],
    repositories: [{ name: 'owner/beta', path: beta, baseBranch: 'main', criteria: { assigneesAny: ['alice'] } }],
  });
  let store = new Store(config.dataDir);
  let created = 0;
  function task(id: string, changes: Partial<Task> = {}): Task {
    return taskSchema.parse({ id, sourceId: id,
      source: { kind: 'cli', ...ProjectRuntime.submission(id, 'Original request.'), submittedAt: 1 },
      contextDirectory: join(root, 'task', id), resources: [], status: 'pending', reason: null,
      prompt: 'Original request.', promptHash: 'original', skillPath: null, chatId: null, threadId: null,
      turnId: null, lastHandledTurnId: null, requests: [], createdAt: 1, updatedAt: 1, ...changes });
  }
  const host = {
    async makeTask(sourceId: string, prompt: string) {
      created++;
      return task(`created-${created}`, { sourceId, purpose: 'execution', prompt,
        source: { kind: 'cli', ...ProjectRuntime.submission(sourceId, prompt), submittedAt: 1 } });
    },
    async releaseWorkspace() { throw new Error('Unexpected workspace release'); },
    async control() { throw new Error('Unexpected task control'); },
  };
  let runtime = new ProjectRuntime(config, store, host);
  t.after(async () => { await runtime.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, engineering, alpha, beta, config, task,
    get store() { return store; }, get runtime() { return runtime; }, get created() { return created; },
    async restart() {
      await runtime.close(); store.close(); store = new Store(config.dataDir);
      runtime = new ProjectRuntime(config, store, host); await runtime.ensure();
    },
    events(taskId: string, category: string) {
      return store.inputs(taskId).filter(input => input.provenance.kind === 'agent' && input.provenance.category === category);
    },
    input(taskId: string, id: string, text = 'Original material.') {
      store.receive(taskId, { id, chatId: 'original-chat', chatType: 'group', senderId: 'owner', text, attachments: [], createdAt: 1 });
    },
  };
}

test('catalog uses canonical identities, explicit policy, durable automatic definitions and lazy coordinators', async t => {
  const f = await fixture(t);
  await symlink(f.beta, join(f.engineering, 'beta-alias'));
  const originalRepositories = structuredClone(f.config.repositories);
  const catalog = new ProjectCatalog(f.config, f.store);
  await catalog.refresh();
  assert.equal(catalog.configs.length, 2);
  assert.equal((await catalog.resolveRepository('OWNER/ALPHA'))?.id, 'explicit-alpha');
  const automatic = await catalog.resolveRepository('owner/beta'); assert.ok(automatic);
  assert.equal(automatic.directory, f.beta);
  assert.deepEqual(automatic.repositories[0]?.criteria, f.config.repositories[0]?.criteria);
  assert.deepEqual(f.config.repositories, originalRepositories);
  await f.runtime.ensure();
  assert.equal(f.created, 1);
  assert.equal(f.runtime.ledger.project(automatic.id), null);
  await f.restart();
  assert.equal((await f.runtime.resolveRepository('owner/beta'))?.id, automatic.id);
  assert.equal(f.created, 1);
  f.config.repositories = [];
  await f.restart();
  assert.equal(await f.runtime.resolveRepository('owner/beta'), null);
  assert.deepEqual(f.runtime.projectConfig(automatic.id)?.repositories, []);
});

test('selection validates supplied candidates, canonical paths and explicit coordinated IDs', async t => {
  const f = await fixture(t);
  const alias = join(f.engineering, 'alias'); await symlink(f.beta, alias);
  const candidates = await discoverProjects(f.engineering);
  const beta = candidates.find(project => project.entryPath === alias); assert.ok(beta);
  const choice = { kind: 'project', projectId: beta.id, reason: 'Selected by owner' } as const;
  const selected = await f.runtime.resolveSelection(choice, candidates); assert.ok(selected);
  assert.equal(selected.directory, f.beta);
  await unlink(alias); await symlink(f.alpha, alias);
  assert.equal(await f.runtime.resolveSelection(choice, candidates), null);
  const explicit = { kind: 'project', id: 'coordinated:explicit-alpha', name: 'Alpha', entryPath: f.alpha, canonicalPath: f.alpha } as const;
  assert.equal((await f.runtime.resolveSelection({ kind: 'project', projectId: explicit.id, reason: '' }, [explicit]))?.id, 'explicit-alpha');
  assert.equal(await f.runtime.resolveSelection({ kind: 'project', projectId: 'invented', reason: '' }, candidates), null);
  assert.equal(await f.runtime.resolveSelection({ kind: 'repository', repositoryName: 'owner/beta', reason: '' }, [{ name: 'owner/beta', path: f.alpha }]), null);
  assert.equal(f.created, 0);
});

test('intake routes freeze atomically and repeated inbox revisions reach the coordinator exactly once', async t => {
  const f = await fixture(t);
  const config = await f.runtime.resolveRepository('owner/beta'); assert.ok(config);
  const task = f.task('intake', { purpose: 'intake' }); f.store.saveTask(task); f.input(task.id, 'owner-input');
  const originalInputs = f.store.inputs(task.id);
  await Promise.all([f.runtime.acceptIntake(task.id, config.id, 'owner-input; prepared path /cached/file'),
    f.runtime.acceptIntake(task.id, config.id, 'owner-input; prepared path /cached/file')]);
  const route = f.runtime.intakeRoute(task.id); assert.ok(route);
  assert.deepEqual(JSON.parse(f.store.meta(`project-intake-route:${task.id}`) ?? 'null'), route);
  assert.equal(f.events(route.coordinatorTaskId, 'intake_request').length, 1);
  assert.deepEqual(f.store.inputs(task.id), originalInputs);
  assert.equal(f.runtime.ledger.membership(task.id), null);
  await f.restart(); await f.runtime.acceptIntake(task.id, config.id, 'same material');
  assert.equal(f.events(route.coordinatorTaskId, 'intake_request').length, 1);
  f.input(task.id, 'owner-followup', 'Additional scope.');
  await f.runtime.acceptIntake(task.id, config.id, 'Complete original and additional scope.');
  assert.equal(f.events(route.coordinatorTaskId, 'intake_request').length, 2);
  await assert.rejects(f.runtime.acceptIntake(task.id, 'explicit-alpha', 'Wrong project'), /immutable/);
  assert.deepEqual(f.runtime.intakeRoute(task.id), route);
});

test('dispatch promotes the same intake with old group and resources and rejects another promotion request', async t => {
  const f = await fixture(t);
  const resource = { id: 'existing', kind: 'project', workspace: f.alpha,
    project: { kind: 'project', id: 'saved', name: 'Alpha', entryPath: f.alpha, canonicalPath: f.alpha } } as const;
  const intake = f.task('old-group', { purpose: 'intake', chatId: 'original-group', resources: [resource], status: 'paused', reason: 'Owner paused' });
  f.store.saveTask(intake); f.input(intake.id, 'original-inbox');
  await f.runtime.acceptIntake(intake.id, 'explicit-alpha', 'Full original input and prepared files.');
  const route = f.runtime.intakeRoute(intake.id); assert.ok(route);
  const originalInputs = f.store.inputs(intake.id);
  const action = { action: 'dispatch', requestId: 'promote', intakeTaskId: intake.id, prompt: 'Delegated scope before initial input.' };
  await assert.rejects(f.runtime.action(route.coordinatorTaskId, action), /paused/);
  f.store.saveTask({ ...intake, status: 'pending', reason: null });
  const first = await f.runtime.action(route.coordinatorTaskId, action);
  assert.deepEqual(first, { taskId: intake.id });
  assert.deepEqual(await f.runtime.action(route.coordinatorTaskId, action), first);
  assert.deepEqual(f.store.task(intake.id), { ...intake, purpose: 'execution', status: 'pending', reason: null });
  assert.deepEqual(f.store.inputs(intake.id), originalInputs);
  assert.equal(f.store.meta(`project-delegation:${intake.id}`), action.prompt);
  assert.equal(f.store.meta(`project-task-model:${intake.id}`), 'gpt-6.1-sol');
  assert.equal(f.runtime.ledger.project('explicit-alpha')?.members.filter(member => member.taskId === intake.id).length, 1);
  assert.equal(f.created, 1);
  await f.restart();
  assert.deepEqual(await f.runtime.action(route.coordinatorTaskId, action), first);
  await assert.rejects(f.runtime.action(route.coordinatorTaskId, { ...action, requestId: 'duplicate-dispatch' }), /already/);
});

test('legacy adoption preserves execution and model identity without admitting an excluded Issue', async t => {
  const f = await fixture(t);
  const task = f.task('legacy', { purpose: 'legacy', status: 'failed', executionStatus: 'failed', reason: 'Existing failure',
    chatId: 'original-group', threadId: 'original-thread', turnId: 'original-turn',
    requests: [{ id: 'approval', threadId: 'original-thread', turnId: 'original-turn', kind: 'approval', prompt: 'Original approval',
      method: 'native', payload: { original: true }, isBlocking: true, connectionEpoch: 'original-epoch' }],
    source: { kind: 'github', issue: { id: 'excluded#1', repository: 'owner/excluded', number: 1, url: 'https://example.test/1',
      title: 'Historical task', body: 'Old body', state: 'open', labels: [], assignees: [], nativeType: 'Bug', updatedAt: '2026-11-12T00:00:00Z', isPullRequest: false },
    repository: { name: 'owner/excluded', criteria: criteriaSchema.parse({}) }, collectionReason: 'historical' },
    resources: [{ id: 'project', kind: 'project', workspace: f.alpha,
      project: { kind: 'project', id: 'old', name: 'Alpha', entryPath: f.alpha, canonicalPath: f.alpha } }] });
  f.store.saveTask(task); f.input(task.id, 'pending-original');
  const originalInputs = f.store.inputs(task.id);
  f.store.setMeta(`project-task-model:${task.id}`, 'original-model');
  assert.equal((await f.runtime.resolveTask(task))?.id, 'explicit-alpha');
  await f.runtime.adopt(task.id, 'explicit-alpha'); await f.runtime.adopt(task.id, 'explicit-alpha');
  assert.deepEqual(f.store.task(task.id), { ...task, purpose: 'execution' });
  assert.deepEqual(f.store.inputs(task.id), originalInputs);
  assert.equal(f.store.meta(`project-task-model:${task.id}`), 'original-model');
  const project = f.runtime.ledger.project('explicit-alpha'); assert.ok(project);
  assert.equal(project.issues.length, 0);
  assert.equal(f.events(project.coordinatorTaskId, 'existing_work').length, 1);
  await f.restart(); await f.runtime.adopt(task.id, 'explicit-alpha');
  assert.equal(f.events(project.coordinatorTaskId, 'existing_work').length, 1);
  assert.deepEqual(f.config.repositories.map(repository => repository.name), ['owner/beta']);
});

test('collect tracks eligible Issue facts without enrolling a threadless intake as a worker', async t => {
  const f = await fixture(t);
  const source = { id: 'owner/alpha#1', repository: 'owner/alpha', number: 1, url: 'https://example.test/1', title: 'Request', body: '',
    state: 'open', assignees: [], labels: ['coordinate'], nativeType: 'Bug', updatedAt: '2026-11-12T00:00:00Z', isPullRequest: false } as const;
  const intake = f.task('github-intake', { purpose: 'intake' }); f.store.saveTask(intake);
  await f.runtime.collect({ ...source, labels: [...source.labels], assignees: [] }, intake);
  assert.equal(f.runtime.ledger.membership(intake.id), null);
  assert.equal(f.runtime.ledger.project('explicit-alpha')?.issues.length, 1);
  assert.equal(f.created, 1);
});

test('an accepted explicit repository cannot move to a different coordinator on restart', async t => {
  const f = await fixture(t);
  const source = issue(71, { repository: 'owner/alpha', labels: ['coordinate'] });
  const request = f.task('explicit-binding', { purpose: 'intake', sourceId: source.id,
    source: { kind: 'github', issue: source, repository: { name: source.repository, criteria: criteriaSchema.parse({}) }, collectionReason: 'project:explicit-alpha' } });
  f.store.saveTask(request); f.input(request.id, 'binding-input');
  await f.runtime.acceptIntake(request.id, 'explicit-alpha', 'Accepted source material.');
  const original = f.config.projects[0]; assert.ok(original);
  f.config.projects = [{ ...original, id: 'replacement' }];
  await assert.rejects(f.restart(), /ownership changed/);
  assert.equal(f.runtime.ledger.project('replacement'), null);
  assert.equal(f.created, 1);
});

test('concurrent source collection cannot overwrite a promoted intake with an earlier Task snapshot', async t => {
  const f = await fixture(t);
  const source = issue(72, { repository: 'owner/alpha', labels: ['coordinate'] });
  const request = f.task('collection-race', { purpose: 'intake', sourceId: source.id,
    source: { kind: 'github', issue: source, repository: { name: source.repository, criteria: criteriaSchema.parse({}) }, collectionReason: 'project:explicit-alpha' } });
  f.store.saveTask(request); f.input(request.id, 'race-input');
  await f.runtime.acceptIntake(request.id, 'explicit-alpha', 'Accepted source material.');
  const earlier = f.store.task(request.id);
  const collecting = f.runtime.collect({ ...source, body: 'Updated issue facts.' }, earlier);
  const route = f.runtime.intakeRoute(request.id); assert.ok(route);
  await f.runtime.action(route.coordinatorTaskId, { action: 'dispatch', requestId: 'concurrent-promotion', intakeTaskId: request.id, prompt: 'Use the original request and scope.' });
  const promoted = f.store.task(request.id);
  await collecting;
  const latest = f.store.task(request.id);
  assert.equal(latest.purpose, 'execution');
  assert.deepEqual(latest.workspaceSelection, promoted.workspaceSelection);
  assert.deepEqual(f.runtime.ledger.membership(request.id), { projectId: 'explicit-alpha', role: 'worker' });
  assert.equal(latest.source.kind === 'github' && latest.source.issue.body, 'Updated issue facts.');
});

test('a source-only repository binding survives restart without expanding collection targets', async t => {
  const f = await fixture(t);
  f.config.repositories = [{ name: 'owner/incoming', criteria: criteriaSchema.parse({ taskTypes: ['bug'], assigneesAny: ['alice'] }) }];
  const catalog = new ProjectCatalog(f.config, f.store);
  const candidates = await discoverProjects(f.engineering);
  const candidate = candidates.find(project => project.name === 'beta'); assert.ok(candidate);
  const project = await catalog.resolveSelection({ kind: 'project', projectId: candidate.id, reason: 'Selected project' }, candidates);
  assert.ok(project);
  await catalog.bindRepository('owner/incoming', project.id);
  await f.restart();
  assert.equal((await f.runtime.resolveRepository('owner/incoming'))?.id, project.id);
  assert.equal(f.config.repositories.length, 1);
  assert.equal((await f.runtime.resolveRepository('owner/incoming'))?.repositories[0]?.criteria?.assigneesAny[0], 'alice');
});
