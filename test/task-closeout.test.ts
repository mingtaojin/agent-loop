import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { CodexPort } from '../src/ports.js';
import { z } from 'zod';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import { taskCloseoutSchema } from '../src/task-closeout.js';
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
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'closeout-runtime-'))), project = join(root, 'project'), data = join(root, 'data');
  await mkdir(project);
  await git(project, 'init', '-b', 'main'); await git(project, 'config', 'user.email', 'fixture@example.test'); await git(project, 'config', 'user.name', 'Fixture');
  await writeFile(join(project, 'source.txt'), 'original source'); await git(project, 'add', '.'); await git(project, 'commit', '-m', 'initial');
  const config = configSchema.parse({ dataDir: data, feishu: { userOpenId: 'owner' },
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
    async worker() { const result = z.object({ taskId: z.string() }).parse(await action({ action: 'dispatch', requestId: `dispatch-${++request}`, prompt: 'Do fixture work', role: 'worker' })); await loop.tick(); return loop.store.task(result.taskId); },
    async scope(taskId: string) { const value = (await state(taskId)).scopes.find(scope => scope.resource.kind === 'artifacts'); assert.ok(value); return value; },
    async complete(taskId: string) { return receipt.parse(await action(completeAction(taskId))); },
    async restart() { await loop.close(); loop = new AgentLoop(config, ports); await loop.recover(); },
  };
}

test('closeout removes actual default artifacts, retains records and originals, and replays one stable operation', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id);
  await writeFile(join(scope.location.root.path, 'evidence.mp4'), 'large generated evidence');
  const attachment = join(f.data, 'attachments', worker.id, 'original.txt'); await mkdir(join(f.data, 'attachments', worker.id), { recursive: true }); await writeFile(attachment, 'user original');
  await f.finish(worker.id);
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'open'); assert.equal(await exists(scope.location.root.path), true);
  const first = await f.complete(worker.id); assert.deepEqual(await f.complete(worker.id), first);
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
  await f.complete(worker.id); assert.equal((await f.state(worker.id)).operations[0]?.targets[0]?.state, 'pending');
  assert.equal(await exists(path), true); assert.equal(f.codex.interrupts.length, 0);
  const threadId = worker.threadId; assert.ok(threadId); f.codex.complete(threadId, null);
  f.codex.inspectError = new Error('usage unavailable'); await f.loop.tick(); assert.equal(await exists(path), true); f.codex.inspectError = null;
  const child = spawn(process.execPath, ['-e', "require('node:fs').openSync('in-use.txt', 'r'); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { cwd: path, stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child.stdout, 'data');
  t.after(() => { child.kill(); });
  await f.loop.tick(); assert.equal(await exists(path), true); assert.match((await f.state(worker.id)).operations[0]?.targets[0]?.reason ?? '', /process/i); assert.equal(child.exitCode, null);
  child.kill(); await once(child, 'exit'); await f.loop.tick(); assert.equal(await exists(path), false);
});

test('completion rejects authoritative native requests even before stale Task snapshots observe them', async t => {
  for (const kind of ['approval', 'question', 'permissions', 'unsupported'] as const) {
    const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id); assert.ok(worker.threadId);
    const snapshot = f.codex.snapshot(worker.threadId); assert.ok(snapshot.turnId);
    snapshot.requests = [{ id: `outstanding-${kind}`, threadId: worker.threadId, turnId: snapshot.turnId, kind,
      prompt: 'Unresolved request', method: kind, payload: {}, isBlocking: false, connectionEpoch: 'fixture' }];
    assert.equal(f.loop.store.task(worker.id).requests.length, 0);
    await assert.rejects(f.complete(worker.id), /native request/);
    const state = await f.state(worker.id); assert.equal(state.lifecycle.kind, 'open'); assert.equal(state.operations.length, 0);
    assert.equal(await exists(scope.location.root.path), true); assert.equal(snapshot.requests.length, 1);
  }
});

test('native requests arriving during resource discovery reject the final completion transaction', async t => {
  const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app'); assert.ok(worker.threadId);
  const snapshot = f.codex.snapshot(worker.threadId); assert.ok(snapshot.turnId);
  const request = { id: 'discovery-race', threadId: worker.threadId, turnId: snapshot.turnId, kind: 'approval' as const,
    prompt: 'Late approval', method: 'approval', payload: {}, isBlocking: true, connectionEpoch: 'fixture' };
  const completion = f.complete(worker.id); queueMicrotask(() => { snapshot.requests = [request]; });
  await assert.rejects(completion, /native request/);
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'open'); assert.equal((await f.state(worker.id)).operations.length, 0);
  assert.equal(await exists(tree.workspace), true);
});

