import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CodexAppServer } from '../src/adapters/codex.js';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import type { CodexPort } from '../src/ports.js';
import { projectStateSchema } from '../src/project.js';
import { Store } from '../src/store.js';
import { assertProbeTaskInventory } from './project-coordinator-probe-tasks.js';
import { WorkspaceProvider } from '../src/workspace.js';
import { FeishuFake, GitHubFake, issue } from '../test/fakes.js';

type ProjectHandler = Parameters<NonNullable<CodexPort['setProjectHandler']>>[0];
type ProjectRequest = Parameters<ProjectHandler>[0];
type ActionCall = { request: ProjectRequest; startedAt: number } & (
  { status: 'running' } | { status: 'succeeded'; finishedAt: number; result: unknown }
  | { status: 'rejected'; finishedAt: number; error: string }
);
type Outcome = { result: 'passed' } | { result: 'failed' | 'blocked'; error: string };
class ProbeBlocked extends Error {}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const codexUnavailable = (message: string) => /\b(?:credit|quota|billing|auth(?:entication|orization)?|login)\b|not logged|connect|ENOTFOUND|ENOENT|timed out|rate.limit|model.*(not|unavailable)|\b(?:403|401|429|502|503)\b/i.test(message);
const execute = promisify(execFile);
const options = z.object({
  model: z.string().trim().min(1).optional(),
  timeoutMs: z.coerce.number().int().min(10_000).max(1_200_000).default(480_000),
  restart: z.enum(['0', '1']).default('1'),
}).parse({ model: process.env.PROJECT_COORDINATOR_VERIFY_MODEL,
  timeoutMs: process.env.PROJECT_COORDINATOR_VERIFY_TIMEOUT_MS,
  restart: process.env.PROJECT_COORDINATOR_VERIFY_RESTART });
const startedAt = Date.now();
const deadline = startedAt + options.timeoutMs;
const sourceFiles = ['scripts/verify-project-coordinator.ts', 'scripts/project-coordinator-probe-tasks.ts', 'src/loop.ts', 'src/project.ts', 'src/project-runtime.ts',
  'src/adapters/codex.ts', 'src/config.ts', 'src/domain.ts', 'src/store.ts', 'src/workspace.ts',
  'src/workspace-bridge.ts', 'prompts/coordinator.md', 'prompts/worker.md'];
const fingerprintSources = () => Promise.all(sourceFiles.map(async path => ({ path,
  sha256: createHash('sha256').update(await readFile(resolve(path))).digest('hex') })));
const sourceAtStart = await fingerprintSources();
const evidenceDirectory = resolve('.scratch/project-coordinator/execution', `live-${startedAt}-${randomUUID().slice(0, 8)}`);
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-loop-project-live-')));
const directory = join(root, 'project');
const proofFile = join(directory, 'proof.txt');
const gateFile = join(root, 'coordinator-idle.gate');
const marker = `PROJECT_COORDINATOR_PROOF_${randomUUID()}`;
const projectId = 'live-fixture';
const repository = 'fixture/coordinator';
const dispatchId = 'fixture-read-only-worker';
const reportId = 'fixture-read-only-result';
const recordId = 'fixture-result-receipt';
const recordKey = 'acceptance.worker-receipt';
const calls: ActionCall[] = [];
const timeline: { at: number; event: string; detail: unknown }[] = [];
const servers: CodexAppServer[] = [];
const cleanup: { resource: string; result: string }[] = [];
let loop: AgentLoop | undefined;
let outcome: Outcome = { result: 'blocked', error: 'Acceptance did not finish' };
let initialTurn: string | null = null;
let initialThread: string | null = null;
let gateOpenedAt: number | null = null;
let reportArrival: { status: string; turnId: string | null; at: number } | null = null;
let coreProof: unknown = null;
let restartProof: unknown = { result: 'skipped', reason: 'Core acceptance has not completed' };
const runtimeEvidence: { phase: string; snapshot: unknown }[] = [];
let databaseEvidence: unknown = null;
const secrets = new Set<string>();
const note = (event: string, detail: unknown = null) => {
  timeline.push({ at: Date.now(), event, detail });
  process.stdout.write(`${JSON.stringify({ event, detail })}\n`);
};

