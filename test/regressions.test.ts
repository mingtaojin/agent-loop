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
  assert.equal(f.feishu.sent.filter(message => message.text.includes('飞书历史消息暂时拉取失败')).length, 0);
  await f.loop.collect();
  const outageNotices = f.feishu.sent.filter(message => message.text.includes('飞书历史消息暂时拉取失败'));
  assert.equal(outageNotices.length, f.loop.tasks().filter(task => task.chatId).length);
  assert.match(outageNotices[0]?.text ?? '', /与代码提交、push 等操作无关/);
  assert.doesNotMatch(outageNotices[0]?.text ?? '', /first private failure/);
  f.feishu.historyError = null;
  await f.loop.collect();
  await f.loop.collect();
  assert.equal(f.feishu.sent.filter(message => message.text.includes('飞书历史消息已恢复拉取')).length, f.loop.tasks().filter(task => task.chatId).length);
  assert.equal(f.loop.store.meta(`history-failure:${f.task().id}`), null);
});

test('a single history failure that recovers on the next poll stays out of the task group', async t => {
  const f = await fixture(t);
  await f.launch();
  await f.loop.start();
  const chatId = f.task().chatId;
  assert.ok(chatId);
  const sentForTask = () => f.feishu.sent.filter(message => message.chatId === chatId);
  const before = sentForTask().length;
  f.feishu.historyError = new Error('Request failed with status code 500');
  await f.loop.collect();
  f.feishu.historyError = null;
  await f.loop.collect();
  await f.loop.tick();
  assert.deepEqual(sentForTask().slice(before).map(message => message.text), []);
  assert.ok(f.loop.store.diagnostics().some(row => row.scope === `history:${f.task().id}` && row.message === 'Request failed with status code 500'));
});

test('persistent history failures send one plain notice, then a recovery notice without skipping or repeating messages', async t => {
  const f = await fixture(t);
  await f.launch();
  await f.loop.start();
  const missed = f.message('missed-during-outage', 'Feedback sent while history was failing.');
  f.feishu.offline = [missed];
  for (const error of ['Request failed with status code 500', 'timeout of 30000ms exceeded', 'write EPIPE', 'Request failed with status code 500']) {
    f.feishu.historyError = new Error(error);
    await f.loop.collect();
    await f.loop.tick();
  }
  const chatId = f.task().chatId;
  assert.ok(chatId);
  const sentForTask = () => f.feishu.sent.filter(message => message.chatId === chatId);
  const firstNotice = sentForTask().findIndex(message => message.text.includes('飞书历史消息暂时拉取失败'));
  assert.ok(firstNotice >= 0);
  const outage = sentForTask().slice(firstNotice).map(message => message.text);
  assert.equal(outage.length, 1, 'one notice per outage, whatever the raw errors');
  assert.equal(outage[0], [
    '飞书历史消息暂时拉取失败，正在自动重试。',
    '这一步只用于补收可能漏掉的群消息，与代码提交、push 等操作无关，不影响已回复的结果。',
    '目前没有确认丢失消息。如果你最近发的消息没有回应，可能是还没收到，恢复后会自动补上处理，不用重发。恢复后会在本群告知。',
  ].join('\n'));
  assert.doesNotMatch(outage[0]!, /status code|timeout|EPIPE|缺口/);
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 0);
  const raw = f.loop.store.diagnostics().filter(row => row.scope === `history:${f.task().id}`).map(row => row.message);
  assert.ok(raw.includes('Request failed with status code 500') && raw.includes('write EPIPE'), 'raw errors remain for maintainers');

  f.feishu.historyError = null;
  await f.loop.collect();
  await f.loop.tick();
  const recovery = sentForTask().slice(-1).map(message => message.text);
  assert.deepEqual(recovery, ['飞书历史消息已恢复拉取，补收到 1 条之前没收到的消息，会按顺序处理。']);
  assert.deepEqual(workerCalls(f.loop, f.codex).steers.map(input => input.deliveryId), ['missed-during-outage']);

  assert.ok(f.feishu.receiver);
  await f.feishu.receiver(missed);
  await f.loop.collect();
  await f.loop.tick();
  assert.deepEqual(workerCalls(f.loop, f.codex).steers.map(input => input.deliveryId), ['missed-during-outage'], 'live replay and later backfill do not repeat the message');
  assert.equal(sentForTask().filter(message => message.text.includes('飞书历史消息')).length, 2);

  f.feishu.historyError = new Error('timeout of 30000ms exceeded');
  await f.loop.collect();
  await f.loop.collect();
  f.feishu.historyError = null;
  await f.loop.collect();
  assert.deepEqual(sentForTask().slice(-2).map(message => message.text.split('\n')[0]),
    ['飞书历史消息暂时拉取失败，正在自动重试。', '飞书历史消息已恢复拉取，核对后没有漏收的消息。'], 'a later outage is announced again');
});

