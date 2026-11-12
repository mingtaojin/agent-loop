import { z } from 'zod';

export const criteriaSchema = z.object({
  states: z.array(z.enum(['open', 'closed'])).default(['open']),
  assigneesAny: z.array(z.string()).default([]),
  taskTypes: z.array(z.string().trim().min(1)).nullable().default(['bug']),
  labelsAll: z.array(z.string()).default([]),
  labelsAny: z.array(z.string()).default([]),
  labelsNone: z.array(z.string()).default([]),
  nativeTypes: z.record(z.string(), z.string().trim().min(1)).default({ Bug: 'bug', Feature: 'feature' }),
  typeLabels: z.record(z.string(), z.string().trim().min(1)).default({ bug: 'bug', enhancement: 'feature' }),
});
export type Criteria = z.infer<typeof criteriaSchema>;
const projectDirectoryPolicySchema = z.strictObject({
  kind: z.literal('project-directory'), path: z.string().min(1),
});
const workspacePolicySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('git-worktree') }), projectDirectoryPolicySchema,
]);
export const repositorySchema = z.object({
  name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  path: z.string().min(1),
  baseBranch: z.string().min(1),
  criteria: criteriaSchema.default(() => criteriaSchema.parse({})),
  workspace: workspacePolicySchema.optional(),
});
export type Repository = z.infer<typeof repositorySchema>;
export const collectionRepositorySchema = z.union([repositorySchema, z.strictObject({
  name: repositorySchema.shape.name, criteria: criteriaSchema,
})]);
export type CollectionRepository = z.infer<typeof collectionRepositorySchema>;
export const discoveredProjectSchema = z.strictObject({
  kind: z.literal('project'), id: z.string().min(1), name: z.string().min(1),
  entryPath: z.string().min(1), canonicalPath: z.string().min(1),
});
export type DiscoveredProject = z.infer<typeof discoveredProjectSchema>;
export type WorkspaceCandidate = Pick<Repository, 'name' | 'path' | 'workspace'> | DiscoveredProject;
export const sourceSchema = z.object({
  id: z.string(), repository: z.string(), number: z.number().int().positive(), url: z.string(),
  title: z.string(), body: z.string(), state: z.enum(['open', 'closed']),
  assignees: z.array(z.string()), labels: z.array(z.string()), nativeType: z.string().nullable(),
  updatedAt: z.string(), isPullRequest: z.boolean(),
});
export type Source = z.infer<typeof sourceSchema>;
export const sourceCommentSchema = z.object({
  id: z.string(), sourceId: z.string(), url: z.string(), author: z.string(), body: z.string(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type SourceComment = z.infer<typeof sourceCommentSchema>;
export function matchSource(source: Source, criteria: Criteria): { matches: boolean; reason: string } {
  if (source.isPullRequest) return { matches: false, reason: 'pull_request' };
  const labels = new Set(source.labels);
  let reason = 'issue';
  if (criteria.taskTypes !== null) {
    const labelTypes = new Set(source.labels.flatMap(label => criteria.typeLabels[label] ? [criteria.typeLabels[label]] : []));
    const native = source.nativeType === null ? undefined : criteria.nativeTypes[source.nativeType];
    if (source.nativeType !== null && !native) return { matches: false, reason: 'unmapped_native_type' };
    if (labelTypes.size > 1 || (native && [...labelTypes].some(type => type !== native))) return { matches: false, reason: 'conflicting_type' };
    const type = native ?? [...labelTypes][0];
    if (!type) return { matches: false, reason: 'unclassified' };
    if (!criteria.taskTypes.includes(type)) return { matches: false, reason: 'type_not_enabled' };
    reason = type;
  }
  if (!criteria.states.includes(source.state)) return { matches: false, reason: 'state' };
  if (criteria.assigneesAny.length && !criteria.assigneesAny.some(name => source.assignees.includes(name))) return { matches: false, reason: 'assignee' };
  if (!criteria.labelsAll.every(label => labels.has(label))) return { matches: false, reason: 'labels_all' };
  if (criteria.labelsAny.length && !criteria.labelsAny.some(label => labels.has(label))) return { matches: false, reason: 'labels_any' };
  if (criteria.labelsNone.some(label => labels.has(label))) return { matches: false, reason: 'labels_none' };
  return { matches: true, reason };
}

export const requestSchema = z.object({
  id: z.string(), threadId: z.string(), turnId: z.string(),
  kind: z.enum(['question', 'approval', 'permissions', 'unsupported']),
  prompt: z.string(), method: z.string(), payload: z.unknown(),
  isBlocking: z.boolean().default(true), connectionEpoch: z.string().default('legacy'),
});
export type PendingRequest = z.infer<typeof requestSchema>;
export const attachmentSchema = z.object({
  key: z.string(), name: z.string(), kind: z.enum(['image', 'file']),
});
export type Attachment = z.infer<typeof attachmentSchema>;
export const incomingSchema = z.object({
  id: z.string(), chatId: z.string(), senderId: z.string(), text: z.string(),
  attachments: z.array(attachmentSchema), createdAt: z.number(),
  chatType: z.enum(['p2p', 'group']).default('group'),
});
export type IncomingMessage = z.infer<typeof incomingSchema>;
export function normalizeManualTaskText(text: IncomingMessage['text']): string {
  return text.trim().replace(/^\/new(?:\s|$)/, '').trim();
}
export function manualTaskTitle(input: { text: IncomingMessage['text']; maxLength: number }): string {
  return normalizeManualTaskText(input.text).slice(0, input.maxLength) || '新讨论';
}
export type AgentInput =
  | { kind: 'text'; text: string }
  | { kind: 'image'; path: string }
  | { kind: 'skill'; name: string; path: string };
export const workspaceChoiceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project'), projectId: z.string().min(1), reason: z.string() }),
  z.strictObject({ kind: z.literal('repository'), repositoryName: z.string().min(1), reason: z.string() }),
  z.strictObject({ kind: z.literal('none'), reason: z.string() }),
  z.strictObject({ kind: z.literal('question'), question: z.string().min(1) }),
]);
export type WorkspaceChoice = z.infer<typeof workspaceChoiceSchema>;
export const workspaceSelectionResponseSchema = z.strictObject({
  temporaryThreadId: z.string().min(1), choice: workspaceChoiceSchema,
});
export type WorkspaceSelectionResponse = z.infer<typeof workspaceSelectionResponseSchema>;
export const submissionRequestIdSchema = z.uuid().regex(/^[0-9a-f-]+$/, 'Use a canonical lowercase UUID').brand<'SubmissionRequestId'>();
export const submissionSchema = z.strictObject({
  requestId: submissionRequestIdSchema,
  prompt: z.string().refine(text => text.trim().length > 0, 'Prompt must not be blank')
    .refine(text => !/[\uD800-\uDFFF]/u.test(text), 'Prompt contains an unpaired surrogate').brand<'SubmissionPrompt'>(),
});
export type Submission = z.infer<typeof submissionSchema>;
export interface WorkspaceSelectionRequest {
  taskId: string;
  cwd: string;
  candidates: WorkspaceCandidate[];
  input: AgentInput[];
  answers: { inputId: string; text: string }[];
  signal?: AbortSignal;
}
const workspaceSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending') }),
  z.object({ kind: z.literal('waiting'), question: z.string(), temporaryThreadId: z.string(), askedAt: z.number() }),
  z.object({ kind: z.literal('selected'), temporaryThreadId: z.string(), inputIds: z.array(z.string()).default([]), choice: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('project'), projectId: z.string(), reason: z.string(), project: discoveredProjectSchema }),
    z.object({ kind: z.literal('repository'), repositoryName: z.string(), reason: z.string(), repository: repositorySchema.optional() }),
    z.object({ kind: z.literal('none'), reason: z.string() }),
  ]) }),
]);
export const taskSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github'), issue: sourceSchema, repository: collectionRepositorySchema, collectionReason: z.string() }),
  z.object({ kind: z.literal('manual'), message: incomingSchema }),
  submissionSchema.extend({ kind: z.literal('cli'), submittedAt: z.number() }),
]);
export type TaskSource = z.infer<typeof taskSourceSchema>;
export function presentTaskSource(source: TaskSource, maxLength: number): { title: string; label: string; url: string | null } {
  switch (source.kind) {
    case 'github': return { title: source.issue.title, label: 'GitHub', url: source.issue.url };
    case 'manual': return { title: manualTaskTitle({ text: source.message.text, maxLength }), label: '飞书', url: null };
    case 'cli': return { title: source.prompt.trim().slice(0, maxLength), label: 'CLI', url: null };
    default: { const exhaustive: never = source; return exhaustive; }
  }
}
const resourceFields = { id: z.string(), workspace: z.string() };
export const taskResourceSchema = z.union([
  z.strictObject({ ...resourceFields, kind: z.literal('project'), project: discoveredProjectSchema }),
  z.object({ ...resourceFields, kind: z.literal('git-worktree').default('git-worktree'),
    repository: repositorySchema, branch: z.string() }),
  z.strictObject({ ...resourceFields, kind: z.literal('project-directory'),
    repository: repositorySchema.extend({ workspace: projectDirectoryPolicySchema }) }),
]);
export type TaskResource = z.infer<typeof taskResourceSchema>;
export const recoverySchema = z.object({
  attempts: z.number().int().nonnegative(), nextAttemptAt: z.number().nullable(),
  lastError: z.string().nullable(), interruptedTurnId: z.string().nullable(),
  lastUserInputSeq: z.number().int().nonnegative().nullable().default(null),
});
export const taskSchema = z.object({
  id: z.string(), sourceId: z.string(), source: taskSourceSchema,
  contextDirectory: z.string(), resources: z.array(taskResourceSchema),
  workspaceSelection: workspaceSelectionSchema.default({ kind: 'pending' }),
  status: z.enum(['pending', 'running', 'idle', 'paused', 'failed']),
  reason: z.string().nullable(), prompt: z.string(), promptHash: z.string(), skillPath: z.string().nullable(),
  chatId: z.string().nullable(), threadId: z.string().nullable(), turnId: z.string().nullable(),
  executionStatus: z.enum(['unbound', 'idle', 'running', 'completed', 'interrupted', 'failed', 'unknown']).default('unbound'),
  lastHandledTurnId: z.string().nullable(), requests: z.array(requestSchema),
  recovery: recoverySchema.default({ attempts: 0, nextAttemptAt: null, lastError: null, interruptedTurnId: null, lastUserInputSeq: null }),
  legacy: z.object({ status: z.string(), prUrl: z.string().nullable() }).optional(),
  createdAt: z.number(), updatedAt: z.number(),
});
export type Task = z.infer<typeof taskSchema>;
export const submissionReceiptSchema = taskSchema.pick({ status: true, reason: true, chatId: true, threadId: true })
  .extend({ requestId: submissionRequestIdSchema, taskId: z.string() }).strict();