async function bounded<T>(label: string, run: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProbeBlocked(`Deadline exceeded during ${label}`)), Math.max(1, deadline - Date.now()));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

// The adapter delegates every accepted call to AgentLoop's original handler.
class ObservedCodex extends CodexAppServer {
  override setProjectHandler(handler: ProjectHandler): void {
    super.setProjectHandler(async request => {
      const callStartedAt = Date.now();
      const index = calls.push({ request: structuredClone(request), startedAt: callStartedAt, status: 'running' }) - 1;
      note('project_action', { action: request.action.action, threadId: request.threadId, turnId: request.turnId });
      try {
        const action = request.action;
        if (action.action === 'dispatch') {
          assert.equal(action.requestId, dispatchId, 'Only the single fixture worker is authorized');
          assert.equal(action.role, 'worker');
        } else if (action.action === 'report') {
          assert.equal(action.requestId, reportId);
          assert.equal(action.kind, 'result');
          assert.ok(loop);
          const project = loop.projects.ledger.project(projectId); assert.ok(project);
          const coordinator = loop.store.task(project.coordinatorTaskId);
          reportArrival = { status: coordinator.status, turnId: coordinator.turnId, at: Date.now() };
        } else if (action.action === 'record') {
          assert.equal(action.requestId, recordId);
          assert.equal(action.key, recordKey);
        } else assert.equal(action.action, 'status', 'Only status, dispatch, report and record are authorized');
        const result = await handler(request);
        calls[index] = { request: structuredClone(request), startedAt: callStartedAt,
          status: 'succeeded', finishedAt: Date.now(), result: structuredClone(result) };
        return result;
      } catch (error) {
        calls[index] = { request: structuredClone(request), startedAt: callStartedAt,
          status: 'rejected', finishedAt: Date.now(), error: errorText(error) };
        throw error;
      }
    });
  }
}

const safety = `This is an isolated, read-only acceptance probe. Only inspect the fixture under ${root} and the exact supplied poteto-mode skill file. Use native project_action for communication. No external tools, browser, images, remote hosts, real Feishu/GitHub, PR, git changes, deployments, service operations, credential/config inspection, or other agents. Model-provider communication is allowed. Do not read capability files or use shell fallbacks. Do not edit any files. The only delegation authorized is the coordinator's one project_action dispatch described below. Scope and prohibitions override generic playbook suggestions. A turn ending does not close the Issue.`;
const workerPrompt = `Use poteto-mode for a read-only fixture investigation. ${safety}
Read ${join(directory, 'AGENTS.md')}. Wait for ${gateFile} to exist, then read ${proofFile} with the shell tool. You may use a bounded shell loop (at most 180 seconds, sleep 1) to wait for that file. The probe creates it after the coordinator's first turn ends. Extract the unique marker from proof.txt. Report it exactly once with native project_action {"action":"report","requestId":"${reportId}","kind":"result","text":"<exact marker plus the absolute proof.txt path and what you actually read>"}. Return a short final answer containing that same marker and path. Do not create documentation or make a PR. Do not delegate. Do not call record. If blocked, say what failed instead of inventing evidence.`;
const policy = `${safety}
First call project_action {"action":"status"}. Inspect issues and existing tasks. Only Issue 101 authorizes the single read-only check. Other admitted Issues exercise intake only and require no workers. Ignore out-of-scope Issues. If no worker exists for Issue 101, dispatch exactly one using requestId ${dispatchId}, role worker, issueId live-issue-101, and this complete worker prompt as the prompt field:
${workerPrompt}
After dispatch, END THIS TURN with COORDINATOR_WAITING_FOR_REPORT. Do not wait, sleep or poll inside that turn. The Runtime will wake you when the worker reports.
On later turns call status first and do not dispatch again. When a worker result containing its unique proof marker is present, query status for the current version and records, then call project_action record with requestId ${recordId}, key ${recordKey}, expectedVersion equal to the current status version, and text containing the actual worker marker, worker task ID, proof file path, and an explicit receipt of the result. Never guess the marker or read proof.txt yourself. If this receipt already exists, do not record again. End with COORDINATOR_RECEIPT_RECORDED plus the actual marker. No rotation is requested in this probe.`;
const config = configSchema.parse({ dataDir: join(root, 'data'),
  feishu: { userOpenId: 'fixture-owner', progress: { enabled: false } },
  engineering: { skillPath: '/Users/developer/.codex/packages/pstack/skills/poteto-mode/SKILL.md' },
  projects: [{ id: projectId, name: 'Coordinator live fixture', directory,
    repositories: [{ name: repository, labelsAny: ['coordinate'], assigneesAny: ['fixture-owner'] }],
    instructions: policy }],
  recovery: { maxAttempts: 0, retryDelayMs: 1000 },
  codex: { command: ['codex', 'app-server'], ...(options.model ? { model: options.model } : {}),
    approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 30_000 } });
