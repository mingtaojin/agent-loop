import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { workspaceSelectionOutputSchema } from '../src/workspace-selection.js';

for (const mode of ['original', 'current']) test(`schema probe ${mode} logs the schema actually received by its child`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-schema-wire-'));
  const record = join(root, 'protocol.jsonl');
  const proxy = spawn(process.execPath, [resolve('scripts/fixtures/workspace-selection-schema-proxy.mjs'), record, mode,
    process.execPath, '-e', 'process.stdin.pipe(process.stdout)']);
  t.after(async () => { proxy.kill(); await rm(root, { recursive: true, force: true }); });
  const received: Buffer[] = [], errors: Buffer[] = [];
  proxy.stdout.on('data', chunk => received.push(chunk));
  proxy.stderr.on('data', chunk => errors.push(chunk));
  const closed = once(proxy, 'close');
  const request = { id: 1, method: 'turn/start', params: { threadId: 'fixture', outputSchema: z.toJSONSchema(workspaceSelectionOutputSchema),
    sandboxPolicy: { type: 'readOnly', networkAccess: false } } };
  proxy.stdin.end(JSON.stringify(request) + '\n');
  const [code] = await closed;
  assert.equal(code, 0, Buffer.concat(errors).toString());
  const wire = z.object({ method: z.literal('turn/start'), params: z.object({ outputSchema: z.unknown() }) })
    .parse(JSON.parse(Buffer.concat(received).toString()));
  const schema = z.object({ properties: z.object({ choice: z.record(z.string(), z.unknown()) }) }).parse(wire.params.outputSchema);
  const expected = mode === 'original' ? 'oneOf' : 'anyOf', forbidden = mode === 'original' ? 'anyOf' : 'oneOf';
  assert.equal(z.array(z.unknown()).parse(schema.properties.choice[expected]).length, 4);
  assert.equal(forbidden in schema.properties.choice, false);
  const rows = (await readFile(record, 'utf8')).trim().split('\n').map(line => z.object({ outputSchema: z.unknown() }).parse(JSON.parse(line)));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.outputSchema, wire.params.outputSchema, 'The log must describe what the actual receiving child echoed');
});
