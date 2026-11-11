import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { documentBaseUrlSchema, documentMaxLinesSchema } from './config.js';
import { errorMessage } from './domain.js';
import { finished, progressViewSchema, taskProgressStatus } from './feishu-progress-view.js';
import { documentConversationText, projectDocumentConversation } from './feishu-document-conversation.js';
import { documentChunks } from './feishu-document-text.js';
import { DocumentRequestRejected, type FeishuDocumentProgressPort } from './ports.js';
import type { Store } from './store.js';

const id = z.string().min(1);
const writeSchema = z.strictObject({ clientToken: id, text: z.string(), sent: z.boolean(), chunks: z.array(z.string()).min(1).optional() });
const partSchema = z.strictObject({ blockId: id, text: z.string() });
const operationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('replace'), ...partSchema.shape, clientToken: id, sent: z.boolean() }),
  z.strictObject({ kind: z.literal('append'), index: z.number().int().nonnegative(), text: z.string(), clientToken: id, sent: z.boolean() }),
  z.strictObject({ kind: z.literal('remove'), blockIds: z.array(id).min(1), clientToken: id, sent: z.boolean() }),
]);
const documentFields = { documentId: id, documentUrl: z.url() };
const blockFields = { ...documentFields, blockId: id };
const deliverySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('document'), title: id, pending: z.boolean() }),
  z.strictObject({ kind: z.literal('block'), ...documentFields, write: writeSchema }),
  z.strictObject({ kind: z.literal('access'), ...blockFields, pending: z.boolean() }),
  z.strictObject({ kind: z.literal('tab'), ...blockFields, pending: z.boolean() }),
  z.strictObject({ kind: z.literal('ready'), ...blockFields, tabId: id, content: z.string(), write: writeSchema.nullable(),
    parts: z.array(partSchema).default([]), operation: operationSchema.nullable().default(null) }),
]);
export const documentPublicationSchema = z.strictObject({
  version: z.literal(1), taskId: id, chatId: id, turnId: id,
  view: progressViewSchema, text: z.string().default(''), delivery: deliverySchema,
  lastAttemptAt: z.number(), nextAttemptAt: z.number(), failures: z.number().int().nonnegative(),
});
export type DocumentPublication = z.infer<typeof documentPublicationSchema>;
const discoverySchema = z.strictObject({ cursor: z.number().int().nonnegative(), excludedTurns: z.array(z.string()) });
const discoveryKey = 'feishu-document-progress:discovery:v1';
const turnKey = (taskId: string, turnId: string) => JSON.stringify([taskId, turnId]);
const emptyView = () => progressViewSchema.parse({ status: 'running', cursor: 0, lastExecutionEventAt: null, assistant: [], tool: null });
const content = (record: DocumentPublication) => record.text;

