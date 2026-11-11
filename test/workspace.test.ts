import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { configSchema, loadConfig } from '../src/config.js';
import { repositorySchema } from '../src/domain.js';
import { WorkspaceProvider } from '../src/workspace.js';

const execute = promisify(execFile);

async function git(path: string, ...args: string[]): Promise<string> {
  return (await execute('git', ['-C', path, ...args])).stdout.trim();
}

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-workspace-'));
  const original = join(root, 'original');
  await mkdir(original);
  await git(original, 'init', '-b', 'main');
  await git(original, 'config', 'user.name', 'Workspace Test');
  await git(original, 'config', 'user.email', 'workspace@example.invalid');
  await writeFile(join(original, 'tracked.txt'), 'committed\n');
  await git(original, 'add', 'tracked.txt');
  await git(original, 'commit', '-m', 'Initial fixture');
  return {
    root, original,
    repository: repositorySchema.parse({ name: 'example/project', path: original, baseBranch: 'main' }),
    workspace: new WorkspaceProvider(join(root, 'data')),
  };
}

test('parallel task worktrees preserve staged, unstaged and untracked original files, and survive restart', async t => {
  const fixture = await repositoryFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.original, 'tracked.txt'), 'staged user change\n');
  await git(fixture.original, 'add', 'tracked.txt');
  await writeFile(join(fixture.original, 'tracked.txt'), 'unstaged user change\n');
  await writeFile(join(fixture.original, 'private.txt'), 'untracked user change\n');
  const before = await git(fixture.original, 'status', '--porcelain=v1');
  const staged = await git(fixture.original, 'diff', '--cached');
  const first = { resourceId: 'repo', taskId: 'task-1', repository: fixture.repository, branch: 'agent-loop/task-1' };
  const second = { resourceId: 'repo', taskId: 'task-2', repository: fixture.repository, branch: 'agent-loop/task-2' };
  const [path1, path2, duplicate] = await Promise.all([
    fixture.workspace.ensure(first), fixture.workspace.ensure(second), fixture.workspace.ensure(first),
  ]);
  assert.equal(path1, duplicate);
  assert.notEqual(path1, path2);
  assert.equal(await readFile(join(path1, 'tracked.txt'), 'utf8'), 'committed\n');
  await writeFile(join(path1, 'tracked.txt'), 'task one change\n');
  assert.equal(await readFile(join(path2, 'tracked.txt'), 'utf8'), 'committed\n');
  assert.equal(await git(path1, 'branch', '--show-current'), first.branch);
  assert.equal(await git(path2, 'branch', '--show-current'), second.branch);
  assert.equal(await new WorkspaceProvider(join(fixture.root, 'data')).ensure(first), path1);
  assert.equal(await readFile(join(path1, 'tracked.txt'), 'utf8'), 'task one change\n');
  assert.equal(await fixture.workspace.head(path1), await git(fixture.original, 'rev-parse', 'HEAD'));
  assert.equal(await git(fixture.original, 'status', '--porcelain=v1'), before);
  assert.equal(await git(fixture.original, 'diff', '--cached'), staged);
  assert.equal(await readFile(join(fixture.original, 'tracked.txt'), 'utf8'), 'unstaged user change\n');
  assert.equal(await readFile(join(fixture.original, 'private.txt'), 'utf8'), 'untracked user change\n');
});

test('a workspace on a different branch is refused without resetting user work', async t => {
  const fixture = await repositoryFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const input = { resourceId: 'repo', taskId: 'task-1', repository: fixture.repository, branch: 'agent-loop/task-1' };
  const path = await fixture.workspace.ensure(input);
  await git(path, 'switch', '-c', 'user-changed-branch');
  await writeFile(join(path, 'tracked.txt'), 'user change\n');
  await assert.rejects(fixture.workspace.ensure(input), /identity does not match/);
  assert.equal(await git(path, 'branch', '--show-current'), 'user-changed-branch');
  assert.equal(await readFile(join(path, 'tracked.txt'), 'utf8'), 'user change\n');
});

test('missing workspace with existing branch fails and later independent tasks still work', async t => {
  const fixture = await repositoryFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await git(fixture.original, 'branch', 'agent-loop/occupied');
  await assert.rejects(fixture.workspace.ensure({ resourceId: 'repo', taskId: 'occupied', repository: fixture.repository, branch: 'agent-loop/occupied' }), /already exists without its workspace/);
  const path = await fixture.workspace.ensure({ resourceId: 'repo', taskId: 'other', repository: fixture.repository, branch: 'agent-loop/other' });
  assert.equal(await readFile(join(path, 'tracked.txt'), 'utf8'), 'committed\n');
});

