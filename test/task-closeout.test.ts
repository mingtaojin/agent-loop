import { testExecution } from './test-config.js';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { CodexPort } from '../src/ports.js';
import { z } from 'zod';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import { taskCloseoutSchema } from '../src/task-closeout.js';
import { ProjectDashboardReader } from '../src/dashboard-reader.js';
import { WorkspaceProvider } from '../src/workspace.js';
import { CodexFake, FeishuFake, GitHubFake } from './fakes.js';
import { repositorySchema } from '../src/domain.js';
import type { ProjectAction } from '../src/project.js';

const execute = promisify(execFile);
const git = async (path: string, ...args: string[]) => (await execute('git', ['-C', path, ...args])).stdout.trim();
const exists = async (path: string) => access(path).then(() => true, () => false);
class CloseoutCodexFake extends CodexFake {
  projectHandler: Parameters<NonNullable<CodexPort['setProjectHandler']>>[0] | null = null;
  setProjectHandler(handler: Parameters<NonNullable<CodexPort['setProjectHandler']>>[0]): void { this.projectHandler = handler; }
}
const receipt = z.object({ taskId: z.string(), operationId: z.string() });
async function fixture(t: TestContext, maxAttempts?: number) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'closeout-runtime-'))), project = join(root, 'project'), data = join(root, 'data');
  await mkdir(project);
  await git(project, 'init', '-b', 'main'); await git(project, 'config', 'user.email', 'fixture@example.test'); await git(project, 'config', 'user.name', 'Fixture');
  await writeFile(join(project, 'source.txt'), 'original source'); await git(project, 'add', '.'); await git(project, 'commit', '-m', 'initial');
  const config = configSchema.parse({ execution: testExecution, dataDir: data, feishu: { userOpenId: 'owner' }, recovery: maxAttempts === undefined ? undefined : { maxAttempts },
    repositories: [{ name: 'example/app', path: project, baseBranch: 'main', criteria: { labelsAny: ['work'] } }],
    projects: [{ id: 'app', name: 'App', directory: project, repositories: [{ name: 'example/app', labelsAny: ['work'] }] }],
  });
  const codex = new CloseoutCodexFake(), feishu = new FeishuFake(), workspace = new WorkspaceProvider(data), github = new GitHubFake();
  const ports = { codex, feishu, workspace, github };
  let loop = new AgentLoop(config, ports);
  await loop.collect(); await loop.tick();
  const coordinatorId = loop.projects.ledger.project('app')!.coordinatorTaskId;
  let request = 0;
  const action = (input: ProjectAction, caller = coordinatorId) => loop.projectAction(caller, input);
  const state = async (taskId: string) => {
    const page = z.object({ items: z.array(taskCloseoutSchema) }).parse(await action({ action: 'status', section: 'closeout', limit: 100 }));
    const item = page.items.find(item => item.taskId === taskId); assert.ok(item); return item;
  };
  const completeAction = (taskId: string, requestId = `complete-${taskId}`): Extract<ProjectAction, { action: 'complete_task' }> => ({ action: 'complete_task', taskId, requestId, outcome: 'delivered', summary: 'Delivered result', deliveryReferences: ['https://example.test/result'] });
  const finish = async (taskId: string) => { const threadId = loop.store.task(taskId).threadId; assert.ok(threadId); codex.complete(threadId, 'Finished work'); await loop.tick(); };
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  return { root, project, data, codex, feishu, workspace, action, state, finish, completeAction, coordinatorId,
    get loop() { return loop; },
    async worker() { const result = z.object({ taskId: z.string() }).parse(await action({ action: 'dispatch', execution: testExecution.worker, requestId: `dispatch-${++request}`, prompt: 'Do fixture work', role: 'worker' })); await loop.tick(); return loop.store.task(result.taskId); },
    async scope(taskId: string) { const value = (await state(taskId)).scopes.find(scope => scope.resource.kind === 'artifacts'); assert.ok(value); return value; },
    async complete(taskId: string) { return receipt.parse(await action(completeAction(taskId))); },
    async cleanup(taskId: string, scopeIds?: string[], requestId = `cleanup-${taskId}`) {
      return receipt.parse(await action({ action: 'cleanup_artifacts', taskId, scopeIds: scopeIds ?? (await state(taskId)).scopes.map(scope => scope.id), requestId }));
    },
    async close(taskId: string) {
      await action(completeAction(taskId));
      return receipt.parse(await action({ action: 'cleanup_artifacts', taskId, scopeIds: (await state(taskId)).scopes.map(scope => scope.id), requestId: `cleanup-${taskId}` }));
    },
    async restart() { await loop.close(); loop = new AgentLoop(config, ports); await loop.recover(); },
  };
}

test('closeout removes actual default artifacts, retains records and originals, and replays one stable operation', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id);
  await writeFile(join(scope.location.root.path, 'evidence.mp4'), 'large generated evidence');
  const attachment = join(f.data, 'attachments', worker.id, 'original.txt'); await mkdir(join(f.data, 'attachments', worker.id), { recursive: true }); await writeFile(attachment, 'user original');
  await f.finish(worker.id);
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'open'); assert.equal(await exists(scope.location.root.path), true);
  const first = await f.close(worker.id); assert.deepEqual(await f.close(worker.id), first);
  assert.equal(await exists(scope.location.root.path), false);
  const state = await f.state(worker.id); assert.equal(state.lifecycle.kind, 'completed'); assert.equal(state.operations[0]?.targets[0]?.state, 'removed');
  assert.equal(await readFile(attachment, 'utf8'), 'user original'); assert.equal(await readFile(join(f.project, 'source.txt'), 'utf8'), 'original source');
  assert.ok(f.loop.store.task(worker.id)); assert.ok(f.loop.store.outputs(worker.id).some(output => output.text === 'Finished work'));
  await assert.rejects(f.action({ ...f.completeAction(worker.id), requestId: `complete-${worker.id}`, summary: 'Different' }), /different content/);
  await f.restart(); assert.equal(await exists(scope.location.root.path), false); assert.equal((await f.state(worker.id)).operations.length, 1);
});

test('active execution, unknown use and child processes keep cleanup pending without stopping users', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id), path = scope.location.root.path;
  await writeFile(join(path, 'in-use.txt'), 'open file');
  await f.close(worker.id); assert.equal((await f.state(worker.id)).operations[0]?.targets[0]?.state, 'pending');
  assert.equal(await exists(path), true); assert.equal(f.codex.interrupts.length, 0);
  const threadId = worker.threadId; assert.ok(threadId); f.codex.complete(threadId, null);
  f.codex.inspectError = new Error('usage unavailable'); await f.loop.tick(); assert.equal(await exists(path), true); f.codex.inspectError = null;
  const child = spawn(process.execPath, ['-e', "require('node:fs').openSync('in-use.txt', 'r'); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { cwd: path, stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child.stdout, 'data');
  t.after(() => { child.kill(); });
  await f.loop.tick(); assert.equal(await exists(path), true); assert.match((await f.state(worker.id)).operations[0]?.targets[0]?.reason ?? '', /process/i); assert.equal(child.exitCode, null);
  child.kill(); await once(child, 'exit'); await f.loop.tick(); assert.equal(await exists(path), false);
});

test('completion records the conclusion without consuming or denying native requests', async t => {
  for (const kind of ['approval', 'question', 'permissions', 'unsupported'] as const) {
    const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id); assert.ok(worker.threadId);
    const snapshot = f.codex.snapshot(worker.threadId); assert.ok(snapshot.turnId);
    snapshot.requests = [{ id: `outstanding-${kind}`, threadId: worker.threadId, turnId: snapshot.turnId, kind,
      prompt: 'Unresolved request', method: kind, payload: {}, isBlocking: false, connectionEpoch: 'fixture' }];
    await f.complete(worker.id); await f.loop.tick();
    const state = await f.state(worker.id);
    assert.equal(state.lifecycle.kind, 'completed'); assert.equal(state.operations.length, 0);
    assert.equal(state.completionHistory.length, 1); assert.equal(await exists(scope.location.root.path), true);
    assert.equal(snapshot.requests.length, 1); assert.equal(f.codex.nativeDenials.length, 0);
  }
});

test('unique delivery holds survive completion and only matching authorized delivery releases them', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id), file = join(scope.location.root.path, 'only.zip');
  await writeFile(file, 'only deliverable');
  await f.action({ action: 'register_artifact', requestId: 'hold', scopeId: scope.id, path: file, disposition: 'undelivered' }, worker.id);
  await f.finish(worker.id); await f.close(worker.id);
  assert.equal((await f.state(worker.id)).operations[0]?.targets[0]?.state, 'protected'); assert.equal(await exists(file), true);
  await f.action({ action: 'register_artifact', requestId: 'delivered', taskId: worker.id, scopeId: scope.id, path: file, disposition: 'delivered', reference: 'https://example.test/download' });
  await f.loop.tick(); assert.equal(await exists(file), false);
});

