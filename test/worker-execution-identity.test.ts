import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectActionSchema } from '../src/project.js';
import { taskSchema, type Task } from '../src/domain.js';
import { CodexProviderMismatchError } from '../src/ports.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import type { ExecutionProfile } from '../src/execution.js';
import { CodexFake, FeishuFake, GitHubFake } from './fakes.js';
import type { CodexPort, WorkspacePort } from '../src/ports.js';
import { Store } from '../src/store.js';

const workerA: ExecutionProfile = { backend: 'codex', model: 'worker-a', reasoningEffort: 'high' };
const workerB: ExecutionProfile = { backend: 'codex', model: 'worker-b', reasoningEffort: 'medium' };
const coordinator: ExecutionProfile = { backend: 'codex', model: 'coordinator', reasoningEffort: 'low' };

class IdentityCodex extends CodexFake {
  readonly observations: { threadId: string; model?: string; reasoningEffort?: string }[] = [];
  override async inspect(...args: Parameters<CodexPort['inspect']>) {
    const [threadId, _instructions, model, reasoningEffort] = args;
    this.observations.push({ threadId, model, reasoningEffort });
    return super.inspect(threadId);
  }
  override async activity(...args: Parameters<CodexPort['activity']>) {
    const [threadId, _instructions, model, reasoningEffort] = args;
    this.observations.push({ threadId, model, reasoningEffort });
    return super.activity(...args);
  }
}

async function fixture(t: TestContext, profiles = [workerA, workerB]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-worker-identity-')));
  const config = configSchema.parse({
    dataDir: root,
    execution: { coordinator, worker: profiles },
    feishu: { userOpenId: 'owner' },
    projects: [{ id: 'app', name: 'Application', directory: root, repositories: [] }],
  });
  const codex = new IdentityCodex();
  const workspace: WorkspacePort = { async ensure(input) { return input.kind === 'project-directory' ? input.directory : input.workspace ?? root; }, async head() { return 'head'; } };
  const ports = { github: new GitHubFake(), feishu: new FeishuFake(), codex, workspace };
  let loop = new AgentLoop(config, ports, new Store(root));
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  await loop.collect(); await loop.tick();
  const project = loop.projects.ledger.project('app');
  assert.ok(project);
  const coordinatorTask = loop.store.task(project.coordinatorTaskId);
  return { root, config, get loop() { return loop; }, codex, coordinatorTask,
    async restart() { await loop.close(); loop = new AgentLoop(config, ports, new Store(root)); await loop.recover(); } };
}

async function dispatch(f: Awaited<ReturnType<typeof fixture>>, execution?: ExecutionProfile) {
  const action = { action: 'dispatch' as const, requestId: `dispatch-${randomUUID()}`, role: 'worker' as const,
    prompt: 'Preserve the selected execution identity.', ...(execution ? { execution } : {}) };
  const result = await f.loop.projectAction(f.coordinatorTask.id, projectActionSchema.parse(action));
  await f.loop.tick();
  return f.loop.store.task(z.object({ taskId: z.string() }).parse(result).taskId);
}

test('worker dispatch accepts only complete allowlisted execution profiles', async t => {
  const f = await fixture(t);
  const worker = await dispatch(f, workerB);
  assert.deepEqual(worker.workerExecution?.profile, workerB);
  assert.equal(f.codex.created.at(-1)?.model, workerB.model);
  await assert.rejects(dispatch(f, { ...workerA, model: workerB.model }), /outside the configured allowlist/);
  await assert.rejects(dispatch(f), /execution/);
});

test('a saved Worker identity survives allowlist deletion and restart', async t => {
  const f = await fixture(t);
  const worker = await dispatch(f, workerB);
  const created = f.codex.created.length;
  f.config.execution.worker = [workerA];
  await f.restart(); await f.loop.tick();
  const restored = f.loop.store.task(worker.id);
  assert.deepEqual(restored.workerExecution?.profile, workerB);
  assert.equal(f.codex.created.length, created);
  const calls = f.codex.observations.filter(call => call.threadId === worker.threadId);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.model === workerB.model && call.reasoningEffort === workerB.reasoningEffort));
});

