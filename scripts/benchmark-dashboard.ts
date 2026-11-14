import { performance } from 'node:perf_hooks';
import { startDashboard } from '../src/dashboard.js';

type Sample = { elapsedMs: number; bytes: number; status: number };

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
}

async function sample(url: string): Promise<Sample> {
  const started = performance.now();
  const response = await fetch(url);
  const body = await response.text();
  return { elapsedMs: Number((performance.now() - started).toFixed(3)), bytes: Buffer.byteLength(body), status: response.status };
}

function summary(samples: Sample[]) {
  const elapsed = samples.map(sample => sample.elapsedMs);
  return {
    count: samples.length,
    p50Ms: Number(percentile(elapsed, 0.5).toFixed(3)),
    p95Ms: Number(percentile(elapsed, 0.95).toFixed(3)),
    p99Ms: Number(percentile(elapsed, 0.99).toFixed(3)),
    worstMs: Number(Math.max(...elapsed).toFixed(3)),
    minBytes: Math.min(...samples.map(sample => sample.bytes)),
    maxBytes: Math.max(...samples.map(sample => sample.bytes)),
    non2xx: samples.filter(sample => sample.status < 200 || sample.status >= 300).length,
  };
}

async function idleCpuWindows(): Promise<{ windows: number[]; p50: number; p95: number }> {
  const windows: number[] = [];
  for (let index = 0; index < 3; index++) {
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const cpu = process.cpuUsage(cpuStart);
    const elapsed = performance.now() - wallStart;
    windows.push(Number((((cpu.user + cpu.system) / 1_000) / elapsed * 100).toFixed(3)));
  }
  return { windows, p50: percentile(windows, 0.5), p95: percentile(windows, 0.95) };
}

const dataDir = process.argv[2];
if (!dataDir) throw new Error('Usage: tsx scripts/benchmark-dashboard.ts <data-dir> [sample-count]');
const sampleCount = Math.max(7, Number(process.argv[3] ?? 25));
const dashboard = await startDashboard({ dataDir, port: 0, host: '127.0.0.1' });
try {
  const coldSnapshot: Sample[] = [];
  const coldProjects: Sample[] = [];
  for (let index = 0; index < 7; index++) {
    const fresh = await startDashboard({ dataDir, port: 0, host: '127.0.0.1' });
    try {
      coldSnapshot.push(await sample(fresh.url + '/api/snapshot'));
      coldProjects.push(await sample(fresh.url + '/api/projects'));
    } finally { await fresh.close(); }
  }
  for (let index = 0; index < 20; index++) await sample(dashboard.url + '/api/snapshot');
  const idle = await idleCpuWindows();
  const hotSnapshot: Sample[] = [];
  const hotProjects: Sample[] = [];
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  for (let index = 0; index < sampleCount; index++) {
    hotSnapshot.push(await sample(dashboard.url + '/api/snapshot'));
    hotProjects.push(await sample(dashboard.url + '/api/projects'));
  }
  const cpu = process.cpuUsage(cpuStart);
  const wallMs = performance.now() - wallStart;
  const cpuPercent = ((cpu.user + cpu.system) / 1_000) / wallMs * 100;
  console.log(JSON.stringify({
    dataDir, taskCount: (await (await fetch(dashboard.url + '/api/snapshot')).json()).tasks.length,
    thresholdMs: 500,
    cold: { snapshot: summary(coldSnapshot), projects: summary(coldProjects) },
    hot: { snapshot: summary(hotSnapshot), projects: summary(hotProjects) },
    idleCpu: { ...idle, note: 'isolated read-only dashboard process with no requests; runtime worker CPU is a separate acceptance gate' },
    hotWindow: { wallMs: Number(wallMs.toFixed(3)), cpuPercent: Number(cpuPercent.toFixed(3)), note: 'client process includes request generation; use only as a bounded local signal' },
    pass: [...coldSnapshot, ...coldProjects, ...hotSnapshot, ...hotProjects].every(sample => sample.status >= 200 && sample.status < 300)
      && Math.max(summary(coldSnapshot).p95Ms, summary(coldProjects).p95Ms, summary(hotSnapshot).p95Ms, summary(hotProjects).p95Ms) <= 500,
  }));
} finally {
  await dashboard.close();
}
