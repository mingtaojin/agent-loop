import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import { submissionReceiptSchema, submissionSchema, submissionSourceId, taskSchema } from '../src/domain.js';
import { projectDocumentConversation, documentConversationText } from '../src/feishu-document-conversation.js';
import { startDashboard } from '../src/dashboard.js';
import { CodexFake, FeishuFake, GitHubFake } from './fakes.js';
import { delegateIntake } from './coordinated-fixture.js';

const built = import.meta.url.endsWith('.js');
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "retired-submit ' $()-"));
  const dataDir = join(root, 'data'), configPath = join(root, 'config.json');
  const config = configSchema.parse({ dataDir, feishu: { userOpenId: 'owner' },
    projects: [{ id: 'app', name: 'Application', directory: root, repositories: [] }] });
  await writeFile(configPath, JSON.stringify(config));
  const codex = new CodexFake(), feishu = new FeishuFake(), github = new GitHubFake();
  const ports = { codex, feishu, github, workspace: { async ensure() { return root; }, async head() { return 'saved-head'; } } };
  let loop = new AgentLoop(config, ports);
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  async function cli(args: string[]) {
    const child = spawn(process.execPath, [...(built ? [] : ['--import', resolve('node_modules/tsx/dist/loader.mjs')]),
      resolve(built ? 'dist/src/cli.js' : 'src/cli.ts'), ...args, '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
    return { code, stdout, stderr };
  }
  function saved(prompt = 'Saved CLI request\r\nDetails') {
    const submission = submissionSchema.parse({ requestId: randomUUID(), prompt });
    const id = randomUUID();
    const task = taskSchema.parse({ id, sourceId: submissionSourceId(submission.requestId),
      source: { kind: 'cli', ...submission, submittedAt: Date.now() }, purpose: 'intake',
      contextDirectory: join(dataDir, 'tasks', id), resources: [], workspaceSelection: { kind: 'pending' },
      status: 'pending', reason: null, prompt: 'Saved guidance', promptHash: 'saved-hash', skillPath: null,
      chatId: null, threadId: null, turnId: null, requests: [], lastHandledTurnId: null, createdAt: Date.now(), updatedAt: Date.now() });
    loop.store.saveTask(task);
    loop.store.receive(task.id, { id: `${id}:initial`, text: prompt, chatId: '', senderId: 'external:cli', chatType: 'group',
      attachments: [], createdAt: task.createdAt }, 'initial', { kind: 'cli', requestId: submission.requestId }, 'workspace-selection');
    return task;
  }
  return { root, dataDir, codex, feishu, cli, saved, get loop() { return loop; },
    async restart() { await loop.close(); loop = new AgentLoop(config, ports); await loop.recover(); } };
}

test('CLI submit and answer are removed and help advertises only project-group intake', async t => {
  const f = await fixture(t);
  for (const command of ['submit', 'answer']) {
    const result = await f.cli([command]);
    assert.equal(result.code, 1); assert.match(result.stderr, /未知命令/); assert.equal(result.stdout, '');
  }
  const help = await f.cli(['--help']); assert.equal(help.code, 0);
  assert.doesNotMatch(help.stdout, /npm start -- (submit|answer)|private message|prompt-file|answer-id/);
  assert.match(help.stdout, /only in the project group/);
  assert.equal(f.loop.tasks().length, 0);
  await assert.rejects(access(join(f.dataDir, 'submission-endpoint.json')));
});

test('read-only status preserves historical CLI receipts without credentials or a service', async t => {
  const f = await fixture(t), task = f.saved(); assert.equal(task.source.kind, 'cli');
  if (task.source.kind !== 'cli') throw new Error('CLI source expected');
  const before = f.loop.store.task(task.id);
  const result = await f.cli(['status', '--request-id', task.source.requestId]); assert.equal(result.code, 0, result.stderr);
  const receipt = submissionReceiptSchema.parse(JSON.parse(result.stdout));
  assert.equal(receipt.taskId, task.id); assert.equal(receipt.status, 'pending'); assert.equal(receipt.chatId, null);
  assert.deepEqual(f.loop.store.task(task.id), before);
  const missing = await f.cli(['status', '--request-id', randomUUID()]); assert.equal(missing.code, 0);
  assert.equal(JSON.parse(missing.stdout).status, 'not_found');
});

test('saved CLI intake recovers into its coordinator and delegates the same Task once without a group', async t => {
  const f = await fixture(t), saved = f.saved();
  f.codex.selectionResults.push({ kind: 'project', projectId: 'coordinated:app', reason: 'Saved Application request' });
  await f.restart(); await f.loop.tick();
  const route = f.loop.projects.intakeRoute(saved.id); assert.ok(route);
  assert.equal(f.loop.store.task(saved.id).threadId, null);
  assert.deepEqual(f.loop.store.task(saved.id).source, saved.source);
  await delegateIntake(f.loop, saved.id);
  const worker = f.loop.store.task(saved.id); assert.ok(worker.threadId); assert.equal(worker.chatId, null);
  const failed = taskSchema.parse({ ...worker, status: 'failed', reason: 'Preserved execution failure' }); f.loop.store.saveTask(failed);
  const created = f.codex.created.length, starts = f.codex.starts.length;
  const receipt = await f.loop.projectAction(route.coordinatorTaskId, { action: 'dispatch', requestId: `delegate-${saved.id}`,
    intakeTaskId: saved.id, role: 'worker', prompt: 'Investigate the supplied request within its original scope.' });
  assert.equal(typeof receipt, 'object'); assert.deepEqual(f.loop.store.task(saved.id), failed);
  assert.equal(f.codex.created.length, created); assert.equal(f.codex.starts.length, starts); assert.equal(f.feishu.groups.size, 1);
  const instructions = f.codex.created.find(call => call.cwd === worker.resources[0]?.workspace)?.instructions ?? '';
  assert.match(instructions, /project_action|project-client/); assert.doesNotMatch(instructions, /submit --config|prompt-file/);
});

test('historical CLI conversation and dashboard keep original request text and provenance', async t => {
  const f = await fixture(t), task = f.saved();
  const conversation = projectDocumentConversation(task, f.loop.store.inputs(task.id), []);
  assert.equal(conversation.messages[0]?.role, 'cli'); assert.equal(conversation.messages[0]?.text, 'Saved CLI request\nDetails');
  assert.match(documentConversationText(conversation, 3000), /CLI 提交/);
  const dashboard = await startDashboard({ dataDir: f.dataDir, port: 0 }); t.after(() => dashboard.close());
  const response = await fetch(dashboard.url + '/api/snapshot');
  const snapshot: unknown = await response.json();
  assert.ok(JSON.stringify(snapshot).includes('Saved CLI request'));
  assert.ok(JSON.stringify(snapshot).includes('"sourceKind":"cli"'));
});
