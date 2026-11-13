import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { criteriaSchema, matchSource, sourceSchema, sourceCommentSchema, type Source, type SourceComment } from './domain.js';
import type { Store } from './store.js';

const idSchema = z.string().min(1).max(512)
  .refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value), 'Invalid identifier');
const textSchema = z.string().max(131_072).refine(value => value.trim().length > 0, 'Text must not be blank');
const versionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const reasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
const repositoryNameSchema = z.string().max(512).regex(/^[\w.-]+\/[\w.-]+$/);
const projectRepositorySchema = z.strictObject({
  name: repositoryNameSchema,
  labelsAny: z.array(idSchema).max(1_000).default([]),
  assigneesAny: z.array(idSchema).max(1_000).default([]),
  criteria: criteriaSchema.optional(),
}).refine(value => value.labelsAny.length + value.assigneesAny.length > 0 || value.criteria !== undefined, 'An intake selector is required');
export const projectConfigSchema = z.strictObject({
  id: idSchema, name: z.string().trim().min(1).max(512), directory: z.string().min(1).max(4_096)
    .refine(value => value.trim().length > 0 && !value.includes('\0'), 'Invalid project directory'),
  repositories: z.array(projectRepositorySchema).max(1_000),
  instructions: z.string().max(131_072).default(''),
  models: z.strictObject({ coordinator: idSchema.default('gpt-6-astra'), worker: idSchema.default('gpt-6.1-sol'), verifier: idSchema.optional() })
    .default({ coordinator: 'gpt-6-astra', worker: 'gpt-6.1-sol' }),
  reasoningEfforts: z.strictObject({ coordinator: reasoningEffortSchema.default('high'), worker: reasoningEffortSchema.default('xhigh'), verifier: reasoningEffortSchema.optional() })
    .default({ coordinator: 'high', worker: 'xhigh' }),
}).refine(value => new Set(value.repositories.map(repository => repository.name.toLowerCase())).size === value.repositories.length,
  'Duplicate project repository');
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export const projectConfigInputSchema = projectConfigSchema.safeExtend({
  supervisionIntervalMs: z.number().int().positive().max(2_147_483_647).optional(),
}).transform(({ supervisionIntervalMs: _retired, ...config }) => config);

export const recordScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project') }),
  z.strictObject({ kind: z.literal('task'), taskId: idSchema }),
  z.strictObject({ kind: z.literal('coordinator') }),
]);
export type RecordScope = z.infer<typeof recordScopeSchema>;
const recordRequestSchema = z.strictObject({ requestId: idSchema, key: idSchema, text: textSchema, expectedVersion: versionSchema,
  scope: recordScopeSchema.optional() });
