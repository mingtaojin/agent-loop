import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { ExecutionConfigWatcher, configSchema, loadConfig } from '../src/config.js';

const execution = {
  coordinator: { backend: 'codex', model: 'coordinator-a', reasoningEffort: 'high' as const },
  worker: { backend: 'codex', model: 'worker-a', reasoningEffort: 'xhigh' as const },
};

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('Timed out waiting for execution config reload');
}

test('execution watcher applies valid changes and keeps the last valid config after an invalid edit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-execution-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config.json');
  const configFile = (profile: typeof execution = execution) => JSON.stringify({ execution: profile, feishu: { userOpenId: 'owner' } });
  await writeFile(path, configFile());
  const target = await loadConfig(path);
  const diagnostics: unknown[] = [];
  const watcher = new ExecutionConfigWatcher(path, target, error => diagnostics.push(error));
  watcher.start(); t.after(() => watcher.close());

  await writeFile(path, configFile({ ...execution, coordinator: { ...execution.coordinator, model: 'coordinator-b' } }));
  await waitFor(() => target.execution.coordinator.model === 'coordinator-b');
  await writeFile(path, '{ invalid json');
  await waitFor(() => diagnostics.length === 1);
  assert.equal(target.execution.coordinator.model, 'coordinator-b');

  const invalid = configSchema.safeParse({ execution: { ...execution, worker: { ...execution.worker, backend: 'dsh' } }, feishu: { userOpenId: 'owner' } });
  assert.equal(invalid.success, false);
});
