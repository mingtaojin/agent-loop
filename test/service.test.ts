import { testExecution } from './test-config.js';
import { recoverSavedIntake } from './saved-intake.js';
import { tickWithCoordinator, tickWithDirectGroups, workerCalls, workerGroupCount, instructWorker } from './coordinated-runtime.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { configSchema, type Config } from '../src/config.js';
import { criteriaSchema, matchSource, type IncomingMessage, type Task } from '../src/domain.js';
import { AgentLoop } from '../src/loop.js';
import { WorkspaceProvider } from '../src/workspace.js';
import { type LegacyReport, CodexFake, FeishuFake, GitHubFake, issue } from './fakes.js';

const execute = promisify(execFile);
const prompt = 'Continue authorized technical work. Ask about unresolved business decisions.';
const waiting: LegacyReport = { status: 'waiting_user', summary: 'Reproduced', question: 'May I propose a fix?', prUrl: null, validation: ['Reproduction verified'], limitations: [] };
const review: LegacyReport = { status: 'awaiting_review', summary: 'Fix ready', question: null, prUrl: 'https://github.com/example/project/pull/90', validation: ['Regression passed'], limitations: ['Hardware check pending'] };

async function git(path: string, ...args: string[]): Promise<string> {
  return (await execute('git', ['-C', path, ...args])).stdout.trim();
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-service-'));
  const repository = join(root, 'repository');
  await mkdir(repository);
  await git(repository, 'init', '-b', 'main');
  await git(repository, 'config', 'user.name', 'Service Test');
  await git(repository, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(repository, 'tracked.txt'), 'original commit\n');
  await git(repository, 'add', 'tracked.txt');
  await git(repository, 'commit', '-m', 'Fixture');
  await writeFile(join(root, 'prompt.md'), prompt);
  await writeFile(join(root, 'SKILL.md'), '# poteto-mode\nFollow the user confirmation requirement.\n');
  const config = configSchema.parse({ execution: testExecution,
    dataDir: join(root, 'data'),
    repositories: [{ name: 'example/project', path: repository, baseBranch: 'main', criteria: { assigneesAny: ['developer'] } }],
    engineering: { promptPath: join(root, 'prompt.md'), skillPath: join(root, 'SKILL.md') },
    feishu: { userOpenId: 'ou_owner' }, pollIntervalMs: 3_600_000, executionPollMs: 3_600_000,
  });
  const github = new GitHubFake();
  const feishu = new FeishuFake();
  const codex = new CodexFake();
  const ports = { github, feishu, codex, workspace: new WorkspaceProvider(config.dataDir) };
  let loop = new AgentLoop(config, ports);
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  return {
    root, repository, config, github, feishu, codex,
    get loop() { return loop; },
    requests() { return loop.tasks().filter(task => !task.sourceId.startsWith('project:')); },
    async restart(nextConfig: Config = config) {
      await loop.close();
      loop = new AgentLoop(nextConfig, ports);
      await loop.recover();
    },
    task(number = 1): Task {
      const task = loop.tasks().find(task => (task.source.kind === 'github' ? task.source.issue.number : null) === number);
      assert.ok(task, `Task for issue ${number} exists`);
      return task;
    },
    async launch(numbers = [1]) {
      github.sources = numbers.map(number => issue(number));
      await loop.collect();
      await tickWithDirectGroups(loop);
    },
    message(number: number, id: string, text: string, changes: Partial<IncomingMessage> = {}): IncomingMessage {
      const task = this.task(number);
      assert.ok(task.chatId);
      return { id, chatId: task.chatId, senderId: 'ou_owner', text, attachments: [], createdAt: Date.now(), chatType: 'group', ...changes };
    },
  };
}

function thread(task: Task): string { assert.ok(task.threadId); return task.threadId; }
function workspace(task: Task): string { const resource = task.resources.find(item => item.kind === 'git-worktree') ?? task.resources[0]; assert.ok(resource); return resource.workspace; }

