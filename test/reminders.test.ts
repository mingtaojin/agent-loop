import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { configSchema } from '../src/config.js';
import { reminderSchema, UncertainOperationError } from '../src/domain.js';
import { AgentLoop } from '../src/loop.js';
import type { CodexPort } from '../src/ports.js';
import type { ProjectAction } from '../src/project.js';
import { Store } from '../src/store.js';
import { CodexFake, FeishuFake, GitHubFake } from './fakes.js';
import { testExecution } from './test-config.js';

const receiptSchema = z.object({ accepted: z.literal(true), reminder: reminderSchema });
const pageSchema = z.object({ reminders: z.array(reminderSchema), total: z.number(), offset: z.number(), limit: z.number(), nextOffset: z.number().nullable() });

class ReminderCodexFake extends CodexFake {
  projectHandler: Parameters<NonNullable<CodexPort['setProjectHandler']>>[0] | null = null;
  loseToolAck = false;
  setProjectHandler(handler: Parameters<NonNullable<CodexPort['setProjectHandler']>>[0]): void { this.projectHandler = handler; }
  async projectAction(threadId: string, action: ProjectAction): Promise<unknown> {
    const snapshot = this.snapshot(threadId);
    assert.ok(this.projectHandler && snapshot.turnId);
    const result = await this.projectHandler({ threadId, turnId: snapshot.turnId, connectionEpoch: 'fake-epoch',
      callId: 'requestId' in action ? action.requestId : action.action, call: { tool: 'project_action', arguments: action } });
    if (this.loseToolAck) { this.loseToolAck = false; throw new UncertainOperationError('Tool accepted; acknowledgement lost'); }
    return result;
  }
}

async function fixture(t: TestContext, secondProject = false) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 20) });
  const root = await mkdtemp(join(tmpdir(), 'agent-reminders-'));
  const directory = await realpath(root);
  const config = configSchema.parse({ execution: testExecution, dataDir: root, feishu: { userOpenId: 'owner' },
    projects: [{ id: 'app', name: 'Application', directory, repositories: [] },
      ...(secondProject ? [{ id: 'docs', name: 'Documentation', directory, repositories: [] }] : [])] });
  const codex = new ReminderCodexFake(), feishu = new FeishuFake();
  const ports = { codex, feishu, github: new GitHubFake(), workspace: {
    async ensure(): Promise<string> { throw new Error('This reminder fixture does not allocate workspaces'); },
    async head() { return 'fixture-head'; },
  } };
  let loop = new AgentLoop(config, ports, new Store(root));
  t.after(async () => { await loop.close(); t.mock.timers.reset(); await rm(root, { recursive: true, force: true }); });
  await loop.projects.ensure(); await loop.tick();
  const coordinator = (projectId = 'app') => {
    const project = loop.projects.ledger.project(projectId); assert.ok(project);
    return loop.store.task(project.coordinatorTaskId);
  };
  const action = async (taskId: string, action: ProjectAction) => {
    const task = loop.store.task(taskId); assert.ok(task.threadId);
    return codex.projectAction(task.threadId, action);
  };
  return { root, config, codex, feishu, coordinator, action,
    get loop() { return loop; },
    async dispatch(requestId = 'worker') {
      const result = z.object({ taskId: z.string() }).parse(await action(coordinator().id, {
        action: 'dispatch', requestId, prompt: 'Wait for the agreed follow-up.', role: 'worker', execution: testExecution.worker,
      }));
      await loop.tick();
      const worker = loop.store.task(result.taskId); assert.ok(worker.threadId);
      assert.equal(worker.status, 'running');
      return worker;
    },
    async schedule(taskId: string, requestId: string, dueAt: number, text = 'Check the pending review.') {
      return receiptSchema.parse(await action(taskId, { action: 'schedule_reminder', requestId, dueAt, text })).reminder;
    },
    async list(taskId: string, page: { offset?: number; limit?: number } = {}) {
      return pageSchema.parse(await loop.projectAction(taskId, { action: 'list_reminders', ...page }));
    },
    inputs(taskId: string) { return loop.store.inputs(taskId).filter(input => input.provenance.kind === 'reminder'); },
    deliveries(inputId: string) {
      return codex.starts.filter(input => input.deliveryId === inputId || input.additionalDeliveryIds?.includes(inputId)).length
        + codex.steers.filter(input => input.deliveryId === inputId).length;
    },
    async restart() { await loop.close(); loop = new AgentLoop(config, ports, new Store(root)); await loop.recover(); },
  };
}

