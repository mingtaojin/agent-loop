import { testExecution } from './test-config.js';
import { testProject, tickWithCoordinator } from './coordinated-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { z } from 'zod';
import { GitHubAdapter } from '../src/adapters/github.js';
import { FeishuAdapter, parseFeishuEvent, parseFeishuHistory, type FeishuDependencies } from '../src/adapters/feishu.js';
import { repositorySchema, UncertainOperationError, type ApprovalAction, type PendingRequest } from '../src/domain.js';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import { Store } from '../src/store.js';
import { CodexAppServer } from './helpers/codex.js';
import { GitHubFake } from './fakes.js';
import { FeishuApiError, GroupCreationRejected, TaskGroupBindingChanged, TaskGroupUnavailable, type FeishuProgressPort, type ProgressWriteGuard } from '../src/ports.js';

const repository = repositorySchema.parse({ name: 'owner/repo', path: '/repo', baseBranch: 'main' });
const issue = { node_id: 'I_1', number: 1, html_url: 'https://github.com/owner/repo/issues/1', title: 'Broken',
  body: null, state: 'open', assignees: [{ login: 'owner' }], labels: [{ name: 'bug' }], type: { name: 'Bug' }, updated_at: '2026-11-04T00:00:00Z' };
async function collect(github: GitHubAdapter) {
  const sources = [];
  for await (const source of github.list(repository)) sources.push(source);
  return sources;
}
test('GitHub skips remote collection when no issue states are enabled', async () => {
  let calls = 0;
  const github = new GitHubAdapter({ token: 'test' }, async () => {
    calls++;
    return Response.json([issue]);
  });
  const disabled = repositorySchema.parse({ ...repository, criteria: { states: [] } });
  const sources = [];
  for await (const source of github.list(disabled)) sources.push(source);
  assert.deepEqual(sources, []);
  assert.equal(calls, 0);
});
test('GitHub traverses all pages and preserves native types, labels and PR identity', async () => {
  const calls: string[] = [];
  const github = new GitHubAdapter({ token: 'test' }, async (url, options) => {
    calls.push(String(url));
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer test');
    assert.equal(options?.redirect, 'error');
    if (calls.length === 1) return new Response(JSON.stringify([issue]), { headers: { link: '<https://api.github.com/repos/owner/repo/issues?page=2>; rel="next"' } });
    return Response.json([{ ...issue, node_id: 'PR_2', number: 2, labels: ['bug'], type: null, pull_request: {} }]);
  });
  const results = await collect(github);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0]?.assignees, ['owner']);
  assert.equal(results[0]?.nativeType, 'Bug');
  assert.equal(results[0]?.body, '');
  assert.equal(results[1]?.isPullRequest, true);
  assert.equal(results[1]?.nativeType, null);
});
test('GitHub rejects failed pages and pagination credential escape', async () => {
  let calls = 0;
  const github = new GitHubAdapter({ token: 'test' }, async () => {
    calls++;
    return new Response(JSON.stringify([issue]), { headers: { link: '<https://evil.example/page>; rel="next"' } });
  });
  await assert.rejects(collect(github), /escaped/);
  assert.equal(calls, 1);
  await assert.rejects(collect(new GitHubAdapter({ token: 'test' }, async () => new Response('', { status: 403 }))), /HTTP 403/);
});
test('GitHub verifies draft PR repository, head branch and exact commit', async () => {
  const pr = { draft: true, state: 'open', merged: false, base: { repo: { full_name: 'owner/repo' } },
    head: { ref: 'agent/task', sha: 'abc', repo: { full_name: 'owner/repo' } } };
  const github = new GitHubAdapter({ token: 'test' }, async url => {
    assert.match(String(url), /\/pulls\/5$/);
    return Response.json(pr);
  });
  const input = { url: 'https://github.com/owner/repo/pull/5', repository: 'owner/repo', branch: 'agent/task', headSha: 'abc' };
  assert.equal(await github.verifyPullRequest(input), true);
  assert.equal(await github.verifyPullRequest({ ...input, headSha: 'stale' }), false);
  pr.draft = false;
  assert.equal(await github.verifyPullRequest(input), false);
  assert.equal(await github.verifyPullRequest({ ...input, url: 'https://evil.example/owner/repo/pull/5' }), false);
});
test('GitHub direct source reads preserve closed and unassigned facts', async () => {
  const github = new GitHubAdapter({ token: 'test' }, async () => Response.json({ ...issue, state: 'closed', assignees: [] }));
  const result = await github.get('owner/repo', 1);
  assert.equal(result.state, 'closed');
  assert.deepEqual(result.assignees, []);
});

const owner = 'ou_owner';
const options = { appId: 'test-app', appSecret: 'test-secret', userOpenId: owner };
const event = { sender: { sender_type: 'user', sender_id: { open_id: owner } },
  message: { message_id: 'om_1', chat_id: 'oc_1', create_time: '1770000000123', message_type: 'text', content: '{"text":"hello"}' } };
const historyItem = { message_id: 'om_1', chat_id: 'oc_1', create_time: '1770000000123', msg_type: 'text',
  sender: { id: owner, id_type: 'open_id', sender_type: 'user' }, body: { content: '{"text":"hello"}' } };
function fakeApi(): NonNullable<FeishuDependencies['api']> {
  return {
    chat: {
      list: async () => ({ code: 0, data: { items: [], has_more: false } }),
      get: async () => ({ code: 0, data: { owner_id: owner, chat_status: 'normal', chat_mode: 'group', chat_type: 'private' } }),
      create: async () => ({ code: 0, data: { chat_id: 'oc_new' } }),
    },
    message: {
      list: async () => ({ code: 0, data: { items: [], has_more: false } }),
      create: async () => ({ code: 0, data: { message_id: 'om_sent' } }),
    },
    messageResource: { get: async () => ({ writeFile: async () => {}, getReadableStream: () => Readable.from([Buffer.from('original')]), headers: {} }) },
  };
}

