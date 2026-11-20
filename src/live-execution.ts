import { createHash, randomUUID, type Hash } from 'node:crypto';
import { executionKey, type ExecutionEvent, type VisibleExecution } from './execution-events.js';
import type { ExecutionHistoryPort } from './ports.js';

export interface ExecutionObservation {
  cursor: string;
  canonicalTurnIds: string[];
  history: { kind: 'available' } | { kind: 'unavailable'; reason: string };
  entries: VisibleExecution[];
}
export type ExecutionChange = { cursor: string; event: VisibleExecution };
type GapCoverage = { kind: 'prefix'; length: number; hash: Hash } | { kind: 'unknown' } | { kind: 'history' };
const prefixCoverage = (text: string): GapCoverage => ({ kind: 'prefix', length: text.length, hash: createHash('sha256').update(text, 'utf16le') });
type LiveItem = { kind: 'snapshot'; event: VisibleExecution; streamText: string | null } | { kind: 'gap'; taskId: string; threadId: string; seq: number; after: number; coverage: GapCoverage; terminal: boolean };
const terminal = (kind: ExecutionEvent['kind']) => kind === 'agent_message' || kind === 'tool_end' || kind === 'turn_end';

export class LiveExecution {
  private epoch = randomUUID();
  private sequence = 0;
  private floor = 0;
  private evictedGap = false;
  private readonly items = new Map<string, LiveItem>();
  private readonly changes: ExecutionChange[] = [];
  private readonly listeners = new Set<(change: ExecutionChange | { cursor: string; event: null }) => void>();
  constructor(private readonly history?: ExecutionHistoryPort, private readonly capacity = 4096) {}
  get cursor(): string { return `${this.epoch}:${this.sequence}`; }
  private notify(change: ExecutionChange | { cursor: string; event: null }): void {
    for (const listener of this.listeners) {
      try { listener(change); } catch { this.listeners.delete(listener); }
    }
  }
  private remember(key: string, item: LiveItem): void {
    this.items.delete(key); this.items.set(key, item);
    while (this.items.size > this.capacity) {
      const oldest = this.items.keys().next().value!, evicted = this.items.get(oldest)!;
      if (evicted.kind === 'gap' && !evicted.terminal && evicted.coverage.kind !== 'history') this.evictedGap = true;
      this.items.delete(oldest);
    }
  }
  reset(): void {
    this.epoch = randomUUID(); this.sequence = 0; this.floor = 0; this.evictedGap = false; this.items.clear(); this.changes.length = 0;
    this.notify({ cursor: this.cursor, event: null });
  }
  publish(taskId: string, event: ExecutionEvent): void {
    if (event.kind === 'tool_output') return;
    const key = executionKey(event), local = this.items.get(key), previous = local?.kind === 'snapshot' ? local.event : undefined;
    if ((event.kind === 'agent_delta' || event.kind === 'agent_start') && (previous?.kind === 'agent_message' || (local?.kind === 'gap' && local.terminal))) return;
    const safeText = event.kind === 'tool_start' || event.kind === 'tool_end' ? event.text.split('\n', 1)[0]! : event.text;
    const streamText = event.kind === 'agent_delta' ? local?.kind === 'snapshot' && local.streamText !== null ? local.streamText + safeText : null : safeText;
    const conflict = event.kind === 'agent_delta' && streamText !== null && previous && !streamText.startsWith(previous.text) && !previous.text.startsWith(streamText);
    if (streamText === null || streamText.length > 32768 || conflict) {
      let coverage: GapCoverage;
      if (streamText !== null) coverage = prefixCoverage(streamText);
      else if (local?.kind === 'gap' && local.coverage.kind === 'prefix') {
        coverage = { kind: 'prefix', length: local.coverage.length + safeText.length, hash: local.coverage.hash.copy().update(safeText, 'utf16le') };
      } else coverage = { kind: 'unknown' };
      this.remember(key, { kind: 'gap', taskId, threadId: event.threadId, seq: ++this.sequence,
        after: local?.kind === 'gap' ? local.after : this.sequence - 1,
        coverage, terminal: terminal(event.kind) });
      this.floor = this.sequence;
      this.notify({ cursor: this.cursor, event: null });
      return;
    }
    const text = (event.kind === 'agent_delta' || event.kind === 'agent_start') && previous?.text.startsWith(streamText) ? previous.text : streamText;
    const item: VisibleExecution = { ...event, kind: event.kind === 'agent_start' ? 'agent_delta' : event.kind, key, taskId, seq: ++this.sequence, text };
    this.remember(key, { kind: 'snapshot', event: item, streamText });
    const change = { cursor: this.cursor, event: item };
    this.changes.push(change);
    while (this.changes.length > this.capacity) this.floor = Math.max(this.floor, this.changes.shift()!.event.seq);
    this.notify(change);
  }
  subscribe(listener: (change: ExecutionChange | { cursor: string; event: null }) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  since(cursor: string): ExecutionChange[] | null {
    const [epoch, number] = cursor.split(':');
    const sequence = Number(number);
    if (epoch !== this.epoch || !Number.isSafeInteger(sequence) || sequence < this.floor || sequence > this.sequence) return null;
    return this.changes.filter(change => change.event.seq > sequence);
  }
  current(taskId: string, threadId?: string | null): VisibleExecution[] {
    return [...this.items.values()].flatMap(item => item.kind === 'snapshot' && item.event.taskId === taskId && (threadId === undefined || item.event.threadId === threadId) ? [item.event] : []);
  }
  revision(taskId: string, threadId?: string | null): number {
    return Math.max(0, ...[...this.items.values()].map(item => item.kind === 'snapshot' ? item.event : item).filter(item => item.taskId === taskId && (threadId === undefined || item.threadId === threadId)).map(item => item.seq));
  }
  async read(taskId: string, threadId: string): Promise<ExecutionObservation> {
    const startedAtSequence = this.sequence, startedAtCursor = this.cursor, epoch = this.epoch;
    let entries: VisibleExecution[] = [], history: ExecutionObservation['history'];
    try {
      if (!this.history) throw new Error('Codex history is unavailable');
      entries = (await this.history.readHistory(threadId)).map(event => ({ ...event, taskId, seq: startedAtSequence }));
      history = { kind: 'available' };
    } catch { history = { kind: 'unavailable', reason: 'Codex 历史暂不可用' }; }
    const canonicalTurnIds = [...new Set(entries.flatMap(event => event.turnId === null ? [] : [event.turnId]))];
    const merged = new Map(entries.map(event => [event.key, event]));
    let gap = epoch !== this.epoch || startedAtSequence < this.floor, acknowledged = startedAtSequence;
    const unresolved = new Set<string>();
    for (const [key, local] of this.items) {
      const live = local.kind === 'snapshot' ? local.event : local;
      if (live.taskId !== taskId || live.threadId !== threadId) continue;
      const persisted = merged.get(key);
      if (local.kind === 'gap') {
        const covered = persisted && (local.coverage.kind === 'prefix'
          ? persisted.text.length >= local.coverage.length && createHash('sha256').update(persisted.text.slice(0, local.coverage.length), 'utf16le').digest('hex') === local.coverage.hash.copy().digest('hex')
          : local.coverage.kind === 'history');
        if (!persisted || local.seq > startedAtSequence || (!terminal(persisted.kind) && !covered)) {
          gap = true; unresolved.add(key); acknowledged = Math.min(acknowledged, local.after);
        }
        continue;
      }
      const event = local.event;
      if (persisted?.kind === 'agent_message' && event.kind === 'agent_delta') continue;
      if (persisted?.kind === 'agent_delta' && event.kind === 'agent_message') { merged.set(key, event); continue; }
      if (persisted?.kind === 'agent_delta' && event.kind === 'agent_delta') {
        if (persisted.text.startsWith(event.text)) continue;
        if (event.text.startsWith(persisted.text)) { merged.set(key, event); continue; }
        gap = true;
        this.remember(key, { kind: 'gap', taskId, threadId, seq: ++this.sequence, after: startedAtSequence, coverage: local.streamText === null ? { kind: 'unknown' } : prefixCoverage(local.streamText), terminal: false });
        unresolved.add(key);
        this.floor = this.sequence;
        continue;
      }
      if (!persisted || event.seq > startedAtSequence || history.kind === 'unavailable') {
        merged.set(key, event);
      }
    }
    if (history.kind === 'available' && epoch === this.epoch) {
      for (const item of merged.values()) {
        if (unresolved.has(item.key)) continue;
        const local = this.items.get(item.key);
        if (item.text.length > 32768) {
          this.remember(item.key, { kind: 'gap', taskId, threadId, seq: item.seq, after: item.seq,
            coverage: local?.kind === 'gap' ? local.coverage : local?.streamText !== null && local?.streamText !== undefined ? prefixCoverage(local.streamText) : { kind: 'history' }, terminal: terminal(item.kind) });
        } else this.remember(item.key, { kind: 'snapshot', event: item, streamText: local?.kind === 'snapshot' ? local.streamText : null });
      }
    }
    if (this.evictedGap && (entries.some(item => item.kind === 'agent_delta') || entries.at(-1)?.kind !== 'turn_end' || entries.at(-1)?.text !== 'completed')) {
      gap = true; acknowledged = Math.min(acknowledged, this.floor - 1);
    }
    if (gap) history = { kind: 'unavailable', reason: '实时记录存在缺口，正在重新读取 Codex 历史' };
    return { cursor: gap ? epoch === this.epoch ? `${epoch}:${acknowledged}` : startedAtCursor : this.cursor, canonicalTurnIds, history, entries: [...merged.values()].map((event, index) => ({ ...event, seq: index + 1 })) };
  }
}
