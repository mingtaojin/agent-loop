import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { approvalActionSchema, feishuCardRecordSchema, inputProvenanceSchema, incomingSchema, repositorySchema, sourceSchema, taskSchema, type ApprovalAction, type FeishuCardRecord, type IncomingMessage, type InputProvenance, type Source, type Task } from './domain.js';

const payloadRow = z.object({ payload: z.string() });
const taskPayloadRow = payloadRow.extend({ id: z.string() });
const taskIdRow = z.object({ task_id: z.string() });
const metaRow = z.object({ value: z.string() });
const dataVersionRow = z.object({ data_version: z.number() });
const nameRow = z.object({ name: z.string() });
const sourceRow = payloadRow.extend({ reason: z.string() });
const sequenceRow = z.object({ seq: z.number() });
const countRow = z.object({ count: z.number() });
const approvalRow = z.object({ id: z.string(), payload: z.string(), status: z.string(), error: z.string().nullable() });
const diagnosticRow = z.object({ created_at: z.number(), scope: z.string(), message: z.string() });
const inputPayloadSchema = z.object({ message: incomingSchema, provenance: inputProvenanceSchema, requestId: z.string().nullable().default(null) });
const legacyTaskSchema = z.object({
  id: z.string(), sourceId: z.string(), source: sourceSchema, repository: repositorySchema,
  workspace: z.string().nullable(), branch: z.string(), status: z.string(), prUrl: z.string().nullable().default(null),
}).passthrough();
const operationSchema = z.object({ id: z.string(), task_id: z.string(), kind: z.string(), status: z.enum(['attempting', 'confirmed', 'uncertain']), result: z.string().nullable(), error: z.string().nullable() });
export type Operation = z.infer<typeof operationSchema>;
const inboxRow = z.object({ seq: z.number(), id: z.string(), task_id: z.string(), payload: z.string(), status: z.enum(['pending', 'delivering', 'delivered', 'failed', 'uncertain', 'held', 'dropped']), origin: z.enum(['user', 'source', 'initial', 'resume']), error: z.string().nullable() });
export type Inbox = Omit<z.infer<typeof inboxRow>, 'payload'> & { message: IncomingMessage; provenance: InputProvenance; requestId: string | null };
export type InboxFilter = { statuses?: readonly Inbox['status'][]; origin?: Inbox['origin'] };
const outboxSchema = z.object({ id: z.string(), task_id: z.string(), text: z.string(), status: z.enum(['pending', 'sending', 'sent', 'uncertain', 'dropped']), error: z.string().nullable() });
export type Outbox = z.infer<typeof outboxSchema>;

export const diagnosticRetentionLimit = 1_000;
const diagnosticReadLimit = 100;
const diagnosticMessageLimit = 8_192;