test('collection classifies backlog, records skip reasons, deduplicates, and does not launch', async t => {
  const f = await fixture(t);
  const repository = f.config.repositories[0];
  assert.ok(repository);
  repository.criteria.labelsAll = ['required'];
  repository.criteria.labelsAny = ['triage', 'urgent'];
  repository.criteria.labelsNone = ['blocked'];
  const labels = ['required', 'triage'];
  f.github.sources = [
    issue(1, { labels }), issue(2, { nativeType: null, labels: [...labels, 'bug'] }),
    issue(3, { nativeType: 'Feature', labels: [...labels, 'enhancement'] }),
    issue(4, { labels: [...labels, 'enhancement'] }), issue(5, { nativeType: null, labels }),
    issue(6, { nativeType: 'Unmapped', labels }), issue(7, { isPullRequest: true, labels }),
    issue(8, { assignees: ['someone-else'], labels }), issue(9, { labels: ['triage'] }),
    issue(10, { labels: ['required'] }), issue(11, { labels: [...labels, 'blocked'] }),
    issue(12, { state: 'closed', labels }), issue(1, { labels }),
  ];
  await Promise.all([f.loop.collect(), f.loop.collect()]);
  await f.loop.collect();
  assert.deepEqual(f.requests().map(task => [(task.source.kind === 'github' ? task.source.issue.number : null), task.status]), [[1, 'pending'], [2, 'pending']]);
  const reasons = new Map(f.loop.store.sources().map(record => [record.source.number, record.reason]));
  assert.deepEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(number => reasons.get(number)),
    ['type_not_enabled', 'conflicting_type', 'unclassified', 'unmapped_native_type', 'pull_request', 'assignee', 'labels_all', 'labels_any', 'labels_none', 'state']);
  assert.equal(workerGroupCount(f.loop, f.feishu), 0);
  assert.equal(workerCalls(f.loop, f.codex).created.length, 0);
  await tickWithDirectGroups(f.loop);
  assert.equal(workerGroupCount(f.loop, f.feishu), 2);
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 2);
});

test('open issue collection can omit type, assignee and label restrictions', async t => {
  const f = await fixture(t);
  const repository = f.config.repositories[0];
  assert.ok(repository);
  repository.criteria = criteriaSchema.parse({ states: ['open'], taskTypes: null });
  f.github.sources = [
    issue(1), issue(2, { nativeType: 'Feature', labels: ['enhancement'], assignees: ['other'] }),
    issue(3, { nativeType: null, labels: [], assignees: [] }),
    issue(4, { nativeType: 'Refactor', labels: [] }),
    issue(5, { nativeType: 'Bug', labels: ['enhancement'] }),
    issue(6, { nativeType: null, labels: ['bug', 'enhancement'] }),
    issue(7, { state: 'closed' }), issue(8, { isPullRequest: true }),
    issue(9, { repository: 'example/unconfigured' }),
  ];
  await f.loop.collect();
  const originalIds = f.requests().map(task => task.id);
  assert.deepEqual(f.requests().map(task => task.source.kind === 'github' ? task.source.issue.number : null), [1, 2, 3, 4, 5, 6]);
  const reasons = new Map(f.loop.store.sources().map(record => [record.source.number, record.reason]));
  assert.ok([1, 2, 3, 4, 5, 6].every(number => reasons.get(number)?.startsWith('project:')));
  assert.deepEqual([reasons.get(7), reasons.get(8)], ['state', 'pull_request']);
  assert.equal(reasons.has(9), false);
  await f.loop.collect();
  assert.deepEqual(f.requests().map(task => task.id), originalIds);
  await tickWithDirectGroups(f.loop);
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 6);
});

test('unrestricted issue types preserve configured assignee and label filters', () => {
  const criteria = criteriaSchema.parse({ taskTypes: null, assigneesAny: ['developer'],
    labelsAll: ['required'], labelsAny: ['triage'], labelsNone: ['blocked'] });
  const source = issue(1, { nativeType: null, labels: ['required', 'triage'] });
  assert.equal(matchSource(source, criteria).matches, true);
  assert.equal(matchSource({ ...source, assignees: [] }, criteria).reason, 'assignee');
  assert.equal(matchSource({ ...source, labels: ['triage'] }, criteria).reason, 'labels_all');
  assert.equal(matchSource({ ...source, labels: ['required'] }, criteria).reason, 'labels_any');
  assert.equal(matchSource({ ...source, labels: [...source.labels, 'blocked'] }, criteria).reason, 'labels_none');
});

test('partial collection survives retry without interpreting unread sources as closed', async t => {
  const f = await fixture(t);
  f.github.sources = [issue(1), issue(2), issue(1), issue(3)];
  f.github.listFailureAfter = 1;
  await f.loop.collect();
  assert.deepEqual(f.requests().map(task => (task.source.kind === 'github' ? task.source.issue.number : null)), [1]);
  f.github.listFailureAfter = null;
  await f.loop.collect();
  assert.deepEqual(f.requests().map(task => (task.source.kind === 'github' ? task.source.issue.number : null)), [1, 2, 3]);
  await tickWithDirectGroups(f.loop);
  f.github.listFailureAfter = 1;
  f.github.getError = new Error('GitHub offline');
  await f.loop.collect();
  assert.ok(f.requests().every(task => task.status === 'running'));
  assert.equal(workerCalls(f.loop, f.codex).interrupts.length, 0);
});

