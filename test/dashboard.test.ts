import { testExecution } from './test-config.js';
import { SurfaceCodex, testProject, restoreSurface } from './coordinated-surfaces.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';
import { networkInterfaces } from 'node:os';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { test } from 'node:test';
import { z } from 'zod';
import { startDashboard } from '../src/dashboard.js';
import { dashboardScript } from '../src/dashboard-page.js';
import { AgentLoop } from '../src/loop.js';
import { configSchema } from '../src/config.js';
import { CodexAppServer } from './helpers/codex.js';
import { Store } from '../src/store.js';
import { storedExecutionEventSchema, executionEvent } from '../src/execution-events.js';
import { CodexFake, FeishuFake, GitHubFake } from './fakes.js';
import { WorkspaceProvider } from '../src/workspace.js';

test('dashboard projects discovered resource identity and workspace without repository metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-project-'));
  const projectRoot = join(root, 'projects'); await mkdir(join(projectRoot, 'local'), { recursive: true });
  const config = configSchema.parse({ execution: testExecution, dataDir: join(root, 'data'), engineering: { projectRoot }, projects: [testProject(join(projectRoot, 'local'))], feishu: { userOpenId: 'owner' } });
  const codex = new SurfaceCodex();
  const loop = new AgentLoop(config, { codex, feishu: new FeishuFake(), github: new GitHubFake(), workspace: new WorkspaceProvider(config.dataDir) });
  const dashboard = await startDashboard({ dataDir: config.dataDir, port: 0 });
  t.after(async () => { await dashboard.close(); await loop.close(); await rm(root, { recursive: true, force: true }); });
  await restoreSurface(loop, { id: 'dashboard-project-input', chatId: 'private', chatType: 'p2p', senderId: 'owner',
    text: 'Inspect the local project', attachments: [], createdAt: Date.now() });
  const task = loop.tasks()[0]; assert.ok(task);
  const response = await fetch(dashboard.url + '/api/snapshot'); assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.deepEqual(snapshot.tasks[0].resources, []);
  assert.equal(snapshot.tasks[0].threadId, task.threadId);
});

test('dashboard serves a read-only local page before the runtime database exists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-empty-'));
  const dashboard = await startDashboard({ dataDir: join(root, 'not-created'), port: 0 });
  t.after(async () => { await dashboard.close(); await rm(root, { recursive: true, force: true }); });
  const page = await fetch(dashboard.url);
  assert.equal(page.status, 200); assert.match(await page.text(), /实时输出/);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const data = await (await fetch(dashboard.url + '/api/snapshot')).json();
  assert.deepEqual(data.tasks, []); assert.equal(data.runtime, null);
  await assert.rejects(access(join(root, 'not-created')));
  assert.equal((await fetch(dashboard.url + '/api/snapshot', { method: 'POST' })).status, 405);
  assert.equal((await fetch(dashboard.url + '/api/snapshot', { headers: { origin: 'https://unrelated.example' } })).status, 403);
  const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const call = request(dashboard.url + '/api/snapshot', { headers: { host: 'unrelated.example' } }, response => { response.resume(); resolve(response.statusCode); });
    call.on('error', reject); call.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(dashboard.url + '/api/tasks/missing')).status, 404);
  assert.equal((await fetch(dashboard.url + '/api/events?taskId=missing&after=NaN')).status, 400);
  assert.equal((await fetch(dashboard.url + '/app.css')).status, 200);
  assert.match((await fetch(dashboard.url + '/app.js')).headers.get('content-type') ?? '', /javascript/);
  assert.doesNotThrow(() => new Script(dashboardScript));
});

test('group and dashboard titles share normalization while persisted manual source text stays original', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-title-'));
  const config = configSchema.parse({ execution: testExecution, dataDir: root, projects: [testProject(root)], feishu: { userOpenId: 'owner' } });
  const feishu = new FeishuFake();
  const groupTitles = new Map<string, string>();
  const ensureGroup = feishu.ensureGroup.bind(feishu);
  feishu.ensureGroup = async input => { groupTitles.set(input.taskId, input.title); return ensureGroup(input); };
  feishu.resources.set('title-file', Buffer.from('original attachment\n'));
  const loop = new AgentLoop(config, { codex: new SurfaceCodex(), feishu, github: new GitHubFake(), workspace: new WorkspaceProvider(root) });
  const dashboard = await startDashboard({ dataDir: root, port: 0 });
  t.after(async () => { await dashboard.close(); await loop.close(); await rm(root, { recursive: true, force: true }); });
  const cases = [
    { text: ' \nAnalyze the recording  ', title: 'Analyze the recording' },
    { text: ' \t\n/new Analyze the recording  ', title: 'Analyze the recording' },
    { text: '/news task', title: '/news task' }, { text: '/new-task', title: '/new-task' },
    { text: '/new /new Keep once', title: '/new Keep once' },
    { text: ' \n/new ' + 'x'.repeat(220), title: 'x'.repeat(220) },
    { text: '', title: '新讨论' },
  ];
  for (const [index, input] of cases.entries()) await restoreSurface(loop, { id: `title-${index}`, chatId: 'private', chatType: 'p2p', senderId: 'owner',
    text: input.text, attachments: input.text ? [] : [{ key: 'title-file', name: 'evidence.log', kind: 'file' }], createdAt: Date.now() });
  const response = await fetch(dashboard.url + '/api/snapshot'); assert.equal(response.status, 200);
  const snapshot = await response.json();
  for (const [index, input] of cases.entries()) {
    const task = loop.store.taskForSource(`feishu:new:title-${index}`); assert.ok(task?.source.kind === 'manual');
    assert.equal(task.source.message.text, input.text);
    assert.equal(groupTitles.get(task.id), input.title.slice(0, 100));
    const projected = snapshot.tasks.find((item: { id: string }) => item.id === task.id); assert.ok(projected);
    assert.equal(projected.title, input.title.slice(0, 200));
  }
});

