import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { availableParallelism, cpus, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setImmediate as yieldToIo, setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { IncomingMessage, Task } from '../src/domain.js';
import type { Inbox } from '../src/store.js';
import { CodexFake, FeishuFake, GitHubFake, issue } from '../test/fakes.js';

const { values } = parseArgs({ options: {
  source: { type: 'string', default: resolve(dirname(fileURLToPath(import.meta.url)), '..') },
  label: { type: 'string', default: 'runtime' },
  shape: { type: 'string', default: 'live' },
  duration: { type: 'string', default: '9000' },
  poll: { type: 'string', default: '2000' },
  output: { type: 'string' },
  profile: { type: 'string' },
  'keep-fixture': { type: 'boolean', default: false },
  compiled: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  process.stdout.write('Usage: tsx scripts/benchmark-runtime.ts [--source REPO] [--label NAME] [--shape live|unicode|revisions] [--duration 9000] [--poll 2000] [--output FILE] [--profile FILE] [--compiled] [--keep-fixture]\n');
  process.exit(0);
}
const durationMs = Number(values.duration), pollMs = Number(values.poll);
assert.ok(Number.isInteger(durationMs) && durationMs >= 6000 && durationMs <= 15000, 'duration must be 6000..15000 ms');
assert.ok(Number.isInteger(pollMs) && pollMs > 0, 'poll must be positive milliseconds');
assert.ok(values.shape === 'live' || values.shape === 'unicode' || values.shape === 'revisions', 'shape must be live, unicode or revisions');
const sourceRoot = await realpath(values.source);
const sourceFile = (name: string) => join(sourceRoot, values.compiled ? 'dist/src' : 'src', `${name}.${values.compiled ? 'js' : 'ts'}`);
const { AgentLoop }: typeof import('../src/loop.js') = await import(pathToFileURL(sourceFile('loop')).href);
const { Store }: typeof import('../src/store.js') = await import(pathToFileURL(sourceFile('store')).href);
const { ProjectLedger }: typeof import('../src/project.js') = await import(pathToFileURL(sourceFile('project')).href);
const { configSchema }: typeof import('../src/config.js') = await import(pathToFileURL(sourceFile('config')).href);
const { taskSchema }: typeof import('../src/domain.js') = await import(pathToFileURL(sourceFile('domain')).href);

type Counts = Record<string, number>;
type Arrival = {
  taskId: string; threadId: string; message: IncomingMessage; expectedReply: string; scheduledMs: number;
  receivedMs: number | null; persistedMs: number | null; startedMs: number | null;
  completedMs: number | null; sentMs: number | null;
};
const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'agent-loop-runtime-bench-')));
let measuring = false, startedAt = 0;
let counts: Counts = {};
const arrivals: Arrival[] = [];
const errors: { scope: string; message: string }[] = [];
const count = (key: string, amount = 1) => { if (measuring) counts[key] = (counts[key] ?? 0) + amount; };
const elapsed = () => performance.now() - startedAt;
const fail = (scope: string, error: unknown): void => { errors.push({ scope, message: error instanceof Error ? error.stack ?? error.message : String(error) }); };