test('configured Feature collection preserves scope, classification and existing task identities', async t => {
  const f = await fixture(t);
  const repository = f.config.repositories[0];
  assert.ok(repository);
  repository.criteria.taskTypes = ['feature'];
  repository.criteria.nativeTypes = { Request: 'feature' };
  repository.criteria.typeLabels = { idea: 'feature', defect: 'bug' };
  repository.criteria.labelsAll = ['required'];
  repository.criteria.labelsAny = ['triage', 'urgent'];
  repository.criteria.labelsNone = ['blocked'];
  const labels = ['required', 'triage'];
  const feature = (number: number, changes: Partial<ReturnType<typeof issue>> = {}) =>
    issue(number, { nativeType: 'Request', labels, ...changes });
  f.github.sources = [
    feature(1), feature(2, { nativeType: null, labels: [...labels, 'idea'] }),
    feature(3, { nativeType: 'Feature' }), feature(4, { labels: [...labels, 'defect'] }),
    feature(5, { nativeType: null, labels: [...labels, 'idea', 'defect'] }),
    feature(6, { nativeType: null }), feature(7, { nativeType: null, labels: [...labels, 'defect'] }),
    feature(8, { assignees: ['other'] }), feature(9, { labels: ['triage'] }),
    feature(10, { labels: ['required'] }), feature(11, { labels: [...labels, 'blocked'] }),
    feature(12, { state: 'closed' }), feature(13, { isPullRequest: true }),
    feature(14, { repository: 'example/unconfigured' }),
  ];
  await f.loop.collect();
  const originalIds = f.requests().map(task => task.id);
  assert.deepEqual(f.requests().map(task => [(task.source.kind === 'github' ? task.source.issue.number : null), task.status]), [[1, 'pending'], [2, 'pending']]);
  assert.equal(workerGroupCount(f.loop, f.feishu), 0);
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 0);
  const reasons = new Map(f.loop.store.sources().map(record => [record.source.number, record.reason]));
  assert.deepEqual(Array.from({ length: 11 }, (_, index) => reasons.get(index + 3)), [ 'unmapped_native_type', 'conflicting_type', 'conflicting_type',
    'unclassified', 'type_not_enabled', 'assignee', 'labels_all', 'labels_any', 'labels_none', 'state', 'pull_request',
  ]);
  assert.equal(reasons.has(14), false);
  await f.loop.collect();
  assert.deepEqual(f.requests().map(task => task.id), originalIds);
  f.github.sources.push(feature(15));
  await f.loop.collect();
  assert.deepEqual(f.requests().map(task => (task.source.kind === 'github' ? task.source.issue.number : null)), [1, 2, 15]);
  await tickWithDirectGroups(f.loop);
  assert.equal(workerGroupCount(f.loop, f.feishu), 3);
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 3);
  await f.loop.collect();
  await tickWithDirectGroups(f.loop);
  assert.deepEqual(f.requests().slice(0, 2).map(task => task.id), originalIds);
  assert.equal(workerGroupCount(f.loop, f.feishu), 3);
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 3);
});

test('manual and GitHub requests execute only with the Worker role and coordinator delegation', async t => {
  const f = await fixture(t);
  f.config.repositories[0]!.criteria.taskTypes = ['bug', 'feature'];
  f.github.sources = [issue(1), issue(2, { nativeType: 'Feature', labels: ['enhancement'] })];
  await f.loop.collect();
  await recoverSavedIntake(f.loop, { id: 'manual-topic', chatId: 'private', senderId: 'ou_owner', chatType: 'p2p', text: 'Discuss this topic', attachments: [], createdAt: Date.now() });
  await tickWithDirectGroups(f.loop);
  const role = await readFile(new URL('../prompts/worker.md', import.meta.url), 'utf8');
  const calls = workerCalls(f.loop, f.codex);
  assert.equal(calls.created.length, 2);
  for (const thread of calls.created) {
    assert.ok(thread.instructions.startsWith(role));
    assert.ok(thread.instructions.includes('Delegation from your project coordinator:'));
    assert.equal(thread.model, 'test-worker');
    assert.equal(thread.reasoningEffort, 'xhigh');
  }
  for (const turn of calls.starts) assert.equal(JSON.stringify(turn.input).includes(prompt), false);
  assert.ok(calls.starts.some(turn => JSON.stringify(turn.input).includes('Reproduction 1')));
  assert.ok(calls.starts.some(turn => JSON.stringify(turn.input).includes('Reproduction 2')));
});

test('retained Worker roles preserve project tools, workspace bridge and configured skill paths', async t => {
  const f = await fixture(t); await f.launch();
  const task = f.task(); f.loop.store.saveTask(task);
  const resumedInstructions: string[] = [];
  const inspect = f.codex.inspect.bind(f.codex);
  f.codex.inspect = async (threadId, instructions?: string) => {
    if (threadId === task.threadId && instructions !== undefined) resumedInstructions.push(instructions);
    return inspect(threadId);
  };
  await f.restart();
  const role = await readFile(new URL('../prompts/worker.md', import.meta.url), 'utf8');
  assert.ok(resumedInstructions.length > 0);
  for (const instructions of resumedInstructions) {
    assert.ok(instructions.startsWith(role));
    assert.ok(instructions.includes('Available repositories: ["example/project"]'));
    assert.ok(instructions.includes(JSON.stringify(f.config.engineering!.skillPath)));
    assert.ok(instructions.includes('project-client'));
    assert.ok(instructions.includes('workspace-client'));
  }
});

