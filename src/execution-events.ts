import { z } from 'zod';

export const executionEventSchema = z.object({
  threadId: z.string(), turnId: z.string().nullable(), itemId: z.string().nullable(),
  kind: z.enum(['agent_delta', 'agent_message', 'tool_start', 'tool_output', 'tool_end', 'turn_start', 'turn_end', 'turn_status', 'error']),
  label: z.string(), text: z.string(), createdAt: z.number(),
});
export type ExecutionEvent = z.infer<typeof executionEventSchema>;
export const storedExecutionEventSchema = executionEventSchema.extend({ seq: z.number(), taskId: z.string() });
export type StoredExecutionEvent = z.infer<typeof storedExecutionEventSchema>;

const scopeSchema = z.object({ threadId: z.string(), turnId: z.string() });
const deltaSchema = scopeSchema.extend({ itemId: z.string(), delta: z.string() });
const errorSchema = scopeSchema.extend({ error: z.object({ message: z.string() }), willRetry: z.boolean() });
const turnNotificationSchema = z.object({
  threadId: z.string(), turn: z.object({ id: z.string(), status: z.string(), error: z.object({ message: z.string() }).nullish() }),
});
const itemNotificationSchema = scopeSchema.extend({
  item: z.discriminatedUnion('type', [
    z.object({ type: z.literal('agentMessage'), id: z.string(), text: z.string(), phase: z.string().nullish() }),
    z.object({ type: z.literal('commandExecution'), id: z.string(), command: z.string(), status: z.string(), aggregatedOutput: z.string().nullish(), exitCode: z.number().nullish() }),
    z.object({ type: z.literal('fileChange'), id: z.string(), status: z.string(), changes: z.array(z.object({ path: z.string(), diff: z.string() })).default([]) }),
    z.object({ type: z.literal('mcpToolCall'), id: z.string(), server: z.string(), tool: z.string(), status: z.string(), result: z.unknown().optional(), error: z.unknown().optional() }),
    z.object({ type: z.literal('dynamicToolCall'), id: z.string(), tool: z.string(), status: z.string(), contentItems: z.array(z.unknown()).nullish() }),
    z.object({ type: z.literal('webSearch'), id: z.string(), query: z.string() }),
  ]),
});

export function executionEvent(method: string, params: unknown): ExecutionEvent | null {
  const base = { createdAt: Date.now() };
  if (method === 'item/commandExecution/outputDelta') return null;
  if (method === 'item/agentMessage/delta') {
    const parsed = deltaSchema.safeParse(params);
    if (!parsed.success) return null;
    const { delta, ...scope } = parsed.data;
    return { ...base, ...scope, kind: 'agent_delta', label: 'Agent', text: delta };
  }
  if (method === 'error') {
    const parsed = errorSchema.safeParse(params);
    if (!parsed.success) return null;
    const { threadId, turnId, error, willRetry } = parsed.data;
    return { ...base, threadId, turnId, itemId: null, kind: 'error', label: willRetry ? '执行器正在重试' : '执行错误', text: error.message };
  }
  if (method === 'turn/started' || method === 'turn/completed') {
    const parsed = turnNotificationSchema.safeParse(params);
    if (!parsed.success) return null;
    const { threadId, turn } = parsed.data;
    return { ...base, threadId, turnId: turn.id, itemId: null, kind: method === 'turn/started' ? 'turn_start' : 'turn_end', label: method === 'turn/started' ? '本轮开始' : '本轮结束', text: turn.status + (turn.error ? '\n' + turn.error.message : '') };
  }
  if (method !== 'item/started' && method !== 'item/completed') return null;
  const parsed = itemNotificationSchema.safeParse(params);
  if (!parsed.success) return null;
  const { threadId, turnId, item } = parsed.data;
  const scope = { ...base, threadId, turnId, itemId: item.id };
  if (item.type === 'agentMessage') {
    if (method !== 'item/completed') return null;
    return { ...scope, kind: 'agent_message', label: item.phase === 'final_answer' ? '最终回答' : 'Agent', text: item.text };
  }
  const kind = method === 'item/started' ? 'tool_start' : 'tool_end';
  switch (item.type) {
    case 'commandExecution': return { ...scope, kind, label: '命令 · ' + item.status + (item.exitCode == null ? '' : ' · exit ' + item.exitCode), text: '$ ' + item.command };
    case 'fileChange': return { ...scope, kind, label: '文件变更 · ' + item.status, text: item.changes.map(change => change.path).join('\n') };
    case 'mcpToolCall': return { ...scope, kind, label: item.server + '/' + item.tool + ' · ' + item.status, text: '' };
    case 'dynamicToolCall': return { ...scope, kind, label: item.tool + ' · ' + item.status, text: '' };
    case 'webSearch': return { ...scope, kind, label: '搜索', text: item.query };
  }
}