for (const role of ['coordinator', 'worker'] as const) for (const running of [false, true]) {
  test(`${role} self-reminder ${running ? 'steers its running turn' : 'starts its idle original Thread'} once`, async t => {
    const f = await fixture(t);
    const caller = role === 'worker' ? await f.dispatch() : f.coordinator();
    assert.ok(caller.threadId);
    const dueAt = Date.now() + 1_000, text = 'Recheck review 42 and decide the next step.';
    const reminder = await f.schedule(caller.id, 'review-follow-up', dueAt, text);
    assert.equal(reminder.status, 'scheduled');
    assert.equal(reminder.taskId, caller.id); assert.equal(reminder.projectId, 'app');
    assert.deepEqual((await f.list(caller.id)).reminders, [reminder]);
    if (!running) { f.codex.complete(caller.threadId, null); await f.loop.tick(); }
    const starts = f.codex.starts.length, steers = f.codex.steers.length, groups = f.feishu.groups.size;
    t.mock.timers.setTime(dueAt - 1); await f.loop.tick();
    assert.deepEqual(f.inputs(caller.id), []);
    assert.equal(f.codex.starts.length, starts); assert.equal(f.codex.steers.length, steers);
    t.mock.timers.setTime(dueAt); await f.loop.tick(); await f.loop.tick();
    const inputs = f.inputs(caller.id); assert.equal(inputs.length, 1);
    const input = inputs[0]; assert.ok(input);
    assert.equal(input.status, 'delivered');
    assert.deepEqual(input.provenance, { kind: 'reminder', projectId: 'app', taskId: caller.id, reminderId: reminder.id, dueAt });
    assert.equal(f.deliveries(input.id), 1);
    const delivered = [...f.codex.starts, ...f.codex.steers].find(delivery => delivery.deliveryId === input.id);
    assert.ok(delivered); assert.equal(delivered.threadId, caller.threadId);
    assert.ok(delivered.input.some(part => part.kind === 'text' && part.text.includes(text)));
    assert.equal(f.codex.starts.length, starts + Number(!running));
    assert.equal(f.codex.steers.length, steers + Number(running));
    assert.equal(f.loop.store.task(caller.id).threadId, caller.threadId);
    assert.equal(f.feishu.groups.size, groups);
    const retry = await f.schedule(caller.id, 'review-follow-up', dueAt, text);
    assert.equal(retry.id, reminder.id); assert.equal(retry.status, 'fired');
    t.mock.timers.setTime(dueAt + 100_000); await f.loop.tick();
    assert.equal(f.deliveries(input.id), 1); assert.equal((await f.list(caller.id)).total, 1);
  });
}

test('cancel wins before a due scan and fire wins before cancellation without withdrawing its input', async t => {
  const f = await fixture(t), caller = f.coordinator().id, dueAt = Date.now() + 1_000;
  const before = await f.schedule(caller, 'before', dueAt);
  const overdue = await f.schedule(caller, 'overdue', dueAt);
  const fired = await f.schedule(caller, 'fired', dueAt);
  const cancel = async (requestId: string, reminderId: string) => receiptSchema.parse(await f.action(caller, {
    action: 'cancel_reminder', requestId, reminderId,
  })).reminder;
  assert.equal((await cancel('cancel-before', before.id)).status, 'cancelled');
  t.mock.timers.setTime(dueAt + 1);
  assert.equal((await cancel('cancel-overdue', overdue.id)).status, 'cancelled');
  await f.loop.tick();
  const result = await cancel('cancel-fired', fired.id);
  assert.equal(result.status, 'fired');
  assert.deepEqual(await cancel('cancel-fired', fired.id), result);
  assert.equal((await f.schedule(caller, 'before', dueAt)).status, 'cancelled');
  await f.loop.tick(); await f.restart();
  const inputs = f.inputs(caller); assert.equal(inputs.length, 1); assert.ok(inputs[0]);
  assert.equal(inputs[0].status, 'delivered'); assert.equal(f.deliveries(inputs[0].id), 1);
  assert.deepEqual((await f.list(caller)).reminders.map(item => item.status).sort(), ['cancelled', 'cancelled', 'fired']);
});