class MeasuredStore extends Store {
  override meta(key: string): string | null {
    count('store.meta');
    const value = super.meta(key);
    if (key.startsWith('project:["state",')) {
      count('store.projectDocumentReads');
      count('store.projectDocumentCharacters', value?.length ?? 0);
    }
    return value;
  }
  override setMeta(key: string, value: string): void { count('store.setMeta'); super.setMeta(key, value); }
  override task(id: string): Task { count('store.task'); return super.task(id); }
  override tasks(): Task[] { count('store.tasks'); return super.tasks(); }
  override saveTask(task: Task): void { count('store.saveTask'); super.saveTask(task); }
  override inputs(taskId: string): Inbox[] { count('store.inputs'); return super.inputs(taskId); }
  override outputs(taskId: string) { count('store.outputs'); return super.outputs(taskId); }
  override hasOutput(taskId: string, key: string): boolean { count('store.hasOutput'); return super.hasOutput(taskId, key); }
  override enqueue(taskId: string, text: string, key: string): string { count('store.enqueue'); return super.enqueue(taskId, text, key); }
  override markOutput(...args: Parameters<InstanceType<typeof Store>['markOutput']>): void { count('store.markOutput'); super.markOutput(...args); }
  override markInput(...args: Parameters<InstanceType<typeof Store>['markInput']>): void { count('store.markInput'); super.markInput(...args); }
  override receive(...args: Parameters<InstanceType<typeof Store>['receive']>): boolean {
    count('store.receiveAttempts');
    const accepted = super.receive(...args);
    count(accepted ? 'store.received' : 'store.duplicateInputs');
    const arrival = arrivals.find(item => item.message.id === args[1].id);
    if (measuring && arrival && accepted) arrival.persistedMs = elapsed();
    return accepted;
  }
}

const background = new Set<Promise<void>>();
function track(scope: string, action: Promise<void>): void {
  const tracked = action.catch(error => fail(scope, error)).finally(() => background.delete(tracked));
  background.add(tracked);
}

class BenchmarkCodex extends CodexFake {
  override async inspect(...args: Parameters<CodexFake['inspect']>) {
    count('codex.inspect');
    await yieldToIo();
    const snapshot = await super.inspect(...args);
    count('codex.observedOutputs', snapshot.outputs.length);
    return snapshot;
  }
  override async activity(...args: Parameters<CodexFake['activity']>) {
    count('codex.activity');
    await yieldToIo();
    return super.activity(...args);
  }
  override async startTurn(input: Parameters<CodexFake['startTurn']>[0]): Promise<string> {
    count('codex.startTurn');
    await yieldToIo();
    const arrival = arrivals.find(item => item.message.id === input.deliveryId);
    assert.ok(arrival, `Unexpected turn ${input.deliveryId}`);
    assert.equal(input.threadId, arrival.threadId);
    assert.equal(arrival.startedMs, null, `Duplicate native delivery ${input.deliveryId}`);
    assert.ok(input.input.some(part => part.kind === 'text' && part.text === arrival.message.text), 'Exact owner input reached native execution');
    assert.equal(input.additionalDeliveryIds?.length ?? 0, 0, 'Each scheduled owner message starts independently');
    const turn = await super.startTurn(input);
    arrival.startedMs = elapsed();
    track(`completion:${input.deliveryId}`, delay(50).then(() => {
      this.complete(input.threadId, arrival.expectedReply);
      arrival.completedMs = elapsed();
      count('codex.completed');
    }));
    return turn;
  }
}

class BenchmarkFeishu extends FeishuFake {
  override async send(input: Parameters<FeishuFake['send']>[0]): Promise<void> {
    count('feishu.send');
    await yieldToIo();
    const arrival = arrivals.find(item => item.expectedReply === input.text);
    assert.ok(arrival, `Unexpected output ${input.text.slice(0, 100)}`);
    assert.equal(input.chatId, arrival.message.chatId);
    assert.equal(arrival.sentMs, null, `Duplicate reply ${arrival.message.id}`);
    assert.ok(arrival.completedMs !== null, 'Native completion precedes output delivery');
    await super.send(input);
    arrival.sentMs = elapsed();
  }
}