function replaceAsHistorical(f: Awaited<ReturnType<typeof fixture>>, worker: Task) {
  const legacy = { ...worker };
  delete legacy.workerExecution;
  const database = new DatabaseSync(join(f.root, 'tasks.sqlite'));
  try { database.prepare('UPDATE tasks SET payload=? WHERE id=?').run(JSON.stringify(legacy), worker.id); }
  finally { database.close(); }
  return legacy;
}

for (const missing of ['both', 'model', 'effort', 'invalid-effort'] as const) test(`historical identity ${missing} is blocked without execution or state changes across resume and restart`, async t => {
  const f = await fixture(t, [workerA]);
  const worker = await dispatch(f, workerA);
  assert.ok(worker.threadId);
  await f.loop.projectAction(f.coordinatorTask.id, { action: 'open_group', requestId: 'open', taskId: worker.id });
  await f.loop.control(worker.id, 'pause');
  const paused = f.loop.store.task(worker.id);
  paused.requests = [{ id: 'pending-native', threadId: worker.threadId, turnId: worker.turnId!, kind: 'approval', prompt: 'Retain approval', method: 'item/commandExecution/requestApproval', payload: {}, isBlocking: true, connectionEpoch: 'original' }];
  f.loop.store.saveTask(paused);
  const message = { id: 'held', chatId: paused.chatId!, senderId: 'owner', chatType: 'group' as const, text: 'Continue later', attachments: [], createdAt: Date.now() };
  f.loop.store.receive(worker.id, message);
  f.loop.store.markInput(message.id, 'held');
  const original = replaceAsHistorical(f, paused);
  if (missing !== 'both' && missing !== 'model') f.loop.store.setMeta(`project-task-model:${worker.id}`, workerB.model);
  if (missing === 'model') f.loop.store.setMeta(`project-task-effort:${worker.id}`, workerB.reasoningEffort);
  if (missing === 'invalid-effort') f.loop.store.setMeta(`project-task-effort:${worker.id}`, 'invalid');
  const observations = f.codex.observations.length, creates = f.codex.created.length;
  const starts = () => f.codex.starts.filter(call => call.threadId === worker.threadId).length;
  const steers = () => f.codex.steers.filter(call => call.threadId === worker.threadId).length;
  const started = starts(), steered = steers();
  await f.loop.tick(); await f.loop.tick();
  await f.loop.control(worker.id, 'resume');
  assert.deepEqual(f.loop.store.task(worker.id), original);
  assert.equal(f.loop.store.input(worker.id, 'held')?.status, 'held');
  assert.ok(f.codex.observations.slice(observations).every(call => call.threadId !== worker.threadId));
  assert.equal(starts(), started); assert.equal(steers(), steered); assert.equal(f.codex.created.length, creates);
  const blockers = () => f.loop.store.inputs(f.coordinatorTask.id).filter(input => input.provenance.kind === 'agent' && input.provenance.eventId === `execution-identity:${worker.id}`);
  assert.equal(blockers().length, 1);
  assert.match(blockers()[0]!.message.text, /No complete reliable original model/);
  const blocker = blockers()[0]!.provenance;
  assert.equal(blocker.kind === 'agent' && blocker.escalation, 'blocker');
  await f.restart(); await f.loop.tick();
  assert.deepEqual(f.loop.store.task(worker.id), original);
  assert.equal(blockers().length, 1);
});

