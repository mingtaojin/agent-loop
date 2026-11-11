import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { configSchema } from '../src/config.js';
import { startDashboard } from '../src/dashboard.js';
import { AgentLoop } from '../src/loop.js';
import { WorkspaceProvider } from '../src/workspace.js';
import { CodexFake, FeishuFake, GitHubFake } from '../test/fakes.js';

const execute = promisify(execFile);
const project = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../' : '../../', import.meta.url));
const entry = import.meta.url.endsWith('.ts')
  ? [join(project, 'node_modules/tsx/dist/cli.mjs'), join(project, 'src/cli.ts')]
  : [join(project, 'dist/src/cli.js')];
const receiptSchema = z.object({ requestId: z.string(), taskId: z.string(), status: z.string() });
const root = await mkdtemp(join(tmpdir(), 'agent-loop-submit-acceptance-'));
const configPath = join(root, 'config.json');
const config = configSchema.parse({ dataDir: join(root, 'data'), repositories: [],
  feishu: { userOpenId: 'acceptance-owner' }, pollIntervalMs: 60_000, executionPollMs: 25 });
await writeFile(configPath, JSON.stringify(config));
const github = new GitHubFake(), feishu = new FeishuFake(), codex = new CodexFake();
const ports = { github, feishu, codex, workspace: new WorkspaceProvider(config.dataDir) };
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !['GITHUB_TOKEN', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET'].includes(name)));
let loop = new AgentLoop(config, ports, undefined, { configPath });
let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
const passed: string[] = [];

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for accepted task execution');
    await delay(20);
  }
}

async function cli(...args: string[]) {
  return execute(process.execPath, [...entry, ...args, '--config', configPath], {
    cwd: root, env, timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  });
}