test('role templates and latest source remain authoritative when generic prompt snapshots or cwd change', async t => {
  const f = await fixture(t);
  f.github.sources = [issue(1)]; await f.loop.collect();
  await writeFile(f.config.engineering!.promptPath!, 'Generic snapshot, not execution policy.');
  f.github.sources = [issue(1, { body: 'Latest source' }), issue(2)];
  const role = await readFile(new URL('../prompts/worker.md', import.meta.url), 'utf8');
  const cwd = process.cwd();
  try { process.chdir(f.root); await f.loop.collect(); await tickWithDirectGroups(f.loop); }
  finally { process.chdir(cwd); }
  const calls = workerCalls(f.loop, f.codex);
  const initial = calls.starts.find(input => input.threadId === f.task().threadId); assert.ok(initial);
  assert.match(JSON.stringify(initial.input), /Latest source/);
  for (const thread of calls.created) {
    assert.ok(thread.instructions.startsWith(role));
    assert.ok(!thread.instructions.includes('Generic snapshot, not execution policy.'));
    assert.ok(thread.instructions.includes(`Engineering skill path: ${JSON.stringify(f.config.engineering!.skillPath)}.`));
  }
});

test('new criteria scope collection without stopping existing sources after repository removal', async t => {
  const f = await fixture(t); await f.launch(); const original = f.task();
  const changed = structuredClone(f.config); changed.repositories[0]!.criteria.assigneesAny = ['other'];
  await f.restart(changed); f.github.sources.push(issue(2), issue(3, { assignees: ['other'] })); await f.loop.collect();
  assert.deepEqual(f.requests().map(task => task.source.kind === 'github' ? task.source.issue.number : null), [1, 3]);
  changed.repositories = []; await f.restart(changed);
  f.github.sources[0] = issue(1, { assignees: [], state: 'closed' });
  await f.loop.collect(); await tickWithDirectGroups(f.loop);
  assert.equal(f.task().status, 'running'); assert.equal(workerCalls(f.loop, f.codex).interrupts.length, 0);
  assert.equal(f.task().threadId, original.threadId); assert.equal(f.task().chatId, original.chatId);
  assert.ok(f.codex.steers.some(input => JSON.stringify(input.input).includes('closed')));
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 0);
});

test('workspaces are acquired on demand and remain isolated while another task waits', async t => {
  const f = await fixture(t); await writeFile(join(f.repository, 'tracked.txt'), 'user dirty change\n');
  await f.launch([1, 2]);
  assert.ok(f.requests().every(task => task.resources.length === 0));
  await Promise.all([1, 2].map(number => f.loop.ensureWorkspace(f.task(number).id, 'example/project')));
  const first = f.task(1), second = f.task(2);
  assert.notEqual(workspace(first), workspace(second)); assert.notEqual(first.threadId, second.threadId);
  await writeFile(join(workspace(first), 'tracked.txt'), 'task one change\n');
  assert.equal(await readFile(join(workspace(second), 'tracked.txt'), 'utf8'), 'original commit\n');
  assert.equal(await readFile(join(f.repository, 'tracked.txt'), 'utf8'), 'user dirty change\n');
  f.codex.complete(thread(first), 'Discussion answer without PR'); await tickWithDirectGroups(f.loop);
  assert.equal(f.task(1).status, 'idle');
  await f.loop.receive(f.message(2, 'other-input', 'more evidence'));
  assert.equal(workerCalls(f.loop, f.codex).steers.at(-1)?.threadId, second.threadId);
  await f.loop.receive(f.message(1, 'followup', 'continue this discussion'));
  assert.equal(workerCalls(f.loop, f.codex).starts.at(-1)?.threadId, first.threadId);
  await f.restart(); assert.equal(workspace(f.task(1)), workspace(first));
});