test('complete historical task metadata restores the original pair and source independently of the allowlist', async t => {
  const f = await fixture(t);
  const worker = await dispatch(f, workerB);
  f.config.execution.worker = [workerA];
  replaceAsHistorical(f, worker);
  const modelKey = `project-task-model:${worker.id}`, effortKey = `project-task-effort:${worker.id}`;
  f.loop.store.setMeta(modelKey, workerB.model); f.loop.store.setMeta(effortKey, workerB.reasoningEffort);
  const observations = f.codex.observations.length;
  await f.loop.tick();
  assert.deepEqual(f.loop.store.task(worker.id).workerExecution, { profile: workerB, source: { kind: 'legacy-task-metadata', modelKey, effortKey } });
  const calls = f.codex.observations.slice(observations).filter(call => call.threadId === worker.threadId);
  assert.ok(calls.length); assert.ok(calls.every(call => call.model === workerB.model && call.reasoningEffort === workerB.reasoningEffort));
  assert.equal(f.loop.store.meta(modelKey), workerB.model); assert.equal(f.loop.store.meta(effortKey), workerB.reasoningEffort);
});

test('saved execution identity cannot be changed or deleted through task persistence', async t => {
  const f = await fixture(t);
  const worker = await dispatch(f, workerA);
  assert.ok(worker.workerExecution);
  await assert.rejects(f.loop.projectAction(f.coordinatorTask.id, { action: 'dispatch', requestId: worker.workerExecution.source.kind === 'dispatch' ? worker.workerExecution.source.requestId : 'unexpected', prompt: 'Preserve the selected execution identity.', role: 'worker', execution: workerB }), /different content/);
  const changed = structuredClone(worker);
  changed.workerExecution!.profile = workerB;
  assert.throws(() => f.loop.store.saveTask(changed), /immutable/);
  delete changed.workerExecution;
  assert.throws(() => f.loop.store.saveTask(changed), /immutable/);
  assert.deepEqual(f.loop.store.task(worker.id).workerExecution, worker.workerExecution);
});

test('missing explicit selection rejects even a one-entry allowlist', async t => {
  const f = await fixture(t, [workerA]);
  await assert.rejects(dispatch(f), /execution/);
});

test('duplicate Worker allowlist entries are rejected at the config boundary', () => {
  const result = configSchema.safeParse({ execution: { coordinator, worker: [workerA, workerA] }, feishu: { userOpenId: 'owner' } });
  assert.equal(result.success, false);
});

test('saved Worker pair remains fixed across multiple turns, pause and provider migration', async t => {
  const f = await fixture(t);
  const worker = await dispatch(f, workerB);
  assert.ok(worker.threadId);
  const originalIdentity = worker.workerExecution;
  f.config.execution.worker = [workerA];
  await f.loop.projectAction(f.coordinatorTask.id, { action: 'open_group', requestId: 'open', taskId: worker.id });
  const opened = f.loop.store.task(worker.id);
  assert.ok(opened.chatId);
  f.codex.complete(worker.threadId, null); await f.loop.tick();
  await f.loop.receive({ id: 'second-turn', chatId: opened.chatId, senderId: 'owner', chatType: 'group', text: 'Continue the same task.', attachments: [], createdAt: Date.now() });
  assert.equal(f.codex.starts.filter(call => call.threadId === worker.threadId).length, 2);
  await f.loop.control(worker.id, 'pause');
  f.codex.inspectErrors.set(worker.threadId, new CodexProviderMismatchError('old-provider', 'new-provider'));
  await f.loop.control(worker.id, 'resume'); await f.loop.tick();
  const migrated = f.loop.store.task(worker.id);
  assert.notEqual(migrated.threadId, worker.threadId);
  assert.deepEqual(migrated.workerExecution, originalIdentity);
  assert.equal(f.codex.created.at(-1)?.model, workerB.model);
  assert.equal(f.codex.created.at(-1)?.reasoningEffort, workerB.reasoningEffort);
});

test('status queries leave historical execution identity untouched', async t => {
  const f = await fixture(t);
  const worker = await dispatch(f, workerB);
  const original = replaceAsHistorical(f, worker);
  f.loop.store.setMeta(`project-task-model:${worker.id}`, workerB.model);
  f.loop.store.setMeta(`project-task-effort:${worker.id}`, workerB.reasoningEffort);
  await f.loop.projectAction(f.coordinatorTask.id, { action: 'status', section: 'tasks' });
  await f.loop.control(worker.id, 'status');
  assert.deepEqual(f.loop.store.task(worker.id), original);
});