test('concurrent worktree enrollment preserves a successful delivery hold and its cached registration receipt', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id), file = join(scope.location.root.path, 'only.zip');
  await writeFile(file, 'only deliverable');
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
  const ensure = f.workspace.ensure.bind(f.workspace);
  let branchLog: string | undefined;
  f.workspace.ensure = async input => {
    const path = await ensure(input);
    if (input.kind === 'git-worktree') branchLog = join(f.project, '.git', 'logs', 'refs', 'heads', input.branch);
    return path;
  };
  const reader = t.mock.method(fs, 'readFile', new Proxy(fs.readFile, {
    apply(target, receiver, args) {
      if (args[0] !== branchLog) return Reflect.apply(target, receiver, args);
      enter();
      return gate.then(() => Reflect.apply(target, receiver, args));
    },
  }));
  syncBuiltinESMExports();
  const acquisition = f.loop.ensureWorkspace(worker.id, 'example/app');
  const registration: ProjectAction = { action: 'register_artifact', requestId: 'concurrent-hold', scopeId: scope.id, path: file, disposition: 'undelivered' };
  try {
    await entered;
    const receipt = await f.action(registration, worker.id);
    assert.equal((await f.scope(worker.id)).artifacts[0]?.disposition, 'undelivered');
    resume();
    await acquisition;
    assert.deepEqual(await f.action(registration, worker.id), receipt);
  } finally {
    resume();
    try { await acquisition; }
    finally { reader.mock.restore(); syncBuiltinESMExports(); }
  }
  const afterEnrollment = (await f.scope(worker.id)).artifacts;
  await f.finish(worker.id); await f.close(worker.id);
  const target = (await f.state(worker.id)).operations[0]?.targets.find(target => target.scope.id === scope.id);
  assert.deepEqual({ disposition: afterEnrollment[0]?.disposition, cleanup: target?.state, retained: await exists(file) },
    { disposition: 'undelivered', cleanup: 'protected', retained: true });
  await f.restart();
  assert.equal(await readFile(file, 'utf8'), 'only deliverable');
  assert.equal((await f.scope(worker.id)).artifacts[0]?.disposition, 'undelivered');
});

test('delivery status cannot release a replacement file and arbitrary external paths cannot be adopted', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id), file = join(scope.location.root.path, 'only.zip');
  await writeFile(file, 'original'); await f.action({ action: 'register_artifact', requestId: 'hold', scopeId: scope.id, path: file, disposition: 'undelivered' }, worker.id);
  await rename(file, `${file}.old`); await writeFile(file, 'replacement');
  await assert.rejects(f.action({ action: 'register_artifact', requestId: 'replacement', scopeId: scope.id, path: file, disposition: 'delivered', reference: 'https://example.test/new' }, worker.id), /identity changed/);
  await assert.rejects(f.action({ action: 'register_artifact', requestId: 'claim-source', scopeId: scope.id, path: join(f.project, 'source.txt'), disposition: 'temporary' }, worker.id), /outside/);
  await assert.rejects(f.action({ action: 'allocate_artifacts', requestId: 'bad-parent', parent: f.root, label: 'claim external' }, worker.id), /parent/);
  await f.finish(worker.id); await f.close(worker.id); assert.equal(await readFile(file, 'utf8'), 'replacement');
});

test('root replacement, symlink retargeting and ancestor replacement never inherit deletion authority', async t => {
  for (const mode of ['root', 'symlink', 'ancestor']) {
    const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id), path = scope.location.root.path;
    await f.finish(worker.id);
    if (mode === 'ancestor') { await rename(worker.contextDirectory, `${worker.contextDirectory}.old`); await mkdir(path, { recursive: true }); }
    else { await rename(path, `${path}.old`); if (mode === 'symlink') await symlink(f.project, path); else await mkdir(path); }
    await f.close(worker.id);
    const target = (await f.state(worker.id)).operations[0]?.targets[0]; assert.equal(target?.state, 'pending'); assert.match(target?.reason ?? '', /identity|physical directory/);
    assert.equal(await exists(path), true); assert.equal(await readFile(join(f.project, 'source.txt'), 'utf8'), 'original source');
  }
});

test('formal closeout discards dirty unmerged worktree and branch while ordinary release remains conservative', async t => {
  const f = await fixture(t), worker = await f.worker();
  const tree = await f.loop.ensureWorkspace(worker.id, 'example/app'); assert.equal(tree.kind, 'git-worktree'); if (tree.kind !== 'git-worktree') return;
  await writeFile(join(tree.workspace, 'unique.txt'), 'unmerged'); await git(tree.workspace, 'add', '.'); await git(tree.workspace, 'commit', '-m', 'unique');
  await writeFile(join(tree.workspace, '.gitignore'), 'ignored.bin'); await writeFile(join(tree.workspace, 'ignored.bin'), 'build'); await writeFile(join(tree.workspace, 'untracked.txt'), 'dirty');
  await assert.rejects(f.action({ action: 'release_workspace', requestId: 'ordinary', resourceId: tree.id }, worker.id), /uncommitted|untracked|ignored/);
  await f.finish(worker.id); await f.close(worker.id);
  assert.equal(await exists(tree.workspace), false); assert.equal(await git(f.project, 'for-each-ref', '--format=%(refname)', `refs/heads/${tree.branch}`), '');
  assert.equal((await f.state(worker.id)).operations[0]?.targets.find(target => target.scope.resource.kind === 'worktree')?.branchRemoved, true);
  assert.equal(await readFile(join(f.project, 'source.txt'), 'utf8'), 'original source');
});

test('completion reconciles a previously removed owned worktree and branch with one durable receipt', async t => {
  const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app');
  if (tree.kind !== 'git-worktree') throw new Error('Expected real worktree');
  await f.finish(worker.id);
  await git(f.project, 'worktree', 'remove', '--force', tree.workspace); await git(f.project, 'branch', '-D', tree.branch);
  const completed = await f.close(worker.id), state = await f.state(worker.id);
  assert.equal(state.lifecycle.kind, 'completed'); assert.equal(state.operations.length, 1);
  assert.ok(state.operations[0]?.targets.every(target => target.state === 'removed'));
  const target = state.operations[0]?.targets.find(target => target.scope.resource.kind === 'worktree'); assert.ok(target);
  assert.equal(target.directoryRemoved, true); assert.equal(target.branchRemoved, true);
  assert.equal(await exists(tree.workspace), false);
  assert.equal(await git(f.project, 'for-each-ref', '--format=%(refname)', `refs/heads/${tree.branch}`), '');
  assert.equal((await git(f.project, 'worktree', 'list', '--porcelain', '-z')).split('\0').includes(`worktree ${tree.workspace}`), false);
  assert.equal(f.loop.store.task(worker.id).resources.some(resource => resource.id === tree.id), false);
  await f.restart(); assert.deepEqual(await f.close(worker.id), completed);
  assert.deepEqual(await f.state(worker.id), state);
  assert.equal(await readFile(join(f.project, 'source.txt'), 'utf8'), 'original source');
});

test('a missing branch does not authorize removal of remaining or replaced worktree resources', async t => {
  for (const mode of ['worktree', 'replacement', 'registration', 'elsewhere', 'descendant-branch']) {
    const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app');
    if (tree.kind !== 'git-worktree') throw new Error('Expected real worktree');
    const before = (await f.state(worker.id)).scopes.find(scope => scope.resource.kind === 'worktree');
    assert.ok(before); if (before.resource.kind !== 'worktree') throw new Error('Expected owned worktree');
    await f.finish(worker.id);
    let retainedPath = tree.workspace;
    if (mode === 'replacement') {
      await rename(tree.workspace, `${tree.workspace}.old`);
      await git(f.project, 'worktree', 'remove', '--force', tree.workspace); await mkdir(tree.workspace);
    } else if (mode === 'registration') await rm(tree.workspace, { recursive: true });
    else if (mode === 'elsewhere') {
      await git(f.project, 'worktree', 'remove', '--force', tree.workspace);
      retainedPath = join(f.root, 'elsewhere'); await git(f.project, 'worktree', 'add', retainedPath, tree.branch);
    }
    if (mode !== 'registration') await writeFile(join(retainedPath, 'retained.txt'), mode);
    await git(f.project, 'update-ref', '-d', `refs/heads/${tree.branch}`);
    if (mode === 'descendant-branch') await git(f.project, 'branch', `${tree.branch}/replacement`, 'main');
    await f.close(worker.id);
    const state = await f.state(worker.id), target = state.operations[0]?.targets.find(target => target.scope.resource.kind === 'worktree');
    assert.equal(state.lifecycle.kind, 'completed'); assert.equal(target?.state, 'pending');
    assert.match(target?.reason ?? '', /identity|branch|registration/);
    if (mode === 'registration') {
      assert.equal(await exists(before.resource.gitDirectory.root.path), true);
      assert.equal((await git(f.project, 'worktree', 'list', '--porcelain', '-z')).split('\0').includes(`worktree ${tree.workspace}`), true);
    } else assert.equal(await readFile(join(retainedPath, 'retained.txt'), 'utf8'), mode);
    assert.equal(f.loop.store.task(worker.id).resources.some(resource => resource.id === tree.id), true);
    assert.equal(await readFile(join(f.project, 'source.txt'), 'utf8'), 'original source');
  }
});

test('a recreated branch at the frozen commit cannot inherit cleanup authority', async t => {
  const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app');
  if (tree.kind !== 'git-worktree') throw new Error('Expected real worktree');
  const head = await git(f.project, 'rev-parse', `refs/heads/${tree.branch}`);
  await f.close(worker.id);
  await git(f.project, 'worktree', 'remove', '--force', tree.workspace); await git(f.project, 'branch', '-D', tree.branch);
  await git(f.project, 'branch', tree.branch, head);
  await f.finish(worker.id); await f.restart();
  assert.equal(await git(f.project, 'rev-parse', `refs/heads/${tree.branch}`), head);
  const target = (await f.state(worker.id)).operations[0]?.targets.find(target => target.scope.resource.kind === 'worktree');
  assert.equal(target?.state, 'pending'); assert.match(target?.reason ?? '', /branch.*identity/);
});

