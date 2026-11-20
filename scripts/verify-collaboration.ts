import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv, promisify } from 'node:util';
import { Client, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { CodexAppServer } from '../src/adapters/codex.js';
import type { CodexConnector } from '../src/adapters/codex-daemon.js';
import { FeishuAdapter } from '../src/adapters/feishu.js';
import { configSchema } from '../src/config.js';
import type { ExecutionEvent } from '../src/execution-events.js';
import { AgentLoop } from '../src/loop.js';
import type { CodexPort, FeishuPort, ProjectRequest } from '../src/ports.js';
import { WorkspaceProvider } from '../src/workspace.js';
import { FeishuFake, GitHubFake } from '../test/fakes.js';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, 'env-file': { type: 'string' }, 'real-feishu': { type: 'boolean', default: false },
  'timeout-ms': { type: 'string', default: '600000' }, 'evidence-dir': { type: 'string' }, help: { type: 'boolean' },
}, strict: true });
if (values.help) {
  process.stdout.write('Usage: npx --no-install tsx scripts/verify-collaboration.ts --config /absolute/config.json --env-file /absolute/.env [--real-feishu] [--timeout-ms 600000] [--evidence-dir /absolute/directory]\nReal Feishu mode creates two test groups and leaves them for review. Without the flag, only the Feishu transport is fake. Both modes use real Codex models. No production service, data directory or Feishu WebSocket is used.\n');
  process.exit(0);
}
const absolutePath = z.string().min(1).refine(isAbsolute, 'An absolute path is required');
const options = z.object({ config: absolutePath, envFile: absolutePath, realFeishu: z.boolean(),
  timeoutMs: z.coerce.number().int().min(30_000).max(1_200_000), evidenceDir: absolutePath.optional(),
}).parse({ config: values.config, envFile: values['env-file'], realFeishu: values['real-feishu'],
  timeoutMs: values['timeout-ms'], evidenceDir: values['evidence-dir'] });
type Outcome = { result: 'passed' } | { result: 'failed' | 'blocked'; error: string };
type ToolCall = { request: ProjectRequest; startedAt: number; callerChatId: string | null } & (
  { status: 'running' } | { status: 'succeeded'; finishedAt: number; result: unknown }
  | { status: 'rejected'; finishedAt: number; error: string }
);
type Group = { taskId: string; chatId: string; title: string };
type SentMessage = { chatId: string; text: string; id: string; messageId: string; at: number };
type Readback = { chatId: string; messageId: string; body: string; messageType: string; createdAt: string };
type Delivery = { method: 'startTurn' | 'steer'; threadId: string; turnId: string; deliveryId: string; at: number;
  sender: ProjectRequest; senderStillActive: boolean };
class ProbeBlocked extends Error {}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const unavailable = (message: string) => /\b(?:credit|quota|billing|auth(?:entication|orization)?|login)\b|not logged|ENOTFOUND|ECONNREFUSED|ENOENT|rate.limit|model.*(?:unavailable|not found)|\b(?:401|403|429|502|503)\b/i.test(message);
const execute = promisify(execFile);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const startedAt = Date.now();
const deadline = startedAt + options.timeoutMs;
const evidenceDirectory = options.evidenceDir ?? join(sourceRoot, '.scratch', 'collaboration', runId);
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-loop-collaboration-')));
const directory = join(root, 'project');
const dataDir = join(root, 'data');
const proofPath = join(directory, 'proof.txt');
const waitPath = join(directory, 'wait.cjs');
const duePath = join(directory, 'due.cjs');
const projectId = `collaboration-${runId}`;
const titlePrefix = `Agent Loop 协作验收 ${runId}`;
const marker = `PROOF_${randomUUID()}`;
const markers = { acknowledged: `ACK_${runId}`, reminder: `REMINDER_${runId}`, commentary: `WORKER_COMMENTARY_${runId}`,
  question: `WORKER_QUESTION_${runId}`, final: `WORKER_FINAL_${runId}`, hidden: `COORDINATOR_HIDDEN_${runId}`,
  direct: `DIRECT_REPLY_${runId}` };
