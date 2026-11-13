import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CodexAppServer } from '../src/adapters/codex.js';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import { GitHubFake, FeishuFake } from './fakes.js';

test('isolated RPC rejection and authenticated socket disposition preserve the original Thread across Runtime restart', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-disposition-wire-')));
  const stateFile = join(root, 'native-fixture.json');
  const config = configSchema.parse({ dataDir: root, feishu: { userOpenId: 'owner' },
    projects: [{ id: 'wire', name: 'Wire', directory: root, repositories: [{ name: 'test/project', labelsAny: ['test'] }] }] });
  const createServer = () => new CodexAppServer({ ...config.codex,
    command: [process.execPath, resolve('test/fixtures/input-disposition-codex.mjs'), stateFile], env: {} });
  let server = createServer();
  const github = new GitHubFake(), feishu = new FeishuFake();
  const workspace = { async ensure() { return root; }, async head() { return 'isolated-head'; } };
  let loop = new AgentLoop(config, { github, feishu, codex: server, workspace });
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  await loop.collect(); await loop.tick();
  const coordinatorId = loop.projects.ledger.project('wire')?.coordinatorTaskId; assert.ok(coordinatorId);
  const dispatched = z.object({ taskId: z.string() }).parse(await loop.projectAction(coordinatorId,
    { action: 'dispatch', requestId: 'dispatch-wire', prompt: 'Reconcile work before continuing.', role: 'worker' }));
  await loop.tick();
  const worker = loop.store.task(dispatched.taskId), coordinator = loop.store.task(coordinatorId);
  assert.ok(worker.chatId && worker.threadId && coordinator.chatId && coordinator.threadId,
    JSON.stringify(loop.tasks().map(task => ({ id: task.id, status: task.status, reason: task.reason }))));
  const message = (id: string, chatId: string, text: string) => ({ id, chatId, text, senderId: 'owner', chatType: 'group', attachments: [], createdAt: Date.now() } satisfies Parameters<AgentLoop['receive']>[0]);
  await loop.receive(message('old-unknown', worker.chatId, 'Old instruction'));
  await loop.receive(message('wire-successor', worker.chatId, 'Check existing state, then follow this instruction.'));
  await loop.receive(message('wire-authorization', coordinator.chatId, 'Authorize the scoped disposition after reviewing its evidence.'));
  await loop.projectAction(coordinatorId, { action: 'control', requestId: 'pause-wire', taskId: worker.id, operation: 'pause' });
  const before = loop.store.inputs(worker.id).find(input => input.id === 'old-unknown'); assert.ok(before);
  assert.equal(before.status, 'uncertain');
  assert.ok(loop.store.outputs(worker.id).some(output => output.text.includes('Synthetic provider rejection')));
  const nativeBefore = await server.inspect(worker.threadId);
  assert.ok(!nativeBefore.seenInputIds.includes('old-unknown'));
  const actionFile = join(root, 'action.json');
  await writeFile(actionFile, JSON.stringify({ action: 'supersede_input', requestId: 'wire-disposition', taskId: worker.id, threadId: worker.threadId,
    inputId: 'old-unknown', successorInputId: 'wire-successor', authorizationInputId: 'wire-authorization',
    reason: 'Saved successor replaces the old instruction without replay.', evidence: 'Isolated RPC error receipt and persisted history.' }));
  const invoke = () => promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'),
    resolve('src/project-client.ts'), join(root, 'workspace-capabilities', coordinatorId + '.json'), actionFile]);
  const first = JSON.parse((await invoke()).stdout);
  assert.equal(first.kind, 'superseded');
  assert.deepEqual(JSON.parse((await invoke()).stdout), first);
  const { disposition, ...unchanged } = loop.store.inputs(worker.id).find(input => input.id === 'old-unknown') ?? {};
  assert.deepEqual(unchanged, before); assert.deepEqual(disposition, first);
  await loop.close(); server = createServer(); loop = new AgentLoop(config, { github, feishu, codex: server, workspace });
  await loop.recover();
  assert.equal(loop.store.task(worker.id).status, 'paused');
  assert.deepEqual(await loop.projects.action(coordinatorId, JSON.parse(await readFile(actionFile, 'utf8'))), first);
  await loop.control(worker.id, 'resume'); await loop.tick();
  assert.equal(loop.store.task(worker.id).threadId, worker.threadId);
  assert.deepEqual(loop.store.task(worker.id).resources, worker.resources);
  const state = z.object({ calls: z.array(z.object({ method: z.string(), threadId: z.string().optional(), clientUserMessageId: z.string().optional() })),
    threads: z.array(z.object({ id: z.string(), instructions: z.string() })) }).parse(JSON.parse(await readFile(stateFile, 'utf8')));
  assert.equal(state.calls.filter(call => call.method === 'thread/start').length, 2);
  assert.equal(state.calls.filter(call => call.method === 'turn/start' && call.clientUserMessageId === 'old-unknown').length, 1);
  assert.equal(state.calls.filter(call => call.method === 'turn/start' && call.clientUserMessageId === 'wire-successor').length, 1);
  assert.match(state.threads.find(thread => thread.id === worker.threadId)?.instructions ?? '', /reconcile existing work and effects/);
  assert.equal(loop.store.inputs(worker.id).find(input => input.id === 'old-unknown')?.status, 'uncertain');
  assert.equal(loop.store.inputs(worker.id).find(input => input.id === 'wire-successor')?.status, 'delivered');
});