test('registered delivery identity is rechecked before deleting artifact scopes or worktrees', async t => {
  for (const kind of ['artifacts', 'worktree']) {
    const f = await fixture(t), worker = await f.worker();
    if (kind === 'worktree') await f.loop.ensureWorkspace(worker.id, 'example/app');
    const scope = (await f.state(worker.id)).scopes.find(scope => scope.resource.kind === kind); assert.ok(scope);
    const file = join(scope.location.root.path, 'delivered.log'); await writeFile(file, 'delivered original');
    await f.action({ action: 'register_artifact', requestId: 'delivered', scopeId: scope.id, path: file, disposition: 'delivered', reference: 'fixture://delivery' }, worker.id);
    await f.close(worker.id);
    await rename(file, `${file}.old`); await writeFile(file, 'replacement not delivered');
    await f.finish(worker.id); await f.restart();
    assert.equal(await readFile(file, 'utf8'), 'replacement not delivered');
    assert.equal(await readFile(`${file}.old`, 'utf8'), 'delivered original');
    const target = (await f.state(worker.id)).operations[0]?.targets.find(target => target.scope.id === scope.id);
    assert.equal(target?.state, 'pending'); assert.match(target?.reason ?? '', /artifact.*identity/);
  }
});

test('branch deletion resumes after worktree removal fails to update its locked local ref', async t => {
  const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app'); if (tree.kind !== 'git-worktree') throw new Error('Expected real worktree');
  const lock = join(f.project, '.git', `${`refs/heads/${tree.branch}`}.lock`); await writeFile(lock, 'controlled ref lock');
  await f.finish(worker.id); await f.close(worker.id); assert.equal(await exists(tree.workspace), false);
  assert.notEqual(await git(f.project, 'for-each-ref', '--format=%(refname)', `refs/heads/${tree.branch}`), '');
  await rm(lock); await f.restart(); assert.equal(await git(f.project, 'for-each-ref', '--format=%(refname)', `refs/heads/${tree.branch}`), '');
  assert.ok((await f.state(worker.id)).operations[0]?.targets.every(target => target.state === 'removed'));
});

test('shared associations and another task scope protect their actual contents', async t => {
  const f = await fixture(t), first = await f.worker(), second = await f.worker(), tree = await f.loop.ensureWorkspace(first.id, 'example/app');
  const saved = f.loop.store.task(second.id); saved.resources.push(tree); f.loop.store.saveTask(saved);
  await writeFile(join(tree.workspace, 'shared.txt'), 'still used'); await f.finish(first.id); await f.close(first.id);
  assert.equal(await readFile(join(tree.workspace, 'shared.txt'), 'utf8'), 'still used');
  assert.match((await f.state(first.id)).operations[0]?.targets.find(target => target.scope.resource.kind === 'worktree')?.reason ?? '', /another task/);
  assert.equal((await f.state(second.id)).lifecycle.kind, 'open');
});

test('completed followups continue the original Worker and Thread, retaining completion history', async t => {
  const f = await fixture(t), worker = await f.worker();
  await f.action({ action: 'open_group', requestId: 'group', taskId: worker.id });
  const before = f.loop.store.task(worker.id); assert.ok(before.chatId);
  await f.finish(worker.id); await f.complete(worker.id);
  const message = { id: 'follow-up', chatId: before.chatId, senderId: 'owner', chatType: 'group' as const, text: 'What was delivered?', attachments: [], createdAt: Date.now() };
  await f.loop.receive(message); await f.loop.receive(message);
  const after = f.loop.store.task(worker.id);
  assert.equal(after.threadId, before.threadId); assert.equal(after.chatId, before.chatId);
  assert.deepEqual(after.workerExecution, before.workerExecution); assert.equal(f.loop.tasks().length, 2);
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'open'); assert.equal((await f.state(worker.id)).completionHistory.length, 1);
  assert.equal(f.loop.store.inputs(worker.id).find(input => input.id === message.id)?.status, 'delivered');
  assert.equal(f.loop.store.inputs(f.coordinatorId).filter(input => input.id.startsWith('completed-followup:')).length, 0);
  assert.equal(f.codex.starts.filter(start => start.deliveryId === message.id).length, 1);
});

test('completed-task followups cannot answer coordinator native questions while direct group replies can', async t => {
  const f = await fixture(t), worker = await f.worker();
  await f.action({ action: 'open_group', requestId: 'group', taskId: worker.id });
  const workerChat = f.loop.store.task(worker.id).chatId; assert.ok(workerChat);
  await f.finish(worker.id); await f.close(worker.id);
  const coordinator = f.loop.store.task(f.coordinatorId); assert.ok(coordinator.threadId); assert.ok(coordinator.chatId);
  const snapshot = f.codex.snapshot(coordinator.threadId); assert.ok(snapshot.turnId);
  const request = {
    id: 'coordinator-question', threadId: snapshot.threadId, turnId: snapshot.turnId,
    kind: 'question' as const, prompt: 'Which separate target?', method: 'item/tool/requestUserInput',
    payload: {}, isBlocking: true, connectionEpoch: 'fixture',
  };
  snapshot.requests = [request];
  const followup = { id: 'completed-followup', chatId: workerChat, senderId: 'owner', chatType: 'group' as const,
    text: 'Add a new report section', attachments: [], createdAt: Date.now() };
  await f.loop.receive(followup); await f.loop.receive(followup); await f.loop.tick();
  assert.equal(f.codex.replies.length, 0); assert.deepEqual(snapshot.requests, [request]);
  const forwarded = f.loop.store.inputs(f.coordinatorId).filter(input => input.id === `completed-followup:${worker.id}:${followup.id}`);
  assert.equal(forwarded.length, 0);
  assert.equal(f.loop.store.inputs(worker.id).find(input => input.id === followup.id)?.status, 'delivered');
  await f.loop.receive({ id: 'direct-answer', chatId: coordinator.chatId, senderId: 'owner', chatType: 'group',
    text: 'Use the QA target', attachments: [], createdAt: Date.now() });
  await f.loop.tick();
  assert.deepEqual(f.codex.replies.map(input => [input.request.id, input.text]), [[request.id, 'Use the QA target']]);
});

test('continued Worker attachments use the original Feishu message identity and deduplicate delivery', async t => {
  const f = await fixture(t), worker = await f.worker();
  await f.action({ action: 'open_group', requestId: 'group', taskId: worker.id });
  const chatId = f.loop.store.task(worker.id).chatId; assert.ok(chatId);
  await f.finish(worker.id); await f.close(worker.id);
  const message = { id: 'original-feishu-message', chatId, senderId: 'owner', chatType: 'group' as const,
    text: 'Use the attached log for the followup', attachments: [{ kind: 'file' as const, key: 'followup-log', name: 'followup.log' }], createdAt: Date.now() };
  f.feishu.resources.set('followup-log', Buffer.from('original followup log'));
  const download = f.feishu.download.bind(f.feishu);
  f.feishu.download = async input => { assert.equal(input.messageId, message.id, 'Feishu resource lookup requires its original message ID'); await download(input); };
  await f.loop.receive(message); await f.loop.receive(message); await f.loop.tick();
  const forwardedId = message.id;
  const forwarded = f.loop.store.inputs(worker.id).find(input => input.id === forwardedId); assert.ok(forwarded);
  assert.equal(forwarded.status, 'delivered'); assert.equal(f.feishu.downloads.length, 1);
  assert.equal(f.feishu.downloads[0]?.messageId, message.id);
  assert.deepEqual(forwarded.provenance, { kind: 'user', message });
  const directory = join(f.data, 'attachments', worker.id), files = await readdir(directory, { recursive: true });
  const log = files.find(file => file.endsWith('.log')); assert.ok(log);
  assert.equal(await readFile(join(directory, log), 'utf8'), 'original followup log');
  assert.equal([...f.codex.steers, ...f.codex.starts].filter(input => input.deliveryId === forwardedId).length, 1);
  await f.restart(); await f.loop.tick(); assert.equal(f.feishu.downloads.length, 1);
});

test('lost cleanup acknowledgement and immutable action receipt converge against actual files on restart', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id); await f.finish(worker.id);
  const setMeta = f.loop.store.setMeta.bind(f.loop.store); let lose = true;
  f.loop.store.setMeta = (key, value) => {
    if (lose && key === `task-closeout:${worker.id}` && value.includes('"state":"removed"')) { lose = false; throw new Error('Lost cleanup acknowledgement'); }
    setMeta(key, value);
  };
  await assert.rejects(f.close(worker.id), /Lost cleanup acknowledgement/); assert.equal(await exists(scope.location.root.path), false);
  assert.equal((await f.state(worker.id)).operations[0]?.targets[0]?.state, 'pending');
  await f.restart(); const result = await f.close(worker.id); assert.equal(result.operationId, (await f.state(worker.id)).operations[0]?.id);
  assert.equal((await f.state(worker.id)).operations[0]?.targets[0]?.state, 'removed');
});

test('allocation reservation prevents incomplete closeout snapshots and later scopes do not inherit old cleanup', async t => {
  const f = await fixture(t), worker = await f.worker(); await f.finish(worker.id);
  const original = f.workspace.ensure.bind(f.workspace); let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.workspace.ensure = async input => { if (input.kind === 'git-worktree') { entered(); await gate; } return original(input); };
  const acquire = f.loop.ensureWorkspace(worker.id, 'example/app'); await started;
  try { await f.complete(worker.id); await assert.rejects(f.cleanup(worker.id, undefined, 'during-allocation'), /in flight/); assert.equal((await f.state(worker.id)).lifecycle.kind, 'completed'); } finally { release(); await acquire; }
  await f.close(worker.id); assert.ok((await f.state(worker.id)).operations[0]?.targets.some(target => target.scope.resource.kind === 'worktree'));
  const next = await f.worker(), nextScope = await f.scope(next.id); await writeFile(join(nextScope.location.root.path, 'new.txt'), 'new task');
  await f.close(worker.id); assert.equal(await readFile(join(nextScope.location.root.path, 'new.txt'), 'utf8'), 'new task');
});