const github = new GitHubFake();
const feishu = new FeishuFake();
github.sources = [
  issue(101, { id: 'live-issue-101', repository, url: 'https://example.invalid/fixture/issues/101',
    title: 'Read-only fixture proof', body: 'Inspect the local fixture and report its marker. No PR or external actions.', labels: ['coordinate'], assignees: [] }),
  issue(102, { id: 'live-issue-102', repository, url: 'https://example.invalid/fixture/issues/102',
    title: 'Assignee-only intake fixture', body: 'Intake only. No work authorized.', labels: [], assignees: ['fixture-owner'] }),
  issue(103, { id: 'live-issue-103', repository, url: 'https://example.invalid/fixture/issues/103',
    title: 'Out-of-scope fixture', body: 'No work authorized.', labels: [], assignees: [] }),
  issue(104, { id: 'live-issue-104', repository, url: 'https://example.invalid/fixture/issues/104',
    title: 'Both selectors intake fixture', body: 'Intake only. No work authorized.', labels: ['coordinate'], assignees: ['fixture-owner'] }),
];

function newLoop(): AgentLoop {
  const codex = new ObservedCodex(config.codex);
  servers.push(codex);
  return new AgentLoop(config, { codex, feishu, github, workspace: new WorkspaceProvider(config.dataDir) });
}

function snapshot(current: AgentLoop): unknown {
  return { project: current.projects.ledger.project(projectId), tasks: current.tasks().map(task => ({ task,
    inputs: current.store.inputs(task.id), outputs: current.store.outputs(task.id),
    approvals: current.store.approvals(task.id), events: current.store.executionEvents(task.id, 0, 100_000) })),
  diagnostics: current.store.diagnostics(), fakeFeishu: { groups: [...feishu.groups], sent: feishu.sent,
    approvals: feishu.approvals }, fakeGithub: { sources: github.sources, verifications: github.verifications } };
}