const guardedCardWrites: { name: string; run(port: FeishuProgressPort, guard: ProgressWriteGuard): Promise<unknown> }[] = [
  { name: 'create', run: (port, guard) => port.createProgressCard({ content: 'Progress' }, guard) },
  { name: 'send', run: (port, guard) => port.sendProgressCard({ chatId: 'group', cardId: 'card', uuid: 'send' }, guard) },
  { name: 'content', run: (port, guard) => port.updateProgressContent({ cardId: 'card', content: 'Progress', sequence: 1, uuid: 'content' }, guard) },
  { name: 'settings', run: (port, guard) => port.setProgressStreaming({ cardId: 'card', enabled: true, sequence: 1, uuid: 'settings' }, guard) },
];
for (const operation of guardedCardWrites) test(`retiring a binding during card pacing cancels ${operation.name} dispatch`, async () => {
  const calls: string[] = [];
  const api = fakeApi();
  api.message.create = async () => { calls.push('send'); return { code: 0, data: { message_id: 'message' } }; };
  const adapter = new FeishuAdapter(options, { api, cardkit: {
    card: {
      create: async () => { calls.push('create'); return { code: 0, data: { card_id: 'card' } }; },
      settings: async () => { calls.push('settings'); return { code: 0, data: {} }; },
      idConvert: async () => { throw new Error('Unexpected read'); },
    },
    cardElement: { content: async () => { calls.push('content'); return { code: 0, data: {} }; } },
  } });
  await adapter.createProgressCard({ content: 'Initial' });
  let current = true;
  const writing = operation.run(adapter, () => { if (!current) throw new TaskGroupBindingChanged(); });
  current = false;
  await assert.rejects(writing, TaskGroupBindingChanged);
  assert.deepEqual(calls, ['create']);
});

test('Feishu group generations use distinct create UUIDs and exact generation markers', async () => {
  const api = fakeApi();
  const requests: NonNullable<Parameters<typeof api.chat.create>[0]>[] = [];
  api.chat.list = async () => ({ code: 0, data: { items: [{ chat_id: 'old', description: 'agent-loop:v1:task' }], has_more: false } });
  api.chat.create = async input => { assert.ok(input); requests.push(input); return { code: 0, data: { chat_id: 'replacement' } }; };
  const adapter = new FeishuAdapter(options, { api });
  assert.equal(await adapter.ensureGroup({ taskId: 'task', title: 'Same title', generation: 1 }), 'replacement');
  assert.equal(await adapter.ensureGroup({ taskId: 'task', title: 'Same title', generation: 2 }), 'replacement');
  assert.notEqual(requests[0]?.params?.uuid, requests[1]?.params?.uuid);
  assert.equal(requests[0]?.data?.description, 'agent-loop:v1:task:generation:1\n');
  api.chat.list = async () => ({ code: 0, data: { items: [{ chat_id: 'replacement', description: 'agent-loop:v1:task:generation:1\n' }], has_more: false } });
  await adapter.ensureGroup({ taskId: 'task', title: 'Same title', generation: 1, reconcileOnly: true });
  assert.equal(requests.length, 2);
});

test('Feishu deletion treats dissolved groups as success but preserves permission and malformed-response errors', async () => {
  const api = fakeApi(); let calls = 0;
  api.chat.delete = async () => { calls++; return { code: 232009, msg: 'already dissolved' }; };
  const adapter = new FeishuAdapter(options, { api });
  await adapter.dissolveGroup('old'); assert.equal(calls, 1);
  api.chat.delete = async () => ({ code: 232017, msg: 'permission denied' });
  await assert.rejects(adapter.dissolveGroup('old'), FeishuApiError);
  api.chat.delete = async () => ({});
  await assert.rejects(adapter.dissolveGroup('old'), UncertainOperationError);
  api.chat.get = async () => ({ code: 232009, msg: 'already dissolved' });
  await assert.rejects(adapter.verifyGroup('old'), TaskGroupUnavailable);
  api.chat.get = async () => ({ code: 232011, msg: 'not in chat' });
  await assert.rejects(adapter.verifyGroup('old'), error => error instanceof FeishuApiError && !(error instanceof TaskGroupUnavailable));
  api.chat.get = async () => ({ code: 0, data: {} });
  await assert.rejects(adapter.verifyGroup('old'), error => error instanceof Error && !(error instanceof TaskGroupUnavailable));
  api.chat.create = async () => ({ code: 232017, msg: 'permission denied' });
  await assert.rejects(adapter.ensureGroup({ taskId: 'new', title: 'Task' }), GroupCreationRejected);
});

