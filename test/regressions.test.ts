import { testExecution } from './test-config.js';
import { tickWithDirectGroups, workerCalls } from './coordinated-runtime.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { configSchema } from '../src/config.js';
import { RejectedInputError, type IncomingMessage } from '../src/domain.js';
import { AgentLoop } from '../src/loop.js';
import { WorkspaceProvider } from '../src/workspace.js';
import { type LegacyReport, CodexFake, FeishuFake, GitHubFake, issue } from './fakes.js';

const execute = promisify(execFile);
const waiting: LegacyReport = {
  status: 'waiting_user', summary: 'Reproduction confirmed', question: 'May I fix it?',
  prUrl: null, validation: ['Reproduced'], limitations: [],
};

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-regression-'));
  const repository = join(root, 'repository');
  await mkdir(repository);
  for (const args of [
    ['init', '-b', 'main'], ['config', 'user.name', 'Regression Test'],
    ['config', 'user.email', 'test@example.invalid'],
  ]) await execute('git', ['-C', repository, ...args]);
  await writeFile(join(repository, 'tracked.txt'), 'fixture\n');
  await execute('git', ['-C', repository, 'add', 'tracked.txt']);
  await execute('git', ['-C', repository, 'commit', '-m', 'Fixture']);
  await writeFile(join(root, 'prompt.md'), 'Continue authorized work and ask about unresolved decisions.');
  await writeFile(join(root, 'SKILL.md'), '# poteto-mode\nFollow the task prompt.\n');
  const config = configSchema.parse({ execution: testExecution,
    dataDir: join(root, 'data'),
    repositories: [{ name: 'example/project', path: repository, baseBranch: 'main', criteria: { assigneesAny: ['developer'] } }],
    engineering: { promptPath: join(root, 'prompt.md'), skillPath: join(root, 'SKILL.md') },
    feishu: { userOpenId: 'ou_owner' }, pollIntervalMs: 3_600_000, executionPollMs: 3_600_000,
  });
  const github = new GitHubFake();
  const feishu = new FeishuFake();
  const codex = new CodexFake();
  const loop = new AgentLoop(config, { github, feishu, codex, workspace: new WorkspaceProvider(config.dataDir) });
  let closed = false;
  async function close() { closed = true; await loop.close(); }
  t.after(async () => {
    try { if (!closed) await close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  function task() {
    const current = loop.tasks()[0];
    assert.ok(current);
    return current;
  }
  function thread() { const id = task().threadId; assert.ok(id); return id; }
  return {
    loop, config, github, feishu, codex, task, thread, close,
    async launch() { github.sources = [issue(1)]; await loop.collect(); await tickWithDirectGroups(loop); },
    message(id: string, text: string): IncomingMessage {
      const chatId = task().chatId;
      assert.ok(chatId);
      return { id, chatId, senderId: 'ou_owner', text, attachments: [], createdAt: Date.now(), chatType: 'group' };
    },
  };
}

test('a rejected native answer leaves the question answerable and does not block later feedback', async t => {
  const f = await fixture(t);
  await f.launch();
  const snapshot = f.codex.snapshot(f.thread());
  assert.ok(snapshot.turnId);
  snapshot.requests = [{
    id: 'question-1', threadId: f.thread(), turnId: snapshot.turnId, kind: 'question', isBlocking: true, connectionEpoch: 'epoch',
    prompt: 'Provide both device and version', method: 'item/tool/requestUserInput',
    payload: { questions: [{ id: 'device' }, { id: 'version' }] },
  }];
  const reply = f.codex.reply.bind(f.codex);
  f.codex.reply = async input => {
    if (input.text === 'incomplete') throw new RejectedInputError('Both answer fields are required');
    await reply(input);
  };
  await tickWithDirectGroups(f.loop);
  await f.loop.receive(f.message('bad-answer', 'incomplete'));
  assert.equal(workerCalls(f.loop, f.codex).replies.length, 0);
  assert.equal(f.task().status, 'running');
  assert.equal(snapshot.requests.length, 1);
  assert.ok(f.feishu.sent.some(message => message.text.includes('Both answer fields are required')));

  const answer = '{"device":"C5010","version":"3"}';
  await f.loop.receive(f.message('correct-answer', answer));
  await f.loop.receive(f.message('follow-up', 'The original reproduction also includes this log.'));
  assert.deepEqual(workerCalls(f.loop, f.codex).replies.map(input => [input.request.id, input.text]), [['question-1', answer]]);
  assert.deepEqual(workerCalls(f.loop, f.codex).steers.map(input => input.deliveryId), ['follow-up']);
  assert.equal(f.task().status, 'running');
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 1);
});

test('a source update queued before completion cannot answer the completed turn on behalf of the user', async t => {
  const f = await fixture(t);
  await f.launch();
  f.github.sources = [issue(1, { body: 'Additional reproduction details' })];
  await f.loop.collect();
  f.codex.complete(f.thread(), waiting);
  await tickWithDirectGroups(f.loop);
  await tickWithDirectGroups(f.loop);

  assert.equal(f.task().status, 'idle');
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 1);
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 0);
  assert.equal(workerCalls(f.loop, f.codex).replies.length, 0);
  await f.loop.receive(f.message('explicit-answer', 'Confirmed, proceed with the fix.'));
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 2);
  assert.equal(workerCalls(f.loop, f.codex).starts.at(-1)?.deliveryId, 'explicit-answer');
});

