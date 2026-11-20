import { progressFailure, progressDiagnostic } from './feishu-progress-errors.js';
import { LiveExecution } from './live-execution.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type Task } from './domain.js';
import { TaskGroupBindingChanged, TaskGroupUnavailable, type FeishuProgressPort } from './ports.js';
import { assertGroupBinding, retireTaskGroup } from './task-groups.js';
import type { Store } from './store.js';
import { coversSource, sourceFrontier, sourceFrontierSchema, HistoryRetries, finished, progressContent, progressViewSchema, projectProgress, taskProgressStatus } from './feishu-progress-view.js';

const entityFields = { cardId: z.string().min(1), createdAt: z.number() };
const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('content'), sequence: z.number().int().positive(), uuid: z.string(), contentHash: z.string() }),
  z.object({ kind: z.literal('settings'), sequence: z.number().int().positive(), uuid: z.string(), enabled: z.boolean() }),
]);
const publishedFields = { ...entityFields, messageId: z.string().min(1), streamingAt: z.number().nullable(),
  contentHash: z.string(), pending: operationSchema.nullable() };
const runtimePublicationSchema = z.object({
  taskId: z.string(), threadId: z.string(), turnId: z.string(), chatId: z.string(), uuid: z.string(),
  sourceFrontier: sourceFrontierSchema.default({}), projectionHash: z.string().default(''), terminal: z.boolean().default(false), sequence: z.number().int().nonnegative(), view: progressViewSchema,
  lastAttemptAt: z.number(), nextAttemptAt: z.number(), failures: z.number().int().nonnegative(),
  delivery: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('uncreated') }),
    z.object({ kind: z.literal('entity'), ...entityFields }),
    z.object({ kind: z.literal('sending'), ...entityFields, firstAttemptAt: z.number() }),
    z.object({ kind: z.literal('published'), ...publishedFields }),
    z.object({ kind: z.literal('closed'), ...publishedFields }),
    z.object({ kind: z.literal('disabled'), cardId: z.string().nullable(), messageId: z.string().nullable(), reason: z.string(), apiCode: z.number().nullable().default(null) }),
  ]),
});
export const progressPublicationSchema = runtimePublicationSchema.omit({ view: true });
type ProgressPublication = z.infer<typeof runtimePublicationSchema>;
const discoverySchema = z.object({ snapshots: z.record(z.string(), z.string()), excludedTurns: z.array(z.string()) });
const discoveryKey = 'feishu-progress:discovery:v2';
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
  private discoveryWork: Promise<boolean> | null = null;
  private readonly views = new Map<string, ProgressPublication['view']>();
  private readonly hydrated = new Set<string>();
  private readonly observed = new Map<string, string>();
  private readonly historyRetries = new HistoryRetries();
  private unsubscribe: (() => void) | undefined;
  constructor(private readonly options: { store: Store; execution: LiveExecution; transport: FeishuProgressPort; intervalMs?: number; dashboardUrl?: string; now?: () => number }) {
    this.store = options.store; this.transport = options.transport; this.now = options.now ?? Date.now;
    this.unsubscribe = options.execution.subscribe(({ event }) => {
      if (!event) { this.observed.clear(); this.views.clear(); this.hydrated.clear(); return; }
      if (this.store.meta(discoveryKey) === null) return;
      const task = this.store.task(event.taskId);
      if (!task.chatId || task.threadId !== event.threadId || !event.turnId || this.excluded(task.id, event.turnId)) return;
      let record = this.load(task.id, event.turnId);
      if (!record || record.chatId !== task.chatId || record.threadId !== task.threadId) record = this.newRecord(task, event.turnId);
      this.observed.delete(task.id);
      this.hydrated.delete(key(record));
      if (record.delivery.kind === 'uncreated') this.save(record);
    });
  }
  start(): void {
    if (this.timer || this.stopped) return;
    void this.discoverSafely();
    this.timer = setInterval(() => { void this.poll().catch(error => this.report(error)); }, this.options.intervalMs ?? 1000);
    this.timer.unref();
  }
  async poll(): Promise<void> {
    if (this.stopped) return;
    const discovered = await this.discoverSafely();
    if (!discovered || this.stopped) return;
    const now = this.now();
    this.operationTimes = this.operationTimes.filter(time => now - time < 1000);
    const work: Promise<void>[] = [];
    for (const record of this.store.activeProgressRecords().map(raw => progressPublicationSchema.parse(raw)).flatMap(receipt => { const record = this.load(receipt.taskId, receipt.turnId); return record ? [record] : []; }).sort((a, b) => a.lastAttemptAt - b.lastAttemptAt)) {
      if (this.store.task(record.taskId).chatId !== record.chatId) { this.disable(record, '任务群已失效'); continue; }
      if (!this.views.has(key(record)) || !this.hydrated.has(key(record))) continue;
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
    for (const receipt of this.store.activeProgressRecords().map(raw => progressPublicationSchema.parse(raw))) {
      if (this.needsProjection(receipt)) continue;
      this.views.delete(key(receipt)); this.hydrated.delete(key(receipt));
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    await this.discoveryWork;
    await Promise.allSettled(this.inFlight.values());
  }
  private report(error: unknown, taskId?: string, operation = 'discovery', retry: 'pending' | 'disabled' = 'pending'): void {
    this.store.diagnostic(taskId ?? 'feishu-progress', progressDiagnostic(error, `card.${operation}`, retry));
  }
  private discoverSafely(): Promise<boolean> {
    return this.discoveryWork ??= this.discover().then(() => true, error => { this.report(error); return false; })
      .finally(() => { this.discoveryWork = null; });
  }
  private load(taskId: string, turnId: string): ProgressPublication | null {
    const raw = this.store.progressRecord(taskId, turnId);
    if (raw === null) return null;
    const receipt = progressPublicationSchema.parse(raw);
    const view = this.views.get(key(receipt)) ?? progressViewSchema.parse({ status: 'running', cursor: 0, lastExecutionEventAt: null, assistant: [], tool: null });
    return { ...receipt, view };
  }
  private save(record: ProgressPublication): void {
    if (record.delivery.kind === 'closed' && record.delivery.contentHash !== record.projectionHash) {
      record.delivery = { ...record.delivery, kind: 'published', streamingAt: null };
    }
    if (record.delivery.kind === 'closed' || record.delivery.kind === 'disabled') { this.views.delete(key(record)); this.hydrated.delete(key(record)); }
    else if (this.hydrated.has(key(record))) {
      this.views.set(key(record), record.view);
      while (this.views.size > 128) {
        const oldest = this.views.keys().next().value!;
        this.views.delete(oldest); this.hydrated.delete(oldest);
      }
    }
    this.store.saveProgressRecord(record.taskId, record.turnId, progressPublicationSchema.parse(record), record.delivery.kind !== 'closed' && record.delivery.kind !== 'disabled');
  }
  private saveDelivery(record: ProgressPublication): void {
    const latest = this.load(record.taskId, record.turnId);
    if (!latest) throw new Error('Progress publication disappeared');
    if (latest.chatId !== record.chatId || this.store.task(record.taskId).chatId !== record.chatId || this.store.task(record.taskId).threadId !== record.threadId) return;
    this.save({ ...latest, delivery: record.delivery, sequence: record.sequence, lastAttemptAt: record.lastAttemptAt,
      nextAttemptAt: record.nextAttemptAt, failures: record.failures });
  }
  private newRecord(task: Task, turnId: string): ProgressPublication {
    return runtimePublicationSchema.parse({ taskId: task.id, threadId: task.threadId, turnId, chatId: task.chatId,
      uuid: hash(`feishu-progress:${key({ taskId: task.id, turnId })}:${task.chatId}`).slice(0, 32),
      sequence: 0, lastAttemptAt: 0, nextAttemptAt: 0, failures: 0, delivery: { kind: 'uncreated' },
      view: { status: 'running', cursor: 0, lastExecutionEventAt: null, assistant: [], tool: null } });
  }
  private initializeDiscovery(): void {
    if (this.store.meta(discoveryKey) !== null) return;
    this.store.setMeta(discoveryKey, JSON.stringify({ snapshots: Object.fromEntries(this.store.tasks().flatMap(task =>
      task.turnId && task.threadId && task.chatId ? [[JSON.stringify([task.id, task.threadId, task.chatId]), task.turnId]] : [])), excludedTurns: this.store.tasks().flatMap(task =>
      task.turnId && finished(taskProgressStatus(task)) && !this.load(task.id, task.turnId) ? [key({ taskId: task.id, turnId: task.turnId })] : []) }));
  }
  private excluded(taskId: string, turnId: string): boolean {
    return discoverySchema.parse(JSON.parse(this.store.meta(discoveryKey)!)).excludedTurns.includes(key({ taskId, turnId }));
  }
  private async discover(): Promise<void> {
    this.initializeDiscovery();
    for (const task of this.store.tasks()) {
      if (!task.chatId || !task.threadId || !task.turnId || this.excluded(task.id, task.turnId)) continue;
      const signature = JSON.stringify([task.threadId, task.turnId, task.chatId, taskProgressStatus(task), this.options.execution.revision(task.id, task.threadId)]);
      const pending = this.store.activeProgressRecords().map(raw => progressPublicationSchema.parse(raw)).filter(record => record.taskId === task.id && record.threadId === task.threadId && record.chatId === task.chatId);
      if (this.observed.get(task.id) === signature && pending.every(record => !this.needsProjection(record) || this.hydrated.has(key(record)))) continue;
      if (!this.historyRetries.ready(task.id, signature, this.now())) continue;
      const observation = await this.options.execution.read(task.id, task.threadId);
      if (this.stopped) return;
      const current = this.store.task(task.id);
      if (current.threadId !== task.threadId || current.turnId !== task.turnId || current.chatId !== task.chatId || taskProgressStatus(current) !== taskProgressStatus(task)) continue;
      if (observation.history.kind === 'unavailable') { this.historyRetries.failed(task.id, signature, this.now()); continue; }
      const discovery = discoverySchema.parse(JSON.parse(this.store.meta(discoveryKey)!));
      const discoveryBinding = JSON.stringify([task.id, task.threadId, task.chatId]);
      const watermark = discovery.snapshots[discoveryBinding];
      const turns = observation.canonicalTurnIds;
      if (watermark && watermark !== task.turnId && !turns.includes(task.turnId)) {
        this.historyRetries.failed(task.id, signature, this.now()); continue;
      }
      const eligible = watermark ? turns.slice(Math.max(0, turns.indexOf(watermark) + 1)) : [];
      eligible.push(task.turnId, ...this.store.activeProgressRecords().map(raw => progressPublicationSchema.parse(raw)).filter(record => record.taskId === task.id && record.threadId === task.threadId && record.chatId === task.chatId).map(record => record.turnId));
      let covered = true;
      let hydrated = 0;
      for (const turnId of new Set(eligible)) {
        if (this.excluded(task.id, turnId)) continue;
        let record = this.load(task.id, turnId);
        if (record && (record.chatId !== task.chatId || record.threadId !== task.threadId)) {
          this.store.setMeta(`retired-progress:${task.id}:${record.chatId}:${turnId}`, JSON.stringify(progressPublicationSchema.parse(record)));
          record = null;
        }
        record ??= this.newRecord(task, turnId);
        if (record.delivery.kind === 'disabled') continue;
        if (record.delivery.kind === 'closed' && turnId !== task.turnId) continue;
        if (this.observed.get(task.id) === signature && !this.needsProjection(record)) continue;
        if (hydrated >= 64 || (!this.views.has(key(record)) && this.views.size >= 128)) {
          if (record.delivery.kind === 'uncreated') this.save(record);
          continue;
        }
        const entries = observation.entries.filter(event => event.turnId === turnId);
        if (!coversSource(entries, record.sourceFrontier)) { covered = false; continue; }
        const view = progressViewSchema.parse({ status: 'running', cursor: 0, lastExecutionEventAt: null, assistant: [], tool: null });
        for (const event of entries) projectProgress(view, event);
        if (turnId === task.turnId && (!finished(view.status) || taskProgressStatus(task) !== 'running')) view.status = taskProgressStatus(task);
        record.view = view; record.sourceFrontier = sourceFrontier(entries); record.projectionHash = hash(progressContent(view)); record.terminal = finished(view.status); hydrated++;
        this.hydrated.add(key(record));
        this.save(record);
      }
      if (covered) {
        discovery.snapshots[discoveryBinding] = turns.at(-1) ?? task.turnId;
        this.store.setMeta(discoveryKey, JSON.stringify(discovery));
      }
      if (covered) { this.observed.set(task.id, signature); this.historyRetries.succeeded(task.id); }
      else this.historyRetries.failed(task.id, signature, this.now());
    }
  }
  private needsProjection(record: z.infer<typeof progressPublicationSchema>): boolean {
    const delivery = record.delivery;
    if (delivery.kind === 'closed' || delivery.kind === 'disabled') return false;
    return delivery.kind !== 'published' || delivery.pending !== null || delivery.contentHash !== record.projectionHash
      || delivery.streamingAt === null || this.now() - delivery.streamingAt >= renewalMs || record.terminal;
  }
  private needsWrite(record: ProgressPublication): boolean {
    const delivery = record.delivery;
    switch (delivery.kind) {
      case 'uncreated': case 'entity': case 'sending': return true;
      case 'closed': case 'disabled': return false;
      case 'published': return delivery.pending !== null || delivery.streamingAt === null || this.now() - delivery.streamingAt >= renewalMs
        || delivery.contentHash !== hash(progressContent(record.view)) || finished(record.view.status);
      default: { const exhaustive: never = delivery; return exhaustive; }
    }
  }
  private disable(record: ProgressPublication, reason: string, apiCode: number | null = null): void {
    const delivery = record.delivery;
    record.delivery = { kind: 'disabled', reason, apiCode, cardId: 'cardId' in delivery ? delivery.cardId : null, messageId: 'messageId' in delivery ? delivery.messageId : null };
    const latest = this.load(record.taskId, record.turnId);
    if (latest?.chatId === record.chatId) this.save({ ...latest, delivery: record.delivery });
    this.report(reason, record.taskId, 'disable', 'disabled');
  }
  private async deliver(record: ProgressPublication): Promise<void> {
    const guard = () => { assertGroupBinding(this.store, record.taskId, record.chatId); if (this.store.task(record.taskId).threadId !== record.threadId) throw new TaskGroupBindingChanged(); };
    try {
      if (this.store.task(record.taskId).chatId !== record.chatId) { this.disable(record, '任务群已失效'); return; }
      let delivery = record.delivery;
      if (delivery.kind === 'sending') {
        const messageId = await this.transport.findProgressMessage({ chatId: record.chatId, cardId: delivery.cardId, since: delivery.firstAttemptAt });
        if (this.store.task(record.taskId).chatId !== record.chatId) return;
        if (messageId !== null) {
          record.delivery = { kind: 'published', cardId: delivery.cardId, createdAt: delivery.createdAt, messageId,
            streamingAt: delivery.createdAt, contentHash: '', pending: null };
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
        const cardId = await this.transport.createProgressCard({ content: progressContent(record.view), dashboardUrl: this.options.dashboardUrl }, guard);
        record.delivery = { kind: 'entity', cardId, createdAt };
      } else if (delivery.kind === 'entity' || delivery.kind === 'sending') {
        const firstAttemptAt = delivery.kind === 'sending' ? delivery.firstAttemptAt : this.now();
        if (this.now() - firstAttemptAt >= 59 * 60_000) {
          this.disable(record, 'Message delivery outcome remains unknown beyond the safe UUID retry window'); return;
        }
        record.delivery = { kind: 'sending', cardId: delivery.cardId, createdAt: delivery.createdAt, firstAttemptAt };
        this.saveDelivery(record);
        const messageId = await this.transport.sendProgressCard({ chatId: record.chatId, cardId: delivery.cardId, uuid: record.uuid }, guard);
        record.delivery = { kind: 'published', cardId: delivery.cardId, createdAt: delivery.createdAt, messageId,
          streamingAt: delivery.createdAt, contentHash: '', pending: null };
      } else if (delivery.kind === 'published') {
        if (record.sequence >= 2147483647) { this.disable(record, 'Card operation sequence exhausted'); return; }
        if (delivery.pending) {
          // Unknown writes are superseded with higher sequences, never treated as acknowledged.
          delivery = { ...delivery, pending: null, contentHash: '', streamingAt: null };
        }
        const sequence = ++record.sequence;
        const uuid = hash(`${record.uuid}:${sequence}`).slice(0, 32);
        const content = progressContent(record.view);
        const operation: z.infer<typeof operationSchema> = delivery.streamingAt === null || this.now() - delivery.streamingAt >= renewalMs
          ? { kind: 'settings', sequence, uuid, enabled: true }
          : delivery.contentHash !== hash(content) ? { kind: 'content', sequence, uuid, contentHash: hash(content) }
          : { kind: 'settings', sequence, uuid, enabled: false };
        record.delivery = { ...delivery, pending: operation };
        this.saveDelivery(record);
        const attemptedAt = this.now();
        if (operation.kind === 'content') {
          await this.transport.updateProgressContent({ cardId: delivery.cardId, content, ...operation }, guard);
          record.delivery = { ...delivery, contentHash: hash(content), pending: null };
        } else {
          await this.transport.setProgressStreaming({ cardId: delivery.cardId, ...operation }, guard);
          record.delivery = { ...delivery, kind: operation.enabled ? 'published' : 'closed', streamingAt: operation.enabled ? attemptedAt : null, pending: null };
        }
      }
      record.failures = 0; record.nextAttemptAt = 0;
      this.saveDelivery(record);
    } catch (error) {
      if (error instanceof TaskGroupBindingChanged) { this.disable(record, progressFailure(error)); return; }
      if (error instanceof TaskGroupUnavailable) {
        retireTaskGroup(this.store, record.taskId, record.chatId);
        this.disable(record, progressFailure(error), error.code); return;
      }
      record.failures++;
      record.nextAttemptAt = this.now() + Math.min(30_000, 1000 * 2 ** Math.min(record.failures - 1, 5));
      this.saveDelivery(record);
      this.report(error, record.taskId, record.delivery.kind);
    }
  }
}
