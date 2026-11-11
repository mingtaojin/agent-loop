import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import { Store } from '../src/store.js';
import { parseFeishuEvent } from '../src/adapters/feishu.js';
import type { ApprovalAction, IncomingMessage, PendingRequest } from '../src/domain.js';
import type { WorkspacePort } from '../src/ports.js';
import { CodexFake, FeishuFake, GitHubFake, issue } from './fakes.js';

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-'));
  const config = configSchema.parse({ dataDir: root, feishu: { userOpenId: 'owner' }, recovery: { maxAttempts: 2, retryDelayMs: 1 } });
  const github = new GitHubFake(), feishu = new FeishuFake(), codex = new CodexFake();
  const workspaces: Parameters<WorkspacePort['ensure']>[0][] = [];
  const workspace: WorkspacePort = {
    async ensure(input) { workspaces.push(input); const path = input.workspace ?? join(root, `${input.taskId}--${input.resourceId}`); await mkdir(path, { recursive: true }); return path; },
    async head() { return 'head'; },
  };
  const ports = { github, feishu, codex, workspace };
  let loop = new AgentLoop(config, ports);
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  const message = (id: string, text: string, chatId = 'private', chatType: 'p2p' | 'group' = 'p2p'): IncomingMessage => ({ id, text, chatId, chatType, senderId: 'owner', attachments: [], createdAt: Date.now() });
  const task = () => { const value = loop.tasks()[0]; assert.ok(value); return value; };
  const snapshot = () => { const id = task().threadId; assert.ok(id); return codex.snapshot(id); };
  return { root, config, ports, github, feishu, codex, workspaces, task, snapshot, message,
    get loop() { return loop; },
    async manual() { await loop.receive(message('new', 'Explore this idea')); return task(); },
    async restart() { await loop.close(); loop = new AgentLoop(config, ports); await loop.recover(); },
    async githubTask() { config.repositories = [{ name: 'example/project', path: root, baseBranch: 'main', criteria: configSchema.parse({ feishu: { userOpenId: 'owner' }, repositories: [{ name: 'example/project', path: root, baseBranch: 'main' }] }).repositories[0]!.criteria }]; github.sources = [issue(1)]; await loop.collect(); await loop.tick(); return task(); },
  };
}
function request(f: Awaited<ReturnType<typeof fixture>>, kind: PendingRequest['kind'] = 'approval'): PendingRequest {
  const snapshot = f.snapshot(); assert.ok(snapshot.turnId);
  return { id: 'native', threadId: snapshot.threadId, turnId: snapshot.turnId, kind, prompt: 'Need permission', method: kind === 'question' ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval', payload: {}, isBlocking: true, connectionEpoch: 'connection' };
}
function action(f: Awaited<ReturnType<typeof fixture>>, native: PendingRequest): ApprovalAction {
  return { id: 'click', taskId: f.task().id, threadId: native.threadId, turnId: native.turnId, requestId: native.id, decision: 'approve', chatId: f.task().chatId!, senderId: 'owner', epoch: native.connectionEpoch };
}

test('direct private text creates one task per message ID and deduplicates across restart', async t => {
  const f = await fixture(t);
  const groups: Parameters<FeishuFake['ensureGroup']>[0][] = [];
  const ensureGroup = f.feishu.ensureGroup.bind(f.feishu);
  f.feishu.ensureGroup = async input => { groups.push(input); return ensureGroup(input); };
  const original = f.message('direct-text', ' \t\nDiscuss this idea.\nKeep the details.  ');
  await Promise.all([f.loop.receive(original), f.loop.receive(original)]);
  const task = f.task(); assert.ok(task.chatId && task.threadId);
  assert.equal(task.sourceId, 'feishu:new:direct-text');
  assert.deepEqual(task.source, { kind: 'manual', message: original });
  assert.deepEqual(f.codex.starts[0]?.input[0], { kind: 'text', text: 'Discuss this idea.\nKeep the details.' });
  assert.equal(groups[0]?.title, 'Discuss this idea.\nKeep the details.');
  assert.ok(f.feishu.sent.some(output => output.chatId === task.chatId && output.text.includes('新任务请直接私聊发送')));
  await f.restart(); await f.loop.receive(original);
  assert.equal(f.task().id, task.id); assert.equal(f.task().threadId, task.threadId);
  assert.equal(f.loop.store.inputs(task.id).length, 1);
  assert.equal(groups.length, 1); assert.equal(f.codex.starts.length, 1);
  await f.loop.receive({ ...original, id: 'distinct-text' });
  assert.equal(f.loop.tasks().length, 2); assert.equal(groups.length, 2);
  assert.equal(new Set(f.loop.tasks().map(task => task.chatId)).size, 2);
  const followUp = f.message('group-direct', ' \n/new keep this group text intact  ', task.chatId, 'group');
  await f.loop.receive(followUp);
  assert.equal(f.loop.tasks().length, 2);
  assert.deepEqual(f.loop.store.inputs(task.id).at(-1)?.message, followUp);
  assert.deepEqual(f.codex.steers.at(-1)?.input[0], { kind: 'text', text: followUp.text });
});

test('commandless attachment-only input preserves download identity, bytes and source evidence', async t => {
  const f = await fixture(t); const bytes = Buffer.from('attachment-only evidence\n');
  f.feishu.resources.set('direct-file', bytes);
  const original: IncomingMessage = { ...f.message('direct-file-id', ' \n '), attachments: [{ key: 'direct-file', name: 'evidence.log', kind: 'file' }] };
  await f.loop.receive(original);
  const task = f.task();
  assert.deepEqual(task.source, { kind: 'manual', message: original });
  assert.equal(f.loop.store.inputs(task.id)[0]?.message.text, '');
  const download = f.feishu.downloads[0]; assert.ok(download);
  assert.equal(download.messageId, original.id);
  assert.deepEqual(await readFile(download.destination.replace(/\.partial$/, '')), bytes);
});

test('historical manual source keys deduplicate commandless redelivery without changing saved evidence', async t => {
  const f = await fixture(t);
  const legacy = f.message('historical-id', '/new Existing discussion');
  await f.loop.receive(legacy); const task = f.task();
  assert.equal(task.sourceId, 'feishu:new:historical-id');
  await f.restart(); await f.loop.receive({ ...legacy, text: 'Existing discussion' });
  assert.equal(f.loop.tasks().length, 1); assert.equal(f.task().id, task.id);
  assert.deepEqual(f.task().source, { kind: 'manual', message: legacy });
  assert.equal(f.loop.store.inputs(task.id).length, 1); assert.equal(f.feishu.groups.size, 1);
});

test('empty and unauthorized private inputs create nothing and recovery never imports private history', async t => {
  const f = await fixture(t);
  for (const [index, text] of ['', ' \t\r\n', '/new', ' \n/new \t'].entries()) await f.loop.receive(f.message(`empty-${index}`, text));
  await f.loop.receive({ ...f.message('stranger', 'Create an unauthorized task'), senderId: 'stranger' });
  await f.loop.receive({ ...f.message('stranger-file', ''), senderId: 'stranger', attachments: [{ key: 'untrusted', name: 'log.txt', kind: 'file' }] });
  await f.loop.receive(f.message('unknown-group', 'Unknown group', 'unknown', 'group'));
  assert.equal(f.loop.tasks().length, 0); assert.equal(f.feishu.groups.size, 0); assert.equal(f.feishu.downloads.length, 0);
  await f.loop.receive(f.message('known-task', 'Known discussion'));
  f.feishu.offline = [f.message('missed-private', 'Missed private task')];
  const historyChats: string[] = [];
  const history = f.feishu.history.bind(f.feishu);
  f.feishu.history = async input => { historyChats.push(input.chatId); return history(input); };
  await f.restart();
  assert.equal(f.loop.tasks().length, 1);
  assert.deepEqual(historyChats, [f.task().chatId]);
});

test('manual creation deduplicates and discussions retain identity without repositories or guidance', async t => {
  const f = await fixture(t);
  await Promise.all([f.manual(), f.manual()]);
  const task = f.task(); assert.equal(task.source.kind, 'manual');
  assert.equal(f.loop.tasks().length, 1); assert.equal(f.feishu.groups.size, 1); assert.equal(f.codex.created.length, 1);
  assert.deepEqual(task.resources, []); assert.equal(f.workspaces.length, 0);
  assert.equal(f.codex.starts.length, 1); assert.equal(f.codex.starts[0]?.input[0]?.kind, 'text');
  assert.match(JSON.stringify(f.codex.starts[0]?.input), /Explore this idea/);
  f.codex.complete(task.threadId!, 'An exploratory answer.'); await f.loop.tick();
  await f.restart(); await f.loop.tick(); assert.equal(f.task().status, 'idle'); assert.equal(f.codex.starts.length, 1);
  await f.loop.receive(f.message('next', '/new is ordinary text inside a group', task.chatId!, 'group'));
  assert.equal(f.loop.tasks().length, 1); assert.equal(f.codex.starts.length, 2); assert.equal(f.task().threadId, task.threadId);
});

test('legacy /new attachment-only input retains the original private message identity and bytes', async t => {
  const f = await fixture(t); const bytes = Buffer.from('original log\n'); f.feishu.resources.set('key', bytes);
  await f.loop.receive({ ...f.message('attachment-new', '/new'), attachments: [{ key: 'key', name: 'evidence.log', kind: 'file' }] });
  assert.equal(f.feishu.downloads[0]?.messageId, 'attachment-new');
  const text = JSON.stringify(f.codex.starts[0]?.input); assert.match(text, /evidence.log/);
  const download = f.feishu.downloads[0]; assert.ok(download);
  assert.deepEqual(await readFile(download.destination.replace(/\.partial$/, '')), bytes);
  assert.equal(f.workspaces.length, 0);
});

for (const prefix of ['', ' \t\r\n', ' \t\r\n/new ']) test(`manual rich-post creation preserves both images and deduplicates with optional prefix ${JSON.stringify(prefix)}`, async t => {
  const f = await fixture(t);
  const text = 'Analyze the recording\nKeep the original parameters.';
  const firstImage = Buffer.from('first screenshot'), secondImage = Buffer.from('second screenshot');
  const images = [firstImage, secondImage];
  f.feishu.resources.set('img_1', firstImage); f.feishu.resources.set('img_2', secondImage);
  const message = parseFeishuEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'owner' } }, message: {
    message_id: 'rich-post-new', chat_id: 'private', chat_type: 'p2p', create_time: String(Date.now()), message_type: 'post',
    content: JSON.stringify({ title: '', content: [
      [{ tag: 'text', text: `${prefix}Analyze the recording` }],
      [{ tag: 'text', text: 'Keep the original parameters.' }],
      [{ tag: 'img', image_key: 'img_1' }], [{ tag: 'img', image_key: 'img_2' }],
    ] }),
  } }, 'owner');
  assert.ok(message);
  await f.loop.receive(message); await f.loop.receive(message);
  assert.equal(f.loop.tasks().length, 1); assert.equal(f.feishu.groups.size, 1); assert.equal(f.codex.starts.length, 1);
  const task = f.task(); assert.ok(task.source.kind === 'manual');
  assert.deepEqual(task.source.message, message);
  assert.ok(f.feishu.sent.some(output => output.text === `任务对话已建立。\n${text}\n请在本群继续发送文字、截图和日志。新任务请直接私聊发送。`));
  const inputs = f.loop.store.inputs(task.id);
  assert.equal(inputs.length, 1); assert.equal(inputs[0]?.status, 'delivered');
  assert.equal(inputs[0]?.message.text, text); assert.deepEqual(inputs[0]?.message.attachments, message.attachments);
  const input = f.codex.starts[0]?.input; assert.ok(input);
  assert.deepEqual(input[0], { kind: 'text', text });
  const deliveredImages = input.filter(item => item.kind === 'image');
  assert.equal(deliveredImages.length, 2);
  assert.deepEqual(await Promise.all(deliveredImages.map(item => readFile(item.path))), images);
  assert.deepEqual(f.feishu.downloads.map(download => [download.messageId, download.attachment.key]), [
    ['rich-post-new', 'img_1'], ['rich-post-new', 'img_2'],
  ]);
  await f.restart(); await f.loop.receive(message);
  assert.equal(f.loop.tasks().length, 1); assert.equal(f.feishu.groups.size, 1); assert.equal(f.codex.starts.length, 1);
  assert.equal(f.feishu.downloads.length, 2);
  assert.deepEqual(f.task().source, { kind: 'manual', message });
});

