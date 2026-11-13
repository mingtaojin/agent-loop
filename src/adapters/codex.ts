import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { RejectedInputError, TurnChangedError, UncertainOperationError, workspaceTargetSchema, type AgentInput, type AgentOutput, type ExecutionSnapshot, type PendingRequest, type WorkspaceRequest, type WorkspaceSelectionRequest, type WorkspaceSelectionResponse } from '../domain.js';
import type { Activity, CodexPort, TurnIdentity } from '../ports.js';
import { executionEvent, type ExecutionEvent } from '../execution-events.js';
import { workspaceSelectionInput, workspaceSelectionInstructions, workspaceSelectionOutputSchema } from '../workspace-selection.js';
import { projectActionSchema, type ReasoningEffort } from '../project.js';

export interface CodexOptions {
  command: string[];
  model?: string;
  selectionModel?: string;
  approvalPolicy: 'untrusted' | 'on-request' | 'never';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  requestTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

const rpcIdSchema = z.union([z.string(), z.number().int()]);
const messageSchema = z.object({
  id: rpcIdSchema.optional(), method: z.string().optional(), params: z.unknown().optional(),
  result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional(),
});
const itemSchema = z.object({ id: z.string(), type: z.string() }).passthrough();
const turnSchema = z.object({
  id: z.string(), status: z.enum(['inProgress', 'completed', 'interrupted', 'failed']),
  error: z.object({ message: z.string() }).nullish(),
  items: z.array(itemSchema), itemsView: z.enum(['full', 'summary', 'notLoaded']).default('full'),
});
const turnPageSchema = z.object({ data: z.array(turnSchema), nextCursor: z.string().nullish() });
const userMessageSchema = z.object({ clientId: z.string().nullish(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) });
const agentMessageSchema = z.object({ id: z.string(), text: z.string(), phase: z.enum(['commentary', 'partial_answer', 'final_answer']).nullish() });
const inputIdsSchema = z.array(z.string());
const threadScopeSchema = z.object({ threadId: z.string() });
const threadSchema = z.object({
  id: z.string(), status: z.object({ type: z.enum(['notLoaded', 'idle', 'active', 'systemError']) }),
  historyMode: z.enum(['legacy', 'paginated']).default('legacy'), turns: z.array(turnSchema),
});
const threadResponseSchema = z.object({ thread: threadSchema });
const requestBaseSchema = z.object({ threadId: z.string(), turnId: z.string(), itemId: z.string() });
const questionsSchema = requestBaseSchema.extend({
  isBlocking: z.boolean(),
  questions: z.array(z.object({
    id: z.string(), header: z.string(), question: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() })).nullable().optional(),
  })).min(1),
});
const specialPathSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root') }), z.object({ kind: z.literal('minimal') }),
  z.object({ kind: z.literal('project_roots'), subpath: z.string().nullish() }),
  z.object({ kind: z.literal('tmpdir') }), z.object({ kind: z.literal('slash_tmp') }),
  z.object({ kind: z.literal('unknown'), path: z.string(), subpath: z.string().nullish() }),
]);
const permissionsSchema = z.object({
  network: z.object({ enabled: z.boolean().nullish() }).strict().nullish(),
  fileSystem: z.object({
    read: z.array(z.string()).nullish(), write: z.array(z.string()).nullish(),
    globScanMaxDepth: z.number().int().positive().nullish(),
    entries: z.array(z.object({
      access: z.enum(['read', 'write', 'deny']),
      path: z.discriminatedUnion('type', [
        z.object({ type: z.literal('path'), path: z.string() }),
        z.object({ type: z.literal('glob_pattern'), pattern: z.string() }),
        z.object({ type: z.literal('special'), value: specialPathSchema }),
      ]),
    }).strict()).nullish(),
  }).strict().nullish(),
}).strict();
const permissionRequestSchema = requestBaseSchema.extend({
  cwd: z.string(), startedAtMs: z.number().int(), reason: z.string().nullish(), permissions: permissionsSchema,
});
const approvalSchema = requestBaseSchema.extend({
  startedAtMs: z.number().int(), command: z.string().nullish(), reason: z.string().nullish(),
  cwd: z.string().nullish(), grantRoot: z.string().nullish(), kind: z.enum(['command', 'writeStdin']).optional(),
});
const answersSchema = z.object({ answers: z.record(z.string(), z.object({ answers: z.array(z.string()).min(1) }).strict()) }).strict();
const workspaceTool = {
  type: 'function', name: 'ensure_workspace',
  description: 'Get an additional engineering workspace using an exact Runtime-supplied projectId, or a configured or saved legacy repository name. Use the returned absolute path and read its project instructions. This does not grant additional filesystem permissions.',
  inputSchema: z.toJSONSchema(workspaceTargetSchema),
};
const { $schema: _projectSchema, ...projectInputSchema } = z.toJSONSchema(projectActionSchema, { io: 'input' });
const projectTool = {
  type: 'function', name: 'project_action',
  description: 'Query project status, dispatch or message a task, report progress or questions, record durable project information, rotate the coordinator session, or release an owned workspace. Use nonblank identifiers and text. Project membership and caller role determine allowed actions. Reuse requestId only to retry the same action. This tool grants no additional engineering permissions.',
  inputSchema: projectInputSchema,
};
type RpcId = z.infer<typeof rpcIdSchema>;
type LiveRequest = {
  rpcId: RpcId;
  request: PendingRequest;
  responseSent: boolean;
  waiters: Set<(confirmed: boolean) => void>;
  response: { kind: 'question'; questions: z.infer<typeof questionsSchema>['questions'] }
    | { kind: 'approval' }
    | { kind: 'permissions'; permissions: z.infer<typeof permissionsSchema> }
    | { kind: 'unsupported' };
};
type RpcOutcome = { kind: 'success'; value: unknown } | { kind: 'failure'; error: Error };
type PendingCall = { kind: 'pending'; method: string; resolve: (value: unknown) => void; reject: (error: Error) => void;
  timer: NodeJS.Timeout; settled?: (outcome: RpcOutcome) => void }
  | { kind: 'timed-out'; method: string; settled: (outcome: RpcOutcome) => void };