test('a history outage spanning a restart is announced once and its recovery is announced after restart', async t => {
  const f = await fixture(t);
  await f.launch();
  await f.loop.start();
  const chatId = f.task().chatId;
  assert.ok(chatId);
  const sentForTask = () => f.feishu.sent.filter(message => message.chatId === chatId);
  const before = sentForTask().length;
  f.feishu.historyError = new Error('Request failed with status code 500');
  await f.loop.collect();
  await f.loop.collect();
  await f.close();
  const restarted = new AgentLoop(f.config, { github: f.github, feishu: f.feishu, codex: f.codex, workspace: new WorkspaceProvider(f.config.dataDir) });
  t.after(() => restarted.close());
  await restarted.recover();
  assert.equal(sentForTask().length, before + 1, 'restart during the same outage does not repeat the notice');
  f.feishu.historyError = null;
  await restarted.start();
  await restarted.collect();
  assert.equal(sentForTask().at(-1)?.text, '飞书历史消息已恢复拉取，核对后没有漏收的消息。');
  assert.equal(sentForTask().length, before + 2);
});

test('history episodes keep distinct notice identities when failures share a timestamp', async t => {
  const f = await fixture(t);
  await f.launch();
  await f.loop.start();
  const chatId = f.task().chatId;
  assert.ok(chatId);
  const sentForTask = () => f.feishu.sent.filter(message => message.chatId === chatId);
  const before = sentForTask().length;
  const now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  for (let episode = 0; episode < 2; episode++) {
    f.feishu.historyError = new Error(`history episode ${episode}`);
    await f.loop.collect();
    await f.loop.collect();
    f.feishu.historyError = null;
    await f.loop.collect();
  }
  const historyMessages = sentForTask().slice(before).filter(message => message.text.startsWith('飞书历史消息'));
  assert.deepEqual(historyMessages.map(message => message.text.split('\n')[0]), [
    '飞书历史消息暂时拉取失败，正在自动重试。',
    '飞书历史消息已恢复拉取，核对后没有漏收的消息。',
    '飞书历史消息暂时拉取失败，正在自动重试。',
    '飞书历史消息已恢复拉取，核对后没有漏收的消息。',
  ]);
});

test('a cursor write failure preserves history messages for the recovery count', async t => {
  const f = await fixture(t);
  await f.launch();
  await f.loop.start();
  const chatId = f.task().chatId;
  assert.ok(chatId);
  const sentForTask = () => f.feishu.sent.filter(message => message.chatId === chatId);
  const before = sentForTask().length;
  f.feishu.historyError = new Error('history unavailable');
  await f.loop.collect();
  await f.loop.collect();
  f.feishu.historyError = null;
  const missed = f.message('cursor-write-message', 'Recovered after cursor persistence failed.');
  f.feishu.offline = [missed];
  const setMeta = f.loop.store.setMeta.bind(f.loop.store);
  let failCursor = true;
  f.loop.store.setMeta = (key, value) => {
    if (failCursor && key === `history:${f.task().id}`) { failCursor = false; throw new Error('database is locked'); }
    setMeta(key, value);
  };
  await f.loop.collect();
  await f.loop.collect();
  await f.loop.tick();
  const recovery = sentForTask().slice(before).filter(message => message.text.startsWith('飞书历史消息已恢复拉取'));
  assert.deepEqual(recovery.map(message => message.text), ['飞书历史消息已恢复拉取，补收到 1 条之前没收到的消息，会按顺序处理。']);
  assert.deepEqual(workerCalls(f.loop, f.codex).steers.map(input => input.deliveryId).filter(id => id === missed.id), [missed.id]);
  assert.equal(f.loop.store.meta(`history-failure:${f.task().id}`), null);
});