test('coordinator scopes close after its turn without closing the coordinator or touching later work and project records', async t => {
  const f = await fixture(t), scope = await f.scope(f.coordinatorId);
  await writeFile(join(scope.location.root.path, 'temporary.txt'), 'inspection');
  await f.action({ action: 'record', requestId: 'record', key: 'decision', text: 'Durable decision', expectedVersion: 0 });
  const clean: ProjectAction = { action: 'cleanup_artifacts', taskId: f.coordinatorId, requestId: 'batch-one', scopeIds: [scope.id] };
  const handle = await f.action(clean); assert.equal(await exists(scope.location.root.path), true);
  const next = z.object({ id: z.string(), location: z.object({ root: z.object({ path: z.string() }) }) }).parse(await f.action({ action: 'allocate_artifacts', requestId: 'batch-two', label: 'Next dispatch', parent: f.project }));
  await writeFile(join(next.location.root.path, 'next.txt'), 'active next work');
  await f.finish(f.coordinatorId); await f.loop.tick(); assert.equal(await exists(scope.location.root.path), false);
  assert.equal(await readFile(join(next.location.root.path, 'next.txt'), 'utf8'), 'active next work'); assert.equal((await f.state(f.coordinatorId)).lifecycle.kind, 'open');
  assert.equal(receipt.parse(await f.action(clean)).operationId, receipt.parse(handle).operationId); assert.equal(f.loop.projects.ledger.project('app')?.records[0]?.text, 'Durable decision');
});

test('role boundaries reject workers and cross-project targets without deleting; uncertain input prevents sealing', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id);
  await assert.rejects(f.action(f.completeAction(worker.id), worker.id), /Only the coordinator/);
  await assert.rejects(f.action(f.completeAction(f.coordinatorId)), /not a worker/);
  await assert.rejects(f.action(f.completeAction('other-project-task')), /not a worker/);
  await assert.rejects(f.action({ action: 'cleanup_artifacts', taskId: worker.id, scopeIds: [scope.id], requestId: 'forbidden-cleanup' }, worker.id), /Only the coordinator/);
  await assert.rejects(f.action({ action: 'cleanup_artifacts', taskId: 'other-project-task', scopeIds: [scope.id], requestId: 'foreign-cleanup' }), /not owned/);
  f.loop.store.receive(worker.id, { id: 'uncertain', chatId: '', senderId: 'owner', chatType: 'group', text: 'new work', attachments: [], createdAt: Date.now() }); f.loop.store.markInput('uncertain', 'uncertain');
  await f.close(worker.id); assert.equal((await f.state(worker.id)).lifecycle.kind, 'completed'); assert.equal(await exists(scope.location.root.path), true);
  assert.match((await f.state(worker.id)).operations[0]?.targets[0]?.reason ?? '', /unresolved/);
});

test('historical resource associations are not enrolled by restart or idle checks', async t => {
  const f = await fixture(t), worker = await f.worker(); await f.finish(worker.id);
  const association = { id: 'historical', kind: 'git-worktree' as const, branch: `historical/${worker.id}`, repository: repositorySchema.parse({ name: 'example/app', path: f.project, baseBranch: 'main', criteria: { labelsAny: ['work'] } }) };
  const workspace = await f.workspace.ensure({ taskId: worker.id, resourceId: association.id, repository: association.repository, branch: association.branch });
  const task = f.loop.store.task(worker.id); task.resources.push({ ...association, workspace }); f.loop.store.saveTask(task);
  await writeFile(join(workspace, 'historical.bin'), 'old evidence'); await f.restart(); await f.loop.tick(); await f.close(worker.id);
  assert.equal(await readFile(join(workspace, 'historical.bin'), 'utf8'), 'old evidence'); assert.equal((await f.state(worker.id)).scopes.some(scope => scope.resource.kind === 'worktree'), false);
});

test('cleanup admission racing attachment preparation leaves input pending until execution can start', { timeout: 10_000 }, async t => {
  const f = await fixture(t), scope = await f.scope(f.coordinatorId), coordinator = f.loop.store.task(f.coordinatorId);
  assert.ok(coordinator.threadId); assert.ok(coordinator.chatId);
  await f.action({ action: 'cleanup_artifacts', taskId: f.coordinatorId, requestId: 'cleanup-race', scopeIds: [scope.id] });
  f.codex.complete(coordinator.threadId, null);
  let releaseDownload!: () => void, enteredDownload!: () => void, releaseUsage!: () => void, enteredUsage!: () => void;
  const downloadGate = new Promise<void>(resolve => { releaseDownload = resolve; }), downloadStarted = new Promise<void>(resolve => { enteredDownload = resolve; });
  const usageGate = new Promise<void>(resolve => { releaseUsage = resolve; }), usageStarted = new Promise<void>(resolve => { enteredUsage = resolve; });
  const download = f.feishu.download.bind(f.feishu), usage = f.codex.executionUse.bind(f.codex);
  f.feishu.resources.set('race-file', Buffer.from('original input'));
  f.feishu.download = async input => { enteredDownload(); await downloadGate; await download(input); };
  const message = { id: 'race-input', chatId: coordinator.chatId, senderId: 'owner', chatType: 'group' as const, text: 'Next work', attachments: [{ kind: 'file' as const, key: 'race-file', name: 'input.txt' }], createdAt: Date.now() };
  const receive = f.loop.receive(message); await downloadStarted;
  f.codex.executionUse = async threadId => { enteredUsage(); await usageGate; return usage(threadId); };
  const tick = f.loop.tick(); await usageStarted; releaseDownload(); await receive;
  assert.equal(f.loop.store.inputs(f.coordinatorId).find(input => input.id === message.id)?.status, 'pending');
  assert.equal(f.codex.starts.some(start => start.deliveryId === message.id), false);
  releaseUsage(); await tick; await f.loop.tick();
  assert.equal(f.loop.store.inputs(f.coordinatorId).find(input => input.id === message.id)?.status, 'delivered');
  assert.equal(await exists(scope.location.root.path), false);
});

test('a slow cleanup does not delay another task reply across successive sweeps', { timeout: 10_000 }, async t => {
  const f = await fixture(t), worker = await f.worker(), coordinator = f.loop.store.task(f.coordinatorId);
  assert.ok(worker.threadId); assert.ok(coordinator.threadId); assert.ok(coordinator.chatId);
  await f.close(worker.id);
  let releaseUsage!: () => void, enteredUsage!: () => void;
  const usageGate = new Promise<void>(resolve => { releaseUsage = resolve; });
  const usageStarted = new Promise<void>(resolve => { enteredUsage = resolve; });
  const usage = f.codex.executionUse.bind(f.codex);
  f.codex.executionUse = async threadId => {
    if (threadId === worker.threadId) { enteredUsage(); await usageGate; }
    return usage(threadId);
  };
  const sweeps: Promise<void>[] = [];
  const send = f.feishu.send.bind(f.feishu);
  let delivered!: () => void;
  f.feishu.send = async input => { await send(input); if (input.text === 'Responsive reply') delivered(); };
  try {
    for (let index = 0; index < 2; index++) {
      if (index) await f.loop.receive({ id: 'second-owner-input', chatId: coordinator.chatId, senderId: 'owner',
        chatType: 'group', text: 'Another question', attachments: [], createdAt: Date.now() });
      const reply = new Promise<void>(resolve => { delivered = resolve; });
      sweeps.push(f.loop.tick());
      await usageStarted;
      await f.loop.projectCall(coordinator.id, { tool: 'send_group_message', arguments: { requestId: `responsive-${index}`, text: 'Responsive reply' } });
      f.codex.complete(coordinator.threadId, 'Internal final');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([reply, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Unrelated cleanup blocked a coordinator reply')), 1500);
        })]);
      } finally { clearTimeout(timer); }
    }
    assert.equal(f.feishu.sent.filter(message => message.text === 'Responsive reply').length, 2);
    assert.equal(f.loop.store.inputs(coordinator.id).find(input => input.id === 'second-owner-input')?.status, 'delivered');
  } finally { releaseUsage(); await Promise.allSettled(sweeps); }
});

test('lost generic receipts do not allocate a second scope or lose the atomic completion intent', async t => {
  const f = await fixture(t), worker = await f.worker();
  const setMeta = f.loop.store.setMeta.bind(f.loop.store); let failRequest = 'allocation-ack';
  f.loop.store.setMeta = (key, value) => { if (key.includes('receipt') && key.includes(failRequest)) { failRequest = 'none'; throw new Error('Lost generic receipt'); } setMeta(key, value); };
  const allocate: ProjectAction = { action: 'allocate_artifacts', requestId: 'allocation-ack', label: 'External batch', parent: f.project };
  await assert.rejects(f.action(allocate, worker.id), /Lost generic receipt/);
  const allocated = await f.action(allocate, worker.id); assert.deepEqual(await f.action(allocate, worker.id), allocated);
  assert.equal((await f.state(worker.id)).scopes.length, 2);
  await f.finish(worker.id); failRequest = `complete-${worker.id}`;
  await assert.rejects(f.close(worker.id), /Lost generic receipt/);
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'completed'); assert.equal((await f.state(worker.id)).operations.length, 0);
  await f.restart(); await f.close(worker.id); assert.ok((await f.state(worker.id)).operations[0]?.targets.every(target => target.state === 'removed'));
});

