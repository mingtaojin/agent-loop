import { tickWithCoordinator } from '../test/coordinated-runtime.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { z } from 'zod';
import { CodexAppServer } from '../src/adapters/codex.js';
import { configSchema } from '../src/config.js';
import type { IncomingMessage } from '../src/domain.js';
import { AgentLoop } from '../src/loop.js';
import { WorkspaceProvider } from '../src/workspace.js';
import { FeishuFake, GitHubFake } from '../test/fakes.js';

const root = await realpath(await mkdtemp('/tmp/agent-loop-image-paths-'));
const outputDirectory = resolve('.scratch/image-path-inputs');
const protocolPath = join(root, 'protocol.jsonl');
const project = join(root, 'selected-project');
await mkdir(project);
const config = configSchema.parse({ dataDir: join(root, 'data'), feishu: { userOpenId: 'fixture-owner' },
  repositories: [{ name: 'fixture/images', path: project, baseBranch: 'main', workspace: { kind: 'project-directory', path: project } }],
  codex: { command: [process.execPath, resolve('scripts/fixtures/record-app-server.mjs'), protocolPath, 'codex', 'app-server'],
    sandbox: 'read-only', approvalPolicy: 'never', requestTimeoutMs: 60_000 },
});
const server = new CodexAppServer(config.codex);
const feishu = new FeishuFake();
const loop = new AgentLoop(config, { codex: server, feishu, github: new GitHubFake(), workspace: new WorkspaceProvider(config.dataDir) });
const evidence: Record<string, unknown> = {
  root, protocolPath, startedAt: new Date().toISOString(),
  scope: 'Real Codex App Server through AgentLoop, SQLite and WorkspaceProvider. Synthetic PNGs. Feishu and GitHub are local fakes.',
  limitations: ['No real Feishu transport tested.', 'Request assembly is inspected; upstream model request bytes, token use and timeouts are not measured.'],
};
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4), footer = Buffer.alloc(4);
  header.writeUInt32BE(data.length); footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, footer]);
}
function png(channel: number, padding: number): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * 193);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3 + channel] = 255;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    pngChunk('tEXt', Buffer.from('fixture\0' + 'x'.repeat(padding))), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}
const originals = [png(0, 0), png(2, 1024 * 1024)];
feishu.resources.set('red-small', originals[0] ?? Buffer.alloc(0));
feishu.resources.set('blue-large', originals[1] ?? Buffer.alloc(0));
const message = (id: string, text: string, imageKeys: string[], chatId = 'private'): IncomingMessage => ({
  id, text, chatId, chatType: chatId === 'private' ? 'p2p' : 'group', senderId: 'fixture-owner', createdAt: Date.now(),
  attachments: imageKeys.map(key => ({ key, name: key + '.png', kind: 'image' })),
});
async function settled(taskId: string) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await loop.tick();
    const task = loop.store.task(taskId);
    assert.deepEqual(task.requests, [], 'Read-only fixture must not require permission or user approval');
    if (task.status === 'idle') return task;
    if (task.status === 'failed' || task.status === 'paused') throw new Error(task.reason ?? task.status);
    await delay(500);
  }
  throw new Error('Real Codex fixture did not settle within 240 seconds');
}
const recordSchema = z.object({ direction: z.enum(['request', 'event']), method: z.string().optional(), params: z.unknown().optional() });
const inputSchema = z.object({ threadId: z.string(), input: z.array(z.object({ type: z.literal('text'), text: z.string() })) });
const refSchema = z.object({ messageId: z.string(), name: z.string(), path: z.string() });
try {
  await loop.receive(message('image-start',
    'Use fixture/images as the engineering directory. This is an isolated read-only image-input test. '
    + 'Use your image viewing tool to inspect both saved PNG files referenced in this message. '
    + 'Do not guess colors from filenames. In the final answer return FIRST_COLOR and SECOND_COLOR with the observed colors. '
    + 'Do not change files, delegate, contact external services, or read unrelated paths.', ['red-small', 'blue-large']));
  await tickWithCoordinator(loop);
  const initial = loop.tasks().find(task => !task.sourceId.startsWith('project:')); assert.ok(initial);
  const first = await settled(initial.id);
  assert.ok(first.threadId && first.chatId);
  assert.equal(first.resources[0]?.workspace, project);
  const snapshot = await server.inspect(first.threadId);
  const firstAnswer = snapshot.outputs.filter(item => item.phase === 'final').map(item => item.text).join('\n');
  assert.match(firstAnswer, /FIRST_COLOR\s*[:=]\s*red/i);
  assert.match(firstAnswer, /SECOND_COLOR\s*[:=]\s*blue/i);
  await loop.receive(message('text-followup', 'Reply exactly IMAGE_PATH_TEXT_ONLY_OK. Do not use tools or inspect images again.', [], first.chatId));
  await settled(first.id);
  await loop.receive(message('image-followup', 'Inspect this new local image with the image viewing tool. Reply FOLLOWUP_COLOR=<observed color>. Do not change files or read unrelated paths.', ['red-small'], first.chatId));
  await settled(first.id);
  const rows = (await readFile(protocolPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => recordSchema.parse(JSON.parse(line)));
  const allTurns = rows.filter(row => row.direction === 'request' && ['turn/start', 'turn/steer'].includes(row.method ?? '')).map(row => inputSchema.parse(row.params));
  const turns = allTurns.filter(turn => turn.threadId === first.threadId || turn.input.some(item => item.text.startsWith('Image attachment as data: ')));
  assert.equal(turns.length, 4, 'Selector, initial formal input, text follow-up and image follow-up');
  const references = turns.map(turn => turn.input.flatMap(item => item.text.startsWith('Image attachment as data: ')
    ? [refSchema.parse(JSON.parse(item.text.slice('Image attachment as data: '.length).split('\n')[0] ?? ''))] : []));
  assert.deepEqual(references.map(refs => refs.length), [2, 2, 0, 1]);
  assert.deepEqual(references[0], references[1]);
  const formalRefs = references[1]; assert.ok(formalRefs);
  for (const [index, ref] of formalRefs.entries()) assert.deepEqual(await readFile(ref.path), originals[index]);
  const imageViews = rows.filter(row => row.direction === 'event' && row.method === 'item/completed').flatMap(row => {
    const parsed = z.object({ item: z.object({ type: z.string() }).passthrough() }).safeParse(row.params);
    return parsed.success && /image/i.test(parsed.data.item.type) ? [parsed.data.item] : [];
  });
  assert.ok(imageViews.length >= 3, 'Real model must invoke its image viewing tool for the two original images and the new follow-up');
  const inputJson = JSON.stringify(allTurns);
  assert.doesNotMatch(inputJson, /localImage|data:image|base64/);
  evidence.result = 'passed';
  evidence.threadId = first.threadId;
  evidence.firstAnswer = firstAnswer;
  evidence.finalSnapshot = await server.inspect(first.threadId);
  evidence.inputs = turns;
  evidence.imageViews = imageViews;
  evidence.files = formalRefs.map((ref, index) => ({ ...ref, bytes: originals[index]?.length,
    sha256: createHash('sha256').update(originals[index] ?? Buffer.alloc(0)).digest('hex') }));
  evidence.inputBytes = turns.map(turn => Buffer.byteLength(JSON.stringify(turn.input)));
} catch (error) {
  evidence.result = 'failed'; evidence.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
} finally {
  await loop.close();
  evidence.finishedAt = new Date().toISOString();
  await mkdir(outputDirectory, { recursive: true });
  const output = join(outputDirectory, 'live-result.json');
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ result: evidence.result, output, error: evidence.error }) + '\n');
}