type ThreadLoad = { kind: 'unloaded' } | { kind: 'ready' } | { kind: 'pending'; request: Promise<void> }
  | { kind: 'uncertain'; error: Error } | { kind: 'failed'; error: Error };
type ThreadEntry = { load: ThreadLoad; untouched: boolean; instructions: string | undefined; model?: string; reasoningEffort?: ReasoningEffort };
class RpcTimeoutError extends UncertainOperationError {}
type CompletedHistory = { turnId: string; status: 'completed'; error: string | null; seenInputIds: string[]; digest: string };
type HistoryObservation = { completed?: CompletedHistory };
class TurnHistoryPendingError extends UncertainOperationError {}
class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

function isTurnHistoryMaterializing(error: unknown): error is RpcError {
  return error instanceof RpcError && error.message === 'thread/turns/list: list_turns is not supported yet';
}

function historyDigest(value: object): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    return entry;
  })).digest('hex');
}

function wireInput(input: AgentInput[], deliveryId: string, additionalDeliveryIds: string[] = []) {
  const batch = additionalDeliveryIds.length ? `\n[agent-loop-batch:${encodeURIComponent(JSON.stringify(additionalDeliveryIds))}]` : '';
  return [
    { type: 'text', text: `[agent-loop-delivery:${encodeURIComponent(deliveryId)}]${batch}`, text_elements: [] },
    ...input.map(item => {
      switch (item.kind) {
        case 'text': return { type: 'text', text: item.text, text_elements: [] };
        case 'image': return { type: 'localImage', path: item.path };
        case 'skill': return { type: 'skill', name: item.name, path: item.path };
      }
    }),
  ];
}

export class CodexAppServer implements CodexPort {
  private epoch = randomUUID();
  private readonly calls = new Map<RpcId, PendingCall>();
  private readonly requests = new Map<string, LiveRequest>();
  private readonly seenRequestIds = new Set<string>();
  private readonly threads = new Map<string, ThreadEntry>();
  private readonly activeTurns = new Map<string, string>();
  private readonly startingTurns = new Map<string, Promise<string>>();
  private readonly endedTurns = new Map<string, string>();
  private readonly awaitingHistory = new Map<string, string>();
  private readonly historyObservations = new Map<string, HistoryObservation>();
  private summaryUnsupported = false;
  private process: ChildProcessWithoutNullStreams | undefined;
  private initialized: Promise<void> | undefined;
  private failure: Error | undefined;
  private recovery: Promise<void> | undefined;
  private closed = false;
  private workspaceHandler: Parameters<CodexPort['setWorkspaceHandler']>[0] | undefined;
  private projectHandler: Parameters<NonNullable<CodexPort['setProjectHandler']>>[0] | undefined;
  private readonly outputs = new Map<string, AgentOutput>();
  private sequence = 0;
  private stderr = '';
  private eventHandler: ((event: ExecutionEvent) => void) | undefined;
  private readonly selectors = new Set<CodexAppServer>();
  private selectorsClosing = false;
  private selectionRun: { threadId: string; resolve: (turn: z.infer<typeof turnSchema>) => void; reject: (error: Error) => void } | undefined;

  setEventHandler(handler: (event: ExecutionEvent) => void): void { this.eventHandler = handler; }

  constructor(private readonly options: CodexOptions) {
    if (!options.command[0] || !Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
      throw new Error('Codex command and positive requestTimeoutMs are required');
    }
  }

  private ready(): Promise<void> {
    if (this.closed) return Promise.reject(new UncertainOperationError('Codex connection closed'));
    if (this.failure) return Promise.reject(this.failure);
    this.initialized ??= this.connect();
    return this.initialized;
  }