test('project directory policy returns the whole engineering root and preserves existing Git task workspaces', async t => {
  const f = await fixture(t);
  await f.launch([1, 2]);
  const firstThread = f.task(1).threadId, secondThread = f.task(2).threadId;
  const root = await realpath(f.root);
  const previous = await f.loop.ensureWorkspace(f.task(1).id, 'example/project');
  const repository = f.config.repositories[0]; assert.ok(repository);
  f.config.repositories = configSchema.parse({ ...f.config, repositories: [{ ...repository,
    workspace: { kind: 'project-directory', path: f.root },
  }] }).repositories;
  const secondTask = f.task(2); assert.ok(secondTask.threadId); assert.ok(secondTask.turnId); assert.ok(f.codex.workspaceHandler);
  const directory = await f.codex.workspaceHandler({ connectionEpoch: 'fake-epoch', threadId: secondTask.threadId, turnId: secondTask.turnId,
    callId: 'project-directory', repository: 'example/project' });
  assert.equal(directory.workspace, root);
  assert.equal(directory.kind, 'project-directory');
  assert.equal('branch' in directory, false);
  assert.equal(await readFile(join(directory.workspace, 'repository', 'tracked.txt'), 'utf8'), 'original commit\n');
  assert.equal(await git(f.repository, 'branch', '--show-current'), 'main');
  const client = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../src/workspace-client.ts' : '../src/workspace-client.js', import.meta.url));
  f.loop.store.saveTask(secondTask); await tickWithDirectGroups(f.loop);
  const bridged = await execute(process.execPath, [client, join(f.config.dataDir, 'workspace-capabilities', `${secondTask.id}.json`), 'example/project']);
  assert.equal(JSON.parse(bridged.stdout).workspace, root);
  assert.equal((await f.loop.ensureWorkspace(f.task(1).id, 'example/project')).workspace, previous.workspace);
  await f.restart();
  assert.equal((await f.loop.ensureWorkspace(f.task(2).id, 'example/project')).workspace, root);
  assert.equal((await f.loop.ensureWorkspace(f.task(1).id, 'example/project')).workspace, previous.workspace);
  assert.equal(f.task(1).threadId, firstThread);
  assert.equal(f.task(2).threadId, secondThread);
  assert.equal(f.task(2).resources.length, 1);
  const changed = f.config.repositories[0]; assert.ok(changed);
  f.config.repositories = [{ ...changed, workspace: { kind: 'project-directory', path: f.repository } }];
  assert.equal((await f.loop.ensureWorkspace(f.task(2).id, 'example/project')).workspace, root);
  await f.loop.control(f.task(2).id, 'pause');
  await f.loop.control(f.task(2).id, 'resume');
  assert.notEqual(f.task(2).status, 'failed');
  assert.equal(f.task(2).resources.find(resource => resource.id === directory.id)?.workspace, root);
});

test('plain results wait across restart and source edits wake the original conversation once', async t => {
  const f = await fixture(t); await f.launch(); const original = f.task();
  f.codex.complete(thread(original), 'A complete answer with no delivery gate.'); await tickWithDirectGroups(f.loop);
  await f.restart(); await tickWithDirectGroups(f.loop);
  assert.equal(f.task().status, 'idle'); assert.equal(workerCalls(f.loop, f.codex).starts.length, 1);
  assert.equal(f.feishu.sent.filter(message => message.text === 'A complete answer with no delivery gate.').length, 1);
  f.github.sources = [issue(1, { body: 'Correction while waiting' })];
  await f.loop.collect(); await tickWithDirectGroups(f.loop); await f.loop.collect(); await tickWithDirectGroups(f.loop);
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 1);
  await instructWorker(f.loop, original.id, 'forward-correction', 'Correction while waiting');
  await instructWorker(f.loop, original.id, 'forward-correction', 'Correction while waiting');
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 2); assert.equal(workerCalls(f.loop, f.codex).starts[1]?.threadId, original.threadId);
  assert.equal(f.github.verifications.length, 0);
});

test('running source edits and closure steer original turn once without pausing', async t => {
  const f = await fixture(t); await f.launch(); const original = f.task();
  f.github.sources = [issue(1, { body: 'New detail' })];
  await f.loop.collect(); await tickWithDirectGroups(f.loop); await f.loop.collect(); await tickWithDirectGroups(f.loop);
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 0);
  await instructWorker(f.loop, original.id, 'forward-detail', 'New detail');
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 1);
  f.github.sources = [issue(1, { state: 'closed', body: 'New detail' })];
  await f.loop.collect(); await tickWithDirectGroups(f.loop);
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 1);
  await instructWorker(f.loop, original.id, 'forward-closure', 'The Issue was closed. Check actual delivery.');
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 2); assert.equal(f.task().status, 'running');
  assert.equal(workerCalls(f.loop, f.codex).interrupts.length, 0); assert.equal(f.task().threadId, original.threadId);
});

test('native question receives ordinary answer while approval requires bound action', async t => {
  const f = await fixture(t); await f.launch([1, 2]); const first = f.task();
  const snapshot = f.codex.snapshot(thread(first)); assert.ok(snapshot.turnId);
  const common = { threadId: thread(first), turnId: snapshot.turnId, payload: {}, isBlocking: true, connectionEpoch: 'epoch' };
  snapshot.requests = [
    { ...common, id: 'question', kind: 'question', prompt: 'Which version?', method: 'item/tool/requestUserInput' },
    { ...common, id: 'approval', kind: 'approval', prompt: 'Allow?', method: 'item/commandExecution/requestApproval' },
  ];
  await tickWithDirectGroups(f.loop); assert.equal(f.feishu.approvals.length, 1);
  await f.loop.receive(f.message(1, 'answer', 'version 3'));
  assert.equal(workerCalls(f.loop, f.codex).replies[0]?.text, 'version 3');
  await f.loop.receive(f.message(1, 'ordinary-approval', '/approve approval accept'));
  assert.equal(f.codex.approvals.length, 0);
  assert.equal(workerCalls(f.loop, f.codex).steers.at(-1)?.deliveryId, 'ordinary-approval');
  const action = { id: 'action', taskId: first.id, threadId: thread(first), turnId: snapshot.turnId, requestId: 'approval', decision: 'reject' as const, chatId: first.chatId!, senderId: 'ou_owner', epoch: 'epoch' };
  await assert.rejects(f.loop.approve({ ...action, chatId: f.task(2).chatId! }), /expired/);
  await assert.rejects(f.loop.approve({ ...action, epoch: 'old' }), /expired/);
  await assert.rejects(f.loop.approve({ ...action, senderId: 'other' }), /authorized/);
  await f.loop.approve(action);
  await f.loop.control(first.id, 'status');
  assert.deepEqual(f.codex.approvals.map(input => input.decision), ['reject']);
  await assert.rejects(f.loop.approve(action), /received|expired/);
});

