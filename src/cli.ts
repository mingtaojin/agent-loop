import { parseArgs } from 'node:util';
import { access, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig, type Config } from './config.js';
import { AgentLoop } from './loop.js';
import { WorkspaceProvider } from './workspace.js';
import { GitHubAdapter } from './adapters/github.js';
import { FeishuAdapter } from './adapters/feishu.js';
import { CodexAppServer } from './adapters/codex.js';
import { Store } from './store.js';
import { errorMessage, submissionReceipt, submissionRequestIdSchema, submissionSourceId } from './domain.js';
import { parseSubmission, readSubmissionPrompt, submitPrompt, SubmissionError } from './submission.js';
import { startDashboard } from './dashboard.js';
import { discoverProjects } from './project-discovery.js';

function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function secret(name: string): string { const value = process.env[name]; if (!value) throw new Error(`缺少环境变量 ${name}`); return value; }
const usage = `Agent Loop\n\n  npm start -- doctor --config config.json\n  npm start -- collect --config config.json\n  npm start -- status --config config.json [--request-id <lowercase-uuid>]\n  npm start -- submit --config config.json --request-id <lowercase-uuid> --prompt-file <path|->\n  npm start -- run --config config.json\n\ndoctor 检查本地配置与凭证是否存在，不启动任务。\ncollect 仅收集并核对来源，不启动新任务。\nstatus 查看持久化任务、消息和最近异常，或按请求身份查询回执。\nsubmit 从 UTF-8 文件或标准输入创建独立任务，返回 JSON 持久化回执。保留请求身份用于重试。\nrun 启动常驻服务和只读调试网页，自动执行符合条件的任务。\n所有者直接私聊飞书机器人发送文字、图文、截图或日志文件，无需命令前缀。\n每条不同的非空私聊消息各自创建独立任务群；后续在对应群继续，工具审批使用独立按钮。\n`;
async function doctor(config: Config): Promise<void> {
  const credentials = [...(config.repositories.length ? [config.github.tokenEnv] : []), config.feishu.appIdEnv, config.feishu.appSecretEnv].map(name => ({ name, present: Boolean(process.env[name]) }));
  const repositories = await Promise.all(config.repositories.map(async repository => {
    if (!('path' in repository)) return { name: repository.name, criteria: repository.criteria, sourceOnly: true, exists: true };
    const details = { name: repository.name, path: repository.path, baseBranch: repository.baseBranch,
      ...(repository.workspace ? { workspace: repository.workspace } : {}) };
    try {
      await access(repository.path);
      if (repository.workspace?.kind === 'project-directory' && !(await stat(repository.workspace.path)).isDirectory()) throw new Error('Project workspace must be a directory');
      return { ...details, exists: true };
    } catch { return { ...details, exists: false }; }
  }));
  const projectRoot = config.engineering?.projectRoot;
  const discovery = projectRoot ? await discoverProjects(projectRoot).then(
    projects => ({ projectRoot, readable: true, projects }),
    error => ({ projectRoot, readable: false, error: errorMessage(error) }),
  ) : null;
  const userConfigured = !config.feishu.userOpenId.startsWith('REPLACE_');
  const ready = credentials.every(item => item.present) && repositories.every(item => item.exists) && userConfigured && discovery?.readable !== false;
  output({ ready, node: process.version, dataDir: config.dataDir, repositories, discovery, credentials, feishuUserConfigured: userConfigured, codexCommand: config.codex.command, note: '此检查未验证远端权限，也未创建群或启动 Codex 任务。' });
  if (!ready) process.exitCode = 1;
}
async function main(): Promise<void> {
  const args = parseArgs({ options: { config: { type: 'string', default: 'config.json' }, 'env-file': { type: 'string', default: '.env' }, help: { type: 'boolean', short: 'h' },
    'prompt-file': { type: 'string' }, 'request-id': { type: 'string' } }, allowPositionals: true });
  const command = args.positionals[0];
  if (args.values.help || !command) { process.stdout.write(usage); return; }
  if (!['doctor', 'collect', 'status', 'submit', 'run'].includes(command)) throw new Error(`未知命令 ${command}`);
  if (args.positionals.length !== 1) throw new Error('多余的位置参数');
  if (command === 'submit') {
    const requestId = args.values['request-id'] ?? null;
    try {
      if (!requestId || !args.values['prompt-file']) throw new SubmissionError('invalid_input', 'submit requires --request-id <lowercase-uuid> and --prompt-file <path|->', requestId);
      const config = await loadConfig(resolve(args.values.config));
      const prompt = await readSubmissionPrompt(args.values['prompt-file'], config.submission.maxPromptBytes);
      const input = parseSubmission({ requestId, prompt }, config.submission.maxPromptBytes);
      output(await submitPrompt({ dataDir: config.dataDir, settings: config.submission, input }));
    } catch (error) {
      const failure = error instanceof SubmissionError ? new SubmissionError(error.code, error.message, requestId)
        : new SubmissionError('invalid_input', errorMessage(error), requestId);
      process.stderr.write(`${JSON.stringify(failure.toJSON())}\n`); process.exitCode = 1;
    }
    return;
  }
  if (args.values['prompt-file'] || (args.values['request-id'] && command !== 'status')) throw new Error('提交参数只适用于 submit 或 status --request-id');
  const config = await loadConfig(resolve(args.values.config));
  if (command === 'status') {
    if (args.values['request-id']) {
      const requestId = args.values['request-id'];
      try {
        const id = submissionRequestIdSchema.parse(requestId);
        const missing = { requestId, taskId: null, status: 'not_found', reason: null, chatId: null, threadId: null };
        try { await stat(join(config.dataDir, 'tasks.sqlite')); }
        catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { output(missing); return; } throw error; }
        const store = new Store(config.dataDir, { readOnly: true });
        try { const task = store.taskForSource(submissionSourceId(id)); output(task ? submissionReceipt(task) : missing); }
        finally { store.close(); }
      } catch (error) {
        process.stderr.write(`${JSON.stringify(new SubmissionError('invalid_input', errorMessage(error), requestId).toJSON())}\n`); process.exitCode = 1;
      }
      return;
    }
    try { await stat(join(config.dataDir, 'tasks.sqlite')); } catch { output({ tasks: [], diagnostics: [], note: '尚未建立任务数据库' }); return; }
    const store = new Store(config.dataDir, { readOnly: true });
    try { output({ tasks: store.tasks().map(task => ({ id: task.id, source: task.source.kind === 'github' ? task.source.issue.url : task.sourceId, status: task.status, reason: task.reason, chatId: task.chatId, threadId: task.threadId, resources: task.resources, messages: store.inputs(task.id).map(item => ({ id: item.id, status: item.status, error: item.error, disposition: item.disposition ?? null })), outgoing: store.outputs(task.id).map(item => ({ id: item.id, status: item.status, error: item.error })) })), diagnostics: store.diagnostics() }); }
    finally { store.close(); }
    return;
  }
  const envFile = resolve(args.values['env-file']);
  try { await access(envFile); process.loadEnvFile(envFile); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT' && args.values['env-file'] === '.env')) throw error; }
  if (command === 'doctor') { await doctor(config); return; }
  const token = config.repositories.length ? secret(config.github.tokenEnv) : '';
  if (command === 'run' && config.feishu.userOpenId.startsWith('REPLACE_')) throw new Error('请先配置飞书用户 open_id');
  const loop = new AgentLoop(config, {
    github: new GitHubAdapter({ token, apiUrl: config.github.apiUrl, requestTimeoutMs: config.github.requestTimeoutMs }),
    feishu: new FeishuAdapter({ appId: command === 'run' ? secret(config.feishu.appIdEnv) : '', appSecret: command === 'run' ? secret(config.feishu.appSecretEnv) : '', userOpenId: config.feishu.userOpenId }),
    codex: new CodexAppServer({ ...config.codex, env: Object.fromEntries(Object.entries(process.env).filter(([name]) => ![config.feishu.appIdEnv, config.feishu.appSecretEnv].includes(name))) }), workspace: new WorkspaceProvider(config.dataDir),
  }, undefined, { configPath: resolve(args.values.config) });
  if (command === 'collect') {
    try { await loop.collect(); output({ collectedTasks: loop.tasks().length, diagnostics: loop.store.diagnostics() }); if (loop.store.diagnostics().length) process.exitCode = 1; }
    finally { await loop.close(); }
    return;
  }
  let dashboardStart: ReturnType<typeof startDashboard> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      const results = await Promise.allSettled([
        loop.close(),
        dashboardStart?.then(dashboard => dashboard.close(), () => undefined),
      ]);
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      for (const result of results) if (result.status === 'rejected') {
        process.stderr.write(`${errorMessage(result.reason)}\n`); process.exitCode = 1;
      }
    })();
    return closing;
  };
  const stop = () => { void close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    dashboardStart = startDashboard({ dataDir: config.dataDir, host: config.dashboard.host, port: config.dashboard.port });
    const dashboard = await dashboardStart;
    if (closing) { await closing; return; }
    await loop.start();
    if (closing) { await closing; return; }
    output({ event: 'started', dataDir: config.dataDir, tasks: loop.tasks().length,
      dashboard: { url: dashboard.url, listenAddress: dashboard.listenAddress, networkUrls: dashboard.networkUrls } });
  } catch (error) { await close(); throw error; }
}
main().catch(error => { process.stderr.write(`${errorMessage(error)}\n`); process.exitCode = 1; });