test('socket private events admit nothing while project-group delivery persists and deduplicates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-private-dispatch-'));
  const api = fakeApi();
  const groups: NonNullable<Parameters<typeof api.chat.create>[0]>[] = [];
  const downloads: NonNullable<Parameters<typeof api.messageResource.get>[0]>[] = [];
  const historyChats: string[] = [];
  const resources = new Map([
    ['img_1', Buffer.from('first original screenshot')], ['img_2', Buffer.from('second original screenshot')],
    ['img_only', Buffer.from('image-only original bytes')], ['file_only', Buffer.from('file-only original bytes\n')],
  ]);
  api.chat.create = async input => { assert.ok(input); groups.push(input); return { code: 0, data: { chat_id: `oc_direct_${groups.length}` } }; };
  api.message.list = async input => {
    assert.ok(input);
    historyChats.push(input.params.container_id);
    return { code: 0, data: { items: [], has_more: false } };
  };
  api.messageResource.get = async input => {
    assert.ok(input);
    downloads.push(input);
    const bytes = resources.get(input.path.file_key); assert.ok(bytes);
    return { writeFile: async () => {}, getReadableStream: () => Readable.from([bytes]), headers: {} };
  };
  let dispatch: ((input: unknown) => Promise<unknown>) | undefined;
  const errors: unknown[] = [];
  const feishu = new FeishuAdapter(options, { api, socket: {
    start: async ({ eventDispatcher }) => {
      const handler = eventDispatcher.handles.get('im.message.receive_v1'); assert.ok(handler);
      dispatch = async input => handler(input);
    }, close: () => {},
  } });
  const codex = new CodexAppServer({ command: [process.execPath, resolve('test/fixtures/debug-codex.mjs')],
    approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 2000 });
  const loop = new AgentLoop(configSchema.parse({ execution: testExecution, dataDir: root, projects: [testProject(root)], feishu: { userOpenId: owner } }), {
    codex, feishu, github: new GitHubFake(),
    workspace: { async ensure(input) { if (input.kind === 'project-directory') return input.directory; throw new Error('No workspace needed'); }, async head() { return 'unused'; } },
  });
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  await feishu.start(message => loop.receive(message), error => { errors.push(error); });
  assert.ok(dispatch);
  const cases = [
    { id: 'direct-text', type: 'text', content: { text: ' \nDiscuss directly  ' }, title: 'Discuss directly' },
    { id: 'direct-post', type: 'post', content: { title: '', content: [
      [{ tag: 'text', text: ' \nAnalyze these captures' }],
      [{ tag: 'img', image_key: 'img_1' }, { tag: 'img', image_key: 'img_2' }],
    ] }, title: 'Analyze these captures' },
    { id: 'direct-image', type: 'image', content: { image_key: 'img_only' }, title: '新讨论' },
    { id: 'direct-file', type: 'file', content: { file_key: 'file_only', file_name: 'capture.log' }, title: '新讨论' },
  ];
  for (const [index, input] of cases.entries()) {
    const raw = { sender: { sender_type: 'user', sender_id: { open_id: owner } }, message: {
      message_id: input.id, chat_id: 'oc_private', chat_type: 'p2p', create_time: String(Date.now()),
      message_type: input.type, content: JSON.stringify(input.content),
    } };
    await dispatch(raw); await dispatch(raw); await tickWithCoordinator(loop);
    assert.equal(groups.length, 0);
    assert.equal(loop.store.taskForSource(`feishu:new:${input.id}`), null);
  }
  assert.equal(downloads.length, 0); assert.equal(loop.tasks().length, 0);
  await loop.collect(); await loop.tick();
  const coordinator = loop.tasks().find(task => loop.projects.ledger.membership(task.id)?.role === 'coordinator');
  assert.ok(coordinator?.threadId && coordinator.chatId); assert.equal(groups.length, 1);
  const raw = { sender: { sender_type: 'user', sender_id: { open_id: owner } }, message: {
    message_id: 'project-input', chat_id: coordinator.chatId, chat_type: 'group', create_time: String(Date.now()),
    message_type: 'text', content: JSON.stringify({ text: 'Investigate this project requirement' }),
  } };
  await dispatch(raw); await dispatch(raw); await loop.tick();
  assert.equal(loop.store.inputs(coordinator.id).filter(input => input.id === 'project-input').length, 1);
  assert.ok((await codex.inspect(coordinator.threadId)).seenInputIds.includes('project-input'));
  assert.equal(loop.tasks().length, 1); assert.equal(downloads.length, 0);
  assert.ok(!historyChats.includes('oc_private')); assert.deepEqual(errors, []);
});
test('Feishu progress uses CardKit streaming plain text, stable message UUID and shared update sequences', async () => {
  const api = fakeApi();
  const requests: unknown[] = [];
  const cardkit: NonNullable<FeishuDependencies['cardkit']> = {
    card: {
      create: async payload => { requests.push(payload); return { code: 0, data: { card_id: 'card' } }; },
      idConvert: async () => ({ code: 0, data: { card_id: 'card' } }),
      settings: async payload => { requests.push(payload); return { code: 0, data: {} }; },
    },
    cardElement: { content: async payload => { requests.push(payload); return { code: 0, data: {} }; } },
  };
  api.message.create = async payload => { requests.push(payload); return { code: 0, data: { message_id: 'message' } }; };
  const feishu = new FeishuAdapter(options, { api, cardkit });
  const text = '<at id=all>tool output</at> [link](https://example.com)';
  assert.equal(await feishu.createProgressCard({ content: text, dashboardUrl: 'http://localhost:8787/' }), 'card');
  const creation = z.object({ data: z.object({ type: z.literal('card_json'), data: z.string() }) }).parse(requests[0]);
  const card = z.object({ schema: z.literal('2.0'), config: z.object({ streaming_mode: z.literal(true), update_multi: z.literal(true) }),
    body: z.object({ elements: z.array(z.unknown()) }) }).parse(JSON.parse(creation.data.data));
  assert.deepEqual(card.body.elements[0], { tag: 'div', text: { tag: 'plain_text', element_id: 'progress', content: text } });
  assert.equal(Buffer.byteLength(creation.data.data) < 30_000, true);
  assert.equal(await feishu.sendProgressCard({ cardId: 'card', chatId: 'chat', uuid: 'stable-uuid' }), 'message');
  assert.deepEqual(requests[1], { params: { receive_id_type: 'chat_id' }, data: { receive_id: 'chat', msg_type: 'interactive',
    content: JSON.stringify({ type: 'card', data: { card_id: 'card' } }), uuid: 'stable-uuid' } });
  await feishu.updateProgressContent({ cardId: 'card', content: text, sequence: 1, uuid: 'op-1' });
  assert.deepEqual(requests[2], { path: { card_id: 'card', element_id: 'progress' }, data: { content: text, sequence: 1, uuid: 'op-1' } });
  await feishu.setProgressStreaming({ cardId: 'card', enabled: false, sequence: 2, uuid: 'op-2' });
  assert.deepEqual(requests[3], { path: { card_id: 'card' }, data: { settings: '{"config":{"streaming_mode":false}}', sequence: 2, uuid: 'op-2' } });
  cardkit.cardElement.content = async () => ({ code: 200770, msg: 'UUID consumed' });
  await assert.rejects(feishu.updateProgressContent({ cardId: 'card', content: text, sequence: 3, uuid: 'op-3' }), /200770/);
  cardkit.card.settings = async () => ({ code: 300317, msg: 'sequence rejected' });
  await assert.rejects(feishu.setProgressStreaming({ cardId: 'card', enabled: false, sequence: 4, uuid: 'op-4' }), /300317/);
  await assert.rejects(feishu.createProgressCard({ content: '🙂'.repeat(10_000) }), /30KB/);
});
function fakeCardkit(): NonNullable<FeishuDependencies['cardkit']> {
  return { card: {
    create: async () => ({ code: 0, data: { card_id: 'card' } }),
    settings: async () => ({ code: 0, data: {} }),
    idConvert: async () => ({ code: 0, data: { card_id: 'other-card' } }),
  }, cardElement: { content: async () => ({ code: 0, data: {} }) } };
}
const progressHistoryItem = { ...historyItem, msg_type: 'interactive', body: { content: JSON.stringify({
  schema: '2.0', header: { title: { tag: 'plain_text', content: '执行进度' } },
}) } };