test('sender and event deduplication includes offline history replay after restart', async t => {
  const f = await fixture(t);
  await f.launch();
  await f.loop.receive(f.message(1, 'bot', 'feedback loop', { senderId: 'bot' }));
  await f.loop.receive(f.message(1, 'stranger', 'untrusted chat', { chatId: 'unknown-chat' }));
  const message = f.message(1, 'message-1', 'one instruction');
  await Promise.all([f.loop.receive(message), f.loop.receive(message)]);
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 1);
  f.feishu.offline = [message, f.message(1, 'offline', 'offline instruction')];
  await f.restart();
  await f.loop.receive(message);
  assert.deepEqual(workerCalls(f.loop, f.codex).steers.map(input => input.deliveryId), ['message-1', 'offline']);
  assert.equal(workerCalls(f.loop, f.codex).created.length, 1);
  assert.equal(workerGroupCount(f.loop, f.feishu), 1);
});

test('screenshots and same-name logs reach Codex as unchanged, readable task-local files', async t => {
  const f = await fixture(t);
  await f.launch();
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 1]);
  const firstLog = Buffer.from('first log\r\n用户输入\r\n' + 'long record\n'.repeat(10_000));
  const secondLog = Buffer.from('second log\n');
  f.feishu.resources.set('image-key', image);
  f.feishu.resources.set('log-1', firstLog);
  f.feishu.resources.set('log-2', secondLog);
  const message = f.message(1, 'evidence', 'Reproduced with these files', { attachments: [
    { key: 'image-key', name: 'capture.png', kind: 'image' },
    { key: 'log-1', name: 'session.log', kind: 'file' },
    { key: 'log-2', name: 'session.log', kind: 'file' },
  ] });
  await f.loop.receive(message);
  const input = workerCalls(f.loop, f.codex).steers.at(-1)?.input;
  assert.ok(input);
  assert.deepEqual(input[0], { kind: 'text', text: message.text });
  assert.ok(input.every(item => item.kind === 'text'));
  const imageInput = input.find(item => item.kind === 'text' && item.text.startsWith('Image attachment as data: '));
  assert.ok(imageInput && imageInput.kind === 'text');
  const imageReference = z.object({ path: z.string() }).parse(JSON.parse(imageInput.text.slice('Image attachment as data: '.length).split('\n')[0] ?? ''));
  assert.deepEqual(await readFile(imageReference.path), image);
  const logPaths = input.filter(item => item.kind === 'text').flatMap(item => {
    if (item.text.startsWith('Image attachment as data: ')) return [];
    const match = /完整原文件位于 ("(?:[^"\\]|\\.)*")/.exec(item.text);
    if (!match?.[1]) return [];
    const path: unknown = JSON.parse(match[1]);
    assert.ok(typeof path === 'string');
    return [path];
  });
  assert.equal(logPaths.length, 2);
  const [firstPath, secondPath] = logPaths;
  assert.ok(firstPath && secondPath);
  assert.notEqual(firstPath, secondPath);
  assert.deepEqual(await readFile(firstPath), firstLog);
  assert.deepEqual(await readFile(secondPath), secondLog);
  await f.restart();
  await f.loop.receive(message);
  assert.equal(f.feishu.downloads.length, 3);
  assert.equal(workerCalls(f.loop, f.codex).steers.filter(input => input.deliveryId === message.id).length, 1);
  assert.deepEqual(await readFile(imageReference.path), image);
});

test('failed attachment retains text while later ordinary messages proceed and retry remains explicit', async t => {
  const f = await fixture(t); await f.launch();
  f.feishu.resources.set('retry-log', Buffer.from('evidence')); f.feishu.downloadFailures.add('retry-log');
  const message = f.message(1, 'failed-evidence', 'text stays with log', { attachments: [{ key: 'retry-log', name: 'error.log', kind: 'file' }] });
  await f.loop.receive(message); assert.equal(workerCalls(f.loop, f.codex).steers.length, 0);
  await f.loop.receive(f.message(1, 'stop-text', '/pause'));
  assert.equal(workerCalls(f.loop, f.codex).steers.at(-1)?.deliveryId, 'stop-text'); assert.equal(workerCalls(f.loop, f.codex).interrupts.length, 0);
  f.feishu.downloadFailures.delete('retry-log'); await f.loop.retryAttachment(f.task().id, message.id);
  assert.equal(workerCalls(f.loop, f.codex).steers.filter(input => input.deliveryId === message.id).length, 1);
});

