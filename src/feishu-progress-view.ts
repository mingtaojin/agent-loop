import { z } from 'zod';
import type { Task } from './domain.js';
import type { StoredExecutionEvent } from './execution-events.js';
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
export function projectProgress(view: ProgressView, event: StoredExecutionEvent): void {
  if (event.seq <= view.cursor) return;
  view.cursor = event.seq;
  if (event.kind !== 'turn_status') view.lastExecutionEventAt = Math.max(view.lastExecutionEventAt ?? 0, event.createdAt);
  switch (event.kind) {
    case 'agent_delta': case 'agent_message': {
      view.notice = null;
      let item = view.assistant.find(item => item.id === event.itemId);
      if (!item) { item = { id: event.itemId, text: '' }; view.assistant.push(item); }
      item.text = boundedText(event.kind === 'agent_message' ? event.text : item.text + event.text, 2000);
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
