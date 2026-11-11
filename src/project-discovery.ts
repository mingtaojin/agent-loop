import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DiscoveredProject } from './domain.js';

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