test('live and history delivery of the same message steer the task once in either order', async t => {
  const f = await fixture(t);
  await f.launch();
  await f.loop.start();
  assert.ok(f.feishu.receiver);
  const liveFirst = f.message('live-first', 'Live delivery wins.');
  f.feishu.offline = [liveFirst];
  await f.feishu.receiver(liveFirst);
  await f.loop.collect();
  await f.loop.tick();
  const historyFirst = f.message('history-first', 'History delivery wins.');
  f.feishu.offline = [historyFirst];
  await f.loop.collect();
  await f.loop.tick();
  await f.feishu.receiver(historyFirst);
  await f.loop.tick();
  const steers = workerCalls(f.loop, f.codex).steers.map(input => input.deliveryId);
  assert.equal(steers.filter(id => id === liveFirst.id).length, 1);
  assert.equal(steers.filter(id => id === historyFirst.id).length, 1);
});

test('history failure episodes stay isolated per task', async t => {
  const f = await fixture(t);
  await f.launch();
  await f.loop.start();
  const tasks = f.loop.tasks().filter(task => task.chatId);
  assert.ok(tasks.length >= 2);
  const [isolated, healthy] = tasks;
  assert.ok(isolated?.chatId && healthy?.chatId);
  const history = f.feishu.history.bind(f.feishu);
  let failIsolated = true;
  f.feishu.history = async input => {
    if (failIsolated && input.chatId === isolated.chatId) throw new Error('isolated history outage');
    return history(input);
  };
  const messages = (chatId: string) => f.feishu.sent.filter(message => message.chatId === chatId && message.text.startsWith('飞书历史消息'));
  await f.loop.collect();
  await f.loop.collect();
  assert.equal(messages(isolated.chatId).length, 1);
  assert.equal(messages(healthy.chatId).length, 0);
  failIsolated = false;
  await f.loop.collect();
  assert.equal(messages(isolated.chatId).length, 2);
  assert.equal(messages(healthy.chatId).length, 0);
});

test('legacy history failure metadata is normalized into the current episode shape', async t => {
  const f = await fixture(t);
  await f.launch();
  await f.loop.start();
  const tasks = f.loop.tasks().filter(task => task.chatId);
  assert.ok(tasks.length >= 2);
  const [attemptsTask, startedAtTask] = tasks;
  assert.ok(attemptsTask?.chatId && startedAtTask?.chatId);
  const messages = (chatId: string) => f.feishu.sent.filter(message => message.chatId === chatId && message.text.startsWith('飞书历史消息'));
  f.loop.store.setMeta(`history-failure:${attemptsTask.id}`, JSON.stringify({ attempts: 1, noticeSent: false }));
  f.loop.store.setMeta(`history-failure:${startedAtTask.id}`, JSON.stringify({ startedAt: Date.now(), failures: 1 }));
  f.feishu.historyError = new Error('legacy metadata outage');
  await f.loop.collect();
  assert.equal(messages(attemptsTask.chatId).length, 1);
  assert.equal(messages(startedAtTask.chatId).length, 1);
  f.feishu.historyError = null;
  await f.loop.collect();
  assert.equal(messages(attemptsTask.chatId).length, 2);
  assert.equal(messages(startedAtTask.chatId).length, 2);
  assert.equal(f.loop.store.meta(`history-failure:${attemptsTask.id}`), null);
  assert.equal(f.loop.store.meta(`history-failure:${startedAtTask.id}`), null);
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
