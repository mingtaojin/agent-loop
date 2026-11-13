import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer } from '../src/adapters/codex.js';
import { configSchema } from '../src/config.js';
import { manualTaskTitle, normalizeManualTaskText } from '../src/domain.js';
import { fitsTaskTitle, parseTaskTitle } from '../src/task-title.js';

const samples = [
  'opentest插件版本 2.4.1分支 目前不支持后处理 帮我分析定位根因',
  '那个，帮我看一下 agent loop 这个工程吧，就是最近飞书里面新开的任务群名字特别长，列表里根本看不出来是干嘛的，能不能想办法让它短一点，顺便别把原始任务内容改了',
  '/new 看下agent loop这个工程，总觉得grill with doc技能触发的不是很好',
  'opentest需要新增一个仪表盘重新分析的功能,a.目前Measure仅支持采集+分析，需要支持已采集信号重新分析功能，包括所有仪表盘\nb.在选定的测试记录中，修改设置栏的参数',
  'Read /Users/developer/.codex/packages/pstack/skills/poteto-mode/SKILL.md in full and use poteto-mode (Bug fix flow). You are the sole write Owner for GitHub Issue mingtaojin/agent-loop#12 "[Bug] 新建任务群聊名称未精简提炼，难以识别核心任务". Goal: new task group names summarize the core problem.',
];

const codex = configSchema.parse({ feishu: { userOpenId: 'verify' } }).execution.backends.codex;
const server = new CodexAppServer({ ...codex, ...(process.env.AGENT_LOOP_TITLE_MODEL ? { model: process.env.AGENT_LOOP_TITLE_MODEL } : {}) });
const cwd = await mkdtemp(join(tmpdir(), 'agent-title-verify-'));
try {
  for (const [index, sample] of samples.entries()) {
    const text = normalizeManualTaskText(sample);
    const before = manualTaskTitle({ text: sample, maxLength: 100 }).slice(0, 80);
    const started = Date.now();
    let raw: string | null = null, error: string | null = null;
    try { raw = await server.summarizeTitle({ taskId: `verify-${index}`, cwd, text, signal: AbortSignal.timeout(codex.titleTimeoutMs) }); }
    catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    const after = raw === null ? before : parseTaskTitle(raw) ?? before;
    console.log(JSON.stringify({ before, raw, after, fits: fitsTaskTitle(after), ms: Date.now() - started, error }));
  }
} finally {
  await server.close();
  await rm(cwd, { recursive: true, force: true });
}
