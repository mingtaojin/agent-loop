import type { AgentInput, ApprovalAction, Attachment, CollectionRepository, ExecutionSnapshot, IncomingMessage, PendingRequest, Repository, Source, SourceComment, TaskResource, WorkspaceRequest, WorkspaceSelectionRequest, WorkspaceSelectionResponse } from './domain.js';
import type { ExecutionEvent } from './execution-events.js';
import type { ProjectAction, ReasoningEffort } from './project.js';

export interface ProjectRequest {
  threadId: string;
  turnId: string;
  callId: string;
  action: ProjectAction;
}

export interface GitHubPort {
  list(repository: CollectionRepository): AsyncIterable<Source>;
  get(repository: string, number: number): Promise<Source>;
  comments(repository: string, number: number): AsyncIterable<SourceComment>;
  verifyPullRequest(input: { url: string; repository: string; branch: string; headSha: string }): Promise<boolean>;
}
export interface FeishuPort {
  progress?: FeishuProgressPort;
  documentProgress?: FeishuDocumentProgressPort;
  ensureGroup(input: { taskId: string; title: string; sourceUrl: string; generation?: number; reconcileOnly?: boolean }): Promise<string>;
  verifyGroup(chatId: string): Promise<void>;
  dissolveGroup(chatId: string): Promise<void>;
  send(input: { chatId: string; text: string; id: string }): Promise<void>;
  download(input: { messageId: string; attachment: Attachment; destination: string; maxBytes: number }): Promise<void>;
  history(input: { chatId: string; since: number }): Promise<IncomingMessage[]>;
  start(onMessage: (message: IncomingMessage) => Promise<void>, onError: (error: unknown) => void, onAction?: (action: ApprovalAction) => Promise<void>): Promise<void>;
  sendApproval(input: { chatId: string; id: string; taskId: string; request: PendingRequest }): Promise<void>;
  close(): Promise<void>;
}
export class FeishuApiError extends Error {
  constructor(readonly code: number, message: string) { super(`Feishu API error ${code}: ${message}`); }
}
export class TaskGroupUnavailable extends FeishuApiError {}
export class GroupCreationRejected extends FeishuApiError {}
export class TaskGroupBindingChanged extends Error {}
export type ProgressWriteGuard = () => void;
export class DocumentRequestRejected extends Error {}
export interface FeishuDocumentProgressPort {
  createDocument(input: { title: string }, guard?: ProgressWriteGuard): Promise<string>;
  createBlock(input: { documentId: string; parentBlockId?: string; index?: number; text: string; clientToken: string }, guard?: ProgressWriteGuard): Promise<string>;
  findBlock(input: { documentId: string; parentBlockId?: string; index?: number; text: string }): Promise<string | null>;
  removeBlocks(input: { documentId: string; parentBlockId: string; blockIds: string[]; clientToken: string }, guard?: ProgressWriteGuard): Promise<void>;
  readBlock(input: { documentId: string; blockId: string }): Promise<string>;
  replaceContent(input: { documentId: string; blockId: string; text: string; clientToken: string }, guard?: ProgressWriteGuard): Promise<void>;
  grantGroupRead(input: { documentId: string; chatId: string }, guard?: ProgressWriteGuard): Promise<void>;
  hasGroupRead(input: { documentId: string; chatId: string }): Promise<boolean>;
  findTab(input: { chatId: string; documentUrl: string }): Promise<string | null>;
  createTab(input: { chatId: string; documentUrl: string }, guard?: ProgressWriteGuard): Promise<string>;
}
export interface FeishuProgressPort {
  createProgressCard(input: { content: string; dashboardUrl?: string }, guard?: ProgressWriteGuard): Promise<string>;
  sendProgressCard(input: { chatId: string; cardId: string; uuid: string }, guard?: ProgressWriteGuard): Promise<string>;
  // Null means a complete scan found no match. Failed or incomplete reads reject.
  findProgressMessage(input: { chatId: string; cardId: string; since: number }): Promise<string | null>;
  updateProgressContent(input: { cardId: string; content: string; sequence: number; uuid: string }, guard?: ProgressWriteGuard): Promise<void>;
  setProgressStreaming(input: { cardId: string; enabled: boolean; sequence: number; uuid: string }, guard?: ProgressWriteGuard): Promise<void>;
}
export interface CodexPort {
  selectWorkspace(input: WorkspaceSelectionRequest): Promise<WorkspaceSelectionResponse>;
  setEventHandler?(handler: (event: ExecutionEvent) => void): void;
  createThread(input: { cwd: string; instructions: string; model?: string; reasoningEffort?: ReasoningEffort }): Promise<string>;
  inspect(threadId: string, instructions?: string, model?: string, reasoningEffort?: ReasoningEffort): Promise<ExecutionSnapshot>;
  startTurn(input: { threadId: string; input: AgentInput[]; deliveryId: string; additionalDeliveryIds?: string[] }): Promise<string>;
  steer(input: { threadId: string; turnId: string; input: AgentInput[]; deliveryId: string }): Promise<void>;
  reply(input: { request: PendingRequest; text: string }): Promise<void>;
  respondApproval(input: { request: PendingRequest; decision: 'approve' | 'reject' }): Promise<'confirmed' | 'uncertain'>;
  setWorkspaceHandler(handler: (request: WorkspaceRequest) => Promise<TaskResource>): void;
  setProjectHandler?(handler: (request: ProjectRequest) => Promise<unknown>): void;
  recover(): Promise<void>;
  interrupt(input: { threadId: string; turnId: string }): Promise<void>;
  close(): Promise<void>;
}
export interface WorkspacePort {
  release?(input: { taskId: string; resourceId: string; workspace: string; repository: Repository; branch: string }): Promise<void>;
  ensure(input: { taskId: string; resourceId: string; workspace?: string } & (
    { kind?: 'git-worktree'; repository: Repository; branch: string } |
    { kind: 'project-directory'; directory: string }
  )): Promise<string>;
  head(workspace: string): Promise<string>;
}