  private async connect(): Promise<void> {
    const [command, ...args] = this.options.command;
    if (!command) throw new Error('Codex command is empty');
    const child = spawn(command, args, { stdio: 'pipe', detached: process.platform !== 'win32', env: this.options.env ?? process.env });
    this.process = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4096); });
    child.on('error', error => { if (this.process === child) this.fail(error); });
    child.stdin.on('error', error => { if (this.process === child) this.fail(error); });
    child.on('exit', (code, signal) => {
      if (this.process === child) this.fail(new UncertainOperationError(`Codex exited (${signal ?? code}): ${this.stderr}`));
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (this.process !== child || this.failure) return;
      try { this.receive(messageSchema.parse(JSON.parse(line))); }
      catch (error) { this.fail(new Error(`Invalid Codex protocol message: ${error instanceof Error ? error.message : String(error)}`)); }
    });
    try {
      await this.rpc('initialize', { clientInfo: { name: 'agent_loop', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      await this.write({ method: 'initialized' });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.historyObservations.clear();
    this.activeTurns.clear();
    this.startingTurns.clear();
    this.endedTurns.clear();
    this.failure ??= error;
    this.selectionRun?.reject(this.failure);
    for (const call of this.calls.values()) if (call.kind === 'pending') { clearTimeout(call.timer); call.reject(this.failure); }
    for (const entry of this.threads.values()) entry.load = { kind: 'unloaded' };
    this.calls.clear();
    for (const live of this.requests.values()) for (const settle of live.waiters) settle(false);
    this.requests.clear();
    this.seenRequestIds.clear();
    this.epoch = randomUUID();
    const child = this.process;
    if (child?.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    } else child?.kill('SIGKILL');
  }

  private async write(message: unknown): Promise<void> {
    if (this.failure) throw this.failure;
    const child = this.process;
    if (!child) throw new Error('Codex is not connected');
    await new Promise<void>((resolve, reject) => child.stdin.write(`${JSON.stringify(message)}\n`, error => {
      if (error) {
        const failure = new UncertainOperationError(`Codex transport write failed: ${error.message}`);
        this.fail(failure);
        reject(failure);
      }
      else resolve();
    }));
  }

  private rpc(method: string, params: unknown, settled?: (outcome: RpcOutcome) => void): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const call = this.calls.get(id);
        if (call?.kind !== 'pending') return;
        if (settled) this.calls.set(id, { kind: 'timed-out', method, settled });
        else this.calls.delete(id);
        const scope = threadScopeSchema.safeParse(params);
        reject(new RpcTimeoutError(`Codex ${method}${scope.success ? ` for ${scope.data.threadId}` : ''} timed out; reconcile before retrying`));
      }, this.options.requestTimeoutMs);
      this.calls.set(id, { kind: 'pending', method, resolve, reject, timer, settled });
      void this.write({ id, method, params }).catch(error => this.fail(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private receive(message: z.infer<typeof messageSchema>): void {
    if (message.method !== undefined) {
      const scope = threadScopeSchema.safeParse(message.params);
      if (scope.success) this.historyObservations.delete(scope.data.threadId);
      else if (message.id !== undefined || /^(thread|turn|item|serverRequest|error)(\/|$)/.test(message.method)) this.historyObservations.clear();
    }
    if (message.method !== undefined && message.id === undefined && this.eventHandler) {
      const event = executionEvent(message.method, message.params);
      if (event) this.eventHandler(event);
    }
    if (message.method !== undefined) {
      if (this.selectionRun && message.id !== undefined) throw new Error(`Temporary directory selection cannot handle native request ${message.method}`);
      if (message.id !== undefined) this.request(message.id, message.method, message.params);
      else if (message.method === 'serverRequest/resolved') {
        const resolved = z.object({ requestId: rpcIdSchema, threadId: z.string() }).parse(message.params);
        const key = this.requestId(resolved.requestId);
        const live = this.requests.get(key);
        if (live?.request.threadId === resolved.threadId) this.resolveRequest(key, true);
      } else if (message.method === 'turn/started') {
        const started = z.object({ threadId: z.string(), turn: z.object({ id: z.string() }) }).parse(message.params);
        if (this.threads.has(started.threadId)) this.activeTurns.set(started.threadId, started.turn.id);
      } else if (message.method === 'item/completed') {
        const completed = z.object({ threadId: z.string(), turnId: z.string(), item: itemSchema }).parse(message.params);
        this.captureOutput(completed.threadId, completed.turnId, completed.item, false);
      } else if (message.method === 'turn/completed') {
        const completed = z.object({ threadId: z.string(), turn: z.object({ id: z.string() }) }).parse(message.params);
        if (this.selectionRun?.threadId === completed.threadId) {
          const { turn } = z.object({ turn: turnSchema }).parse(message.params);
          for (const item of turn.items) this.captureOutput(completed.threadId, turn.id, item, turn.status === 'completed');
          this.selectionRun.resolve(turn);
        }
        this.endedTurns.set(completed.threadId, completed.turn.id);
        if (this.activeTurns.get(completed.threadId) === completed.turn.id) this.activeTurns.delete(completed.threadId);
        for (const [key, live] of this.requests) {
          if (live.request.threadId === completed.threadId && live.request.turnId === completed.turn.id) this.resolveRequest(key, false);
        }
      }
      return;
    }
    if (message.id === undefined) throw new Error('Response lacks request ID');
    const call = this.calls.get(message.id);
    if (!call) return;
    if (call.kind === 'pending') clearTimeout(call.timer);
    this.calls.delete(message.id);
    const outcome: RpcOutcome = message.error
      ? { kind: 'failure', error: new RpcError(message.error.code, `${call.method}: ${message.error.message}`) }
      : { kind: 'success', value: message.result };
    call.settled?.(outcome);
    if (call.kind === 'pending') {
      if (outcome.kind === 'failure') call.reject(outcome.error);
      else call.resolve(outcome.value);
    }
  }

  private requestId(id: RpcId): string { return `${this.epoch}:${Buffer.from(JSON.stringify(id)).toString('base64url')}`; }

  private request(rpcId: RpcId, method: string, payload: unknown): void {
    const id = this.requestId(rpcId);
    if (this.seenRequestIds.has(id)) return;
    this.seenRequestIds.add(id);
    if (method === 'item/tool/call') {
      const epoch = this.epoch;
      const { tool } = z.object({ tool: z.string() }).parse(payload);
      const operation = tool === 'project_action' ? this.projectCall(rpcId, payload, epoch) : this.workspaceCall(rpcId, payload, epoch);
      void operation.catch(error => {
        if (epoch === this.epoch) this.fail(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }
    const base = z.object({ threadId: z.string(), turnId: z.string().nullish() }).safeParse(payload);
    if (!base.success) throw new Error(`Unsupported unscoped server request ${method}`);
    let isBlocking = true;
    let response: LiveRequest['response'] = { kind: 'unsupported' };
    let prompt = `Unsupported Codex request ${method}. Pause this task and inspect the request.`;
    let kind: PendingRequest['kind'] = 'unsupported';
    if (method === 'item/tool/requestUserInput') {
      const params = questionsSchema.parse(payload);
      response = { kind: 'question', questions: params.questions };
      isBlocking = params.isBlocking;
      kind = 'question';
      prompt = params.questions.map(q => `${q.id}: ${q.question}${q.options?.length ? `\n${q.options.map(o => `${o.label}: ${o.description}`).join('\n')}` : ''}`).join('\n\n');
    } else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const params = approvalSchema.parse(payload);
      response = { kind: 'approval' };
      kind = 'approval';
      prompt = [method, params.kind, `Item ${params.itemId}`, params.command, params.cwd, params.grantRoot, params.reason, 'Use the approval action to approve or reject this request.'].filter(Boolean).join('\n');
    } else if (method === 'item/permissions/requestApproval') {
      const params = permissionRequestSchema.parse(payload);
      response = { kind: 'permissions', permissions: params.permissions };
      kind = 'permissions';
      prompt = `${params.reason ?? 'Additional permissions requested'}\n${JSON.stringify(params.permissions)}\nUse the approval action to approve or reject this request. Grants apply to this turn only.`;
    }
    const request: PendingRequest = { id: this.requestId(rpcId), isBlocking, connectionEpoch: this.epoch, threadId: base.data.threadId, turnId: base.data.turnId ?? '', kind, method, payload, prompt };
    this.requests.set(request.id, { rpcId, request, response, responseSent: false, waiters: new Set() });
  }

  private config() {
    return { model: this.options.model, approvalPolicy: this.options.approvalPolicy, sandbox: this.options.sandbox, approvalsReviewer: 'user' };
  }

  async selectWorkspace(input: WorkspaceSelectionRequest): Promise<WorkspaceSelectionResponse> {
    if (this.closed || this.selectorsClosing) throw new Error('Codex owner is closed for directory selection');
    input.signal?.throwIfAborted();
    const selector = new CodexAppServer({ ...this.options, approvalPolicy: 'never', sandbox: 'read-only' });
    this.selectors.add(selector);
    const abort = () => selector.fail(new Error('Temporary directory selection aborted'));
    input.signal?.addEventListener('abort', abort, { once: true });
    try { return await selector.runWorkspaceSelection(input); }
    finally {
      input.signal?.removeEventListener('abort', abort);
      await selector.dispose(new Error('Temporary directory selection closed'));
      this.selectors.delete(selector);
    }
  }

  private async runWorkspaceSelection(input: WorkspaceSelectionRequest): Promise<WorkspaceSelectionResponse> {
    await this.ready();
    const response = z.object({
      thread: threadSchema, cwd: z.string(), approvalPolicy: z.literal('never'),
      sandbox: z.object({ type: z.literal('readOnly'), networkAccess: z.literal(false).optional() }),
    }).parse(await this.rpc('thread/start', {
      ...this.config(), model: this.options.selectionModel ?? this.options.model,
      cwd: input.cwd, developerInstructions: workspaceSelectionInstructions,
      ephemeral: true, dynamicTools: [],
    }));
    if (response.cwd !== input.cwd || response.thread.status.type !== 'idle' || response.thread.turns.length) throw new Error('Temporary directory selection did not start in the requested empty read-only context');
    const threadId = response.thread.id;
    const completion = new Promise<z.infer<typeof turnSchema>>((resolve, reject) => { this.selectionRun = { threadId, resolve, reject }; });
    void completion.catch(() => undefined);
    const { turn: started } = z.object({ turn: turnSchema }).parse(await this.rpc('turn/start', {
      threadId, cwd: input.cwd, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
      input: wireInput(workspaceSelectionInput(input), `directory-selection:${input.taskId}`),
      outputSchema: z.toJSONSchema(workspaceSelectionOutputSchema),
    }));
    const completed = await completion;
    if (completed.id !== started.id) throw new Error('Temporary directory selection completed a different turn');
    if (completed.status !== 'completed') throw new Error(completed.error?.message ?? `Temporary directory selection ${completed.status}`);
    const answers = [...this.outputs.values()].filter(output => output.threadId === threadId && output.turnId === completed.id && output.phase === 'final');
    const answer = answers[0];
    if (!answer || answers.length !== 1) throw new Error('Temporary directory selection must return one complete structured choice');
    const { choice } = workspaceSelectionOutputSchema.parse(JSON.parse(answer.text));
    if (choice.kind === 'repository' && !input.candidates.some(candidate => !('kind' in candidate) && candidate.name === choice.repositoryName)) throw new Error('Temporary directory selection chose an unconfigured repository');
    if (choice.kind === 'project' && !input.candidates.some(candidate => 'kind' in candidate && candidate.id === choice.projectId)) throw new Error('Temporary directory selection chose an unknown project identity');
    return { temporaryThreadId: threadId, choice };
  }

  private async dispose(error: Error): Promise<void> {
    this.closed = true;
    this.fail(error);
    const child = this.process;
    if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()));
  }

  private runtimeContext(threadId: string, additionalContext?: string) {
    const instructions = this.threads.get(threadId)?.instructions;
    return {
      ...(instructions === undefined ? {} : { 'agent-loop-runtime': { kind: 'application', value: `Current Runtime instructions. These replace earlier Runtime instructions for this conversation.\n${instructions}` } }),
      ...(additionalContext === undefined ? {} : { 'agent-loop-project-records': { kind: 'application', value: additionalContext } }),
    };
  }

  async createThread(input: { cwd: string; instructions: string; model?: string; reasoningEffort?: ReasoningEffort }): Promise<string> {
    await this.ready();
    const { thread } = threadResponseSchema.parse(await this.rpc('thread/start', { ...this.config(), ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { config: { model_reasoning_effort: input.reasoningEffort } } : {}),
      cwd: input.cwd, developerInstructions: input.instructions, dynamicTools: this.projectHandler ? [workspaceTool, projectTool] : [workspaceTool], ephemeral: false }));
    if (thread.status.type !== 'idle' || thread.turns.length) throw new UncertainOperationError('New Codex thread was not empty and idle');
    this.threads.set(thread.id, { load: { kind: 'ready' }, untouched: true, instructions: input.instructions, model: input.model, reasoningEffort: input.reasoningEffort });
    return thread.id;
  }

  private async resume(threadId: string, instructions?: string, model?: string, reasoningEffort?: ReasoningEffort): Promise<void> {
    await this.ready();
    const entry = this.threads.get(threadId);
    if (entry?.load.kind === 'pending') await entry.load.request;
    if (entry?.load.kind === 'uncertain') throw entry.load.error;
    if (entry?.load.kind === 'ready' && (instructions === undefined || instructions === entry.instructions)
      && (model === undefined || model === entry.model) && (reasoningEffort === undefined || reasoningEffort === entry.reasoningEffort)) return;
    this.historyObservations.delete(threadId);
    this.activeTurns.delete(threadId);
    const current: ThreadEntry = { load: { kind: 'unloaded' }, untouched: false,
      instructions: instructions ?? entry?.instructions, model: model ?? entry?.model, reasoningEffort: reasoningEffort ?? entry?.reasoningEffort };
    this.threads.set(threadId, current);
    const epoch = this.epoch;
    const matches = () => epoch === this.epoch && this.threads.get(threadId) === current;
    const request = this.rpc('thread/resume', { ...this.config(), ...(current.model ? { model: current.model } : {}),
      ...(current.reasoningEffort ? { config: { model_reasoning_effort: current.reasoningEffort } } : {}), threadId, developerInstructions: current.instructions }, outcome => {
      if (!matches()) return;
      this.historyObservations.delete(threadId);
      if (outcome.kind === 'failure') { current.load = { kind: 'failed', error: outcome.error }; return; }
      try {
        const { thread } = threadResponseSchema.parse(outcome.value);
        if (thread.id !== threadId) throw new Error('Codex resumed a different thread');
        current.load = { kind: 'ready' };
      } catch (error) {
        current.load = { kind: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
      }
    }).then(() => {
      if (!matches()) throw new UncertainOperationError('Codex connection changed during thread resume');
      if (current.load.kind === 'failed') throw current.load.error;
    }).catch(error => {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (matches() && current.load.kind === 'pending') {
        current.load = { kind: failure instanceof RpcTimeoutError ? 'uncertain' : 'failed', error: failure };
      }
      throw failure;
    }).finally(() => { this.historyObservations.delete(threadId); });
    current.load = { kind: 'pending', request };
    await request;
  }

  isActiveTurn(identity: TurnIdentity): boolean {
    return !this.failure && !this.closed && identity.connectionEpoch === this.epoch
      && this.activeTurns.get(identity.threadId) === identity.turnId;
  }

  async activity(threadId: string, instructions?: string, model?: string, reasoningEffort?: ReasoningEffort): Promise<Activity> {
    await this.resume(threadId, instructions, model, reasoningEffort);
    const epoch = this.epoch;
    const starting = this.startingTurns.get(threadId);
    if (starting && !this.activeTurns.has(threadId)) await starting;
    const turnId = this.activeTurns.get(threadId);
    if (!turnId || epoch !== this.epoch) return { kind: 'reconcile' };
    const { thread } = threadResponseSchema.parse(await this.rpc('thread/read', { threadId, includeTurns: false }));
    if (thread.id !== threadId) throw new Error('Codex returned a different thread');
    if (epoch !== this.epoch || this.activeTurns.get(threadId) !== turnId) return { kind: 'reconcile' };
    if (thread.status.type !== 'active') {
      this.activeTurns.delete(threadId);
      return { kind: 'reconcile' };
    }
    return { kind: 'running', threadId, turnId, connectionEpoch: epoch,
      requests: [...this.requests.values()].map(live => live.request).filter(request => request.threadId === threadId
        && (request.turnId === turnId || (request.kind === 'unsupported' && !request.turnId))),
      outputs: [...this.outputs.values()].filter(output => output.threadId === threadId && output.turnId === turnId && output.phase === 'progress') };
  }

  async inspect(threadId: string, instructions?: string, model?: string, reasoningEffort?: ReasoningEffort): Promise<ExecutionSnapshot> {
    await this.resume(threadId, instructions, model, reasoningEffort);
    const deadline = Date.now() + this.options.requestTimeoutMs;
    do {
      try { return await this.inspectSnapshot(threadId, true); }
      catch (error) {
        this.historyObservations.delete(threadId);
        if (isTurnHistoryMaterializing(error) && (this.activeTurns.has(threadId) || this.awaitingHistory.has(threadId))) {
          error = new TurnHistoryPendingError(error.message);
        }
        if (!(error instanceof TurnHistoryPendingError) || Date.now() >= deadline) throw error;
        await delay(50);
      }
    } while (true);
  }

  private async inspectSnapshot(threadId: string, reconcile: boolean): Promise<ExecutionSnapshot> {
    const observation = this.historyObservations.get(threadId) ?? {};
    this.historyObservations.set(threadId, observation);
    const epoch = this.epoch;
    const current = () => this.epoch === epoch && this.historyObservations.get(threadId) === observation;
    const settled = () => current() && !this.activeTurns.has(threadId) && !this.awaitingHistory.has(threadId) && ![...this.requests.values()].some(live => live.request.threadId === threadId);
    await this.resume(threadId);
    let { thread } = threadResponseSchema.parse(await this.rpc('thread/read', { threadId, includeTurns: false }));
    if (thread.id !== threadId) throw new Error('Codex returned a different thread');
    if (this.threads.get(threadId)?.untouched && thread.status.type === 'idle') {
      return { threadId, turnId: null, status: 'idle', requests: [], outputs: [], seenInputIds: [], error: null };
    }
    let head: z.infer<typeof turnSchema> | undefined;
    let digest: string | undefined;
    if (current() && thread.historyMode === 'paginated' && thread.status.type === 'idle' && !this.summaryUnsupported) {
      try {
        const page = turnPageSchema.parse(await this.rpc('thread/turns/list', { threadId, cursor: null, limit: 1, sortDirection: 'desc', itemsView: 'summary' }));
        if (page.data.length === 1 && page.data[0]?.itemsView === 'summary' && page.data[0].status === 'completed') {
          head = page.data[0];
          digest = historyDigest(head);
          const completed = observation.completed;
          if (completed && completed.digest === digest && settled()) return {
            threadId, turnId: completed.turnId, status: completed.status, error: completed.error, seenInputIds: [...completed.seenInputIds],
            requests: [...this.requests.values()].map(live => live.request).filter(request => request.threadId === threadId),
            outputs: [...this.outputs.values()].filter(output => output.threadId === threadId),
          };
        }
      } catch (error) {
        if (isTurnHistoryMaterializing(error)) throw error;
        if (!(error instanceof RpcError) || ![-32601, -32602].includes(error.code)) throw error;
        if (this.epoch === epoch) this.summaryUnsupported = true;
      }
    }
    observation.completed = undefined;
    if (thread.historyMode === 'legacy') {
      ({ thread } = threadResponseSchema.parse(await this.rpc('thread/read', { threadId, includeTurns: true })));
    } else {
      const turns: z.infer<typeof turnSchema>[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = turnPageSchema.parse(await this.rpc('thread/turns/list', { threadId, cursor, sortDirection: 'asc', itemsView: 'full' }));
        turns.push(...page.data);
        cursor = page.nextCursor ?? null;
        if (cursor && cursors.has(cursor)) throw new Error('Codex history pagination repeated a cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      thread = { ...thread, turns };
    }
    if (epoch !== this.epoch) throw new UncertainOperationError('Codex connection changed during history inspection');
    if (thread.id !== threadId || thread.turns.some(turn => turn.itemsView !== 'full')) throw new Error('Codex history is incomplete');
    const seenInputIds = new Set<string>();
    for (const turn of thread.turns) for (const item of turn.items) {
      if (item.type !== 'userMessage') continue;
      const user = userMessageSchema.parse(item);
      if (user.clientId) seenInputIds.add(user.clientId);
      const content = user.content[0];
      if (content?.type === 'text' && content.text) {
        const marker = /^\[agent-loop-delivery:([^\]\r\n]+)\](?:\n\[agent-loop-batch:([^\]\r\n]+)\])?$/.exec(content.text);
        if (marker?.[1]) seenInputIds.add(decodeURIComponent(marker[1]));
        if (marker?.[2]) for (const id of inputIdsSchema.parse(JSON.parse(decodeURIComponent(marker[2])))) seenInputIds.add(id);
      }
    }
    const latest = thread.turns.at(-1);
    const expectedTurn = this.awaitingHistory.get(threadId);
    if (expectedTurn && !thread.turns.some(turn => turn.id === expectedTurn)) throw new TurnHistoryPendingError('Accepted Codex turn is not visible in history yet; reconcile before continuing');
    for (const turn of thread.turns) {
      if (turn.status === 'inProgress') continue;
      for (const item of turn.items) this.captureOutput(threadId, turn.id, item, turn.status === 'completed');
    }
    const mismatched = (thread.status.type === 'active') !== (latest?.status === 'inProgress');
    if (expectedTurn && mismatched) throw new TurnHistoryPendingError('Accepted Codex turn state is still materializing; reconcile before continuing');
    if (expectedTurn) this.awaitingHistory.delete(threadId);
    if (mismatched && reconcile) return this.inspectSnapshot(threadId, false);
    if (thread.status.type === 'active' && latest?.status !== 'inProgress') throw new TurnHistoryPendingError('Active Codex turn is missing from history; reconcile before continuing');
    if (latest?.status === 'inProgress' && thread.status.type !== 'active') return { threadId, turnId: latest.id, status: 'interrupted', requests: [], outputs: [...this.outputs.values()].filter(output => output.threadId === threadId), seenInputIds: [...seenInputIds], error: latest.error?.message ?? 'Persisted active turn has no live execution' };
    const status: ExecutionSnapshot['status'] = thread.status.type === 'systemError' ? 'failed' : latest?.status === 'inProgress' ? 'running' : latest?.status ?? 'idle';
    if (status === 'running' && latest) this.activeTurns.set(threadId, latest.id);
    else this.activeTurns.delete(threadId);
    const requests = [...this.requests.values()].map(live => live.request).filter(request => request.threadId === threadId && (request.turnId === latest?.id || (request.kind === 'unsupported' && !request.turnId)) && status === 'running');
    if (head && digest && latest?.status === 'completed' && thread.status.type === 'idle' && settled() &&
      historyDigest({ ...latest, itemsView: 'summary', items: head.items.map(item => latest.items.find(full => full.id === item.id)) }) === digest) {
      observation.completed = { turnId: latest.id, status: 'completed', error: latest.error?.message ?? null, seenInputIds: [...seenInputIds], digest };
    }
    return { threadId, turnId: latest?.id ?? null, status, requests, outputs: [...this.outputs.values()].filter(output => output.threadId === threadId), seenInputIds: [...seenInputIds], error: latest?.error?.message ?? (status === 'failed' ? 'Codex thread system error' : null) };
  }

  async startTurn(input: Parameters<CodexPort['startTurn']>[0]): Promise<string> {
    this.historyObservations.delete(input.threadId);
    await this.resume(input.threadId);
    const entry = this.threads.get(input.threadId);
    if (entry) entry.untouched = false;
    this.historyObservations.delete(input.threadId);
    const epoch = this.epoch;
    const starting = this.rpc('turn/start', {
      ...(entry?.reasoningEffort ? { effort: entry.reasoningEffort } : {}),
      threadId: input.threadId, input: wireInput(input.input, input.deliveryId, input.additionalDeliveryIds), clientUserMessageId: input.deliveryId,
      additionalContext: this.runtimeContext(input.threadId, input.additionalContext),
    }).then(value => {
      const { turn } = z.object({ turn: turnSchema }).parse(value);
      if (epoch !== this.epoch) throw new UncertainOperationError('Codex connection changed during turn start');
      this.awaitingHistory.set(input.threadId, turn.id);
      if (turn.status === 'inProgress' && this.endedTurns.get(input.threadId) !== turn.id) this.activeTurns.set(input.threadId, turn.id);
      return turn.id;
    });
    this.startingTurns.set(input.threadId, starting);
    try { return await starting; }
    finally {
      if (this.startingTurns.get(input.threadId) === starting) this.startingTurns.delete(input.threadId);
      this.historyObservations.delete(input.threadId);
    }
  }

  async steer(input: Parameters<CodexPort['steer']>[0]): Promise<void> {
    this.historyObservations.delete(input.threadId);
    await this.resume(input.threadId);
    try {
      this.historyObservations.delete(input.threadId);
      const response = z.object({ turnId: z.string() }).parse(await this.rpc('turn/steer', {
        threadId: input.threadId, expectedTurnId: input.turnId, input: wireInput(input.input, input.deliveryId), clientUserMessageId: input.deliveryId, additionalContext: this.runtimeContext(input.threadId, input.additionalContext),
      }));
      if (response.turnId !== input.turnId) throw new UncertainOperationError('Codex steered a different turn');
    } catch (error) {
      if (error instanceof RpcError && /no active turn|expected turn (?:id )?.*(?:does not match|mismatch)|turn.*(?:is not active|is no longer active)|active turn.*(?:does not match|mismatch)/i.test(error.message)) throw new TurnChangedError(error.message);
      throw error;
    } finally { this.historyObservations.delete(input.threadId); }
  }

  async reply(input: { request: PendingRequest; text: string }): Promise<void> {
    this.historyObservations.delete(input.request.threadId);
    await this.ready();
    const live = this.liveRequest(input.request);
    if (live.response.kind !== 'question') throw new RejectedInputError('Only native questions can receive ordinary replies');
    let result: unknown;
    try {
      const questions = live.response.questions;
      const first = questions[0];
      if (questions.length === 1 && first && !input.text.trim().startsWith('{')) result = { answers: { [first.id]: { answers: [input.text] } } };
      else {
        const answer = answersSchema.parse(JSON.parse(input.text));
        if (Object.keys(answer.answers).length !== questions.length || questions.some(question => !answer.answers[question.id])) throw new Error('Answer every question using its exact question ID');
        result = answer;
      }
    } catch (error) { throw new RejectedInputError(error instanceof Error ? error.message : String(error)); }
    if (!await this.respond(live, result)) throw new UncertainOperationError('Codex question response has no native resolution acknowledgement');
  }

  async respondApproval(input: Parameters<CodexPort['respondApproval']>[0]): Promise<'confirmed' | 'uncertain'> {
    this.historyObservations.delete(input.request.threadId);
    await this.ready();
    const live = this.liveRequest(input.request);
    let result: unknown;
    switch (live.response.kind) {
      case 'approval': result = { decision: input.decision === 'approve' ? 'accept' : 'decline' }; break;
      case 'permissions': result = { permissions: input.decision === 'approve' ? live.response.permissions : {}, scope: 'turn' }; break;
      default: throw new RejectedInputError('This native request is not an approval');
    }
    return await this.respond(live, result) ? 'confirmed' : 'uncertain';
  }

  private liveRequest(request: PendingRequest): LiveRequest {
    const live = this.requests.get(request.id);
    if (!live || request.connectionEpoch !== this.epoch || live.request.threadId !== request.threadId || live.request.turnId !== request.turnId || live.request.method !== request.method) throw new RejectedInputError('Codex request expired or belongs to a previous connection');
    if (live.responseSent) throw new RejectedInputError('Codex response already sent; reconcile its resolution before retrying');
    return live;
  }

  private async respond(live: LiveRequest, result: unknown): Promise<boolean> {
    this.historyObservations.delete(live.request.threadId);
    live.responseSent = true;
    const resolved = new Promise<boolean>(resolve => {
      const settle = (confirmed: boolean) => { clearTimeout(timer); live.waiters.delete(settle); resolve(confirmed); };
      const timer = setTimeout(() => settle(false), this.options.requestTimeoutMs);
      live.waiters.add(settle);
    });
    try {
      await this.write({ id: live.rpcId, result });
      return await resolved;
    } finally { this.historyObservations.delete(live.request.threadId); }
  }

  private resolveRequest(key: string, confirmed: boolean): void {
    const live = this.requests.get(key);
    if (!live) return;
    this.requests.delete(key);
    for (const settle of live.waiters) settle(confirmed);
  }

  private captureOutput(threadId: string, turnId: string, item: z.infer<typeof itemSchema>, completed: boolean): void {
    if (item.type !== 'agentMessage') return;
    const message = agentMessageSchema.parse(item);
    if (!message.text || (!message.phase && !completed)) return;
    const phase = message.phase === 'final_answer' || !message.phase ? 'final' : 'progress';
    const id = `${threadId}:${turnId}:${message.id}`;
    this.outputs.set(id, { id, threadId, turnId, phase, text: message.text });
  }

  setWorkspaceHandler(handler: Parameters<CodexPort['setWorkspaceHandler']>[0]): void { this.workspaceHandler = handler; }

  setProjectHandler(handler: Parameters<NonNullable<CodexPort['setProjectHandler']>>[0]): void { this.projectHandler = handler; }

  private async projectCall(rpcId: RpcId, payload: unknown, epoch: string): Promise<void> {
    const call = z.object({ threadId: z.string(), turnId: z.string(), callId: z.string(), tool: z.string(), namespace: z.string().nullish(), arguments: z.unknown() }).parse(payload);
    let result: { success: boolean; contentItems: { type: 'inputText'; text: string }[] };
    try {
      if (call.tool !== 'project_action' || call.namespace) throw new Error(`Unsupported dynamic tool ${call.tool}`);
      if (!this.threads.has(call.threadId)) throw new Error('Project request belongs to an unknown thread');
      if (!this.projectHandler) throw new Error('Project coordination is unavailable');
      const action = projectActionSchema.parse(call.arguments);
      const activity = await this.activity(call.threadId);
      if (epoch !== this.epoch || activity.kind !== 'running' || activity.turnId !== call.turnId || !this.isActiveTurn(activity)) throw new Error('Project request belongs to an inactive turn');
      const value = await this.projectHandler({ threadId: call.threadId, turnId: call.turnId, callId: call.callId, action, connectionEpoch: epoch });
      result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
    } catch (error) {
      result = { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : String(error) }] };
    }
    if (epoch !== this.epoch || this.failure || this.closed) return;
    await this.write({ id: rpcId, result });
  }

  private async workspaceCall(rpcId: RpcId, payload: unknown, epoch: string): Promise<void> {
    const call = z.object({ threadId: z.string(), turnId: z.string(), callId: z.string(), tool: z.string(), namespace: z.string().nullish(), arguments: z.unknown() }).parse(payload);
    let result: { success: boolean; contentItems: { type: 'inputText'; text: string }[] };
    try {
      if (call.tool !== 'ensure_workspace' || call.namespace) throw new Error(`Unsupported dynamic tool ${call.tool}`);
      if (!this.threads.has(call.threadId)) throw new Error('Workspace request belongs to an unknown thread');
      if (!this.workspaceHandler) throw new Error('Workspace provisioning is unavailable');
      const args = workspaceTargetSchema.parse(call.arguments);
      const activity = await this.activity(call.threadId);
      if (epoch !== this.epoch || activity.kind !== 'running' || activity.turnId !== call.turnId || !this.isActiveTurn(activity)) throw new Error('Workspace request belongs to an inactive turn');
      const request: WorkspaceRequest = { threadId: call.threadId, turnId: call.turnId, callId: call.callId, connectionEpoch: epoch, ...args };
      const resource = await this.workspaceHandler(request);
      result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(resource) }] };
    } catch (error) {
      result = { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : String(error) }] };
    }
    if (epoch !== this.epoch || this.failure || this.closed) return;
    await this.write({ id: rpcId, result });
  }

  recover(): Promise<void> {
    this.historyObservations.clear();
    if (this.closed) return Promise.reject(new UncertainOperationError('Codex connection closed'));
    if (this.recovery) return this.recovery;
    if (!this.failure) return this.ready();
    this.process = undefined;
    this.initialized = undefined;
    this.failure = undefined;
    this.stderr = '';
    this.activeTurns.clear();
    this.awaitingHistory.clear();
    this.summaryUnsupported = false;
    const operation = this.ready();
    this.recovery = operation.finally(() => { this.historyObservations.clear(); this.recovery = undefined; });
    return this.recovery;
  }

  async interrupt(input: { threadId: string; turnId: string }): Promise<void> {
    this.historyObservations.delete(input.threadId);
    await this.resume(input.threadId);
    this.historyObservations.delete(input.threadId);
    try { await this.rpc('turn/interrupt', input); }
    finally { this.historyObservations.delete(input.threadId); }
  }

  async close(): Promise<void> {
    this.selectorsClosing = true;
    await Promise.all([...this.selectors].map(selector => selector.dispose(new Error('Codex owner is closing'))));
    const child = this.process;
    try {
      if (!this.failure) for (const [threadId] of this.activeTurns) {
        let snapshot = await this.inspect(threadId);
        if (snapshot.status !== 'running' || !snapshot.turnId) continue;
        const turnId = snapshot.turnId;
        await this.interrupt({ threadId, turnId });
        const deadline = Date.now() + this.options.requestTimeoutMs;
        do {
          snapshot = await this.inspect(threadId);
          if (snapshot.status !== 'running') break;
          if (Date.now() >= deadline) throw new UncertainOperationError('Codex interruption was not confirmed before shutdown; manual recovery required');
          await delay(50);
        } while (true);
      }
    } finally {
      this.closed = true;
      this.fail(new UncertainOperationError('Codex connection closed'));
      if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()));
    }
  }
}