test('task paths cannot escape or impersonate another repository', async t => {
  const fixture = await repositoryFixture();
  const other = await repositoryFixture();
  t.after(async () => { await rm(fixture.root, { recursive: true, force: true }); await rm(other.root, { recursive: true, force: true }); });
  await assert.rejects(fixture.workspace.ensure({ resourceId: 'repo', taskId: '../escape', repository: fixture.repository, branch: 'task' }), /identifier/);
  await mkdir(join(fixture.root, 'data', 'workspaces'), { recursive: true });
  await symlink(fixture.original, join(fixture.root, 'data', 'workspaces', 'linked'));
  await assert.rejects(fixture.workspace.ensure({ resourceId: 'repo', taskId: 'linked', workspace: join(fixture.root, 'data', 'workspaces', 'linked'), repository: fixture.repository, branch: 'main' }), /owned directory/);
  const existing = join(fixture.root, 'data', 'workspaces', 'unrelated');
  await git(other.original, 'worktree', 'add', '-b', 'task', existing);
  await assert.rejects(fixture.workspace.ensure({ resourceId: 'repo', taskId: 'unrelated', workspace: existing, repository: fixture.repository, branch: 'task' }), /identity does not match/);
  assert.equal(await readFile(join(existing, 'tracked.txt'), 'utf8'), 'committed\n');
});

test('configuration resolves paths relative to its file and requires actual prompt and skill files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'prompt.md'), 'exact prompt');
  await writeFile(join(root, 'SKILL.md'), 'required skill');
  const raw = {
    repositories: [{ name: 'example/project', path: './repo', baseBranch: 'origin/main' }],
    engineering: { promptPath: './prompt.md', skillPath: './SKILL.md' },
    feishu: { userOpenId: 'ou_test' },
  };
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(raw));
  const config = await loadConfig(path);
  const configuredRepository = config.repositories[0]; assert.ok(configuredRepository && 'path' in configuredRepository);
  assert.equal(configuredRepository.path, join(root, 'repo'));
  assert.equal(config.dataDir, join(root, 'data'));
  assert.equal(config.engineering!.promptPath, join(root, 'prompt.md'));
  assert.equal(config.engineering!.skillPath, join(root, 'SKILL.md'));
  assert.equal(config.github.tokenEnv, 'GITHUB_TOKEN');
  assert.equal(config.pollIntervalMs, 30_000);
  assert.equal(config.executionPollMs, 2_000);
  assert.equal(config.codex.model, undefined);
  assert.equal(config.codex.selectionModel, undefined);
  assert.equal(configSchema.parse({ ...raw, codex: { selectionModel: 'selection-model' } }).codex.selectionModel, 'selection-model');
  assert.throws(() => configSchema.parse({ ...raw, github: { token: 'never-store-secrets' } }));
  assert.throws(() => configSchema.parse({ ...raw, github: { tokenEnv: 'github-token-value' } }));
  assert.throws(() => configSchema.parse({ ...raw, bug: raw.engineering }), /Unrecognized key/);
  await rm(join(root, 'SKILL.md'));
  await assert.rejects(loadConfig(path), /ENOENT/);
});


test('one task can own two repositories and preserve an exact legacy workspace', async t => {
  const first = await repositoryFixture();
  const second = await repositoryFixture();
  t.after(async () => { await rm(first.root, { recursive: true, force: true }); await rm(second.root, { recursive: true, force: true }); });
  const legacy = join(first.root, 'data', 'workspaces', 'old-task');
  await git(first.original, 'worktree', 'add', '-b', 'agent-loop/legacy', legacy);
  await writeFile(join(legacy, 'tracked.txt'), 'retained legacy work\n');
  const legacyInput = { taskId: 'old-task', resourceId: 'first', repository: first.repository, branch: 'agent-loop/legacy', workspace: legacy };
  assert.equal(await first.workspace.ensure(legacyInput), legacy);
  const added = await first.workspace.ensure({ taskId: 'old-task', resourceId: 'second', repository: second.repository, branch: 'agent-loop/second' });
  assert.notEqual(added, legacy);
  assert.ok(!added.startsWith(legacy + '/'));
  assert.equal(await readFile(join(legacy, 'tracked.txt'), 'utf8'), 'retained legacy work\n');
  assert.equal(await readFile(join(added, 'tracked.txt'), 'utf8'), 'committed\n');
  assert.equal(await new WorkspaceProvider(join(first.root, 'data')).ensure(legacyInput), legacy);
  await assert.rejects(first.workspace.ensure({ ...legacyInput, workspace: first.original }), /does not belong/);
  await assert.rejects(first.workspace.ensure({ ...legacyInput, resourceId: '../escape' }), /resource identifier/);
  await assert.rejects(first.workspace.ensure({ ...legacyInput, workspace: join(first.root, 'data', 'workspaces', 'old-task--first') }), /directory is missing/);
});

