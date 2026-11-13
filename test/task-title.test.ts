import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import { type IncomingMessage } from '../src/domain.js';
import type { CodexPort, WorkspacePort } from '../src/ports.js';
import { parseTaskTitle, taskTitleMaxWidth } from '../src/task-title.js';
import { testExecution } from './test-config.js';
import { restoreSurface, testProject, workerCalls, SurfaceCodex } from './coordinated-surfaces.js';
import { CodexAppServer } from './helpers/codex.js';
import { FeishuFake, GitHubFake } from './fakes.js';

type TitleRequest = Parameters<NonNullable<CodexPort['summarizeTitle']>>[0];

async function fixture(t: TestContext, summarize?: (input: TitleRequest) => Promise<string>) {
  const root = await mkdtemp(join(tmpdir(), 'agent-title-'));
  const config = configSchema.parse({ execution: testExecution, dataDir: root, projects: [testProject(root)], feishu: { userOpenId: 'owner' }, recovery: { maxAttempts: 2, retryDelayMs: 1 } });
  config.execution.backends.codex.titleTimeoutMs = 50;
  const feishu = new FeishuFake(), codex = new SurfaceCodex();
  const requests: TitleRequest[] = [];
  if (summarize) Object.assign(codex, { summarizeTitle: async (input: TitleRequest) => { requests.push(input); return summarize(input); } });
  const groups: Parameters<FeishuFake['ensureGroup']>[0][] = [];
  const ensureGroup = feishu.ensureGroup.bind(feishu);
  feishu.ensureGroup = async input => { groups.push(input); return ensureGroup(input); };
  const workspace: WorkspacePort = { async ensure(input) { if (input.kind === 'project-directory') return input.directory; const path = join(root, input.resourceId); await mkdir(path, { recursive: true }); return path; }, async head() { return 'head'; } };
  const loop = new AgentLoop(config, { github: new GitHubFake(), feishu, codex, workspace });
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  const message = (id: string, text: string): IncomingMessage => ({ id, text, chatId: 'private', chatType: 'p2p', senderId: 'owner', attachments: [], createdAt: Date.now() });
  const workerTitle = () => groups.find(input => input.title !== 'Fixture 项目协调者')?.title;
  return { loop, feishu, codex, requests, groups, workerTitle, message };
}

const issueExample = 'opentest插件版本 2.4.1分支 目前不支持后处理 帮我分析定位根因';

test('group name summarizes a long request while the worker keeps its original text', async t => {
  const f = await fixture(t, async () => '「2.4.1 后处理根因定位。」');
  await restoreSurface(f.loop, f.message('issue-12', issueExample));
  assert.equal(f.workerTitle(), '2.4.1 后处理根因定位');
  assert.equal(f.requests.length, 1);
  assert.equal(workerCalls(f.loop, f.codex).starts.at(-1)?.input[0]?.text, issueExample);
});

for (const [name, summarize] of [
  ['fails', async () => { throw new Error('model unavailable'); }],
  ['times out', (input: TitleRequest) => new Promise<string>((_, reject) => input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))],
  ['returns an empty title', async () => ' 「」 '],
] as const) test(`group name falls back to the task text when summarization ${name}`, async t => {
  const f = await fixture(t, summarize);
  await restoreSurface(f.loop, f.message(`fallback-${name}`, issueExample));
  assert.equal(f.workerTitle(), issueExample);
  assert.equal(workerCalls(f.loop, f.codex).starts.at(-1)?.input[0]?.text, issueExample);
});

test('a short single-line request names its group directly without a model call', async t => {
  const f = await fixture(t, async () => 'unused');
  await restoreSurface(f.loop, f.message('short', '/new 排查重连超时'));
  assert.equal(f.workerTitle(), '排查重连超时');
  assert.equal(f.requests.length, 0);
});

