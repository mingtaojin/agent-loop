import { writeFile } from 'node:fs/promises';
import { TurnChangedError, UncertainOperationError, type ExecutionSnapshot, type IncomingMessage, type Source, type SourceComment, type TaskResource, type WorkspaceRequest, type WorkspaceChoice } from '../src/domain.js';
export interface LegacyReport { status: 'waiting_user' | 'awaiting_review' | 'failed'; summary: string; question: string | null; prUrl: string | null; validation: string[]; limitations: string[] }
import { TaskGroupUnavailable, type CodexPort, type FeishuPort, type GitHubPort } from '../src/ports.js';

export function issue(number: number, changes: Partial<Source> = {}): Source {
  return {
    id: `issue-${number}`, repository: 'example/project', number,
    url: `https://github.com/example/project/issues/${number}`, title: `Bug ${number}`, body: `Reproduction ${number}`,
    state: 'open', assignees: ['developer'], labels: ['bug'], nativeType: 'Bug',
    updatedAt: '2026-11-04T00:00:00Z', isPullRequest: false, ...changes,
  };
}

export class GitHubFake implements GitHubPort {
  sources: Source[] = [];
  sourceComments: SourceComment[] = [];
  async *comments(repository: string, number: number): AsyncIterable<SourceComment> {
    const source = this.sources.find(item => item.repository === repository && item.number === number);
    for (const comment of this.sourceComments.filter(item => item.sourceId === source?.id)) yield structuredClone(comment);
  }
  listFailureAfter: number | null = null;
  getError: Error | null = null;
  validPullRequest = true;
  readonly verifications: Parameters<GitHubPort['verifyPullRequest']>[0][] = [];
  async *list(repository: Parameters<GitHubPort['list']>[0]): AsyncIterable<Source> {
    let emitted = 0;
    for (const source of this.sources.filter(source => source.repository === repository.name)) {
      if (emitted === this.listFailureAfter) throw new Error('GitHub collection interrupted');
      emitted++;
      yield structuredClone(source);
    }
  }
  async get(repository: string, number: number): Promise<Source> {
    if (this.getError) throw this.getError;
    const source = this.sources.find(source => source.repository === repository && source.number === number);
    if (!source) throw new Error('Issue unavailable');
    return structuredClone(source);
  }
  async verifyPullRequest(input: Parameters<GitHubPort['verifyPullRequest']>[0]): Promise<boolean> {
    this.verifications.push(input);
    return this.validPullRequest;
  }
}

export class FeishuFake implements FeishuPort {
  readonly groups = new Map<string, string>();
  readonly sent: Parameters<FeishuPort['send']>[0][] = [];
  readonly approvals: Parameters<FeishuPort['sendApproval']>[0][] = [];
  async sendApproval(input: Parameters<FeishuPort['sendApproval']>[0]): Promise<void> { this.approvals.push(structuredClone(input)); }
  readonly downloads: Parameters<FeishuPort['download']>[0][] = [];
  readonly resources = new Map<string, Uint8Array>();
  readonly downloadFailures = new Set<string>();
  offline: IncomingMessage[] = [];
  historyError: Error | null = null;
  loseGroupAck = false;
  loseSendAck = false;
  receiver: ((message: IncomingMessage) => Promise<void>) | null = null;
  async ensureGroup(input: Parameters<FeishuPort['ensureGroup']>[0]): Promise<string> {
    const key = input.generation ? `${input.taskId}:${input.generation}` : input.taskId;
    const group = this.groups.get(key) ?? `chat-${input.taskId}-${input.generation ?? 0}`;
    this.groups.set(key, group);
    if (this.loseGroupAck) { this.loseGroupAck = false; throw new UncertainOperationError('Group created; acknowledgement lost'); }
    return group;
  }
  async verifyGroup(chatId: string): Promise<void> {
    if (![...this.groups.values()].includes(chatId)) throw new TaskGroupUnavailable(232009, 'Task group unavailable');
  }
  async dissolveGroup(chatId: string): Promise<void> {
    for (const [key, group] of this.groups) if (group === chatId) this.groups.delete(key);
  }
  async send(input: Parameters<FeishuPort['send']>[0]): Promise<void> {
    this.sent.push(input);
    if (this.loseSendAck) { this.loseSendAck = false; throw new UncertainOperationError('Message sent; acknowledgement lost'); }
  }
  async download(input: Parameters<FeishuPort['download']>[0]): Promise<void> {
    this.downloads.push(input);
    if (this.downloadFailures.has(input.attachment.key)) throw new Error('Resource download interrupted');
    const bytes = this.resources.get(input.attachment.key);
    if (!bytes) throw new Error('Resource missing');
    await writeFile(input.destination, bytes);
  }
  async history(input: Parameters<FeishuPort['history']>[0]): Promise<IncomingMessage[]> {
    if (this.historyError) throw this.historyError;
    return this.offline.filter(message => message.chatId === input.chatId && message.createdAt >= input.since);
  }
  async start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> { this.receiver = onMessage; }
  async close(): Promise<void> { this.receiver = null; }
}

