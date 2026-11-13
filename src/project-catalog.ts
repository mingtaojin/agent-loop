import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Task, WorkspaceCandidate, WorkspaceChoice } from './domain.js';
import { errorMessage } from './domain.js';
import { discoverProjects } from './project-discovery.js';
import { ProjectLedger, projectConfigSchema, projectConfigInputSchema, type ProjectConfig } from './project.js';
import type { Store } from './store.js';

const catalogKey = 'project-catalog:auto';
const definitionsSchema = z.array(projectConfigInputSchema);
const bindingsKey = 'project-catalog:repositories';
const bindingsSchema = z.array(z.strictObject({ repository: z.string(), projectId: z.string() }));
const contains = (directory: string, path: string) => {
  const suffix = relative(directory, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../'));
};
async function canonical(path: string): Promise<string | null> {
  try {
    const directory = await realpath(path);
    return (await stat(directory)).isDirectory() ? directory : null;
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) return null;
    throw error;
  }
}

export class ProjectCatalog {
  private effective: ProjectConfig[] = [];
  private refreshing: Promise<void> | null = null;
  constructor(private readonly config: Config, private readonly store: Store) {}

  get configs(): ProjectConfig[] { return this.effective; }
  isExplicit(id: string): boolean { return this.config.projects.some(project => project.id === id); }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const pending = this.load();
    this.refreshing = pending;
    try { await pending; } finally { if (this.refreshing === pending) this.refreshing = null; }
  }

  private async discovered() {
    if (!this.config.engineering?.projectRoot) return [];
    try { return await discoverProjects(this.config.engineering.projectRoot); }
    catch (error) { this.store.diagnostic('project-discovery', errorMessage(error)); return []; }
  }

  private async load(): Promise<void> {
    const explicit: ProjectConfig[] = [];
    for (const config of this.config.projects) {
      const directory = await canonical(config.directory);
      if (!directory) throw new Error(`Project directory unavailable: ${config.id}`);
      const state = new ProjectLedger(this.store).project(config.id);
      if (state && state.directory !== directory) throw new Error(`Project directory identity changed: ${config.id}`);
      explicit.push({ ...config, directory });
    }
    const saved = definitionsSchema.parse(JSON.parse(this.store.meta(catalogKey) ?? '[]'));
    const bindings = bindingsSchema.parse(JSON.parse(this.store.meta(bindingsKey) ?? '[]'));
    const ledger = new ProjectLedger(this.store);
    const projects = new Set(this.store.tasks().map(task => ledger.membership(task.id)?.projectId).filter(id => id !== undefined));
    for (const projectId of projects) for (const issue of ledger.project(projectId)?.issues ?? []) {
      const previous = bindings.find(binding => binding.repository.toLowerCase() === issue.repository.toLowerCase());
      if (previous && previous.projectId !== projectId) throw new Error(`Conflicting durable repository ownership: ${issue.repository}`);
      if (!previous) bindings.push({ repository: issue.repository, projectId });
    }
    this.store.setMeta(bindingsKey, JSON.stringify(bindings));
    const automatic = new Map<string, ProjectConfig>();
    for (const config of saved) {
      const replacement = explicit.find(item => item.directory === config.directory && item.id !== config.id);
      if (replacement && new ProjectLedger(this.store).project(config.id)) throw new Error(`Project directory already belongs to ${config.id}; preserve its project ID`);
      if (explicit.some(item => item.id === config.id || item.directory === config.directory)) continue;
      if (await canonical(config.directory) !== config.directory) continue;
      automatic.set(config.directory, { ...config, repositories: [] });
    }
    const add = (directory: string, name: string): ProjectConfig | null => {
      if (explicit.some(item => item.directory === directory)) return null;
      const previous = automatic.get(directory);
      if (previous) return previous;
      const id = `auto-${createHash('sha256').update(directory).digest('hex')}`;
      if (explicit.some(item => item.id === id)) return null;
      const project = projectConfigSchema.parse({ id, name, directory, repositories: [] });
      automatic.set(directory, project);
      return project;
    };
    const discovered = await this.discovered();
    for (const project of discovered) add(project.canonicalPath, project.name);
    for (const repository of this.config.repositories) {
      if (!('path' in repository) || explicit.some(project => project.repositories.some(item => item.name.toLowerCase() === repository.name.toLowerCase()))) continue;
      const binding = bindings.find(item => item.repository.toLowerCase() === repository.name.toLowerCase());
      const bound = binding ? [...automatic.values()].find(project => project.id === binding.projectId) : null;
      if (bound) {
        bound.repositories.push({ name: repository.name, labelsAny: [], assigneesAny: [], criteria: repository.criteria });
        continue;
      }
      const root = await canonical(repository.path);
      const directory = await canonical(repository.workspace?.kind === 'project-directory' ? repository.workspace.path : repository.path);
      if (!root || !directory) continue;
      const owners = explicit.filter(project => contains(project.directory, directory));
      if (owners.length) continue;
      const parents = discovered.filter(project => contains(project.canonicalPath, directory));
      const paths = [...new Set(parents.map(project => project.canonicalPath))];
      if (paths.length > 1) continue;
      const parent = parents[0];
      const project = add(parent?.canonicalPath ?? directory, parent?.name ?? basename(directory));
      if (project) project.repositories.push({ name: repository.name, labelsAny: [], assigneesAny: [], criteria: repository.criteria });
    }
    const auto = [...automatic.values()];
    for (const binding of bindings) {
      const owner = [...explicit, ...auto].find(project => project.repositories.some(item => item.name.toLowerCase() === binding.repository.toLowerCase()));
      if (owner && owner.id !== binding.projectId) throw new Error(`Repository project ownership changed: ${binding.repository}`);
      const repository = this.config.repositories.find(item => item.name.toLowerCase() === binding.repository.toLowerCase());
      if (!repository) continue;
      const project = auto.find(item => item.id === binding.projectId);
      if (project && !owner) project.repositories.push({ name: repository.name, labelsAny: [], assigneesAny: [], criteria: repository.criteria });
    }
    const durable = new Map(saved.map(project => [project.id, project]));
    for (const project of auto) durable.set(project.id, project);
    this.store.setMeta(catalogKey, JSON.stringify([...durable.values()]));
    this.effective = [...explicit, ...auto];
  }

  async byId(id: string): Promise<ProjectConfig | null> {
    await this.refresh();
    return this.effective.find(project => project.id === id) ?? null;
  }

  async resolveRepository(repositoryName: string): Promise<ProjectConfig | null> {
    await this.refresh();
    return this.effective.find(project => project.repositories.some(repository => repository.name.toLowerCase() === repositoryName.toLowerCase())) ?? null;
  }

  repositoryOwner(repositoryName: string): string | null {
    const name = repositoryName.toLowerCase();
    const saved = bindingsSchema.parse(JSON.parse(this.store.meta(bindingsKey) ?? '[]'));
    return saved.find(binding => binding.repository.toLowerCase() === name)?.projectId
      ?? this.effective.find(project => project.repositories.some(repository => repository.name.toLowerCase() === name))?.id ?? null;
  }

  async bindRepository(repositoryName: string, projectId: string, beforeBind?: () => void): Promise<ProjectConfig> {
    await this.refresh();
    const project = this.effective.find(item => item.id === projectId);
    if (!project) throw new Error('Project configuration unavailable');
    const owner = this.effective.find(item => item.repositories.some(repository => repository.name.toLowerCase() === repositoryName.toLowerCase()));
    if (owner) {
      if (owner.id !== project.id) throw new Error('Repository belongs to another project');
    }
    if (this.isExplicit(project.id)) {
      if (!owner) throw new Error('Repository is outside the explicit project intake scope');
    }
    const repository = this.config.repositories.find(item => item.name.toLowerCase() === repositoryName.toLowerCase())
      ?? project.repositories.find(item => item.name.toLowerCase() === repositoryName.toLowerCase());
    if (!repository) throw new Error('Repository is not a configured collection source');
    const bindings = bindingsSchema.parse(JSON.parse(this.store.meta(bindingsKey) ?? '[]'));
    const previous = bindings.find(item => item.repository.toLowerCase() === repositoryName.toLowerCase());
    if (previous && previous.projectId !== project.id) throw new Error('Repository project ownership is immutable');
    if (!previous) bindings.push({ repository: repository.name, projectId: project.id });
    this.store.transaction(() => {
      beforeBind?.();
      this.store.setMeta(bindingsKey, JSON.stringify(bindings));
    });
    await this.refresh();
    const result = this.effective.find(item => item.id === project.id);
    if (!result) throw new Error('Bound project is unavailable');
    return result;
  }

  private async resolveDirectory(path: string, expected?: string): Promise<ProjectConfig | null> {
    const directory = await canonical(path);
    if (!directory || (expected !== undefined && directory !== expected)) return null;
    const exact = this.effective.filter(project => project.directory === directory);
    const explicit = exact.filter(project => this.config.projects.some(item => item.id === project.id));
    if (explicit.length) return explicit.length === 1 ? explicit[0] ?? null : null;
    if (exact.length) return exact.length === 1 ? exact[0] ?? null : null;
    const parents = this.effective.filter(project => contains(project.directory, directory));
    return parents.length === 1 ? parents[0] ?? null : null;
  }

  async resolveSelection(choice: WorkspaceChoice, candidates: WorkspaceCandidate[]): Promise<ProjectConfig | null> {
    await this.refresh();
    if (choice.kind === 'none' || choice.kind === 'question') return null;
    if (choice.kind === 'repository') {
      const candidate = candidates.find(item => !('kind' in item) && item.name.toLowerCase() === choice.repositoryName.toLowerCase());
      const repository = this.config.repositories.find(item => item.name.toLowerCase() === choice.repositoryName.toLowerCase());
      if (!candidate || 'kind' in candidate || !repository || !('path' in repository)) return null;
      const directory = await canonical(repository.path);
      if (!directory || await canonical(candidate.path) !== directory) return null;
      const candidateWorkspace = candidate.workspace?.kind === 'project-directory' ? candidate.workspace.path : candidate.path;
      const workspace = repository.workspace?.kind === 'project-directory' ? repository.workspace.path : repository.path;
      if (await canonical(candidateWorkspace) !== await canonical(workspace)) return null;
      return this.resolveRepository(repository.name);
    }
    const candidate = candidates.find(item => 'kind' in item && item.id === choice.projectId);
    if (!candidate || !('kind' in candidate)) return null;
    const discovered = await this.discovered();
    const entry = discovered.find(item => item.id === candidate.id && item.entryPath === candidate.entryPath && item.canonicalPath === candidate.canonicalPath);
    const configured = this.effective.find(project => (project.id === candidate.id || `coordinated:${project.id}` === candidate.id)
      && project.directory === candidate.canonicalPath);
    if (!entry && !configured) return null;
    if (configured && await canonical(candidate.entryPath) === candidate.canonicalPath) return configured;
    return this.resolveDirectory(candidate.entryPath, candidate.canonicalPath);
  }

  async resolveTask(task: Task): Promise<ProjectConfig | null> {
    await this.refresh();
    const member = new ProjectLedger(this.store).membership(task.id);
    if (member) return this.effective.find(project => project.id === member.projectId) ?? null;
    const resolved: ProjectConfig[] = [];
    if (task.source.kind === 'github') {
      const project = await this.resolveRepository(task.source.issue.repository);
      if (project) resolved.push(project);
    }
    for (const resource of task.resources) {
      let project: ProjectConfig | null;
      if (resource.kind === 'project') project = await this.resolveDirectory(resource.project.entryPath, resource.project.canonicalPath);
      else {
        const configured = this.config.repositories.find(repository => repository.name.toLowerCase() === resource.repository.name.toLowerCase());
        if (configured && 'path' in configured && await canonical(configured.path) !== await canonical(resource.repository.path)) return null;
        project = await this.resolveRepository(resource.repository.name)
          ?? await this.resolveDirectory(resource.repository.workspace?.kind === 'project-directory' ? resource.repository.workspace.path : resource.repository.path);
      }
      if (!project) return null;
      resolved.push(project);
    }
    if (task.workspaceSelection.kind === 'selected') {
      const choice = task.workspaceSelection.choice;
      if (choice.kind === 'project') {
        const project = await this.resolveDirectory(choice.project.entryPath, choice.project.canonicalPath);
        if (!project) return null;
        resolved.push(project);
      } else if (choice.kind === 'repository') {
        const project = await this.resolveRepository(choice.repositoryName);
        if (project) resolved.push(project);
        else if (!resolved.length) return null;
      }
    }
    const ids = new Set(resolved.map(project => project.id));
    return ids.size === 1 ? resolved[0] ?? null : null;
  }
}