export const projectActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('status'), section: z.enum(['overview', 'issues', 'comments', 'records', 'tasks', 'intakes', 'unassigned_intakes']).optional(),
    offset: versionSchema.optional(), limit: z.number().int().min(1).max(100).optional() }),
  z.strictObject({ action: z.literal('dispatch'), requestId: idSchema, prompt: textSchema,
    issueId: idSchema.optional(), intakeTaskId: idSchema.optional(), role: z.enum(['worker', 'verifier']).default('worker') }),
  z.strictObject({ action: z.literal('send'), requestId: idSchema, taskId: idSchema, text: textSchema }),
  z.strictObject({ action: z.literal('claim_intake'), requestId: idSchema, taskId: idSchema, messageId: idSchema }),
  z.strictObject({ action: z.literal('open_group'), requestId: idSchema, taskId: idSchema }),
  z.strictObject({ action: z.literal('plan_group_cleanup'), requestId: idSchema }),
  z.strictObject({ action: z.literal('confirm_group_cleanup'), requestId: idSchema, planId: idSchema, messageId: idSchema }),
  z.strictObject({ action: z.literal('apply_group_cleanup'), requestId: idSchema, planId: idSchema }),
  z.strictObject({ action: z.literal('report'), requestId: idSchema, kind: z.enum(['result', 'question', 'update']), text: textSchema }),
  recordRequestSchema.extend({ action: z.literal('record') }),
  z.strictObject({ action: z.literal('rotate'), requestId: idSchema, checkpoint: textSchema }),
  z.strictObject({ action: z.literal('release_workspace'), requestId: idSchema, resourceId: idSchema }),
  z.strictObject({ action: z.literal('control'), requestId: idSchema, taskId: idSchema, operation: z.enum(['pause', 'resume']) }),
]);
export type ProjectAction = z.infer<typeof projectActionSchema>;
const roleSchema = z.enum(['coordinator', 'worker', 'verifier']);
const memberSchema = z.strictObject({ taskId: idSchema, role: roleSchema, issueId: idSchema.optional() });
const recordSchema = z.strictObject({
  requestId: idSchema, key: idSchema, text: textSchema, version: versionSchema.refine(value => value > 0),
  authorTaskId: idSchema, createdAt: versionSchema, scope: recordScopeSchema.optional(),
});
const ledgerSourceSchema = sourceSchema.strict().extend({
  id: idSchema, repository: repositoryNameSchema, url: z.string().max(8_192),
  title: z.string().max(4_096), body: z.string().max(1_048_576),
  assignees: z.array(idSchema).max(1_000), labels: z.array(idSchema).max(1_000),
  nativeType: idSchema.nullable(), updatedAt: z.string().min(1).max(128),
});
const ledgerCommentSchema = sourceCommentSchema.strict().extend({
  id: idSchema, sourceId: idSchema, url: z.string().max(8_192), author: idSchema,
  body: z.string().max(1_048_576), createdAt: z.string().min(1).max(128), updatedAt: z.string().min(1).max(128),
});
export const projectStateSchema = z.strictObject({
  id: projectConfigSchema.shape.id, name: projectConfigSchema.shape.name, directory: projectConfigSchema.shape.directory,
  coordinatorTaskId: idSchema, members: z.array(memberSchema), issues: z.array(ledgerSourceSchema),
  comments: z.array(ledgerCommentSchema), records: z.array(recordSchema), version: versionSchema,
}).superRefine((state, context) => {
  const invalid = (message: string) => context.addIssue({ code: 'custom', message });
  const coordinators = state.members.filter(member => member.role === 'coordinator');
  if (coordinators.length !== 1 || coordinators[0]?.taskId !== state.coordinatorTaskId || coordinators[0]?.issueId !== undefined)
    invalid('The project must have exactly its designated coordinator');
  if (new Set(state.members.map(member => member.taskId)).size !== state.members.length) invalid('Duplicate project member');
  if (new Set(state.issues.map(issue => issue.id)).size !== state.issues.length) invalid('Duplicate project issue');
  if (new Set(state.comments.map(comment => comment.id)).size !== state.comments.length) invalid('Duplicate project comment');
  if (new Set(state.issues.map(issue => JSON.stringify([issue.repository.toLowerCase(), issue.number]))).size !== state.issues.length)
    invalid('Duplicate repository issue identity');
  const issueIds = new Set(state.issues.map(issue => issue.id));
  const memberIds = new Set(state.members.map(member => member.taskId));
  if (state.members.some(member => member.issueId !== undefined && !issueIds.has(member.issueId))) invalid('Unknown member issue');
  if (state.comments.some(comment => !issueIds.has(comment.sourceId))) invalid('Unknown comment issue');
  if (state.records.some(record => !memberIds.has(record.authorTaskId))) invalid('Unknown record author');
  if (state.records.some(record => record.scope?.kind === 'task' && !memberIds.has(record.scope.taskId))) invalid('Unknown record target');
  if (state.version !== state.records.length || state.records.some((record, index) => record.version !== index + 1))
    invalid('Record versions must form a continuous history');
  if (new Set(state.records.map(record => JSON.stringify([record.authorTaskId, record.requestId]))).size !== state.records.length)
    invalid('Duplicate record request');
});
export type ProjectState = z.infer<typeof projectStateSchema>;
export function projectView(state: ProjectState, callerTaskId: string): ProjectState {
  const caller = state.members.find(member => member.taskId === callerTaskId);
  if (!caller) throw new Error('Task does not belong to this project');
  if (caller.role === 'coordinator') return state;
  const issues = state.issues.filter(issue => issue.id === caller.issueId);
  return { ...state, members: [caller], issues,
    comments: state.comments.filter(comment => comment.sourceId === caller.issueId),
    records: state.records.filter(record => record.scope?.kind === 'project'
      || (record.scope?.kind === 'task' && record.scope.taskId === callerTaskId)) };
}