test('external worktree scopes respect nested delivery holds and changed branch identity', async t => {
  const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app'); if (tree.kind !== 'git-worktree') throw new Error('Expected worktree');
  const scope = z.object({ id: z.string(), location: z.object({ root: z.object({ path: z.string() }) }) }).parse(await f.action({ action: 'allocate_artifacts', requestId: 'tree-output', parent: tree.workspace, label: 'Build output' }, worker.id));
  const file = join(scope.location.root.path, 'only.bin'); await writeFile(file, 'unique binary');
  await f.action({ action: 'register_artifact', requestId: 'tree-hold', scopeId: scope.id, path: file, disposition: 'undelivered' }, worker.id);
  await f.finish(worker.id); await f.close(worker.id); assert.equal(await exists(file), true); assert.equal(await exists(tree.workspace), true);
  await writeFile(join(tree.workspace, 'later.txt'), 'changed after frozen intent'); await git(tree.workspace, 'add', '.'); await git(tree.workspace, 'commit', '-m', 'later external change');
  await f.action({ action: 'register_artifact', requestId: 'tree-delivery', taskId: worker.id, scopeId: scope.id, path: file, disposition: 'delivered', reference: 'https://example.test/build' });
  await f.loop.tick(); assert.equal(await exists(file), false); assert.equal(await exists(tree.workspace), true);
  assert.match((await f.state(worker.id)).operations[0]?.targets.find(target => target.scope.resource.kind === 'worktree')?.reason ?? '', /branch changed/);
});

test('interrupted worktree directory removal reconciles its saved Git registration on restart', async t => {
  const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app'); if (tree.kind !== 'git-worktree') throw new Error('Expected worktree');
  await f.close(worker.id);
  await rm(tree.workspace, { recursive: true });
  assert.match(await git(f.project, 'worktree', 'list', '--porcelain'), new RegExp(tree.branch));
  assert.ok(worker.threadId); f.codex.complete(worker.threadId, null);
  await f.restart(); assert.equal(await git(f.project, 'for-each-ref', '--format=%(refname)', `refs/heads/${tree.branch}`), '');
  assert.ok((await f.state(worker.id)).operations[0]?.targets.every(target => target.state === 'removed'));
});


test('closeout status and overview preserve task record visibility', async t => {
  const f = await fixture(t), first = await f.worker(), second = await f.worker();
  const own = await f.scope(first.id), other = await f.scope(second.id);
  await f.action({ action: 'record', requestId: 'private-record', key: 'result', text: 'SECOND_TASK_PRIVATE_RECORD', expectedVersion: 0 }, second.id);
  await f.finish(second.id);
  await f.action({ ...f.completeAction(second.id), summary: 'SECOND_TASK_PRIVATE_RESULT', deliveryReferences: ['fixture://second-private-delivery'] });
  for (const section of ['closeout', 'overview', 'tasks'] as const) {
    const visible = JSON.stringify(await f.action({ action: 'status', section }, first.id));
    assert.ok(visible.includes(own.location.root.path));
    for (const secret of [other.location.root.path, second.id, 'SECOND_TASK_PRIVATE_RECORD', 'SECOND_TASK_PRIVATE_RESULT', 'fixture://second-private-delivery']) assert.ok(!visible.includes(secret), `${section} leaked ${secret}`);
    const coordinator = JSON.stringify(await f.action({ action: 'status', section }));
    assert.ok(coordinator.includes(other.location.root.path));
    assert.ok(coordinator.includes('SECOND_TASK_PRIVATE_RESULT'));
  }
  const records = JSON.stringify(await f.action({ action: 'status', section: 'records' }, first.id));
  assert.ok(!records.includes('SECOND_TASK_PRIVATE_RECORD'));
});

test('artifact inventory changes use input context without changing stable thread instructions', async t => {
  const f = await fixture(t), worker = await f.worker();
  const coordinator = f.loop.store.task(f.coordinatorId); assert.ok(coordinator.threadId && coordinator.chatId);
  const before = f.codex.created[0]?.instructions; assert.ok(before);
  const updates: string[] = [];
  const inspect = f.codex.inspect.bind(f.codex);
  f.codex.inspect = async (...args) => { if (args[0] === coordinator.threadId && args[1]) updates.push(args[1]); return inspect(...args); };
  const scope = z.object({ id: z.string(), location: z.object({ root: z.object({ path: z.string() }) }) }).parse(await f.action({ action: 'allocate_artifacts', requestId: 'dynamic-scope', label: 'Current work' }));
  await f.loop.tick();
  assert.ok(updates.length > 0); assert.ok(updates.every(instructions => instructions === before));
  assert.ok(!f.loop.projects.context(worker.id).includes(scope.location.root.path));
  await f.loop.receive({ id: 'scope-context-input', chatId: coordinator.chatId, senderId: 'owner', chatType: 'group', text: 'Continue this review', attachments: [], createdAt: Date.now() });
  assert.ok(f.codex.steers.find(input => input.deliveryId === 'scope-context-input')?.additionalContext?.includes(scope.location.root.path));
  await f.action({ action: 'cleanup_artifacts', taskId: f.coordinatorId, requestId: 'clean-dynamic-scope', scopeIds: [scope.id] });
  await f.loop.tick();
  assert.ok(updates.every(instructions => instructions === before));
  assert.ok(f.loop.projects.context(f.coordinatorId).includes(scope.location.root.path));
  assert.equal(await exists(scope.location.root.path), true);
});

for (const entry of ['native', 'capability'] as const) test(`${entry} project action preserves original turn authorization and immediately progresses accepted closeout`, async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id);
  await f.finish(worker.id);
  const coordinator = f.loop.store.task(f.coordinatorId); assert.ok(coordinator.threadId);
  const activity = await f.codex.activity(coordinator.threadId); assert.equal(activity.kind, 'running');
  if (activity.kind !== 'running') throw new Error('Expected running coordinator');
  const action = f.completeAction(worker.id);
  const actionFile = join(f.root, 'closeout-action.json'); await writeFile(actionFile, JSON.stringify(action));
  const call = async () => {
    if (entry === 'native') {
      assert.ok(f.codex.projectHandler);
      return f.codex.projectHandler({ ...activity, callId: 'closeout-call', call: { tool: 'project_action', arguments: action } });
    }
    const output = await execute(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/project-client.ts', import.meta.url)), join(f.data, 'workspace-capabilities', `${coordinator.id}.json`), actionFile]);
    return JSON.parse(output.stdout);
  };
  const originalActivity = f.codex.activity.bind(f.codex);
  f.codex.complete(coordinator.threadId, null);
  f.codex.activity = async () => activity;
  await assert.rejects(call(), /original active task turn/);
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'open'); assert.equal(await exists(scope.location.root.path), true);
  f.codex.snapshot(coordinator.threadId).status = 'running'; f.codex.activity = originalActivity;
  receipt.parse(await call());
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'completed');
  assert.equal(await exists(scope.location.root.path), true);
  assert.equal((await f.state(worker.id)).operations.length, 0);
});

for (const mode of ['disposal-file', 'root', 'removed-recreated'] as const) test(`nested ownership protects ${mode} from recursive parent cleanup`, async t => {
  const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app');
  if (tree.kind !== 'git-worktree') throw new Error('Expected worktree');
  const allocated = z.object({ id: z.string() }).parse(await f.action({ action: 'allocate_artifacts', requestId: 'nested', parent: tree.workspace, label: 'Nested output' }, worker.id));
  const scope = (await f.state(worker.id)).scopes.find(scope => scope.id === allocated.id); assert.ok(scope);
  const file = join(scope.location.root.path, 'result.txt'); await writeFile(file, 'original output');
  if (mode === 'disposal-file') await f.action({ action: 'register_artifact', requestId: 'delivery', scopeId: scope.id, path: file, disposition: 'delivered', reference: 'fixture://delivered' }, worker.id);
  await f.close(worker.id);
  const child = (await f.state(worker.id)).operations[0]?.targets.find(target => target.scope.id === scope.id); assert.ok(child);
  let retained = file;
  if (mode === 'disposal-file') {
    t.diagnostic('Constructed interrupted cleanup by moving the owned child directory to its persisted disposal path.');
    await rename(scope.location.root.path, child.disposalPath);
    retained = join(child.disposalPath, 'result.txt'); await rename(retained, `${retained}.old`); await writeFile(retained, 'replacement');
  } else if (mode === 'root') {
    await rename(scope.location.root.path, `${scope.location.root.path}.old`); await mkdir(scope.location.root.path); await writeFile(retained, 'replacement');
  } else {
    const setMeta = f.loop.store.setMeta.bind(f.loop.store); let recreated = false;
    f.loop.store.setMeta = (key, value) => {
      setMeta(key, value);
      if (key === `task-closeout:${worker.id}`) {
        const saved = taskCloseoutSchema.parse(JSON.parse(value));
        if (!recreated && saved.operations[0]?.targets.find(target => target.scope.id === scope.id)?.state === 'removed') {
          recreated = true;
          mkdirSync(scope.location.root.path); writeFileSync(retained, 'replacement');
        }
      }
    };
  }
  await f.finish(worker.id); await f.restart();
  assert.equal(await readFile(retained, 'utf8'), 'replacement');
  const targets = (await f.state(worker.id)).operations[0]?.targets; assert.ok(targets);
  assert.equal(targets.find(target => target.scope.resource.kind === 'worktree')?.state, 'pending');
  assert.equal(await git(f.project, 'rev-parse', `refs/heads/${tree.branch}`), await git(f.project, 'rev-parse', 'main'));
});