test('optional /new normalization keeps command boundaries and leaves group follow-ups verbatim', async t => {
  const f = await fixture(t);
  for (const text of [' \n/news task', ' \n/new-task', 'mention /new task', '/new /new Strip only once']) {
    const original = f.message(text, text);
    await f.loop.receive(original);
    const task = f.loop.store.taskForSource(`feishu:new:${text}`); assert.ok(task);
    assert.equal(f.loop.store.inputs(task.id)[0]?.message.text, text === '/new /new Strip only once' ? '/new Strip only once' : text.trim());
    assert.deepEqual(task.source, { kind: 'manual', message: original });
  }
  assert.equal(f.loop.tasks().length, 4); assert.equal(f.feishu.groups.size, 4);
  await f.loop.receive(f.message('new-whitespace', ' \t\n/new Discuss this'));
  assert.equal(f.loop.tasks().length, 5);
  assert.deepEqual(f.codex.starts.at(-1)?.input[0], { kind: 'text', text: 'Discuss this' });
  const task = f.task(); assert.ok(task.chatId);
  const followUp = ' \n/new is ordinary group text';
  await f.loop.receive(f.message('group-new', followUp, task.chatId, 'group'));
  assert.equal(f.loop.tasks().length, 5);
  assert.equal(f.loop.store.inputs(task.id).at(-1)?.message.text, followUp);
});