test('turn completion racing with steer continues once in the original conversation', async t => {
  const f = await fixture(t);
  await f.launch();
  const original = f.task();
  f.codex.raceOnSteer = true;
  await f.loop.receive(f.message(1, 'racing-message', 'New detail at the boundary'));
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 2);
  assert.equal(workerCalls(f.loop, f.codex).starts[1]?.threadId, original.threadId);
  assert.equal(workerCalls(f.loop, f.codex).starts[1]?.deliveryId, 'racing-message');
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 0);
  await tickWithDirectGroups(f.loop);
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 2);
  assert.equal(f.task().status, 'running');
});

test('lost input acknowledgement reconciles after restart without duplication or blocking newer input', async t => {
  const f = await fixture(t);
  await f.launch();
  f.codex.loseInputAck = true;
  await f.loop.receive(f.message(1, 'lost-ack', 'Accepted before timeout'));
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 1);
  await f.restart();
  await f.loop.receive(f.message(1, 'after-lost-ack', 'Continue after reconciliation'));
  assert.deepEqual(workerCalls(f.loop, f.codex).steers.map(input => input.deliveryId), ['lost-ack', 'after-lost-ack']);
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 1);
});

test('one data directory admits only one scheduler and restart reconnects the active executor', async t => {
  const f = await fixture(t);
  await f.launch();
  assert.throws(() => new AgentLoop(f.config, { github: f.github, feishu: f.feishu, codex: f.codex, workspace: new WorkspaceProvider(f.config.dataDir) }), /进程/);
  await Promise.all([f.loop.tick(), f.loop.tick(), f.loop.collect()]);
  await f.restart();
  assert.equal(workerCalls(f.loop, f.codex).created.length, 1);
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 1);
  assert.equal(f.task().status, 'running');
});

test('uncertain on-demand group creation reconciles without failing or duplicating the executor', async t => {
  const f = await fixture(t);
  f.github.sources = [issue(1)]; await f.loop.collect(); await tickWithCoordinator(f.loop);
  const original = f.task(); assert.ok(original.threadId); assert.equal(original.chatId, null);
  const member = f.loop.projects.ledger.membership(original.id); assert.ok(member);
  const coordinator = f.loop.projects.ledger.project(member.projectId)!.coordinatorTaskId;
  f.feishu.loseGroupAck = true;
  await assert.rejects(f.loop.projectAction(coordinator, { action: 'open_group', requestId: 'unknown-group', taskId: original.id }));
  assert.equal(f.task().status, 'running'); assert.equal(f.task().threadId, original.threadId);
  assert.equal(workerGroupCount(f.loop, f.feishu), 1);
  await f.restart();
  await f.loop.projectAction(coordinator, { action: 'open_group', requestId: 'reconcile-group', taskId: original.id });
  assert.equal(workerGroupCount(f.loop, f.feishu), 1);
  assert.equal(workerCalls(f.loop, f.codex).created.length, 1); assert.equal(workerCalls(f.loop, f.codex).starts.length, 1);
  assert.equal(f.task().chatId, f.feishu.groups.get(f.task().id));
});

test('uncertain thread creation is reported and cannot create a second executor on resume', async t => {
  const f = await fixture(t);
  f.github.sources = [issue(1)]; await f.loop.collect(); await f.loop.tick();
  f.codex.loseCreateAck = true;
  await tickWithDirectGroups(f.loop);
  assert.equal(f.task().status, 'failed');
  await f.restart();
  await f.loop.control(f.task().id, 'resume');
  await tickWithDirectGroups(f.loop);
  assert.equal(workerCalls(f.loop, f.codex).created.length, 1);
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 0);
  assert.equal(f.task().status, 'failed');
  assert.ok(f.feishu.sent.some(message => message.text.includes('未重复创建')));
});

test('runtime forwards actual output without checking PR or requiring reports', async t => {
  const f = await fixture(t); await f.launch([1, 2]);
  f.github.validPullRequest = false;
  f.codex.complete(thread(f.task(1)), review); f.codex.complete(thread(f.task(2)), null); await tickWithDirectGroups(f.loop);
  assert.ok(f.requests().every(task => task.status === 'idle'));
  assert.equal(f.github.verifications.length, 0);
  assert.ok(f.feishu.sent.some(message => message.text.includes('Hardware check pending')));
  await tickWithDirectGroups(f.loop); assert.equal(workerCalls(f.loop, f.codex).starts.length, 2);
});

