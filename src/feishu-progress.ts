import { createHash } from 'node:crypto';
import { z } from 'zod';
import { errorMessage, type Task } from './domain.js';
import type { FeishuProgressPort } from './ports.js';
import type { Store } from './store.js';
import { finished, progressContent, progressViewSchema, projectProgress, taskProgressStatus } from './feishu-progress-view.js';

const entityFields = { cardId: z.string().min(1), createdAt: z.number() };
const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('content'), sequence: z.number().int().positive(), uuid: z.string(), content: z.string() }),
  z.object({ kind: z.literal('settings'), sequence: z.number().int().positive(), uuid: z.string(), enabled: z.boolean() }),
]);
const publishedFields = { ...entityFields, messageId: z.string().min(1), streamingAt: z.number().nullable(),
  content: z.string(), pending: operationSchema.nullable() };
export const progressPublicationSchema = z.object({
  taskId: z.string(), turnId: z.string(), chatId: z.string(), uuid: z.string(),
  sequence: z.number().int().nonnegative(), view: progressViewSchema,
  lastAttemptAt: z.number(), nextAttemptAt: z.number(), failures: z.number().int().nonnegative(),
  delivery: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('uncreated') }),
    z.object({ kind: z.literal('entity'), ...entityFields }),
    z.object({ kind: z.literal('sending'), ...entityFields, firstAttemptAt: z.number() }),
    z.object({ kind: z.literal('published'), ...publishedFields }),
    z.object({ kind: z.literal('closed'), ...publishedFields }),
    z.object({ kind: z.literal('disabled'), cardId: z.string().nullable(), messageId: z.string().nullable(), reason: z.string() }),
  ]),
});
export type ProgressPublication = z.infer<typeof progressPublicationSchema>;
const discoverySchema = z.object({ cursor: z.number().int().nonnegative(), snapshots: z.record(z.string(), z.string()), excludedTurns: z.array(z.string()).default([]) });
const discoveryKey = 'feishu-progress:discovery:v1';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const key = (record: Pick<ProgressPublication, 'taskId' | 'turnId'>) => JSON.stringify([record.taskId, record.turnId]);
const renewalMs = 8 * 60_000;
const entityLifetimeMs = 14 * 24 * 60 * 60_000;