test('project directories expose all repositories and materials without changing or copying them', async t => {
  const fixture = await repositoryFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const plugins = join(fixture.root, 'plugins');
  await mkdir(plugins);
  await git(plugins, 'init', '-b', 'plugins-main');
  await writeFile(join(plugins, 'plugin.txt'), 'staged plugin work\n');
  await git(plugins, 'add', 'plugin.txt');
  await writeFile(join(plugins, 'private.txt'), 'untracked plugin work\n');
  await writeFile(join(fixture.original, 'tracked.txt'), 'original user work\n');
  await writeFile(join(fixture.root, 'project.md'), 'whole project instructions\n');
  const originalStatus = await git(fixture.original, 'status', '--porcelain=v1');
  const pluginStatus = await git(plugins, 'status', '--porcelain=v1');
  const input = { kind: 'project-directory', taskId: 'first', resourceId: 'project', directory: fixture.root } satisfies Parameters<WorkspaceProvider['ensure']>[0];
  const directory = await fixture.workspace.ensure(input);
  assert.equal(directory, await realpath(fixture.root));
  assert.equal(await readFile(join(directory, 'project.md'), 'utf8'), 'whole project instructions\n');
  assert.equal(await readFile(join(directory, 'plugins', 'plugin.txt'), 'utf8'), 'staged plugin work\n');
  assert.equal(await fixture.workspace.ensure({ ...input, taskId: 'second' }), directory);
  assert.equal(await new WorkspaceProvider(join(fixture.root, 'data')).ensure({ ...input, workspace: directory }), directory);
  assert.equal(await git(fixture.original, 'status', '--porcelain=v1'), originalStatus);
  assert.equal(await git(plugins, 'status', '--porcelain=v1'), pluginStatus);
  assert.equal(await git(fixture.original, 'branch', '--show-current'), 'main');
  assert.equal(await git(plugins, 'branch', '--show-current'), 'plugins-main');
  await assert.rejects(stat(join(fixture.root, 'data', 'workspaces')), { code: 'ENOENT' });
});

test('project directory recovery refuses missing directories, files and retargeted symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-project-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first'), second = join(root, 'second'), link = join(root, 'project');
  await mkdir(first); await mkdir(second); await symlink(first, link);
  const provider = new WorkspaceProvider(join(root, 'data'));
  const input = { kind: 'project-directory', taskId: 'task', resourceId: 'project', directory: link } satisfies Parameters<WorkspaceProvider['ensure']>[0];
  const workspace = await provider.ensure(input);
  await unlink(link); await symlink(second, link);
  await assert.rejects(provider.ensure({ ...input, workspace }), /association changed/);
  await rm(first, { recursive: true });
  await assert.rejects(provider.ensure({ ...input, directory: first, workspace }), { code: 'ENOENT' });
  await assert.rejects(stat(first), { code: 'ENOENT' });
  const file = join(root, 'file.txt'); await writeFile(file, 'not a directory');
  await assert.rejects(provider.ensure({ ...input, directory: file }), /existing directory/);
});

test('project workspace configuration resolves its own path and rejects incomplete policies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-project-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = { name: 'example/project', path: './project/framework', baseBranch: 'main',
    workspace: { kind: 'project-directory', path: './project' } };
  const raw = { feishu: { userOpenId: 'owner' }, repositories: [repository] };
  await writeFile(join(root, 'config.json'), JSON.stringify(raw));
  const config = await loadConfig(join(root, 'config.json'));
  const configuredRepository = config.repositories[0]; assert.ok(configuredRepository && 'path' in configuredRepository);
  const policy = configuredRepository.workspace;
  assert.equal(policy?.kind, 'project-directory');
  assert.equal(policy?.kind === 'project-directory' ? policy.path : null, join(root, 'project'));
  assert.equal(configuredRepository.path, join(root, 'project', 'framework'));
  assert.throws(() => configSchema.parse({ ...raw, repositories: [{ ...repository, workspace: { kind: 'project-directory' } }] }));
  assert.throws(() => configSchema.parse({ ...raw, repositories: [{ ...repository, workspace: { kind: 'unknown', path: './project' } }] }));
});

test('loadConfig resolves discovery root and keeps source-only collection separate from legacy local entries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-discovery-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config.json');
  const raw = { feishu: { userOpenId: 'owner' }, engineering: { projectRoot: './projects' }, repositories: [
    { name: 'source/issues', criteria: { labelsAll: ['collect-me'] } },
    { name: 'legacy/project', path: './local', baseBranch: 'stable' },
  ] };
  await writeFile(path, JSON.stringify(raw));
  const config = await loadConfig(path);
  assert.equal(config.engineering?.projectRoot, join(root, 'projects'));
  const source = config.repositories[0]; assert.ok(source);
  assert.equal('path' in source, false); assert.equal('baseBranch' in source, false);
  assert.deepEqual(source.criteria.labelsAll, ['collect-me']);
  const legacy = config.repositories[1]; assert.ok(legacy && 'path' in legacy);
  assert.equal(legacy.path, join(root, 'local')); assert.equal(legacy.baseBranch, 'stable');
  assert.equal(configSchema.parse({ feishu: { userOpenId: 'owner' } }).engineering?.projectRoot, undefined);
  for (const projectRoot of ['', '  ', 4, ['projects']]) {
    assert.equal(configSchema.safeParse({ ...raw, engineering: { projectRoot } }).success, false);
  }
  for (const repository of [
    { name: 'source/issues' }, { name: 'invalid', criteria: {} },
    { name: 'source/issues', criteria: {}, path: './partial' },
    { name: 'source/issues', criteria: {}, baseBranch: 'main' },
    { name: 'source/issues', criteria: {}, workspace: { kind: 'project-directory', path: './projects' } },
  ]) assert.equal(configSchema.safeParse({ ...raw, repositories: [repository] }).success, false);
});