test('a source update racing with turn completion starts once without manufacturing a user answer', async t => {
  const f = await fixture(t);
  await f.launch();
  f.github.sources = [issue(1, { body: 'Evidence arrived just as the agent finished' })];
  await f.loop.collect();
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 0);
  f.codex.raceOnSteer = true;
  await f.loop.receive(f.message('owner-race', 'Use the additional evidence.'));
  await tickWithDirectGroups(f.loop);

  assert.equal(f.task().status, 'running');
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 2);
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 0);
  assert.equal(workerCalls(f.loop, f.codex).replies.length, 0);
});

test('periodic collection recovers history-only messages after a connection gap without restarting', async t => {
  const f = await fixture(t);
  await f.launch();
  await f.loop.start();
  const message = f.message('connection-gap', 'Feedback sent while the connection was unavailable.');
  f.feishu.offline = [message];
  f.feishu.historyError = new Error('Temporary history failure');
  await f.loop.collect();
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 0);

  f.feishu.historyError = null;
  await f.loop.collect();
  await tickWithDirectGroups(f.loop);
  await f.loop.collect();
  assert.ok(f.feishu.receiver);
  await f.feishu.receiver(message);
  assert.deepEqual(workerCalls(f.loop, f.codex).steers.map(input => input.deliveryId), ['connection-gap']);
  assert.equal(workerCalls(f.loop, f.codex).created.length, 1);
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 1);
  assert.equal(f.task().status, 'running');
});

test('Feishu reconnect requests one coalesced backfill while the runtime is ready', async t => {
  const f = await fixture(t);
  await f.launch();
  await f.loop.start();
  const before = f.feishu.historyCalls;
  const message = f.message('reconnect-history', 'Recovered after reconnect.');
  f.feishu.offline = [message];
  assert.ok(f.feishu.reconnect);
  f.feishu.reconnect?.({ state: 'reconnected', attempt: 1 });
  f.feishu.reconnect?.({ state: 'reconnected', attempt: 2 });
  await setTimeout(10);
  assert.equal(f.feishu.historyCalls, before + f.loop.tasks().filter(task => task.chatId).length);
  assert.equal(f.loop.store.inputs(f.task().id).some(input => input.id === message.id), true);
});

test('slow Feishu history fetch does not block a live owner message', async t => {
  const f = await fixture(t);
  await f.launch();
  await f.loop.start();
  const entered = gate();
  const release = gate();
  const history = f.feishu.history.bind(f.feishu);
  f.feishu.history = async input => { entered.resolve(); await release.promise; return history(input); };
  const collecting = f.loop.collect();
  await entered.promise;
  const message = f.message('live-during-history', 'Live owner input.');
  await f.loop.receive(message);
  assert.equal(workerCalls(f.loop, f.codex).steers.at(-1)?.deliveryId, message.id);
  release.resolve();
  await collecting;
});

test('history failure notices are delayed, coalesced, and clear with one recovery notice', async t => {
  const f = await fixture(t);
  await f.launch();
  await f.loop.start();
  f.feishu.historyError = new Error('first private failure');
  await f.loop.collect();
  assert.equal(f.feishu.sent.filter(message => message.text.includes('离线消息补偿暂时失败')).length, 0);
  await f.loop.collect();
  assert.equal(f.feishu.sent.filter(message => message.text.includes('离线消息补偿暂时失败')).length, f.loop.tasks().filter(task => task.chatId).length);
  f.feishu.historyError = null;
  await f.loop.collect();
  await f.loop.collect();
  assert.equal(f.feishu.sent.filter(message => message.text.includes('离线消息补偿已恢复')).length, f.loop.tasks().filter(task => task.chatId).length);
  assert.equal(f.loop.store.meta(`history-failure:${f.task().id}`), JSON.stringify({ attempts: 0, noticeSent: false }));
});