test('lost scheduling receipt retries recover the original reminder and its current status across restart', async t => {
  const f = await fixture(t), worker = await f.dispatch(), dueAt = Date.now() + 1_000;
  f.codex.loseToolAck = true;
  await assert.rejects(f.schedule(worker.id, 'lost-receipt', dueAt), UncertainOperationError);
  const first = (await f.list(worker.id)).reminders[0]; assert.ok(first);
  await f.restart();
  assert.deepEqual(await f.schedule(worker.id, 'lost-receipt', dueAt), first);
  await assert.rejects(f.schedule(worker.id, 'lost-receipt', dueAt + 1), /different content/);
  await assert.rejects(f.schedule(worker.id, 'lost-receipt', dueAt, 'Changed reminder'), /different content/);
  t.mock.timers.setTime(dueAt); await f.restart(); await f.loop.tick();
  const retry = await f.schedule(worker.id, 'lost-receipt', dueAt);
  assert.equal(retry.id, first.id); assert.equal(retry.status, 'fired');
  assert.equal((await f.list(worker.id)).total, 1);
  const inputs = f.inputs(worker.id); assert.equal(inputs.length, 1); assert.ok(inputs[0]);
  assert.equal(inputs[0].status, 'delivered'); assert.equal(f.deliveries(inputs[0].id), 1);
});

test('a fired reminder pending at process exit delivers exactly once after recovery', async t => {
  const f = await fixture(t), worker = await f.dispatch(), dueAt = Date.now() + 1_000;
  assert.ok(worker.threadId);
  const reminder = await f.schedule(worker.id, 'committed-before-exit', dueAt);
  f.codex.complete(worker.threadId, null); await f.loop.tick();
  t.mock.timers.setTime(dueAt);
  f.loop.store.fireDueReminders(Date.now());
  assert.equal((await f.list(worker.id)).reminders[0]?.status, 'fired');
  const input = f.inputs(worker.id)[0]; assert.ok(input);
  assert.equal(input.status, 'pending'); assert.equal(f.deliveries(input.id), 0);
  await f.restart(); await f.loop.tick(); await f.restart();
  assert.equal(f.inputs(worker.id).length, 1);
  assert.equal(f.inputs(worker.id)[0]?.status, 'delivered'); assert.equal(f.deliveries(input.id), 1);
  assert.equal(f.loop.store.task(worker.id).threadId, worker.threadId);
  assert.equal((await f.list(worker.id)).reminders[0]?.id, reminder.id);
});

test('a reminder delivered with a lost backend acknowledgement reconciles without another delivery after restart', async t => {
  const f = await fixture(t), worker = await f.dispatch();
  await f.schedule(worker.id, 'lost-input-receipt', Date.now());
  f.codex.loseInputAck = true; await f.loop.tick();
  const input = f.inputs(worker.id)[0]; assert.ok(input);
  assert.equal(input.status, 'uncertain'); assert.equal(f.deliveries(input.id), 1);
  await f.restart(); await f.loop.tick();
  assert.equal(f.inputs(worker.id)[0]?.status, 'delivered'); assert.equal(f.deliveries(input.id), 1);
});

test('paused tasks retain due reminders through restart until an explicit resume', async t => {
  const f = await fixture(t), worker = await f.dispatch(), dueAt = Date.now() + 1_000;
  await f.schedule(worker.id, 'paused-follow-up', dueAt);
  await f.loop.control(worker.id, 'pause');
  t.mock.timers.setTime(dueAt); await f.restart(); await f.loop.tick();
  const input = f.inputs(worker.id)[0]; assert.ok(input);
  assert.equal(f.loop.store.task(worker.id).status, 'paused');
  assert.equal(input.status, 'held'); assert.equal(f.deliveries(input.id), 0);
  assert.equal((await f.list(worker.id)).reminders[0]?.status, 'fired');
  await f.loop.control(worker.id, 'resume'); await f.loop.tick();
  assert.equal(f.loop.store.task(worker.id).status, 'running');
  assert.equal(f.inputs(worker.id)[0]?.status, 'delivered'); assert.equal(f.deliveries(input.id), 1);
  await f.restart(); assert.equal(f.deliveries(input.id), 1);
});

