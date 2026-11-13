import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { z } from 'zod';
import { observedCodexConnection } from './codex-connection.js';
import { CodexAppServer } from '../src/adapters/codex.js';
import { TurnChangedError } from '../src/domain.js';

const workspace = await mkdtemp('/tmp/agent-loop-inputs-');
const output = resolve('.scratch/verification', `inputs-${Date.now()}.json`);
const daemonBefore = execFileSync('codex', ['app-server', 'daemon', 'version'], { encoding: 'utf8' });
const protocolFile = `${workspace}/protocol.jsonl`;
const logPath = `${workspace}/fixture.log`;
const imagePath = `${workspace}/fixture.png`;
const nonce = randomUUID();
const marker = randomUUID();
const protocolEventSchema = z.object({ method: z.string().optional(), params: z.unknown().optional() });
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(), workspace,
  version: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
  expected: { nonce, marker, color: 'red' },
  limitations: ['Synthetic PNG and UTF-8 log only; no Feishu download, real screenshot interpretation, GitHub, repository, or remote operation tested.'],
};
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const footer = Buffer.alloc(4);
  footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, footer]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(64, 0);
header.writeUInt32BE(64, 4);
header[8] = 8;
header[9] = 2;
const pixels = Buffer.alloc(64 * (1 + 64 * 3));
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255;
await writeFile(imagePath, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
await writeFile(logPath, `测试日志，仅读取本文件。\nnonce=${nonce}\n`, { mode: 0o600 });
const server = new CodexAppServer({
  approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 20_000,
}, observedCodexConnection({ recordPath: protocolFile }).connector);
try {
  const threadId = await server.createThread({ cwd: workspace, instructions: `This is a harmless input protocol test. Never access repositories, network, remote hosts, credentials, or other files. You may use a shell read command ONLY to read ${logPath}. Inspect the attached image directly; do not use tools for the image. Do not use other tools or commands. Delivery markers are transport metadata. Follow the newest user instruction. Return a plain final answer.` });
  evidence.threadId = threadId;
  const turnId = await server.startTurn({ threadId, deliveryId: 'inputs-start', input: [{ kind: 'text', text: 'No tools yet. Mentally derive the first 1000 primes. A follow-up will replace this task shortly. If no follow-up arrives, ask for the test fixtures in a plain answer.' }] });
  evidence.turnId = turnId;
  const before = await server.inspect(threadId);
  evidence.beforeSteer = before;
  assert.equal(before.status, 'running');
  try {
    await server.steer({ threadId, turnId, deliveryId: 'inputs-steer', input: [
      { kind: 'text', text: `Cancel the primes task immediately. Read ONLY the UTF-8 log ${logPath} with a shell read command. Inspect the attached image. Return a plain final answer with exactly these three lines: "nonce=<the nonce read from the log>", "color=<the image's dominant color in lowercase English>", and "marker=${marker}". Then state any actual limitations. Do not guess the nonce or color.` },
      { kind: 'image', path: imagePath },
    ] });
    evidence.steer = { accepted: true, turnId };
  } catch (error) {
    evidence.steer = { accepted: false, endTurnRace: error instanceof TurnChangedError, error: String(error) };
    throw error;
  }
  const deadline = Date.now() + 180_000;
  let after = await server.inspect(threadId);
  while (after.status === 'running') {
    assert.equal(after.requests.length, 0, 'Unexpected request during sandboxed fixture verification');
    if (Date.now() > deadline) throw new Error('Input verification exceeded 180 seconds');
    await delay(250);
    after = await server.inspect(threadId);
  }
  evidence.afterSteer = after;
  assert.equal(after.status, 'completed');
  assert.equal(after.threadId, threadId);
  assert.equal(after.turnId, turnId);
  const finalText = after.outputs.filter(item => item.turnId === turnId && item.phase === 'final').map(item => item.text).join('\n');
  for (const expected of [`nonce=${nonce}`, 'color=red', `marker=${marker}`]) assert.ok(finalText.includes(expected), `Missing ${expected}`);
  assert.ok(after.seenInputIds.includes('inputs-start'));
  assert.ok(after.seenInputIds.includes('inputs-steer'));
  try {
    await server.steer({ threadId, turnId, deliveryId: 'inputs-too-late', input: [{ kind: 'text', text: 'Late input should be rejected because the turn completed.' }] });
    throw new Error('Completed turn unexpectedly accepted steer');
  } catch (error) {
    evidence.completedTurnSteer = { error: String(error), recognizedAsTurnChanged: error instanceof TurnChangedError };
    assert.ok(error instanceof TurnChangedError);
  }
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed';
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  try { await server.close(); evidence.cleanup = 'closed'; }
  catch (error) { evidence.cleanup = String(error); process.exitCode = 1; }
  evidence.daemonPreserved = execFileSync('codex', ['app-server', 'daemon', 'version'], { encoding: 'utf8' }) === daemonBefore;
  assert.equal(evidence.daemonPreserved, true);
  try {
    const protocol = (await readFile(protocolFile, 'utf8')).trim().split('\n').map(line => protocolEventSchema.parse(JSON.parse(line)));
    evidence.completedItems = protocol.filter(event => event.method === 'item/completed').map(event => event.params);
  } catch (error) { evidence.protocolAuditError = String(error); process.exitCode = 1; }
  if (process.exitCode) evidence.result = 'failed';
  evidence.finishedAt = new Date().toISOString();
  await mkdir(resolve('.scratch/verification'), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await rm(workspace, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ result: evidence.result, output, error: evidence.error })}\n`);
}