test('real adapter to SQLite to SSE streams partial text, tools and capacity errors, resumes and isolates tasks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-live-'));
  const config = configSchema.parse({ execution: testExecution, dataDir: root, projects: [testProject(root)], feishu: { userOpenId: 'owner' } });
  const codex = new CodexAppServer({ command: [process.execPath, resolve('test/fixtures/debug-codex.mjs')], approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 2000 });
  const feishu = new FeishuFake();
  const loop = new AgentLoop(config, { codex, feishu, github: new GitHubFake(), workspace: { async ensure(input) { if (input.kind === 'project-directory') return input.directory; throw new Error('No workspace needed'); }, async head() { return 'unused'; } } });
  const dashboard = await startDashboard({ dataDir: root, port: 0 });
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await dashboard.close(); await loop.close(); await rm(root, { recursive: true, force: true }); });
  const message = (id: string, text: string, chatId = 'private', chatType: 'p2p' | 'group' = 'p2p') => ({ id, text, chatId, chatType, senderId: 'owner', attachments: [], createdAt: Date.now() });
  await restoreSurface(loop, message('one', 'First task')); await loop.tick();
  await restoreSurface(loop, message('two', '<img src=x onerror=alert(1)>')); await loop.tick();
  const [first, second] = loop.tasks().filter(task => !task.sourceId.startsWith('project:')); assert.ok(first?.threadId && first.chatId && second?.threadId);
  assert.throws(() => new Store(root), /已有 Agent Loop/);
  const initial = await (await fetch(dashboard.url + '/api/snapshot')).json();
  assert.equal(initial.tasks.length, 3);
  const response = await fetch(dashboard.url + '/api/events?taskId=' + first.id, { signal: abort.signal });
  assert.equal(response.status, 200); assert.ok(response.body);
  const reader = response.body.getReader();
  const chunk = await reader.read();
  const raw = new TextDecoder().decode(chunk.value);
  assert.match(raw, /agent_delta/); assert.match(raw, /tool_start/); assert.doesNotMatch(raw, /tool_output/); assert.match(raw, /Selected model is at capacity/);
  assert.doesNotMatch(raw, /private reasoning/);
  assert.ok(!raw.includes(second.threadId));
  const before = loop.store.executionEvents(first.id);
  assert.equal(before.some(event => event.kind === 'agent_message'), false);
  assert.equal(before.some(event => event.kind === 'turn_end'), false);
  assert.equal(loop.tasks()[0]?.status, 'running');
  await restoreSurface(loop, message('finish', 'finish', first.chatId, 'group')); await loop.tick();
  const events = loop.store.executionEvents(first.id);
  assert.equal(events.filter(event => event.kind === 'agent_message').length, 1);
  assert.equal(events.at(-1)?.kind, 'turn_end');
  assert.equal(events.find(event => event.kind === 'agent_message')?.text, '正在检查运行状态，校验已完成。');
  assert.equal(feishu.sent.some(item => item.text.includes('Selected model is at capacity')), false);
  const cursor = before.at(-1)?.seq; assert.ok(cursor);
  const resumed = await fetch(dashboard.url + '/api/events?taskId=' + first.id, { headers: { 'Last-Event-ID': String(cursor) }, signal: abort.signal });
  assert.ok(resumed.body);
  const resumedChunk = await resumed.body.getReader().read();
  const resumedRaw = new TextDecoder().decode(resumedChunk.value);
  const resumedEvents = resumedRaw.split('\n').filter(line => line.startsWith('data: ')).map(line => storedExecutionEventSchema.parse(JSON.parse(line.slice(6))));
  assert.ok(resumedEvents.length > 0);
  assert.ok(resumedEvents.every(event => event.seq > cursor && event.taskId === first.id));
  assert.equal(resumedEvents.at(-1)?.kind, 'turn_end');
  assert.equal((await (await fetch(dashboard.url + '/api/tasks/' + first.id)).json()).outputs.some((row: { text: string }) => row.text === '正在检查运行状态，校验已完成。'), true);
  const readOnly = new Store(root, { readOnly: true });
  const durable = readOnly.executionEvents(first.id);
  assert.equal(durable.some(event => event.kind === 'tool_output'), false);
  assert.equal(durable.filter(event => event.kind === 'agent_message').length, 1);
  assert.equal(durable.at(-1)?.kind, 'turn_end'); readOnly.close();
  assert.equal(loop.store.task(second.id).status, 'running');
});