test('approval receipt is durable before native resolution and duplicate decisions never replay', async t => {
  const f = await fixture(t); await f.manual(); const native = request(f); f.snapshot().requests = [native]; await f.loop.tick();
  const entered = gate(), release = gate();
  const respond = f.codex.respondApproval.bind(f.codex);
  f.codex.respondApproval = async input => { entered.resolve(); await release.promise; return respond(input); };
  try {
    await f.loop.approve(action(f, native));
    assert.equal(f.loop.store.approvals(f.task().id).length, 1);
    await entered.promise;
    assert.equal(f.loop.store.approvals(f.task().id)[0]?.status, 'processing');
    await assert.rejects(f.loop.approve({ ...action(f, native), decision: 'reject' }), /already/);
    assert.equal(f.codex.approvals.length, 0);
  } finally { release.resolve(); }
  await f.loop.control(f.task().id, 'status');
  assert.equal(f.codex.approvals.length, 1); assert.equal(f.loop.store.approvals(f.task().id)[0]?.status, 'confirmed');
});

test('approval with lost native acknowledgement remains uncertain across restart', async t => {
  const f = await fixture(t); await f.manual(); const native = request(f); f.snapshot().requests = [native]; await f.loop.tick();
  f.codex.respondApproval = async () => 'uncertain';
  await f.loop.approve(action(f, native)); await f.loop.control(f.task().id, 'status');
  assert.equal(f.loop.store.approvals(f.task().id)[0]?.status, 'uncertain');
  await f.restart(); await assert.rejects(f.loop.approve(action(f, native)), /already/);
  assert.ok(f.feishu.sent.some(output => output.text.includes('审批结果不确定')));
});