test('allocation branch generation rejects same-name same-OID recreation before completion', async t => {
  const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app');
  if (tree.kind !== 'git-worktree') throw new Error('Expected worktree');
  const head = await git(f.project, 'rev-parse', `refs/heads/${tree.branch}`);
  await f.finish(worker.id);
  await git(f.project, 'worktree', 'remove', '--force', tree.workspace); await git(f.project, 'branch', '-D', tree.branch);
  await git(f.project, 'branch', tree.branch, head);
  await f.close(worker.id); await f.restart();
  assert.equal(await git(f.project, 'rev-parse', `refs/heads/${tree.branch}`), head);
  const target = (await f.state(worker.id)).operations[0]?.targets.find(target => target.scope.resource.kind === 'worktree');
  assert.equal(target?.state, 'pending'); assert.match(target?.reason ?? '', /branch.*(generation|identity)/);
});

test('allocation branch generation permits normal Worker commits and packed refs before completion', async t => {
  const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app');
  if (tree.kind !== 'git-worktree') throw new Error('Expected worktree');
  for (let i = 0; i < 2; i++) {
    await writeFile(join(tree.workspace, 'source.txt'), `Worker commit ${i}`); await git(tree.workspace, 'add', '.'); await git(tree.workspace, 'commit', '-m', `Worker ${i}`);
  }
  await git(f.project, 'pack-refs', '--all');
  await f.finish(worker.id); await f.close(worker.id); await f.restart();
  assert.equal(await exists(tree.workspace), false);
  assert.equal(await git(f.project, 'for-each-ref', '--format=%(refname)', `refs/heads/${tree.branch}`), '');
  assert.ok((await f.state(worker.id)).operations[0]?.targets.every(target => target.state === 'removed'));
});

for (const mode of ['absent', 'replacement', 'symlink', 'missing-ref'] as const) test(`nested absence reconciles ${mode} with verified ancestors`, async t => {
  const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app');
  if (tree.kind !== 'git-worktree') throw new Error('Expected worktree');
  const parent = join(tree.workspace, 'build', 'outputs'); await mkdir(parent, { recursive: true });
  const allocated = z.object({ id: z.string() }).parse(await f.action({ action: 'allocate_artifacts', requestId: 'nested', parent, label: 'Nested output' }, worker.id));
  const scope = (await f.state(worker.id)).scopes.find(scope => scope.id === allocated.id); assert.ok(scope);
  await writeFile(join(scope.location.root.path, 'retained.txt'), 'nested');
  await f.finish(worker.id);
  if (mode !== 'missing-ref') await git(f.project, 'worktree', 'remove', '--force', tree.workspace);
  await git(f.project, 'update-ref', '-d', `refs/heads/${tree.branch}`);
  if (mode === 'replacement') { await mkdir(tree.workspace); await writeFile(join(tree.workspace, 'retained.txt'), 'replacement'); }
  if (mode === 'symlink') await symlink(f.project, tree.workspace);
  await f.close(worker.id); await f.restart();
  const state = await f.state(worker.id);
  if (mode === 'absent') {
    assert.ok(state.operations[0]?.targets.every(target => target.state === 'removed'));
    assert.equal(await exists(tree.workspace), false); assert.equal(await exists(scope.location.root.path), false);
    assert.equal(f.loop.store.task(worker.id).resources.some(resource => resource.id === tree.id), false);
  } else {
    assert.equal(state.operations[0]?.targets.find(target => target.scope.id === scope.id)?.state, 'pending');
    assert.equal(await exists(tree.workspace), true);
    if (mode === 'replacement') assert.equal(await readFile(join(tree.workspace, 'retained.txt'), 'utf8'), 'replacement');
    if (mode === 'missing-ref') assert.equal(await readFile(join(scope.location.root.path, 'retained.txt'), 'utf8'), 'nested');
  }
  assert.equal(await readFile(join(f.project, 'source.txt'), 'utf8'), 'original source');
});

for (const childLocation of ['original', 'disposal'] as const) test(`constructed interrupted parent disposal protects recreated nested ${childLocation} path`, async t => {
  const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app');
  if (tree.kind !== 'git-worktree') throw new Error('Expected worktree');
  const outer = z.object({ id: z.string(), location: z.object({ root: z.object({ path: z.string() }) }) }).parse(await f.action({ action: 'allocate_artifacts', requestId: 'outer', parent: tree.workspace, label: 'Outer build' }, worker.id));
  const innerParent = join(outer.location.root.path, 'deep', 'output'); await mkdir(innerParent, { recursive: true });
  const inner = z.object({ id: z.string(), location: z.object({ root: z.object({ path: z.string() }) }) }).parse(await f.action({ action: 'allocate_artifacts', requestId: 'inner', parent: innerParent, label: 'Inner output' }, worker.id));
  await f.close(worker.id);
  const state = await f.state(worker.id), child = state.operations[0]?.targets.find(target => target.scope.id === inner.id), parent = state.operations[0]?.targets.find(target => target.scope.id === outer.id);
  assert.ok(child); assert.ok(parent);
  await rm(inner.location.root.path, { recursive: true });
  child.state = 'removed'; child.directoryRemoved = true;
  f.loop.store.setMeta(`task-closeout:${worker.id}`, JSON.stringify(state));
  await rename(outer.location.root.path, parent.disposalPath);
  const oldPath = childLocation === 'original' ? child.scope.location.root.path : child.disposalPath;
  const replacement = join(parent.disposalPath, relative(outer.location.root.path, oldPath));
  await mkdir(replacement); await writeFile(join(replacement, 'replacement.txt'), 'not owned by completed child');
  await f.finish(worker.id); await f.restart();
  assert.equal(await readFile(join(replacement, 'replacement.txt'), 'utf8'), 'not owned by completed child');
  const targets = (await f.state(worker.id)).operations[0]?.targets; assert.ok(targets);
  assert.equal(targets.find(target => target.scope.id === outer.id)?.state, 'pending');
  assert.equal(targets.find(target => target.scope.resource.kind === 'worktree')?.state, 'pending');
});

test('unproven allocation branch generation retains worktree when reflogs were disabled', async t => {
  const f = await fixture(t), worker = await f.worker();
  await git(f.project, 'config', 'core.logAllRefUpdates', 'false');
  const tree = await f.loop.ensureWorkspace(worker.id, 'example/app');
  if (tree.kind !== 'git-worktree') throw new Error('Expected worktree');
  await writeFile(join(tree.workspace, 'retained.txt'), 'unproven ownership');
  await f.finish(worker.id); await f.close(worker.id); await f.restart();
  assert.equal(await readFile(join(tree.workspace, 'retained.txt'), 'utf8'), 'unproven ownership');
  const target = (await f.state(worker.id)).operations[0]?.targets.find(target => target.scope.resource.kind === 'worktree');
  assert.equal(target?.state, 'pending'); assert.match(target?.reason ?? '', /branch.*generation/);
});

test('constructed interrupted disposal preserves a new coordinator scope allocated at its actual location', async t => {
  const f = await fixture(t), tree = await f.loop.ensureWorkspace(f.coordinatorId, 'example/app');
  if (tree.kind !== 'git-worktree') throw new Error('Expected worktree');
  const outer = z.object({ id: z.string(), location: z.object({ root: z.object({ path: z.string() }) }) }).parse(await f.action({ action: 'allocate_artifacts', requestId: 'outer-batch', parent: tree.workspace, label: 'Completed batch' }));
  await f.action({ action: 'cleanup_artifacts', taskId: f.coordinatorId, requestId: 'close-batch', scopeIds: [outer.id] });
  const target = (await f.state(f.coordinatorId)).operations[0]?.targets.find(target => target.scope.id === outer.id); assert.ok(target);
  await rename(outer.location.root.path, target.disposalPath);
  const next = z.object({ location: z.object({ root: z.object({ path: z.string() }) }) }).parse(await f.action({ action: 'allocate_artifacts', requestId: 'next-batch', parent: target.disposalPath, label: 'New work' }));
  const file = join(next.location.root.path, 'retained.txt'); await writeFile(file, 'next coordinator work');
  await f.finish(f.coordinatorId); await f.restart();
  assert.equal(await readFile(file, 'utf8'), 'next coordinator work');
  const state = await f.state(f.coordinatorId);
  assert.equal(state.lifecycle.kind, 'open'); assert.equal(state.operations[0]?.targets[0]?.state, 'pending');
});

test('shutdown drains an in-flight cleanup sweep before closing its store', { timeout: 10_000 }, async t => {
  const f = await fixture(t), worker = await f.worker();
  assert.ok(worker.threadId);
  await f.close(worker.id);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const usage = f.codex.executionUse.bind(f.codex);
  f.codex.executionUse = async threadId => {
    if (threadId === worker.threadId) { entered(); await gate; }
    return usage(threadId);
  };
  const sweep = f.loop.tick();
  await started;
  let closed = false;
  const close = f.loop.close().then(() => { closed = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'shutdown must wait for cleanup that still owns the store');
  } finally {
    release();
    await Promise.all([sweep, close]);
  }
  await f.loop.tick();
});

test('completion preserves bytes, scopes and running turns; retries keep immutable history', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id);
  const file = join(scope.location.root.path, 'evidence.bin'); await writeFile(file, 'retained bytes');
  const first = await f.complete(worker.id); assert.deepEqual(await f.complete(worker.id), first);
  await f.loop.tick(); await f.restart();
  const state = await f.state(worker.id);
  assert.equal(await readFile(file, 'utf8'), 'retained bytes'); assert.equal(state.scopes[0]?.sealed, false);
  assert.equal(state.operations.length, 0); assert.equal(state.completionHistory.length, 1);
  assert.equal(f.codex.interrupts.length, 0); assert.equal(f.loop.store.task(worker.id).threadId, worker.threadId);
});