try {
  await loop.start();
  await loop.receive({ id: 'acceptance-original-task', chatId: 'original-private', senderId: config.feishu.userOpenId,
    chatType: 'p2p', text: 'Original discussion stays here.', attachments: [], createdAt: Date.now() });
  const original = loop.tasks()[0];
  assert.ok(original?.threadId && original.chatId);
  codex.complete(original.threadId, 'Original discussion is ready for handoff.');
  await loop.tick();
  const prompt = '\uFEFF  /new Implement the agreed work.\r\n\u4fdd\u7559\u5df2\u786e\u8ba4\u7684\u8303\u56f4\u3002\r\nDo not deploy.  \r\n';
  const promptFile = join(root, 'handoff prompt.txt');
  await writeFile(promptFile, prompt);
  const requestId = randomUUID();
  const submit = () => cli('submit', '--request-id', requestId, '--prompt-file', promptFile);
  const accepted = receiptSchema.parse(JSON.parse((await submit()).stdout));
  assert.equal(accepted.requestId, requestId);
  assert.notEqual(accepted.taskId, original.id);
  passed.push('Actual CLI accepts a new task without platform credentials from another cwd.');

  await waitFor(() => {
    const current = loop.store.task(accepted.taskId);
    return Boolean(current.threadId) && codex.starts.some(turn => turn.threadId === current.threadId);
  });
  const task = loop.store.task(accepted.taskId);
  assert.ok(task.threadId && task.chatId);
  assert.equal(task.source.kind, 'cli');
  assert.notEqual(task.threadId, original.threadId);
  assert.notEqual(task.chatId, original.chatId);
  assert.equal(loop.store.task(original.id).threadId, original.threadId);
  assert.ok(loop.store.inputs(task.id).some(input => input.message.text === prompt));
  assert.ok(codex.starts.some(turn => turn.threadId === task.threadId && turn.input.some(input => input.kind === 'text' && input.text === prompt)));
  assert.ok(codex.created.some(thread => thread.instructions.includes(configPath)
    && thread.instructions.includes('--request-id') && thread.instructions.includes('--prompt-file')));
  passed.push('Exact BOM, CRLF, Unicode and /new text reach an independent formal Thread; original context is unchanged.');

  const starts = codex.starts.length;
  const retries = await Promise.all([submit(), submit(), submit()]);
  for (const retry of retries) assert.equal(receiptSchema.parse(JSON.parse(retry.stdout)).taskId, task.id);
  assert.equal(loop.tasks().length, 2);
  assert.equal(codex.starts.length, starts);
  passed.push('Concurrent same-ID retries return one Task without another execution.');

  const changedFile = join(root, 'changed.txt');
  await writeFile(changedFile, prompt + 'Changed scope.');
  await assert.rejects(cli('submit', '--request-id', requestId, '--prompt-file', changedFile));
  assert.equal(loop.tasks().length, 2);
  assert.ok(loop.store.inputs(task.id).some(input => input.message.text === prompt));
  passed.push('Same-ID changed prompt is rejected without altering accepted work.');

  const another = receiptSchema.parse(JSON.parse((await cli('submit', '--request-id', randomUUID(), '--prompt-file', promptFile)).stdout));
  assert.notEqual(another.taskId, task.id);
  await waitFor(() => {
    const current = loop.store.task(another.taskId);
    return Boolean(current.threadId) && codex.starts.some(turn => turn.threadId === current.threadId);
  });
  passed.push('A new request ID creates another task even when prompt text is identical.');

  const emptyFile = join(root, 'empty.txt'), invalidFile = join(root, 'invalid-utf8.txt');
  await writeFile(emptyFile, ' \r\n\t');
  await writeFile(invalidFile, Uint8Array.of(0xc3, 0x28));
  for (const file of [emptyFile, invalidFile]) await assert.rejects(cli('submit', '--request-id', randomUUID(), '--prompt-file', file));
  assert.equal(loop.tasks().length, 3);
  passed.push('Blank and malformed UTF-8 inputs create no tasks.');

  codex.complete(task.threadId, 'Synthetic submission acceptance completed.');
  await loop.tick();
  assert.ok(feishu.sent.some(message => message.chatId === task.chatId && message.text === 'Synthetic submission acceptance completed.'));
  assert.ok(!feishu.sent.some(message => message.chatId === original.chatId && message.text === 'Synthetic submission acceptance completed.'));
  passed.push('Final answer follows the new task group through the existing output path.');

  dashboard = await startDashboard({ dataDir: config.dataDir, port: 0 });
  const snapshot = z.object({ tasks: z.array(z.object({ id: z.string(), sourceKind: z.string() })) })
    .parse(await (await fetch(dashboard.url + '/api/snapshot')).json());
  assert.equal(snapshot.tasks.find(item => item.id === task.id)?.sourceKind, 'cli');
  await dashboard.close(); dashboard = undefined;
  passed.push('Read-only dashboard reads the new source alongside historical sources.');

  await loop.close();
  const offlineStatus = await cli('status', '--request-id', requestId);
  assert.ok(offlineStatus.stdout.includes(task.id));
  await assert.rejects(submit());
  passed.push('Persisted status remains queryable after shutdown; unavailable Runtime rejects submission.');

  loop = new AgentLoop(config, ports, undefined, { configPath });
  await loop.start();
  const afterRestart = receiptSchema.parse(JSON.parse((await submit()).stdout));
  assert.equal(afterRestart.taskId, task.id);
  assert.equal(loop.tasks().length, 3);
  assert.equal(loop.store.task(task.id).threadId, task.threadId);
  assert.equal(loop.store.task(task.id).chatId, task.chatId);
  assert.equal(codex.starts.length, starts + 1);
  passed.push('Restart and retry preserve Task, group, formal Thread and execution count.');
  process.stdout.write(JSON.stringify({ result: 'PASS', surface: 'actual CLI and isolated Runtime',
    platforms: 'controlled Feishu and Codex ports', checks: passed }, null, 2) + '\n');
} finally {
  await dashboard?.close();
  await loop.close();
  await rm(root, { recursive: true, force: true });
}