function readDatabase(): unknown {
  const db = new DatabaseSync(join(config.dataDir, 'tasks.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
    if (coreProof) {
      const row = z.object({ value: z.string() }).parse(db.prepare('SELECT value FROM meta WHERE key=?')
        .get(`project:${JSON.stringify(['state', projectId])}`));
      const persisted = z.object({ state: projectStateSchema }).parse(JSON.parse(row.value)).state;
      assert.equal(persisted.members.length, 2);
      assert.equal(persisted.version, 1);
      assert.ok(persisted.records.some(record => record.key === recordKey && record.text.includes(marker)), 'Receipt must exist in actual SQLite metadata');
    }
    const queries = {
      integrity: 'PRAGMA integrity_check',
      schema: "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",
      tasks: 'SELECT * FROM tasks ORDER BY rowid', sources: 'SELECT * FROM sources ORDER BY id',
      inbox: 'SELECT * FROM inbox ORDER BY seq', outbox: 'SELECT * FROM outbox ORDER BY rowid',
      operations: 'SELECT * FROM operations ORDER BY rowid',
      projectMetadata: "SELECT * FROM meta WHERE key LIKE 'project:%' OR key LIKE 'project-generation:%' OR key LIKE 'project-archived-thread:%' ORDER BY key",
      executionEvents: 'SELECT * FROM execution_events ORDER BY seq',
      diagnostics: 'SELECT * FROM diagnostics ORDER BY id',
    };
    return Object.fromEntries(Object.entries(queries).map(([name, sql]) => [name, { sql, rows: db.prepare(sql).all() }]));
  } finally { db.close(); }
}

async function verify(): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'AGENTS.md'), `${safety}\nOnly proof.txt and this file may be read in this project. No file changes. Use the supplied report operation.\n`);
  await writeFile(proofFile, `${marker}\n`, { mode: 0o600 });
  const fixtureBefore = { files: (await readdir(directory)).sort(),
    proof: createHash('sha256').update(await readFile(proofFile)).digest('hex'),
    instructions: createHash('sha256').update(await readFile(join(directory, 'AGENTS.md'))).digest('hex') };
  const version = await execute('codex', ['--version'], { timeout: 10_000 });
  note('native_codex', { version: version.stdout.trim(), fallbackModel: options.model ?? 'native default',
    roleModels: config.projects[0]?.models, roleReasoningEfforts: config.projects[0]?.reasoningEfforts });
  loop = newLoop();
  await bounded('Issue collection', loop.collect());
  const intake = loop.projects.ledger.project(projectId);
  assert.ok(intake);
  assert.deepEqual(intake.issues.map(source => source.id).sort(), ['live-issue-101', 'live-issue-102', 'live-issue-104']);
  const taskIdentities = loop.tasks().map(task => ({ id: task.id, sourceId: task.sourceId }));
  const collected = assertProbeTaskInventory(loop.tasks(), intake, taskIdentities);
  assert.equal(collected.executions.length, 1, 'Collection creates only the coordinator execution');
  assert.equal(collected.intakes.length, 3, 'All three admitted Issues remain unbound intake tasks');
  assert.ok(collected.intakes.every(task => task.status === 'pending'), 'Collected intakes must await routing');
  const coordinatorId = intake.coordinatorTaskId;
  note('intake_verified', { coordinatorId, admitted: intake.issues.map(source => source.id), excluded: 'live-issue-103' });
  let lastState = '';
  while (Date.now() < deadline) {
    await bounded('Runtime tick', loop.tick());
    const state = loop.projects.ledger.project(projectId);
    assert.ok(state);
    const tasks = loop.tasks();
    const current = loop.store.task(coordinatorId);
    const summary = tasks.map(task => ({ id: task.id, status: task.status, executionStatus: task.executionStatus,
      turnId: task.turnId, reason: task.reason }));
    if (JSON.stringify(summary) !== lastState) { lastState = JSON.stringify(summary); note('tasks', summary); }
    const { executions, intakes } = assertProbeTaskInventory(tasks, state, taskIdentities);
    for (const task of tasks) {
      if (task.requests.length) throw new ProbeBlocked(`Unexpected native request on ${task.id}; approvals are disabled`);
      if (task.executionStatus === 'failed' && task.reason && codexUnavailable(task.reason)) throw new ProbeBlocked(task.reason);
      if (task.status === 'failed') {
        const message = task.reason ?? task.recovery.lastError ?? 'Unknown task failure';
        if (codexUnavailable(message)) throw new ProbeBlocked(message);
        throw new Error(`Runtime task ${task.id} failed: ${message}`);
      }
    }
    if (initialTurn === null && current.status === 'idle' && state.members.length === 2) {
      const firstOutput = loop.store.outputs(coordinatorId).map(output => output.text).join('\n');
      assert.match(firstOutput, /COORDINATOR_WAITING_FOR_REPORT/, 'Coordinator must end its dispatch turn before the worker is released');
      assert.ok(current.turnId);
      assert.ok(current.threadId);
      initialTurn = current.turnId; initialThread = current.threadId;
      note('dispatch_turn_ended', { initialTurn, initialThread });
    }
    if (initialTurn !== null && gateOpenedAt === null && current.status === 'idle') {
      if (!loop.store.inputs(coordinatorId).some(input => input.status !== 'delivered' && input.status !== 'dropped')) {
        gateOpenedAt = Date.now();
        await writeFile(gateFile, 'Coordinator dispatch turn has ended. The read-only worker may proceed.\n');
        note('worker_gate_opened', { initialTurn, initialThread, at: gateOpenedAt });
      }
    }
    const record = state.records.find(item => item.key === recordKey);
    const currentLoop = loop;
    const allIdle = executions.length === 2 && intakes.length === 2 && executions.every(task => task.status === 'idle'
      && currentLoop.store.inputs(task.id).every(input => input.status === 'delivered' || input.status === 'dropped'));
    if (record && allIdle) {
      assert.ok(gateOpenedAt !== null);
      const worker = state.members.find(member => member.role === 'worker'); assert.ok(worker);
      assert.equal(worker.issueId, 'live-issue-101');
      const workerTask = loop.store.task(worker.taskId);
      assert.notEqual(workerTask.threadId, current.threadId);
      assert.ok(workerTask.resources.some(resource => resource.kind === 'project' && resource.workspace === directory), 'Worker must use the actual WorkspaceProvider project directory');
      assert.equal(record.authorTaskId, coordinatorId);
      assert.equal(record.requestId, recordId);
      assert.equal(record.version, 1);
      assert.match(record.text, new RegExp(marker));
      assert.ok(record.text.includes(worker.taskId) && record.text.includes(proofFile));
      const successful = calls.filter(call => call.status === 'succeeded');
      assert.equal(calls.filter(call => call.status === 'rejected').length, 0, 'No tool error may be concealed by a successful final answer');
      const coordinatorCalls = successful.filter(call => call.request.threadId === current.threadId);
      assert.equal(coordinatorCalls[0]?.request.action.action, 'status');
      assert.equal(successful.filter(call => call.request.action.action === 'dispatch').length, 1);
      const reports = successful.filter(call => call.request.action.action === 'report');
      assert.equal(reports.length, 1);
      const report = reports[0]; assert.ok(report && report.request.action.action === 'report');
      assert.equal(report.request.threadId, workerTask.threadId);
      assert.ok(report.startedAt >= gateOpenedAt);
      assert.ok(report.request.action.text.includes(marker));
      const recorded = successful.find(call => call.request.action.action === 'record');
      assert.ok(recorded && recorded.request.action.action === 'record');
      assert.equal(recorded.request.action.expectedVersion, 0, 'Coordinator must use the actual CAS version');
      assert.equal(recorded.request.threadId, current.threadId);
      assert.notEqual(recorded.request.turnId, initialTurn, 'Worker report must wake a later coordinator turn');
      assert.ok(reportArrival);
      assert.equal(reportArrival.status, 'idle', 'Report must arrive at an idle coordinator');
      assert.notEqual(recorded.request.turnId, reportArrival.turnId);
      const reportInput = loop.store.inputs(coordinatorId).find(input => input.provenance.kind === 'agent'
        && input.provenance.taskId === worker.taskId && input.provenance.category === 'result' && input.message.text.includes(marker));
      assert.ok(reportInput);
      assert.equal(reportInput.provenance.kind, 'agent');
      assert.equal(reportInput.status, 'delivered');
      const receiptTurnStart = loop.store.executionEvents(coordinatorId, 0, 100_000).find(event => event.kind === 'turn_start' && event.turnId === recorded.request.turnId);
      assert.ok(receiptTurnStart && receiptTurnStart.createdAt >= reportArrival.at, 'Receipt turn must start after the actual worker report');
      const workerEvents = loop.store.executionEvents(worker.taskId, 0, 100_000);
      assert.ok(workerEvents.some(event => ['tool_output', 'tool_end'].includes(event.kind)
        && event.text.includes(marker)), 'Marker must be observed in actual worker tool output');
      const workerOutputs = loop.store.outputs(worker.taskId).map(output => output.text).join('\n');
      assert.ok(workerOutputs.includes(marker));
      const coordinatorOutputs = loop.store.outputs(coordinatorId).map(output => output.text).join('\n');
      assert.match(coordinatorOutputs, /COORDINATOR_RECEIPT_RECORDED/);
      assert.ok(coordinatorOutputs.includes(marker));
      for (const task of tasks) for (const event of loop.store.executionEvents(task.id, 0, 100_000)) {
        if (event.kind === 'tool_start') assert.ok(event.label.startsWith('project_action') || event.text.startsWith('$ '), 'No external tool or nested agent may be used');
      }
      assert.deepEqual({ files: (await readdir(directory)).sort(),
        proof: createHash('sha256').update(await readFile(proofFile)).digest('hex'),
        instructions: createHash('sha256').update(await readFile(join(directory, 'AGENTS.md'))).digest('hex') }, fixtureBefore, 'Read-only fixture must remain unchanged');
      assert.equal(github.verifications.length, 0);
      assert.equal(feishu.approvals.length, 0);
      coreProof = { coordinatorId, workerTaskId: worker.taskId, taskIdentities,
        retainedIntakeIds: intakes.map(task => task.id), initialThread, initialTurn,
        receiptTurn: recorded.request.turnId, receiptTurnStartedAt: receiptTurnStart.createdAt,
        gateOpenedAt, reportArrival, reportInputId: reportInput.id,
        reportProvenance: reportInput.provenance, marker, record, fixtureBefore, calls: successful.length };
      note('core_acceptance_passed', coreProof);
      break;
    }
    await delay(500);
  }
  if (!coreProof) throw new ProbeBlocked('Bounded deadline expired before all dispatch/report/wakeup/CAS assertions passed');
  runtimeEvidence.push({ phase: 'core', snapshot: snapshot(loop) });
  if (options.restart === '1') {
    const before = { tasks: loop.tasks().map(task => ({ id: task.id, threadId: task.threadId, turnId: task.turnId })),
      state: loop.projects.ledger.project(projectId), calls: calls.length };
    await bounded('initial Runtime shutdown', loop.close());
    loop = newLoop();
    await bounded('Runtime recovery against the same SQLite and real Codex threads', loop.recover());
    await bounded('repeat Issue collection', loop.collect());
    await bounded('post-recovery tick', loop.tick());
    assert.deepEqual(loop.tasks().map(task => ({ id: task.id, threadId: task.threadId, turnId: task.turnId })), before.tasks);
    assert.deepEqual(loop.projects.ledger.project(projectId), before.state);
    const recoveredState = loop.projects.ledger.project(projectId); assert.ok(recoveredState);
    const recovered = assertProbeTaskInventory(loop.tasks(), recoveredState, taskIdentities);
    assert.equal(recovered.executions.length, 2);
    assert.equal(recovered.intakes.length, 2);
    assert.ok(recovered.executions.every(task => task.status === 'idle'));
    assert.equal(calls.length, before.calls, 'Restart must not trigger a new dispatch, report or record');
    const persisted = new Store(config.dataDir, { readOnly: true });
    try { assert.deepEqual(persisted.tasks().map(task => task.id), before.tasks.map(task => task.id)); }
    finally { persisted.close(); }
    restartProof = { result: 'passed', before, after: loop.tasks().map(task => ({ id: task.id, threadId: task.threadId, turnId: task.turnId })) };
    runtimeEvidence.push({ phase: 'after-restart', snapshot: snapshot(loop) });
    note('restart_acceptance_passed');
  } else restartProof = { result: 'skipped', reason: 'Explicit PROJECT_COORDINATOR_VERIFY_RESTART=0' };
}

