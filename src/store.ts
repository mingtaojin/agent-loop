import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { executionEventSchema, storedExecutionEventSchema, type ExecutionEvent, type StoredExecutionEvent } from './execution-events.js';
import { approvalActionSchema, inputProvenanceSchema, incomingSchema, repositorySchema, sourceSchema, taskSchema, type ApprovalAction, type IncomingMessage, type InputProvenance, type Source, type Task } from './domain.js';

const payloadRow = z.object({ payload: z.string() });
export const documentSourcePositionSchema = z.strictObject({
  eventSeq: z.number().int().nonnegative(), inputSeq: z.number().int().nonnegative(),
});
export type DocumentSourcePosition = z.infer<typeof documentSourcePositionSchema>;
const operationSchema = z.object({ id: z.string(), task_id: z.string(), kind: z.string(), status: z.enum(['attempting', 'confirmed', 'uncertain']), result: z.string().nullable(), error: z.string().nullable() });
export type Operation = z.infer<typeof operationSchema>;
const inboxRow = z.object({ seq: z.number(), id: z.string(), task_id: z.string(), payload: z.string(), status: z.enum(['pending', 'delivering', 'delivered', 'failed', 'uncertain', 'held', 'dropped']), origin: z.enum(['user', 'source', 'initial', 'resume']), error: z.string().nullable() });
export type Inbox = Omit<z.infer<typeof inboxRow>, 'payload'> & { message: IncomingMessage; provenance: InputProvenance; requestId: string | null };
const outboxSchema = z.object({ id: z.string(), task_id: z.string(), text: z.string(), status: z.enum(['pending', 'sending', 'sent', 'uncertain', 'dropped']), error: z.string().nullable() });
export type Outbox = z.infer<typeof outboxSchema>;

/** Runtime execution traces are a bounded projection; user/audit facts live in their own tables. */
export const executionEventRetentionLimit = 2_000;
export const executionDeltaSampleMs = 250;
export const diagnosticRetentionLimit = 1_000;
const diagnosticReadLimit = 100;
const diagnosticMessageLimit = 8_192;
type LiveExecutionListener = (event: StoredExecutionEvent) => void;
const liveExecutionListeners = new Map<string, Set<LiveExecutionListener>>();