export function currentRecords(records: ProjectState['records']): ProjectState['records'] {
  const latest = new Map<string, ProjectState['records'][number]>();
  for (const record of records) {
    const identity = JSON.stringify([record.scope?.kind ?? 'legacy', record.scope?.kind === 'task' ? record.scope.taskId : null, record.key]);
    latest.delete(identity);
    latest.set(identity, record);
  }
  return [...latest.values()];
}

const membershipSchema = z.strictObject({ projectId: idSchema, role: roleSchema });
const issueRevisionSchema = z.strictObject({ eventId: idSchema, source: ledgerSourceSchema });
const commentRevisionSchema = z.strictObject({ eventId: idSchema, comment: ledgerCommentSchema });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const issueFingerprint = (source: Source) => digest({ ...source,
  assignees: [...new Set(source.assignees)].sort(), labels: [...new Set(source.labels)].sort(), updatedAt: undefined });
const commentFingerprint = (comment: SourceComment) => digest({ ...comment, updatedAt: undefined });
const documentSchema = z.strictObject({
  state: projectStateSchema, issueRevisions: z.array(issueRevisionSchema), commentRevisions: z.array(commentRevisionSchema),
}).superRefine((document, context) => {
  const invalid = (message: string) => context.addIssue({ code: 'custom', message });
  const issueHeads = new Map<string, Source>();
  const commentHeads = new Map<string, SourceComment>();
  const eventIds = new Set<string>();
  for (const revision of document.issueRevisions) {
    const issue = document.state.issues.find(source => source.id === revision.source.id);
    const previous = issueHeads.get(revision.source.id);
    if (!issue || issue.repository !== revision.source.repository || issue.number !== revision.source.number)
      invalid('Invalid project issue revision identity');
    if (previous && issueFingerprint(previous) === issueFingerprint(revision.source)) invalid('Duplicate project issue revision');
    if (eventIds.has(revision.eventId)) invalid('Duplicate project revision event');
    issueHeads.set(revision.source.id, revision.source); eventIds.add(revision.eventId);
  }
  for (const revision of document.commentRevisions) {
    const comment = document.state.comments.find(candidate => candidate.id === revision.comment.id);
    const previous = commentHeads.get(revision.comment.id);
    if (!comment || comment.sourceId !== revision.comment.sourceId || comment.author !== revision.comment.author
      || comment.createdAt !== revision.comment.createdAt) invalid('Invalid project comment revision identity');
    if (previous && commentFingerprint(previous) === commentFingerprint(revision.comment)) invalid('Duplicate project comment revision');
    if (eventIds.has(revision.eventId)) invalid('Duplicate project revision event');
    commentHeads.set(revision.comment.id, revision.comment); eventIds.add(revision.eventId);
  }
  for (const issue of document.state.issues) {
    const latest = issueHeads.get(issue.id);
    if (!latest || issueFingerprint(issue) !== issueFingerprint(latest)) invalid('Project issue snapshot diverges from its history');
  }
  for (const comment of document.state.comments) {
    const latest = commentHeads.get(comment.id);
    if (!latest || commentFingerprint(comment) !== commentFingerprint(latest)) invalid('Project comment snapshot diverges from its history');
  }
});
type ProjectDocument = z.infer<typeof documentSchema>;
const receiptSchema = z.strictObject({ fingerprint: idSchema, value: z.json() });
const recordInputSchema = recordRequestSchema.extend({ authorTaskId: idSchema });
const metadataKey = (...parts: string[]) => `project:${JSON.stringify(parts)}`;
const older = (incoming: string, current: string) => Date.parse(incoming) < Date.parse(current);

