import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import { Store } from '../src/store.js';
import { submissionReceiptSchema, type Submission, type SubmissionReceipt } from '../src/domain.js';
import { startDashboard } from '../src/dashboard.js';
import { documentConversationText, projectDocumentConversation } from '../src/feishu-document-conversation.js';
import { CodexFake, FeishuFake, GitHubFake } from './fakes.js';

const loader = resolve('node_modules/tsx/dist/loader.mjs');
const built = import.meta.url.endsWith('.js');
const entry = resolve(built ? 'dist/src/cli.js' : 'src/cli.ts');
const endpointSchema = z.object({ version: z.literal(1), socketPath: z.string(), token: z.string() });
const failureSchema = z.object({ requestId: z.string().nullable(), error: z.object({ code: z.string(), message: z.string() }) });
function gate() {
  let release = () => {};
  const promise = new Promise<void>(done => { release = done; });
  return { promise, release };
}
async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Timed out waiting for submission state'); await delay(10); }
}
class ControlledLoop extends AgentLoop {
  afterSubmit: (() => Promise<void>) | null = null;
  override async submit(input: Submission): Promise<SubmissionReceipt> {
    const receipt = await super.submit(input);
    await this.afterSubmit?.();
    return receipt;
  }
}
async function fixture(t: TestContext, settings: { maxPromptBytes?: number; requestTimeoutMs?: number; maxConcurrentRequests?: number } = {},
  storeFactory?: (dataDir: string) => Store) {
  const root = await mkdtemp(join(tmpdir(), "agent-submit ' $()-"));
  const configPath = join(root, 'runtime config.json');
  const dataDir = join(root, 'data');
  const promptPath = join(root, 'guidance.md');
  await writeFile(promptPath, 'Generic engineering guidance, independent of the submitted task.');
  const config = configSchema.parse({ dataDir, engineering: { promptPath }, submission: settings,
    feishu: { userOpenId: 'owner', appIdEnv: 'ABSENT_SUBMIT_APP', appSecretEnv: 'ABSENT_SUBMIT_SECRET' },
    github: { tokenEnv: 'ABSENT_SUBMIT_GITHUB' }, pollIntervalMs: 60_000, executionPollMs: 60_000 });
  await writeFile(configPath, JSON.stringify(config));
  await mkdir(join(root, 'other-project'));
  const codex = new CodexFake(), feishu = new FeishuFake(), github = new GitHubFake();
  const ports = { codex, feishu, github, workspace: {
    async ensure() { throw new Error('Unexpected workspace acquisition'); }, async head() { return 'unused'; },
  } };
  let loop = new ControlledLoop(config, ports, storeFactory?.(dataDir), { configPath });
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  const cli = async (command: string, args: string[], bytes: Uint8Array = Buffer.alloc(0)) => {
    const env = { ...process.env };
    delete env.ABSENT_SUBMIT_APP; delete env.ABSENT_SUBMIT_SECRET; delete env.ABSENT_SUBMIT_GITHUB;
    const child = spawn(process.execPath, [...(built ? [] : ['--import', loader]), '--', entry,
      command, '--config', configPath, '--env-file', join(root, 'must-not-read.env'), ...args],
    { cwd: join(root, 'other-project'), env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    child.stdin.on('error', () => undefined);
    child.stdin.end(bytes);
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
    });
  };
  const submit = async (requestId: string, prompt: Uint8Array | string, path = '-') => {
    const bytes = typeof prompt === 'string' ? Buffer.from(prompt) : prompt;
    if (path !== '-') await writeFile(path, bytes);
    return cli('submit', ['--request-id', requestId, '--prompt-file', path], path === '-' ? bytes : undefined);
  };
  const status = (requestId: string) => cli('status', ['--request-id', requestId]);
  const endpoint = async () => endpointSchema.parse(JSON.parse(await readFile(join(dataDir, 'submission-endpoint.json'), 'utf8')));
  return { root, dataDir, configPath, config, ports, codex, feishu, github, cli, submit, status, endpoint,
    get loop() { return loop; },
    async restart() { await loop.close(); loop = new ControlledLoop(config, ports, undefined, { configPath }); await loop.start(); },
  };
}
function accepted(result: { code: number | null; stdout: string; stderr: string }): SubmissionReceipt {
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
  return submissionReceiptSchema.parse(JSON.parse(result.stdout));
}
function rejected(result: { code: number | null; stdout: string; stderr: string }, code: string, requestId: string | null) {
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  const failure = failureSchema.parse(JSON.parse(result.stderr));
  assert.equal(failure.error.code, code, failure.error.message); assert.equal(failure.requestId, requestId);
  return failure;
}
async function rpc(endpoint: z.infer<typeof endpointSchema>, bytes: Uint8Array, authorization = `Bearer ${endpoint.token}`) {
  return new Promise<{ status: number | undefined; body: unknown }>((done, reject) => {
    const call = request({ socketPath: endpoint.socketPath, path: '/submit', method: 'POST', agent: false,
      headers: { authorization } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => done({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      response.once('error', reject);
    });
    call.once('error', reject); call.end(bytes);
  });
}

test('actual CLI file and stdin create independent tasks and preserve exact submitted text through selection and first turn', async t => {
  const f = await fixture(t);
  await f.loop.receive({ id: 'origin', chatId: 'private', senderId: 'owner', chatType: 'p2p', text: 'Original discussion', attachments: [], createdAt: Date.now() });
  const original = f.loop.tasks()[0]; assert.ok(original);
  await f.loop.start();
  const saved = structuredClone(f.loop.store.task(original.id));
  const prompt = '\uFEFF  /new do not strip this\r\n规格与限制 🎯 e\u0301\r\n  final spaces  \r\n';
  const groups: Parameters<FeishuFake['ensureGroup']>[0][] = [];
  const ensureGroup = f.feishu.ensureGroup.bind(f.feishu);
  f.feishu.ensureGroup = async input => { groups.push(input); return ensureGroup(input); };
  const firstId = randomUUID(), secondId = randomUUID();
  const first = accepted(await f.submit(firstId, prompt, join(f.root, "prompt ' $.txt")));
  const second = accepted(await f.submit(secondId, prompt));
  assert.equal(first.status, 'pending'); assert.equal(first.chatId, null); assert.equal(first.threadId, null);
  assert.notEqual(first.taskId, second.taskId);
  assert.equal(f.loop.tasks().length, 3);
  assert.throws(() => new Store(f.dataDir), /已有 Agent Loop/);
  for (const receipt of [first, second]) {
    const task = f.loop.store.task(receipt.taskId);
    assert.equal(task.prompt, 'Generic engineering guidance, independent of the submitted task.');
    assert.notEqual(task.prompt, prompt); assert.equal(task.source.kind, 'cli');
    assert.ok(task.source.kind === 'cli'); assert.equal(task.source.prompt, prompt);
    const inputs = f.loop.store.inputs(task.id); assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.message.text, prompt); assert.equal(inputs[0]?.message.senderId, 'external:cli');
    assert.deepEqual(inputs[0]?.provenance, { kind: 'cli', requestId: receipt.requestId });
  }
  await f.loop.tick();
  const tasks = f.loop.tasks();
  assert.equal(new Set(tasks.map(task => task.chatId)).size, 3);
  assert.equal(new Set(tasks.map(task => task.threadId)).size, 3);
  assert.equal(f.codex.created.length, 3);
  for (const receipt of [first, second]) {
    const task = f.loop.store.task(receipt.taskId); assert.ok(task.threadId && task.chatId);
    assert.deepEqual(f.codex.starts.find(start => start.threadId === task.threadId)?.input[0], { kind: 'text', text: prompt });
    assert.ok(f.codex.selections.some(selection => selection.taskId === task.id && selection.input.some(input => input.kind === 'text' && input.text === prompt)));
    assert.equal(accepted(await f.status(receipt.requestId)).threadId, task.threadId);
  }
  assert.equal(groups[0]?.title, '/new do not strip this\r\n规格与限制 🎯 e\u0301\r\n  final spaces');
  assert.deepEqual({ ...f.loop.store.task(original.id), updatedAt: saved.updatedAt }, saved);
  f.codex.complete(f.loop.store.task(first.taskId).threadId!, 'Reply in the new group');
  await f.loop.tick();
  assert.ok(f.feishu.sent.some(message => message.chatId === f.loop.store.task(first.taskId).chatId && message.text === 'Reply in the new group'));
  assert.ok(!f.feishu.sent.some(message => message.chatId === original.chatId && message.text === 'Reply in the new group'));
});

test('concurrent CLI retries, exact-content conflicts, persisted status and restart keep one task and input per request', async t => {
  const f = await fixture(t); await f.loop.start();
  const requestId = randomUUID();
  const receipts = await Promise.all(Array.from({ length: 5 }, () => f.submit(requestId, 'Same text\r\n').then(accepted)));
  assert.equal(new Set(receipts.map(receipt => receipt.taskId)).size, 1);
  const first = receipts[0]; assert.ok(first);
  assert.equal(f.loop.tasks().length, 1); assert.equal(f.loop.store.inputs(first.taskId).length, 1);
  for (const changed of ['Same text\n', '\uFEFFSame text\r\n', 'Same text\r\n ']) rejected(await f.submit(requestId, changed), 'conflict', requestId);
  await f.loop.tick();
  const snapshot = f.loop.store.task(first.taskId);
  const inputSnapshot = f.loop.store.inputs(first.taskId);
  accepted(await f.submit(requestId, 'Same text\r\n'));
  assert.deepEqual(f.loop.store.task(first.taskId), snapshot);
  assert.deepEqual(f.loop.store.inputs(first.taskId), inputSnapshot);
  assert.equal(f.codex.starts.length, 1);
  await f.loop.close();
  assert.equal(accepted(await f.status(requestId)).taskId, first.taskId);
  await f.restart();
  assert.equal(accepted(await f.submit(requestId, 'Same text\r\n')).taskId, first.taskId);
  assert.equal(f.codex.starts.length, 1); assert.equal(f.codex.created.length, 1); assert.equal(f.feishu.groups.size, 1);
  const extra = accepted(await f.submit(randomUUID(), 'Same text\r\n'));
  assert.notEqual(extra.taskId, first.taskId);
});

test('a repeated submit preserves a failed task and never resets recovery or starts another execution', async t => {
  const f = await fixture(t); await f.loop.start();
  const requestId = randomUUID(), first = accepted(await f.submit(requestId, 'A task'));
  f.codex.loseCreateAck = true; await f.loop.tick();
  const failed = f.loop.store.task(first.taskId); assert.equal(failed.status, 'failed');
  const retry = accepted(await f.submit(requestId, 'A task'));
  assert.equal(retry.status, 'failed'); assert.deepEqual(f.loop.store.task(first.taskId), failed);
  await f.restart();
  accepted(await f.submit(requestId, 'A task')); await f.loop.tick();
  assert.equal(f.codex.created.length, 1); assert.equal(f.codex.starts.length, 0); assert.equal(f.feishu.groups.size, 1);
});

test('concurrent different prompts with one identity accept one immutable request and reject the other', async t => {
  const f = await fixture(t); await f.loop.start();
  const requestId = randomUUID();
  const results = await Promise.all(['First prompt', 'Different prompt'].map(prompt => f.submit(requestId, prompt)));
  assert.deepEqual(results.map(result => result.code).sort(), [0, 1]);
  const failure = results.find(result => result.code === 1); assert.ok(failure); rejected(failure, 'conflict', requestId);
  const task = f.loop.tasks()[0]; assert.ok(task && task.source.kind === 'cli');
  assert.equal(f.loop.tasks().length, 1); assert.equal(f.loop.store.inputs(task.id).length, 1);
  assert.equal(task.source.prompt, results[0]?.code === 0 ? 'First prompt' : 'Different prompt');
});

test('a SQLite acceptance failure rolls back Task and inbox together and the same request can retry', async t => {
  let fail = true;
  class FaultStore extends Store {
    override receive(...args: Parameters<Store['receive']>): boolean {
      const result = super.receive(...args);
      if (fail && args[3]?.kind === 'cli') throw new Error('Controlled database failure after inbox insert');
      return result;
    }
  }
  const f = await fixture(t, {}, dataDir => new FaultStore(dataDir)); await f.loop.start();
  const requestId = randomUUID();
  rejected(await f.submit(requestId, 'Atomic acceptance'), 'unknown_outcome', requestId);
  assert.equal(f.loop.tasks().length, 0);
  const missing = await f.status(requestId); assert.equal(missing.code, 0); assert.equal(JSON.parse(missing.stdout).status, 'not_found');
  fail = false;
  const receipt = accepted(await f.submit(requestId, 'Atomic acceptance'));
  assert.equal(f.loop.tasks().length, 1); assert.equal(f.loop.store.inputs(receipt.taskId).length, 1);
  await f.loop.tick(); assert.equal(f.codex.starts.length, 1);
});

test('bounded concurrent admission returns busy without persisting another request', async t => {
  const f = await fixture(t, { maxConcurrentRequests: 1 }); await f.loop.start();
  const held = gate(), submitted = gate();
  f.loop.afterSubmit = async () => { submitted.release(); await held.promise; };
  const firstId = randomUUID(), secondId = randomUUID();
  const pending = f.submit(firstId, 'Held receipt');
  try {
    await submitted.promise;
    rejected(await f.submit(secondId, 'Excess request'), 'busy', secondId);
    assert.equal(f.loop.tasks().length, 1);
    const missing = await f.status(secondId); assert.equal(missing.code, 0); assert.equal(JSON.parse(missing.stdout).status, 'not_found');
  } finally { held.release(); await pending; }
  accepted(await pending);
  f.loop.afterSubmit = null;
  accepted(await f.submit(secondId, 'Excess request'));
  assert.equal(f.loop.tasks().length, 2);
});

test('accepted pending submissions resume through normal lifecycle after restart', async t => {
  const f = await fixture(t); await f.loop.start();
  const first = accepted(await f.submit(randomUUID(), 'Restart before preparation'));
  assert.equal(f.codex.created.length, 0);
  await f.restart();
  const recovered = accepted(await f.status(first.requestId));
  assert.ok(recovered.threadId && recovered.chatId); assert.equal(recovered.taskId, first.taskId);
  assert.equal(f.codex.starts.length, 1); assert.equal(f.loop.store.inputs(first.taskId).length, 1);
});

test('submit and status need no platform env file, Runtime or writable Store; missing Runtime creates no database', async t => {
  const f = await fixture(t); const id = randomUUID();
  rejected(await f.submit(id, 'Offline submission'), 'unavailable', id);
  assert.equal(f.loop.tasks().length, 0);
  await f.loop.close(); await rm(f.dataDir, { recursive: true, force: true });
  const result = await f.status(id); assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { requestId: id, taskId: null, status: 'not_found', reason: null, chatId: null, threadId: null });
  const all = await f.cli('status', []); assert.equal(all.code, 0, all.stderr);
  assert.deepEqual(JSON.parse(all.stdout).tasks, []);
  rejected(await f.submit(id, 'Still offline'), 'unavailable', id);
  await assert.rejects(access(join(f.dataDir, 'tasks.sqlite')));
  await assert.rejects(access(join(f.dataDir, 'owner.sqlite')));
});

