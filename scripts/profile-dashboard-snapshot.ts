import { performance } from 'node:perf_hooks';
import { Store } from '../src/store.js';
import { ProjectDashboardReader } from '../src/dashboard-reader.js';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('Usage: tsx scripts/profile-dashboard-snapshot.ts <data-dir>');

const store = new Store(dataDir, { readOnly: true });
try {
  const startedAt = performance.now();
  const projects = new ProjectDashboardReader(store).projects();
  console.log(JSON.stringify({
    projects: projects.length,
    cards: projects.reduce((total, project) => total + project.tasks.length, 0),
    elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
    responseBytes: JSON.stringify(projects).length,
  }));
} finally {
  store.close();
}