export function matchesProjectIssue(source: Source, project: ProjectConfig): boolean {
  if (source.state !== 'open' || source.isPullRequest) return false;
  const repository = project.repositories.find(candidate => candidate.name.toLowerCase() === source.repository.toLowerCase());
  if (repository?.criteria && !matchSource(source, repository.criteria).matches) return false;
  return repository !== undefined && ((repository.labelsAny.length + repository.assigneesAny.length === 0 && repository.criteria !== undefined)
    || repository.labelsAny.some(label => source.labels.includes(label))
    || repository.assigneesAny.some(assignee => source.assignees.some(name => name.toLowerCase() === assignee.toLowerCase())));
}

export class ProjectLedger {
  constructor(private readonly store: Store) {}

  project(projectId: string): ProjectState | null { return this.document(projectId)?.state ?? null; }

  save(state: ProjectState): void {
    const next = projectStateSchema.parse(state);
    const previous = this.document(next.id);
    if (previous) {
      if (previous.state.directory !== next.directory || previous.state.coordinatorTaskId !== next.coordinatorTaskId)
        throw new Error('Project identity cannot change');
      if (!isDeepStrictEqual(next.records.slice(0, previous.state.records.length), previous.state.records))
        throw new Error('Project record history is immutable');
      for (const member of previous.state.members) {
        if (!isDeepStrictEqual(next.members.find(candidate => candidate.taskId === member.taskId), member))
          throw new Error('Project membership is immutable');
      }
      for (const source of previous.state.issues) {
        const current = next.issues.find(candidate => candidate.id === source.id);
        if (!current || current.repository !== source.repository || current.number !== source.number)
          throw new Error('Project issue identity cannot change');
      }
      for (const comment of previous.state.comments) {
        const current = next.comments.find(candidate => candidate.id === comment.id);
        if (!current || current.sourceId !== comment.sourceId || current.author !== comment.author || current.createdAt !== comment.createdAt)
          throw new Error('Project comment identity cannot change');
      }
    }
    for (const member of next.members) {
      const ownership = this.membership(member.taskId);
      if (ownership && (ownership.projectId !== next.id || ownership.role !== member.role))
        throw new Error('Task already belongs to a project or role');
    }
    const document: ProjectDocument = { state: next,
      issueRevisions: previous?.issueRevisions ?? [], commentRevisions: previous?.commentRevisions ?? [] };
    for (const source of next.issues) {
      const revisions = document.issueRevisions.filter(revision => revision.source.id === source.id);
      if (issueFingerprint(revisions.at(-1)?.source ?? source) !== issueFingerprint(source) || revisions.length === 0) {
        document.issueRevisions.push({ eventId: `project-issue:${digest([next.id, source.id, revisions.length + 1, issueFingerprint(source)])}`, source });
      }
    }
    for (const comment of next.comments) {
      const revisions = document.commentRevisions.filter(revision => revision.comment.id === comment.id);
      if (commentFingerprint(revisions.at(-1)?.comment ?? comment) !== commentFingerprint(comment) || revisions.length === 0) {
        document.commentRevisions.push({ eventId: `project-comment:${digest([next.id, comment.id, revisions.length + 1, commentFingerprint(comment)])}`, comment });
      }
    }
    this.store.setMeta(metadataKey('state', next.id), JSON.stringify(document));
    for (const member of next.members) {
      if (!previous?.state.members.some(candidate => candidate.taskId === member.taskId))
        this.store.setMeta(metadataKey('member', member.taskId), JSON.stringify({ projectId: next.id, role: member.role }));
    }
  }