test('identity-blocked restart preserves group binding when history says the group is unavailable', async t => {
  const f = await fixture(t);
  const worker = await dispatch(f, workerB);
  await f.loop.projectAction(f.coordinatorTask.id, { action: 'open_group', requestId: 'open', taskId: worker.id });
  await f.loop.control(worker.id, 'pause');
  const original = replaceAsHistorical(f, f.loop.store.task(worker.id));
  assert.ok(original.chatId);
  await f.loop.ports.feishu.dissolveGroup(original.chatId);
  f.loop.store.enqueue(worker.id, 'Retain pending output until identity is established.', 'before-block');
  const outputs = f.loop.store.outputs(worker.id);
  const sent = f.loop.ports.feishu.send;
  let sends = 0;
  f.loop.ports.feishu.send = async input => { if (input.chatId === original.chatId) { sends++; throw new Error('Unknown original group'); } return sent.call(f.loop.ports.feishu, input); };
  const history = f.loop.ports.feishu.history;
  let blockedHistory = 0;
  f.loop.ports.feishu.history = async input => {
    if (input.chatId === original.chatId) blockedHistory++;
    return history.call(f.loop.ports.feishu, input);
  };
  await f.restart(); await f.loop.tick();
  assert.deepEqual(f.loop.store.task(worker.id), original);
  assert.equal(blockedHistory, 0); assert.equal(sends, 0);
  assert.deepEqual(f.loop.store.outputs(worker.id), outputs);
});

test('an adopted historical Worker blocks before unavailable saved resources can change its state', async t => {
  const f = await fixture(t);
  const worker = await dispatch(f, workerB);
  const id = 'historical-before-adoption';
  const legacy = taskSchema.parse({ ...worker, id, sourceId: id,
    workerExecution: undefined, purpose: 'legacy', chatId: null,
    contextDirectory: join(f.root, 'tasks', id),
    threadId: await f.codex.createThread({ cwd: f.root, instructions: 'Original historical task.', model: workerB.model, reasoningEffort: workerB.reasoningEffort }),
    resources: [{ id: 'saved-resource', kind: 'project', workspace: f.root,
      project: { kind: 'project', id: 'saved-project', name: 'Application', entryPath: f.root, canonicalPath: f.root } }],
  });
  f.loop.store.saveTask(legacy);
  let restores = 0;
  f.loop.ports.workspace.ensure = async () => { restores++; throw new Error('Original workspace unavailable'); };
  await f.restart();
  const adopted = f.loop.store.task(id);
  assert.equal(adopted.status, legacy.status); assert.equal(adopted.reason, legacy.reason);
  assert.equal(adopted.threadId, legacy.threadId); assert.deepEqual(adopted.resources, legacy.resources);
  assert.equal(f.loop.projects.ledger.membership(id)?.role, 'worker');
  assert.equal(restores, 0);
});

test('lost dispatch receipt retries preserve the accepted pair after it is removed from the allowlist', async t => {
  const f = await fixture(t);
  const action = { action: 'dispatch' as const, requestId: 'lost-receipt', prompt: 'Preserve accepted work.', role: 'worker' as const, execution: workerB };
  t.mock.method(f.loop.projects.ledger, 'saveReceipt', () => { throw new Error('Receipt write failed after acceptance'); }, { times: 1 });
  await assert.rejects(f.loop.projectAction(f.coordinatorTask.id, action), /Receipt write failed/);
  const accepted = f.loop.tasks().find(task => f.loop.projects.ledger.membership(task.id)?.role === 'worker');
  assert.ok(accepted);
  f.config.execution.worker = [workerA];
  await f.restart();
  assert.deepEqual(await f.loop.projectAction(f.coordinatorTask.id, action), { taskId: accepted.id });
  assert.deepEqual(f.loop.store.task(accepted.id).workerExecution?.profile, workerB);
  assert.equal(f.loop.tasks().filter(task => f.loop.projects.ledger.membership(task.id)?.role === 'worker').length, 1);
});