export class FeishuDocumentProgressPublisher {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly baseUrl: string;
  private readonly maxLines: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  constructor(private readonly options: { store: Store; transport: FeishuDocumentProgressPort; documentBaseUrl: string; intervalMs?: number; maxLines?: number; now?: () => number }) {
    this.now = options.now ?? Date.now;
    this.intervalMs = Math.max(3000, options.intervalMs ?? 3000);
    this.baseUrl = documentBaseUrlSchema.parse(options.documentBaseUrl);
    this.maxLines = documentMaxLinesSchema.parse(options.maxLines);
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.discoverSafely();
    this.timer = setInterval(() => { void this.poll().catch(error => this.report(error)); }, this.intervalMs);
    this.timer.unref();
  }
  async poll(): Promise<void> {
    if (this.stopped || !this.discoverSafely()) return;
    const work: Promise<void>[] = [];
    const records = this.options.store.documentProgressRecords().map(raw => documentPublicationSchema.parse(raw));
    for (const record of records.sort((a, b) => a.lastAttemptAt - b.lastAttemptAt)) {
      if (this.inFlight.size >= 2) break;
      if (this.inFlight.has(record.taskId) || record.nextAttemptAt > this.now()) continue;
      const delivery = record.delivery;
      if (delivery.kind === 'document' && delivery.pending) continue;
      if (delivery.kind === 'ready' && !delivery.write && delivery.content === content(record)) continue;
      const request = this.deliver(record).catch(error => this.report(error)).finally(() => this.inFlight.delete(record.taskId));
      this.inFlight.set(record.taskId, request);
      work.push(request);
    }
    await Promise.all(work);
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled(this.inFlight.values());
  }
  private report(error: unknown): void { this.options.store.diagnostic('feishu-document-progress', errorMessage(error)); }
  private load(taskId: string): DocumentPublication | null {
    const raw = this.options.store.documentProgressRecord(taskId);
    return raw === null ? null : documentPublicationSchema.parse(raw);
  }
  private save(record: DocumentPublication): void { this.options.store.saveDocumentProgressRecord(record.taskId, record); }
  private saveDelivery(record: DocumentPublication): void {
    const latest = this.load(record.taskId);
    if (!latest) throw new Error('Document publication disappeared');
    this.save({ ...latest, delivery: record.delivery, lastAttemptAt: record.lastAttemptAt,
      nextAttemptAt: record.nextAttemptAt, failures: record.failures });
  }
  private discoverSafely(): boolean {
    try { this.discover(); return true; }
    catch (error) { this.report(error); return false; }
  }
  private discover(): void {
    const store = this.options.store;
    store.transaction(() => {
      const tasks = store.tasks();
      const raw = store.meta(discoveryKey);
      const discovery = raw === null ? { cursor: store.latestExecutionSequence(), excludedTurns: tasks.flatMap(task =>
        task.turnId && finished(taskProgressStatus(task)) && !this.load(task.id) ? [turnKey(task.id, task.turnId)] : []) }
        : discoverySchema.parse(JSON.parse(raw));
      const excluded = new Set(discovery.excludedTurns);
      for (const task of tasks) {
        if (!task.chatId || !task.turnId || excluded.has(turnKey(task.id, task.turnId))) continue;
        let record = this.load(task.id);
        if (record && record.chatId !== task.chatId) throw new Error(`Document chat binding changed for ${task.id}`);
        if (!record) {
          record = { version: 1, taskId: task.id, chatId: task.chatId, turnId: task.turnId,
            view: emptyView(), text: '', delivery: { kind: 'document', title: '执行进度', pending: false },
            lastAttemptAt: 0, nextAttemptAt: 0, failures: 0 };
        }
        record.turnId = task.turnId;
        const conversation = projectDocumentConversation(task, store.inputs(task.id), store.documentConversationEvents(task.id));
        record.view = { status: conversation.status, cursor: conversation.cursor,
          lastExecutionEventAt: conversation.lastExecutionEventAt, assistant: [], tool: null, notice: null };
        record.text = documentConversationText(conversation, this.maxLines);
        this.save(record);
      }
      discovery.cursor = store.latestExecutionSequence();
      store.setMeta(discoveryKey, JSON.stringify(discovery));
    });
  }
  private async deliver(record: DocumentPublication): Promise<void> {
    const transport = this.options.transport;
    let rollback: DocumentPublication['delivery'] | undefined;
    record.lastAttemptAt = this.now();
    record.nextAttemptAt = this.now() + this.intervalMs;
    this.saveDelivery(record);
    try {
      const delivery = record.delivery;
      switch (delivery.kind) {
        case 'document': {
          if (delivery.pending) return;
          rollback = structuredClone(delivery);
          delivery.pending = true;
          this.saveDelivery(record);
          const documentId = await transport.createDocument({ title: delivery.title });
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
            blockId = await transport.createBlock({ documentId: delivery.documentId, ...delivery.write });
          }
          if (!blockId) throw new Error('Managed block creation remains unknown');
          record.delivery = { kind: 'access', documentId: delivery.documentId, documentUrl: delivery.documentUrl, blockId, pending: false };
          break;
        }
        case 'access': {
          const input = { documentId: delivery.documentId, chatId: record.chatId };
          if (!await transport.hasGroupRead(input)) {
            if (delivery.pending) throw new Error('Group permission remains unknown');
            rollback = structuredClone(delivery);
            delivery.pending = true;
            this.saveDelivery(record);
            await transport.grantGroupRead(input);
          }
          record.delivery = { ...delivery, kind: 'tab', pending: false };
          break;
        }
        case 'tab': {
          const input = { chatId: record.chatId, documentUrl: delivery.documentUrl };
          let tabId = await transport.findTab(input);
          if (!tabId && !delivery.pending) {
            rollback = structuredClone(delivery);
            delivery.pending = true;
            this.saveDelivery(record);
            tabId = await transport.createTab(input);
          }
          if (!tabId) throw new Error('Document tab creation remains unknown');
          record.delivery = { kind: 'ready', documentId: delivery.documentId, documentUrl: delivery.documentUrl,
            blockId: delivery.blockId, tabId, content: '', write: null, parts: [], operation: null };
          break;
        }
        case 'ready': {
          delivery.write ??= { clientToken: randomUUID(), text: content(record), chunks: documentChunks(content(record)), sent: false };
          const write = delivery.write;
          if (!write.chunks) {
            const input = { documentId: delivery.documentId, blockId: delivery.blockId };
            if (!write.sent || await transport.readBlock(input) !== write.text) {
              rollback = structuredClone(delivery); write.sent = true; this.saveDelivery(record);
              await transport.replaceContent({ ...input, ...write });
            }
            delivery.parts = [{ blockId: delivery.blockId, text: write.text }];
            delivery.content = write.text; delivery.write = null; break;
          }
          const chunks = write.chunks;
          if (!delivery.parts.length) delivery.parts.push({ blockId: delivery.blockId, text: delivery.content });
          if (!delivery.operation) {
            const changed = delivery.parts.findIndex((part, index) => index < chunks.length && part.text !== chunks[index]);
            const part = delivery.parts[changed], text = chunks[changed];
            if (part && text !== undefined) delivery.operation = { kind: 'replace', blockId: part.blockId, text, clientToken: randomUUID(), sent: false };
            else if (delivery.parts.length < write.chunks.length) {
              const next = write.chunks[delivery.parts.length];
              if (next === undefined) throw new Error('Missing document chunk');
              delivery.operation = { kind: 'append', index: delivery.parts.length - 1, text: next, clientToken: randomUUID(), sent: false };
            } else if (delivery.parts.length > write.chunks.length) {
              delivery.operation = { kind: 'remove', blockIds: delivery.parts.slice(write.chunks.length).map(part => part.blockId), clientToken: randomUUID(), sent: false };
            } else { delivery.content = write.text; delivery.write = null; break; }
          }
          const operation = delivery.operation;
          rollback = structuredClone(delivery);
          switch (operation.kind) {
            case 'replace': {
              const input = { documentId: delivery.documentId, blockId: operation.blockId };
              if (!operation.sent || await transport.readBlock(input) !== operation.text) {
                operation.sent = true; this.saveDelivery(record);
                await transport.replaceContent({ ...input, text: operation.text, clientToken: operation.clientToken });
              }
              const part = delivery.parts.find(part => part.blockId === operation.blockId);
              if (!part) throw new Error('Document block ownership disappeared');
              part.text = operation.text;
              break;
            }
            case 'append': {
              const input = { documentId: delivery.documentId, parentBlockId: delivery.blockId, index: operation.index, text: operation.text };
              let blockId: string | null;
              if (operation.sent) blockId = await transport.findBlock(input);
              else {
                operation.sent = true; this.saveDelivery(record);
                blockId = await transport.createBlock({ ...input, clientToken: operation.clientToken });
              }
              if (!blockId) throw new Error('Overflow block creation remains unknown');
              delivery.parts.push({ blockId, text: operation.text });
              break;
            }
            case 'remove': {
              operation.sent = true; this.saveDelivery(record);
              await transport.removeBlocks({ documentId: delivery.documentId, parentBlockId: delivery.blockId,
                blockIds: operation.blockIds, clientToken: operation.clientToken });
              delivery.parts = delivery.parts.filter(part => !operation.blockIds.includes(part.blockId));
              break;
            }
            default: { const exhaustive: never = operation; return exhaustive; }
          }
          delivery.operation = null;
          if (delivery.parts.length === chunks.length && delivery.parts.every((part, index) => part.text === chunks[index])) {
            delivery.content = write.text; delivery.write = null;
          }
          break;
        }
        default: { const exhaustive: never = delivery; return exhaustive; }
      }
      record.failures = 0;
      record.nextAttemptAt = this.now() + this.intervalMs;
      this.saveDelivery(record);
    } catch (error) {
      // Only a definitive rejection permits a new dispatch. Read failures never erase pending intent.
      if (error instanceof DocumentRequestRejected && rollback) record.delivery = rollback;
      record.failures++;
      record.nextAttemptAt = this.now() + Math.max(this.intervalMs, Math.min(60_000, 3000 * 2 ** Math.min(record.failures - 1, 5)));
      this.saveDelivery(record);
      this.report(`${record.taskId}: ${errorMessage(error)}`);
    }
  }
}