const store = new MeasuredStore(join(fixtureRoot, 'data'));
const codex = new BenchmarkCodex(), feishu = new BenchmarkFeishu();
const projects = [
  { id: 'record-heavy', members: 33, records: 337, targetBytes: 473572, issues: values.shape === 'revisions' ? 15 : 0, comments: 0 },
  { id: 'history-heavy', members: 39, records: values.shape === 'revisions' ? 160 : 40, targetBytes: values.shape === 'revisions' ? 300000 : 112924, issues: values.shape === 'revisions' ? 15 : 6, comments: 5 },
];
const config = configSchema.parse({
  dataDir: join(fixtureRoot, 'data'), repositories: [], pollIntervalMs: 30000, executionPollMs: pollMs,
  projects: projects.map(project => ({ id: project.id, name: project.id, directory: join(fixtureRoot, project.id), repositories: [] })),
  feishu: { userOpenId: 'benchmark-owner', progress: { enabled: false } },
  execution: { coordinator: { backend: 'codex', model: 'benchmark-fake', reasoningEffort: 'high' },
    worker: { backend: 'codex', model: 'benchmark-fake', reasoningEffort: 'high' } },
});
const loop = new AgentLoop(config, { codex, feishu, github: new GitHubFake(), workspace: {
  ensure: async () => { throw new Error('Benchmark must not acquire a workspace'); },
  head: async () => { throw new Error('Benchmark must not inspect a real workspace'); },
} }, store);
const ledger = new ProjectLedger(store);
const epoch = Date.parse('2026-11-01T00:00:00Z');
const allTasks: Task[] = [];
const fixtureProjects: { id: string; bytes: number; members: number; records: number; issues: number; comments: number; issueRevisions: number; commentRevisions: number }[] = [];
const timers: ReturnType<typeof setTimeout>[] = [];
const intervals: ReturnType<typeof setInterval>[] = [];
const ticks: { scheduledMs: number; startedMs: number; finishedMs: number | null }[] = [];
let activeTicks = 0, maxActiveTicks = 0;
let profiler: Session | undefined;