const calls: ToolCall[] = [];
const events: ExecutionEvent[] = [];
const deliveries: Delivery[] = [];
const inputReceipts: { method: Delivery['method']; threadId: string; turnId: string; inputIds: string[]; at: number }[] = [];
const groups: Group[] = [];
const sent: SentMessage[] = [];
const timeline: { at: number; event: string; detail: unknown }[] = [];
const cleanup: { resource: string; result: string }[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const secrets = new Set<string>();
let loop: AgentLoop | undefined;
let codex: CodexAppServer | undefined;
let sdk: Client | undefined;
let fakeFeishu: FeishuFake | undefined;
let outcome: Outcome = { result: 'blocked', error: 'Acceptance did not finish' };
let database: unknown = null;
let runtime: unknown = null;
let sourceAtStart: unknown = null;
let artifact: unknown = null;
let executionProfiles: unknown = null;
let proof: unknown = null;
let readback: Readback[] = [];
let childStderr = '';
const sourceFiles = ['scripts/verify-collaboration.ts', 'src/loop.ts', 'src/project.ts', 'src/project-runtime.ts',
  'src/store.ts', 'src/domain.ts', 'src/adapters/codex.ts', 'src/adapters/feishu.ts', 'prompts/coordinator.md', 'prompts/worker.md'];
const fingerprint = () => Promise.all(sourceFiles.map(async path => ({ path,
  sha256: createHash('sha256').update(await readFile(join(sourceRoot, path))).digest('hex') })));
function sanitized(value: unknown): string {
  let text = JSON.stringify(value, null, 2);
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]') + '\n';
}
function note(event: string, detail: unknown = null): void {
  timeline.push({ at: Date.now(), event, detail });
  process.stdout.write(sanitized({ event, detail }));
}
async function bounded<T>(label: string, work: Promise<T>, until = deadline): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProbeBlocked(`Deadline exceeded during ${label}`)), Math.max(1, until - Date.now()));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function currentLoop(): AgentLoop { assert.ok(loop); return loop; }
function project() {
  const state = currentLoop().projects.ledger.project(projectId);
  assert.ok(state, 'The isolated project must exist');
  return state;
}
function ownedGroup(chatId: string): void {
  assert.ok(groups.some(group => group.chatId === chatId), 'Only newly created acceptance groups may be accessed');
}

class ObservedFeishu extends FeishuAdapter {
  override async ensureGroup(input: Parameters<FeishuPort['ensureGroup']>[0]): Promise<string> {
    assert.ok(currentLoop().tasks().some(task => task.id === input.taskId), 'Group must belong to the isolated runtime');
    const title = `${titlePrefix} ${input.taskId === project().coordinatorTaskId ? '协调者' : 'Worker'}`;
    const chatId = await super.ensureGroup({ ...input, title });
    if (!groups.some(group => group.chatId === chatId)) groups.push({ taskId: input.taskId, chatId, title });
    note('group_ready', { taskId: input.taskId, chatId, title });
    return chatId;
  }
  override async send(input: Parameters<FeishuPort['send']>[0]): Promise<{ messageId: string }> {
    ownedGroup(input.chatId);
    const result = await super.send(input);
    sent.push({ ...input, ...result, at: Date.now() });
    return result;
  }
  override async history(input: Parameters<FeishuPort['history']>[0]) { ownedGroup(input.chatId); return super.history(input); }
  override async dissolveGroup(): Promise<void> { throw new Error('Group deletion is outside this acceptance'); }
  override async download(): Promise<void> { throw new Error('Attachment download is outside this acceptance'); }
  override async sendApproval(): Promise<never> { throw new ProbeBlocked('Unexpected native approval during marker-only acceptance'); }
  override async sendDecisionCard(): Promise<never> { throw new Error('Decision cards are outside this acceptance'); }
  override async start(): Promise<void> { throw new Error('A Feishu WebSocket must not be started by this probe'); }
}

