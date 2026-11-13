import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspacePort } from './ports.js';

const execute = promisify(execFile);

async function git(directory: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute('git', ['-C', directory, ...args], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000,
  });
  return stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export class WorkspaceProvider implements WorkspacePort {
  readonly supportsCloseout = true;
  private readonly root: string;
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) { this.root = resolve(dataDir, 'workspaces'); }

  async ensure(input: Parameters<WorkspacePort['ensure']>[0]): Promise<string> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.taskId)) throw new Error('Invalid task workspace identifier');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.resourceId)) throw new Error('Invalid workspace resource identifier');
    if (input.kind === 'project-directory') {
      const directory = await realpath(input.directory);
      if (!(await stat(directory)).isDirectory()) throw new Error('Project workspace must be an existing directory');
      if (input.workspace !== undefined && input.workspace !== directory) throw new Error('Project workspace association changed');
      return directory;
    }
    const repositoryPath = await realpath(input.repository.path);
    const repositoryRoot = await realpath(await git(repositoryPath, 'rev-parse', '--show-toplevel'));
    if (repositoryRoot !== repositoryPath) throw new Error('Repository path must be its Git root');
    const commonDirectory = await realpath(await git(repositoryPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    const previous = this.mutations.get(commonDirectory) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await git(repositoryPath, 'check-ref-format', '--branch', input.branch);
      await mkdir(this.root, { recursive: true });
      const root = await realpath(this.root);
      const resourcePath = resolve(root, `${input.taskId}--${input.resourceId}`);
      const legacyPath = resolve(root, input.taskId);
      const workspace = input.workspace ? resolve(await realpath(dirname(input.workspace)), basename(input.workspace)) : resourcePath;
      if (workspace !== resourcePath && workspace !== legacyPath) throw new Error('Persisted workspace path does not belong to this task resource');
      if (input.workspace && !await exists(workspace)) throw new Error('Persisted workspace directory is missing');
      if (workspace === repositoryRoot) throw new Error('Task workspace cannot be the original repository');
      if (await exists(workspace)) {
        if (input.fresh) throw new Error('New ownership requires a newly allocated worktree');
        const info = await lstat(workspace);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Workspace is not an owned directory: ${workspace}`);
        const actualRoot = await realpath(await git(workspace, 'rev-parse', '--show-toplevel'));
        const actualCommonDirectory = await realpath(await git(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
        const actualGitDirectory = await realpath(await git(workspace, 'rev-parse', '--absolute-git-dir'));
        const actualBranch = await git(workspace, 'symbolic-ref', '--quiet', 'HEAD');
        if (actualRoot !== workspace || actualCommonDirectory !== commonDirectory || actualGitDirectory === commonDirectory || actualBranch !== `refs/heads/${input.branch}`) {
          throw new Error(`Workspace identity does not match task ${input.taskId}`);
        }
        const registrations = await git(repositoryPath, 'worktree', 'list', '--porcelain', '-z');
        if (!registrations.split('\0').includes(`worktree ${workspace}`)) throw new Error(`Workspace is not registered: ${workspace}`);
        return input.workspace ?? workspace;
      }
      const existingBranch = await git(repositoryPath, 'for-each-ref', '--format=%(refname)', `refs/heads/${input.branch}`);
      if (existingBranch) throw new Error(`Task branch already exists without its workspace: ${input.branch}`);
      const base = await git(repositoryPath, 'rev-parse', '--verify', '--end-of-options', `${input.repository.baseBranch}^{commit}`);
      await git(repositoryPath, 'worktree', 'add', '-b', input.branch, '--', workspace, base);
      return input.workspace ?? workspace;
    });
    this.mutations.set(commonDirectory, operation);
    try { return await operation; }
    finally { if (this.mutations.get(commonDirectory) === operation) this.mutations.delete(commonDirectory); }
  }

  async head(workspace: string): Promise<string> { return git(workspace, 'rev-parse', '--verify', 'HEAD'); }

  async release(input: { taskId: string; resourceId: string; workspace: string; repository: import('./domain.js').Repository; branch: string }): Promise<void> {
    const root = await realpath(this.root);
    const expected = resolve(root, `${input.taskId}--${input.resourceId}`);
    const legacy = resolve(root, input.taskId);
    if (resolve(input.workspace) !== expected && resolve(input.workspace) !== legacy) throw new Error('Release path does not belong to the task');
    if (!await exists(input.workspace)) return;
    await this.ensure({ ...input, kind: 'git-worktree' });
    const dirty = await git(input.workspace, 'status', '--porcelain', '--untracked-files=all', '--ignored');
    if (dirty) throw new Error('Workspace contains uncommitted, untracked or ignored files; preserve them before release');
    const base = await git(input.repository.path, 'rev-parse', '--verify', '--end-of-options', `${input.repository.baseBranch}^{commit}`);
    const head = await this.head(input.workspace);
    try { await git(input.repository.path, 'merge-base', '--is-ancestor', head, base); }
    catch { throw new Error('Workspace commits are not preserved on the configured base; release refused'); }
    await git(input.repository.path, 'worktree', 'remove', '--', input.workspace);
  }
}
