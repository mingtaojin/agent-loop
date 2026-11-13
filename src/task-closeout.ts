import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { taskResourceSchema, type Task, type TaskResource } from './domain.js';
import type { Store } from './store.js';

const execute = promisify(execFile);
const identitySchema = z.strictObject({ path: z.string(), dev: z.number(), ino: z.number() });
const locationSchema = z.strictObject({ root: identitySchema, ancestors: z.array(identitySchema) });
const branchIdentitySchema = z.array(z.strictObject({ path: z.string(), dev: z.string(), ino: z.string(), birthtimeNs: z.string(), ctimeNs: z.string(), parent: locationSchema }));
const scopeSchema = z.strictObject({
  id: z.string(), allocationRequestId: z.string().nullable(), location: locationSchema, createdAt: z.number(), sealed: z.boolean(),
  resource: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('artifacts'), label: z.string() }),
    z.strictObject({ kind: z.literal('worktree'), association: taskResourceSchema, common: locationSchema, gitDirectory: locationSchema }),
  ]),
  artifacts: z.array(z.strictObject({ path: z.string(), dev: z.number(), ino: z.number(), disposition: z.enum(['temporary', 'undelivered', 'delivered', 'superseded', 'abandoned']), reference: z.string().nullable() })),
});
const completionSchema = z.strictObject({ kind: z.literal('completed'), outcome: z.enum(['delivered', 'terminated']), summary: z.string(), deliveryReferences: z.array(z.string()), at: z.number(), operationId: z.string() });
const targetSchema = z.strictObject({ scope: scopeSchema, branchHead: z.string().nullable(), branchIdentity: branchIdentitySchema.nullable().default(null), disposalPath: z.string(),
  state: z.enum(['pending', 'removed', 'protected']), reason: z.string().nullable(), directoryRemoved: z.boolean(), branchRemoved: z.boolean() });
const operationSchema = z.strictObject({ id: z.string(), requestId: z.string(), callerId: z.string(), projectId: z.string(), fingerprint: z.string(),
  kind: z.enum(['completion', 'scopes']), createdAt: z.number(), targets: z.array(targetSchema) });
export const taskCloseoutSchema = z.strictObject({ taskId: z.string(), projectId: z.string().nullable(),
  lifecycle: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('open') }), completionSchema]),
  scopes: z.array(scopeSchema), operations: z.array(operationSchema), predecessorTaskId: z.string().nullable() });