test('Feishu progress reconciliation paginates and matches exact card identity, not card text', async () => {
  const api = fakeApi(); const cardkit = fakeCardkit();
  const pages: Array<string | undefined> = []; const conversions: string[] = [];
  const candidate = progressHistoryItem;
  api.message.list = async payload => {
    assert.equal(payload?.params.container_id, 'oc_1');
    assert.equal(payload?.params.container_id_type, 'chat');
    assert.equal(payload?.params.start_time, '1769999999');
    assert.equal(payload?.params.sort_type, 'ByCreateTimeAsc');
    assert.equal(payload?.params.page_size, 50);
    assert.equal(payload?.params.card_msg_content_type, 'user_card_content');
    pages.push(payload?.params.page_token);
    return payload?.params.page_token
      ? { code: 0, data: { items: [candidate, { ...candidate, message_id: 'om_original' }], has_more: false } }
      : { code: 0, data: { items: [{ ...historyItem, message_id: 'text' }, candidate], has_more: true, page_token: 'next' } };
  };
  cardkit.card.idConvert = async payload => {
    assert.ok(payload); conversions.push(payload.data.message_id);
    return { code: 0, data: { card_id: payload.data.message_id === 'om_original' ? 'card' : 'different-card' } };
  };
  const adapter = new FeishuAdapter(options, { api, cardkit });
  assert.equal(await adapter.findProgressMessage({ chatId: 'oc_1', cardId: 'card', since: 1770000000123 }), 'om_original');
  assert.deepEqual(pages, [undefined, 'next']);
  assert.deepEqual(conversions, ['om_1', 'om_original']);
  assert.equal(await adapter.findProgressMessage({ chatId: 'oc_1', cardId: 'absent', since: 1770000000123 }), null);
});

test('Feishu progress lookup skips native approvals, unrelated cards and deleted messages', async () => {
  const api = fakeApi(); const cardkit = fakeCardkit();
  let approval = ''; let progress = ''; const conversions: string[] = [];
  api.message.create = async payload => { approval = payload?.data.content ?? ''; return { code: 0, data: { message_id: 'approval' } }; };
  cardkit.card.create = async payload => { progress = payload?.data.data ?? ''; return { code: 0, data: { card_id: 'card' } }; };
  const adapter = new FeishuAdapter(options, { api, cardkit });
  await adapter.sendApproval({ chatId: 'oc_1', id: 'approval', taskId: 'task', request: nativeApproval });
  await adapter.createProgressCard({ content: 'running' });
  api.message.list = async payload => payload?.params.page_token
    ? { code: 0, data: { items: [{ ...progressHistoryItem, message_id: 'original', body: { content: progress } }], has_more: false } }
    : { code: 0, data: { items: [
      { ...progressHistoryItem, message_id: 'approval', body: { content: approval } },
      { ...progressHistoryItem, message_id: 'legacy-title', body: { content: '{"header":{"title":{"tag":"plain_text","content":"执行进度"}}}' } },
      { ...progressHistoryItem, message_id: 'other-title', body: { content: '{"schema":"2.0","header":{"title":{"tag":"plain_text","content":"other"}}}' } },
      { deleted: true }, { ...progressHistoryItem, message_id: 'deleted-card', deleted: true },
    ], has_more: true, page_token: 'next' } };
  cardkit.card.idConvert = async payload => {
    assert.equal(payload?.data.message_id, 'original', 'unrelated cards must never reach idConvert');
    conversions.push(payload.data.message_id); return { code: 0, data: { card_id: 'card' } };
  };
  assert.equal(await adapter.findProgressMessage({ chatId: 'oc_1', cardId: 'card', since: 0 }), 'original');
  assert.deepEqual(conversions, ['original']);
});

test('Feishu queues progress calls without queuing native final or approval sends', async () => {
  const api = fakeApi(); const cardkit = fakeCardkit(); const starts: string[] = [];
  cardkit.card.create = async () => { starts.push('create'); return { code: 0, data: { card_id: 'card' } }; };
  cardkit.card.settings = async () => { starts.push('settings'); return { code: 0, data: {} }; };
  cardkit.cardElement.content = async () => { starts.push('content'); return { code: 0, data: {} }; };
  cardkit.card.idConvert = async () => { starts.push('convert'); return { code: 0, data: { card_id: 'card' } }; };
  api.message.create = async payload => {
    const progress = payload?.data.content === JSON.stringify({ type: 'card', data: { card_id: 'card' } });
    starts.push(progress ? 'send' : 'native'); return { code: 0, data: { message_id: 'sent' } };
  };
  api.message.list = async () => { starts.push('list'); return { code: 0, data: { items: [progressHistoryItem], has_more: false } }; };
  const adapter = new FeishuAdapter(options, { api, cardkit });
  const pending = Promise.all([
    adapter.createProgressCard({ content: 'running' }),
    adapter.sendProgressCard({ chatId: 'oc_1', cardId: 'card', uuid: 'uuid' }),
    adapter.updateProgressContent({ cardId: 'card', content: 'updated', sequence: 1, uuid: 'content' }),
    adapter.setProgressStreaming({ cardId: 'card', enabled: false, sequence: 2, uuid: 'settings' }),
    adapter.findProgressMessage({ chatId: 'oc_1', cardId: 'card', since: 0 }),
  ]);
  await adapter.send({ chatId: 'oc_1', text: 'final', id: 'final' });
  await adapter.sendApproval({ chatId: 'oc_1', id: 'approval', taskId: 'task', request: nativeApproval });
  assert.equal(starts.filter(kind => kind === 'native').length, 2);
  assert.equal(starts.includes('send'), false, 'native sends bypass the pending progress requests');
  assert.equal((await pending)[4], 'om_1');
  assert.deepEqual(starts.filter(kind => kind !== 'native'), ['create', 'send', 'content', 'settings', 'list', 'convert']);
});

test('Feishu progress reconciliation rejects incomplete, failed, repeated and mixed-chat reads', async t => {
  const cases: { name: string; list: NonNullable<FeishuDependencies['api']>['message']['list'] }[] = [
    { name: 'transport failure', list: async () => { throw new Error('connection reset'); } },
    { name: 'API error', list: async () => ({ code: 230099, msg: 'card binding biz count over limit' }) },
    { name: 'missing code', list: async () => ({ data: { items: [], has_more: false } }) },
    { name: 'missing data', list: async () => ({ code: 0 }) },
    { name: 'missing items', list: async () => ({ code: 0, data: { has_more: false } }) },
    { name: 'missing has_more', list: async () => ({ code: 0, data: { items: [] } }) },
    { name: 'missing page token', list: async () => ({ code: 0, data: { items: [], has_more: true } }) },
    { name: 'repeated page token', list: async () => ({ code: 0, data: { items: [], has_more: true, page_token: 'same' } }) },
    { name: 'failed second page', list: async payload => payload?.params.page_token
      ? { code: 999, msg: 'read failed' } : { code: 0, data: { items: [historyItem], has_more: true, page_token: 'next' } } },
    { name: 'missing candidate identity', list: async () => ({ code: 0, data: { items: [{ msg_type: 'interactive', chat_id: 'oc_1' }], has_more: false } }) },
    { name: 'missing message type', list: async () => ({ code: 0, data: { items: [{ message_id: 'om_1', chat_id: 'oc_1' }], has_more: false } }) },
    { name: 'missing card body', list: async () => ({ code: 0, data: { items: [{ message_id: 'om_1', chat_id: 'oc_1', msg_type: 'interactive' }], has_more: false } }) },
    { name: 'invalid card JSON', list: async () => ({ code: 0, data: { items: [{ ...progressHistoryItem, body: { content: '{' } }], has_more: false } }) },
    { name: 'different chat', list: async () => ({ code: 0, data: { items: [{ ...historyItem, chat_id: 'other', msg_type: 'interactive' }], has_more: false } }) },
    { name: 'oversized page', list: async () => ({ code: 0, data: { items: Array.from({ length: 51 }, () => historyItem), has_more: false } }) },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const api = fakeApi(); const cardkit = fakeCardkit(); api.message.list = scenario.list;
    await assert.rejects(new FeishuAdapter(options, { api, cardkit }).findProgressMessage({ chatId: 'oc_1', cardId: 'card', since: 0 }));
  });
});

