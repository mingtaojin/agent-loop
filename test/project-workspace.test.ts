import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { repositorySchema } from '../src/domain.js';
import { WorkspaceProvider } from '../src/workspace.js';

const execute = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'project-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(repo);
  const git = (...args: string[]) => execute('git', ['-C', repo, ...args]);
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repo, 'base'), 'base'); await writeFile(join(repo, '.gitignore'), 'build/\n');
  await git('add', '.'); await git('commit', '-m', 'base');
  const repository = repositorySchema.parse({ name: 'fixture/repo', path: repo, baseBranch: 'main' });
  const provider = new WorkspaceProvider(join(root, 'data'));
  const input = { taskId: 'worker', resourceId: 'repo', repository, branch: 'worker-branch' };
  const workspace = await provider.ensure(input);
  return { root, repo, git, provider, input: { ...input, workspace }, workspace };
}

test('release removes only an owned clean worktree and is repeatable', async t => {
  const f = await fixture(t);
  await f.provider.release(f.input);
  await assert.rejects(stat(f.workspace), /ENOENT/);
  assert.equal(await readFile(join(f.repo, 'base'), 'utf8'), 'base');
  await f.provider.release(f.input);
  assert.ok((await f.git('show-ref', '--verify', 'refs/heads/worker-branch')).stdout);
});

test('release preserves uncommitted, untracked and ignored artifacts', async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, 'base'), 'changed');
  await assert.rejects(f.provider.release(f.input), /uncommitted/);
  await writeFile(join(f.workspace, 'base'), 'base');
  await writeFile(join(f.workspace, 'untracked'), 'evidence');
  await assert.rejects(f.provider.release(f.input), /untracked/);
  await rm(join(f.workspace, 'untracked'));
  await mkdir(join(f.workspace, 'build')); await writeFile(join(f.workspace, 'build', 'result'), 'artifact');
  await assert.rejects(f.provider.release(f.input), /ignored/);
  assert.equal(await readFile(join(f.workspace, 'build', 'result'), 'utf8'), 'artifact');
});

test('release preserves unique commits until the configured base contains them', async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, 'new'), 'work');
  await execute('git', ['-C', f.workspace, 'add', '.']);
  await execute('git', ['-C', f.workspace, 'commit', '-m', 'work']);
  await assert.rejects(f.provider.release(f.input), /not preserved/);
  await f.git('merge', '--ff-only', 'worker-branch');
  await f.provider.release(f.input);
  assert.equal(await readFile(join(f.repo, 'new'), 'utf8'), 'work');
});

test('release rejects the original repository and another task path', async t => {
  const f = await fixture(t);
  await assert.rejects(f.provider.release({ ...f.input, workspace: f.repo }), /does not belong/);
  await assert.rejects(f.provider.release({ ...f.input, taskId: 'other' }), /does not belong/);
  assert.ok(await stat(f.workspace));
});