type Ledger = z.infer<typeof taskCloseoutSchema>;
type Scope = z.infer<typeof scopeSchema>;
type Target = z.infer<typeof targetSchema>;
export type CloseoutOperation = z.infer<typeof operationSchema>;
const within = (parent: string, child: string) => { const suffix = relative(parent, child); return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../')); };
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
async function identity(path: string) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Not a physical directory: ${path}`);
  return { path, dev: info.dev, ino: info.ino };
}
async function location(path: string): Promise<z.infer<typeof locationSchema>> {
  const canonical = await realpath(path);
  if (resolve(path) !== canonical) throw new Error('Owned path must be canonical, without symbolic links');
  const ancestors = [];
  for (let parent = dirname(canonical); ; parent = dirname(parent)) { ancestors.push(await identity(parent)); if (parent === dirname(parent)) break; }
  return { root: await identity(canonical), ancestors };
}
async function same(expected: z.infer<typeof identitySchema>): Promise<boolean> {
  const actual = await identity(expected.path);
  return actual.dev === expected.dev && actual.ino === expected.ino;
}
async function checkLocation(value: z.infer<typeof locationSchema>, allowMissing = false): Promise<boolean> {
  for (const parent of value.ancestors) if (!await same(parent)) throw new Error(`Ancestor identity changed: ${parent.path}`);
  try { if (!await same(value.root)) throw new Error(`Resource identity changed: ${value.root.path}`); return true; }
  catch (error) { if (allowMissing && missing(error)) return false; throw error; }
}
async function absentLocation(value: z.infer<typeof locationSchema>): Promise<boolean> {
  let present = false;
  for (const expected of [value.root, ...value.ancestors]) {
    try {
      if (!await same(expected)) throw new Error(`Resource identity changed: ${expected.path}`);
      if (expected.path === value.root.path) present = true;
    } catch (error) { if (!missing(error)) throw error; }
  }
  return !present;
}
async function git(path: string, ...args: string[]) { return (await execute('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim(); }
async function localBranchHead(repository: string, ref: string): Promise<string | null> {
  const heads = await git(repository, 'for-each-ref', '--format=%(refname) %(objectname)', ref);
  return heads.split('\n').find(head => head.startsWith(`${ref} `))?.slice(ref.length + 1) ?? null;
}
async function branchIdentity(common: string, ref: string): Promise<z.infer<typeof branchIdentitySchema>> {
  const file = async (path: string) => {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Task branch identity is not a physical file: ${path}`);
    return { path, dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs), ctimeNs: String(info.ctimeNs), parent: await location(dirname(path)) };
  };
  let backing: Awaited<ReturnType<typeof file>>;
  try { backing = await file(join(common, ref)); }
  catch (error) { if (!missing(error)) throw error; backing = await file(join(common, 'packed-refs')); }
  const result = [backing];
  try { result.push(await file(join(common, 'logs', ref))); }
  catch (error) { if (!missing(error)) throw error; }
  return result;
}
async function checkBranchIdentity(expected: Target['branchIdentity'], common: string, ref: string) {
  if (!expected || JSON.stringify(await branchIdentity(common, ref)) !== JSON.stringify(expected)) throw new Error('Task branch identity changed after closeout');
}
async function processUse(path: string): Promise<string | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return 'Process-use probe is unavailable on this host';
  try {
    const { stdout, stderr } = await execute('lsof', ['-nP', '-Fpn', '+D', path], { encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return stderr.trim() ? `Process-use probe incomplete: ${stderr.trim()}` : stdout.trim() ? 'A process has a cwd or open file in this resource' : null;
  } catch (error) {
    const result = z.object({ code: z.literal(1), stdout: z.literal(''), stderr: z.literal('') }).safeParse(error);
    return result.success ? null : `Process-use probe unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export class CleanupAdmissionBusy extends Error {}

export class TaskCloseout {
  private readonly destructing = new Set<string>();
  private readonly reservations = new Map<string, number>();
  private readonly progressing = new Map<string, Promise<void>>();
  constructor(private readonly store: Store, private readonly host: {
    usage(task: Task): Promise<string | null>;
    assertCompletionAllowed?(task: Task): void;
    protectedPaths(): string[];
  }) {}
  read(taskId: string): Ledger {
    const value = this.store.meta(`task-closeout:${taskId}`);
    return value ? taskCloseoutSchema.parse(JSON.parse(value)) : { taskId, projectId: null, lifecycle: { kind: 'open' }, scopes: [], operations: [], predecessorTaskId: null };
  }
  private save(value: Ledger) { this.store.setMeta(`task-closeout:${value.taskId}`, JSON.stringify(taskCloseoutSchema.parse(value))); }
  completed(taskId: string) { return this.read(taskId).lifecycle.kind === 'completed'; }
  assertOpen(taskId: string) { if (this.completed(taskId)) throw new Error('Task is completed; dispatch a new linked task'); }
  reserve(taskId: string): () => void {
    this.assertOpen(taskId);
    if (this.destructing.has(taskId)) throw new CleanupAdmissionBusy('Task cleanup is in flight; retry admission');
    this.reservations.set(taskId, (this.reservations.get(taskId) ?? 0) + 1);
    return () => { const count = (this.reservations.get(taskId) ?? 1) - 1; if (count) this.reservations.set(taskId, count); else this.reservations.delete(taskId); };
  }
  async initialize(task: Task): Promise<void> {
    await mkdir(task.contextDirectory, { recursive: true, mode: 0o700 });
    await this.allocate(task.id, await realpath(task.contextDirectory), 'Default artifacts');
  }
  async allocate(taskId: string, parent: string, label: string, allocationRequestId: string | null = null): Promise<Scope> {
    const release = this.reserve(taskId);
    try {
      const parentLocation = await location(parent);
      const path = await mkdtemp(join(parent, 'artifacts-'));
      if (!await checkLocation(parentLocation)) throw new Error('Artifact parent changed');
      const scope: Scope = { id: randomUUID(), allocationRequestId, location: await location(path), createdAt: Date.now(), sealed: false, resource: { kind: 'artifacts', label }, artifacts: [] };
      const state = this.read(taskId); state.scopes.push(scope); this.save(state); return scope;
    } finally { release(); }
  }
  async allocateExternal(taskId: string, parent: string | undefined, projectId: string, projectDirectory: string, label: string, requestId: string) {
    this.assertOpen(taskId);
    this.bind(taskId, projectId);
    const state = this.read(taskId);
    const existing = state.scopes.find(scope => scope.allocationRequestId === requestId);
    if (existing) return existing;
    const candidate = parent ?? await realpath(this.store.task(taskId).contextDirectory);
    const canonical = await realpath(candidate);
    if (resolve(candidate) !== canonical) throw new Error('Artifact parent must be canonical');
    if (parent && canonical !== projectDirectory && !state.scopes.some(scope => !scope.sealed && scope.resource.kind === 'worktree' && within(scope.location.root.path, canonical)))
      throw new Error('External artifacts require the project directory or a newly owned worktree parent');
    return this.allocate(taskId, canonical, label, requestId);
  }
  bind(taskId: string, projectId: string) {
    const value = this.read(taskId);
    if (value.projectId && value.projectId !== projectId) throw new Error('Resource project identity changed');
    value.projectId = projectId; this.save(value);
  }
  link(taskId: string, predecessorTaskId: string) { const value = this.read(taskId); value.predecessorTaskId = predecessorTaskId; this.save(value); }
  async enrollWorktree(taskId: string, association: TaskResource): Promise<void> {
    if (association.kind !== 'git-worktree') return;
    this.assertOpen(taskId);
    const common = await realpath(await git(association.workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    const gitDirectory = await realpath(await git(association.workspace, 'rev-parse', '--absolute-git-dir'));
    if (common === gitDirectory) throw new Error('Original repository cannot be enrolled');
    const state = this.read(taskId);
    state.scopes.push({ id: randomUUID(), allocationRequestId: null, location: await location(association.workspace), createdAt: Date.now(), sealed: false,
      resource: { kind: 'worktree', association, common: await location(common), gitDirectory: await location(gitDirectory) }, artifacts: [] });
    this.save(state);
  }
  async register(taskId: string, scopeId: string, path: string, disposition: Scope['artifacts'][number]['disposition'], reference?: string) {
    const state = this.read(taskId), scope = state.scopes.find(scope => scope.id === scopeId);
    if (!scope) throw new Error('Unknown owned artifact scope');
    if (scope.sealed && disposition === 'undelivered') throw new Error('Sealed scopes cannot accept new delivery holds');
    if (disposition === 'delivered' && !reference?.trim()) throw new Error('Delivered artifacts require a delivery reference');
    const canonical = await realpath(path);
    if (resolve(path) !== canonical || !within(scope.location.root.path, canonical)) throw new Error('Artifact is outside its owned scope');
    await checkLocation(scope.location);
    const info = await lstat(canonical);
    const current = this.read(taskId), latest = current.scopes.find(item => item.id === scopeId);
    if (!latest || (latest.sealed && disposition === 'undelivered')) throw new Error('Artifact scope was sealed');
    const previous = latest.artifacts.find(item => item.path === canonical);
    if (previous && (previous.dev !== info.dev || previous.ino !== info.ino)) throw new Error('Registered artifact identity changed');
    if (latest.sealed && !previous) throw new Error('Sealed scopes cannot register new artifacts');
    latest.artifacts = [...latest.artifacts.filter(item => item.path !== canonical), { path: canonical, dev: info.dev, ino: info.ino, disposition, reference: reference ?? null }];
    this.save(current); return { scopeId, path: canonical, disposition };
  }
  async accept(input: { taskId: string; callerId: string; projectId: string; requestId: string; fingerprint: string; scopeIds?: string[];
    completion?: { outcome: 'delivered' | 'terminated'; summary: string; deliveryReferences: string[] } }): Promise<{ operationId: string; taskId: string }> {
    const old = this.read(input.taskId).operations.find(op => op.callerId === input.callerId && op.requestId === input.requestId);
    if (old) { if (old.fingerprint !== input.fingerprint) throw new Error('Closeout request has different content'); return { operationId: old.id, taskId: input.taskId }; }
    this.assertOpen(input.taskId);
    if (input.completion && (this.store.inputs(input.taskId).some(item => ['delivering', 'uncertain'].includes(item.status))
      || this.store.approvals(input.taskId).some(item => ['processing', 'uncertain', 'pending'].includes(item.status)))) throw new Error('Reconcile unresolved input and approvals before completion');
    if (this.reservations.has(input.taskId)) throw new Error('Resource allocation or execution admission is in flight; retry closeout');
    this.bind(input.taskId, input.projectId);
    const initial = this.read(input.taskId);
    const scopes = input.scopeIds ? input.scopeIds.map(id => { const scope = initial.scopes.find(item => item.id === id); if (!scope || scope.sealed || scope.resource.kind !== 'artifacts') throw new Error('Unknown, sealed or non-artifact scope'); return scope; }) : initial.scopes.filter(scope => !scope.sealed);
    if (new Set(scopes.map(scope => scope.id)).size !== scopes.length) throw new Error('Duplicate artifact scope');
    scopes.sort((a, b) => b.location.root.path.length - a.location.root.path.length);
    const id = randomUUID();
    const targets: Target[] = [];
    for (const scope of scopes) {
      let branchHead: string | null = null;
      let frozenBranch: Target['branchIdentity'] = null;
      if (scope.resource.kind === 'worktree') {
        const association = scope.resource.association;
        if (association.kind !== 'git-worktree') throw new Error('Invalid worktree ownership');
        branchHead = await localBranchHead(association.repository.path, `refs/heads/${association.branch}`);
        if (branchHead) frozenBranch = await branchIdentity(scope.resource.common.root.path, `refs/heads/${association.branch}`);
      }
      targets.push({ scope: structuredClone(scope), branchHead, branchIdentity: frozenBranch, disposalPath: join(dirname(scope.location.root.path), `.closeout-${id}-${scope.id}`), state: 'pending', reason: null, directoryRemoved: false, branchRemoved: scope.resource.kind !== 'worktree' });
    }
    return this.store.transaction(() => {
      this.assertOpen(input.taskId);
      if (input.completion && (this.store.inputs(input.taskId).some(item => ['delivering', 'uncertain'].includes(item.status))
        || this.store.approvals(input.taskId).some(item => ['processing', 'uncertain', 'pending'].includes(item.status)))) throw new Error('Reconcile unresolved input and approvals before completion');
      if (this.reservations.has(input.taskId)) throw new Error('Resource allocation or execution admission is in flight; retry closeout');
      const state = this.read(input.taskId);
      if (JSON.stringify(state.scopes) !== JSON.stringify(initial.scopes)) throw new Error('Owned resources changed; retry closeout');
      if (input.completion) {
        const task = this.store.task(input.taskId);
        if (task.threadId && !this.host.assertCompletionAllowed) throw new Error('Native request completion protection is unavailable');
        this.host.assertCompletionAllowed?.(task);
      }
      state.operations.push({ id, requestId: input.requestId, callerId: input.callerId, projectId: input.projectId, fingerprint: input.fingerprint,
        kind: input.completion ? 'completion' : 'scopes', createdAt: Date.now(), targets });
      for (const scope of state.scopes) if (scopes.some(item => item.id === scope.id)) scope.sealed = true;
      if (input.completion) state.lifecycle = { kind: 'completed', ...input.completion, at: Date.now(), operationId: id };
      this.save(state);
      return { operationId: id, taskId: input.taskId };
    });
  }
  async progress(taskId: string): Promise<void> {
    const old = this.progressing.get(taskId); if (old) return old;
    const work = this.progressTask(taskId); this.progressing.set(taskId, work);
    try { await work; } finally { this.progressing.delete(taskId); }
  }
  private async progressTask(taskId: string) {
    for (const operation of this.read(taskId).operations) for (const frozen of operation.targets) {
      if (frozen.state === 'removed') continue;
      const target = structuredClone(frozen);
      try {
        const scope = this.read(taskId).scopes.find(scope => scope.id === target.scope.id);
        if (!scope) throw new Error('Ownership record missing');
        if (this.read(taskId).scopes.some(child => within(scope.location.root.path, child.location.root.path) && child.artifacts.some(artifact => artifact.disposition === 'undelivered'))) { target.state = 'protected'; target.reason = 'Unique deliverable has not been delivered'; }
        else {
          target.state = 'pending'; target.reason = null;
          if (this.reservations.has(taskId)) throw new Error('Resource allocation or execution admission is in flight');
          this.destructing.add(taskId);
          const usage = await this.host.usage(this.store.task(taskId));
          if (usage) throw new Error(usage);
          await this.remove(taskId, target);
          target.state = 'removed';
        }
      } catch (error) { target.reason = error instanceof Error ? error.message : String(error); }
      finally { this.destructing.delete(taskId); }
      const current = this.read(taskId), saved = current.operations.find(item => item.id === operation.id);
      if (!saved) throw new Error('Cleanup intent disappeared');
      saved.targets = saved.targets.map(item => item.scope.id === target.scope.id ? target : item);
      this.save(current);
    }
  }
  private async guard(taskId: string, target: Target) {
    const path = target.scope.location.root.path;
    for (const protectedPath of this.host.protectedPaths()) if (within(path, protectedPath)) throw new Error('Scope contains protected project or input records');
    for (const other of this.store.tasks()) {
      if (other.id !== taskId && other.resources.some(resource => within(path, resource.workspace) || (resource.kind === 'git-worktree' && overlaps(path, resource.workspace)))) throw new Error('Resource is associated with another task');
      if (other.id !== taskId && this.read(other.id).scopes.some(scope => overlaps(path, scope.location.root.path))) throw new Error('Resource overlaps another task ownership');
    }
    if (this.read(taskId).scopes.some(scope => scope.id !== target.scope.id && within(path, scope.location.root.path) && !scope.sealed)) throw new Error('A newer scope is inside this resource');
    if (this.reservations.has(taskId)) throw new Error('Task admission is in flight');
    await this.checkArtifacts(taskId, target, path);
  }
  private async checkArtifacts(taskId: string, target: Target, actualRoot: string) {
    const path = target.scope.location.root.path;
    for (const scope of this.read(taskId).scopes.filter(scope => within(path, scope.location.root.path))) for (const artifact of scope.artifacts) {
      try {
        const info = await lstat(join(actualRoot, relative(path, artifact.path)));
        if (info.isSymbolicLink() || info.dev !== artifact.dev || info.ino !== artifact.ino) throw new Error(`Registered artifact identity changed: ${artifact.path}`);
      } catch (error) { if (!missing(error)) throw error; }
    }
  }
  private async remove(taskId: string, target: Target) {
    await this.guard(taskId, target);
    const path = target.scope.location.root.path;
    const present = await checkLocation(target.scope.location, true);
    if (target.scope.resource.kind === 'artifacts') {
      let disposalPresent = false;
      try {
        const actual = await identity(target.disposalPath);
        if (actual.dev !== target.scope.location.root.dev || actual.ino !== target.scope.location.root.ino) throw new Error('Disposal identity changed');
        disposalPresent = true;
      } catch (error) { if (!missing(error)) throw error; }
      if (present && disposalPresent) throw new Error('Both resource and disposal paths exist');
      if (present) {
        const use = await processUse(path); if (use) throw new Error(use);
        await checkLocation(target.scope.location);
        await this.guard(taskId, target);
        await rename(path, target.disposalPath);
        disposalPresent = true;
      }
      if (disposalPresent) {
        const use = await processUse(target.disposalPath); if (use) throw new Error(use);
        const actual = await identity(target.disposalPath);
        if (actual.dev !== target.scope.location.root.dev || actual.ino !== target.scope.location.root.ino) throw new Error('Disposal identity changed');
        await this.checkArtifacts(taskId, target, target.disposalPath);
        await rm(target.disposalPath, { recursive: true });
      }
      target.directoryRemoved = true;
      return;
    }
    const resource = target.scope.resource, association = resource.association;
    if (association.kind !== 'git-worktree') throw new Error('Invalid frozen worktree identity');
    await checkLocation(resource.common);
    const repository = await realpath(association.repository.path);
    if (await realpath(await git(repository, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== resource.common.root.path) throw new Error('Repository identity changed');
    const ref = `refs/heads/${association.branch}`;
    const branchHead = await localBranchHead(repository, ref);
    if (branchHead && branchHead !== target.branchHead) throw new Error('Task branch changed after closeout');
    if (branchHead) await checkBranchIdentity(target.branchIdentity, resource.common.root.path, ref);
    if (target.branchHead === null && (present || !await absentLocation(resource.gitDirectory))) throw new Error('Task branch is missing while its worktree or Git registration remains');
    if (present) {
      await checkLocation(resource.gitDirectory);
      if (await git(path, 'symbolic-ref', '--quiet', 'HEAD') !== ref || await realpath(await git(path, 'rev-parse', '--absolute-git-dir')) !== resource.gitDirectory.root.path) throw new Error('Worktree identity changed');
      const use = await processUse(path); if (use) throw new Error(use);
      await checkLocation(target.scope.location);
      await this.guard(taskId, target);
      await git(repository, 'worktree', 'remove', '--force', '--', path);
    }
    if ((await git(repository, 'worktree', 'list', '--porcelain', '-z')).split('\0').includes(`worktree ${path}`)) {
      if (target.branchHead === null) throw new Error('Task branch is missing while its worktree remains registered');
      if (present) throw new Error('Worktree remains registered');
      await checkLocation(resource.gitDirectory);
      if ((await readFile(join(resource.gitDirectory.root.path, 'gitdir'), 'utf8')).trim() !== join(path, '.git')) throw new Error('Missing worktree registration changed');
      await git(repository, 'worktree', 'remove', '--force', '--', path);
      if ((await git(repository, 'worktree', 'list', '--porcelain', '-z')).split('\0').includes(`worktree ${path}`)) throw new Error('Worktree remains registered');
    }
    target.directoryRemoved = true;
    const registrations = (await git(repository, 'worktree', 'list', '--porcelain', '-z')).split('\0');
    if (registrations.includes(`branch ${ref}`)) throw new Error('Task branch is checked out elsewhere');
    if (branchHead && target.branchHead !== null) {
      await checkBranchIdentity(target.branchIdentity, resource.common.root.path, ref);
      await git(repository, 'update-ref', '-d', ref, target.branchHead);
    }
    if (await localBranchHead(repository, ref)) throw new Error('Task branch remains');
    target.branchRemoved = true;
    this.store.transaction(() => {
      this.store.setMeta(`released-resource:${taskId}:${association.id}`, 'released');
      const task = this.store.task(taskId); task.resources = task.resources.filter(item => item.id !== association.id); this.store.saveTask(task);
    });
  }
}