test('restart does not replay an approval whose write may already have happened', async t => {
  const f = await fixture(t); await f.manual(); const native = request(f); f.snapshot().requests = [native]; await f.loop.tick();
  const click = action(f, native); f.loop.store.queueApproval(click); f.loop.store.markApproval(f.loop.store.approvalKey(click), 'processing');
  await f.restart();
  assert.equal(f.codex.approvals.length, 0); assert.equal(f.loop.store.approvals(f.task().id)[0]?.status, 'uncertain');
});

test('Issue and comment repeated A to B transitions preserve every change while unchanged polls do not wake', async t => {
  const f = await fixture(t); await f.githubTask();
  for (const body of ['B', 'A', 'B']) {
    f.github.sources = [issue(1, { body })];
    await f.loop.collect(); await f.loop.tick();
    await f.loop.collect(); await f.loop.tick();
  }
  assert.equal(f.codex.steers.length, 3);
  for (const body of ['A', 'B', 'A', 'B']) {
    f.github.sourceComments = [{ id: 'comment', sourceId: 'issue-1', url: 'https://example.invalid/comment', author: 'reviewer', body, createdAt: 'date', updatedAt: body }];
    await f.loop.collect(); await f.loop.tick(); await f.loop.collect(); await f.loop.tick();
  }
  assert.equal(f.codex.steers.length, 7);
  f.github.sources = [issue(1, { body: 'B', updatedAt: 'timestamp-only-change' })];
  f.github.sourceComments[0]!.updatedAt = 'timestamp-only-change';
  await f.loop.collect(); await f.loop.tick(); assert.equal(f.codex.steers.length, 7);
  await f.restart(); await f.loop.collect(); await f.loop.tick(); assert.equal(f.codex.steers.length, 7);
});

test('external comments do not answer a native question while user input can', async t => {
  const f = await fixture(t); await f.githubTask(); const native = request(f, 'question'); native.isBlocking = false;
  f.snapshot().requests = [native]; await f.loop.tick();
  f.github.sourceComments = [{ id: 'comment', sourceId: 'issue-1', url: 'url', author: 'reviewer', body: 'yes', createdAt: 'date', updatedAt: 'date' }];
  await f.loop.collect(); await f.loop.tick();
  assert.equal(f.codex.replies.length, 0); assert.equal(f.codex.steers.length, 1);
  await f.loop.receive(f.message('answer', 'user answer', f.task().chatId!, 'group'));
  assert.equal(f.codex.replies[0]?.text, 'user answer');
});

