import { z } from 'zod';
import { errorMessage, presentTaskSource, type Task } from './domain.js';
import { GroupCreationRejected, TaskGroupBindingChanged, TaskGroupUnavailable, type FeishuPort } from './ports.js';
import type { Store } from './store.js';
import { ProjectLedger } from './project.js';

const groupStateSchema = z.strictObject({ generation: z.number().int().nonnegative(), retiredChatIds: z.array(z.string()) });
const stateKey = (taskId: string) => `task-group:${taskId}`;
function state(store: Store, taskId: string): z.infer<typeof groupStateSchema> {
  const raw = store.meta(stateKey(taskId));
  return raw === null ? { generation: 0, retiredChatIds: [] } : groupStateSchema.parse(JSON.parse(raw));
}
export function groupGeneration(store: Store, taskId: string): number { return state(store, taskId).generation; }
export function assertGroupBinding(store: Store, taskId: string, chatId: string | null, generation?: number): void {
  if (store.task(taskId).chatId !== chatId || (generation !== undefined && groupGeneration(store, taskId) !== generation))
    throw new TaskGroupBindingChanged('Task group binding changed while awaiting an operation');
}
export function retireTaskGroup(store: Store, taskId: string, chatId: string): boolean {
  return store.transaction(() => {
    const task = store.task(taskId);
    if (task.chatId !== chatId) return false;
    const previous = state(store, taskId);
    store.setMeta(stateKey(taskId), JSON.stringify({ generation: previous.generation + 1,
      retiredChatIds: [...previous.retiredChatIds, chatId] }));
    task.chatId = null;
    store.saveTask(task);
    for (const output of store.outputs(taskId)) {
      if (output.status === 'pending') store.markOutput(output.id, 'dropped', '任务群已失效');
      if (output.status === 'sending') store.markOutput(output.id, 'uncertain', '任务群失效前发送结果未知');
    }
    return true;
  });
}

export class TaskGroups {
  private readonly lanes = new Map<string, Promise<string>>();
  constructor(private readonly store: Store, private readonly transport: FeishuPort,
    private readonly titleForTask?: (task: Task) => Promise<string>) {}
  async open(taskId: string): Promise<string> {
    const running = this.lanes.get(taskId);
    if (running) return running;
    const operation = this.ensure(taskId);
    this.lanes.set(taskId, operation);
    try { return await operation; } finally { this.lanes.delete(taskId); }
  }
  private async ensure(taskId: string): Promise<string> {
    let task = this.store.task(taskId);
    if (task.chatId) {
      const chatId = task.chatId, generation = groupGeneration(this.store, taskId);
      try {
        await this.transport.verifyGroup(chatId);
        assertGroupBinding(this.store, taskId, chatId, generation);
        return chatId;
      }
      catch (error) {
        if (!(error instanceof TaskGroupUnavailable)) throw error;
        retireTaskGroup(this.store, taskId, task.chatId);
        task = this.store.task(taskId);
      }
    }
    const generation = groupGeneration(this.store, taskId);
    const kind = generation === 0 ? 'group' : `group:${generation}`;
    const operationId = `${taskId}:${kind}`;
    const previous = this.store.operation(operationId);
    const startKey = `task-group-start:${taskId}:${generation}`;
    const startedAt = Number(this.store.meta(startKey) ?? Date.now());
    if (this.store.meta(startKey) === null) this.store.setMeta(startKey, String(startedAt));
    if (!previous) this.store.beginOperation(operationId, taskId, kind);
    else if (previous.error === 'rejected') this.store.retryRejectedOperation(operationId);
    const { title: sourceTitle, url } = presentTaskSource(task.source, 100);
    const ledger = new ProjectLedger(this.store), member = ledger.membership(taskId);
    const name = member ? ledger.project(member.projectId)?.name ?? member.projectId : sourceTitle;
    const title = member?.role === 'coordinator'
      ? (/协调者$/.test(name) ? name : `${name} 项目协调者`)
      : this.titleForTask ? await this.titleForTask(task) : sourceTitle;
    let chatId: string;
    try {
      chatId = previous?.status === 'confirmed' && previous.result !== null ? previous.result
        : await this.transport.ensureGroup({ taskId, title, sourceUrl: url ?? '', generation,
          reconcileOnly: previous !== null && previous.error !== 'rejected' });
      this.store.finishOperation(operationId, chatId);
      try { await this.transport.verifyGroup(chatId); }
      catch (error) {
        if (!(error instanceof TaskGroupUnavailable)) throw error;
        assertGroupBinding(this.store, taskId, null, generation);
        const current = this.store.task(taskId);
        current.chatId = chatId; this.store.saveTask(current);
        retireTaskGroup(this.store, taskId, chatId);
        throw error;
      }
    } catch (error) {
      if (this.store.operation(operationId)?.status !== 'confirmed')
        this.store.uncertainOperation(operationId, error instanceof GroupCreationRejected ? 'rejected' : errorMessage(error));
      throw error;
    }
    assertGroupBinding(this.store, taskId, null, generation);
    task = this.store.task(taskId);
    this.store.transaction(() => {
      for (const output of this.store.outputs(taskId)) {
        if (output.status === 'pending' && !this.store.meta(`approval-output:${output.id}`))
          this.store.markOutput(output.id, 'dropped', '新任务群不补发历史');
      }
      task.chatId = chatId;
      this.store.saveTask(task);
      this.store.setMeta(`history:${taskId}`, String(startedAt));
      const summary = this.store.meta(`task-summary:${taskId}`);
      this.store.enqueue(taskId, member?.role === 'coordinator' ? `项目协调入口已建立。\n${title}\n你可以在本群直接交办 Bug、新需求，补充文字、截图和日志。协调者负责派发和监督 Worker。`
        : member ? `任务对话已建立。\n${title}\n当前状态：${task.status}${task.reason ? `，${task.reason}` : ''}。\n${summary ? `当前摘要：${summary.slice(0, 1500)}\n` : ''}请在本群继续交流。`
        : `任务对话已建立。\n${title}\n请在本群继续发送文字、截图和日志。新任务请在项目协调群交办。`, `welcome:group:${generation}`);
    });
    return chatId;
  }
}