test('reminders are owner-only, paginated, and validate safe supported epoch milliseconds', async t => {
  const f = await fixture(t, true), worker = await f.dispatch(), caller = f.coordinator().id;
  for (const dueAt of [NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(f.action(caller, { action: 'schedule_reminder', requestId: 'invalid-time', dueAt, text: 'Wait.' }));
  }
  assert.equal((await f.list(caller)).total, 0);
  const workerReminder = await f.schedule(worker.id, 'owner-only', Date.now() + 10_000);
  assert.deepEqual((await f.list(caller)).reminders, []);
  assert.deepEqual((await f.list(f.coordinator('docs').id)).reminders, []);
  for (const other of [caller, f.coordinator('docs').id]) await assert.rejects(f.action(other, {
    action: 'cancel_reminder', requestId: 'foreign-cancel', reminderId: workerReminder.id,
  }), /Unknown reminder/);
  const low = await f.schedule(caller, 'low', -8_640_000_000_000_000);
  const mid = await f.schedule(caller, 'mid', 0);
  const high = await f.schedule(caller, 'high', 8_640_000_000_000_000);
  const page = await f.list(caller, { limit: 2 });
  assert.deepEqual(page.reminders.map(item => item.id), [low.id, mid.id]);
  assert.equal(page.total, 3); assert.equal(page.nextOffset, 2);
  const last = await f.list(caller, { offset: 2, limit: 2 });
  assert.deepEqual(last.reminders.map(item => item.id), [high.id]); assert.equal(last.nextOffset, null);
  await assert.rejects(f.action(caller, { action: 'list_reminders', limit: 101 }));
  await assert.rejects(f.action(caller, { action: 'list_reminders', offset: -1 }));
  assert.ok(f.codex.projectHandler && worker.threadId);
  const snapshot = f.codex.snapshot(worker.threadId); assert.ok(snapshot.turnId);
  await assert.rejects(f.codex.projectHandler({ threadId: worker.threadId, turnId: snapshot.turnId, connectionEpoch: 'stale-epoch',
    callId: 'stale-schedule', call: { tool: 'project_action', arguments: { action: 'schedule_reminder', requestId: 'stale-schedule', dueAt: 0, text: 'Wait.' } } }), /active/);
  await f.loop.tick();
  assert.equal(f.inputs(caller).length, 2);
  assert.equal((await f.list(caller)).reminders.find(item => item.id === high.id)?.status, 'scheduled');
});

test('a database failure rolls back both reminder firing and its inbox input', async t => {
  const f = await fixture(t), caller = f.coordinator().id;
  await f.schedule(caller, 'atomic-fire', Date.now());
  const database = new DatabaseSync(join(f.root, 'tasks.sqlite'));
  t.after(() => database.close());
  database.exec("CREATE TRIGGER fail_reminder_fire BEFORE UPDATE OF status ON reminders WHEN NEW.status='fired' BEGIN SELECT RAISE(ABORT,'injected database failure'); END");
  assert.throws(() => f.loop.store.fireDueReminders(Date.now()), /injected database failure/);
  assert.deepEqual(f.inputs(caller), []); assert.equal((await f.list(caller)).reminders[0]?.status, 'scheduled');
  database.exec('DROP TRIGGER fail_reminder_fire');
  await f.loop.tick(); await f.loop.tick();
  const inputs = f.inputs(caller); assert.equal(inputs.length, 1); assert.ok(inputs[0]);
  assert.equal(f.deliveries(inputs[0].id), 1); assert.equal((await f.list(caller)).reminders[0]?.status, 'fired');
});

test('no scheduled reminders create no timed execution input or supervisor turn', async t => {
  const f = await fixture(t), worker = await f.dispatch();
  for (const task of [f.coordinator(), worker]) { assert.ok(task.threadId); f.codex.complete(task.threadId, null); }
  await f.loop.tick();
  const starts = f.codex.starts.length, steers = f.codex.steers.length;
  t.mock.timers.setTime(Date.now() + 30 * 24 * 60 * 60 * 1_000);
  await f.loop.tick(); await f.restart(); await f.loop.tick();
  assert.equal(f.codex.starts.length, starts); assert.equal(f.codex.steers.length, steers);
  assert.deepEqual(f.inputs(f.coordinator().id), []); assert.deepEqual(f.inputs(worker.id), []);
  assert.equal((await f.list(worker.id)).total, 0);
});
