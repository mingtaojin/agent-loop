import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DiscoveredProject } from './domain.js';

const discoveryCacheTtlMs = 5_000;
const discoveryCache = new Map<string, { expiresAt: number; projects: DiscoveredProject[]; pending?: Promise<DiscoveredProject[]> }>();

export async function discoverProjects(root: string): Promise<DiscoveredProject[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const projects: DiscoveredProject[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === '__MACOSX' || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const entryPath = resolve(root, entry.name);
    try {
      const canonicalPath = await realpath(entryPath);
      if (!(await stat(canonicalPath)).isDirectory()) continue;
      const id = 'project-' + createHash('sha256').update(JSON.stringify([entryPath, canonicalPath])).digest('hex');
      projects.push({ kind: 'project', id, name: entry.name, entryPath, canonicalPath });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return projects;
}

export async function discoverProjectsCached(root: string): Promise<DiscoveredProject[]> {
  const now = Date.now();
  const cached = discoveryCache.get(root);
  if (cached && cached.expiresAt > now) return cached.projects;
  if (cached?.pending) return cached.pending;
  const pending = discoverProjects(root).then(projects => {
    discoveryCache.set(root, { projects, expiresAt: Date.now() + discoveryCacheTtlMs });
    return projects;
  }).finally(() => {
    const current = discoveryCache.get(root);
    if (current && current.pending === pending) discoveryCache.set(root, { projects: current.projects, expiresAt: current.expiresAt });
  });
  discoveryCache.set(root, { projects: cached?.projects ?? [], expiresAt: 0, pending });
  return pending;
}

export function clearProjectDiscoveryCache(root?: string): void {
  if (root === undefined) discoveryCache.clear();
  else discoveryCache.delete(root);
}