test('Feishu forwards only final answers during execution and after restart', async t => {
  const f = await fixture(t); await f.manual();
  const snapshot = f.snapshot(); assert.ok(snapshot.turnId);
  const initialMessages = [...f.feishu.sent];
  snapshot.outputs.push({ id: 'progress', threadId: snapshot.threadId, turnId: snapshot.turnId, phase: 'progress', text: 'Still investigating.' });
  await f.loop.tick(); await f.loop.tick();
  assert.equal(f.task().status, 'running');
  assert.deepEqual(f.feishu.sent, initialMessages);
  await f.restart();
  assert.deepEqual(f.feishu.sent, initialMessages);
  f.codex.complete(snapshot.threadId, 'Final answer.');
  await f.loop.tick(); await f.loop.tick(); await f.restart();
  assert.deepEqual(f.feishu.sent.slice(initialMessages.length).map(output => output.text), ['Final answer.']);
  assert.equal(f.task().status, 'idle');
});

test('final answers route once per task and uncertain sends are never blindly replayed', async t => {
  const f = await fixture(t); await f.manual();
  await f.loop.receive(f.message('new2', 'second topic'));
  const [first, second] = f.loop.tasks(); assert.ok(first?.threadId && second?.threadId);
  for (const task of [first, second]) {
    const snapshot = f.codex.snapshot(task.threadId!); assert.ok(snapshot.turnId);
    snapshot.outputs.push({ id: 'same-local-id', threadId: snapshot.threadId, turnId: snapshot.turnId, phase: 'progress', text: `Progress for ${task.id}` });
    f.codex.complete(snapshot.threadId, `Answer for ${task.id}`);
  }
  f.feishu.loseSendAck = true; await f.loop.tick(); await f.restart(); await f.loop.tick();
  for (const task of [first, second]) {
    assert.equal(f.feishu.sent.filter(output => output.text === `Progress for ${task.id}` && output.chatId === task.chatId).length, 0);
    assert.equal(f.feishu.sent.filter(output => output.text === `Answer for ${task.id}` && output.chatId === task.chatId).length, 1);
  }
  assert.ok(f.loop.tasks().some(task => f.loop.store.outputs(task.id).some(output => output.status === 'uncertain')));
});

for (const status of ['interrupted', 'failed'] as const) test(`confirmed ${status} execution recovers only within configured limit`, async t => {
  const f = await fixture(t); await f.manual(); const original = f.task();
  for (let attempt = 0; attempt < 3; attempt++) {
    f.snapshot().status = status; f.snapshot().error = status === 'failed' ? 'temporary execution error' : null;
    await f.loop.tick(); await setTimeout(5); await f.loop.tick();
  }
  assert.equal(f.task().status, 'failed'); assert.equal(f.codex.starts.length, 3);
  assert.equal(f.codex.recoveries, 2); assert.equal(f.task().threadId, original.threadId);
  await f.loop.tick(); await f.restart(); assert.equal(f.codex.starts.length, 3);
  assert.ok(f.feishu.sent.some(output => output.text.includes('恢复已停止')));
});

test('transport recovery is bounded, does not wake idle tasks, and silence does not trigger recovery', async t => {
  const f = await fixture(t); await f.manual();
  await f.loop.tick(); await f.loop.tick(); assert.equal(f.codex.recoveries, 0);
  f.codex.inspectError = new Error('connection lost');
  for (let attempt = 0; attempt < 4; attempt++) { await f.loop.tick(); await setTimeout(5); }
  assert.equal(f.task().status, 'failed'); assert.equal(f.codex.recoveries, 2);
  f.codex.inspectError = null;
  await f.loop.receive(f.message('independent', 'independent task'));
  const other = f.loop.tasks()[1]; assert.ok(other?.threadId);
  f.codex.complete(other.threadId, 'done'); await f.loop.tick(); await f.restart();
  assert.equal(f.loop.tasks()[1]?.status, 'idle'); assert.equal(f.codex.starts.length, 2);
});