test('threaded completion fails closed when the provider lacks native request protection', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id);
  Object.defineProperty(f.codex, 'assertThreadCompletionAllowed', { value: undefined });
  await assert.rejects(f.complete(worker.id), /protection is unavailable/);
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'open'); assert.equal(await exists(scope.location.root.path), true);
});

test('completed tasks deny late native requests without execution and retain uncertain cleanup until resolution', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id); assert.ok(worker.threadId);
  const starts = f.codex.starts.length, steers = f.codex.steers.length;
  await f.complete(worker.id);
  const snapshot = f.codex.snapshot(worker.threadId); assert.ok(snapshot.turnId);
  for (const kind of ['approval', 'question'] as const) {
    snapshot.requests = [{ id: `late-${kind}`, threadId: worker.threadId, turnId: snapshot.turnId, kind,
      prompt: 'Late request', method: kind, payload: {}, isBlocking: true, connectionEpoch: 'fixture' }];
    f.codex.uncertainNativeDenial = true;
    await f.loop.tick();
    assert.equal(await exists(scope.location.root.path), true); assert.equal(snapshot.requests.length, 1);
    assert.equal((await f.state(worker.id)).operations[0]?.targets[0]?.state, 'pending');
    f.codex.uncertainNativeDenial = false; await f.loop.tick(); assert.equal(snapshot.requests.length, 0);
  }
  assert.deepEqual(f.codex.nativeDenials.map(request => request.kind), ['approval', 'question']);
  assert.equal(f.codex.approvals.length, 0); assert.equal(f.codex.replies.length, 0); assert.equal(f.codex.interrupts.length, 0);
  assert.equal(f.codex.starts.length, starts); assert.equal(f.codex.steers.length, steers);
  f.codex.complete(worker.threadId, null); await f.restart(); assert.equal(await exists(scope.location.root.path), false);
});

test('unique delivery holds survive completion and only matching authorized delivery releases them', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id), file = join(scope.location.root.path, 'only.zip');
  await writeFile(file, 'only deliverable');
  await f.action({ action: 'register_artifact', requestId: 'hold', scopeId: scope.id, path: file, disposition: 'undelivered' }, worker.id);
  await f.finish(worker.id); await f.complete(worker.id);
  assert.equal((await f.state(worker.id)).operations[0]?.targets[0]?.state, 'protected'); assert.equal(await exists(file), true);
  await f.action({ action: 'register_artifact', requestId: 'delivered', taskId: worker.id, scopeId: scope.id, path: file, disposition: 'delivered', reference: 'https://example.test/download' });
  await f.loop.tick(); assert.equal(await exists(file), false);
});

test('delivery status cannot release a replacement file and arbitrary external paths cannot be adopted', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id), file = join(scope.location.root.path, 'only.zip');
  await writeFile(file, 'original'); await f.action({ action: 'register_artifact', requestId: 'hold', scopeId: scope.id, path: file, disposition: 'undelivered' }, worker.id);
  await rename(file, `${file}.old`); await writeFile(file, 'replacement');
  await assert.rejects(f.action({ action: 'register_artifact', requestId: 'replacement', scopeId: scope.id, path: file, disposition: 'delivered', reference: 'https://example.test/new' }, worker.id), /identity changed/);
  await assert.rejects(f.action({ action: 'register_artifact', requestId: 'claim-source', scopeId: scope.id, path: join(f.project, 'source.txt'), disposition: 'temporary' }, worker.id), /outside/);
  await assert.rejects(f.action({ action: 'allocate_artifacts', requestId: 'bad-parent', parent: f.root, label: 'claim external' }, worker.id), /parent/);
  await f.finish(worker.id); await f.complete(worker.id); assert.equal(await readFile(file, 'utf8'), 'replacement');
});