export class FeishuProgressPublisher {
  private readonly store: Store;
  private readonly transport: FeishuProgressPort;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<void>>();
  private operationTimes: number[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  constructor(private readonly options: { store: Store; transport: FeishuProgressPort; intervalMs?: number; dashboardUrl?: string; now?: () => number }) {
    this.store = options.store; this.transport = options.transport; this.now = options.now ?? Date.now;
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.discoverSafely();
    this.timer = setInterval(() => { void this.poll().catch(error => this.report(error)); }, this.options.intervalMs ?? 1000);
    this.timer.unref();
  }
  async poll(): Promise<void> {
    if (this.stopped || !this.discoverSafely()) return;
    const now = this.now();
    this.operationTimes = this.operationTimes.filter(time => now - time < 1000);
    const work: Promise<void>[] = [];
    for (const record of this.store.activeProgressRecords().map(raw => progressPublicationSchema.parse(raw)).sort((a, b) => a.lastAttemptAt - b.lastAttemptAt)) {
      if (this.inFlight.size >= 4 || this.operationTimes.length >= 12) break;
      if (this.inFlight.has(key(record)) || record.nextAttemptAt > now || !this.needsWrite(record)) continue;
      this.operationTimes.push(now);
      record.lastAttemptAt = now;
      this.save(record);
      const request = this.deliver(record).catch(error => this.report(error)).finally(() => this.inFlight.delete(key(record)));
      this.inFlight.set(key(record), request);
      work.push(request);
    }
    await Promise.all(work);
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled(this.inFlight.values());
  }
  private report(error: unknown): void { this.store.diagnostic('feishu-progress', errorMessage(error)); }
  private discoverSafely(): boolean {
    try { this.discover(); return true; }
    catch (error) { this.report(error); return false; }
  }
  private load(taskId: string, turnId: string): ProgressPublication | null {
    const raw = this.store.progressRecord(taskId, turnId);
    return raw === null ? null : progressPublicationSchema.parse(raw);
  }
  private save(record: ProgressPublication): void {
    if (record.delivery.kind === 'closed' && record.delivery.content !== progressContent(record.view)) {
      record.delivery = { ...record.delivery, kind: 'published', streamingAt: null };
    }
    this.store.saveProgressRecord(record.taskId, record.turnId, record, record.delivery.kind !== 'closed' && record.delivery.kind !== 'disabled');
  }
  private saveDelivery(record: ProgressPublication): void {
    const latest = this.load(record.taskId, record.turnId);
    if (!latest) throw new Error('Progress publication disappeared');
    this.save({ ...latest, delivery: record.delivery, sequence: record.sequence, lastAttemptAt: record.lastAttemptAt,
      nextAttemptAt: record.nextAttemptAt, failures: record.failures });
  }
  private newRecord(task: Task, turnId: string): ProgressPublication {
    return progressPublicationSchema.parse({ taskId: task.id, turnId, chatId: task.chatId,
      uuid: hash(`feishu-progress:${key({ taskId: task.id, turnId })}`).slice(0, 32),
      sequence: 0, lastAttemptAt: 0, nextAttemptAt: 0, failures: 0, delivery: { kind: 'uncreated' },
      view: { status: 'running', cursor: 0, lastExecutionEventAt: null, assistant: [], tool: null } });
  }
  private discover(): void {
    this.store.transaction(() => {
      const raw = this.store.meta(discoveryKey);
      const initial = raw === null;
      const tasks = new Map(this.store.tasks().map(task => [task.id, task]));
      const discovery = initial ? { cursor: this.store.latestExecutionSequence(), snapshots: {},
        excludedTurns: [...tasks.values()].flatMap(task => task.turnId && finished(taskProgressStatus(task)) && !this.load(task.id, task.turnId)
          ? [key({ taskId: task.id, turnId: task.turnId })] : []) } : discoverySchema.parse(JSON.parse(raw));
      const excluded = new Set(discovery.excludedTurns);
      for (const event of this.store.progressEvents(discovery.cursor)) {
        discovery.cursor = event.seq;
        if (!event.turnId) continue;
        if (excluded.has(key({ taskId: event.taskId, turnId: event.turnId }))) continue;
        const task = tasks.get(event.taskId);
        if (!task?.chatId) continue;
        const record = this.load(task.id, event.turnId) ?? this.newRecord(task, event.turnId);
        projectProgress(record.view, event);
        this.save(record);
      }
      const snapshots: Record<string, string> = discovery.snapshots;
      for (const task of tasks.values()) {
        if (!task.chatId || !task.turnId) continue;
        if (excluded.has(key({ taskId: task.id, turnId: task.turnId }))) continue;
        const status = taskProgressStatus(task);
        const signature = JSON.stringify([task.turnId, status]);
        const waiting = status === 'waiting_input' || status === 'waiting_approval';
        if (snapshots[task.id] === signature && !waiting) continue;
        const previous = snapshots[task.id];
        snapshots[task.id] = signature;
        let record = this.load(task.id, task.turnId);
        if (!record && (initial ? !finished(status) : previous !== signature)) {
          record = this.newRecord(task, task.turnId);
          for (const event of this.store.recentTurnEvents(task.id, task.turnId)) projectProgress(record.view, event);
        }
        if (!record) continue;
        if (!finished(record.view.status) || status !== 'running') record.view.status = status;
        this.save(record);
      }
      this.store.setMeta(discoveryKey, JSON.stringify({ ...discovery, snapshots }));
    });
  }
  private needsWrite(record: ProgressPublication): boolean {
    const delivery = record.delivery;
    switch (delivery.kind) {
      case 'uncreated': case 'entity': case 'sending': return true;
      case 'closed': case 'disabled': return false;
      case 'published': return delivery.pending !== null || delivery.streamingAt === null || this.now() - delivery.streamingAt >= renewalMs
        || delivery.content !== progressContent(record.view) || finished(record.view.status);
      default: { const exhaustive: never = delivery; return exhaustive; }
    }
  }
  private disable(record: ProgressPublication, reason: string): void {
    const delivery = record.delivery;
    record.delivery = { kind: 'disabled', reason, cardId: 'cardId' in delivery ? delivery.cardId : null, messageId: 'messageId' in delivery ? delivery.messageId : null };
    this.saveDelivery(record);
    this.report(`${record.taskId}/${record.turnId}: ${reason}`);
  }
  private async deliver(record: ProgressPublication): Promise<void> {
    try {
      let delivery = record.delivery;
      if (delivery.kind === 'sending') {
        const messageId = await this.transport.findProgressMessage({ chatId: record.chatId, cardId: delivery.cardId, since: delivery.firstAttemptAt });
        if (messageId !== null) {
          record.delivery = { kind: 'published', cardId: delivery.cardId, createdAt: delivery.createdAt, messageId,
            streamingAt: delivery.createdAt, content: '', pending: null };
          record.failures = 0; record.nextAttemptAt = 0;
          this.saveDelivery(record);
          return;
        }
      }
      if ('createdAt' in delivery && this.now() - delivery.createdAt >= entityLifetimeMs) {
        this.disable(record, 'Card entity expired; no replacement message will be sent'); return;
      }
      if (delivery.kind === 'uncreated') {
        // An unacknowledged entity is unsent. Retrying creation can only leave an orphan.
        const createdAt = this.now();
        const cardId = await this.transport.createProgressCard({ content: progressContent(record.view), dashboardUrl: this.options.dashboardUrl });
        record.delivery = { kind: 'entity', cardId, createdAt };
      } else if (delivery.kind === 'entity' || delivery.kind === 'sending') {
        const firstAttemptAt = delivery.kind === 'sending' ? delivery.firstAttemptAt : this.now();
        if (this.now() - firstAttemptAt >= 59 * 60_000) {
          this.disable(record, 'Message delivery outcome remains unknown beyond the safe UUID retry window'); return;
        }
        record.delivery = { kind: 'sending', cardId: delivery.cardId, createdAt: delivery.createdAt, firstAttemptAt };
        this.saveDelivery(record);
        const messageId = await this.transport.sendProgressCard({ chatId: record.chatId, cardId: delivery.cardId, uuid: record.uuid });
        record.delivery = { kind: 'published', cardId: delivery.cardId, createdAt: delivery.createdAt, messageId,
          streamingAt: delivery.createdAt, content: '', pending: null };
      } else if (delivery.kind === 'published') {
        if (record.sequence >= 2147483647) { this.disable(record, 'Card operation sequence exhausted'); return; }
        if (delivery.pending) {
          // Unknown writes are superseded with higher sequences, never treated as acknowledged.
          delivery = { ...delivery, pending: null, content: '', streamingAt: null };
        }
        const sequence = ++record.sequence;
        const uuid = hash(`${record.uuid}:${sequence}`).slice(0, 32);
        const content = progressContent(record.view);
        const operation: z.infer<typeof operationSchema> = delivery.streamingAt === null || this.now() - delivery.streamingAt >= renewalMs
          ? { kind: 'settings', sequence, uuid, enabled: true }
          : delivery.content !== content ? { kind: 'content', sequence, uuid, content }
          : { kind: 'settings', sequence, uuid, enabled: false };
        record.delivery = { ...delivery, pending: operation };
        this.saveDelivery(record);
        const attemptedAt = this.now();
        if (operation.kind === 'content') {
          await this.transport.updateProgressContent({ cardId: delivery.cardId, ...operation });
          record.delivery = { ...delivery, content, pending: null };
        } else {
          await this.transport.setProgressStreaming({ cardId: delivery.cardId, ...operation });
          record.delivery = { ...delivery, kind: operation.enabled ? 'published' : 'closed', streamingAt: operation.enabled ? attemptedAt : null, pending: null };
        }
      }
      record.failures = 0; record.nextAttemptAt = 0;
      this.saveDelivery(record);
    } catch (error) {
      record.failures++;
      record.nextAttemptAt = this.now() + Math.min(30_000, 1000 * 2 ** Math.min(record.failures - 1, 5));
      this.saveDelivery(record);
      this.report(`${record.taskId}/${record.turnId}: ${errorMessage(error)}`);
    }
  }
}