export class Store {
  private readonly db: DatabaseSync;
  private readonly lock: DatabaseSync | null;
  private readonly statements = new Map<string, StatementSync>();
  private readonly taskSnapshots = new Map<string, { payload: string; task: Task }>();
  private readonly documentPayloads = new Map<string, string | null>();
  private lastDocumentDataVersion: number | null = null;
  private readonly metaRevisions = new Map<string, symbol>();
  private readonly taskThreads = new Map<string, string | null>();
  private readonly taskIdsByThread = new Map<string, string>();
  private lastMetaDataVersion: number | null = null;
  constructor(private readonly dataDir: string, options: { readOnly?: boolean } = {}) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.lock = options.readOnly ? null : new DatabaseSync(join(dataDir, 'owner.sqlite'));
    try { this.lock?.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
    catch { this.lock?.close(); throw new Error('已有 Agent Loop 进程使用此数据目录'); }
    try {
      this.db = new DatabaseSync(join(dataDir, 'tasks.sqlite'), { readOnly: options.readOnly ?? false });
      if (options.readOnly) return;
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,payload TEXT NOT NULL,reason TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS source_revisions(source_id TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(source_id,hash));
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,source_id TEXT NOT NULL UNIQUE,chat_id TEXT UNIQUE,thread_id TEXT UNIQUE,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),payload TEXT NOT NULL,status TEXT NOT NULL,origin TEXT NOT NULL DEFAULT 'user',error TEXT);
        CREATE INDEX IF NOT EXISTS inbox_task ON inbox(task_id,seq);
        CREATE INDEX IF NOT EXISTS inbox_task_status ON inbox(task_id,status,seq);
        CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),text TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
        CREATE INDEX IF NOT EXISTS outbox_task_status ON outbox(task_id,status);
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT);
        CREATE TABLE IF NOT EXISTS approval_actions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),payload TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
        CREATE INDEX IF NOT EXISTS approval_actions_task ON approval_actions(task_id);
        CREATE TABLE IF NOT EXISTS feishu_cards(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS feishu_cards_request ON feishu_cards(request_id);
        CREATE TABLE IF NOT EXISTS diagnostics(id INTEGER PRIMARY KEY,created_at INTEGER NOT NULL,scope TEXT NOT NULL,message TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS diagnostic_rollups(scope TEXT NOT NULL,fingerprint TEXT NOT NULL,first_created_at INTEGER NOT NULL,last_created_at INTEGER NOT NULL,count INTEGER NOT NULL,message TEXT NOT NULL,PRIMARY KEY(scope,fingerprint));
        CREATE INDEX IF NOT EXISTS diagnostic_rollups_recent ON diagnostic_rollups(last_created_at DESC);
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS feishu_progress(task_id TEXT NOT NULL REFERENCES tasks(id),turn_id TEXT NOT NULL,payload TEXT NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(task_id,turn_id));
        CREATE INDEX IF NOT EXISTS feishu_progress_active ON feishu_progress(active);
        CREATE TABLE IF NOT EXISTS feishu_document_progress(task_id TEXT PRIMARY KEY REFERENCES tasks(id),payload TEXT NOT NULL);
        `);
      const columns = this.prepare('PRAGMA table_info(inbox)').all().map(row => nameRow.parse(row).name);
      if (!columns.includes('origin')) this.db.exec("ALTER TABLE inbox ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'");
      this.transaction(() => {
        for (const raw of this.prepare('SELECT payload FROM tasks').all()) {
          const task = this.normalizeTask(JSON.parse(payloadRow.parse(raw).payload));
          this.saveTask(task);
        }
        this.db.exec('PRAGMA user_version=2');
      });
    } catch (error) { this.lock?.close(); throw error; }
  }
  private prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const statement = this.db.prepare(sql);
    if (this.statements.size >= 128) this.statements.clear();
    this.statements.set(sql, statement);
    return statement;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) {
      try { this.db.exec('ROLLBACK'); }
      finally {
        this.metaRevisions.clear();
        this.documentPayloads.clear();
        this.taskThreads.clear(); this.taskIdsByThread.clear();
        for (const row of this.prepare('SELECT id,thread_id FROM tasks WHERE thread_id IS NOT NULL').all() as { id?: unknown; thread_id?: unknown }[]) {
          if (typeof row.id === 'string' && typeof row.thread_id === 'string') {
            this.taskThreads.set(row.id, row.thread_id); this.taskIdsByThread.set(row.thread_id, row.id);
          }
        }
      }
      throw error;
    }
  }
  saveSource(source: Source, reason: string): void {
    const payload = JSON.stringify(source);
    this.prepare('INSERT INTO sources VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,reason=excluded.reason').run(source.id, payload, reason);
    this.prepare('INSERT OR IGNORE INTO source_revisions VALUES(?,?,?)').run(source.id, createHash('sha256').update(payload).digest('hex'), payload);
  }
  sources(): { source: Source; reason: string }[] {
    return this.prepare('SELECT payload,reason FROM sources').all().map(row => { const parsed = sourceRow.parse(row); return { source: sourceSchema.parse(JSON.parse(parsed.payload)), reason: parsed.reason }; });
  }
  saveTask(task: Task): void {
    const previousThread = this.taskThreads.get(task.id);
    this.prepare('INSERT INTO tasks VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id,thread_id=excluded.thread_id,payload=excluded.payload').run(task.id, task.sourceId, task.chatId, task.threadId, JSON.stringify(task));
    if (previousThread && previousThread !== task.threadId) this.taskIdsByThread.delete(previousThread);
    this.taskThreads.set(task.id, task.threadId);
    if (task.threadId) this.taskIdsByThread.set(task.threadId, task.id);
  }
  tasks(): Task[] {
    const rows = this.prepare('SELECT id,payload FROM tasks ORDER BY rowid').all().map(row => taskPayloadRow.parse(row));
    const ids = new Set(rows.map(row => row.id));
    for (const id of this.taskSnapshots.keys()) if (!ids.has(id)) this.taskSnapshots.delete(id);
    return rows.map(row => this.taskSnapshot(row));
  }
  task(id: string): Task { const row = this.prepare('SELECT id,payload FROM tasks WHERE id=?').get(id); if (!row) throw new Error(`Unknown task ${id}`); return this.taskSnapshot(taskPayloadRow.parse(row)); }
  taskForSource(id: string): Task | null { return this.findTask('source_id', id); }
  taskForChat(id: string): Task | null { return this.findTask('chat_id', id); }
  taskForThread(id: string): Task | null { return this.findTask('thread_id', id); }
  taskIdForThread(id: string): string | null { return this.taskIdsByThread.get(id) ?? null; }
  private findTask(column: 'source_id' | 'chat_id' | 'thread_id', id: string): Task | null {
    const row = this.prepare(`SELECT id,payload FROM tasks WHERE ${column}=?`).get(id);
    return row ? this.taskSnapshot(taskPayloadRow.parse(row)) : null;
  }
  private taskSnapshot(row: z.infer<typeof taskPayloadRow>): Task {
    let cached = this.taskSnapshots.get(row.id);
    if (cached?.payload !== row.payload) {
      const task = this.normalizeTask(JSON.parse(row.payload));
      cached = { payload: row.payload, task };
      if (this.taskSnapshots.size >= 256) this.taskSnapshots.clear();
      this.taskSnapshots.set(row.id, cached);
    }
    return structuredClone(cached.task);
  }
  private normalizeTask(raw: unknown): Task {
    const current = taskSchema.safeParse(raw);
    if (current.success) return current.data;
    const legacy = legacyTaskSchema.parse(raw);
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
    return this.prepare("INSERT OR IGNORE INTO inbox(id,task_id,payload,status,origin) VALUES(?,?,?,'pending',?)").run(message.id, taskId, JSON.stringify({ message, provenance: facts, requestId: null }), origin).changes > 0;
  }
  inputs(taskId: string, filter: InboxFilter = {}): Inbox[] {
    const clauses = ['task_id=?'];
    const params: (string | number)[] = [taskId];
    if (filter.statuses) {
      if (!filter.statuses.length) return [];
      clauses.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      params.push(...filter.statuses);
    }
    if (filter.origin) { clauses.push('origin=?'); params.push(filter.origin); }
    return this.prepare(`SELECT * FROM inbox WHERE ${clauses.join(' AND ')} ORDER BY seq`).all(...params).map(raw => {
      const { payload, ...row } = inboxRow.parse(raw);
      const json: unknown = JSON.parse(payload);
      const wrapped = inputPayloadSchema.safeParse(json);
      if (wrapped.success) return { ...row, ...wrapped.data };
      const message = incomingSchema.parse(json);
      const task = this.task(taskId);
      const provenance: InputProvenance = row.origin === 'user' ? { kind: 'user', message }
        : row.origin === 'source' ? { kind: 'github_issue', sourceId: task.sourceId, revision: message.id, url: task.source.kind === 'github' ? task.source.issue.url : '' }
        : row.origin === 'initial' ? { kind: 'initial', sourceId: task.sourceId } : { kind: 'recovery', previousTurnId: task.turnId ?? 'legacy' };
      return { ...row, message, provenance, requestId: null };
    });
  }
  hasInputs(taskId: string, filter: InboxFilter): boolean {
    const clauses = ['task_id=?'];
    const params: (string | number)[] = [taskId];
    if (filter.statuses) {
      if (!filter.statuses.length) return false;
      clauses.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      params.push(...filter.statuses);
    }
    if (filter.origin) { clauses.push('origin=?'); params.push(filter.origin); }
    return this.prepare(`SELECT 1 FROM inbox WHERE ${clauses.join(' AND ')} LIMIT 1`).get(...params) !== undefined;
  }
  input(taskId: string, id: string): Inbox | null { return this.inputs(taskId).find(item => item.id === id) ?? null; }
  associateRequest(id: string, taskId: string, requestId: string): void {
    const input = this.inputs(taskId).find(item => item.id === id);
    if (!input) throw new Error('Unknown inbox input');
    this.prepare('UPDATE inbox SET payload=? WHERE id=?').run(JSON.stringify({ message: input.message, provenance: input.provenance, requestId }), id);
  }
  markInput(id: string, status: Inbox['status'], error: string | null = null): void { this.prepare('UPDATE inbox SET status=?,error=? WHERE id=?').run(status, error, id); }
  enqueue(taskId: string, text: string, key: string): string {
    const id = createHash('sha256').update(`${taskId}:${key}`).digest('hex').slice(0, 32);
    this.prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,'pending',NULL)").run(id, taskId, text);
    return id;
  }
  hasOutput(taskId: string, key: string): boolean {
    const id = createHash('sha256').update(`${taskId}:${key}`).digest('hex').slice(0, 32);
    return this.prepare('SELECT id FROM outbox WHERE id=?').get(id) !== undefined;
  }
  outputs(taskId: string, statuses?: readonly Outbox['status'][]): Outbox[] {
    if (statuses?.length === 0) return [];
    const condition = statuses ? ` AND status IN (${statuses.map(() => '?').join(',')})` : '';
    return this.prepare(`SELECT * FROM outbox WHERE task_id=?${condition} ORDER BY rowid`).all(taskId, ...(statuses ?? [])).map(row => outboxSchema.parse(row));
  }
  hasOutputs(taskId: string, statuses: readonly Outbox['status'][]): boolean {
    if (!statuses.length) return false;
    return this.prepare(`SELECT 1 FROM outbox WHERE task_id=? AND status IN (${statuses.map(() => '?').join(',')}) LIMIT 1`).get(taskId, ...statuses) !== undefined;
  }
  markOutput(id: string, status: Outbox['status'], error: string | null = null): void { this.prepare('UPDATE outbox SET status=?,error=? WHERE id=?').run(status, error, id); }
  operation(id: string): Operation | null { const row = this.prepare('SELECT * FROM operations WHERE id=?').get(id); return row ? operationSchema.parse(row) : null; }
  beginOperation(id: string, taskId: string, kind: string): void { this.prepare("INSERT INTO operations VALUES(?,?,?,'attempting',NULL,NULL)").run(id, taskId, kind); }
  retryRejectedOperation(id: string): void {
    const result = this.prepare("UPDATE operations SET status='attempting',result=NULL,error=NULL WHERE id=? AND status='uncertain' AND error='rejected'").run(id);
    if (result.changes !== 1) throw new Error('Operation is not a rejected attempt');
  }
  finishOperation(id: string, result: string): void { this.prepare("UPDATE operations SET status='confirmed',result=?,error=NULL WHERE id=?").run(result, id); }
  uncertainOperation(id: string, error: string): void { this.prepare("UPDATE operations SET status='uncertain',error=? WHERE id=?").run(error, id); }
  queueApproval(action: ApprovalAction): boolean {
    const id = this.approvalKey(action);
    return this.prepare("INSERT OR IGNORE INTO approval_actions VALUES(?,?,?,'pending',NULL)").run(id, action.taskId, JSON.stringify(action)).changes > 0;
  }
  approvalKey(action: ApprovalAction): string { return `approval:${action.taskId}:${action.epoch}:${action.requestId}`; }
  approvals(taskId: string): { id: string; action: ApprovalAction; status: string; error: string | null }[] {
    return this.prepare('SELECT id,payload,status,error FROM approval_actions WHERE task_id=? ORDER BY rowid').all(taskId).map(raw => {
      const row = approvalRow.parse(raw);
      return { id: row.id, action: approvalActionSchema.parse(JSON.parse(row.payload)), status: row.status, error: row.error };
    });
  }
  markApproval(id: string, status: 'processing' | 'confirmed' | 'uncertain' | 'rejected', error: string | null = null): void {
    this.prepare('UPDATE approval_actions SET status=?,error=? WHERE id=?').run(status, error, id);
  }
  saveFeishuCard(record: FeishuCardRecord): void {
    const card = feishuCardRecordSchema.parse(record);
    this.prepare('INSERT INTO feishu_cards(id,request_id,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET request_id=excluded.request_id,payload=excluded.payload')
      .run(card.id, card.requestId, JSON.stringify(card));
  }
  feishuCard(id: string): FeishuCardRecord | null {
    const row = this.prepare('SELECT payload FROM feishu_cards WHERE id=?').get(id);
    return row ? feishuCardRecordSchema.parse(JSON.parse(payloadRow.parse(row).payload)) : null;
  }
  feishuCardForRequest(requestId: string): FeishuCardRecord | null {
    const rows = this.prepare('SELECT payload FROM feishu_cards WHERE request_id=? ORDER BY rowid DESC LIMIT 1').all(requestId);
    return rows.length ? feishuCardRecordSchema.parse(JSON.parse(payloadRow.parse(rows[0]).payload)) : null;
  }
  feishuCards(): FeishuCardRecord[] {
    return this.prepare('SELECT payload FROM feishu_cards ORDER BY rowid').all().map(row => feishuCardRecordSchema.parse(JSON.parse(payloadRow.parse(row).payload)));
  }
  updateFeishuCard(id: string, patch: Partial<FeishuCardRecord>): FeishuCardRecord {
    const current = this.feishuCard(id);
    if (!current) throw new Error('Unknown Feishu card');
    const next = feishuCardRecordSchema.parse({ ...current, ...patch, id: current.id, updatedAt: Date.now() });
    if (next.sequence < current.sequence) throw new Error('Feishu CardKit update sequence is out of order');
    const terminal = new Set(['confirmed', 'rejected', 'expired', 'failed', 'closed', 'uncertain']);
    if (terminal.has(current.status) && next.status !== current.status) throw new Error('Feishu card cannot leave its terminal state');
    this.saveFeishuCard(next);
    return next;
  }
  diagnostic(scope: string, message: string): void {
    const createdAt = Date.now();
    const bounded = message.length <= diagnosticMessageLimit ? message : message.slice(0, diagnosticMessageLimit) + '\n…';
    const fingerprint = createHash('sha256').update(`${scope}\u0000${bounded}`).digest('hex');
    this.prepare(`INSERT INTO diagnostic_rollups(scope,fingerprint,first_created_at,last_created_at,count,message)
      VALUES(?,?,?,?,1,?) ON CONFLICT(scope,fingerprint) DO UPDATE SET last_created_at=excluded.last_created_at,count=diagnostic_rollups.count+1,message=excluded.message`)
      .run(scope, fingerprint, createdAt, createdAt, bounded);
    this.prepare(`DELETE FROM diagnostic_rollups WHERE rowid NOT IN (SELECT rowid FROM diagnostic_rollups ORDER BY last_created_at DESC LIMIT ?)`)
      .run(diagnosticRetentionLimit);
  }
  diagnostics(): { created_at: number; scope: string; message: string }[] {
    const legacy = this.prepare('SELECT created_at,scope,message FROM diagnostics ORDER BY id DESC LIMIT ?').all(diagnosticReadLimit).map(row => diagnosticRow.parse(row));
    const hasRollups = this.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='diagnostic_rollups'").get();
    const rollups = hasRollups ? this.prepare('SELECT last_created_at AS created_at,scope,message FROM diagnostic_rollups ORDER BY last_created_at DESC LIMIT ?').all(diagnosticReadLimit).map(row => diagnosticRow.parse(row)) : [];
    const seen = new Set<string>();
    return [...legacy, ...rollups].sort((a, b) => b.created_at - a.created_at).filter(row => {
      const identity = `${row.scope}\u0000${row.message}`;
      if (seen.has(identity)) return false;
      seen.add(identity); return true;
    }).slice(0, diagnosticReadLimit);
  }
  meta(key: string): string | null { const row = this.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? metaRow.parse(row).value : null; }
  metaRevision(key: string): symbol {
    const dataVersion = this.dataVersion();
    if (dataVersion !== this.lastMetaDataVersion) {
      this.metaRevisions.clear();
      this.lastMetaDataVersion = dataVersion;
    }
    const cached = this.metaRevisions.get(key);
    if (cached !== undefined) return cached;
    if (this.metaRevisions.size >= 256) this.metaRevisions.clear();
    const revision = Symbol();
    this.metaRevisions.set(key, revision);
    return revision;
  }
  inputSequence(taskId: string): number {
    return sequenceRow.parse(this.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM inbox WHERE task_id=?').get(taskId)).seq;
  }
  setMeta(key: string, value: string): void {
    const result = this.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE meta.value IS NOT excluded.value').run(key, value);
    if (result.changes > 0) this.metaRevisions.delete(key);
  }
  deleteMeta(key: string): void {
    const result = this.prepare('DELETE FROM meta WHERE key=?').run(key);
    if (result.changes > 0) this.metaRevisions.delete(key);
  }
  dataVersion(): number {
    const row = this.prepare('PRAGMA data_version').get();
    return dataVersionRow.parse(row).data_version;
  }
  progressRecord(taskId: string, turnId: string): unknown | null {
    const row = this.prepare('SELECT payload FROM feishu_progress WHERE task_id=? AND turn_id=?').get(taskId, turnId);
    return row ? JSON.parse(payloadRow.parse(row).payload) : null;
  }
  activeProgressRecords(): unknown[] {
    return this.prepare('SELECT payload FROM feishu_progress WHERE active=1 ORDER BY rowid').all().map(row => JSON.parse(payloadRow.parse(row).payload));
  }
  saveProgressRecord(taskId: string, turnId: string, record: unknown, active: boolean): void {
    this.prepare('INSERT INTO feishu_progress VALUES(?,?,?,?) ON CONFLICT(task_id,turn_id) DO UPDATE SET payload=excluded.payload,active=excluded.active').run(taskId, turnId, JSON.stringify(record), Number(active));
  }
  close(): void {
    this.db.close(); this.lock?.close();
    this.statements.clear(); this.taskSnapshots.clear(); this.documentPayloads.clear();
  }
  documentProgressPayload(taskId: string): string | null {
    const dataVersion = this.dataVersion();
    if (dataVersion !== this.lastDocumentDataVersion) {
      this.documentPayloads.clear();
      this.lastDocumentDataVersion = dataVersion;
    }
    const cached = this.documentPayloads.get(taskId);
    if (cached !== undefined) return cached;
    const row = this.prepare('SELECT payload FROM feishu_document_progress WHERE task_id=?').get(taskId);
    const payload = row ? payloadRow.parse(row).payload : null;
    if (this.documentPayloads.size >= 256) this.documentPayloads.clear();
    this.documentPayloads.set(taskId, payload);
    return payload;
  }
  documentProgressTaskIds(): string[] {
    return this.prepare('SELECT task_id FROM feishu_document_progress ORDER BY rowid').all().map(row => taskIdRow.parse(row).task_id);
  }
  documentProgressRecord(taskId: string): unknown | null {
    const payload = this.documentProgressPayload(taskId);
    return payload === null ? null : JSON.parse(payload);
  }
  documentProgressRecords(): unknown[] {
    return this.prepare('SELECT payload FROM feishu_document_progress ORDER BY rowid').all().map(row => JSON.parse(payloadRow.parse(row).payload));
  }
  saveDocumentProgressRecord(taskId: string, record: unknown): void {
    this.prepare('INSERT INTO feishu_document_progress VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload').run(taskId, JSON.stringify(record));
    this.documentPayloads.delete(taskId);
  }
}