test('root replacement, symlink retargeting and ancestor replacement never inherit deletion authority', async t => {
  for (const mode of ['root', 'symlink', 'ancestor']) {
    const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id), path = scope.location.root.path;
    await f.finish(worker.id);
    if (mode === 'ancestor') { await rename(worker.contextDirectory, `${worker.contextDirectory}.old`); await mkdir(path, { recursive: true }); }
    else { await rename(path, `${path}.old`); if (mode === 'symlink') await symlink(f.project, path); else await mkdir(path); }
    await f.complete(worker.id);
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
  await f.finish(worker.id); await f.complete(worker.id);
  assert.equal(await exists(tree.workspace), false); assert.equal(await git(f.project, 'for-each-ref', '--format=%(refname)', `refs/heads/${tree.branch}`), '');
  assert.equal((await f.state(worker.id)).operations[0]?.targets.find(target => target.scope.resource.kind === 'worktree')?.branchRemoved, true);
  assert.equal(await readFile(join(f.project, 'source.txt'), 'utf8'), 'original source');
});

test('completion reconciles a previously removed owned worktree and branch with one durable receipt', async t => {
  const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app');
  if (tree.kind !== 'git-worktree') throw new Error('Expected real worktree');
  await f.finish(worker.id);
  await git(f.project, 'worktree', 'remove', '--force', tree.workspace); await git(f.project, 'branch', '-D', tree.branch);
  const completed = await f.complete(worker.id), state = await f.state(worker.id);
  assert.equal(state.lifecycle.kind, 'completed'); assert.equal(state.operations.length, 1);
  assert.ok(state.operations[0]?.targets.every(target => target.state === 'removed'));
  const target = state.operations[0]?.targets.find(target => target.scope.resource.kind === 'worktree'); assert.ok(target);
  assert.equal(target.directoryRemoved, true); assert.equal(target.branchRemoved, true);
  assert.equal(await exists(tree.workspace), false);
  assert.equal(await git(f.project, 'for-each-ref', '--format=%(refname)', `refs/heads/${tree.branch}`), '');
  assert.equal((await git(f.project, 'worktree', 'list', '--porcelain', '-z')).split('\0').includes(`worktree ${tree.workspace}`), false);
  assert.equal(f.loop.store.task(worker.id).resources.some(resource => resource.id === tree.id), false);
  await f.restart(); assert.deepEqual(await f.complete(worker.id), completed);
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
    await f.complete(worker.id);
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
  await f.complete(worker.id);
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
    await f.complete(worker.id);
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
  await f.finish(worker.id); await f.complete(worker.id); assert.equal(await exists(tree.workspace), false);
  assert.notEqual(await git(f.project, 'for-each-ref', '--format=%(refname)', `refs/heads/${tree.branch}`), '');
  await rm(lock); await f.restart(); assert.equal(await git(f.project, 'for-each-ref', '--format=%(refname)', `refs/heads/${tree.branch}`), '');
  assert.ok((await f.state(worker.id)).operations[0]?.targets.every(target => target.state === 'removed'));
});

test('shared associations and another task scope protect their actual contents', async t => {
  const f = await fixture(t), first = await f.worker(), second = await f.worker(), tree = await f.loop.ensureWorkspace(first.id, 'example/app');
  const saved = f.loop.store.task(second.id); saved.resources.push(tree); f.loop.store.saveTask(saved);
  await writeFile(join(tree.workspace, 'shared.txt'), 'still used'); await f.finish(first.id); await f.complete(first.id);
  assert.equal(await readFile(join(tree.workspace, 'shared.txt'), 'utf8'), 'still used');
  assert.match((await f.state(first.id)).operations[0]?.targets.find(target => target.scope.resource.kind === 'worktree')?.reason ?? '', /another task/);
  assert.equal((await f.state(second.id)).lifecycle.kind, 'open');
});

test('completed followups retain original provenance and create no automatic execution; explicit dispatch links fresh task', async t => {
  const f = await fixture(t), worker = await f.worker();
  await f.action({ action: 'open_group', requestId: 'group', taskId: worker.id }); const chatId = f.loop.store.task(worker.id).chatId; assert.ok(chatId);
  await f.finish(worker.id); await f.complete(worker.id); const starts = f.codex.starts.filter(start => start.threadId === worker.threadId).length;
  const message = { id: 'follow-up', chatId, senderId: 'owner', chatType: 'group' as const, text: 'What was delivered?', attachments: [], createdAt: Date.now() };
  await f.loop.receive(message); await f.loop.receive(message);
  f.feishu.offline = [{ ...message, id: 'offline-follow-up', text: 'Please add another output' }];
  await f.restart(); await f.loop.tick();
  const forwarded = f.loop.store.inputs(f.coordinatorId).filter(input => input.id.startsWith(`completed-followup:${worker.id}:`));
  assert.equal(forwarded.length, 2); assert.deepEqual(forwarded[0]?.provenance, { kind: 'user', message });
  assert.equal(f.loop.tasks().length, 2); assert.equal(f.codex.starts.filter(start => start.threadId === worker.threadId).length, starts);
  await assert.rejects(f.loop.control(worker.id, 'resume'), /completed/); await assert.rejects(f.loop.ensureWorkspace(worker.id, 'example/app'), /completed/);
  await assert.rejects(f.action({ action: 'send', requestId: 'old-send', taskId: worker.id, text: 'continue' }), /completed/);
  const newTask = z.object({ taskId: z.string() }).parse(await f.action({ action: 'dispatch', requestId: 'follow-new', predecessorTaskId: worker.id, prompt: 'New output', role: 'worker' }));
  assert.equal((await f.state(newTask.taskId)).predecessorTaskId, worker.id); assert.notEqual((await f.scope(newTask.taskId)).location.root.path, (await f.scope(worker.id)).location.root.path);
  assert.match(f.loop.store.inputs(newTask.taskId)[0]?.message.text ?? '', /Delivered result/);
});

