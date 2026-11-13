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
import { delegateIntake } from './coordinated-fixture.js';

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
    repositories: [{ name: 'example/submission', path: root, baseBranch: 'main', workspace: { kind: 'project-directory', path: root } }],
    feishu: { userOpenId: 'owner', appIdEnv: 'ABSENT_SUBMIT_APP', appSecretEnv: 'ABSENT_SUBMIT_SECRET' },
    github: { tokenEnv: 'ABSENT_SUBMIT_GITHUB' }, pollIntervalMs: 60_000, executionPollMs: 60_000 });
  await writeFile(configPath, JSON.stringify(config));
  await mkdir(join(root, 'other-project'));
  const codex = new CodexFake(), feishu = new FeishuFake(), github = new GitHubFake();
  codex.selectionResults = Array.from({ length: 20 }, () => ({ kind: 'repository', repositoryName: 'example/submission', reason: 'Select the submission project' }));
  const ports = { codex, feishu, github, workspace: {
    async ensure() { return root; }, async head() { return 'unused'; },
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
    requests() { return loop.tasks().filter(task => !task.sourceId.startsWith('project:')); },
    async delegate(taskId: string) { return delegateIntake(loop, taskId); },
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

test('actual CLI file and stdin preserve exact intake text and require coordinator dispatch before Worker execution', async t => {
  const f = await fixture(t); await f.loop.start();
  const prompt = '\uFEFF  /new do not strip this\r\n规格与限制 🎯 e\u0301\r\n  final spaces  \r\n';
  const first = accepted(await f.submit(randomUUID(), prompt, join(f.root, "prompt ' $.txt")));
  const second = accepted(await f.submit(randomUUID(), prompt));
  assert.equal(first.status, 'pending'); assert.equal(first.purpose, 'intake');
  assert.equal(first.chatId, null); assert.equal(first.threadId, null);
  assert.equal(first.projectId, null); assert.equal(first.coordinatorTaskId, null);
  assert.notEqual(first.taskId, second.taskId); assert.equal(f.requests().length, 2);
  assert.throws(() => new Store(f.dataDir), /已有 Agent Loop/);
  for (const receipt of [first, second]) {
    const task = f.loop.store.task(receipt.taskId);
    assert.equal(task.prompt, 'Generic engineering guidance, independent of the submitted task.');
    assert.ok(task.source.kind === 'cli'); assert.equal(task.source.prompt, prompt);
    const inputs = f.loop.store.inputs(task.id); assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.message.text, prompt); assert.equal(inputs[0]?.message.senderId, 'external:cli');
    assert.deepEqual(inputs[0]?.provenance, { kind: 'cli', requestId: receipt.requestId });
  }
  await f.loop.tick();
  assert.equal(f.codex.created.length, 1); assert.equal(f.feishu.groups.size, 1);
  const routes = [first, second].map(receipt => f.loop.projects.intakeRoute(receipt.taskId));
  assert.ok(routes[0]); assert.deepEqual(routes[0], routes[1]);
  for (const receipt of [first, second]) {
    const status = accepted(await f.status(receipt.requestId));
    assert.equal(status.taskId, receipt.taskId); assert.equal(status.purpose, 'intake');
    assert.equal(status.threadId, null); assert.equal(status.chatId, null);
    assert.deepEqual({ projectId: status.projectId, coordinatorTaskId: status.coordinatorTaskId }, routes[0]);
  }
  const worker = await f.delegate(first.taskId); assert.ok(worker.threadId); assert.equal(worker.chatId, null);
  assert.deepEqual(f.codex.starts.find(start => start.threadId === worker.threadId)?.input[0], { kind: 'text', text: prompt });
  const promoted = accepted(await f.status(first.requestId));
  assert.equal(promoted.taskId, first.taskId); assert.equal(promoted.purpose, 'execution');
  assert.equal(promoted.threadId, worker.threadId); assert.equal(f.loop.store.task(second.taskId).threadId, null);
  f.codex.complete(worker.threadId, 'Reply through the project coordinator'); await f.loop.tick();
  assert.equal(f.feishu.groups.size, 1);
  assert.ok(f.loop.store.inputs(routes[0]!.coordinatorTaskId).some(input => input.message.text.includes('Reply through the project coordinator')));
});

test('concurrent CLI retries, exact-content conflicts, persisted status and restart keep one task and input per request', async t => {
  const f = await fixture(t); await f.loop.start();
  const requestId = randomUUID();
  const receipts = await Promise.all(Array.from({ length: 5 }, () => f.submit(requestId, 'Same text\r\n').then(accepted)));
  assert.equal(new Set(receipts.map(receipt => receipt.taskId)).size, 1);
  const first = receipts[0]; assert.ok(first);
  assert.equal(f.requests().length, 1); assert.equal(f.loop.store.inputs(first.taskId).length, 1);
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
  await f.loop.tick(); f.codex.loseCreateAck = true; await f.delegate(first.taskId);
  const failed = f.loop.store.task(first.taskId); assert.equal(failed.status, 'failed');
  const retry = accepted(await f.submit(requestId, 'A task'));
  assert.equal(retry.status, 'failed'); assert.deepEqual(f.loop.store.task(first.taskId), failed);
  await f.restart();
  accepted(await f.submit(requestId, 'A task')); await f.loop.tick();
  assert.equal(f.codex.created.length, 2); assert.equal(f.codex.starts.length, 1);
  assert.equal(f.feishu.groups.size, 1, 'only the coordinator keeps a group');
  assert.equal(f.loop.store.task(first.taskId).chatId, null, 'the failed Worker remains group-less');
});

test('concurrent different prompts with one identity accept one immutable request and reject the other', async t => {
  const f = await fixture(t); await f.loop.start();
  const requestId = randomUUID();
  const results = await Promise.all(['First prompt', 'Different prompt'].map(prompt => f.submit(requestId, prompt)));
  assert.deepEqual(results.map(result => result.code).sort(), [0, 1]);
  const failure = results.find(result => result.code === 1); assert.ok(failure); rejected(failure, 'conflict', requestId);
  const task = f.requests()[0]; assert.ok(task && task.source.kind === 'cli');
  assert.equal(f.requests().length, 1); assert.equal(f.loop.store.inputs(task.id).length, 1);
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
  assert.equal(f.requests().length, 0);
  const missing = await f.status(requestId); assert.equal(missing.code, 0); assert.equal(JSON.parse(missing.stdout).status, 'not_found');
  fail = false;
  const receipt = accepted(await f.submit(requestId, 'Atomic acceptance'));
  assert.equal(f.requests().length, 1); assert.equal(f.loop.store.inputs(receipt.taskId).length, 1);
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
    assert.equal(f.requests().length, 1);
    const missing = await f.status(secondId); assert.equal(missing.code, 0); assert.equal(JSON.parse(missing.stdout).status, 'not_found');
  } finally { held.release(); await pending; }
  accepted(await pending);
  f.loop.afterSubmit = null;
  accepted(await f.submit(secondId, 'Excess request'));
  assert.equal(f.requests().length, 2);
});