test('paused completion keeps new input through restart and continues only after explicit resume', async t => {
  const f = await fixture(t), worker = await f.worker();
  await f.action({ action: 'open_group', taskId: worker.id, requestId: 'open-paused' });
  await f.loop.control(worker.id, 'pause'); await f.complete(worker.id);
  const before = f.loop.store.task(worker.id); assert.ok(before.chatId);
  const message = { id: 'paused-after-completion', chatId: before.chatId, senderId: 'owner', chatType: 'group' as const, text: 'Continue after the pause', attachments: [], createdAt: Date.now() };
  await f.loop.receive(message); await f.restart(); await f.loop.tick();
  assert.equal(f.loop.store.task(worker.id).status, 'paused');
  assert.equal([...f.codex.starts, ...f.codex.steers].filter(input => input.deliveryId === message.id).length, 0);
  await f.loop.control(worker.id, 'resume');
  const after = f.loop.store.task(worker.id);
  assert.equal(after.threadId, before.threadId); assert.equal(after.chatId, before.chatId); assert.deepEqual(after.workerExecution, before.workerExecution);
  assert.equal(f.loop.store.inputs(worker.id).find(input => input.id === message.id)?.status, 'delivered');
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'open'); assert.equal((await f.state(worker.id)).completionHistory.length, 1);
});

test('an Agent instruction continues a completed Worker and preserves historical completion on retries', async t => {
  const f = await fixture(t), worker = await f.worker(); await f.finish(worker.id); await f.complete(worker.id);
  const send = { tool: 'send_agent_message' as const, arguments: { requestId: 'continued-agent-message', taskId: worker.id, text: 'Inspect the retained result' } };
  await f.loop.projectCall(f.coordinatorId, send); await f.loop.tick(); await f.loop.projectCall(f.coordinatorId, send); await f.loop.tick();
  await eventually(() => assert.equal(f.loop.store.inputs(worker.id).find(input => input.provenance.kind === 'agent_message')?.status, 'delivered'));
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'open'); assert.equal((await f.state(worker.id)).completionHistory.length, 1);
  const delivered = f.loop.store.inputs(worker.id).filter(input => input.provenance.kind === 'agent_message' && input.provenance.requestId === send.arguments.requestId);
  assert.equal(delivered.length, 1); assert.equal(delivered[0]?.status, 'delivered');
  assert.equal(f.loop.store.task(worker.id).threadId, worker.threadId);
  await f.complete(worker.id); assert.equal((await f.state(worker.id)).lifecycle.kind, 'open');
});

test('input accepted during cleanup waits, then continues the same Worker with actual removed resource state', { timeout: 10_000 }, async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id);
  await f.action({ action: 'open_group', taskId: worker.id, requestId: 'open-cleaning' });
  await f.finish(worker.id); await f.complete(worker.id);
  const before = f.loop.store.task(worker.id); assert.ok(before.chatId);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const usage = f.codex.executionUse.bind(f.codex);
  f.codex.executionUse = async threadId => { if (threadId === worker.threadId) { entered(); await gate; } return usage(threadId); };
  const cleanup = f.cleanup(worker.id, [scope.id]); await started;
  const message = { id: 'during-cleanup', chatId: before.chatId, senderId: 'owner', chatType: 'group' as const, text: 'Inspect the result after cleanup', attachments: [], createdAt: Date.now() };
  try {
    await f.loop.receive(message);
    assert.equal(f.loop.store.inputs(worker.id).find(input => input.id === message.id)?.status, 'pending');
    assert.equal(f.codex.starts.some(input => input.deliveryId === message.id), false);
  } finally { release(); await cleanup; }
  await f.loop.tick();
  const delivered = f.codex.starts.find(input => input.deliveryId === message.id); assert.ok(delivered);
  assert.equal(delivered.threadId, before.threadId); assert.match(delivered.additionalContext ?? '', /"state":"removed"/);
  assert.equal(await exists(scope.location.root.path), false); assert.equal((await f.state(worker.id)).completionHistory.length, 1);
});

test('blocked cleanup permits new work; a cleaned worktree gets a new persisted generation immune to old cleanup', async t => {
  const f = await fixture(t), worker = await f.worker();
  const original = await f.loop.ensureWorkspace(worker.id, 'example/app'); assert.equal(original.kind, 'git-worktree');
  const scopes = (await f.state(worker.id)).scopes.map(scope => scope.id);
  await f.complete(worker.id); await f.cleanup(worker.id, scopes);
  await f.loop.projectCall(f.coordinatorId, { tool: 'send_agent_message', arguments: { taskId: worker.id, requestId: 'while-cleanup-blocked', text: 'Continue while your active turn protects its files' } });
  await f.loop.tick();
  await eventually(() => assert.ok(f.codex.steers.some(input => input.threadId === worker.threadId && input.input.some(part => part.kind === 'text' && part.text.includes('active turn protects')))));
  await f.finish(worker.id); await f.loop.tick(); assert.equal(await exists(original.workspace), false);
  const replacement = await f.loop.ensureWorkspace(worker.id, 'example/app'); assert.equal(replacement.kind, 'git-worktree');
  assert.notEqual(replacement.id, original.id); assert.notEqual(replacement.workspace, original.workspace);
  if (replacement.kind !== 'git-worktree' || original.kind !== 'git-worktree') throw new Error('Expected worktrees');
  assert.notEqual(replacement.branch, original.branch);
  await writeFile(join(replacement.workspace, 'preserve.txt'), 'new generation');
  await f.cleanup(worker.id, scopes); await f.loop.closeout.progress(worker.id); await f.restart();
  assert.equal(await readFile(join(replacement.workspace, 'preserve.txt'), 'utf8'), 'new generation');
  assert.equal((await f.loop.ensureWorkspace(worker.id, 'example/app')).id, replacement.id);
  assert.equal(f.loop.store.task(worker.id).resources.some(resource => resource.id === original.id), false);
});

for (const interrupted of [false, true]) test(`legacy implicit cleanup migration retains ${interrupted ? 'renamed' : 'untouched'} resources without waking history`, async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id);
  const file = join(scope.location.root.path, 'legacy.txt'); await writeFile(file, 'legacy bytes');
  await f.close(worker.id);
  const old = await f.state(worker.id), operation = old.operations[0]; assert.ok(operation);
  const target = operation.targets.find(item => item.scope.id === scope.id); assert.ok(target);
  if (interrupted) await rename(scope.location.root.path, target.disposalPath);
  const retainedPath = interrupted ? join(target.disposalPath, 'legacy.txt') : file;
  const legacyInput = { id: 'old-pending-input', chatId: '', senderId: 'owner', chatType: 'group' as const, text: 'Historical pending message', attachments: [], createdAt: worker.createdAt };
  f.loop.store.receive(worker.id, legacyInput);
  operation.kind = 'completion';
  if (old.lifecycle.kind !== 'completed') throw new Error('Expected completion');
  old.lifecycle.operationId = operation.id;
  const { version: _version, completionHistory: _history, ...legacy } = old;
  const { inboxSequence: _sequence, ...completion } = old.lifecycle;
  f.loop.store.setMeta(`task-closeout:${worker.id}`, JSON.stringify({ ...legacy, lifecycle: completion }));
  assert.ok(worker.threadId); f.codex.complete(worker.threadId, null);
  const starts = f.codex.starts.length;
  await f.restart(); await f.loop.tick(); await f.restart();
  const migrated = await f.state(worker.id);
  assert.equal(await readFile(retainedPath, 'utf8'), 'legacy bytes');
  assert.equal(migrated.lifecycle.kind, 'completed'); assert.equal(migrated.completionHistory.length, 1);
  assert.equal(migrated.operations[0]?.targets[0]?.state, 'retained'); assert.equal(f.codex.starts.length, starts);
  await f.cleanup(worker.id, [scope.id], 'explicit-after-migration');
  assert.equal(await exists(retainedPath), false);
  assert.equal((await f.state(worker.id)).operations[1]?.targets[0]?.state, 'removed');
  await f.loop.projectCall(f.coordinatorId, { tool: 'send_agent_message', arguments: { taskId: worker.id, requestId: 'after-legacy-migration', text: 'Continue with new work' } });
  await f.loop.tick();
  await eventually(() => assert.equal(f.loop.store.inputs(worker.id).find(input => input.provenance.kind === 'agent_message')?.status, 'delivered'));
  await f.finish(worker.id); await f.action(f.completeAction(worker.id, 'complete-new-cycle'));
  await f.restart(); await f.loop.tick();
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'completed');
  assert.equal((await f.state(worker.id)).completionHistory.length, 2);
  assert.equal(f.loop.store.inputs(worker.id).find(input => input.id === legacyInput.id)?.status, 'pending');
  assert.equal([...f.codex.starts, ...f.codex.steers].some(input => input.deliveryId === legacyInput.id), false);
});