test('completed-task followups cannot answer coordinator native questions while direct group replies can', async t => {
  const f = await fixture(t), worker = await f.worker();
  await f.action({ action: 'open_group', requestId: 'group', taskId: worker.id });
  const workerChat = f.loop.store.task(worker.id).chatId; assert.ok(workerChat);
  await f.finish(worker.id); await f.complete(worker.id);
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
  assert.equal(forwarded.length, 1); assert.equal(forwarded[0]?.status, 'delivered');
  assert.deepEqual(forwarded[0]?.provenance, { kind: 'user', message: followup });
  assert.ok(f.codex.steers.some(input => input.deliveryId === forwarded[0]?.id && input.input.some(item => item.kind === 'text' && item.text.includes(followup.text))));
  await f.loop.receive({ id: 'direct-answer', chatId: coordinator.chatId, senderId: 'owner', chatType: 'group',
    text: 'Use the QA target', attachments: [], createdAt: Date.now() });
  await f.loop.tick();
  assert.deepEqual(f.codex.replies.map(input => [input.request.id, input.text]), [[request.id, 'Use the QA target']]);
});

test('forwarded followup attachments use the original Feishu message identity and deduplicate delivery', async t => {
  const f = await fixture(t), worker = await f.worker();
  await f.action({ action: 'open_group', requestId: 'group', taskId: worker.id });
  const chatId = f.loop.store.task(worker.id).chatId; assert.ok(chatId);
  await f.finish(worker.id); await f.complete(worker.id);
  const message = { id: 'original-feishu-message', chatId, senderId: 'owner', chatType: 'group' as const,
    text: 'Use the attached log for the followup', attachments: [{ kind: 'file' as const, key: 'followup-log', name: 'followup.log' }], createdAt: Date.now() };
  f.feishu.resources.set('followup-log', Buffer.from('original followup log'));
  const download = f.feishu.download.bind(f.feishu);
  f.feishu.download = async input => { assert.equal(input.messageId, message.id, 'Feishu resource lookup requires its original message ID'); await download(input); };
  await f.loop.receive(message); await f.loop.receive(message); await f.loop.tick();
  const forwardedId = `completed-followup:${worker.id}:${message.id}`;
  const forwarded = f.loop.store.inputs(f.coordinatorId).find(input => input.id === forwardedId); assert.ok(forwarded);
  assert.equal(forwarded.status, 'delivered'); assert.equal(f.feishu.downloads.length, 1);
  assert.equal(f.feishu.downloads[0]?.messageId, message.id);
  assert.deepEqual(forwarded.provenance, { kind: 'user', message });
  const directory = join(f.data, 'attachments', f.coordinatorId), files = await readdir(directory, { recursive: true });
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
  await assert.rejects(f.complete(worker.id), /Lost cleanup acknowledgement/); assert.equal(await exists(scope.location.root.path), false);
  assert.equal((await f.state(worker.id)).operations[0]?.targets[0]?.state, 'pending');
  await f.restart(); const result = await f.complete(worker.id); assert.equal(result.operationId, (await f.state(worker.id)).operations[0]?.id);
  assert.equal((await f.state(worker.id)).operations[0]?.targets[0]?.state, 'removed');
});