export class Store {
  private readonly db: DatabaseSync;
  private readonly lock: DatabaseSync | null;
  private readonly lastDeltaAt = new Map<string, number>();
  private readonly ephemeralEvents: StoredExecutionEvent[] = [];
  private logicalSequence = 0;
  private logicalSequenceLoaded = false;
  private unsubscribeLive: (() => void) | null = null;
  constructor(private readonly dataDir: string, options: { readOnly?: boolean } = {}) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.lock = options.readOnly ? null : new DatabaseSync(join(dataDir, 'owner.sqlite'));
    try { this.lock?.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
    catch { this.lock?.close(); throw new Error('已有 Agent Loop 进程使用此数据目录'); }
    try {
      this.db = new DatabaseSync(join(dataDir, 'tasks.sqlite'), { readOnly: options.readOnly ?? false });
      if (options.readOnly) {
        const listeners = liveExecutionListeners.get(dataDir) ?? new Set<LiveExecutionListener>();
        liveExecutionListeners.set(dataDir, listeners);
        const listener: LiveExecutionListener = event => {
          this.ephemeralEvents.push(event);
          if (this.ephemeralEvents.length > 4_096) this.ephemeralEvents.splice(0, this.ephemeralEvents.length - 4_096);
        };
        listeners.add(listener);
        this.unsubscribeLive = () => { listeners.delete(listener); if (!listeners.size) liveExecutionListeners.delete(dataDir); };
        return;
      }
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,payload TEXT NOT NULL,reason TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS source_revisions(source_id TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(source_id,hash));
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,source_id TEXT NOT NULL UNIQUE,chat_id TEXT UNIQUE,thread_id TEXT UNIQUE,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),payload TEXT NOT NULL,status TEXT NOT NULL,origin TEXT NOT NULL DEFAULT 'user',error TEXT);
        CREATE INDEX IF NOT EXISTS inbox_task ON inbox(task_id,seq);
        CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),text TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT);
        CREATE TABLE IF NOT EXISTS approval_actions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),payload TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
        CREATE TABLE IF NOT EXISTS diagnostics(id INTEGER PRIMARY KEY,created_at INTEGER NOT NULL,scope TEXT NOT NULL,message TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS diagnostic_rollups(scope TEXT NOT NULL,fingerprint TEXT NOT NULL,first_created_at INTEGER NOT NULL,last_created_at INTEGER NOT NULL,count INTEGER NOT NULL,message TEXT NOT NULL,PRIMARY KEY(scope,fingerprint));
        CREATE INDEX IF NOT EXISTS diagnostic_rollups_recent ON diagnostic_rollups(last_created_at DESC);
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS execution_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(id),created_at INTEGER NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS execution_events_task ON execution_events(task_id,seq);
        CREATE INDEX IF NOT EXISTS execution_events_task_kind_seq ON execution_events(task_id,json_extract(payload,'$.kind'),seq);
        CREATE TABLE IF NOT EXISTS feishu_progress(task_id TEXT NOT NULL REFERENCES tasks(id),turn_id TEXT NOT NULL,payload TEXT NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(task_id,turn_id));
        CREATE INDEX IF NOT EXISTS feishu_progress_active ON feishu_progress(active);
        CREATE TABLE IF NOT EXISTS feishu_document_progress(task_id TEXT PRIMARY KEY REFERENCES tasks(id),payload TEXT NOT NULL);
        `);
      const columns = this.db.prepare('PRAGMA table_info(inbox)').all().map(row => z.object({ name: z.string() }).parse(row).name);
      if (!columns.includes('origin')) this.db.exec("ALTER TABLE inbox ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'");
      this.transaction(() => {
        for (const raw of this.db.prepare('SELECT payload FROM tasks').all()) {
          const task = this.normalizeTask(JSON.parse(payloadRow.parse(raw).payload));
          this.saveTask(task);
        }
        this.db.exec('PRAGMA user_version=2');
      });
    } catch (error) { this.lock?.close(); throw error; }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveSource(source: Source, reason: string): void {
    const payload = JSON.stringify(source);
    this.db.prepare('INSERT INTO sources VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,reason=excluded.reason').run(source.id, payload, reason);
    this.db.prepare('INSERT OR IGNORE INTO source_revisions VALUES(?,?,?)').run(source.id, createHash('sha256').update(payload).digest('hex'), payload);
  }
  sources(): { source: Source; reason: string }[] {
    return this.db.prepare('SELECT payload,reason FROM sources').all().map(row => { const parsed = payloadRow.extend({ reason: z.string() }).parse(row); return { source: sourceSchema.parse(JSON.parse(parsed.payload)), reason: parsed.reason }; });
  }
  saveTask(task: Task): void {
    this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id,thread_id=excluded.thread_id,payload=excluded.payload').run(task.id, task.sourceId, task.chatId, task.threadId, JSON.stringify(task));
  }
  tasks(): Task[] { return this.db.prepare('SELECT payload FROM tasks ORDER BY rowid').all().map(row => this.normalizeTask(JSON.parse(payloadRow.parse(row).payload))); }
  task(id: string): Task { const row = this.db.prepare('SELECT payload FROM tasks WHERE id=?').get(id); if (!row) throw new Error(`Unknown task ${id}`); return this.normalizeTask(JSON.parse(payloadRow.parse(row).payload)); }
  taskForSource(id: string): Task | null { return this.findTask('source_id', id); }
  taskForChat(id: string): Task | null { return this.findTask('chat_id', id); }
  taskForThread(id: string): Task | null { return this.findTask('thread_id', id); }
  private findTask(column: 'source_id' | 'chat_id' | 'thread_id', id: string): Task | null {
    const row = this.db.prepare(`SELECT payload FROM tasks WHERE ${column}=?`).get(id);
    return row ? this.normalizeTask(JSON.parse(payloadRow.parse(row).payload)) : null;
  }
  private normalizeTask(raw: unknown): Task {
    const current = taskSchema.safeParse(raw);
    if (current.success) return current.data;
    const legacy = z.object({
      id: z.string(), sourceId: z.string(), source: sourceSchema, repository: repositorySchema,
      workspace: z.string().nullable(), branch: z.string(), status: z.string(), prUrl: z.string().nullable().default(null),
    }).passthrough().parse(raw);
    return taskSchema.parse({
      ...legacy, source: { kind: 'github', issue: legacy.source, repository: legacy.repository, collectionReason: 'legacy' },
      contextDirectory: legacy.workspace ?? join(this.dataDir, 'tasks', legacy.id),
      resources: legacy.workspace ? [{ id: 'legacy', repository: legacy.repository, workspace: legacy.workspace, branch: legacy.branch }] : [],
      status: ['waiting_user', 'awaiting_review'].includes(legacy.status) ? 'idle' : legacy.status,
      legacy: { status: legacy.status, prUrl: legacy.prUrl },
    });
  }
  receive(taskId: string, message: IncomingMessage, origin: Inbox['origin'] = 'user', provenance?: InputProvenance): boolean {
    const task = this.task(taskId);
    if (origin === 'user' && provenance === undefined && task.chatId !== null && message.chatId !== task.chatId) return false;
    const facts = provenance ?? (origin === 'user' ? { kind: 'user', message } : origin === 'source'
      ? { kind: 'github_issue', sourceId: task.sourceId, revision: message.id, url: task.source.kind === 'github' ? task.source.issue.url : '' }
      : origin === 'initial' ? { kind: 'initial', sourceId: task.sourceId } : { kind: 'recovery', previousTurnId: task.turnId ?? 'legacy' });
    return this.db.prepare("INSERT OR IGNORE INTO inbox(id,task_id,payload,status,origin) VALUES(?,?,?,'pending',?)").run(message.id, taskId, JSON.stringify({ message, provenance: facts, requestId: null }), origin).changes > 0;
  }
  inputs(taskId: string): Inbox[] {
    return this.db.prepare('SELECT * FROM inbox WHERE task_id=? ORDER BY seq').all(taskId).map(raw => {
      const { payload, ...row } = inboxRow.parse(raw);
      const json: unknown = JSON.parse(payload);
      const wrapped = z.object({ message: incomingSchema, provenance: inputProvenanceSchema, requestId: z.string().nullable().default(null) }).safeParse(json);
      if (wrapped.success) return { ...row, ...wrapped.data };
      const message = incomingSchema.parse(json);
      const task = this.task(taskId);
      const provenance: InputProvenance = row.origin === 'user' ? { kind: 'user', message }
        : row.origin === 'source' ? { kind: 'github_issue', sourceId: task.sourceId, revision: message.id, url: task.source.kind === 'github' ? task.source.issue.url : '' }
        : row.origin === 'initial' ? { kind: 'initial', sourceId: task.sourceId } : { kind: 'recovery', previousTurnId: task.turnId ?? 'legacy' };
      return { ...row, message, provenance, requestId: null };
    });
  }
  associateRequest(id: string, taskId: string, requestId: string): void {
    const input = this.inputs(taskId).find(item => item.id === id);
    if (!input) throw new Error('Unknown inbox input');
    this.db.prepare('UPDATE inbox SET payload=? WHERE id=?').run(JSON.stringify({ message: input.message, provenance: input.provenance, requestId }), id);
  }
  markInput(id: string, status: Inbox['status'], error: string | null = null): void { this.db.prepare('UPDATE inbox SET status=?,error=? WHERE id=?').run(status, error, id); }
  enqueue(taskId: string, text: string, key: string): string {
    const id = createHash('sha256').update(`${taskId}:${key}`).digest('hex').slice(0, 32);
    this.db.prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,'pending',NULL)").run(id, taskId, text);
    return id;
  }
  hasOutput(taskId: string, key: string): boolean {
    const id = createHash('sha256').update(`${taskId}:${key}`).digest('hex').slice(0, 32);
    return this.db.prepare('SELECT id FROM outbox WHERE id=?').get(id) !== undefined;
  }
  outputs(taskId: string): Outbox[] { return this.db.prepare('SELECT * FROM outbox WHERE task_id=? ORDER BY rowid').all(taskId).map(row => outboxSchema.parse(row)); }
  markOutput(id: string, status: Outbox['status'], error: string | null = null): void { this.db.prepare('UPDATE outbox SET status=?,error=? WHERE id=?').run(status, error, id); }
  operation(id: string): Operation | null { const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id); return row ? operationSchema.parse(row) : null; }
  beginOperation(id: string, taskId: string, kind: string): void { this.db.prepare("INSERT INTO operations VALUES(?,?,?,'attempting',NULL,NULL)").run(id, taskId, kind); }
  retryRejectedOperation(id: string): void {
    const result = this.db.prepare("UPDATE operations SET status='attempting',result=NULL,error=NULL WHERE id=? AND status='uncertain' AND error='rejected'").run(id);
    if (result.changes !== 1) throw new Error('Operation is not a rejected attempt');
  }
  finishOperation(id: string, result: string): void { this.db.prepare("UPDATE operations SET status='confirmed',result=?,error=NULL WHERE id=?").run(result, id); }
  uncertainOperation(id: string, error: string): void { this.db.prepare("UPDATE operations SET status='uncertain',error=? WHERE id=?").run(error, id); }
  queueApproval(action: ApprovalAction): boolean {
    const id = this.approvalKey(action);
    return this.db.prepare("INSERT OR IGNORE INTO approval_actions VALUES(?,?,?,'pending',NULL)").run(id, action.taskId, JSON.stringify(action)).changes > 0;
  }
  approvalKey(action: ApprovalAction): string { return `approval:${action.taskId}:${action.epoch}:${action.requestId}`; }
  approvals(taskId: string): { id: string; action: ApprovalAction; status: string; error: string | null }[] {
    const schema = z.object({ id: z.string(), payload: z.string(), status: z.string(), error: z.string().nullable() });
    return this.db.prepare('SELECT id,payload,status,error FROM approval_actions WHERE task_id=? ORDER BY rowid').all(taskId).map(raw => {
      const row = schema.parse(raw);
      return { id: row.id, action: approvalActionSchema.parse(JSON.parse(row.payload)), status: row.status, error: row.error };
    });
  }
  markApproval(id: string, status: 'processing' | 'confirmed' | 'uncertain' | 'rejected', error: string | null = null): void {
    this.db.prepare('UPDATE approval_actions SET status=?,error=? WHERE id=?').run(status, error, id);
  }
  diagnostic(scope: string, message: string): void {
    const createdAt = Date.now();
    const bounded = message.length <= diagnosticMessageLimit ? message : message.slice(0, diagnosticMessageLimit) + '\n…';
    const fingerprint = createHash('sha256').update(`${scope}\u0000${bounded}`).digest('hex');
    this.db.prepare(`INSERT INTO diagnostic_rollups(scope,fingerprint,first_created_at,last_created_at,count,message)
      VALUES(?,?,?,?,1,?) ON CONFLICT(scope,fingerprint) DO UPDATE SET last_created_at=excluded.last_created_at,count=diagnostic_rollups.count+1,message=excluded.message`)
      .run(scope, fingerprint, createdAt, createdAt, bounded);
    this.db.prepare(`DELETE FROM diagnostic_rollups WHERE rowid NOT IN (SELECT rowid FROM diagnostic_rollups ORDER BY last_created_at DESC LIMIT ?)`)
      .run(diagnosticRetentionLimit);
  }
  diagnostics(): { created_at: number; scope: string; message: string }[] {
    const schema = z.object({ created_at: z.number(), scope: z.string(), message: z.string() });
    const legacy = this.db.prepare('SELECT created_at,scope,message FROM diagnostics ORDER BY id DESC LIMIT ?').all(diagnosticReadLimit).map(row => schema.parse(row));
    const hasRollups = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='diagnostic_rollups'").get();
    const rollups = hasRollups ? this.db.prepare('SELECT last_created_at AS created_at,scope,message FROM diagnostic_rollups ORDER BY last_created_at DESC LIMIT ?').all(diagnosticReadLimit).map(row => schema.parse(row)) : [];
    const seen = new Set<string>();
    return [...legacy, ...rollups].sort((a, b) => b.created_at - a.created_at).filter(row => {
      const identity = `${row.scope}\u0000${row.message}`;
      if (seen.has(identity)) return false;
      seen.add(identity); return true;
    }).slice(0, diagnosticReadLimit);
  }
  meta(key: string): string | null { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? z.object({ value: z.string() }).parse(row).value : null; }
  recordExecutionEvent(taskId: string, event: ExecutionEvent): void {
    const sequence = this.nextExecutionSequence();
    let persist = event.kind !== 'tool_output' && event.kind !== 'agent_delta';
    // Keep enough live narrative for the dashboard/progress surfaces without turning every token
    // delta into a durable row. Completed messages and lifecycle events remain lossless.
    if (event.kind === 'agent_delta') {
      const key = `${taskId}\u0000${event.threadId}\u0000${event.turnId ?? ''}\u0000${event.itemId ?? ''}`;
      const previous = this.lastDeltaAt.get(key);
      persist = previous === undefined || event.createdAt - previous >= executionDeltaSampleMs;
      if (persist) this.lastDeltaAt.set(key, event.createdAt);
    }
    const compact = event.kind === 'tool_start' || event.kind === 'tool_end'
      ? { ...event, text: event.text.split('\n', 1)[0]!.slice(0, 4_096) }
      : event;
    const stored = storedExecutionEventSchema.parse({ ...compact, seq: sequence, taskId });
    if (!persist) {
      const live = { ...stored, text: stored.text.length <= 16_384 ? stored.text : stored.text.slice(-16_384) };
      this.ephemeralEvents.push(live);
      if (this.ephemeralEvents.length > 4_096) this.ephemeralEvents.splice(0, this.ephemeralEvents.length - 4_096);
      for (const listener of liveExecutionListeners.get(this.dataDir) ?? []) listener(live);
      return;
    }
    this.db.prepare('INSERT INTO execution_events(seq,task_id,created_at,payload) VALUES(?,?,?,?)').run(sequence, taskId, event.createdAt, JSON.stringify(compact));
    this.pruneExecutionEvents(taskId);
  }
  private nextExecutionSequence(): number {
    if (!this.logicalSequenceLoaded) {
      const row = z.object({ seq: z.number() }).parse(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM execution_events').get());
      this.logicalSequence = row.seq; this.logicalSequenceLoaded = true;
    }
    return ++this.logicalSequence;
  }
  private eventRows(taskId: string, after = 0, limit = 500, includeToolOutput = true): StoredExecutionEvent[] {
    const durable = this.db.prepare('SELECT seq,task_id,payload FROM execution_events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?').all(taskId, after, limit).map(raw => {
      const row = z.object({ seq: z.number(), task_id: z.string(), payload: z.string() }).parse(raw);
      return storedExecutionEventSchema.parse({ ...executionEventSchema.parse(JSON.parse(row.payload)), seq: row.seq, taskId: row.task_id });
    });
    const transient = this.ephemeralEvents.filter(event => event.taskId === taskId && event.seq > after && (includeToolOutput || event.kind !== 'tool_output'));
    return [...durable, ...transient].sort((a, b) => a.seq - b.seq).slice(0, limit);
  }
  private pruneExecutionEvents(taskId: string): void {
    const count = z.object({ count: z.number() }).parse(this.db.prepare('SELECT COUNT(*) AS count FROM execution_events WHERE task_id=?').get(taskId)).count;
    const overflow = count - executionEventRetentionLimit;
    if (overflow <= 0) return;
    // Keep final answers and lifecycle facts longest. Drop sampled/tool metadata first,
    // then the oldest status rows if the durable budget still overflows.
    this.db.prepare(`DELETE FROM execution_events WHERE seq IN (
      SELECT seq FROM execution_events WHERE task_id=?
      ORDER BY CASE json_extract(payload,'$.kind')
        WHEN 'agent_delta' THEN 0
        WHEN 'tool_start' THEN 0
        WHEN 'tool_end' THEN 0
        WHEN 'turn_status' THEN 1
        WHEN 'error' THEN 2
        WHEN 'turn_start' THEN 2
        WHEN 'turn_end' THEN 2
        WHEN 'agent_message' THEN 3
        ELSE 1 END, seq LIMIT ?)`)
      .run(taskId, overflow);
  }
  executionEvents(taskId: string, after = 0, limit = 500): StoredExecutionEvent[] {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_events'").get()) return [];
    return this.eventRows(taskId, after, limit);
  }
  visibleExecutionEvents(taskId: string, after = 0, limit = 500): StoredExecutionEvent[] {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_events'").get()) return [];
    return this.eventRows(taskId, after, limit, false);
  }
  latestVisibleExecutionEvent(taskId: string): StoredExecutionEvent | null {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_events'").get()) return null;
    const raw = this.db.prepare(`SELECT seq,task_id,payload FROM execution_events
      WHERE task_id=? AND COALESCE(json_extract(payload,'$.kind'),'') <> 'tool_output'
      ORDER BY seq DESC LIMIT 1`).get(taskId);
    if (!raw) return null;
    const row = z.object({ seq: z.number(), task_id: z.string(), payload: z.string() }).parse(raw);
    return storedExecutionEventSchema.parse({ ...executionEventSchema.parse(JSON.parse(row.payload)), seq: row.seq, taskId: row.task_id });
  }
  latestVisibleExecutionEvents(taskIds: readonly string[]): Map<string, StoredExecutionEvent> {
    const result = new Map<string, StoredExecutionEvent>();
    if (!taskIds.length || !this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_events'").get()) return result;
    const placeholders = taskIds.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT event.seq,event.task_id,event.payload FROM execution_events event
      JOIN (SELECT task_id,MAX(seq) AS seq FROM execution_events
        WHERE task_id IN (${placeholders}) AND COALESCE(json_extract(payload,'$.kind'),'') <> 'tool_output'
        GROUP BY task_id) latest ON latest.task_id=event.task_id AND latest.seq=event.seq`).all(...taskIds);
    for (const raw of rows) {
      const row = z.object({ seq: z.number(), task_id: z.string(), payload: z.string() }).parse(raw);
      result.set(row.task_id, storedExecutionEventSchema.parse({ ...executionEventSchema.parse(JSON.parse(row.payload)), seq: row.seq, taskId: row.task_id }));
    }
    for (const event of this.ephemeralEvents) {
      if (event.kind === 'tool_output' || !taskIds.includes(event.taskId)) continue;
      const previous = result.get(event.taskId);
      if (!previous || event.seq > previous.seq) result.set(event.taskId, event);
    }
    return result;
  }
  documentConversationPosition(taskId: string): DocumentSourcePosition {
    const position = documentSourcePositionSchema.parse(this.db.prepare(`SELECT
      COALESCE((SELECT seq FROM execution_events WHERE task_id=? ORDER BY seq DESC LIMIT 1),0) AS eventSeq,
      COALESCE((SELECT seq FROM inbox WHERE task_id=? ORDER BY seq DESC LIMIT 1),0) AS inputSeq`).get(taskId, taskId));
    const transient = this.ephemeralEvents.filter(event => event.taskId === taskId).at(-1)?.seq ?? 0;
    return { ...position, eventSeq: Math.max(position.eventSeq, transient) };
  }
  *documentConversationEvents(taskId: string): IterableIterator<StoredExecutionEvent> {
    const rows = this.db.prepare("SELECT seq,payload FROM execution_events WHERE task_id=? AND json_extract(payload,'$.kind') IN ('agent_delta','agent_message','turn_start','turn_end','turn_status') ORDER BY seq").all(taskId)
      .map(raw => ({ seq: z.object({ seq: z.number() }).parse(raw).seq, payload: z.object({ payload: z.string() }).parse(raw).payload }));
    const transient = this.ephemeralEvents.filter(event => event.taskId === taskId && event.kind !== 'tool_output');
    for (const item of [...rows.map(row => ({ seq: row.seq, payload: row.payload })), ...transient.map(event => ({ seq: event.seq, event }))].sort((a, b) => a.seq - b.seq)) {
      const event = 'event' in item ? item.event : storedExecutionEventSchema.parse({ ...JSON.parse(item.payload), seq: item.seq, taskId });
      if (['agent_delta', 'agent_message', 'turn_start', 'turn_end', 'turn_status'].includes(event.kind)) yield event;
    }
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE meta.value IS NOT excluded.value').run(key, value);
  }
  deleteMeta(key: string): void { this.db.prepare('DELETE FROM meta WHERE key=?').run(key); }
  dataVersion(): number {
    const row = this.db.prepare('PRAGMA data_version').get();
    return z.object({ data_version: z.number() }).parse(row).data_version;
  }
  latestExecutionSequence(): number {
    const persisted = z.object({ seq: z.number() }).parse(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM execution_events').get()).seq;
    return Math.max(persisted, this.logicalSequence, this.ephemeralEvents.at(-1)?.seq ?? 0);
  }
  progressEvents(after: number, limit = 500): StoredExecutionEvent[] {
    const durable = this.db.prepare("SELECT seq,task_id,payload FROM execution_events WHERE seq>? AND COALESCE(json_extract(payload,'$.kind'),'') <> 'tool_output' ORDER BY seq LIMIT ?").all(after, limit).map(raw => {
      const row = z.object({ seq: z.number(), task_id: z.string(), payload: z.string() }).parse(raw);
      return storedExecutionEventSchema.parse({ ...JSON.parse(row.payload), seq: row.seq, taskId: row.task_id });
    });
    return [...durable, ...this.ephemeralEvents.filter(event => event.seq > after)].sort((a, b) => a.seq - b.seq).slice(0, limit);
  }
  recentTurnEvents(taskId: string, turnId: string): StoredExecutionEvent[] {
    return this.eventRows(taskId, 0, executionEventRetentionLimit, false).filter(event => event.turnId === turnId).slice(-200);
  }
  progressRecord(taskId: string, turnId: string): unknown | null {
    const row = this.db.prepare('SELECT payload FROM feishu_progress WHERE task_id=? AND turn_id=?').get(taskId, turnId);
    return row ? JSON.parse(payloadRow.parse(row).payload) : null;
  }
  activeProgressRecords(): unknown[] {
    return this.db.prepare('SELECT payload FROM feishu_progress WHERE active=1 ORDER BY rowid').all().map(row => JSON.parse(payloadRow.parse(row).payload));
  }
  saveProgressRecord(taskId: string, turnId: string, record: unknown, active: boolean): void {
    this.db.prepare('INSERT INTO feishu_progress VALUES(?,?,?,?) ON CONFLICT(task_id,turn_id) DO UPDATE SET payload=excluded.payload,active=excluded.active').run(taskId, turnId, JSON.stringify(record), Number(active));
  }
  close(): void { this.unsubscribeLive?.(); this.unsubscribeLive = null; this.db.close(); this.lock?.close(); }
  documentProgressRecord(taskId: string): unknown | null {
    const row = this.db.prepare('SELECT payload FROM feishu_document_progress WHERE task_id=?').get(taskId);
    return row ? JSON.parse(payloadRow.parse(row).payload) : null;
  }
  documentProgressRecords(): unknown[] {
    return this.db.prepare('SELECT payload FROM feishu_document_progress ORDER BY rowid').all().map(row => JSON.parse(payloadRow.parse(row).payload));
  }
  saveDocumentProgressRecord(taskId: string, record: unknown): void {
    this.db.prepare('INSERT INTO feishu_document_progress VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload').run(taskId, JSON.stringify(record));
  }
}