test('debug event projection excludes untrusted protocol configuration and private reasoning', () => {
  assert.equal(executionEvent('thread/started', { thread: { developerInstructions: 'secret' } }), null);
  assert.equal(executionEvent('item/reasoning/textDelta', { threadId: 't', turnId: 'u', delta: 'private' }), null);
  assert.equal(executionEvent('item/agentMessage/delta', { threadId: 't', turnId: 'u', delta: 42 }), null);
  const value = executionEvent('error', { threadId: 't', turnId: 'u', willRetry: false, error: { message: 'capacity', sensitiveField: 'secret' }, secret: 'not exported' });
  assert.ok(value); assert.equal(value.kind, 'error');
  assert.doesNotMatch(JSON.stringify(value), /secret/);
  assert.equal(configSchema.parse({ execution: testExecution, feishu: { userOpenId: 'owner' } }).dashboard.port, 8787);
  assert.equal(configSchema.parse({ execution: testExecution, feishu: { userOpenId: 'owner' } }).dashboard.host, '0.0.0.0');
  assert.equal(z.number().parse(value.createdAt) > 0, true);
});

test('dashboard close is idempotent and terminates active SSE and incomplete HTTP connections', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-close-'));
  const config = configSchema.parse({ execution: testExecution, dataDir: root, projects: [testProject(root)], feishu: { userOpenId: 'owner' } });
  const loop = new AgentLoop(config, { codex: new SurfaceCodex(), feishu: new FeishuFake(), github: new GitHubFake(), workspace: new WorkspaceProvider(root) });
  const dashboard = await startDashboard({ dataDir: root, port: 0 });
  t.after(async () => { await dashboard.close(); await loop.close(); await rm(root, { recursive: true, force: true }); });
  await restoreSurface(loop, { id: 'shutdown-task', chatId: 'private', chatType: 'p2p', senderId: 'owner', text: 'Inspect shutdown', attachments: [], createdAt: Date.now() });
  const task = loop.tasks()[0]; assert.ok(task);
  const response = await new Promise<import('node:http').IncomingMessage>((done, reject) => {
    const call = request(dashboard.url + '/api/events?taskId=' + task.id, done);
    call.on('error', reject); call.end();
  });
  assert.equal(response.statusCode, 200); response.resume();
  const streamClosed = once(response, 'close');
  const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(dashboard.url).port) });
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write('GET / HTTP/1.1\r\n');
  const socketClosed = new Promise<void>((done, reject) => {
    socket.once('close', () => done());
    socket.once('error', error => { if (!('code' in error && error.code === 'ECONNRESET')) reject(error); });
  });
  const closing = dashboard.close();
  assert.equal(dashboard.close(), closing);
  await closing; await streamClosed; await socketClosed;
  assert.equal(dashboard.close(), closing); await dashboard.close();
  const restarted = await startDashboard({ dataDir: root, port: Number(new URL(dashboard.url).port) });
  try { assert.equal((await fetch(restarted.url + '/api/snapshot')).status, 200); }
  finally { await restarted.close(); }
});

test('wildcard dashboard binding accepts interface addresses and still rejects unrelated origins and hosts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dashboard-network-'));
  const dashboard = await startDashboard({ dataDir: root, port: 0, host: '0.0.0.0' });
  t.after(async () => { await dashboard.close(); await rm(root, { recursive: true, force: true }); });
  assert.match(dashboard.listenAddress, /^0\.0\.0\.0:/);
  const port = new URL(dashboard.url).port;
  assert.equal((await fetch(dashboard.url)).status, 200);
  const address = Object.values(networkInterfaces()).flatMap(addresses => addresses ?? []).find(item => item.family === 'IPv4' && !item.internal);
  if (address) {
    const networkUrl = 'http://' + address.address + ':' + port;
    assert.equal((await fetch(networkUrl + '/api/snapshot', { headers: { origin: networkUrl } })).status, 200);
    assert.ok(dashboard.networkUrls.includes(networkUrl));
  }
  assert.equal((await fetch(dashboard.url + '/api/snapshot', { headers: { origin: 'http://unrelated.example' } })).status, 403);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const call = request(dashboard.url, { headers: { host: 'unrelated.example:' + port } }, response => { response.resume(); resolve(response.statusCode); });
    call.on('error', reject); call.end();
  });
  assert.equal(status, 403);
});