class ObservedCodex extends CodexAppServer {
  override setEventHandler(handler: (event: ExecutionEvent) => void): void {
    super.setEventHandler(event => { events.push(structuredClone(event)); handler(event); });
  }
  override setProjectHandler(handler: (request: ProjectRequest) => Promise<unknown>): void {
    super.setProjectHandler(async request => {
      const caller = currentLoop().tasks().find(task => task.threadId === request.threadId);
      assert.ok(caller, 'Tool caller must belong to the isolated runtime');
      const started = Date.now();
      const index = calls.push({ request: structuredClone(request), startedAt: started, callerChatId: caller.chatId, status: 'running' }) - 1;
      try {
        const call = request.call;
        if (call.tool === 'project_action') {
          const action = call.arguments;
          assert.ok(['status', 'dispatch', 'open_group', 'record', 'schedule_reminder', 'list_reminders'].includes(action.action), `Unauthorized management action ${action.action}`);
          if (action.action === 'dispatch') {
            assert.equal(action.requestId, 'probe-dispatch');
            assert.equal(caller.id, project().coordinatorTaskId);
            assert.ok(project().members.length === 1, 'Exactly one Worker may be created');
          }
          if (action.action === 'open_group') {
            assert.equal(action.requestId, 'probe-worker-group');
            assert.equal(action.taskId, caller.id, 'The Worker must open its own group');
            assert.notEqual(caller.id, project().coordinatorTaskId);
          }
          if (action.action === 'record') assert.ok(['probe-receipt', 'probe-reminder-record'].includes(action.requestId));
          if (action.action === 'schedule_reminder') {
            assert.equal(action.requestId, 'probe-reminder');
            assert.ok(action.dueAt > Date.now(), 'The model must schedule a future reminder');
            assert.ok(action.dueAt < deadline - 15_000, 'Reminder must fall within the acceptance deadline');
          }
        } else if (call.tool === 'send_agent_message') {
          assert.equal(call.arguments.requestId, 'probe-worker-progress');
          assert.equal(call.arguments.taskId, project().coordinatorTaskId);
          assert.equal(caller.chatId, null, 'Worker must send progress before it has a group');
          assert.ok(call.arguments.text.includes(marker), 'Worker must send the exact marker it read');
        } else {
          assert.equal(caller.id, project().coordinatorTaskId, 'Worker ordinary bodies must not use send_group_message');
          assert.ok(['probe-coordinator-ack', 'probe-reminder-group', 'probe-direct-reply'].includes(call.arguments.requestId));
        }
        const result = await handler(request);
        calls[index] = { request: structuredClone(request), startedAt: started, callerChatId: caller.chatId,
          status: 'succeeded', finishedAt: Date.now(), result: structuredClone(result) };
        note('tool_accepted', { tool: call.tool, arguments: call.arguments, threadId: request.threadId, turnId: request.turnId });
        return result;
      } catch (error) {
        calls[index] = { request: structuredClone(request), startedAt: started, callerChatId: caller.chatId,
          status: 'rejected', finishedAt: Date.now(), error: errorText(error) };
        throw error;
      }
    });
  }
  private observeDelivery(method: Delivery['method'], input: Parameters<CodexPort['startTurn']>[0], turnId: string): void {
    inputReceipts.push({ method, threadId: input.threadId, turnId, inputIds: [input.deliveryId, ...input.additionalDeliveryIds ?? []], at: Date.now() });
    const progress = calls.find(call => call.request.call.tool === 'send_agent_message');
    if (!progress || !input.input.some(item => item.kind === 'text' && item.text.includes(marker))) return;
    if (input.threadId !== currentLoop().store.task(project().coordinatorTaskId).threadId) return;
    const delivery = { method, threadId: input.threadId, turnId, deliveryId: input.deliveryId, at: Date.now(),
      sender: progress.request, senderStillActive: this.isActiveTurn(progress.request) };
    deliveries.push(delivery);
    note('coordinator_input_confirmed', delivery);
  }
  override async startTurn(input: Parameters<CodexPort['startTurn']>[0]): Promise<string> {
    const turnId = await super.startTurn(input);
    this.observeDelivery('startTurn', input, turnId);
    return turnId;
  }
  override async steer(input: Parameters<CodexPort['steer']>[0]): Promise<void> {
    await super.steer(input);
    this.observeDelivery('steer', input, input.turnId);
  }
}

function isolatedConnector(executable: string, env: NodeJS.ProcessEnv): CodexConnector {
  return async handlers => {
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { cwd: directory, env, stdio: 'pipe', windowsHide: true });
    children.push(child);
    let closing = false;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => handlers.message(line));
    child.stderr.on('data', (bytes: Buffer) => { childStderr = (childStderr + bytes.toString()).slice(-12_000); });
    child.on('error', error => handlers.error(error));
    child.on('exit', (code, signal) => { if (!closing) handlers.error(new ProbeBlocked(`Probe Codex app-server exited with ${code ?? signal}`)); });
    return {
      send: message => new Promise<void>((sent, failed) => child.stdin.write(message + '\n', error => error ? failed(error) : sent())),
      close: async () => {
        closing = true;
        lines.close();
        child.stdin.end();
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        await Promise.race([new Promise<void>(done => child.once('exit', () => done())), delay(2000)]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await bounded('owned Codex process termination', new Promise<void>(done => child.once('exit', () => done())), Date.now() + 3000);
        }
      },
    };
  };
}

