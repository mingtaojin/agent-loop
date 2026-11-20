import { progressDiagnostic } from './feishu-progress-errors.js';
import { LiveExecution } from './live-execution.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { documentBaseUrlSchema, documentMaxLinesSchema } from './config.js';
import { type Task } from './domain.js';
import { coversSource, sourceFrontier, sourceFrontierSchema, HistoryRetries, finished, progressViewSchema, taskProgressStatus } from './feishu-progress-view.js';
import { documentConversationText, projectDocumentConversation } from './feishu-document-conversation.js';
import { documentChunks } from './feishu-document-text.js';
import { DocumentRequestRejected, TaskGroupBindingChanged, TaskGroupUnavailable, type FeishuDocumentProgressPort } from './ports.js';
import { assertGroupBinding, retireTaskGroup } from './task-groups.js';
import type { Store } from './store.js';

const id = z.string().min(1);
const writeSchema = z.strictObject({ clientToken: id, text: z.string(), sent: z.boolean() });
const partSchema = z.strictObject({ blockId: id, digest: z.string() });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const operationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('replace'), blockId: id, text: z.string(), clientToken: id, sent: z.boolean() }),
  z.strictObject({ kind: z.literal('append'), index: z.number().int().nonnegative(), text: z.string(), clientToken: id, sent: z.boolean() }),
  z.strictObject({ kind: z.literal('remove'), blockIds: z.array(id).min(1), clientToken: id, sent: z.boolean() }),
]);
const documentFields = { documentId: id, documentUrl: z.url() };
const blockFields = { ...documentFields, blockId: id };
const deliverySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('disabled'), documentId: id.nullable(), documentUrl: z.url().nullable(),
    reason: z.literal('Task group is unavailable or its binding changed'), apiCode: z.number().nullable() }),
  z.strictObject({ kind: z.literal('document'), title: id, pending: z.boolean() }),
  z.strictObject({ kind: z.literal('block'), ...documentFields, write: writeSchema }),
  z.strictObject({ kind: z.literal('access'), ...blockFields, pending: z.boolean() }),
  z.strictObject({ kind: z.literal('tab'), ...blockFields, pending: z.boolean() }),
  z.strictObject({ kind: z.literal('ready'), ...blockFields, tabId: id, contentHash: z.string(),
    parts: z.array(partSchema).default([]), operation: operationSchema.nullable().default(null) }),
]);
const runtimePublicationSchema = z.strictObject({
  version: z.literal(2), taskId: id, chatId: id, threadId: id, turnId: id,
  view: progressViewSchema, text: z.string().default(''), delivery: deliverySchema,
  lastAttemptAt: z.number(), nextAttemptAt: z.number(), failures: z.number().int().nonnegative(),
  sourceFrontier: sourceFrontierSchema.default({}),
  projectionRevision: z.string().nullable().default(null),
});
export const documentPublicationSchema = runtimePublicationSchema.omit({ view: true, text: true });
type DocumentPublication = z.infer<typeof runtimePublicationSchema>;
const discoverySchema = z.strictObject({ excludedTurns: z.array(z.string()) });
const discoveryKey = 'feishu-document-progress:discovery:v2';
const turnKey = (taskId: string, turnId: string) => JSON.stringify([taskId, turnId]);
const emptyView = () => progressViewSchema.parse({ status: 'running', cursor: 0, lastExecutionEventAt: null, assistant: [], tool: null });
const content = (record: DocumentPublication) => record.text;
export class FeishuDocumentProgressPublisher {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly publications = new Map<string, { payload: string; record: DocumentPublication }>();
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly baseUrl: string;
  private readonly maxLines: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private discoveryWork: Promise<boolean> | null = null;
  private readonly unsubscribe: () => void;
  private readonly observed = new Map<string, string>();
  private readonly historyRetries = new HistoryRetries();
  constructor(private readonly options: { store: Store; execution: LiveExecution; transport: FeishuDocumentProgressPort; documentBaseUrl: string; intervalMs?: number; maxLines?: number; now?: () => number }) {
    this.unsubscribe = options.execution.subscribe(({ event }) => { if (!event) { this.observed.clear(); this.publications.clear(); } });
    this.now = options.now ?? Date.now;
    this.intervalMs = Math.max(3000, options.intervalMs ?? 3000);
    this.baseUrl = documentBaseUrlSchema.parse(options.documentBaseUrl);
    this.maxLines = documentMaxLinesSchema.parse(options.maxLines);
  }
  start(): void {
    if (this.timer || this.stopped) return;
    void this.discoverSafely();
    this.timer = setInterval(() => { void this.poll().catch(error => this.report(error)); }, this.intervalMs);
    this.timer.unref();
  }
  async poll(): Promise<void> {
    if (this.stopped) return;
    const work: Promise<void>[] = [];
    for (const taskId of this.options.store.documentProgressTaskIds()) {
      const record = this.load(taskId);
      if (!record) continue;
      const task = this.options.store.task(taskId);
      if (task.chatId !== record.chatId || task.threadId === null) {
        if (record.delivery.kind === 'block' || (record.delivery.kind === 'ready' && record.delivery.operation)) this.disable(record);
        this.publications.delete(taskId); this.observed.delete(taskId); continue;
      }
      if (task.threadId !== record.threadId) {
        if (record.delivery.kind === 'ready' && record.delivery.operation) { record.delivery.operation = null; this.save(record); }
        else if (record.delivery.kind === 'block') this.disable(record);
        continue;
      }
      if (this.inFlight.has(taskId) || record.nextAttemptAt > this.now()) continue;
      if (this.inFlight.size >= 2) break;
      if ((record.delivery.kind === 'block' && record.delivery.write.sent) || (record.delivery.kind === 'ready' && record.delivery.operation?.sent)) work.push(this.dispatch(record));
    }
    await Promise.all(work);
    if (this.stopped) return;
    const discovered = await this.discoverSafely();
    if (!discovered || this.stopped) { await Promise.all(work); return; }
    const taskIds = new Set(this.options.store.documentProgressTaskIds());
    for (const taskId of this.publications.keys()) if (!taskIds.has(taskId)) this.publications.delete(taskId);
    const records = [...taskIds].flatMap(taskId => { const record = this.load(taskId); return record ? [record] : []; });
    for (const record of records.sort((a, b) => a.lastAttemptAt - b.lastAttemptAt)) {
      if (this.options.store.task(record.taskId).chatId !== record.chatId) {
        if (record.delivery.kind === 'block' || (record.delivery.kind === 'ready' && record.delivery.operation)) this.disable(record);
        this.publications.delete(record.taskId); continue;
      }
      if (record.delivery.kind === 'disabled') continue;
      const pending = record.delivery.kind === 'block' || (record.delivery.kind === 'ready' && record.delivery.operation !== null);
      if (!pending && (!this.publications.has(record.taskId) || !this.observed.has(record.taskId))) continue;
      if (this.inFlight.size >= 2) break;
      if (this.inFlight.has(record.taskId) || record.nextAttemptAt > this.now()) continue;
      const delivery = record.delivery;
      if (delivery.kind === 'document' && delivery.pending) continue;
      if (delivery.kind === 'ready' && !delivery.operation && delivery.contentHash === record.projectionRevision) continue;
      work.push(this.dispatch(record));
    }
    await Promise.all(work);
    let bytes = 0;
    for (const [taskId, cached] of this.publications) {
      const record = cached.record;
      bytes += Buffer.byteLength(record.text);
      if ((record.delivery.kind === 'ready' && !record.delivery.operation && record.delivery.contentHash === record.projectionRevision)
        || bytes > 2_000_000 || this.publications.size > 64) this.publications.delete(taskId);
    }
  }
  private dispatch(record: DocumentPublication): Promise<void> {
    const request = this.deliver(structuredClone(record)).catch(error => this.report(error, record.taskId, record.delivery.kind))
      .finally(() => this.inFlight.delete(record.taskId));
    this.inFlight.set(record.taskId, request);
    return request;
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    if (this.timer) clearInterval(this.timer);
    await this.discoveryWork;
    await Promise.allSettled(this.inFlight.values());
    this.publications.clear();
  }
  private report(error: unknown, taskId?: string, operation = 'discovery', retry: 'pending' | 'disabled' = 'pending'): void {
    this.options.store.diagnostic(taskId ?? 'feishu-document-progress', progressDiagnostic(error, `document.${operation}`, retry));
  }
  private load(taskId: string): DocumentPublication | null {
    const payload = this.options.store.documentProgressPayload(taskId);
    if (payload === null) { this.publications.delete(taskId); return null; }
    let cached = this.publications.get(taskId);
    if (cached?.payload !== payload) {
      cached = { payload, record: { ...documentPublicationSchema.parse(JSON.parse(payload)), view: emptyView(), text: cached?.record.text ?? '' } };
      if (cached.record.text) this.publications.set(taskId, cached);
    }
    return cached.record;
  }
  private save(record: DocumentPublication): void {
    const { view: _view, text: _text, ...receipt } = record;
    this.options.store.saveDocumentProgressRecord(record.taskId, receipt);
    this.publications.set(record.taskId, { payload: JSON.stringify(receipt), record });
  }
  private saveDelivery(record: DocumentPublication): void {
    const latest = this.load(record.taskId);
    if (!latest) throw new Error('Document publication disappeared');
    if (latest.chatId !== record.chatId || this.options.store.task(record.taskId).threadId !== record.threadId) throw new TaskGroupBindingChanged();
    assertGroupBinding(this.options.store, record.taskId, record.chatId);
    this.save({ ...latest, delivery: record.delivery, lastAttemptAt: record.lastAttemptAt,
      nextAttemptAt: record.nextAttemptAt, failures: record.failures });
  }
  private discoverSafely(): Promise<boolean> {
    return this.discoveryWork ??= this.discover().then(() => true, error => { this.report(error); return false; })
      .finally(() => { this.discoveryWork = null; });
  }
  private async discover(): Promise<void> {
    const store = this.options.store;
    const tasks = store.tasks();
    const raw = store.meta(discoveryKey);
    const discovery = raw === null ? { excludedTurns: tasks.flatMap(task =>
      task.turnId && finished(taskProgressStatus(task)) && !this.load(task.id) ? [turnKey(task.id, task.turnId)] : []) }
      : discoverySchema.parse(JSON.parse(raw));
    if (raw === null) store.setMeta(discoveryKey, JSON.stringify(discovery));
    let reads = 0;
    for (const task of tasks.sort((a, b) => (this.load(a.id)?.lastAttemptAt ?? 0) - (this.load(b.id)?.lastAttemptAt ?? 0))) {
      if (!task.chatId || !task.threadId || !task.turnId || discovery.excludedTurns.includes(turnKey(task.id, task.turnId))) continue;
      const inputSequence = store.inputSequence(task.id);
      const signature = JSON.stringify([task.threadId, task.turnId, task.chatId, taskProgressStatus(task), task.source.kind === 'manual' ? task.source.message : null, inputSequence, this.options.execution.revision(task.id, task.threadId)]);
      const existing = this.load(task.id);
      if (existing?.delivery.kind === 'disabled' && existing.chatId === task.chatId && existing.threadId === task.threadId) continue;
      const settled = existing?.delivery.kind === 'ready' && !existing.delivery.operation && existing.delivery.contentHash === existing.projectionRevision;
      if (this.observed.get(task.id) === signature && (this.publications.get(task.id)?.record.text || settled)) continue;
      if (!this.historyRetries.ready(task.id, signature, this.now())) continue;
      if (reads >= 2 || (this.inFlight.size >= 2 && !this.inFlight.has(task.id))) continue;
      reads++;
      const observation = await this.options.execution.read(task.id, task.threadId);
      if (this.stopped) return;
      const current = store.task(task.id);
      if (current.threadId !== task.threadId || current.turnId !== task.turnId || current.chatId !== task.chatId || taskProgressStatus(current) !== taskProgressStatus(task)
        || JSON.stringify(current.source) !== JSON.stringify(task.source) || store.inputSequence(task.id) !== inputSequence) continue;
      if (observation.history.kind === 'unavailable') {
        this.historyRetries.failed(task.id, signature, this.now()); this.observed.delete(task.id); this.publications.delete(task.id); continue;
      }
      let record = this.load(task.id);
      if (record && record.chatId !== task.chatId) {
        const { view: _view, text: _text, ...receipt } = record;
        const delivery = receipt.delivery;
        if (delivery.kind === 'ready') { delivery.operation = null; }
        if (delivery.kind !== 'block') store.setMeta(`retired-document-progress:${task.id}:${record.chatId}`, JSON.stringify(receipt));
        record = null;
      }
      if (record && record.threadId !== task.threadId && record.delivery.kind !== 'ready') record = null;
      if (record && record.chatId === task.chatId && record.threadId === task.threadId && !coversSource(observation.entries, record.sourceFrontier)) {
        this.historyRetries.failed(task.id, signature, this.now()); this.observed.delete(task.id); this.publications.delete(task.id); continue;
      }
      record = record ? structuredClone(record) : { version: 2, taskId: task.id, chatId: task.chatId, threadId: task.threadId, turnId: task.turnId,
        view: emptyView(), text: '', sourceFrontier: {}, projectionRevision: null, delivery: { kind: 'document', title: '执行进度', pending: false },
        lastAttemptAt: 0, nextAttemptAt: 0, failures: 0 };
      record.threadId = task.threadId; record.turnId = task.turnId; record.sourceFrontier = sourceFrontier(observation.entries);
      const conversation = projectDocumentConversation(task, store.inputs(task.id), observation.entries);
      record.view = { status: conversation.status, cursor: conversation.cursor, lastExecutionEventAt: conversation.lastExecutionEventAt, assistant: [], tool: null, notice: null };
      record.text = documentConversationText(conversation, this.maxLines);
      record.projectionRevision = hash(record.text);
      this.save(record);
      this.observed.set(task.id, signature); this.historyRetries.succeeded(task.id);
    }
  }
  private disable(record: DocumentPublication, apiCode: number | null = null): void {
    const latest = this.load(record.taskId);
    if (!latest || latest.chatId !== record.chatId || latest.threadId !== record.threadId) return;
    const delivery = latest.delivery;
    this.save({ ...latest, text: '', view: emptyView(), delivery: { kind: 'disabled',
      documentId: 'documentId' in delivery ? delivery.documentId : null,
      documentUrl: 'documentUrl' in delivery ? delivery.documentUrl : null,
      reason: 'Task group is unavailable or its binding changed', apiCode } });
    this.publications.delete(record.taskId); this.observed.delete(record.taskId);
  }
  private async deliver(record: DocumentPublication): Promise<void> {
    if (this.options.store.task(record.taskId).chatId !== record.chatId) return;
    const transport = this.options.transport;
    const guard = () => { assertGroupBinding(this.options.store, record.taskId, record.chatId); if (this.options.store.task(record.taskId).threadId !== record.threadId) throw new TaskGroupBindingChanged(); };
    let rollback: DocumentPublication['delivery'] | undefined;
    record.lastAttemptAt = this.now();
    record.nextAttemptAt = this.now() + this.intervalMs;
    this.saveDelivery(record);
    try {
      const delivery = record.delivery;
      switch (delivery.kind) {
        case 'disabled': return;
        case 'document': {
          if (delivery.pending) return;
          rollback = structuredClone(delivery);
          delivery.pending = true;
          this.saveDelivery(record);
          const documentId = await transport.createDocument({ title: delivery.title }, guard);
          record.delivery = { kind: 'block', documentId, documentUrl: `${this.baseUrl}/docx/${encodeURIComponent(documentId)}`,
            write: { clientToken: randomUUID(), text: documentChunks(content(record))[0] ?? '', sent: false } };
          break;
        }
        case 'block': {
          let blockId: string | null;
          if (delivery.write.sent) blockId = await transport.findBlock({ documentId: delivery.documentId, text: delivery.write.text });
          else {
            rollback = structuredClone(delivery);
            delivery.write.sent = true;
            this.saveDelivery(record);
            blockId = await transport.createBlock({ documentId: delivery.documentId, ...delivery.write }, guard);
          }
          if (!blockId) throw new Error('Managed block creation remains unknown');
          record.delivery = { kind: 'access', documentId: delivery.documentId, documentUrl: delivery.documentUrl, blockId, pending: false };
          break;
        }
        case 'access': {
          const input = { documentId: delivery.documentId, chatId: record.chatId };
          if (!await transport.hasGroupRead(input)) {
            if (this.options.store.task(record.taskId).chatId !== record.chatId) return;
            if (delivery.pending) throw new Error('Group permission remains unknown');
            rollback = structuredClone(delivery);
            delivery.pending = true;
            this.saveDelivery(record);
            await transport.grantGroupRead(input, guard);
          }
          record.delivery = { ...delivery, kind: 'tab', pending: false };
          break;
        }
        case 'tab': {
          const input = { chatId: record.chatId, documentUrl: delivery.documentUrl };
          let tabId = await transport.findTab(input);
          if (this.options.store.task(record.taskId).chatId !== record.chatId) return;
          if (!tabId && !delivery.pending) {
            rollback = structuredClone(delivery);
            delivery.pending = true;
            this.saveDelivery(record);
            tabId = await transport.createTab(input, guard);
          }
          if (!tabId) throw new Error('Document tab creation remains unknown');
          record.delivery = { kind: 'ready', documentId: delivery.documentId, documentUrl: delivery.documentUrl,
            blockId: delivery.blockId, tabId, contentHash: '', parts: [], operation: null };
          break;
        }
        case 'ready': {
          const chunks = this.observed.has(record.taskId) && record.text ? documentChunks(content(record)) : [];
          if (!delivery.parts.length) delivery.parts.push({ blockId: delivery.blockId, digest: delivery.contentHash });
          if (!delivery.operation) {
            const changed = delivery.parts.findIndex((part, index) => index < chunks.length && part.digest !== hash(chunks[index]!));
            const part = delivery.parts[changed], text = chunks[changed];
            if (part && text !== undefined) delivery.operation = { kind: 'replace', blockId: part.blockId, text, clientToken: randomUUID(), sent: false };
            else if (delivery.parts.length < chunks.length) {
              const next = chunks[delivery.parts.length];
              if (next === undefined) throw new Error('Missing document chunk');
              delivery.operation = { kind: 'append', index: delivery.parts.length - 1, text: next, clientToken: randomUUID(), sent: false };
            } else if (delivery.parts.length > chunks.length) {
              delivery.operation = { kind: 'remove', blockIds: delivery.parts.slice(chunks.length).map(part => part.blockId), clientToken: randomUUID(), sent: false };
            } else { delivery.contentHash = hash(content(record)); break; }
          }
          const operation = delivery.operation;
          rollback = structuredClone(delivery);
          switch (operation.kind) {
            case 'replace': {
              const input = { documentId: delivery.documentId, blockId: operation.blockId };
              if (!operation.sent || await transport.readBlock(input) !== operation.text) {
                operation.sent = true; this.saveDelivery(record);
                await transport.replaceContent({ ...input, text: operation.text, clientToken: operation.clientToken }, guard);
              }
              const part = delivery.parts.find(part => part.blockId === operation.blockId);
              if (!part) throw new Error('Document block ownership disappeared');
              part.digest = hash(operation.text);
              break;
            }
            case 'append': {
              const input = { documentId: delivery.documentId, parentBlockId: delivery.blockId, index: operation.index, text: operation.text };
              let blockId: string | null;
              if (operation.sent) blockId = await transport.findBlock(input);
              else {
                operation.sent = true; this.saveDelivery(record);
                blockId = await transport.createBlock({ ...input, clientToken: operation.clientToken }, guard);
              }
              if (!blockId) throw new Error('Overflow block creation remains unknown');
              delivery.parts.push({ blockId, digest: hash(operation.text) });
              break;
            }
            case 'remove': {
              operation.sent = true; this.saveDelivery(record);
              await transport.removeBlocks({ documentId: delivery.documentId, parentBlockId: delivery.blockId,
                blockIds: operation.blockIds, clientToken: operation.clientToken }, guard);
              delivery.parts = delivery.parts.filter(part => !operation.blockIds.includes(part.blockId));
              break;
            }
            default: { const exhaustive: never = operation; return exhaustive; }
          }
          delivery.operation = null;
          if (delivery.parts.length === chunks.length && delivery.parts.every((part, index) => part.digest === hash(chunks[index]!))) {
            delivery.contentHash = hash(content(record));
          }
          break;
        }
        default: { const exhaustive: never = delivery; return exhaustive; }
      }
      record.failures = 0;
      record.nextAttemptAt = this.now() + this.intervalMs;
      this.saveDelivery(record);
    } catch (error) {
      if (error instanceof TaskGroupBindingChanged) { this.disable(record); return; }
      if (error instanceof TaskGroupUnavailable) {
        retireTaskGroup(this.options.store, record.taskId, record.chatId);
        this.disable(record, error.code);
        this.report(error, record.taskId, record.delivery.kind, 'disabled'); return;
      }
      if (error instanceof DocumentRequestRejected && rollback) record.delivery = rollback;
      record.failures++;
      record.nextAttemptAt = this.now() + Math.max(this.intervalMs, Math.min(60_000, 3000 * 2 ** Math.min(record.failures - 1, 5)));
      this.saveDelivery(record);
      this.report(error, record.taskId, record.delivery.kind);
    }
  }
}