test('history gaps and uncertain outgoing messages are visible without replaying sent messages', async t => {
  const f = await fixture(t);
  f.feishu.loseSendAck = true;
  await f.launch();
  const originalCount = f.feishu.sent.length;
  f.feishu.historyError = new Error('History permission unavailable');
  await f.restart();
  await f.loop.recover();
  assert.equal(f.feishu.sent.filter(message => message.text.includes('任务对话已建立')).length, 1);
  assert.ok(f.feishu.sent.length > originalCount);
  assert.ok(f.feishu.sent.some(message => message.text.includes('离线消息补偿暂时失败')));
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 1);
});

test('service start launches backlog and routes live incoming messages through the shared bot', async t => {
  const f = await fixture(t);
  f.github.sources = [issue(1), issue(2)];
  await f.loop.start();
  assert.ok(f.feishu.receiver);
  await tickWithDirectGroups(f.loop);
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 2, JSON.stringify(f.requests().map(task => ({ id: task.id, status: task.status,
    execution: task.executionStatus, reason: task.reason, inputs: f.loop.store.inputs(task.id).map(input => [input.status, input.error]) }))));
  assert.ok(f.requests().every(task => task.status === 'running'));
  await f.feishu.receiver(f.message(2, 'live-message', 'Live event'));
  assert.equal(workerCalls(f.loop, f.codex).steers.at(-1)?.threadId, thread(f.task(2)));
  assert.equal(workerGroupCount(f.loop, f.feishu), 2);
});

test('unknown input delivery blocks replay and subsequent input until reconciliation', async t => {
  const f = await fixture(t); await f.launch(); f.codex.loseInputAck = true;
  await f.loop.receive(f.message(1, 'unknown', 'May have arrived'));
  f.codex.snapshot(thread(f.task())).seenInputIds = [];
  await f.restart(); await f.loop.receive(f.message(1, 'later', '/pause'));
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 1); assert.equal(workerCalls(f.loop, f.codex).interrupts.length, 0);
  assert.equal(f.loop.store.inputs(f.task().id).find(input => input.id === 'unknown')?.status, 'uncertain');
  await f.loop.control(f.task().id, 'pause'); assert.equal(workerCalls(f.loop, f.codex).interrupts.length, 1);
});

test('ordinary control text never changes runtime state', async t => {
  const f = await fixture(t); await f.launch();
  for (const text of ['/pause', '/resume', '/status', '/answer old answer', '/retry old', 'stop now']) await f.loop.receive(f.message(1, text, text));
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 6); assert.equal(workerCalls(f.loop, f.codex).interrupts.length, 0); assert.equal(f.task().status, 'running');
});

for (const resource of [
  { name: 'record.zip', bytes: Buffer.from('archive'), maximum: 1024 },
  { name: 'record.log', bytes: Buffer.from([255, 254, 128]), maximum: 1024 },
  { name: 'record.log', bytes: Buffer.from('too large'), maximum: 2 },
  { name: 'record.log', bytes: Buffer.from(''), maximum: 1024 },
]) {
  test(`unsupported or invalid evidence is reported without forwarding its accompanying text (${resource.name}, ${resource.bytes.length} bytes, limit ${resource.maximum})`, async t => {
    const f = await fixture(t);
    f.config.maxAttachmentBytes = resource.maximum;
    await f.launch();
    f.feishu.resources.set('invalid-evidence', resource.bytes);
    await f.loop.receive(f.message(1, 'invalid-evidence-message', 'Keep this paired with the resource', { attachments: [{ key: 'invalid-evidence', name: resource.name, kind: 'file' }] }));
    assert.equal(workerCalls(f.loop, f.codex).steers.length, 0);
    assert.ok(f.feishu.sent.some(message => message.text.includes('消息尚未投递')));
    const evidence = join(f.config.dataDir, 'attachments', f.task().id);
    const entries = await readdir(evidence, { recursive: true });
    assert.ok(entries.every(entry => !entry.endsWith('.partial')));
  });
}


test('configured custom Issue types use generic conversation and disabled types stay excluded', async t => {
  const f = await fixture(t); const criteria = f.config.repositories[0]!.criteria;
  criteria.nativeTypes.Refactor = 'refactor'; criteria.typeLabels.refactor = 'refactor';
  f.github.sources = [issue(1, { nativeType: 'Refactor', labels: ['refactor'] })];
  await f.loop.collect(); assert.equal(f.requests().length, 0);
  assert.equal(f.loop.store.sources()[0]?.reason, 'type_not_enabled');
  criteria.taskTypes = ['refactor']; await f.loop.collect(); await tickWithDirectGroups(f.loop);
  const task = f.task(); f.codex.complete(thread(task), 'Refactor investigation answer without PR'); await tickWithDirectGroups(f.loop);
  assert.equal(f.task().status, 'idle');
  assert.ok(f.feishu.sent.some(output => output.text === 'Refactor investigation answer without PR'));
});