for (const status of ['interrupted', 'failed'] as const) test(`owner follow-up resumes exhausted ${status} execution in the same Thread once`, async t => {
  const f = await fixture(t); f.config.recovery.maxAttempts = 0;
  const original = await f.manual();
  f.snapshot().status = status; await f.loop.tick();
  assert.equal(f.task().status, 'failed');
  const followUp = f.message('continue', 'Continue the assigned work', original.chatId!, 'group');
  await f.loop.receive(followUp);
  assert.equal(f.task().status, 'running');
  assert.equal(f.task().threadId, original.threadId);
  assert.equal(f.codex.created.length, 1); assert.equal(f.feishu.groups.size, 1);
  assert.equal(f.codex.starts.length, 2); assert.equal(f.codex.recoveries, 0);
  assert.deepEqual(f.codex.starts[1]?.input[0], { kind: 'text', text: followUp.text });
  assert.equal(f.loop.store.inputs(original.id).find(input => input.id === followUp.id)?.status, 'delivered');
  await f.loop.receive(followUp); await f.restart(); await f.loop.tick();
  assert.equal(f.codex.starts.length, 2);
  f.snapshot().status = status; await f.loop.tick(); await f.loop.tick();
  assert.equal(f.task().status, 'failed'); assert.equal(f.codex.starts.length, 2);
});

test('persisted owner follow-ups wake an older failed task after restart', async t => {
  const f = await fixture(t); f.config.recovery.maxAttempts = 0;
  const original = await f.manual();
  f.snapshot().status = 'failed'; await f.loop.tick();
  const legacy = f.task(); legacy.recovery.lastUserInputSeq = null; f.loop.store.saveTask(legacy);
  const pending = f.message('offline-continue', 'Continue with the correction', original.chatId!, 'group');
  pending.createdAt = f.task().updatedAt + 1;
  f.loop.store.receive(original.id, pending);
  await f.restart();
  assert.equal(f.task().status, 'running'); assert.equal(f.task().threadId, original.threadId);
  assert.equal(f.codex.starts.length, 2);
  assert.equal(f.loop.store.inputs(original.id).find(input => input.id === pending.id)?.status, 'delivered');
});

test('owner follow-up revalidates resources and failed validation cannot loop on the same message', async t => {
  const f = await fixture(t); await f.githubTask();
  await f.loop.ensureWorkspace(f.task().id, 'example/project');
  f.config.recovery.maxAttempts = 0; f.snapshot().status = 'failed'; await f.loop.tick();
  f.ports.workspace.ensure = async () => { throw new Error('Wrong branch'); };
  const followUp = f.message('retry-wrong-branch', 'Continue', f.task().chatId!, 'group');
  await f.loop.receive(followUp);
  assert.equal(f.task().status, 'failed'); assert.match(f.task().reason ?? '', /Wrong branch/);
  assert.equal(f.codex.starts.length, 1);
  f.ports.workspace.ensure = async input => { assert.ok(input.workspace); return input.workspace; };
  await f.loop.tick(); await f.restart(); await f.loop.tick();
  assert.equal(f.task().status, 'failed'); assert.equal(f.codex.starts.length, 1);
  await f.loop.receive(f.message('retry-correct-branch', 'Continue now', f.task().chatId!, 'group'));
  assert.equal(f.task().status, 'running'); assert.equal(f.codex.starts.length, 2);
});

test('failed tasks ignore source updates and unauthorized input', async t => {
  const f = await fixture(t); await f.githubTask();
  f.config.recovery.maxAttempts = 0; f.snapshot().status = 'failed'; await f.loop.tick();
  f.github.sources = [issue(1, { body: 'New source detail' })]; await f.loop.collect(); await f.loop.tick();
  await f.loop.receive({ ...f.message('stranger-retry', 'Continue', f.task().chatId!, 'group'), senderId: 'stranger' });
  assert.equal(f.task().status, 'failed'); assert.equal(f.codex.starts.length, 1);
});

test('owner follow-up retains uncertain delivery barriers', async t => {
  const f = await fixture(t); await f.manual();
  f.config.recovery.maxAttempts = 0; f.snapshot().status = 'failed'; await f.loop.tick();
  const unknown = f.message('unknown-input', 'Unknown previous delivery', f.task().chatId!, 'group');
  f.loop.store.receive(f.task().id, unknown); f.loop.store.markInput(unknown.id, 'uncertain');
  await f.loop.receive(f.message('continue-after-unknown', 'Continue', f.task().chatId!, 'group'));
  assert.equal(f.codex.starts.length, 1);
  assert.equal(f.loop.store.inputs(f.task().id).find(input => input.id === unknown.id)?.status, 'uncertain');
  assert.equal(f.loop.store.inputs(f.task().id).at(-1)?.status, 'pending');
});

