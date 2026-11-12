import { z } from 'zod';
import type { Task } from './domain.js';
import type { StoredExecutionEvent } from './execution-events.js';
import { finished, progressStatusSchema, taskProgressStatus, type ProgressStatus } from './feishu-progress-view.js';
import type { Inbox } from './store.js';
import { formatFeishuTime } from './feishu-time.js';

export const conversationMessageSchema = z.strictObject({
  key: z.string(), role: z.enum(['user', 'assistant', 'cli']), text: z.string(),
  createdAt: z.number(), sequence: z.number(), completed: z.boolean(),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export const documentConversationSchema = z.strictObject({
  status: progressStatusSchema, cursor: z.number().int().nonnegative(),
  lastExecutionEventAt: z.number().nullable(), messages: z.array(conversationMessageSchema),
});
export type DocumentConversation = z.infer<typeof documentConversationSchema>;
const normalize = (text: string) => text.replace(/\r\n?/g, '\n');

export function projectDocumentConversation(task: Task, inputs: Inbox[], events: Iterable<StoredExecutionEvent>): DocumentConversation {
  const messages = new Map<string, ConversationMessage>();
  const addUser = (message: Inbox['message'], sequence: number) => {
    const key = JSON.stringify(['user', message.id]);
    if (messages.has(key)) return;
    const text = normalize([message.text, ...message.attachments.map(attachment => `附件：${attachment.name}`)].filter(Boolean).join('\n'));
    if (text) messages.set(key, { key, role: 'user', text, createdAt: message.createdAt, sequence, completed: true });
  };
  if (task.source.kind === 'manual') addUser(task.source.message, 0);
  for (const input of inputs) if (input.origin === 'user') {
    addUser(input.provenance.kind === 'user' ? input.provenance.message : input.message, input.seq);
  }
  for (const input of inputs) if (input.provenance.kind === 'cli') {
    const key = JSON.stringify(['cli', input.id]);
    messages.set(key, { key, role: 'cli', text: normalize(input.message.text), createdAt: input.message.createdAt, sequence: input.seq, completed: true });
  }
  let status = taskProgressStatus(task), cursor = 0, lastExecutionEventAt: number | null = null;
  for (const event of events) {
    cursor = Math.max(cursor, event.seq);
    if (event.kind === 'agent_delta' || event.kind === 'agent_message') {
      const key = JSON.stringify(['assistant', event.threadId, event.turnId, event.itemId ?? event.seq]);
      let message = messages.get(key);
      if (!message) {
        message = { key, role: 'assistant', text: '', createdAt: event.createdAt, sequence: event.seq, completed: false };
        messages.set(key, message);
      }
      if (event.kind === 'agent_message') { message.text = event.text; message.completed = true; }
      else if (!message.completed) message.text += event.text;
      lastExecutionEventAt = Math.max(lastExecutionEventAt ?? event.createdAt, event.createdAt);
    }
    if (event.threadId !== task.threadId || event.turnId !== task.turnId) continue;
    if (event.kind === 'turn_start') status = 'running';
    if (event.kind === 'turn_end') {
      const terminal = event.text.split('\n')[0];
      if (terminal === 'completed') status = 'completed';
      if (terminal === 'failed') status = 'failed';
      if (terminal === 'interrupted') status = 'paused';
    }
    if (event.kind === 'turn_status') {
      const parsed = progressStatusSchema.safeParse(event.text);
      if (parsed.success && (!finished(status) || parsed.data !== 'running')) status = parsed.data;
    }
  }
  const snapshotStatus = taskProgressStatus(task);
  if (!finished(status) || snapshotStatus !== 'running') status = snapshotStatus;
  return documentConversationSchema.parse({ status, cursor, lastExecutionEventAt,
    messages: [...messages.values()].map(message => ({ ...message, text: normalize(message.text) }))
      .sort((a, b) => a.createdAt - b.createdAt || (a.role === b.role ? a.sequence - b.sequence : a.role === 'assistant' ? 1 : -1)) });
}

const labels: Record<ProgressStatus, string> = { running: '执行中', waiting_input: '等待输入', waiting_approval: '等待审批', completed: '已完成', failed: '失败', paused: '已暂停' };
export function documentConversationText(view: DocumentConversation, maxLines: number): string {
  const header = [`状态：${labels[view.status]}`, '',
    `最近对话事件：${view.lastExecutionEventAt === null ? '尚无事件' : formatFeishuTime(view.lastExecutionEventAt)}`];
  const messages = view.messages.filter(message => message.text).toReversed().map(message => ['',
    `${message.role === 'cli' ? 'CLI 提交' : message.role === 'user' ? '用户' : '助手'} · ${formatFeishuTime(message.createdAt)}`, ...message.text.split('\n')]);
  const lines = [...header, ...messages.flat()];
  if (lines.length <= maxLines) return lines.join('\n');
  const marker = '[仅展示最近对话，较早内容已省略]';
  if (maxLines < 5) return [header[0], marker, ...(messages[0]?.slice(2) ?? []).slice(-Math.max(1, maxLines - 2))].slice(-maxLines).join('\n');
  const retained = [...header];
  let remaining = maxLines - header.length - 1;
  for (const message of messages) {
    if (remaining < 3) break;
    if (message.length > remaining) {
      retained.push(...message.slice(0, 2), ...message.slice(2).slice(-(remaining - 2)));
      break;
    }
    retained.push(...message);
    remaining -= message.length;
  }
  return [...retained, marker].join('\n');
}
