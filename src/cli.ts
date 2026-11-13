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
import { errorMessage, intakeRouteSchema, submissionReceipt, submissionRequestIdSchema, submissionSourceId } from './domain.js';
import { startDashboard } from './dashboard.js';
import { discoverProjects } from './project-discovery.js';

function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function secret(name: string): string { const value = process.env[name]; if (!value) throw new Error(`缺少环境变量 ${name}`); return value; }
const usage = `Agent Loop

  npm start -- doctor --config config.json
  npm start -- collect --config config.json
  npm start -- status --config config.json [--request-id <uuid>]
  npm start -- run --config config.json

doctor validates local configuration without starting execution.
collect persists matching sources for project coordination.
status reads saved request, routing and execution information.
run starts the resident service and debug page.
Every project uses a coordinator. Unknown projects require clarification.
Send new work only in the project group. Only coordinators dispatch Workers.
`;

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
  output({ ready, node: process.version, dataDir: config.dataDir, repositories, discovery, credentials, feishuUserConfigured: userConfigured, codex: { mode: 'shared-daemon', executable: config.codex.executable, socketPath: config.codex.socketPath, model: config.codex.model, modelProvider: config.codex.modelProvider, reasoningEffort: config.codex.reasoningEffort, selectionModel: config.codex.selectionModel }, note: '此检查未验证远端权限，也未创建群或启动 Codex 任务。' });
  if (!ready) process.exitCode = 1;
}
async function main(): Promise<void> {
  const args = parseArgs({ options: { config: { type: 'string', default: 'config.json' }, 'env-file': { type: 'string', default: '.env' }, help: { type: 'boolean', short: 'h' },
    'request-id': { type: 'string' } }, allowPositionals: true });
  const command = args.positionals[0];
  if (args.values.help || !command) { process.stdout.write(usage); return; }
  if (!['doctor', 'collect', 'status', 'run'].includes(command)) throw new Error(`未知命令 ${command}`);
  if (args.positionals.length !== 1) throw new Error('多余的位置参数');
  if (args.values['request-id'] && command !== 'status') throw new Error('--request-id 只适用于 status');
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
        try {
          const task = store.taskForSource(submissionSourceId(id));
          const route = task ? store.meta(`project-intake-route:${task.id}`) : null;
          output(task ? submissionReceipt(task, route ? intakeRouteSchema.parse(JSON.parse(route)) : null) : missing);
        }
        finally { store.close(); }
      } catch (error) {
        process.stderr.write(`${JSON.stringify({ requestId, error: { code: 'invalid_input', message: errorMessage(error) } })}\n`); process.exitCode = 1;
      }
      return;
    }
    try { await stat(join(config.dataDir, 'tasks.sqlite')); } catch { output({ tasks: [], diagnostics: [], note: '尚未建立任务数据库' }); return; }
    const store = new Store(config.dataDir, { readOnly: true });
    try { output({ tasks: store.tasks().map(task => ({ id: task.id, source: task.source.kind === 'github' ? task.source.issue.url : task.sourceId, status: task.status, reason: task.reason, chatId: task.chatId, threadId: task.threadId, resources: task.resources, messages: store.inputs(task.id).map(item => ({ id: item.id, status: item.status, error: item.error })), outgoing: store.outputs(task.id).map(item => ({ id: item.id, status: item.status, error: item.error })) })), diagnostics: store.diagnostics() }); }
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
  });
  if (command === 'collect') {
    try { await loop.collect(); output({ collectedTasks: loop.tasks().filter(task => loop.projects.ledger.membership(task.id)?.role !== 'coordinator').length, diagnostics: loop.store.diagnostics() }); if (loop.store.diagnostics().length) process.exitCode = 1; }
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
