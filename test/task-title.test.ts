import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import type { IncomingMessage } from '../src/domain.js';
import type { CodexPort, WorkspacePort } from '../src/ports.js';
import { CodexFake, FeishuFake, GitHubFake } from './fakes.js';

type TitleRequest = Parameters<NonNullable<CodexPort['summarizeTitle']>>[0];

async function fixture(t: TestContext, summarize?: (input: TitleRequest) => Promise<string>) {
  const root = await mkdtemp(join(tmpdir(), 'agent-title-'));
  const config = configSchema.parse({ dataDir: root, feishu: { userOpenId: 'owner' }, recovery: { maxAttempts: 3, retryDelayMs: 1 } });
  config.codex.titleTimeoutMs = 50;
  const feishu = new FeishuFake(), codex = new CodexFake();
  const requests: TitleRequest[] = [];
  if (summarize) Object.assign(codex, { summarizeTitle: async (input: TitleRequest) => { requests.push(input); return summarize(input); } });
  const groups: string[] = [];
  const ensureGroup = feishu.ensureGroup.bind(feishu);
  feishu.ensureGroup = async input => { groups.push(input.title); return ensureGroup(input); };
  const workspace: WorkspacePort = { async ensure(input) { const path = join(root, input.taskId); await mkdir(path, { recursive: true }); return path; }, async head() { return 'head'; } };
  const loop = new AgentLoop(config, { github: new GitHubFake(), feishu, codex, workspace });
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  const message = (id: string, text: string): IncomingMessage => ({ id, text, chatId: 'private', chatType: 'p2p', senderId: 'owner', attachments: [], createdAt: Date.now() });
  return { loop, feishu, codex, requests, groups, message };
}

const issueExample = 'opentest插件版本 2.4.1分支 目前不支持后处理 帮我分析定位根因';

test('group name summarizes the issue #12 request while the task keeps its original text', async t => {
  const f = await fixture(t, async () => '「2.4.1 后处理根因定位。」');
  await f.loop.receive(f.message('issue-12', issueExample));
  const task = f.loop.tasks()[0]; assert.ok(task?.chatId);
  assert.deepEqual(f.groups, ['2.4.1 后处理根因定位']);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.text, issueExample);
  assert.deepEqual(f.codex.starts[0]?.input[0], { kind: 'text', text: issueExample });
  assert.ok(f.feishu.sent.some(output => output.chatId === task.chatId && output.text.includes('2.4.1 后处理根因定位')));
});

for (const [name, summarize] of [
  ['fails', async () => { throw new Error('model unavailable'); }],
  ['times out', (input: TitleRequest) => new Promise<string>((_, reject) => input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))],
  ['returns an empty title', async () => ' 「」 '],
] as const) test(`group name falls back to the task text when summarization ${name}`, async t => {
  const f = await fixture(t, summarize);
  await f.loop.receive(f.message(`fallback-${name}`, issueExample));
  assert.ok(f.loop.tasks()[0]?.chatId);
  assert.deepEqual(f.groups, [issueExample]);
  assert.deepEqual(f.codex.starts[0]?.input[0], { kind: 'text', text: issueExample });
});

test('a short single-line request names its group directly without a model call', async t => {
  const f = await fixture(t, async () => 'unused');
  await f.loop.receive(f.message('short', '/new 排查重连超时'));
  assert.deepEqual(f.groups, ['排查重连超时']);
  assert.equal(f.requests.length, 0);
});

test('long colloquial requests are summarized and over-long model titles are capped by display width', async t => {
  const colloquial = '那个，帮我看一下 agent loop 这个工程吧，就是最近飞书里面新开的任务群名字特别长，列表里根本看不出来是干嘛的，能不能想办法让它短一点，顺便别把原始任务内容改了';
  const f = await fixture(t, async () => 'Agent Loop 飞书任务群名称过长导致列表中无法识别核心任务问题修复');
  await f.loop.receive(f.message('colloquial', colloquial));
  const title = f.groups[0]; assert.ok(title);
  assert.ok(title.startsWith('Agent Loop 飞书任务群'));
  assert.ok([...title].reduce((width, char) => width + (/[\u2e80-\uffff]/.test(char) ? 2 : 1), 0) <= 32);
  assert.deepEqual(f.codex.starts[0]?.input[0], { kind: 'text', text: colloquial });
});

