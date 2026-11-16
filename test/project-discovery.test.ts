import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearProjectDiscoveryCache, discoverProjectsCached } from '../src/project-discovery.js';

test('cached project discovery shares concurrent work and expires through explicit invalidation', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-discovery-')));
  t.after(async () => { clearProjectDiscoveryCache(root); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'alpha'));
  const [first, concurrent] = await Promise.all([discoverProjectsCached(root), discoverProjectsCached(root)]);
  assert.strictEqual(concurrent, first);
  assert.deepEqual(first.map(project => project.name), ['alpha']);
  await mkdir(join(root, 'beta'));
  assert.deepEqual((await discoverProjectsCached(root)).map(project => project.name), ['alpha']);
  clearProjectDiscoveryCache(root);
  assert.deepEqual((await discoverProjectsCached(root)).map(project => project.name), ['alpha', 'beta']);
});