export class CodexFake implements CodexPort {
  readonly selections: Omit<Parameters<CodexPort['selectWorkspace']>[0], 'signal'>[] = [];
  selectionResults: WorkspaceChoice[] = [];
  selectionError: Error | null = null;
  async selectWorkspace(input: Parameters<CodexPort['selectWorkspace']>[0]): ReturnType<CodexPort['selectWorkspace']> {
    const { signal, ...data } = input;
    signal?.throwIfAborted();
    this.selections.push(structuredClone(data));
    if (this.selectionError) throw this.selectionError;
    return { temporaryThreadId: `selection-${this.selections.length}`, choice: this.selectionResults.shift() ?? { kind: 'none', reason: 'Synthetic discussion selection' } };
  }
  readonly threads = new Map<string, ExecutionSnapshot>();
  readonly created: Parameters<CodexPort['createThread']>[0][] = [];
  readonly starts: Parameters<CodexPort['startTurn']>[0][] = [];
  readonly steers: Parameters<CodexPort['steer']>[0][] = [];
  readonly replies: Parameters<CodexPort['reply']>[0][] = [];
  readonly interrupts: Parameters<CodexPort['interrupt']>[0][] = [];
  readonly approvals: Parameters<CodexPort['respondApproval']>[0][] = [];
  workspaceHandler: ((request: WorkspaceRequest) => Promise<TaskResource>) | null = null;
  setWorkspaceHandler(handler: (request: WorkspaceRequest) => Promise<TaskResource>): void { this.workspaceHandler = handler; }
  recoveries = 0;
  recoveryError: Error | null = null;
  inspectError: Error | null = null;
  async recover(): Promise<void> { this.recoveries++; if (this.recoveryError) throw this.recoveryError; }
  async respondApproval(input: Parameters<CodexPort['respondApproval']>[0]): Promise<'confirmed' | 'uncertain'> {
    this.approvals.push(structuredClone(input));
    const snapshot = this.snapshot(input.request.threadId);
    snapshot.requests = snapshot.requests.filter(request => request.id !== input.request.id);
    return 'confirmed';
  }
  loseCreateAck = false;
  loseInputAck = false;
  raceOnSteer = false;
  private nextTurn = 0;
  snapshot(threadId: string): ExecutionSnapshot {
    const snapshot = this.threads.get(threadId);
    if (!snapshot) throw new Error('Thread unavailable');
    return snapshot;
  }
  complete(threadId: string, report: LegacyReport | string | null): void {
    const snapshot = this.snapshot(threadId);
    const text = typeof report === 'string' ? report : report ? [report.summary, report.question, report.prUrl, ...report.validation, ...report.limitations].filter(Boolean).join('\n') : '';
    if (text && snapshot.turnId) snapshot.outputs.push({ id: `${threadId}:${snapshot.turnId}:final`, threadId, turnId: snapshot.turnId, phase: 'final', text });
    Object.assign(snapshot, { status: 'completed', requests: [], error: null });
  }
  async createThread(input: Parameters<CodexPort['createThread']>[0]): Promise<string> {
    this.created.push(input);
    const id = `thread-${this.created.length}`;
    this.threads.set(id, { threadId: id, turnId: null, status: 'idle', requests: [], outputs: [], seenInputIds: [], error: null });
    if (this.loseCreateAck) { this.loseCreateAck = false; throw new UncertainOperationError('Thread created; acknowledgement lost'); }
    return id;
  }
  async inspect(threadId: string): Promise<ExecutionSnapshot> { if (this.inspectError) throw this.inspectError; return structuredClone(this.snapshot(threadId)); }
  async startTurn(input: Parameters<CodexPort['startTurn']>[0]): Promise<string> {
    this.starts.push(structuredClone(input));
    const snapshot = this.snapshot(input.threadId);
    const turn = `turn-${++this.nextTurn}`;
    Object.assign(snapshot, { turnId: turn, status: 'running', error: null, requests: [] });
    snapshot.seenInputIds.push(input.deliveryId, ...input.additionalDeliveryIds ?? []);
    this.acknowledge();
    return turn;
  }
  async steer(input: Parameters<CodexPort['steer']>[0]): Promise<void> {
    const snapshot = this.snapshot(input.threadId);
    if (this.raceOnSteer) {
      this.raceOnSteer = false;
      this.complete(input.threadId, { status: 'waiting_user', summary: 'Needs a detail', question: 'Which device?', prUrl: null, validation: [], limitations: [] });
      throw new TurnChangedError('Expected turn ended');
    }
    if (snapshot.turnId !== input.turnId || snapshot.status !== 'running') throw new TurnChangedError('Turn no longer active');
    this.steers.push(structuredClone(input));
    snapshot.seenInputIds.push(input.deliveryId);
    this.acknowledge();
  }
  private acknowledge(): void {
    if (this.loseInputAck) { this.loseInputAck = false; throw new UncertainOperationError('Input accepted; acknowledgement lost'); }
  }
  async reply(input: Parameters<CodexPort['reply']>[0]): Promise<void> {
    const snapshot = this.snapshot(input.request.threadId);
    if (!snapshot.requests.some(request => request.id === input.request.id)) throw new Error('Request expired');
    this.replies.push(structuredClone(input));
    snapshot.requests = snapshot.requests.filter(request => request.id !== input.request.id);
  }
  async interrupt(input: Parameters<CodexPort['interrupt']>[0]): Promise<void> {
    this.interrupts.push(input);
    Object.assign(this.snapshot(input.threadId), { status: 'interrupted', requests: [] });
  }
  async close(): Promise<void> {}
}