export type SubmissionReceipt = z.infer<typeof submissionReceiptSchema>;
export function submissionSourceId(requestId: Submission['requestId']): string { return `cli:${requestId}`; }
export function submissionReceipt(task: Task): SubmissionReceipt {
  if (task.source.kind !== 'cli') throw new Error('Task is not a CLI submission');
  return { requestId: task.source.requestId, taskId: task.id, status: task.status, reason: task.reason, chatId: task.chatId, threadId: task.threadId };
}
export interface AgentOutput {
  id: string;
  threadId: string;
  turnId: string;
  phase: 'progress' | 'final';
  text: string;
}
export interface ExecutionSnapshot {
  threadId: string;
  turnId: string | null;
  status: 'idle' | 'running' | 'completed' | 'interrupted' | 'failed';
  requests: PendingRequest[];
  seenInputIds: string[];
  outputs: AgentOutput[];
  error: string | null;
}
export const inputProvenanceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('agent'), projectId: z.string(), taskId: z.string(), eventId: z.string(), category: z.string() }),
  z.object({ kind: z.literal('user'), message: incomingSchema }),
  z.object({ kind: z.literal('github_issue'), sourceId: z.string(), revision: z.string(), url: z.string() }),
  z.object({ kind: z.literal('github_comment'), sourceId: z.string(), commentId: z.string(), revision: z.string(), url: z.string(), author: z.string() }),
  z.object({ kind: z.literal('initial'), sourceId: z.string() }),
  z.strictObject({ kind: z.literal('cli'), requestId: submissionRequestIdSchema }),
  z.object({ kind: z.literal('recovery'), previousTurnId: z.string() }),
]);
export type InputProvenance = z.infer<typeof inputProvenanceSchema>;
export const workspaceTargetSchema = z.union([
  z.strictObject({ repository: z.string().min(1) }),
  z.strictObject({ projectId: z.string().min(1) }),
]);
export type WorkspaceTarget = z.infer<typeof workspaceTargetSchema>;
export type WorkspaceRequest = { threadId: string; turnId: string; callId: string } & WorkspaceTarget;
export const approvalActionSchema = z.object({
  id: z.string(), taskId: z.string(), threadId: z.string(), turnId: z.string(), requestId: z.string(),
  decision: z.enum(['approve', 'reject']), chatId: z.string(), senderId: z.string(), epoch: z.string(),
});
export type ApprovalAction = z.infer<typeof approvalActionSchema>;
export class UncertainOperationError extends Error {}
export class TurnChangedError extends Error {}
export class RejectedInputError extends Error {}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