test('invalid CLI bytes, blank text, oversized files and IDs produce structured errors and no tasks', async t => {
  const f = await fixture(t, { maxPromptBytes: 64 }); await f.loop.start();
  for (const bytes of [Buffer.alloc(0), Buffer.from(' \t\r\n\uFEFF'), Buffer.from([0xc3, 0x28]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.alloc(65, 97), Buffer.from('中'.repeat(22))]) {
    const id = randomUUID(); rejected(await f.submit(id, bytes), 'invalid_input', id);
  }
  const id = randomUUID();
  rejected(await f.submit(id, Buffer.alloc(65, 97), join(f.root, 'large.txt')), 'invalid_input', id);
  rejected(await f.submit('invalid-id', 'valid text'), 'invalid_input', 'invalid-id');
  rejected(await f.cli('submit', ['--prompt-file', '-'], Buffer.from('text')), 'invalid_input', null);
  rejected(await f.cli('submit', ['--request-id', id]), 'invalid_input', id);
  rejected(await f.cli('submit', ['--request-id', id, '--prompt-file', '/file/does-not-exist']), 'invalid_input', id);
  assert.equal(f.loop.tasks().length, 0); assert.equal(f.codex.created.length, 0);
  accepted(await f.submit(randomUUID(), 'a'.repeat(64)));
});

test('local RPC authenticates, rejects malformed envelopes, surrogate text and byte overflow, and publishes private endpoints', async t => {
  const f = await fixture(t, { maxPromptBytes: 32 }); await f.loop.start();
  const endpoint = await f.endpoint();
  for (const path of [f.dataDir, resolve(endpoint.socketPath, '..')]) assert.equal((await stat(path)).mode & 0o077, 0);
  assert.equal((await stat(join(f.dataDir, 'submission-endpoint.json'))).mode & 0o077, 0);
  assert.equal((await stat(endpoint.socketPath)).mode & 0o077, 0);
  const value = { requestId: randomUUID(), prompt: 'Valid' };
  assert.equal((await rpc(endpoint, Buffer.from(JSON.stringify(value)), 'Bearer wrong')).status, 403);
  for (const bytes of [Buffer.from('not-json'), Buffer.from([0xff]), Buffer.from(JSON.stringify({ ...value, prompt: '\uD800' })),
    Buffer.from(JSON.stringify({ ...value, prompt: 'a'.repeat(33) })), Buffer.from(JSON.stringify({ ...value, extra: true })), Buffer.from('x'.repeat(5000))]) {
    const result = await rpc(endpoint, bytes);
    assert.equal(result.status, 400); assert.equal(failureSchema.parse(result.body).error.code, 'invalid_input');
  }
  assert.equal(f.loop.tasks().length, 0);
  await f.loop.close();
  await assert.rejects(access(join(f.dataDir, 'submission-endpoint.json')));
  await assert.rejects(access(endpoint.socketPath));
});

test('CLI reports unknown outcome on lost response and reconciles by status and same-ID retry without executing twice', async t => {
  const f = await fixture(t); await f.loop.start();
  const endpoint = await f.endpoint();
  const proxyDirectory = await mkdtemp(join(tmpdir(), 'al-loss-'));
  const socketPath = join(proxyDirectory, 'loss.sock');
  const proxy = createServer((incoming, downstream) => {
    const upstream = request({ socketPath: endpoint.socketPath, method: 'POST', path: '/submit', headers: incoming.headers, agent: false }, response => {
      response.resume(); response.once('end', () => downstream.destroy());
    });
    upstream.on('error', () => downstream.destroy()); incoming.pipe(upstream);
  });
  await new Promise<void>(done => proxy.listen(socketPath, done));
  t.after(async () => { await new Promise<void>(done => proxy.close(() => done())); await rm(proxyDirectory, { recursive: true, force: true }); });
  const path = join(f.dataDir, 'submission-endpoint.json');
  await writeFile(path, JSON.stringify({ ...endpoint, socketPath }), { mode: 0o600 });
  const requestId = randomUUID();
  rejected(await f.submit(requestId, 'Response loss'), 'unknown_outcome', requestId);
  const receipt = accepted(await f.status(requestId)); assert.equal(receipt.status, 'pending');
  assert.equal(f.loop.tasks().length, 1);
  await writeFile(path, JSON.stringify(endpoint), { mode: 0o600 });
  assert.equal(accepted(await f.submit(requestId, 'Response loss')).taskId, receipt.taskId);
  await f.loop.tick(); assert.equal(f.codex.starts.length, 1); assert.equal(f.feishu.groups.size, 1);
});

test('Runtime stop rejects admission and waits for accepted handlers before closing SQLite', async t => {
  const f = await fixture(t); await f.loop.start();
  const endpoint = await f.endpoint(), held = gate(), submitted = gate();
  f.loop.afterSubmit = async () => { submitted.release(); await held.promise; };
  const requestId = randomUUID(), pending = f.submit(requestId, 'Accepted before stop');
  await submitted.promise;
  let closed = false;
  const closing = f.loop.close().then(() => { closed = true; });
  t.after(() => held.release());
  await waitFor(() => access(join(f.dataDir, 'submission-endpoint.json')).then(() => false, () => true));
  assert.equal(closed, false); assert.equal(f.loop.store.tasks().length, 1);
  assert.equal(accepted(await f.status(requestId)).status, 'pending');
  const late = await rpc(endpoint, Buffer.from(JSON.stringify({ requestId: randomUUID(), prompt: 'Too late' }))).catch(() => null);
  if (late) assert.equal(late.status, 503);
  const lateId = randomUUID(); rejected(await f.submit(lateId, 'After stop began'), 'unavailable', lateId);
  held.release(); accepted(await pending); await closing;
  assert.equal(closed, true); await assert.rejects(access(endpoint.socketPath));
  const store = new Store(f.dataDir); assert.equal(store.tasks().length, 1); store.close();
});

test('new and retained formal Threads receive current absolute CLI commands and explicit CLI progress', async t => {
  const f = await fixture(t); await f.loop.start();
  const requestId = randomUUID(), receipt = accepted(await f.submit(requestId, 'A CLI task\r\nDetails'));
  await f.loop.tick();
  const task = f.loop.store.task(receipt.taskId); assert.ok(task.threadId);
  const instructions = f.codex.created[0]?.instructions; assert.ok(instructions);
  assert.match(instructions, /submit --config/); assert.match(instructions, /status --config/);
  assert.ok(instructions.includes(entry)); assert.ok(instructions.includes(process.execPath));
  assert.ok(instructions.includes("'\"'\"'")); assert.doesNotMatch(instructions, /Bearer|submission-endpoint/);
  const command = instructions.match(/From any working directory run (.*?) --request-id '<uuid>'/)?.[1]; assert.ok(command);
  const secondId = randomUUID();
  const invoked = spawn('/bin/sh', ['-c', `${command} --request-id '${secondId}' --prompt-file -`], {
    cwd: join(f.root, 'other-project'), stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000,
  });
  let stdout = '', stderr = '';
  invoked.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
  invoked.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  invoked.stdin.end('Prompt chosen by the originating Agent');
  const code = await new Promise<number | null>((done, reject) => { invoked.once('error', reject); invoked.once('close', done); });
  const handed = accepted({ code, stdout, stderr }); assert.equal(handed.requestId, secondId);
  assert.notEqual(handed.taskId, task.id);
  let refreshed = '';
  const inspect = f.codex.inspect.bind(f.codex);
  f.codex.inspect = async (threadId: string, current?: string) => { refreshed = current ?? ''; return inspect(threadId); };
  await f.loop.tick(); assert.match(refreshed, /submit --config/);
  const conversation = projectDocumentConversation(task, f.loop.store.inputs(task.id), []);
  assert.equal(conversation.messages.length, 1); assert.equal(conversation.messages[0]?.role, 'cli');
  assert.equal(conversation.messages[0]?.text, 'A CLI task\nDetails');
  assert.match(documentConversationText(conversation, 3000), /CLI 提交/);
  assert.doesNotMatch(documentConversationText(conversation, 3000), /用户/);
  const dashboard = await startDashboard({ dataDir: f.dataDir, port: 0 });
  t.after(() => dashboard.close());
  const snapshot = z.object({ tasks: z.array(z.object({ id: z.string(), sourceKind: z.string(), sourceLabel: z.string(), title: z.string() })) }).parse(await (await fetch(dashboard.url + '/api/snapshot')).json());
  assert.deepEqual(snapshot.tasks[0], { id: task.id, sourceKind: 'cli', sourceLabel: 'CLI', title: 'A CLI task\r\nDetails' });
  const page = await (await fetch(dashboard.url + '/app.js')).text(); assert.match(page, /CLI SUBMISSION/);
});