test('messages received during startup persist until recovery verifies the task', async t => {
  const f = await fixture(t);
  await f.launch();
  const entered = gate();
  const release = gate();
  f.feishu.start = async receiver => {
    f.feishu.receiver = receiver;
    entered.resolve();
    await release.promise;
  };
  const starting = f.loop.start();
  try {
    await entered.promise;
    assert.ok(f.feishu.receiver);
    await f.feishu.receiver(f.message('during-startup', 'Feedback received before recovery.'));
    assert.equal(f.loop.store.inputs(f.task().id).find(input => input.id === 'during-startup')?.status, 'pending');
    assert.equal(workerCalls(f.loop, f.codex).steers.length, 0);
    f.github.sources = [issue(1, { state: 'closed' })];
  } finally {
    release.resolve();
    await starting;
  }
  assert.equal(f.task().status, 'running');
  assert.equal(workerCalls(f.loop, f.codex).steers.filter(input => input.deliveryId === 'during-startup').length, 1);
  assert.equal(f.loop.store.inputs(f.task().id).find(input => input.id === 'during-startup')?.status, 'delivered');
});

test('overlapping starts open only one message receiver and launch each task once', async t => {
  const f = await fixture(t);
  f.github.sources = [issue(1)];
  const entered = gate();
  const release = gate();
  let starts = 0;
  f.feishu.start = async receiver => {
    starts++;
    f.feishu.receiver = receiver;
    entered.resolve();
    await release.promise;
  };
  const first = f.loop.start();
  await entered.promise;
  const second = f.loop.start();
  release.resolve();
  await Promise.all([first, second]);
  await tickWithDirectGroups(f.loop);
  assert.equal(starts, 1);
  assert.equal(workerCalls(f.loop, f.codex).created.length, 1);
  assert.equal(workerCalls(f.loop, f.codex).starts.length, 1, JSON.stringify(f.loop.tasks().map(task => ({ id: task.id, status: task.status,
    execution: task.executionStatus, reason: task.reason, inputs: f.loop.store.inputs(task.id).map(input => [input.status, input.error]) }))));
});

test('repeated close safely releases the same service resources once', async t => {
  const f = await fixture(t);
  let feishuCloses = 0;
  let codexCloses = 0;
  f.feishu.close = async () => { feishuCloses++; f.feishu.receiver = null; };
  f.codex.close = async () => { codexCloses++; };
  await f.loop.start();
  await Promise.all([f.close(), f.close()]);
  await f.loop.close();
  assert.equal(feishuCloses, 1);
  assert.equal(codexCloses, 1);
});

test('close during startup waits for initialization before releasing the database and transports', async t => {
  const f = await fixture(t);
  const entered = gate();
  const release = gate();
  f.feishu.start = async receiver => {
    entered.resolve();
    await release.promise;
    f.feishu.receiver = receiver;
  };
  const starting = f.loop.start();
  await entered.promise;
  const closing = f.close();
  release.resolve();
  await Promise.all([starting, closing]);
  assert.equal(f.feishu.receiver, null);
  assert.equal(f.codex.created.length, 0);
});

for (const previous of ['running', 'waiting_user', 'paused'] as const) {
  test(`restart with an authoritatively interrupted turn preserves ${previous} policy`, async t => {
    const f = await fixture(t);
    await f.launch();
    const threadId = f.thread();
    if (previous === 'waiting_user') {
      const snapshot = f.codex.snapshot(threadId);
      assert.ok(snapshot.turnId);
      snapshot.requests = [{ id: 'old-request', threadId, turnId: snapshot.turnId, kind: 'question', isBlocking: true, connectionEpoch: 'epoch', prompt: 'Need input', method: 'item/tool/requestUserInput', payload: {} }];
      await tickWithDirectGroups(f.loop);
    }
    if (previous === 'paused') await f.loop.control(f.task().id, 'pause');
    const taskId = f.task().id;
    await f.close();
    const remote = structuredClone(f.codex.snapshot(threadId));
    remote.status = 'interrupted'; remote.requests = []; remote.error = null;
    const replacement = new CodexFake();
    replacement.threads.set(threadId, remote);
    const restored = new AgentLoop(f.config, { github: f.github, feishu: f.feishu, codex: replacement, workspace: new WorkspaceProvider(f.config.dataDir) });
    try {
      await restored.recover();
      assert.equal(restored.tasks()[0]?.id, taskId);
      assert.equal(restored.tasks()[0]?.threadId, threadId);
      if (previous === 'running') { await setTimeout(f.config.recovery.retryDelayMs + 5); await restored.tick(); }
      assert.equal(restored.tasks()[0]?.status, previous === 'waiting_user' ? 'idle' : previous);
      assert.equal(replacement.created.length, 0);
      assert.equal(replacement.starts.length, previous === 'running' ? 1 : 0);
      await restored.recover();
      assert.equal(replacement.starts.length, previous === 'running' ? 1 : 0);
    } finally { await restored.close(); }
  });
}