test('allocation reservation prevents incomplete closeout snapshots and later scopes do not inherit old cleanup', async t => {
  const f = await fixture(t), worker = await f.worker(); await f.finish(worker.id);
  const original = f.workspace.ensure.bind(f.workspace); let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.workspace.ensure = async input => { if (input.kind === 'git-worktree') { entered(); await gate; } return original(input); };
  const acquire = f.loop.ensureWorkspace(worker.id, 'example/app'); await started;
  await assert.rejects(f.complete(worker.id), /in flight/); assert.equal((await f.state(worker.id)).lifecycle.kind, 'open'); release(); await acquire;
  await f.complete(worker.id); assert.ok((await f.state(worker.id)).operations[0]?.targets.some(target => target.scope.resource.kind === 'worktree'));
  const next = await f.worker(), nextScope = await f.scope(next.id); await writeFile(join(nextScope.location.root.path, 'new.txt'), 'new task');
  await f.complete(worker.id); assert.equal(await readFile(join(nextScope.location.root.path, 'new.txt'), 'utf8'), 'new task');
});

test('coordinator scopes close after its turn without closing the coordinator or touching later work and project records', async t => {
  const f = await fixture(t), scope = await f.scope(f.coordinatorId);
  await writeFile(join(scope.location.root.path, 'temporary.txt'), 'inspection');
  await f.action({ action: 'record', requestId: 'record', key: 'decision', text: 'Durable decision', expectedVersion: 0 });
  const clean: ProjectAction = { action: 'cleanup_artifacts', requestId: 'batch-one', scopeIds: [scope.id] };
  const handle = await f.action(clean); assert.equal(await exists(scope.location.root.path), true);
  const next = z.object({ id: z.string(), location: z.object({ root: z.object({ path: z.string() }) }) }).parse(await f.action({ action: 'allocate_artifacts', requestId: 'batch-two', label: 'Next dispatch', parent: f.project }));
  await writeFile(join(next.location.root.path, 'next.txt'), 'active next work');
  await f.finish(f.coordinatorId); await f.loop.tick(); assert.equal(await exists(scope.location.root.path), false);
  assert.equal(await readFile(join(next.location.root.path, 'next.txt'), 'utf8'), 'active next work'); assert.equal((await f.state(f.coordinatorId)).lifecycle.kind, 'open');
  assert.deepEqual(await f.action(clean), handle); assert.equal(f.loop.projects.ledger.project('app')?.records[0]?.text, 'Durable decision');
});

test('role boundaries reject workers and cross-project targets without deleting; uncertain input prevents sealing', async t => {
  const f = await fixture(t), worker = await f.worker(), scope = await f.scope(worker.id);
  await assert.rejects(f.action(f.completeAction(worker.id), worker.id), /Only the coordinator/);
  await assert.rejects(f.action(f.completeAction(f.coordinatorId)), /not a worker/);
  await assert.rejects(f.action(f.completeAction('other-project-task')), /not a worker/);
  f.loop.store.receive(worker.id, { id: 'uncertain', chatId: '', senderId: 'owner', chatType: 'group', text: 'new work', attachments: [], createdAt: Date.now() }); f.loop.store.markInput('uncertain', 'uncertain');
  await assert.rejects(f.complete(worker.id), /Reconcile unresolved/); assert.equal((await f.state(worker.id)).lifecycle.kind, 'open'); assert.equal(await exists(scope.location.root.path), true);
});

test('historical resource associations are not enrolled by restart or idle checks', async t => {
  const f = await fixture(t), worker = await f.worker(); await f.finish(worker.id);
  const association = { id: 'historical', kind: 'git-worktree' as const, branch: `historical/${worker.id}`, repository: repositorySchema.parse({ name: 'example/app', path: f.project, baseBranch: 'main', criteria: { labelsAny: ['work'] } }) };
  const workspace = await f.workspace.ensure({ taskId: worker.id, resourceId: association.id, repository: association.repository, branch: association.branch });
  const task = f.loop.store.task(worker.id); task.resources.push({ ...association, workspace }); f.loop.store.saveTask(task);
  await writeFile(join(workspace, 'historical.bin'), 'old evidence'); await f.restart(); await f.loop.tick(); await f.complete(worker.id);
  assert.equal(await readFile(join(workspace, 'historical.bin'), 'utf8'), 'old evidence'); assert.equal((await f.state(worker.id)).scopes.some(scope => scope.resource.kind === 'worktree'), false);
});