  membership(taskId: string): z.infer<typeof membershipSchema> | null {
    const payload = this.store.meta(metadataKey('member', idSchema.parse(taskId)));
    if (payload === null) return null;
    const membership = membershipSchema.parse(JSON.parse(payload));
    const member = this.project(membership.projectId)?.members.find(candidate => candidate.taskId === taskId);
    if (!member || member.role !== membership.role) throw new Error('Inconsistent project membership');
    return membership;
  }

  create(projectConfig: ProjectConfig, coordinatorTaskId: string): ProjectState {
    const config = projectConfigSchema.parse(projectConfig);
    const coordinator = idSchema.parse(coordinatorTaskId);
    const existing = this.project(config.id);
    if (existing) {
      if (existing.directory !== config.directory || existing.coordinatorTaskId !== coordinator)
        throw new Error('Project identity conflicts with existing coordinator');
      return existing;
    }
    const state: ProjectState = { id: config.id, name: config.name, directory: config.directory, coordinatorTaskId: coordinator,
      members: [{ taskId: coordinator, role: 'coordinator' }], issues: [], comments: [], records: [], version: 0 };
    this.save(state);
    return state;
  }

  addMember(projectId: string, taskId: string, role: z.infer<typeof roleSchema>, issueId?: string): void {
    const state = this.required(projectId);
    const member = memberSchema.parse({ taskId, role, ...(issueId === undefined ? {} : { issueId }) });
    const existing = state.members.find(candidate => candidate.taskId === member.taskId);
    if (existing) {
      if (!isDeepStrictEqual(existing, member)) throw new Error('Project membership conflicts with existing member');
      return;
    }
    state.members.push(member);
    this.save(state);
  }

  issue(projectId: string, source: Source): { changed: boolean; eventId: string } {
    const incoming = ledgerSourceSchema.parse(source);
    const document = this.requiredDocument(projectId);
    const current = document.state.issues.find(candidate => candidate.id === incoming.id);
    if (current && (current.repository !== incoming.repository || current.number !== incoming.number))
      throw new Error('Project issue identity cannot change');
    const revisions = document.issueRevisions.filter(revision => revision.source.id === incoming.id);
    const observed = revisions.find(revision => revision.source.updatedAt === incoming.updatedAt
      && issueFingerprint(revision.source) === issueFingerprint(incoming));
    if (current && older(incoming.updatedAt, current.updatedAt))
      return { changed: false, eventId: observed?.eventId ?? this.lastIssueEvent(document, incoming.id) };
    const changed = !current || issueFingerprint(current) !== issueFingerprint(incoming);
    document.state.issues = current ? document.state.issues.map(candidate => candidate.id === incoming.id ? incoming : candidate)
      : [...document.state.issues, incoming];
    this.save(document.state);
    return { changed, eventId: this.lastIssueEvent(this.requiredDocument(projectId), incoming.id) };
  }

  comment(projectId: string, comment: SourceComment): { changed: boolean; eventId: string } {
    const incoming = ledgerCommentSchema.parse(comment);
    const document = this.requiredDocument(projectId);
    const current = document.state.comments.find(candidate => candidate.id === incoming.id);
    if (current && (current.sourceId !== incoming.sourceId || current.author !== incoming.author || current.createdAt !== incoming.createdAt))
      throw new Error('Project comment identity cannot change');
    const revisions = document.commentRevisions.filter(revision => revision.comment.id === incoming.id);
    const observed = revisions.find(revision => revision.comment.updatedAt === incoming.updatedAt
      && commentFingerprint(revision.comment) === commentFingerprint(incoming));
    if (current && older(incoming.updatedAt, current.updatedAt))
      return { changed: false, eventId: observed?.eventId ?? this.lastCommentEvent(document, incoming.id) };
    const changed = !current || commentFingerprint(current) !== commentFingerprint(incoming);
    document.state.comments = [...document.state.comments.filter(candidate => candidate.id !== incoming.id), incoming];
    this.save(document.state);
    return { changed, eventId: this.lastCommentEvent(this.requiredDocument(projectId), incoming.id) };
  }

