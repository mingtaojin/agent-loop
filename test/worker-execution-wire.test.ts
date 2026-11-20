import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { configSchema, ExecutionConfigWatcher } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import { CodexAppServer } from './helpers/codex.js';
import { FeishuFake, GitHubFake } from './fakes.js';

const provider = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const log = process.argv[1], file = process.argv[2];
const threads = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const persist = () => fs.writeFileSync(file, JSON.stringify(threads));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(log, line + '\n');
  const p = message.params;
  let result;
  switch (message.method) {
    case 'initialize': result = { userAgent: 'identity-wire-fixture' }; break;
    case 'initialized': return;
    case 'thread/start': {
      const id = 'thread-' + (Object.keys(threads).length + 1);
      const thread = { id, model: p.model, reasoningEffort: p.config.model_reasoning_effort, status: { type: 'idle' }, turns: [] };
      threads[id] = thread; persist(); result = { thread }; break;
    }
    case 'thread/resume': {
      const thread = threads[p.threadId];
      thread.model = p.model; thread.reasoningEffort = p.config.model_reasoning_effort;
      persist(); result = { thread }; break;
    }
    case 'thread/read': {
      const thread = threads[p.threadId];
      result = { thread: { ...thread, turns: p.includeTurns ? thread.turns : [] } }; break;
    }
    case 'turn/start': {
      const thread = threads[p.threadId];
      const turn = { id: thread.id + '-turn-' + (thread.turns.length + 1), status: 'completed', items: [
        { id: p.clientUserMessageId, type: 'userMessage', clientId: p.clientUserMessageId, content: p.input }
      ] };
      thread.turns.push(turn); persist(); result = { turn }; break;
    }
    default: throw new Error('Unexpected identity fixture request ' + message.method);
  }
  send({ id: message.id, result });
});
`;

const profileA = { backend: 'codex', model: 'model-a', reasoningEffort: 'high' as const };
const profileB = { backend: 'codex', model: 'model-b', reasoningEffort: 'medium' as const };
const requestSchema = z.object({ method: z.string().optional(), params: z.object({
  threadId: z.string().optional(), model: z.string().optional(), effort: z.string().optional(),
  config: z.object({ model_reasoning_effort: z.string() }).optional(), allowProviderModelFallback: z.boolean().optional(),
}).optional() });

test('real Codex adapter sends the saved pair on start, resume and every turn after service restart and allowlist deletion', async t => {
  const root = await mkdtemp(join(tmpdir(), 'worker-wire-'));
  const log = join(root, 'wire.jsonl'), state = join(root, 'provider.json');
  const configInput = { dataDir: join(root, 'data'), feishu: { userOpenId: 'owner' },
    projects: [{ id: 'app', name: 'Application', directory: root, repositories: [] }],
    execution: { coordinator: { backend: 'codex', model: 'coordinator-original', reasoningEffort: 'low' }, worker: [profileA, profileB] } };
  const configFile = join(root, 'config.json');
  await writeFile(configFile, JSON.stringify(configInput));
  const config = configSchema.parse(configInput);
  const errors: unknown[] = [];
  const watcher = new ExecutionConfigWatcher(configFile, config, error => errors.push(error));
  watcher.start();
  t.after(() => watcher.close());
  const github = new GitHubFake(), feishu = new FeishuFake();
  const create = () => new AgentLoop(config, { github, feishu,
    codex: new CodexAppServer({ command: [process.execPath, '-e', provider, log, state], approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 2000 }),
    workspace: { async ensure() { return root; }, async head() { return 'fixture'; } } });
  let loop = create();
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  await loop.collect(); await loop.tick();
  const coordinator = loop.projects.ledger.project('app')!.coordinatorTaskId;
  const action = { action: 'dispatch' as const, requestId: 'wire-worker', prompt: 'Use this immutable pair.', role: 'worker' as const, execution: profileB };
  const receipt = z.object({ taskId: z.string() }).parse(await loop.projectAction(coordinator, action));
  await loop.tick(); await loop.tick();
  const worker = loop.store.task(receipt.taskId); assert.ok(worker.threadId);
  const first = (await readFile(log, 'utf8')).trim().split('\n').map(line => requestSchema.parse(JSON.parse(line))).filter(row => row.method === 'thread/start');
  assert.equal(first[1]?.params?.model, profileB.model);
  assert.equal(first[1]?.params?.config?.model_reasoning_effort, profileB.reasoningEffort);
  assert.equal(first[1]?.params?.allowProviderModelFallback, false);
  const second = z.object({ inputId: z.string() }).parse(await loop.projectCall(coordinator, { tool: 'send_agent_message', arguments: { requestId: 'turn-two', taskId: worker.id, text: 'Continue the original Worker.' } }));
  for (let attempt = 0; loop.store.input(worker.id, second.inputId)?.status !== 'delivered' && attempt < 200; attempt++) await delay(10);
  assert.equal(loop.store.input(worker.id, second.inputId)?.status, 'delivered');
  await loop.tick(); await loop.tick();
  await loop.control(worker.id, 'pause');
  await writeFile(configFile, JSON.stringify({ ...configInput, execution: { worker: [profileA], coordinator: { backend: 'codex', model: 'coordinator-new', reasoningEffort: 'xhigh' } } }));
  for (let attempt = 0; config.execution.worker.length !== 1 && attempt < 200; attempt++) await delay(10);
  assert.equal(config.execution.worker.length, 1); assert.deepEqual(config.execution.worker[0], profileA);
  assert.equal(errors.length, 0);
  await loop.close(); loop = create(); await loop.recover();
  assert.equal(loop.store.task(worker.id).status, 'paused');
  await loop.control(worker.id, 'resume');
  const third = z.object({ inputId: z.string() }).parse(await loop.projectCall(coordinator, { tool: 'send_agent_message', arguments: { requestId: 'turn-three', taskId: worker.id, text: 'Continue after restart.' } }));
  for (let attempt = 0; loop.store.input(worker.id, third.inputId)?.status !== 'delivered' && attempt < 200; attempt++) await delay(10);
  assert.equal(loop.store.input(worker.id, third.inputId)?.status, 'delivered');
  await loop.tick(); await loop.tick();
  assert.deepEqual(await loop.projectAction(coordinator, action), receipt);
  const rows = (await readFile(log, 'utf8')).trim().split('\n').map(line => requestSchema.parse(JSON.parse(line)));
  const resumes = rows.filter(row => row.method === 'thread/resume' && row.params?.threadId === worker.threadId);
  assert.ok(resumes.length > 0);
  for (const row of resumes) {
    assert.equal(row.params?.model, profileB.model); assert.equal(row.params?.config?.model_reasoning_effort, profileB.reasoningEffort);
  }
  const turns = rows.filter(row => row.method === 'turn/start' && row.params?.threadId === worker.threadId);
  assert.equal(turns.length, 3);
  for (const row of turns) assert.equal(row.params?.effort, profileB.reasoningEffort);
  assert.ok(rows.some(row => row.method === 'thread/resume' && row.params?.model === 'coordinator-new' && row.params.config?.model_reasoning_effort === 'xhigh'));
  const newWorker = z.object({ taskId: z.string() }).parse(await loop.projectAction(coordinator, { ...action, requestId: 'new-a', execution: profileA }));
  await loop.tick();
  assert.deepEqual(loop.store.task(newWorker.taskId).workerExecution?.profile, profileA);
  await assert.rejects(loop.projectAction(coordinator, { ...action, requestId: 'deleted-pair' }), /outside the configured allowlist/);
});
