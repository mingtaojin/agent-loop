import { createHash } from 'node:crypto';
import { z } from 'zod';
import { epochMillisecondsSchema, submissionRequestIdSchema } from './domain.js';
import type { Store } from './store.js';

const id = z.string().min(1).max(512);
const text = z.string().trim().min(1).max(131_072);
export const businessTaskIdSchema = id.brand<'BusinessTaskId'>();
export const businessSourceSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('issue'), issueId: id }),
  z.strictObject({ kind: z.literal('input'), inputId: id }),
  z.strictObject({ kind: z.literal('task-source'), taskId: id }),
  z.strictObject({ kind: z.literal('project-record'), version: z.number().int().positive(), key: id.optional() }),
]);
export type BusinessSourceSelector = z.infer<typeof businessSourceSelectorSchema>;
export const businessSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('issue'), issueId: id, repository: id, number: z.number().int().positive(), url: z.string(), title: text }),
  z.strictObject({ kind: z.literal('manual'), messageId: id, chatId: id, senderId: id, text, createdAt: epochMillisecondsSchema }),
  z.strictObject({ kind: z.literal('cli'), requestId: submissionRequestIdSchema, prompt: text, submittedAt: epochMillisecondsSchema }),
  z.strictObject({ kind: z.literal('received-goal'), coordinatorTaskId: id, inputId: id, fromTaskId: id, text, createdAt: epochMillisecondsSchema }),
  z.strictObject({ kind: z.literal('coordinator-goal'), coordinatorTaskId: id, version: z.number().int().positive(), key: id, text, createdAt: epochMillisecondsSchema }),
]);
export type BusinessSource = z.infer<typeof businessSourceSchema>;
export const businessLifecycleChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('active'), summary: text }),
  z.strictObject({ kind: z.literal('historical'), outcome: z.enum(['delivered', 'terminated']), summary: text }),
]);
const lifecycleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('active'), summary: text, at: epochMillisecondsSchema, authorTaskId: id }),
  z.strictObject({ kind: z.literal('historical'), outcome: z.enum(['delivered', 'terminated']), summary: text, at: epochMillisecondsSchema, authorTaskId: id }),
]);
const changeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('created'), version: z.literal(1), at: epochMillisecondsSchema, authorTaskId: id }),
  z.strictObject({ kind: z.literal('assigned'), version: z.number().int().positive(), taskId: id, at: epochMillisecondsSchema, authorTaskId: id }),
  z.strictObject({ kind: z.literal('lifecycle'), version: z.number().int().positive(), lifecycle: lifecycleSchema, at: epochMillisecondsSchema, authorTaskId: id }),
]);
export const businessTaskSchema = z.strictObject({
  id: businessTaskIdSchema, projectId: id, coordinatorTaskId: id, title: text, source: businessSourceSchema,
  workerTaskIds: z.array(id), lifecycle: lifecycleSchema, version: z.number().int().positive(),
  createdAt: epochMillisecondsSchema, updatedAt: epochMillisecondsSchema, history: z.array(changeSchema),
});
export type BusinessTask = z.infer<typeof businessTaskSchema>;
function sourceIdentity(source: BusinessSource): string[] {
  switch (source.kind) {
    case 'issue': return [source.kind, source.issueId];
    case 'manual': return [source.kind, source.chatId, source.messageId];
    case 'cli': return [source.kind, source.requestId];
    case 'received-goal': return [source.kind, source.coordinatorTaskId, source.inputId];
    case 'coordinator-goal': return [source.kind, source.coordinatorTaskId, String(source.version)];
  }
}
export function sameBusinessSource(a: BusinessSource, b: BusinessSource): boolean {
  return JSON.stringify(sourceIdentity(a)) === JSON.stringify(sourceIdentity(b));
}
const documentSchema = z.array(businessTaskSchema).superRefine((tasks, context) => {
  const ids = new Set<string>(), workers = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) context.addIssue({ code: 'custom', message: 'Duplicate business task' });
    ids.add(task.id);
    if (task.history.length !== task.version || task.history.some((event, index) => event.version !== index + 1))
      context.addIssue({ code: 'custom', message: 'Business task versions must be continuous' });
    for (const worker of task.workerTaskIds) {
      if (workers.has(worker)) context.addIssue({ code: 'custom', message: 'Worker belongs to multiple business tasks' });
      workers.add(worker);
    }
  }
});
export class BusinessTaskLedger {
  constructor(private readonly store: Store) {}
  private key(projectId: string): string { return `business-tasks:${JSON.stringify(projectId)}`; }
  list(projectId: string): BusinessTask[] {
    const value = this.store.meta(this.key(projectId));
    return value === null ? [] : documentSchema.parse(JSON.parse(value));
  }
  get(projectId: string, businessTaskId: BusinessTask['id']): BusinessTask {
    const task = this.list(projectId).find(item => item.id === businessTaskId);
    if (!task) throw new Error('Business task is not owned by this project');
    return task;
  }
  private save(projectId: string, tasks: BusinessTask[]): void {
    this.store.setMeta(this.key(projectId), JSON.stringify(documentSchema.parse(tasks)));
  }
  create(projectId: string, coordinatorTaskId: string, source: BusinessSource): BusinessTask {
    const tasks = this.list(projectId);
    const existing = tasks.find(task => sameBusinessSource(task.source, source));
    if (existing) return existing;
    const at = Date.now();
    const title = (source.kind === 'issue' ? source.title : source.kind === 'cli' ? source.prompt : source.text).slice(0, 200);
    const task = businessTaskSchema.parse({ id: `business:${createHash('sha256').update(JSON.stringify([projectId, ...sourceIdentity(source)])).digest('hex')}`,
      projectId, coordinatorTaskId, title, source, workerTaskIds: [], lifecycle: { kind: 'active', summary: 'Registered by coordinator', authorTaskId: coordinatorTaskId, at },
      version: 1, createdAt: at, updatedAt: at, history: [{ kind: 'created', version: 1, at, authorTaskId: coordinatorTaskId }] });
    tasks.push(task); this.save(projectId, tasks); return task;
  }
  assign(projectId: string, businessTaskId: BusinessTask['id'], taskId: string, authorTaskId: string): BusinessTask {
    const tasks = this.list(projectId), task = tasks.find(item => item.id === businessTaskId);
    if (!task) throw new Error('Business task is not owned by this project');
    const previous = tasks.find(item => item.workerTaskIds.includes(taskId));
    if (previous) {
      if (previous.id !== task.id) throw new Error('Worker is already assigned to another business task');
      return previous;
    }
    if (task.lifecycle.kind !== 'active') throw new Error('Business task is historical; explicitly reopen it first');
    const at = Date.now(); task.workerTaskIds.push(taskId); task.version++; task.updatedAt = at;
    task.history.push({ kind: 'assigned', version: task.version, taskId, at, authorTaskId });
    this.save(projectId, tasks); return task;
  }
  setLifecycle(projectId: string, businessTaskId: BusinessTask['id'], expectedVersion: number,
    change: z.infer<typeof businessLifecycleChangeSchema>, authorTaskId: string): BusinessTask {
    const tasks = this.list(projectId), task = tasks.find(item => item.id === businessTaskId);
    if (!task) throw new Error('Business task is not owned by this project');
    if (task.version !== expectedVersion) throw new Error('Business task version conflict');
    const at = Date.now(); task.lifecycle = { ...change, at, authorTaskId }; task.version++; task.updatedAt = at;
    task.history.push({ kind: 'lifecycle', version: task.version, lifecycle: task.lifecycle, at, authorTaskId });
    this.save(projectId, tasks); return task;
  }
}