async function groupReadback(): Promise<Readback[]> {
  if (!sdk) return fakeFeishu?.sent.map((item, index) => ({ chatId: item.chatId, messageId: `fake-${index}`,
    body: item.text, messageType: 'fake-text', createdAt: '' })) ?? [];
  const messages: Readback[] = [];
  for (const group of groups) {
    ownedGroup(group.chatId);
    let pageToken: string | undefined;
    const seen = new Set<string>();
    do {
      const response = await bounded('Feishu test-group readback', sdk.im.v1.message.list({ params: {
        container_id_type: 'chat', container_id: group.chatId, start_time: String(Math.floor(startedAt / 1000)),
        page_size: 50, page_token: pageToken, sort_type: 'ByCreateTimeAsc',
      } }));
      if (response.code !== 0) throw new ProbeBlocked(`Feishu readback failed with code ${response.code}: ${response.msg}`);
      const data = z.object({ items: z.array(z.object({ message_id: z.string(), chat_id: z.string(), msg_type: z.string(),
        create_time: z.string(), deleted: z.boolean().optional(), body: z.object({ content: z.string() }).optional() })).default([]),
        has_more: z.boolean(), page_token: z.string().optional(),
      }).parse(response.data);
      for (const item of data.items) {
        assert.equal(item.chat_id, group.chatId);
        if (!item.deleted) messages.push({ chatId: item.chat_id, messageId: item.message_id,
          body: item.body?.content ?? '', messageType: item.msg_type, createdAt: item.create_time });
      }
      pageToken = data.has_more ? data.page_token : undefined;
      if (data.has_more) {
        assert.ok(pageToken && !seen.has(pageToken), 'Feishu readback pagination must make progress');
        seen.add(pageToken);
        assert.ok(seen.size <= 10, 'Marker-only acceptance must not generate more than 500 group messages');
      }
    } while (pageToken);
  }
  return messages;
}

function readDatabase(): unknown {
  const db = new DatabaseSync(join(dataDir, 'tasks.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
    const tables = ['tasks', 'inbox', 'outbox', 'reminders', 'group_message_deliveries', 'worker_chat_deliveries'];
    const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    return { integrity: 'ok', tables: Object.fromEntries(tables.filter(table => present.has(table))
      .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()])) };
  } finally { db.close(); }
}