test('cleanup admission racing attachment preparation leaves input pending until execution can start', { timeout: 10_000 }, async t => {
  const f = await fixture(t), scope = await f.scope(f.coordinatorId), coordinator = f.loop.store.task(f.coordinatorId);
  assert.ok(coordinator.threadId); assert.ok(coordinator.chatId);
  await f.action({ action: 'cleanup_artifacts', requestId: 'cleanup-race', scopeIds: [scope.id] });
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

test('selected conversation worktree is removed only after durable completion and never restored', async t => {
  const f = await fixture(t);
  const result = z.object({ taskId: z.string() }).parse(await f.action({ action: 'dispatch', requestId: 'selected', prompt: 'Selected workspace fixture', role: 'worker' }));
  const task = f.loop.store.task(result.taskId), repository = repositorySchema.parse({ name: 'example/app', path: f.project, baseBranch: 'main', criteria: { labelsAny: ['work'] } });
  task.workspaceSelection = { kind: 'selected', temporaryThreadId: 'fixture-selection', inputIds: [], choice: { kind: 'repository', repositoryName: repository.name, repository, reason: 'Constructed selected-cwd fixture' } };
  f.loop.store.saveTask(task); await f.loop.tick();
  const selected = f.loop.store.task(task.id), tree = selected.resources.find(resource => resource.kind === 'git-worktree'); assert.ok(tree);
  assert.equal(f.codex.created.at(-1)?.cwd, tree.workspace);
  await assert.rejects(f.action({ action: 'release_workspace', requestId: 'selected-release', resourceId: tree.id }, task.id), /active conversation directory/);
  await f.finish(task.id); await f.complete(task.id); assert.equal(await exists(tree.workspace), false);
  const creates = f.codex.created.length; await f.restart(); assert.equal(f.codex.created.length, creates); assert.equal(await exists(tree.workspace), false);
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
  await assert.rejects(f.complete(worker.id), /Lost generic receipt/);
  assert.equal((await f.state(worker.id)).lifecycle.kind, 'completed'); assert.equal((await f.state(worker.id)).operations.length, 1);
  await f.restart(); await f.complete(worker.id); assert.ok((await f.state(worker.id)).operations[0]?.targets.every(target => target.state === 'removed'));
});

test('external worktree scopes respect nested delivery holds and changed branch identity', async t => {
  const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app'); if (tree.kind !== 'git-worktree') throw new Error('Expected worktree');
  const scope = z.object({ id: z.string(), location: z.object({ root: z.object({ path: z.string() }) }) }).parse(await f.action({ action: 'allocate_artifacts', requestId: 'tree-output', parent: tree.workspace, label: 'Build output' }, worker.id));
  const file = join(scope.location.root.path, 'only.bin'); await writeFile(file, 'unique binary');
  await f.action({ action: 'register_artifact', requestId: 'tree-hold', scopeId: scope.id, path: file, disposition: 'undelivered' }, worker.id);
  await f.finish(worker.id); await f.complete(worker.id); assert.equal(await exists(file), true); assert.equal(await exists(tree.workspace), true);
  await writeFile(join(tree.workspace, 'later.txt'), 'changed after frozen intent'); await git(tree.workspace, 'add', '.'); await git(tree.workspace, 'commit', '-m', 'later external change');
  await f.action({ action: 'register_artifact', requestId: 'tree-delivery', taskId: worker.id, scopeId: scope.id, path: file, disposition: 'delivered', reference: 'https://example.test/build' });
  await f.loop.tick(); assert.equal(await exists(file), false); assert.equal(await exists(tree.workspace), true);
  assert.match((await f.state(worker.id)).operations[0]?.targets.find(target => target.scope.resource.kind === 'worktree')?.reason ?? '', /branch changed/);
});

test('interrupted worktree directory removal reconciles its saved Git registration on restart', async t => {
  const f = await fixture(t), worker = await f.worker(), tree = await f.loop.ensureWorkspace(worker.id, 'example/app'); if (tree.kind !== 'git-worktree') throw new Error('Expected worktree');
  await f.complete(worker.id);
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
  await f.action({ action: 'cleanup_artifacts', requestId: 'clean-dynamic-scope', scopeIds: [scope.id] });
  await f.loop.tick();
  assert.ok(updates.every(instructions => instructions === before));
  assert.ok(!f.loop.projects.context(f.coordinatorId).includes(scope.location.root.path));
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
      return f.codex.projectHandler({ ...activity, callId: 'closeout-call', action });
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
  assert.equal(await exists(scope.location.root.path), false);
  assert.ok((await f.state(worker.id)).operations[0]?.targets.every(target => target.state === 'removed'));
});