async function fingerprint() {
  return Object.fromEntries(await Promise.all(['loop', 'project', 'project-runtime', 'store'].map(async name =>
    [name, createHash('sha256').update(await readFile(sourceFile(name))).digest('hex')])));
}
const sourceBefore = await fingerprint();
let revision = 'archive-or-unversioned';
try {
  const repositoryRoot = await realpath(execFileSync('git', ['-C', sourceRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  if (repositoryRoot === sourceRoot) revision = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {}

try {
  for (const project of projects) {
    const directory = join(fixtureRoot, project.id);
    await mkdir(directory);
    const members: Task[] = [];
    for (let index = 0; index < project.members; index++) {
      const id = `${project.id}-${index}`, threadId = `thread-${id}`, chatId = `chat-${id}`;
      const historicalOutputs = index === 0 ? 90 : 2;
      const lastTurnId = `${id}-old-turn-${historicalOutputs - 1}`;
      const message: IncomingMessage = { id: `initial-${id}`, chatId, senderId: 'benchmark-owner', chatType: 'group',
        text: `Retained local request ${id}`, attachments: [], createdAt: epoch };
      const task = taskSchema.parse({ id, sourceId: `source-${id}`, source: { kind: 'manual', message }, purpose: 'execution',
        contextDirectory: join(fixtureRoot, 'contexts', id), resources: [], status: 'idle', reason: null,
        prompt: message.text, promptHash: 'fixture', skillPath: null, chatId, threadId,
        turnId: lastTurnId, executionStatus: 'idle', lastHandledTurnId: lastTurnId, requests: [], createdAt: epoch, updatedAt: epoch });
      await mkdir(task.contextDirectory, { recursive: true });
      store.saveTask(task); members.push(task); allTasks.push(task); feishu.groups.set(id, chatId);
      const outputs = Array.from({ length: historicalOutputs }, (_, outputIndex) => ({
        id: `${id}-old-output-${outputIndex}`, threadId, turnId: `${id}-old-turn-${outputIndex}`, phase: 'final' as const,
        text: `Retained final ${id}/${outputIndex}. ${'Historical investigation and delivery evidence. '.repeat(12)}`,
      }));
      codex.threads.set(threadId, { threadId, turnId: task.turnId, status: 'idle', requests: [], outputs, seenInputIds: [], error: null });
      for (const output of outputs) {
        store.markOutput(store.enqueue(id, output.text, `agent-output:${output.id}`), 'sent');
        if (index === 0) store.setMeta(`project-coordinator-turn:${JSON.stringify([id, output.turnId])}`,
          JSON.stringify({ directUserMessage: true, visibleLifecycleEvent: false, announced: true }));
      }
    }
    const coordinator = members[0]; assert.ok(coordinator);
    const state = ledger.create({ id: project.id, name: project.id, directory, repositories: [], instructions: '' }, coordinator.id);
    state.members.push(...members.slice(1).map(task => ({ taskId: task.id, role: 'worker' as const })));
    ledger.save(state);
    const revisionsPerIssue = values.shape === 'revisions' ? 3 : 2;
    for (let issueIndex = 0; issueIndex < project.issues; issueIndex++) {
      for (let revisionIndex = 0; revisionIndex < revisionsPerIssue; revisionIndex++) {
        ledger.issue(project.id, issue(issueIndex + 1, { id: `${project.id}-issue-${issueIndex}`, repository: `fixture/${project.id}`,
          url: `https://example.invalid/${project.id}/issues/${issueIndex + 1}`,
          body: `Revision ${revisionIndex}. ${'Reproduction, acceptance and current implementation evidence. '.repeat(20)}`,
          updatedAt: new Date(epoch + revisionIndex * 60000).toISOString() }));
      }
    }
    for (let commentIndex = 0; commentIndex < project.comments; commentIndex++) {
      ledger.comment(project.id, { id: `${project.id}-comment-${commentIndex}`, sourceId: `${project.id}-issue-${commentIndex % project.issues}`,
        url: `https://example.invalid/comments/${commentIndex}`, author: 'fixture-owner', body: 'Preserved discussion. '.repeat(20),
        createdAt: new Date(epoch).toISOString(), updatedAt: new Date(epoch).toISOString() });
    }
    const current = ledger.project(project.id); assert.ok(current);
    current.records = Array.from({ length: project.records }, (_, index) => ({
      requestId: `record-${index}`, key: `evidence-${index % 30}`, text: 'x', version: index + 1,
      authorTaskId: coordinator.id, createdAt: epoch + index, scope: { kind: 'project' as const },
    }));
    current.version = current.records.length;
    const rawBeforeRecords = store.meta(`project:${JSON.stringify(['state', project.id])}`); assert.ok(rawBeforeRecords);
    const projectedBytes = Buffer.byteLength(rawBeforeRecords) + Buffer.byteLength(JSON.stringify(current.records));
    const textLength = Math.max(128, Math.floor((project.targetBytes - projectedBytes) / project.records));
    for (const record of current.records) record.text = values.shape === 'unicode'
      ? '项目协调者的历史决策与验收记录。'.repeat(Math.max(1, Math.floor(textLength / Buffer.byteLength('项目协调者的历史决策与验收记录。'))))
      : 'Local investigation notes, decisions, acceptance, evidence, and retained result. '.repeat(Math.ceil(textLength / 78)).slice(0, textLength);
    ledger.save(current);
    const raw = store.meta(`project:${JSON.stringify(['state', project.id])}`); assert.ok(raw);
    fixtureProjects.push({ id: project.id, bytes: Buffer.byteLength(raw), members: current.members.length,
      records: current.records.length, issues: current.issues.length, comments: current.comments.length,
      issueRevisions: project.issues * revisionsPerIssue, commentRevisions: project.comments });
  }
  const extra = taskSchema.parse({ ...allTasks[1], id: 'unassigned-failed', sourceId: 'source-unassigned', purpose: 'intake',
    threadId: null, chatId: null, turnId: null, status: 'failed', executionStatus: 'unbound', lastHandledTurnId: null,
    reason: 'Fixture retains one unassigned failed intake', contextDirectory: join(fixtureRoot, 'unassigned') });
  store.saveTask(extra); allTasks.push(extra);
  for (let index = 0; index < 1405; index++) {
    const task = allTasks[index % allTasks.length]; assert.ok(task);
    const message: IncomingMessage = { id: `retained-inbox-${index}`, chatId: task.chatId ?? '', senderId: 'benchmark-owner',
      chatType: 'group', text: `Previous resolved owner request ${index}. ${'Retained context. '.repeat(8)}`, attachments: [], createdAt: epoch + index };
    assert.equal(store.receive(task.id, message), true); store.markInput(message.id, 'delivered');
  }
  const membership = loop.projects.ledger.membership.bind(loop.projects.ledger);
  loop.projects.ledger.membership = (...args) => { count('ledger.membership'); return membership(...args); };
  const projectRead = loop.projects.ledger.project.bind(loop.projects.ledger);
  loop.projects.ledger.project = (...args) => { count('ledger.project'); return projectRead(...args); };
  const publish = loop.projects.publishCoordinatorFinal.bind(loop.projects);
  loop.projects.publishCoordinatorFinal = (...args) => { count('runtime.publishCoordinatorFinal'); return publish(...args); };

  const idleMs = Math.round(durationMs * 0.43);
  const targetIds = ['record-heavy-0', 'history-heavy-0', 'history-heavy-1'];
  for (const [index, taskId] of targetIds.entries()) {
    const task = store.task(taskId); assert.ok(task.threadId && task.chatId);
    const id = `measured-owner-${index}`;
    arrivals.push({ taskId, threadId: task.threadId,
      message: { id, chatId: task.chatId, senderId: 'benchmark-owner', chatType: 'group',
        text: `Verify exact runtime reply ${index}; preserve this message once.`, attachments: [], createdAt: Date.now() },
      expectedReply: `Exact benchmark reply ${index}. Owner message ${id} was executed once.`,
      scheduledMs: idleMs + 200 + index * Math.round(durationMs * 0.08),
      receivedMs: null, persistedMs: null, startedMs: null, completedMs: null, sentMs: null });
  }

  await loop.projects.ensure();
  await loop.tick();
  assert.equal(feishu.sent.length, 0, 'Warmup must not replay retained outputs');
  assert.equal(codex.starts.length, 0, 'Warmup must not execute retained inputs');
  assert.equal(store.diagnostics().length, 0, 'Warmup must have no diagnostics');
  if (values.profile) {
    profiler = new Session(); profiler.connect();
    await profiler.post('Profiler.enable'); await profiler.post('Profiler.start');
  }
  const hostBefore = { loadAverage: loadavg(), logicalCores: cpus().length, availableParallelism: availableParallelism() };
  const eventDelay = monitorEventLoopDelay({ resolution: 20 }); eventDelay.enable();
  counts = {}; measuring = true; startedAt = performance.now();
  const cpuStart = process.cpuUsage();
  const tick = (scheduledMs: number) => {
    const sample = { scheduledMs, startedMs: elapsed(), finishedMs: null as number | null }; ticks.push(sample);
    activeTicks++; maxActiveTicks = Math.max(maxActiveTicks, activeTicks); count('runtime.tickStarted');
    track('tick', loop.tick().finally(() => { activeTicks--; sample.finishedMs = elapsed(); count('runtime.tickCompleted'); }));
  };
  let nextTick = pollMs;
  intervals.push(setInterval(() => { tick(nextTick); nextTick += pollMs; }, pollMs));
  tick(0);
  let idle: { wallMs: number; cpuMs: number; cpuPercentOneCore: number; counts: Counts } | null = null;
  timers.push(setTimeout(() => {
    const cpu = process.cpuUsage(cpuStart), wallMs = elapsed(), cpuMs = (cpu.user + cpu.system) / 1000;
    idle = { wallMs, cpuMs, cpuPercentOneCore: cpuMs / wallMs * 100, counts: { ...counts } };
  }, idleMs));
  for (const arrival of arrivals) {
    timers.push(setTimeout(() => {
      arrival.receivedMs = elapsed(); count('runtime.ownerArrivals');
      track(`receive:${arrival.message.id}`, loop.receive(arrival.message));
      timers.push(setTimeout(() => { count('runtime.duplicateArrivals'); track(`duplicate:${arrival.message.id}`, loop.receive(arrival.message)); }, 200));
    }, arrival.scheduledMs));
  }
  await delay(durationMs);
  for (const interval of intervals) clearInterval(interval);
  for (const timer of timers) clearTimeout(timer);
  while (background.size) await Promise.all([...background]);
  const cpu = process.cpuUsage(cpuStart), wallMs = elapsed(), cpuMs = (cpu.user + cpu.system) / 1000;
  measuring = false; eventDelay.disable();
  let profileSummary: { functionName: string; url: string; line: number; samples: number }[] | null = null;
  if (profiler && values.profile) {
    const { profile } = await profiler.post('Profiler.stop'); profiler.disconnect(); profiler = undefined;
    await mkdir(dirname(resolve(values.profile)), { recursive: true });
    await writeFile(values.profile, JSON.stringify(profile));
    profileSummary = profile.nodes.filter(node => (node.hitCount ?? 0) > 0)
      .sort((left, right) => (right.hitCount ?? 0) - (left.hitCount ?? 0)).slice(0, 20)
      .map(node => ({ functionName: node.callFrame.functionName, url: node.callFrame.url, line: node.callFrame.lineNumber + 1, samples: node.hitCount ?? 0 }));
  }
  const workCounts = { ...counts };
  const diagnostics = store.diagnostics();
  const check = (name: string, action: () => void) => { try { action(); } catch (error) { fail(name, error); } };
  check('all-messages', () => {
    assert.equal(arrivals.length, 3); assert.equal(codex.starts.length, arrivals.length);
    assert.equal(feishu.sent.length, arrivals.length); assert.equal(codex.steers.length, 0);
    assert.equal(workCounts['store.received'], arrivals.length); assert.equal(workCounts['store.duplicateInputs'], arrivals.length);
    for (const arrival of arrivals) {
      const inbox = store.inputs(arrival.taskId).filter(input => input.id === arrival.message.id);
      assert.equal(inbox.length, 1); assert.equal(inbox[0]?.status, 'delivered');
      assert.equal(inbox[0]?.message.text, arrival.message.text);
      assert.equal(codex.starts.filter(start => start.deliveryId === arrival.message.id).length, 1);
      assert.equal(feishu.sent.filter(sent => sent.text === arrival.expectedReply).length, 1);
      assert.ok(arrival.persistedMs !== null && arrival.startedMs !== null && arrival.completedMs !== null && arrival.sentMs !== null);
      const outputs = store.outputs(arrival.taskId).filter(output => output.text === arrival.expectedReply);
      assert.equal(outputs.length, 1); assert.equal(outputs[0]?.status, 'sent');
      const native = codex.snapshot(arrival.threadId);
      assert.equal(native.seenInputIds.filter(id => id === arrival.message.id).length, 1);
      assert.equal(native.outputs.filter(output => output.text === arrival.expectedReply).length, 1);
    }
    assert.equal(store.tasks().length, 73); assert.equal(diagnostics.length, 0);
    assert.equal(allTasks.reduce((total, task) => total + store.inputs(task.id).length, 0), 1405 + arrivals.length);
    const outbox = allTasks.flatMap(task => store.outputs(task.id));
    assert.equal(outbox.length, 320 + arrivals.length);
    assert.ok(outbox.every(output => output.status === 'sent'), 'Retained and new delivery receipts must remain sent');
    assert.ok(ticks.length >= 3 && ticks.every(sample => sample.finishedMs !== null), 'Repeated real ticks must finish');
  });
  const sourceAfter = await fingerprint();
  check('source-stable', () => assert.deepEqual(sourceAfter, sourceBefore, 'Runtime source changed during this invocation'));
  const result = {
    version: 1, label: values.label, at: new Date().toISOString(), sourceRoot, revision, sourceBefore,
    scriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
    node: process.version, hostBefore, hostAfter: { loadAverage: loadavg() },
    claim: 'At the original 2s poll, reduce repeated idle CPU work without skipping owner input execution or exact reply delivery.',
    profiled: !!values.profile, profileSummary, fixtureRoot: values['keep-fixture'] ? fixtureRoot : null,
    fixture: { shape: values.shape, tasks: 73, retainedInbox: 1405, coordinatorOutputsEach: 90, workerOutputsEach: 2, projects: fixtureProjects },
    configuration: { pollMs, durationMs, idleMs, fakeCompletionDelayMs: 50, fakeIoYield: 'setImmediate', progressEnabled: false },
    measurement: { wallMs, cpuMs, cpuPercentOneCore: cpuMs / wallMs * 100, userCpuMs: cpu.user / 1000, systemCpuMs: cpu.system / 1000,
      idle, counts: workCounts, maxActiveTicks, ticks,
      eventLoopDelayMs: { p50: eventDelay.percentile(50) / 1e6, p95: eventDelay.percentile(95) / 1e6, max: eventDelay.max / 1e6 },
      messages: arrivals.map(arrival => ({ ...arrival,
        arrivalLagMs: arrival.receivedMs === null ? null : arrival.receivedMs - arrival.scheduledMs,
        receiveToPersistMs: arrival.persistedMs === null || arrival.receivedMs === null ? null : arrival.persistedMs - arrival.receivedMs,
        receiveToStartMs: arrival.startedMs === null || arrival.receivedMs === null ? null : arrival.startedMs - arrival.receivedMs,
        completionToSentMs: arrival.sentMs === null || arrival.completedMs === null ? null : arrival.sentMs - arrival.completedMs,
        scheduledToSentMs: arrival.sentMs === null ? null : arrival.sentMs - arrival.scheduledMs })) },
    errors, diagnostics, pass: errors.length === 0 && diagnostics.length === 0,
    limitations: [
      'Single local run. Use at least five alternating unprofiled runs per side before a comparison claim.',
      'Generated data follows observed shape; revisions mode is extra stress, not a production-data replay.',
      'Real AgentLoop, Store/SQLite, ProjectLedger, prompt files, Unix capability socket and output flush; only external ports are faked.',
      'The driver calls public tick on the configured interval; it does not start live collection, progress publishers, or native Codex.',
      'CPU includes the local fake ports, event-loop monitor and counters. Setup, warmup, verification and cleanup are excluded.',
      'Native completion takes 50ms plus timer delay; discovery and final flush retain the configured poll delay.',
      'An invocation ending before all replies fails; it does not add an untimed recovery tick.',
    ],
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (values.output) { await mkdir(dirname(resolve(values.output)), { recursive: true }); await writeFile(values.output, json); }
  process.stdout.write(json);
  if (!result.pass) process.exitCode = 1;
} catch (error) {
  fail('harness', error);
  const json = JSON.stringify({ version: 1, label: values.label, sourceRoot, revision, sourceBefore,
    scriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
    configuration: { pollMs, durationMs }, fixture: { shape: values.shape, tasks: allTasks.length, projects: fixtureProjects },
    pass: false, errors, diagnostics: store.diagnostics() }, null, 2) + '\n';
  if (values.output) { await mkdir(dirname(resolve(values.output)), { recursive: true }); await writeFile(values.output, json); }
  process.stdout.write(json); process.exitCode = 1;
} finally {
  measuring = false;
  for (const timer of timers) clearTimeout(timer);
  for (const interval of intervals) clearInterval(interval);
  if (profiler) profiler.disconnect();
  await Promise.allSettled([...background]);
  await loop.close();
  if (!values['keep-fixture']) await rm(fixtureRoot, { recursive: true, force: true });
}