async function verify(): Promise<void> {
  const needed = z.object({ execution: configSchema.shape.execution, feishu: configSchema.shape.feishu })
    .parse(JSON.parse(await readFile(options.config, 'utf8')));
  const configuredEnv = parseEnv(await readFile(options.envFile, 'utf8'));
  const credential = (name: string) => {
    const value = process.env[name] ?? configuredEnv[name];
    if (value) secrets.add(value);
    return value;
  };
  const codexEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries({ ...configuredEnv, ...process.env })) {
    if (value === undefined || !/^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_ALL|CODEX_HOME|OPENAI_API_KEY|OPENAI_BASE_URL|SUB2API_API_KEY|SUB2API_BASE_URL|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i.test(name)) continue;
    if (name === needed.feishu.appIdEnv || name === needed.feishu.appSecretEnv || /feishu|lark/i.test(name)) continue;
    codexEnv[name] = value;
    if (/key|token|secret/i.test(name)) secrets.add(value);
  }
  for (const name of [needed.feishu.appIdEnv, needed.feishu.appSecretEnv]) credential(name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const safety = `This is a marker-only acceptance fixture. Read only ${directory}/AGENTS.md and the explicitly named fixture files. Allowed shell commands are cat on the Worker proof file, node ${waitPath}, and node ${duePath}. Do not inspect credentials, environment, configuration, capability files, other projects or repositories. Do not edit files, use network tools, create PRs, deploy, operate services, clean resources, or create nested agents. The only Agent Loop dispatch permitted is one coordinator-created Worker. The native collaboration tools may create this fixture's test groups and send its marker messages. These explicit acceptance restrictions override generic pstack workflows. Do not read or invoke additional skills. A plain question is ordinary assistant prose; do not request native user input for this probe.`;
  await writeFile(join(directory, 'AGENTS.md'), safety + '\n');
  await writeFile(proofPath, marker + '\n', { mode: 0o600 });
  await writeFile(waitPath, 'setTimeout(() => process.stdout.write("fixture wait completed\\n"), 8000);\n');
  await writeFile(duePath, 'process.stdout.write(String(Date.now() + 30000) + "\\n");\n');
  const fixtureHash = async () => Promise.all((await readdir(directory)).sort().map(async name => ({ name,
    sha256: createHash('sha256').update(await readFile(join(directory, name))).digest('hex') })));
  const before = await fixtureHash();
  const workerPrompt = `${safety}
Goal: prove active collaboration and ordinary Worker group output. Read ${proofPath}; the proof marker is unknown until you read it. Query project_action status for your own task ID and coordinator task ID. While you still have no group, call send_agent_message with requestId probe-worker-progress, taskId equal to the coordinator task ID, and text containing the exact proof marker and its file path. No user report request is needed. After that call returns, immediately run node ${waitPath} and wait for it to finish without ending your turn. Then open your own group with project_action open_group, requestId probe-worker-group, taskId your own ID. Emit an ordinary commentary containing ${markers.commentary}. Emit an ordinary question containing ${markers.question} and a question mark. Neither requires a human answer. Finish with an ordinary final answer containing ${markers.final}. Do not use send_group_message. Do not send a second Agent message. Do not close the task or clean its files.`;
  const workerProfile = needed.execution.worker[0];
  assert.ok(workerProfile);
  const instructions = `${safety}
This acceptance has one coordinator and one Worker. Query project_action status before dispatch. Dispatch exactly once with requestId probe-dispatch, role worker, execution ${JSON.stringify(workerProfile)}, and the complete following Worker instructions as prompt:
${workerPrompt}
Do not open the Worker group yourself. Do not read proof.txt yourself. End ordinary responses with ${markers.hidden}; ordinary coordinator text must stay out of the group.
When the Worker's message supplies the actual proof marker, query status, record it with requestId probe-receipt, key acceptance.receipt, text containing the actual marker, and the actual current expectedVersion. Then call send_group_message with requestId probe-coordinator-ack and text containing ${markers.acknowledged} plus the actual proof marker. Run node ${duePath} for a future epoch millisecond. Call project_action schedule_reminder exactly once with requestId probe-reminder, dueAt that returned number, and text instructing your future self to record acceptance.reminder and send ${markers.reminder}. Call list_reminders to inspect it, then end the turn.
When the actual reminder input arrives, query status, record with requestId probe-reminder-record, key acceptance.reminder, text ${markers.reminder}, and current expectedVersion. Call send_group_message with requestId probe-reminder-group, text ${markers.reminder}. Do not schedule another reminder or dispatch again. End with ${markers.hidden}.
If a later input explicitly identifies itself as a synthetic direct user question, answer it using send_group_message requestId probe-direct-reply with text ${markers.direct}, then end ordinary final text with ${markers.hidden}. This synthetic input proves routing only and is not a real human webhook. Existing records mean the corresponding step is already done; do not repeat it.`;
  const config = configSchema.parse({ dataDir, projects: [{ id: projectId, name: titlePrefix, directory, repositories: [], instructions }],
    repositories: [], feishu: { ...needed.feishu, progress: { enabled: false } },
    execution: { ...needed.execution, backends: { codex: { executable: needed.execution.backends.codex.executable,
      approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 30_000, titleTimeoutMs: 30_000 } } },
    recovery: { maxAttempts: 0, retryDelayMs: 1000 },
  });
  executionProfiles = { coordinator: config.execution.coordinator, worker: config.execution.worker };
  sourceAtStart = await fingerprint();
  const commit = await execute('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, timeout: 10_000 });
  const nativeVersion = await execute(config.execution.backends.codex.executable, ['--version'], { env: codexEnv, timeout: 10_000 });
  artifact = { commit: commit.stdout.trim(), sourceRoot, sources: sourceAtStart, codexVersion: nativeVersion.stdout.trim() };
  let feishu: FeishuPort;
  if (options.realFeishu) {
    const appId = credential(needed.feishu.appIdEnv), appSecret = credential(needed.feishu.appSecretEnv);
    if (!appId || !appSecret) throw new ProbeBlocked('Configured Feishu credentials are unavailable');
    const settings = { appId, appSecret, userOpenId: needed.feishu.userOpenId, requestTimeoutMs: 20_000 };
    sdk = new Client({ appId, appSecret, domain: Domain.Feishu, loggerLevel: LoggerLevel.error });
    feishu = new ObservedFeishu(settings);
  } else {
    fakeFeishu = new FeishuFake();
    feishu = fakeFeishu;
  }
  codex = new ObservedCodex({ ...config.execution.backends.codex, env: codexEnv },
    isolatedConnector(config.execution.backends.codex.executable, codexEnv));
  loop = new AgentLoop(config, { codex, feishu, github: new GitHubFake(), workspace: new WorkspaceProvider(dataDir) });
  await bounded('isolated project initialization', loop.collect());
  const coordinatorId = project().coordinatorTaskId;
  let directInputId: string | null = null;
  let lastState = '';
  while (Date.now() < deadline) {
    await bounded('isolated Runtime tick', loop.tick());
    const state = project();
    assert.ok(state.members.length <= 2, 'No additional Worker may be created');
    const coordinator = loop.store.task(coordinatorId);
    const workerMember = state.members.find(member => member.role === 'worker');
    const worker = workerMember ? loop.store.task(workerMember.taskId) : undefined;
    if (fakeFeishu) for (const [taskId, chatId] of fakeFeishu.groups) {
      if (!groups.some(group => group.chatId === chatId)) groups.push({ taskId, chatId, title: `${titlePrefix} fake` });
    }
    const summary = loop.tasks().map(task => ({ id: task.id, status: task.status, executionStatus: task.executionStatus,
      threadId: task.threadId, turnId: task.turnId, chatId: task.chatId, reason: task.reason }));
    if (JSON.stringify(summary) !== lastState) { lastState = JSON.stringify(summary); note('tasks', summary); }
    for (const task of loop.tasks()) {
      if (task.requests.length) throw new ProbeBlocked('Unexpected native request during marker-only acceptance');
      if (task.status === 'failed' || task.executionStatus === 'failed') {
        const reason = task.reason ?? task.recovery.lastError ?? 'Native execution failed';
        throw unavailable(reason) ? new ProbeBlocked(reason) : new Error(reason);
      }
    }
    const rejected = calls.find(call => call.status === 'rejected');
    if (rejected?.status === 'rejected') throw new Error(`A model tool call was rejected: ${rejected.error}`);
    if (!worker || !coordinator.threadId || !worker.threadId) { await delay(200); continue; }
    const reminderRecorded = state.records.some(record => record.key === 'acceptance.reminder' && record.text.includes(markers.reminder));
    if (reminderRecorded && coordinator.status === 'idle' && worker.status === 'idle' && !directInputId) {
      assert.ok(coordinator.chatId);
      directInputId = `synthetic-direct-question-${runId}`;
      note('synthetic_direct_question', { inputId: directInputId, chatId: coordinator.chatId,
        provenance: 'Injected through AgentLoop.receive. No human message or webhook receipt is claimed.' });
      await bounded('synthetic direct question', loop.receive({ id: directInputId, chatId: coordinator.chatId,
        senderId: needed.feishu.userOpenId, chatType: 'group', createdAt: Date.now(), attachments: [],
        text: `This is the synthetic direct user question for this acceptance. Reply visibly with ${markers.direct} using send_group_message, then end with ${markers.hidden}.`,
      }));
    }
    const directReply = calls.some(call => call.status === 'succeeded' && call.request.call.tool === 'send_group_message'
      && call.request.call.arguments.requestId === 'probe-direct-reply');
    if (!directReply || coordinator.status !== 'idle' || worker.status !== 'idle') { await delay(200); continue; }
    await bounded('final output flush', loop.tick());
    readback = await groupReadback();
    const workerBodies = readback.filter(item => item.chatId === worker.chatId).map(item => item.body).join('\n');
    const coordinatorBodies = readback.filter(item => item.chatId === coordinator.chatId).map(item => item.body).join('\n');
    if (![markers.commentary, markers.question, markers.final].every(value => workerBodies.includes(value))
      || ![markers.acknowledged, markers.reminder, markers.direct].every(value => coordinatorBodies.includes(value))) {
      await delay(1000);
      continue;
    }
    assert.ok(!coordinatorBodies.includes(markers.hidden), 'Coordinator ordinary final must not appear in its group');
    assert.equal(groups.length, 2, 'Only the coordinator and single Worker groups may be created');
    assert.equal(calls.filter(call => call.request.call.tool === 'project_action' && call.request.call.arguments.action === 'dispatch').length, 1);
    const progress = calls.filter(call => call.request.call.tool === 'send_agent_message');
    assert.equal(progress.length, 1);
    const sentProgress = progress[0]; assert.ok(sentProgress && sentProgress.status === 'succeeded');
    assert.equal(sentProgress.callerChatId, null);
    const delivery = deliveries.find(item => item.senderStillActive); assert.ok(delivery, 'Coordinator must receive the marker while the sending Worker Turn is still active');
    assert.equal(delivery.sender.turnId, sentProgress.request.turnId);
    const inbox = loop.store.inputs(coordinatorId).filter(input => input.provenance.kind === 'agent_message'
      && input.provenance.fromTaskId === worker.id && input.message.text.includes(marker));
    assert.equal(inbox.length, 1, 'Exactly one durable Worker message must exist');
    assert.equal(inbox[0]?.status, 'delivered');
    const receipt = state.records.find(record => record.key === 'acceptance.receipt');
    assert.ok(receipt?.text.includes(marker));
    const recordCall = calls.find(call => call.request.call.tool === 'project_action'
      && call.request.call.arguments.action === 'record' && call.request.call.arguments.requestId === 'probe-receipt');
    assert.ok(recordCall && recordCall.startedAt >= delivery.at, 'Actual coordinator record action must follow model input delivery');
    assert.ok(events.some(event => event.threadId === worker.threadId && event.turnId === sentProgress.request.turnId
      && event.kind === 'tool_end' && event.text.includes(waitPath) && event.label.includes('exit 0') && event.createdAt >= delivery.at),
    'Worker must continue and finish its fixture wait after coordinator input is confirmed');
    assert.ok(events.some(event => event.threadId === worker.threadId && event.kind === 'tool_end'
      && event.text.includes(proofPath) && event.label.includes('exit 0')), 'Worker must actually read the proof file');
    assert.ok(events.some(event => event.threadId === coordinator.threadId && event.kind === 'agent_message'
      && event.isFinalAnswer && event.text.includes(markers.hidden)), 'Hidden marker must exist in a real coordinator final answer');
    for (const value of [markers.commentary, markers.question, markers.final]) {
      assert.ok(events.some(event => event.threadId === worker.threadId && event.kind === 'agent_message'
        && !!event.isFinalAnswer === (value === markers.final) && event.text.includes(value)),
        `Worker must emit ordinary assistant text containing ${value}`);
    }
    const reminders = loop.store.reminders({ projectId, taskId: coordinatorId, offset: 0, limit: 100 });
    assert.equal(reminders.total, 1);
    assert.equal(reminders.reminders[0]?.status, 'fired');
    const reminderInputs = loop.store.inputs(coordinatorId).filter(input => input.provenance.kind === 'reminder');
    assert.equal(reminderInputs.length, 1);
    assert.equal(reminderInputs[0]?.status, 'delivered');
    const reminderDelivery = inputReceipts.find(item => item.inputIds.includes(reminderInputs[0]?.id ?? ''));
    assert.ok(reminderDelivery, 'The real model must acknowledge the due reminder input');
    const reminderAction = calls.find(call => call.request.call.tool === 'project_action'
      && call.request.call.arguments.action === 'record' && call.request.call.arguments.requestId === 'probe-reminder-record');
    assert.ok(reminderAction && reminderAction.startedAt >= reminderDelivery.at, 'The model must act after the reminder arrives');
    assert.equal(reminderAction.request.turnId, reminderDelivery.turnId);
    assert.equal(calls.filter(call => call.request.call.tool === 'project_action' && call.request.call.arguments.action === 'schedule_reminder').length, 1);
    assert.equal(calls.filter(call => call.request.call.tool === 'send_group_message' && call.request.call.arguments.requestId === 'probe-reminder-group').length, 1);
    assert.ok(loop.store.input(coordinatorId, directInputId ?? '')?.status === 'delivered');
    const allowedCommands = new Set([
      `cat ${join(directory, 'AGENTS.md')}`, `cat ${proofPath}`, `cat ${join(directory, 'AGENTS.md')} ${proofPath}`,
      'cat AGENTS.md', 'cat proof.txt', 'cat AGENTS.md proof.txt', `node ${waitPath}`, `node ${duePath}`, 'node wait.cjs', 'node due.cjs',
    ]);
    for (const event of events.filter(item => item.kind === 'tool_start')) {
      if (['project_action', 'send_agent_message', 'send_group_message'].some(tool => event.label.startsWith(`${tool} `))) continue;
      assert.ok(event.text.startsWith('$ '), `Unexpected tool used by the model: ${event.label}`);
      const commands = event.text.slice(2).replace(/["']/g, '').trim().split(/\s*&&\s*|\s*;\s*/);
      assert.ok(commands.every(command => allowedCommands.has(command)), `Fixture command is outside acceptance scope: ${event.text}`);
      if (event.threadId === coordinator.threadId) assert.ok(!event.text.includes('proof.txt'), 'Coordinator must learn the proof only from its Worker');
    }
    if (options.realFeishu) {
      for (const item of sent) assert.ok(readback.some(message => message.messageId === item.messageId && message.chatId === item.chatId), 'Every acknowledged provider message must be independently read back');
      for (const value of [markers.acknowledged, markers.reminder, markers.direct]) {
        assert.equal(readback.filter(item => item.chatId === coordinator.chatId && item.body.includes(value)).length, 1, 'Explicit coordinator messages must appear exactly once');
      }
    }
    const settled = { calls: calls.length, inputs: loop.store.inputs(coordinatorId).map(input => input.id) };
    for (let repeat = 0; repeat < 3; repeat++) await bounded('repeat due scan', loop.tick());
    assert.equal(calls.length, settled.calls, 'Repeated ticks must not redispatch or resend');
    assert.deepEqual(loop.store.inputs(coordinatorId).map(input => input.id), settled.inputs, 'Repeated ticks must not create another reminder input');
    assert.deepEqual(await fixtureHash(), before, 'Fixture files must remain unchanged');
    assert.deepEqual(await fingerprint(), sourceAtStart, 'Acceptance source must not change during the run');
    proof = { coordinatorId, workerId: worker.id, coordinatorThreadId: coordinator.threadId, workerThreadId: worker.threadId,
      senderTurnId: sentProgress.request.turnId, recipientTurnId: delivery.turnId, delivery, durableMessage: inbox[0],
      nextCoordinatorAction: recordCall, receipt, reminder: reminders.reminders[0], reminderInput: reminderInputs[0], reminderDelivery, reminderAction,
      syntheticDirectInputId: directInputId, fixture: before };
    return;
  }
  throw new Error('Acceptance predicates were not satisfied before the bounded deadline');
}

try {
  await verify();
  outcome = { result: 'passed' };
} catch (error) {
  const message = errorText(error);
  outcome = { result: error instanceof ProbeBlocked || unavailable(message) ? 'blocked' : 'failed', error: message };
  process.exitCode = outcome.result === 'blocked' ? 2 : 1;
  note('acceptance_stopped', outcome);
} finally {
  if (loop) {
    runtime = { project: loop.projects.ledger.project(projectId), tasks: loop.tasks().map(task => ({ task,
      inputs: loop?.store.inputs(task.id), outputs: loop?.store.outputs(task.id) })), diagnostics: loop.store.diagnostics() };
    try { database = readDatabase(); } catch (error) { cleanup.push({ resource: 'SQLite evidence', result: errorText(error) }); }
    try {
      for (const name of await readdir(join(dataDir, 'workspace-capabilities'))) {
        const capability = z.object({ token: z.string() }).parse(JSON.parse(await readFile(join(dataDir, 'workspace-capabilities', name), 'utf8')));
        secrets.add(capability.token);
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) cleanup.push({ resource: 'Capability redaction', result: errorText(error) });
    }
    try { await bounded('probe Runtime shutdown', loop.close(), Date.now() + 35_000); cleanup.push({ resource: 'Probe Runtime', result: 'closed' }); }
    catch (error) { cleanup.push({ resource: 'Probe Runtime', result: errorText(error) }); }
  }
  if (codex) {
    try { await bounded('probe Codex socket shutdown', codex.close(), Date.now() + 5000); }
    catch (error) { cleanup.push({ resource: 'Probe Codex connection', result: errorText(error) }); }
  }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await bounded('probe-owned process exit', new Promise<void>(done => child.once('exit', () => done())), Date.now() + 3000)
        .catch(error => cleanup.push({ resource: `Probe process ${child.pid}`, result: errorText(error) }));
    }
    cleanup.push({ resource: `Probe process ${child.pid}`, result: child.exitCode !== null || child.signalCode !== null ? 'closed' : 'still running' });
  }
  if (cleanup.some(item => item.result !== 'closed')) {
    if (outcome.result === 'passed') outcome = { result: 'failed', error: 'Cleanup or evidence is incomplete' };
    process.exitCode = outcome.result === 'blocked' ? 2 : 1;
  }
  await writeFile(join(evidenceDirectory, 'calls.json'), sanitized(calls), { mode: 0o600 });
  await writeFile(join(evidenceDirectory, 'execution.json'), sanitized({ events, inputReceipts }), { mode: 0o600 });
  await writeFile(join(evidenceDirectory, 'runtime.json'), sanitized(runtime), { mode: 0o600 });
  await writeFile(join(evidenceDirectory, 'database.json'), sanitized(database), { mode: 0o600 });
  await writeFile(join(evidenceDirectory, 'feishu.json'), sanitized({ transport: options.realFeishu ? 'real' : 'fake', groups, sent, readback }), { mode: 0o600 });
  await writeFile(join(evidenceDirectory, 'summary.json'), sanitized({ ...outcome, runId, startedAt, finishedAt: Date.now(),
    timeoutMs: options.timeoutMs, artifact, executionProfiles, root, directory, dataDir, evidenceDirectory, proof, timeline, cleanup,
    childStderr, retained: { groups, fixture: root, codexThreads: loop ? 'See runtime.json task thread IDs' : [] },
    scope: options.realFeishu ? 'Real CodexAppServer models, AgentLoop, SQLite, WorkspaceProvider, FeishuAdapter and provider message readback.'
      : 'Real CodexAppServer models, AgentLoop, SQLite and WorkspaceProvider. Feishu is fake and real group acceptance remains unverified.',
    limits: ['The direct question is synthetic, not a human webhook.', 'No production service, production data or remote repository was used.',
      'No Feishu WebSocket was connected. Bot group metadata listing is used only by the production adapter to reconcile unique fixture task IDs.',
      'This probe does not cover old-data migration, pause/restart races, task continuation or cleanup. Their integration tests remain required.'],
    throughputCheckpoint: { blockingFirstSteps: 'Read the integrated API and type-check before live execution.',
      independentWorkstreams: 'One script owner; the parent integrates runtime changes.', sharedMutableState: 'Unique fixture, SQLite and owned Codex process.',
      smallestSafeDecomposition: 'One script records actual model calls, persistence and provider receipts.' },
  }), { mode: 0o600 });
  process.stdout.write(sanitized({ ...outcome, evidenceDirectory, retainedFixture: root, retainedGroups: groups }));
}