test('undelivered owner follow-up cannot reset the recovery budget repeatedly', async t => {
  const f = await fixture(t); f.config.recovery.maxAttempts = 0; await f.manual();
  f.snapshot().status = 'failed'; await f.loop.tick();
  f.codex.inspectError = new Error('connection still down');
  await f.loop.receive(f.message('continue-offline', 'Continue', f.task().chatId!, 'group'));
  assert.equal(f.task().status, 'failed');
  f.codex.inspectError = null;
  await f.loop.tick(); await f.restart(); await f.loop.tick();
  assert.equal(f.task().status, 'failed'); assert.equal(f.codex.starts.length, 1);
  assert.equal(f.loop.store.inputs(f.task().id).at(-1)?.status, 'pending');
});

test('resource identity failure remains a barrier after recovery retries', async t => {
  const f = await fixture(t); await f.githubTask();
  await f.loop.ensureWorkspace(f.task().id, 'example/project');
  f.ports.workspace.ensure = async () => { throw new Error('Wrong branch'); };
  await f.restart(); await setTimeout(5); await f.loop.tick();
  assert.equal(f.task().status, 'failed'); assert.equal(f.codex.recoveries, 0); assert.equal(f.codex.starts.length, 1);
  assert.match(f.task().reason ?? '', /Wrong branch/);
});

test('dynamic workspace request completes while startTurn holds the task lane and preserves two resource associations', async t => {
  const f = await fixture(t);
  const repository = { name: 'example/one', path: f.root, baseBranch: 'main', criteria: configSchema.parse({ feishu: { userOpenId: 'owner' }, repositories: [{ name: 'example/one', path: f.root, baseBranch: 'main' }] }).repositories[0]!.criteria };
  f.config.repositories = [repository, { ...repository, name: 'example/two' }];
  const start = f.codex.startTurn.bind(f.codex);
  f.codex.startTurn = async input => {
    const turnId = await start(input); assert.ok(f.codex.workspaceHandler);
    await Promise.all(['example/one', 'example/two', 'example/one'].map((name, index) => f.codex.workspaceHandler!({ threadId: input.threadId, turnId, callId: String(index), repository: name })));
    return turnId;
  };
  await f.manual();
  assert.equal(f.task().resources.length, 2); assert.equal(f.workspaces.length, 2);
  assert.equal(f.codex.created.length, 1); await f.restart(); assert.equal(f.task().resources.length, 2);
  await assert.rejects(f.loop.ensureWorkspace(f.task().id, 'unconfigured/repo'), /configured/);
});

test('legacy SQLite migration preserves conversation, workspace, pending input and uncertain effects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-migration-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repository = configSchema.parse({ feishu: { userOpenId: 'owner' }, repositories: [{ name: 'example/project', path: root, baseBranch: 'main' }] }).repositories[0]!;
  const oldTask = { id: 'old', sourceId: 'issue-1', source: issue(1), repository, workspace: join(root, 'workspaces/old'), branch: 'agent-loop/old', status: 'awaiting_review', reason: null, prompt: 'old prompt', promptHash: 'hash', skillPath: '/old/skill', chatId: 'chat-old', threadId: 'thread-old', turnId: 'turn-old', lastHandledTurnId: 'turn-old', requests: [], createdAt: 1, updatedAt: 2, prUrl: 'https://example.invalid/pr' };
  const db = new DatabaseSync(join(root, 'tasks.sqlite'));
  db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,source_id TEXT NOT NULL UNIQUE,chat_id TEXT UNIQUE,thread_id TEXT UNIQUE,payload TEXT NOT NULL); CREATE TABLE inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,task_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,error TEXT)');
  db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(oldTask.id, oldTask.sourceId, oldTask.chatId, oldTask.threadId, JSON.stringify(oldTask));
  db.prepare('INSERT INTO inbox(id,task_id,payload,status) VALUES(?,?,?,?)').run('old-input', 'old', JSON.stringify({ id: 'old-input', chatId: 'chat-old', senderId: 'owner', text: 'saved user input', attachments: [], createdAt: 3 }), 'uncertain');
  db.close();
  let store = new Store(root);
  const migrated = store.task('old'); assert.equal(migrated.status, 'idle'); assert.equal(migrated.source.kind, 'github');
  assert.equal(migrated.contextDirectory, oldTask.workspace); assert.equal(migrated.resources[0]?.workspace, oldTask.workspace);
  const migratedResource = migrated.resources[0]; assert.ok(migratedResource);
  assert.ok(migratedResource.kind === 'git-worktree');
  assert.equal(migratedResource.branch, oldTask.branch);
  assert.equal(migrated.threadId, oldTask.threadId); assert.equal(migrated.chatId, oldTask.chatId);
  assert.equal(migrated.legacy?.prUrl, oldTask.prUrl); assert.equal(store.inputs('old')[0]?.status, 'uncertain');
  assert.equal(store.inputs('old')[0]?.provenance.kind, 'user');
  store.beginOperation('unknown-thread', 'old', 'thread'); store.uncertainOperation('unknown-thread', 'lost acknowledgement');
  store.close(); store = new Store(root);
  assert.deepEqual(store.task('old'), migrated); assert.equal(store.operation('unknown-thread')?.status, 'uncertain'); store.close();
});