test('accepted pending submissions resume through normal lifecycle after restart', async t => {
  const f = await fixture(t); await f.loop.start();
  const first = accepted(await f.submit(randomUUID(), 'Restart before preparation'));
  assert.equal(f.codex.created.length, 0);
  await f.restart();
  const recovered = accepted(await f.status(first.requestId));
  assert.equal(recovered.threadId, null); assert.equal(recovered.chatId, null); assert.equal(recovered.purpose, 'intake');
  assert.ok(recovered.projectId && recovered.coordinatorTaskId); assert.equal(recovered.taskId, first.taskId);
  assert.equal(f.codex.starts.length, 1); assert.equal(f.loop.store.inputs(first.taskId).length, 1);
});

test('actual CLI answers clarify the same intake across restart and promoted follow-ups reach only its coordinator', async t => {
  const f = await fixture(t);
  f.codex.selectionResults.unshift({ kind: 'question', question: 'Which project owns this request?' });
  await f.loop.start();
  const requestId = randomUUID(), answerId = randomUUID();
  const receipt = accepted(await f.submit(requestId, 'Investigate an unspecified project'));
  await f.loop.tick();
  assert.equal(f.codex.created.length, 0); assert.equal(f.feishu.groups.size, 0);
  const answer = (id: string, text: string) => f.cli('answer', [
    '--request-id', requestId, '--answer-id', id, '--prompt-file', '-',
  ], Buffer.from(text));
  const scope = 'Use example/submission. Investigate only; preserve local changes.\r\n';
  assert.equal(accepted(await answer(answerId, scope)).taskId, receipt.taskId);
  accepted(await answer(answerId, scope));
  rejected(await answer(answerId, `${scope}Changed scope`), 'conflict', requestId);
  assert.equal(f.loop.store.inputs(receipt.taskId).length, 2);
  await f.restart();
  const status = accepted(await f.status(requestId));
  assert.equal(status.taskId, receipt.taskId); assert.equal(status.purpose, 'intake');
  assert.equal(status.threadId, null); assert.ok(status.projectId && status.coordinatorTaskId);
  assert.equal(f.requests().length, 1);
  accepted(await answer(answerId, scope));
  assert.equal(f.loop.store.inputs(receipt.taskId).length, 2);
  const coordinatorMaterial = f.loop.store.inputs(status.coordinatorTaskId).map(input => input.message.text).join('\n');
  assert.ok(coordinatorMaterial.includes('Investigate an unspecified project'));
  assert.ok(coordinatorMaterial.includes(scope));
  const worker = await f.delegate(receipt.taskId); assert.ok(worker.threadId);
  assert.equal(worker.chatId, null);
  const inbox = f.loop.store.inputs(worker.id), starts = f.codex.starts.filter(input => input.threadId === worker.threadId);
  const steers = f.codex.steers.filter(input => input.threadId === worker.threadId);
  const followUpId = randomUUID(), followUp = 'New evidence needs coordinator assessment before further work.';
  accepted(await answer(followUpId, followUp)); await f.loop.tick();
  assert.deepEqual(f.loop.store.inputs(worker.id), inbox);
  assert.deepEqual(f.codex.starts.filter(input => input.threadId === worker.threadId), starts);
  assert.deepEqual(f.codex.steers.filter(input => input.threadId === worker.threadId), steers);
  const events = () => f.loop.store.inputs(status.coordinatorTaskId!).filter(input => input.provenance.kind === 'agent'
    && input.provenance.category === 'request_followup' && input.message.text.includes(followUp));
  assert.equal(events().length, 1);
  await f.restart(); accepted(await answer(followUpId, followUp)); await f.loop.tick();
  assert.equal(events().length, 1); assert.equal(f.requests().length, 1);
});

test('submit and status need no platform env file, Runtime or writable Store; missing Runtime creates no database', async t => {
  const f = await fixture(t); const id = randomUUID();
  rejected(await f.submit(id, 'Offline submission'), 'unavailable', id);
  assert.equal(f.requests().length, 0);
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
  assert.equal(f.requests().length, 0); assert.equal(f.codex.created.length, 0);
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
  assert.equal(f.requests().length, 0);
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
  assert.equal(f.requests().length, 1);
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
  const task = await f.delegate(receipt.taskId); assert.ok(task.threadId);
  const instructions = f.codex.created.find(input => input.cwd === task.resources[0]?.workspace)?.instructions; assert.ok(instructions);
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
  assert.deepEqual(snapshot.tasks.find(item => item.id === task.id), { id: task.id, sourceKind: 'cli', sourceLabel: 'CLI', title: 'A CLI task\r\nDetails' });
  const page = await (await fetch(dashboard.url + '/app.js')).text(); assert.match(page, /CLI SUBMISSION/);
});