test('legacy partial worktree cleanup preserves its branch until a new explicit cleanup and cannot affect its replacement', async t => {
  const f = await fixture(t), worker = await f.worker();
  const tree = await f.loop.ensureWorkspace(worker.id, 'example/app'); if (tree.kind !== 'git-worktree') throw new Error('Expected worktree');
  await f.close(worker.id);
  const state = await f.state(worker.id), operation = state.operations[0]; assert.ok(operation);
  const target = operation.targets.find(item => item.scope.resource.kind === 'worktree'); assert.ok(target);
  await git(f.project, 'worktree', 'remove', '--force', '--', tree.workspace);
  operation.kind = 'completion';
  if (state.lifecycle.kind !== 'completed') throw new Error('Expected completion');
  state.lifecycle.operationId = operation.id;
  const { version: _version, completionHistory: _history, ...legacy } = state;
  const { inboxSequence: _sequence, ...completion } = state.lifecycle;
  f.loop.store.setMeta(`task-closeout:${worker.id}`, JSON.stringify({ ...legacy, lifecycle: completion }));
  assert.ok(worker.threadId); f.codex.complete(worker.threadId, null);
  await f.restart();
  assert.notEqual(await git(f.project, 'for-each-ref', '--format=%(refname)', `refs/heads/${tree.branch}`), '');
  assert.equal(f.loop.store.task(worker.id).resources.some(resource => resource.id === tree.id), false);
  const replacement = await f.loop.ensureWorkspace(worker.id, 'example/app');
  await writeFile(join(replacement.workspace, 'keep.txt'), 'replacement bytes');
  await f.cleanup(worker.id, [target.scope.id], 'explicit-partial-worktree');
  assert.equal(await git(f.project, 'for-each-ref', '--format=%(refname)', `refs/heads/${tree.branch}`), '');
  assert.equal(await readFile(join(replacement.workspace, 'keep.txt'), 'utf8'), 'replacement bytes');
});

test('dashboard displays completion history independently of explicit resource cleanup', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id);
  await f.finish(worker.id); await f.complete(worker.id);
  const reader = new ProjectDashboardReader(f.loop.store);
  const before = (await reader.taskDetail(worker.id))?.task; assert.ok(before);
  assert.equal(before.completion.kind, 'completed'); assert.equal(before.completionHistory.length, 1); assert.deepEqual(before.cleanup, []);
  await f.cleanup(worker.id, [scope.id]);
  const after = (await reader.taskDetail(worker.id))?.task; assert.ok(after);
  assert.deepEqual(after.completionHistory, before.completionHistory); assert.equal(after.cleanup[0]?.state, 'removed');
});

test('shutdown waits for an explicit cleanup tool still holding the resource admission', { timeout: 10_000 }, async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id); await f.finish(worker.id);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const usage = f.codex.executionUse.bind(f.codex);
  f.codex.executionUse = async threadId => { if (threadId === worker.threadId) { entered(); await gate; } return usage(threadId); };
  const cleanup = f.cleanup(worker.id, [scope.id]); await started;
  let closed = false; const closing = f.loop.close().then(() => { closed = true; });
  try { await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false); }
  finally { release(); await cleanup; await closing; }
  assert.equal(await exists(scope.location.root.path), false);
});

test('ensure_workspace replaces a resource whose interrupted release finishes during acquisition', async t => {
  const f = await fixture(t), worker = await f.worker();
  const original = await f.loop.ensureWorkspace(worker.id, 'example/app');
  f.loop.store.setMeta(`released-resource:${worker.id}:${original.id}`, 'releasing');
  const replacement = await f.loop.ensureWorkspace(worker.id, 'example/app');
  assert.notEqual(replacement.id, original.id); assert.equal(await exists(original.workspace), false);
  assert.equal(await exists(replacement.workspace), true);
  assert.deepEqual(f.loop.store.task(worker.id).resources.map(resource => resource.id), [replacement.id]);
});

async function eventually(assertion: () => void) {
  for (let attempt = 0; ; attempt++) {
    try { assertion(); return; } catch (error) {
      if (attempt === 100) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }
}

test('a due self-reminder continues completed work on its original Thread without losing completion history', async t => {
  const f = await fixture(t), worker = await f.worker(), dueAt = Date.now() + 60_000;
  await f.action({ action: 'schedule_reminder', requestId: 'completed-followup', dueAt, text: 'Check the retained result' }, worker.id);
  await f.finish(worker.id); await f.complete(worker.id);
  t.mock.method(Date, 'now', () => dueAt);
  await f.loop.tick();
  const reminder = f.loop.store.inputs(worker.id).find(input => input.provenance.kind === 'reminder');
  assert.ok(reminder); assert.equal(reminder.status, 'delivered');
  assert.equal(f.loop.store.task(worker.id).threadId, worker.threadId);
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'open');
  assert.equal((await f.state(worker.id)).completionHistory.length, 1);
  await f.loop.tick();
  assert.equal(f.codex.starts.filter(input => input.deliveryId === reminder.id).length, 1);
});

for (const source of ['agent', 'reminder'] as const) test(`fresh ${source} input continues a failed Worker with automatic retries disabled`, async t => {
  const f = await fixture(t, 0), worker = await f.worker(); assert.ok(worker.threadId);
  const dueAt = Date.now() + 60_000;
  if (source === 'reminder') await f.action({ action: 'schedule_reminder', requestId: 'failed-followup', dueAt, text: 'Inspect after the failed turn' }, worker.id);
  const snapshot = f.codex.snapshot(worker.threadId); snapshot.status = 'failed'; snapshot.error = 'Controlled backend failure';
  await f.loop.tick(); assert.equal(f.loop.store.task(worker.id).status, 'failed');
  if (source === 'agent') await f.loop.projectCall(f.coordinatorId, { tool: 'send_agent_message', arguments: { requestId: 'failed-followup', taskId: worker.id, text: 'Continue after the failed turn' } });
  else t.mock.method(Date, 'now', () => dueAt);
  await f.loop.tick();
  await eventually(() => assert.equal(f.loop.store.inputs(worker.id).find(input => input.provenance.kind === (source === 'agent' ? 'agent_message' : 'reminder'))?.status, 'delivered'));
  assert.equal(f.loop.store.task(worker.id).status, 'running'); assert.equal(f.loop.store.task(worker.id).threadId, worker.threadId);
  const input = f.loop.store.inputs(worker.id).find(input => input.provenance.kind === (source === 'agent' ? 'agent_message' : 'reminder')); assert.ok(input);
  await f.loop.tick(); assert.equal(f.codex.starts.filter(start => start.deliveryId === input.id).length, 1);
});

for (const source of ['user', 'agent', 'reminder'] as const) test(`${source} input queued before paused completion survives restart and explicit resume`, async t => {
  const f = await fixture(t), worker = await f.worker();
  await f.action({ action: 'open_group', taskId: worker.id, requestId: 'open-queued-before-completion' });
  const before = f.loop.store.task(worker.id); assert.ok(before.chatId);
  const dueAt = Date.now() + 60_000;
  if (source === 'reminder') await f.action({ action: 'schedule_reminder', requestId: 'queued-before-completion', dueAt, text: 'Queued before completion' }, worker.id);
  await f.loop.control(worker.id, 'pause');
  if (source === 'user') await f.loop.receive({ id: 'queued-before-completion', chatId: before.chatId, senderId: 'owner', chatType: 'group', text: 'Queued before completion', attachments: [], createdAt: Date.now() });
  else if (source === 'agent') await f.loop.projectCall(f.coordinatorId, { tool: 'send_agent_message', arguments: { requestId: 'queued-before-completion', taskId: worker.id, text: 'Queued before completion' } });
  else t.mock.method(Date, 'now', () => dueAt);
  await f.loop.tick();
  const queued = f.loop.store.inputs(worker.id).find(input => input.provenance.kind === (source === 'agent' ? 'agent_message' : source)); assert.ok(queued);
  await eventually(() => assert.equal(f.loop.store.inputs(worker.id).find(input => input.id === queued.id)?.status, 'held'));
  await f.complete(worker.id); await f.restart(); await f.loop.tick();
  assert.equal(f.loop.store.task(worker.id).status, 'paused'); assert.equal(f.loop.store.inputs(worker.id).find(input => input.id === queued.id)?.status, 'held');
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'completed');
  assert.equal(f.codex.starts.some(start => start.deliveryId === queued.id), false);
  await f.loop.control(worker.id, 'resume'); await f.loop.tick();
  await eventually(() => assert.equal(f.loop.store.inputs(worker.id).find(input => input.id === queued.id)?.status, 'delivered'));
  const after = f.loop.store.task(worker.id);
  assert.equal(after.threadId, before.threadId); assert.equal(after.chatId, before.chatId); assert.deepEqual(after.workerExecution, before.workerExecution);
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'open'); assert.equal((await f.state(worker.id)).completionHistory.length, 1);
  assert.equal(f.codex.starts.filter(start => start.deliveryId === queued.id).length, 1);
  await f.finish(worker.id);
  await f.action(f.completeAction(worker.id, 'complete-after-queued-delivery'));
  await f.restart(); await f.loop.tick();
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'completed');
  assert.equal((await f.state(worker.id)).completionHistory.length, 2);
  assert.equal(f.codex.starts.filter(start => start.deliveryId === queued.id).length, 1);
});

test('a new owner receipt with an old provider timestamp continues completed work once', async t => {
  const f = await fixture(t), worker = await f.worker();
  await f.action({ action: 'open_group', taskId: worker.id, requestId: 'delayed-owner' });
  const before = f.loop.store.task(worker.id); assert.ok(before.chatId);
  await f.finish(worker.id); await f.complete(worker.id);
  const message = { id: 'delayed-owner', chatId: before.chatId, senderId: 'owner', chatType: 'group' as const, text: 'A delayed new message', attachments: [], createdAt: worker.createdAt - 60_000 };
  await f.loop.receive(message); await f.loop.receive(message); await f.loop.tick();
  assert.equal(f.loop.store.inputs(worker.id).find(input => input.id === message.id)?.status, 'delivered');
  assert.equal(f.loop.store.task(worker.id).threadId, before.threadId); assert.equal((await f.state(worker.id)).lifecycle.kind, 'open');
  assert.equal((await f.state(worker.id)).completionHistory.length, 1); assert.equal(f.codex.starts.filter(start => start.deliveryId === message.id).length, 1);
});