test('Feishu progress conversion failures remain uncertain and 230099 never acknowledges sending', async t => {
  const conversions: NonNullable<FeishuDependencies['cardkit']>['card']['idConvert'][] = [
    async () => { throw new Error('conversion timeout'); },
    async () => ({ code: 230099, msg: 'card binding biz count over limit' }),
    async () => ({ code: 0 }),
    async () => ({ code: 0, data: {} }),
    async () => ({ code: 0, data: { card_id: '' } }),
  ];
  for (const [index, convert] of conversions.entries()) await t.test(`conversion failure ${index}`, async () => {
    const api = fakeApi(); const cardkit = fakeCardkit(); cardkit.card.idConvert = convert;
    api.message.list = async () => ({ code: 0, data: { items: [progressHistoryItem], has_more: false } });
    const adapter = new FeishuAdapter(options, { api, cardkit });
    await assert.rejects(adapter.findProgressMessage({ chatId: 'oc_1', cardId: 'card', since: 0 }));
    api.message.create = async () => ({ code: 230099, msg: 'card binding biz count over limit' });
    await assert.rejects(adapter.sendProgressCard({ chatId: 'oc_1', cardId: 'card', uuid: 'original' }), /230099/);
  });
});

test('Feishu progress reconciliation bounds aggregate page and conversion requests', async t => {
  for (const candidatesPerPage of [0, 1, 50]) await t.test(`${candidatesPerPage} candidates per page`, async () => {
    const api = fakeApi(); const cardkit = fakeCardkit(); let requests = 0; let page = 0;
    api.message.list = async () => {
      requests++; page++;
      return { code: 0, data: { items: Array.from({ length: candidatesPerPage }, (_, index) => ({
        ...progressHistoryItem, message_id: `message-${page}-${index}`,
      })), has_more: true, page_token: String(page) } };
    };
    cardkit.card.idConvert = async () => { requests++; return { code: 0, data: { card_id: 'other' } }; };
    await assert.rejects(new FeishuAdapter(options, { api, cardkit }).findProgressMessage({ chatId: 'oc_1', cardId: 'card', since: 0 }), /request limit/);
    assert.equal(requests, 12);
  });
});