  receipt(projectId: string, callerTaskId: string, requestId: string): { fingerprint: string; value: unknown } | null {
    this.requireMember(projectId, callerTaskId);
    const payload = this.store.meta(metadataKey('receipt', projectId, callerTaskId, idSchema.parse(requestId)));
    return payload === null ? null : receiptSchema.parse(JSON.parse(payload));
  }

  saveReceipt(projectId: string, callerTaskId: string, requestId: string, fingerprint: string, value: unknown): void {
    const next = receiptSchema.parse({ fingerprint, value });
    const existing = this.receipt(projectId, callerTaskId, requestId);
    if (existing) {
      if (!isDeepStrictEqual(existing, next)) throw new Error('Project request conflicts with an existing receipt');
      return;
    }
    this.store.setMeta(metadataKey('receipt', projectId, callerTaskId, requestId), JSON.stringify(next));
  }

  record(projectId: string, input: z.infer<typeof recordInputSchema>): ProjectState {
    const request = recordInputSchema.parse(input);
    this.requireMember(projectId, request.authorTaskId);
    const member = this.membership(request.authorTaskId);
    const scope = request.scope ?? (member?.role === 'coordinator' ? { kind: 'coordinator' } : { kind: 'task', taskId: request.authorTaskId });
    if (scope.kind === 'task') this.requireMember(projectId, scope.taskId);
    if (member?.role !== 'coordinator' && (scope.kind !== 'task' || scope.taskId !== request.authorTaskId))
      throw new Error('Only the coordinator can publish project records or route records to another task');
    const state = this.required(projectId);
    const existing = state.records.find(record => record.requestId === request.requestId && record.authorTaskId === request.authorTaskId);
    if (existing) {
      if (existing.key !== request.key || existing.text !== request.text || existing.version !== request.expectedVersion + 1
        || (existing.scope !== undefined ? !isDeepStrictEqual(existing.scope, scope) : request.scope !== undefined))
        throw new Error('Project record request conflicts with existing history');
      return state;
    }
    if (request.expectedVersion !== state.version) throw new Error(`Project record version conflict: expected ${request.expectedVersion}, current ${state.version}`);
    const record = recordSchema.parse({ requestId: request.requestId, key: request.key, text: request.text,
      version: state.version + 1, authorTaskId: request.authorTaskId, createdAt: Date.now(), scope });
    state.records.push(record);
    state.version = record.version;
    this.save(state);
    return state;
  }

  private requireMember(projectId: string, taskId: string): void {
    idSchema.parse(projectId);
    if (this.membership(taskId)?.projectId !== projectId) throw new Error('Task does not belong to this project');
  }

  private document(projectId: string): ProjectDocument | null {
    const payload = this.store.meta(metadataKey('state', idSchema.parse(projectId)));
    if (payload === null) return null;
    const document = documentSchema.parse(JSON.parse(payload));
    if (document.state.id !== projectId) throw new Error('Persisted project identity does not match its key');
    return document;
  }

  private requiredDocument(projectId: string): ProjectDocument {
    const document = this.document(projectId);
    if (!document) throw new Error(`Unknown project ${projectId}`);
    return document;
  }

  private required(projectId: string): ProjectState { return this.requiredDocument(projectId).state; }

  private lastIssueEvent(document: ProjectDocument, sourceId: string): string {
    const revision = document.issueRevisions.findLast(candidate => candidate.source.id === sourceId);
    if (!revision) throw new Error('Missing project issue revision');
    return revision.eventId;
  }

  private lastCommentEvent(document: ProjectDocument, commentId: string): string {
    const revision = document.commentRevisions.findLast(candidate => candidate.comment.id === commentId);
    if (!revision) throw new Error('Missing project comment revision');
    return revision.eventId;
  }
}