try {
  await verify();
  outcome = { result: 'passed' };
} catch (error) {
  outcome = { result: error instanceof ProbeBlocked || codexUnavailable(errorText(error)) ? 'blocked' : 'failed', error: errorText(error) };
  note('acceptance_stopped', outcome);
  process.exitCode = 1;
} finally {
  try { if (loop && outcome.result !== 'passed') runtimeEvidence.push({ phase: 'stopped', snapshot: snapshot(loop) }); }
  catch (error) { cleanup.push({ resource: 'Runtime evidence', result: errorText(error) }); }
  try { databaseEvidence = readDatabase(); }
  catch (error) { cleanup.push({ resource: 'SQLite evidence', result: errorText(error) }); }
  try {
    for (const file of await readdir(join(config.dataDir, 'workspace-capabilities'))) {
      const capability = z.object({ token: z.string() }).parse(JSON.parse(await readFile(join(config.dataDir, 'workspace-capabilities', file), 'utf8')));
      secrets.add(capability.token);
    }
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) cleanup.push({ resource: 'Capability redaction', result: errorText(error) }); }
  try { await loop?.close(); cleanup.push({ resource: 'Runtime', result: 'closed' }); }
  catch (error) { cleanup.push({ resource: 'Runtime', result: errorText(error) }); }
  for (const server of servers) {
    try { await server.close(); cleanup.push({ resource: 'CodexAppServer', result: 'closed' }); }
    catch (error) { cleanup.push({ resource: 'CodexAppServer', result: errorText(error) }); }
  }
  const sanitize = (value: unknown) => {
    let text = JSON.stringify(value, null, 2);
    for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED_TASK_CAPABILITY]');
    return text.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]') + '\n';
  };
  try { await rm(root, { recursive: true, force: true }); cleanup.push({ resource: 'Temporary fixture and capabilities', result: 'removed' }); }
  catch (error) { cleanup.push({ resource: 'Temporary fixture and capabilities', result: errorText(error) }); }
  if (cleanup.some(item => !['closed', 'removed'].includes(item.result))) {
    if (outcome.result === 'passed') outcome = { result: 'failed', error: 'Acceptance or cleanup evidence is incomplete; inspect cleanup' };
    process.exitCode = 1;
  }
  await writeFile(join(evidenceDirectory, 'runtime.json'), sanitize(runtimeEvidence), { mode: 0o600 });
  await writeFile(join(evidenceDirectory, 'database.json'), sanitize(databaseEvidence), { mode: 0o600 });
  await writeFile(join(evidenceDirectory, 'actions.json'), sanitize(calls), { mode: 0o600 });
  await writeFile(join(evidenceDirectory, 'summary.json'), sanitize({ ...outcome,
    scope: 'Actual AgentLoop, real SQLite, WorkspaceProvider and native CodexAppServer. Feishu/GitHub are local fakes. One read-only worker, result wakeup, coordinator CAS receipt, optional same-thread restart.',
    excluded: ['Real Feishu/GitHub writes', 'PR delivery/merge', 'Production service operations', 'Remote hosts', 'Images', 'Session rotation', 'Independent model review'],
    fallbackModel: options.model ?? 'Native Codex default', roleModels: config.projects[0]?.models,
    roleReasoningEfforts: config.projects[0]?.reasoningEfforts, command: 'npx --no-install tsx scripts/verify-project-coordinator.ts',
    source: { script: resolve('scripts/verify-project-coordinator.ts'),
      sha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
      atStart: sourceAtStart, atFinish: await fingerprintSources() },
    throughputCheckpoint: { blockingFirstSteps: 'Read spec and adapter/runtime interfaces; type-check before live execution.',
      independentWorkstreams: 'One script owner; module and test changes belong to the parent and other agents.',
      sharedMutableState: 'Unique temporary fixture, SQLite and native Codex threads per run.',
      smallestSafeDecomposition: 'Single probe owner; nested agents prohibited by the task.' },
    startedAt, finishedAt: Date.now(), timeoutMs: options.timeoutMs, root, evidenceDirectory,
    coreProof, restartProof, timeline, cleanup, redaction: 'Capability tokens and bearer credentials redacted. Only project metadata selected; no environment or Codex configuration dump. Temporary SQLite removed after SQL evidence export.' }), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...outcome, evidenceDirectory })}\n`);
}