test('legacy shell bridge acquires task-bound resources through the live Runtime owner', async t => {
  const f = await fixture(t); await f.githubTask();
  const retained = f.task(); retained.workspaceSelection = { kind: 'pending' }; f.loop.store.saveTask(retained); await f.loop.tick();
  const execute = promisify(execFile);
  const capability = join(f.root, 'workspace-capabilities', `${f.task().id}.json`);
  const client = resolve('src/workspace-client.ts');
  const original = f.task();
  const result = await execute(process.execPath, [client, capability, 'example/project']);
  const resource = JSON.parse(result.stdout);
  assert.equal(resource.id, f.task().resources[0]?.id); assert.equal(resource.workspace, f.task().resources[0]?.workspace);
  assert.equal(f.task().threadId, original.threadId); assert.equal(f.codex.created.length, 1);
  await assert.rejects(execute(process.execPath, [client, capability, 'unconfigured/repo']), /configured/);
  const copied = join(f.root, 'old-capability.json'); await writeFile(copied, await readFile(capability));
  await f.restart();
  await assert.rejects(execute(process.execPath, [client, copied, 'example/project']));
  await execute(process.execPath, [client, capability, 'example/project']);
  assert.equal(f.task().resources.length, 1);
  await f.loop.control(f.task().id, 'pause');
  await assert.rejects(execute(process.execPath, [client, capability, 'example/project']), /active/);
});

test('legacy pause waits across restart and fresh human input resumes the same conversation', async t => {
  const f = await fixture(t); await f.manual();
  const task = f.task(); task.status = 'paused'; task.reason = '来源不再符合条件'; task.legacy = { status: 'paused', prUrl: null }; f.loop.store.saveTask(task);
  f.snapshot().status = 'interrupted'; await f.restart(); assert.equal(f.task().status, 'paused'); assert.equal(f.codex.starts.length, 1);
  await f.loop.receive(f.message('fresh', 'Continue with this correction', task.chatId!, 'group'));
  assert.equal(f.task().status, 'running'); assert.equal(f.codex.starts.length, 2); assert.equal(f.task().threadId, task.threadId);
  await f.loop.control(task.id, 'pause');
  await f.loop.receive(f.message('held', 'Operator pause remains explicit', task.chatId!, 'group'));
  assert.equal(f.task().status, 'paused'); assert.equal(f.codex.starts.length, 2);
});


test('migrated legacy turn notifications do not repeat while newly missed output is delivered', async t => {
  const f = await fixture(t); await f.manual(); const task = f.task();
  task.legacy = { status: 'awaiting_review', prUrl: null }; f.loop.store.saveTask(task);
  const old = f.loop.store.enqueue(task.id, 'Previously forwarded report', 'turn:old-turn');
  f.loop.store.markOutput(old, 'sent');
  const snapshot = f.snapshot(); assert.ok(snapshot.turnId);
  snapshot.outputs.push(
    { id: 'old-progress', threadId: snapshot.threadId, turnId: 'old-turn', phase: 'progress', text: 'Historical progress' },
    { id: 'old-final', threadId: snapshot.threadId, turnId: 'old-turn', phase: 'final', text: 'Historical report' },
    { id: 'missed', threadId: snapshot.threadId, turnId: snapshot.turnId, phase: 'final', text: 'Newly missed output' },
  );
  await f.loop.tick(); await f.restart();
  assert.equal(f.feishu.sent.filter(output => output.text.startsWith('Historical')).length, 0);
  assert.equal(f.feishu.sent.filter(output => output.text === 'Newly missed output').length, 1);
});


test('GitHub outage during recovery preserves the original conversation for new user input', async t => {
  const f = await fixture(t); await f.githubTask(); const original = f.task();
  f.github.getError = new Error('GitHub unavailable'); await f.restart();
  await f.loop.receive(f.message('offline-source-user', 'Continue with this local evidence', original.chatId!, 'group'));
  assert.equal(f.task().threadId, original.threadId); assert.equal(f.task().status, 'running');
  assert.equal(f.codex.steers.at(-1)?.deliveryId, 'offline-source-user');
  assert.ok(f.loop.store.diagnostics().some(item => item.message.includes('GitHub unavailable')));
});