test('Feishu accepts only the configured user open_id and rejects malformed or unsupported input', () => {
  assert.equal(parseFeishuEvent(event, owner)?.text, 'hello');
  assert.equal(parseFeishuEvent({ ...event, sender: { sender_type: 'app', sender_id: { open_id: owner } } }, owner), null);
  assert.equal(parseFeishuEvent({ ...event, sender: { sender_type: 'user', sender_id: { user_id: owner } } }, owner), null);
  assert.equal(parseFeishuHistory({ ...historyItem, sender: { ...historyItem.sender, id_type: 'user_id' } }, owner), null);
  assert.equal(parseFeishuHistory({ msg_type: 'system' }, owner), null);
  assert.equal(parseFeishuHistory({ deleted: true }, owner), null);
  assert.throws(() => parseFeishuEvent({ ...event, message: { ...event.message, content: '{' } }, owner));
  assert.throws(() => parseFeishuEvent({ ...event, message: { ...event.message, message_type: 'interactive' } }, owner), /Unsupported/);
});
test('Feishu rich posts preserve text and every original image/file resource', () => {
  const message = parseFeishuEvent({ ...event, message: { ...event.message, message_type: 'post', content: JSON.stringify({ zh_cn: {
    title: 'Evidence', content: [[{ tag: 'text', text: 'two captures' }, { tag: 'img', image_key: 'img_1' }, { tag: 'img', image_key: 'img_2' }],
      [{ tag: 'file', file_key: 'file_1', file_name: '../log.txt' }]],
  } }) } }, owner);
  assert.equal(message?.text, 'Evidence\ntwo captures\n');
  assert.deepEqual(message?.attachments, [
    { key: 'img_1', name: 'image', kind: 'image' }, { key: 'img_2', name: 'image', kind: 'image' }, { key: 'file_1', name: '../log.txt', kind: 'file' },
  ]);
});
test('Feishu standalone file messages keep the original archive name', () => {
  const message = parseFeishuEvent({ ...event, message: { ...event.message, chat_type: 'p2p', message_type: 'file',
    content: JSON.stringify({ file_key: 'file_rar', file_name: '新建文件夹 (3) (8).rar' }) } }, owner);
  assert.equal(message?.chatType, 'p2p');
  assert.equal(message?.text, '');
  assert.deepEqual(message?.attachments, [{ key: 'file_rar', name: '新建文件夹 (3) (8).rar', kind: 'file' }]);
});
for (const title of [undefined, '', ' \t']) test(`Feishu rich posts omit blank titles (${JSON.stringify(title)}) without dropping body lines`, () => {
  const post = { title, content: [
    [{ tag: 'text', text: 'Analyze the recording' }],
    [],
    [{ tag: 'text', text: 'Keep this second paragraph.' }],
    [{ tag: 'img', image_key: 'img_1' }],
  ] };
  for (const value of [post, { zh_cn: post }]) {
    const message = parseFeishuEvent({ ...event, message: { ...event.message, chat_type: 'p2p', message_type: 'post', content: JSON.stringify(value) } }, owner);
    assert.ok(message);
    assert.equal(message.text, 'Analyze the recording\n\nKeep this second paragraph.\n');
    assert.deepEqual(message.attachments, [{ key: 'img_1', name: 'image', kind: 'image' }]);
  }
});
test('Feishu group lookup reads every page and recovers only exact task metadata', async () => {
  const api = fakeApi();
  const tokens: Array<string | undefined> = [];
  api.chat.list = async payload => {
    tokens.push(payload?.params?.page_token);
    return payload?.params?.page_token ? { code: 0, data: { items: [{ chat_id: 'oc_existing', description: 'agent-loop:v1:task-1\nhttps://source' }], has_more: false } }
      : { code: 0, data: { items: [{ chat_id: 'oc_other', name: 'same title', description: 'unrelated' }], has_more: true, page_token: 'next' } };
  };
  api.chat.create = async () => { throw new Error('Must not create a duplicate'); };
  const adapter = new FeishuAdapter(options, { api });
  assert.equal(await adapter.ensureGroup({ taskId: 'task-1', title: 'same title', sourceUrl: 'https://source' }), 'oc_existing');
  assert.deepEqual(tokens, [undefined, 'next']);
});
test('Feishu does not create groups after incomplete pagination or duplicate task identity', async () => {
  const api = fakeApi();
  let creates = 0;
  api.chat.create = async () => { creates++; return { code: 0, data: { chat_id: 'oc_new' } }; };
  api.chat.list = async () => ({ code: 0, data: { items: [], has_more: true } });
  const adapter = new FeishuAdapter(options, { api });
  const group = { taskId: 'task-1', title: 'task', sourceUrl: 'https://source' };
  await assert.rejects(adapter.ensureGroup(group), /pagination/);
  api.chat.list = async () => ({ code: 0, data: { items: ['oc_a', 'oc_b'].map(chat_id => ({ chat_id, description: 'agent-loop:v1:task-1\nhttps://source' })), has_more: false } });
  await assert.rejects(adapter.ensureGroup(group), /Multiple/);
  assert.equal(creates, 0);
});
test('Feishu group creation and sends use stable UUIDs and private owner membership', async () => {
  const api = fakeApi();
  const groupUuids: Array<string | undefined> = [];
  const messageUuids: Array<string | undefined> = [];
  api.chat.create = async payload => {
    assert.equal(payload?.data?.owner_id, owner);
    assert.deepEqual(payload?.data?.user_id_list, [owner]);
    assert.equal(payload?.data?.chat_type, 'private');
    assert.equal(payload?.data?.description, 'agent-loop:v1:task-1\nhttps://source');
    groupUuids.push(payload?.params?.uuid);
    return { code: 0, data: { chat_id: 'oc_new' } };
  };
  api.message.create = async payload => { messageUuids.push(payload?.data.uuid); return { code: 0, data: { message_id: 'om_sent' } }; };
  const adapter = new FeishuAdapter(options, { api });
  for (let index = 0; index < 2; index++) {
    await adapter.ensureGroup({ taskId: 'task-1', title: 'task', sourceUrl: 'https://source' });
    await adapter.send({ id: 'delivery-1', chatId: 'oc_new', text: 'hello' });
  }
  assert.equal(groupUuids[0], groupUuids[1]);
  assert.match(groupUuids[0] ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(messageUuids[0], messageUuids[1]);
});
test('Feishu write response loss is uncertain and never retried by the adapter', async () => {
  const api = fakeApi();
  let sends = 0;
  api.message.create = async () => { sends++; throw new Error('connection reset'); };
  const adapter = new FeishuAdapter(options, { api });
  await assert.rejects(adapter.send({ id: 'delivery', chatId: 'oc_1', text: 'hello' }), UncertainOperationError);
  assert.equal(sends, 1);
  api.chat.create = async () => ({ code: 0 });
  await assert.rejects(adapter.ensureGroup({ taskId: 'task', title: 'task', sourceUrl: 'source' }), UncertainOperationError);
});
test('Feishu history reads all pages, rejects mixed chats, and deduplicates overlap', async () => {
  const api = fakeApi();
  api.message.list = async payload => payload?.params.page_token
    ? { code: 0, data: { items: [historyItem, { ...historyItem, message_id: 'om_2' }], has_more: false } }
    : { code: 0, data: { items: [historyItem], has_more: true, page_token: 'next' } };
  const adapter = new FeishuAdapter(options, { api });
  const messages = await adapter.history({ chatId: 'oc_1', since: 1770000000000 });
  assert.deepEqual(messages.map(message => message.id), ['om_1', 'om_2']);
  await assert.rejects(adapter.history({ chatId: 'oc_other', since: 0 }), /different group/);
});
test('Feishu attachment downloads preserve bytes and remove oversized partial files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-loop-files-'));
  try {
    const api = fakeApi();
    const adapter = new FeishuAdapter(options, { api });
    const input = { messageId: 'om_1', attachment: { key: 'file_1', name: '../../outside.log', kind: 'file' as const }, destination: join(directory, 'safe.log'), maxBytes: 100 };
    await adapter.download(input);
    assert.equal(await readFile(input.destination, 'utf8'), 'original');
    await assert.rejects(adapter.download({ ...input, destination: join(directory, 'oversize.log'), maxBytes: 3 }), /exceeds/);
    assert.deepEqual(await readdir(directory), ['safe.log']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('Feishu long connection dispatcher delivers original messages and surfaces decode errors', async () => {
  const received: string[] = [];
  const errors: unknown[] = [];
  let closed = false;
  const adapter = new FeishuAdapter(options, { api: fakeApi(), socket: {
    start: async ({ eventDispatcher }) => {
      const handler = eventDispatcher.handles.get('im.message.receive_v1');
      assert.ok(handler);
      await handler(event);
      await assert.rejects(handler({ ...event, message: { ...event.message, content: '{' } }));
    }, close: () => { closed = true; },
  } });
  await adapter.start(async message => { received.push(message.id); }, error => errors.push(error));
  assert.deepEqual(received, ['om_1']);
  assert.equal(errors.length, 1);
  await adapter.close();
  assert.equal(closed, true);
});

test('uncertain group creation never creates a replacement when reconciliation finds no group', async () => {
  const api = fakeApi();
  let created = 0;
  api.chat.create = async () => { created++; return { code: 0, data: { chat_id: 'new' } }; };
  const adapter = new FeishuAdapter(options, { api });
  await assert.rejects(adapter.ensureGroup({ taskId: 'task', title: 'task', sourceUrl: 'source', reconcileOnly: true }), UncertainOperationError);
  assert.equal(created, 0);
});

test('Feishu preserves private new-task input and treats group text as ordinary messages', () => {
  for (const chatType of ['p2p', 'group']) {
    const message = parseFeishuEvent({ ...event, message: { ...event.message,
      chat_type: chatType, content: JSON.stringify({ text: 'discuss this' }) } }, owner);
    assert.equal(message?.chatType, chatType);
    assert.equal(message?.text, 'discuss this');
    assert.equal(message?.id, 'om_1');
  }
  assert.equal(parseFeishuEvent(event, owner)?.chatType, 'group');
  assert.equal(parseFeishuHistory(historyItem, owner)?.chatType, 'group');
  assert.throws(() => parseFeishuEvent({ ...event, message: { ...event.message, chat_type: 'topic' } }, owner));
});

test('manual groups have stable task identity without a source URL', async () => {
  const api = fakeApi();
  let description = '';
  api.chat.create = async payload => {
    description = payload?.data?.description ?? '';
    assert.equal(description, 'agent-loop:v1:manual-task\n');
    return { code: 0, data: { chat_id: 'oc_manual' } };
  };
  const adapter = new FeishuAdapter(options, { api });
  assert.equal(await adapter.ensureGroup({ taskId: 'manual-task', title: 'Discuss' }), 'oc_manual');
  api.chat.list = async () => ({ code: 0, data: { items: [{ chat_id: 'oc_manual', description }], has_more: false } });
  assert.equal(await adapter.ensureGroup({ taskId: 'manual-task', title: 'New title', sourceUrl: 'private message om_1' }), 'oc_manual');
});

const nativeApproval: PendingRequest = { id: 'request-1', threadId: 'thread-1', turnId: 'turn-1', kind: 'approval',
  prompt: 'Allow the command git status in /workspace?', method: 'item/commandExecution/requestApproval',
  payload: { command: 'git status' }, isBlocking: true, connectionEpoch: 'epoch-1' };
const cardSchema = z.object({ elements: z.array(z.union([
  z.object({ tag: z.literal('div'), text: z.object({ content: z.string() }) }),
  z.object({ tag: z.literal('action'), actions: z.array(z.object({ value: z.object({ agent_loop_approval: z.string() }) })) }),
])) });
async function approvalCard(api: NonNullable<FeishuDependencies['api']>, request = nativeApproval) {
  let content = '';
  const uuids: Array<string | undefined> = [];
  api.message.create = async payload => {
    assert.equal(payload?.data.msg_type, 'interactive');
    assert.equal(payload?.data.receive_id, 'oc_1');
    uuids.push(payload?.data.uuid);
    content = payload?.data.content ?? '';
    return { code: 0, data: { message_id: 'om_card' } };
  };
  const adapter = new FeishuAdapter(options, { api });
  await adapter.sendApproval({ chatId: 'oc_1', id: 'approval-card', taskId: 'task-1', request });
  const card = cardSchema.parse(JSON.parse(content));
  const actionRow = card.elements.find(element => element.tag === 'action');
  assert.ok(actionRow && actionRow.tag === 'action');
  assert.equal(actionRow.actions.length, 2);
  assert.ok(card.elements.some(element => element.tag === 'div' && element.text.content === request.prompt));
  return { values: actionRow.actions.map(button => button.value), uuids, adapter };
}
function click(value: unknown, actor = owner, chatId = 'oc_1') {
  return { operator: { open_id: actor }, context: { open_chat_id: chatId, open_message_id: 'om_card' }, action: { tag: 'button', value } };
}
const approvalFailureResponse = { toast: { type: 'error', content: '此次点击未被接收，请查看最新审批状态。' } };
const approvalResponseSchema = z.object({
  toast: z.object({ type: z.literal('info'), content: z.string() }),
  card: z.object({ type: z.literal('raw'), data: cardSchema.extend({
    config: z.object({ wide_screen_mode: z.literal(true) }),
    header: z.object({ title: z.object({ tag: z.literal('plain_text'), content: z.string().min(1) }) }),
  }) }),
});

test('Feishu approval cards authenticate request-bound decisions after adapter restart', async () => {
  const { values, uuids, adapter } = await approvalCard(fakeApi());
  const first = values[0];
  const second = values[1];
  assert.ok(first && second);
  assert.notEqual(first.agent_loop_approval, second.agent_loop_approval);
  assert.ok(!first.agent_loop_approval.includes(nativeApproval.id));
  await adapter.sendApproval({ chatId: 'oc_1', id: 'approval-card', taskId: 'task-1', request: nativeApproval });
  assert.equal(uuids[0], uuids[1]);
  const received: ApprovalAction[] = [];
  const errors: unknown[] = [];
  const restarted = new FeishuAdapter(options, { api: fakeApi(), socket: {
    start: async ({ eventDispatcher }) => {
      const handle = (value: unknown) => eventDispatcher.invoke({ schema: '2.0',
        header: { event_type: 'card.action.trigger' }, event: value }, { needCheck: false });
      for (const [value, decision] of [[first, '批准'], [second, '拒绝']] as const) {
        const response = approvalResponseSchema.parse(await handle(click(value)));
        assert.match(response.toast.content, /已接收.*等待执行器确认/);
        assert.ok(response.toast.content.includes(decision));
        assert.ok(response.card.data.elements.every(element => element.tag !== 'action'));
        const text = response.card.data.elements.flatMap(element => element.tag === 'div' ? [element.text.content] : []).join('\n');
        assert.ok(text.includes(decision));
        assert.match(text, /已接收.*等待执行器确认/);
        assert.match(text, /执行进度/);
        assert.doesNotMatch(JSON.stringify(response), /agent_loop_approval|git status|test-secret|已完成|已确认/);
      }
      await handle(click(first));
      assert.deepEqual(await handle(click(first, 'ou_wrong')), { toast: { type: 'warning', content: '此操作仅限任务所有者' } });
      for (const attempt of [
        { ...click(first), open_chat_id: 'oc_wrong' }, click(first, owner, 'oc_wrong'),
        click({ agent_loop_approval: first.agent_loop_approval.slice(0, -8) + 'AAAAAAAA' }),
        click({ decision: 'approve', requestId: nativeApproval.id }),
      ]) assert.deepEqual(await handle(attempt), approvalFailureResponse);
    }, close: () => {},
  } });
  await restarted.start(async () => assert.fail('An action cannot become chat input'), error => errors.push(error), async action => { received.push(action); });
  assert.equal(errors.length, 4);
  assert.deepEqual(received.map(action => action.decision), ['approve', 'reject', 'approve']);
  assert.deepEqual(received[0], { id: 'approval-card:approve', taskId: 'task-1', chatId: 'oc_1', senderId: owner,
    threadId: 'thread-1', turnId: 'turn-1', requestId: 'request-1', epoch: 'epoch-1', decision: 'approve' });
  assert.equal(received[2]?.id, received[0]?.id);
  for (const error of errors) {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(String(error), /agent_loop_approval|AAAAAAAA|test-secret|git status/);
  }
});

test('Feishu approval failures return a stable toast and safe diagnostics even when reporting throws', async t => {
  const { values } = await approvalCard(fakeApi());
  const value = values[0];
  assert.ok(value);
  for (const failure of ['duplicate', 'stale', 'persistence', 'diagnostics']) await t.test(failure, async () => {
    const errors: unknown[] = [];
    let actions = 0;
    const before = Date.now();
    const adapter = new FeishuAdapter(options, { api: fakeApi(), socket: {
      start: async ({ eventDispatcher }) => {
        const response = await eventDispatcher.invoke({ schema: '2.0',
          header: { event_type: 'card.action.trigger', event_id: `event-${failure}`, token: 'private-header-token' },
          event: click(value) }, { needCheck: false });
        assert.deepEqual(response, approvalFailureResponse);
      }, close: () => {},
    } });
    await adapter.start(async () => assert.fail('An action cannot become chat input'), error => {
      errors.push(error);
      if (failure === 'diagnostics') throw new Error('private-diagnostic-error');
    }, async () => { actions++; throw new Error(`${failure}: private-handler-error git status test-secret`); });
    assert.equal(actions, 1);
    assert.equal(errors.length, 1);
    const error = errors[0];
    assert.ok(error instanceof Error);
    assert.doesNotMatch(String(error), /private-|git status|test-secret|agent_loop_approval/);
    assert.ok(!String(error).includes(value.agent_loop_approval));
    const context = z.object({
      taskId: z.literal('task-1'), threadId: z.literal('thread-1'), turnId: z.literal('turn-1'),
      requestId: z.literal('request-1'), decision: z.literal('approve'), eventId: z.literal(`event-${failure}`),
      receivedAt: z.number(), durationMs: z.number().nonnegative(),
    }).parse(JSON.parse(error.message.slice(error.message.indexOf('{'))));
    assert.ok(context.receivedAt >= before && context.receivedAt <= Date.now());
  });
});

test('Feishu approval callbacks wait for durable receipt before returning success', async () => {
  const { values } = await approvalCard(fakeApi());
  const value = values[0];
  assert.ok(value);
  let enter = () => {}; let release = () => {};
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const receipt = new Promise<void>(resolve => { release = resolve; });
  const adapter = new FeishuAdapter(options, { api: fakeApi(), socket: {
    start: async ({ eventDispatcher }) => {
      let settled = false;
      const response = eventDispatcher.invoke({ schema: '2.0', header: { event_type: 'card.action.trigger' },
        event: click(value) }, { needCheck: false }).finally(() => { settled = true; });
      try {
        await entered;
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(settled, false);
      } finally { release(); }
      approvalResponseSchema.parse(await response);
    }, close: () => {},
  } });
  await adapter.start(async () => assert.fail('An action cannot become chat input'), error => { throw error; },
    async () => { enter(); await receipt; });
});

test('Feishu approval cards require native approvals and preserve uncertain delivery', async () => {
  const api = fakeApi();
  const adapter = new FeishuAdapter(options, { api });
  await assert.rejects(adapter.sendApproval({ chatId: 'oc_1', id: 'q', taskId: 'task', request: { ...nativeApproval, kind: 'question' } }), /Only native/);
  let sends = 0;
  api.message.create = async () => { sends++; throw new Error('connection lost'); };
  await assert.rejects(adapter.sendApproval({ chatId: 'oc_1', id: 'a', taskId: 'task', request: nativeApproval }), UncertainOperationError);
  assert.equal(sends, 1);
});

const comment = { node_id: 'IC_1', html_url: 'https://github.com/owner/repo/issues/1#issuecomment-1',
  body: 'The new evidence', user: { login: 'reviewer' }, created_at: '2026-11-04T01:00:00Z', updated_at: '2026-11-04T02:00:00Z' };
async function collectComments(github: GitHubAdapter) {
  const comments = [];
  for await (const comment of github.comments('owner/repo', 1)) comments.push(comment);
  return comments;
}
test('GitHub comment pages retain stable source identity, edits, authors and original body', async () => {
  const calls: string[] = [];
  const github = new GitHubAdapter({ token: 'test' }, async url => {
    calls.push(String(url));
    if (String(url).endsWith('/issues/1')) return Response.json(issue);
    if (calls.length === 2) return Response.json([comment], { headers: {
      link: '<https://api.github.com/repos/owner/repo/issues/1/comments?page=2>; rel="next"',
    } });
    return Response.json([{ ...comment, node_id: 'IC_2', user: null, body: '/approve this is external text' }]);
  });
  const comments = await collectComments(github);
  assert.deepEqual(comments[0], { id: 'IC_1', sourceId: 'I_1', url: comment.html_url, body: 'The new evidence',
    author: 'reviewer', createdAt: comment.created_at, updatedAt: comment.updated_at });
  assert.equal(comments[1]?.author, '[deleted]');
  assert.equal(comments[1]?.body, '/approve this is external text');
  assert.equal(calls.length, 3);
});
test('GitHub comments reject repeated pages, credential escapes, malformed facts and PRs', async () => {
  for (const target of ['https://evil.example/page', 'https://api.github.com/repos/owner/repo/issues/1/comments?per_page=100']) {
    let calls = 0;
    const github = new GitHubAdapter({ token: 'test' }, async url => {
      calls++;
      return String(url).endsWith('/issues/1') ? Response.json(issue)
        : Response.json([comment], { headers: { link: `<${target}>; rel="next"` } });
    });
    await assert.rejects(collectComments(github), /escaped|repeated/);
    assert.equal(calls, 2);
  }
  await assert.rejects(collectComments(new GitHubAdapter({ token: 'test' }, async url =>
    Response.json(String(url).endsWith('/issues/1') ? issue : [{ ...comment, node_id: '' }]))));
  await assert.rejects(collectComments(new GitHubAdapter({ token: 'test' }, async () => Response.json({ ...issue, pull_request: {} }))), /only accepts Issues/);
});