test('long colloquial requests are summarized and over-long model titles are capped by display width', async t => {
  const colloquial = '那个，帮我看一下 agent loop 这个工程吧，就是最近飞书里面新开的任务群名字特别长，列表里根本看不出来是干嘛的，能不能想办法让它短一点，顺便别把原始任务内容改了';
  const f = await fixture(t, async () => 'Agent Loop 飞书任务群名称过长导致列表中无法识别核心任务问题修复');
  await restoreSurface(f.loop, f.message('colloquial', colloquial));
  const title = f.workerTitle(); assert.ok(title);
  assert.ok(title.startsWith('Agent Loop 飞书任务群'));
  assert.ok([...title].reduce((width, char) => width + (/[⺀-￿]/.test(char) ? 2 : 1), 0) <= taskTitleMaxWidth);
  assert.equal(workerCalls(f.loop, f.codex).starts.at(-1)?.input[0]?.text, colloquial);
});

test('closing the loop cancels an in-flight title summary', async t => {
  let aborted = false;
  const f = await fixture(t, input => new Promise<string>((_, reject) => input.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })));
  const received = f.loop.receive(f.message('shutdown', issueExample));
  const ticking = f.loop.tick();
  await delay(10);
  await f.loop.close();
  await Promise.allSettled([received, ticking]);
  assert.equal(aborted, true);
});

test('model titles lose wrapping quotes, trailing punctuation and extra lines', () => {
  assert.equal(parseTaskTitle('  “2.4.1\n后处理根因定位。” '), '2.4.1 后处理根因定位');
  assert.equal(parseTaskTitle('《#12 群名精简》'), '#12 群名精简');
  assert.equal(parseTaskTitle(' 「」 '), null);
  assert.equal(parseTaskTitle('grill with doc技能触发不佳'), 'grill with doc技能触发不佳');
  assert.equal(parseTaskTitle('一二三四五六七八九十甲乙丙丁戊己庚辛'), '一二三四五六七八九十甲乙丙丁戊己');
});

async function titleServer(t: TestContext, mode: string) {
  const root = await mkdtemp(join(tmpdir(), 'agent-title-codex-'));
  const recordPath = join(root, 'requests.jsonl');
  const server = new CodexAppServer({ command: [process.execPath, resolve('test/fixtures/task-title-codex.mjs'), mode, recordPath], approvalPolicy: 'on-request', sandbox: 'danger-full-access', requestTimeoutMs: 5000 });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const records = async () => (await readFile(recordPath, 'utf8')).trim().split('\n').map(line => z.object({ pid: z.number(), method: z.string().optional(), params: z.unknown().optional() }).parse(JSON.parse(line)));
  return { root, server, records };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('title summary runs in an isolated low-effort read-only ephemeral turn and releases it', async t => {
  const f = await titleServer(t, 'title');
  assert.equal(await f.server.summarizeTitle({ taskId: 'task-1', cwd: f.root, text: issueExample }), '2.4.1 后处理根因定位');
  const rows = await f.records();
  const start = rows.find(row => row.method === 'thread/start');
  assert.deepEqual(z.object({ config: z.object({ model_reasoning_effort: z.string() }) }).parse(start?.params).config, { model_reasoning_effort: 'low' });
  assert.match(JSON.stringify(rows.find(row => row.method === 'turn/start')?.params), new RegExp(issueExample));
  assert.equal(alive(rows[0]!.pid), false);
});

for (const mode of ['malformed', 'slow']) test(`title summary rejects when the model is ${mode} and releases its process`, async t => {
  const f = await titleServer(t, mode);
  const abort = new AbortController();
  const summary = f.server.summarizeTitle({ taskId: 'task-1', cwd: f.root, text: issueExample, signal: abort.signal });
  if (mode === 'slow') {
    while (!(await f.records().catch(() => [])).some(row => row.method === 'turn/start')) await delay(10);
    abort.abort();
  }
  await assert.rejects(summary);
  const rows = await f.records();
  assert.equal(alive(rows[0]!.pid), false);
});
