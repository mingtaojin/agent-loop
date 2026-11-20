import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Task } from './domain.js';
import type { VisibleExecution } from './execution-events.js';
import { formatFeishuTime } from './feishu-time.js';

export const progressStatusSchema = z.enum(['running', 'waiting_input', 'waiting_approval', 'completed', 'failed', 'paused']);
export type ProgressStatus = z.infer<typeof progressStatusSchema>;
export const progressViewSchema = z.object({
  status: progressStatusSchema,
  lastExecutionEventAt: z.number().nullable(),
  cursor: z.number().int().nonnegative(),
  assistant: z.array(z.object({ id: z.string().nullable(), text: z.string() })).max(3),
  tool: z.object({ id: z.string().nullable(), label: z.string(), text: z.string() }).nullable(),
  notice: z.string().nullable().default(null),
});
export type ProgressView = z.infer<typeof progressViewSchema>;
export function taskProgressStatus(task: Task): ProgressStatus {
  if (task.status === 'paused') return 'paused';
  if (task.status === 'failed' || task.executionStatus === 'failed') return 'failed';
  const requests = task.requests.filter(request => request.turnId === task.turnId);
  if (requests.some(request => request.kind === 'approval' || request.kind === 'permissions')) return 'waiting_approval';
  if (requests.some(request => request.kind === 'question')) return 'waiting_input';
  if (task.executionStatus === 'interrupted') return 'paused';
  if (task.executionStatus === 'completed' || task.executionStatus === 'idle') return 'completed';
  return 'running';
}
export function finished(status: ProgressStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'paused';
}
export function boundedText(text: string, bytes: number): string {
  if (Buffer.byteLength(JSON.stringify(text)) <= bytes) return text;
  const marker = '[较早输出已截断]\n';
  let low = 0, high = Math.min(text.length, bytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(marker + text.slice(-mid))) <= bytes) low = mid;
    else high = mid - 1;
  }
  const tail = text.slice(-low).replace(/^[\uDC00-\uDFFF]/, '');
  return marker + tail;
}
export function projectProgress(view: ProgressView, event: VisibleExecution): void {
  if (event.seq <= view.cursor) return;
  view.cursor = event.seq;
  if (event.kind !== 'turn_status' && event.createdAt !== null) view.lastExecutionEventAt = Math.max(view.lastExecutionEventAt ?? 0, event.createdAt);
  switch (event.kind) {
    case 'agent_start': case 'agent_delta': case 'agent_message': {
      view.notice = null;
      let item = view.assistant.find(item => item.id === event.itemId);
      if (!item) { item = { id: event.itemId, text: '' }; view.assistant.push(item); }
      item.text = boundedText(event.text, 2000);
      view.assistant = view.assistant.slice(-3);
      break;
    }
    case 'tool_start': case 'tool_output': case 'tool_end': {
      view.notice = null;
      const previous = view.tool;
      view.tool = { id: event.itemId, label: boundedText(event.kind === 'tool_output' && previous?.id === event.itemId ? previous.label : event.label, 600),
        text: boundedText(event.kind === 'tool_output' && previous?.id === event.itemId ? previous.text + event.text : event.text, 8000) };
      break;
    }
    case 'turn_start': view.status = 'running'; view.notice = null; break;
    case 'turn_end': {
      const status = event.text.split('\n')[0];
      if (status === 'completed') view.status = 'completed';
      else if (status === 'failed') view.status = 'failed';
      else if (status === 'interrupted') view.status = 'paused';
      break;
    }
    case 'turn_status': {
      const parsed = progressStatusSchema.safeParse(event.text);
      if (parsed.success && (!finished(view.status) || parsed.data !== 'running')) view.status = parsed.data;
      break;
    }
    case 'error': view.notice = boundedText(`${event.label}\n${event.text}`, 1500); break;
    default: { const exhaustive: never = event.kind; return exhaustive; }
  }
}
const labels: Record<ProgressStatus, string> = { running: '执行中', waiting_input: '等待输入', waiting_approval: '等待审批', completed: '已完成', failed: '失败', paused: '已暂停' };
export function progressContent(view: ProgressView): string {
  return [`状态：${labels[view.status]}`, `最近执行事件：${view.lastExecutionEventAt === null ? '尚无事件' : formatFeishuTime(view.lastExecutionEventAt)}`,
    ...(view.notice ? [`执行提示：${view.notice}`] : []),
    ...view.assistant.map(item => item.text),
    ...(view.tool ? [`工具：${view.tool.label}`, view.tool.text] : [])].filter(Boolean).join('\n\n');
}


export const sourceFrontierSchema = z.record(z.string(), z.object({
  complete: z.boolean(), length: z.number().int().nonnegative(), digest: z.string(), createdAt: z.number().nullable(),
}));
export type SourceFrontier = z.infer<typeof sourceFrontierSchema>;
const sourceDigest = (text: string) => createHash('sha256').update(text).digest('hex');
export function sourceFrontier(entries: VisibleExecution[]): SourceFrontier {
  return Object.fromEntries(entries.filter(event => !['error', 'turn_status', 'agent_start', 'tool_output'].includes(event.kind)).map(event => [event.key, {
    complete: event.kind === 'agent_message' || event.kind === 'tool_end' || event.kind === 'turn_end',
    length: event.text.length, digest: sourceDigest(event.text), createdAt: event.createdAt,
  }]));
}
export function coversSource(entries: VisibleExecution[], frontier: SourceFrontier): boolean {
  const current = new Map(entries.map(event => [event.key, event]));
  return Object.entries(frontier).every(([key, previous]) => {
    const event = current.get(key);
    if (!event) return false;
    const complete = event.kind === 'agent_message' || event.kind === 'tool_end' || event.kind === 'turn_end';
    if (previous.complete && !complete) return false;
    if (sourceDigest(event.text) === previous.digest) return true;
    if (event.kind === 'agent_start' || event.kind === 'agent_delta') {
      return event.text.length >= previous.length && sourceDigest(event.text.slice(0, previous.length)) === previous.digest;
    }
    if (event.createdAt !== null && previous.createdAt !== null && event.createdAt > previous.createdAt) return true;
    return !previous.complete && (complete || (event.text.length >= previous.length && sourceDigest(event.text.slice(0, previous.length)) === previous.digest));
  });
}

export class HistoryRetries {
  private readonly tasks = new Map<string, { signature: string; failures: number; nextAttemptAt: number }>();
  ready(taskId: string, signature: string, now: number): boolean {
    const retry = this.tasks.get(taskId);
    return !retry || retry.signature !== signature || retry.nextAttemptAt <= now;
  }
  failed(taskId: string, signature: string, now: number): void {
    const previous = this.tasks.get(taskId);
    const failures = previous?.signature === signature ? previous.failures + 1 : 1;
    this.tasks.set(taskId, { signature, failures, nextAttemptAt: now + Math.min(60_000, 3000 * 2 ** Math.min(failures - 1, 5)) });
  }
  succeeded(taskId: string): void { this.tasks.delete(taskId); }
}
