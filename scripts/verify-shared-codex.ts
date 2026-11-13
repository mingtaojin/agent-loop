import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { CodexAppServer as Adapter } from '../src/adapters/codex.js';
import type { CodexConnector } from '../src/adapters/codex-daemon.js';
import { repositorySchema, type ExecutionSnapshot } from '../src/domain.js';

const built: typeof import('../src/adapters/codex.js') = await import(new URL('../dist/src/adapters/codex.js', import.meta.url).href);
const transport: typeof import('../src/adapters/codex-daemon.js') = await import(new URL('../dist/src/adapters/codex-daemon.js', import.meta.url).href);
const root = await mkdtemp('/tmp/verify-shared-codex-');
const output = resolve(process.env.CODEX_VERIFY_OUTPUT ?? `.scratch/verification/shared-codex-${Date.now()}.json`);
const executable = process.env.CODEX_VERIFY_EXECUTABLE ?? 'codex';
const settings = transport.normalizeDaemonSettings({ executable, model: process.env.CODEX_VERIFY_MODEL, modelProvider: process.env.CODEX_VERIFY_PROVIDER });
const daemon = () => z.object({ status: z.literal('running'), socketPath: z.string() }).passthrough().parse(JSON.parse(execFileSync(executable, ['app-server', 'daemon', 'version'], { encoding: 'utf8' })));
const identity = async () => {
  const version = daemon();
  const socket = await stat(version.socketPath);
  const processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(line => /^\s*\d+\s+\S*codex app-server .*--managed-daemon\s*$/.test(line)).map(line => line.trim());
  return { version, socketInode: socket.ino, processes };
};
const messageSchema = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), result: z.record(z.string(), z.unknown()).optional() }).passthrough();
const records: { method: string; threadId?: string; turnId?: string; status?: unknown; params?: unknown }[] = [];
const connector = transport.sharedDaemonConnector(settings, 30_000);
let cancelOnTurnStart: AbortController | undefined;
const observed: CodexConnector = async handlers => {
  const calls = new Map<string | number, { method: string; params: Record<string, unknown> }>();
  const owned = new Set<string>();
  let ephemeralThread: string | undefined;
  const connection = await connector({
    ...handlers,
    message: data => {
      const message = messageSchema.parse(JSON.parse(data));
      const call = message.id === undefined ? undefined : calls.get(message.id);
      if (call && message.id !== undefined && !message.method && message.result !== undefined && !('error' in message)) {
        calls.delete(message.id);
        if (call.method === 'thread/start') {
          const response = z.object({ thread: z.object({ id: z.string() }) }).parse(message.result);
          owned.add(response.thread.id);
          if (call.params.ephemeral === true) ephemeralThread = response.thread.id;
          records.push({ method: 'thread/created', threadId: response.thread.id, params: call.params });
        }
        if (call.method === 'thread/read') records.push({ method: 'thread/observed', threadId: z.string().parse(call.params.threadId), status: z.object({ thread: z.object({ status: z.unknown() }) }).parse(message.result).thread.status });
      }
      handlers.message(data);
      if (!message.method && message.result !== undefined && !('error' in message) && call?.method === 'turn/start' && call.params.threadId === ephemeralThread && cancelOnTurnStart) {
        const controller = cancelOnTurnStart;
        cancelOnTurnStart = undefined;
        queueMicrotask(() => controller.abort());
      }
    },
  });
  return {
    ...connection,
    send: async data => {
      const message = messageSchema.parse(JSON.parse(data));
      if (message.id !== undefined && message.method) calls.set(message.id, { method: message.method, params: message.params ?? {} });
      if (message.method && owned.has(String(message.params?.threadId))) records.push({ method: message.method, threadId: String(message.params?.threadId), ...(typeof message.params?.turnId === 'string' ? { turnId: message.params.turnId } : {}) });
      await connection.send(data);
    },
  };
};
const options = { ...settings, approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 30_000 } satisfies ConstructorParameters<typeof built.CodexAppServer>[0];
const formal = new built.CodexAppServer(options, observed);
const unrelated = new built.CodexAppServer(options);
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(), root,
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  adapterSha256: createHash('sha256').update(await readFile(new URL('../dist/src/adapters/codex.js', import.meta.url))).digest('hex'),
  limits: ['Temporary local read-only fixtures only. No production Agent Loop, Feishu, daemon stop, restart or update.', 'Fault injection is covered by the controlled daemon fixture. This run does not restart the real daemon.'],
};
const terminal = async (client: Adapter, threadId: string) => {
  const deadline = Date.now() + 180_000;
  do {
    const snapshot = await client.inspect(threadId);
    if (snapshot.status !== 'running') { assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot)); return snapshot; }
    if (Date.now() >= deadline) throw new Error('Real daemon Turn exceeded the verification deadline');
    await delay(100);
  } while (true);
};
const final = (snapshot: ExecutionSnapshot) => snapshot.outputs.filter(item => item.turnId === snapshot.turnId && item.phase === 'final').map(item => item.text).join('\n');
try {
  const prepared = await transport.sharedDaemonConnector(settings, 30_000)({ message: () => {}, error: () => {} });
  await prepared.close();
  evidence.before = await identity();
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'README.md'), 'This project is the fixture for QUARTZ_ENGINE_482.\n');
  const token = `CONTEXT_${randomUUID()}`;
  let toolCalls = 0;
  formal.setWorkspaceHandler(async request => {
    assert.ok('repository' in request && request.repository === 'fixture/project'); toolCalls++;
    return { kind: 'project-directory', id: 'fixture/project', repository: { ...repositorySchema.parse({ name: 'fixture/project', path: project, baseBranch: 'main' }), workspace: { kind: 'project-directory', path: project } }, workspace: project };
  });
  const instructions = `Harmless read-only verification in ${root}. Do not modify files, access network, read credentials, inspect other projects, or delegate. Use only the explicitly requested ensure_workspace dynamic tool. Delivery markers are metadata.`;
  const threadId = await formal.createThread({ cwd: root, instructions });
  const unrelatedId = await unrelated.createThread({ cwd: root, instructions });
  await unrelated.startTurn({ threadId: unrelatedId, deliveryId: 'unrelated-before', input: [{ kind: 'text', text: 'Reply only CLIENT_ALIVE. No tools.' }] });
  assert.match(final(await terminal(unrelated, unrelatedId)), /CLIENT_ALIVE/);
  await formal.startTurn({ threadId, deliveryId: 'formal-before', input: [{ kind: 'text', text: `Remember ${token}. Call ensure_workspace exactly once with repository="fixture/project". Do not inspect files or call any other tool. Then reply with the remembered token and the returned path.` }] });
  const first = await terminal(formal, threadId);
  assert.match(final(first), new RegExp(token)); assert.equal(toolCalls, 1);
  evidence.formal = { threadId, snapshot: first, dynamicToolCalls: toolCalls };
  const choice = await formal.selectWorkspace({ taskId: 'choice', cwd: root, candidates: [{ name: 'fixture/project', path: project }], input: [{ kind: 'text', text: 'Work in fixture/project. Choose that exact configured repository. Do not execute the work.' }], answers: [] });
  assert.deepEqual(choice.choice.kind, 'repository');
  evidence.choice = choice;
  const controller = new AbortController(); cancelOnTurnStart = controller;
  await assert.rejects(formal.selectWorkspace({ taskId: 'cancel', cwd: root, candidates: [{ name: 'fixture/project', path: project }], input: [{ kind: 'text', text: 'Before choosing, carefully compare all the evidence for this engineering request. It refers to QUARTZ_ENGINE_482.' }], answers: [], signal: controller.signal }), /abort/i);
  const cancelled = records.filter(row => row.method === 'thread/created' && z.object({ ephemeral: z.boolean() }).parse(row.params).ephemeral).at(-1)?.threadId;
  assert.ok(cancelled);
  assert.ok(records.some(row => row.method === 'turn/interrupt' && row.threadId === cancelled && row.turnId));
  assert.ok(records.some(row => row.method === 'thread/observed' && row.threadId === cancelled && z.object({ type: z.string() }).parse(row.status).type === 'idle'));
  assert.ok(records.some(row => row.method === 'thread/unsubscribe' && row.threadId === cancelled));
  evidence.cancellation = { threadId: cancelled, records: records.filter(row => row.threadId === cancelled) };
  await formal.startTurn({ threadId, deliveryId: 'formal-after', input: [{ kind: 'text', text: 'Reply only with the token you were asked to remember. No tools.' }] });
  const continued = await terminal(formal, threadId); assert.match(final(continued), new RegExp(token));
  assert.ok(continued.seenInputIds.includes('formal-before')); assert.ok(continued.seenInputIds.includes('formal-after'));
  evidence.continuation = continued;
  await formal.close();
  await unrelated.startTurn({ threadId: unrelatedId, deliveryId: 'unrelated-after', input: [{ kind: 'text', text: 'Reply only STILL_ALIVE. No tools.' }] });
  const unrelatedSnapshot = await terminal(unrelated, unrelatedId); evidence.unrelated = unrelatedSnapshot; assert.match(final(unrelatedSnapshot), /STILL_ALIVE/);
  evidence.after = await identity(); assert.deepEqual(evidence.after, evidence.before);
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
} finally {
  const results = await Promise.allSettled([formal.close(), unrelated.close()]);
  evidence.cleanup = results.map(result => result.status === 'fulfilled' ? 'closed' : String(result.reason));
  if (results.some(result => result.status === 'rejected')) { evidence.result = 'failed'; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString();
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ result: evidence.result, output, error: evidence.error }) + '\n');
}
