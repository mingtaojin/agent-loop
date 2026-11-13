import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { errorMessage, presentTaskSource } from './domain.js';
import { FeishuApiError, TaskGroupUnavailable, type FeishuPort } from './ports.js';
import { ProjectLedger } from './project.js';
import type { Store } from './store.js';
import { retireTaskGroup } from './task-groups.js';

const itemSchema = z.strictObject({ taskId: z.string(), chatId: z.string(), title: z.string(),
  status: z.enum(['pending', 'attempting', 'dissolved', 'already_gone', 'skipped', 'failed', 'uncertain']), error: z.string().nullable() });
const planSchema = z.strictObject({ id: z.string(), coordinatorTaskId: z.string(), createdAt: z.number(), digest: z.string(),
  confirmationText: z.string(), confirmationMessageId: z.string().nullable(),
  excluded: z.array(z.strictObject({ taskId: z.string(), chatId: z.string() })), items: z.array(itemSchema) });
type CleanupPlan = z.infer<typeof planSchema>;
const key = (id: string) => `group-cleanup:${id}`;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export class GroupCleanup {
  constructor(private readonly store: Store, private readonly transport: FeishuPort, private readonly userOpenId: string) {}
  private protected(taskId: string): boolean {
    return new ProjectLedger(this.store).membership(taskId)?.role === 'coordinator'
      || /^project:.*:coordinator$/.test(this.store.task(taskId).sourceId);
  }
  plan(coordinatorTaskId: string, requestId: string): CleanupPlan {
    const id = digest(JSON.stringify([coordinatorTaskId, requestId])).slice(0, 24);
    const previous = this.store.meta(key(id));
    if (previous !== null) return this.read(coordinatorTaskId, id);
    const excluded: CleanupPlan['excluded'] = [], items: CleanupPlan['items'] = [];
    for (const task of this.store.tasks()) {
      if (!task.chatId) continue;
      if (this.protected(task.id)) excluded.push({ taskId: task.id, chatId: task.chatId });
      else items.push({ taskId: task.id, chatId: task.chatId, title: presentTaskSource(task.source, 200).title, status: 'pending', error: null });
    }
    const plan: CleanupPlan = { id, coordinatorTaskId, createdAt: Date.now(), digest: digest(JSON.stringify({ excluded, items })),
      confirmationText: `确认解散 ${id}`, confirmationMessageId: null, excluded, items };
    this.store.transaction(() => {
      this.save(plan);
      this.store.enqueue(coordinatorTaskId, `解散任务群清单 ${id}，共 ${items.length} 个。\n${items.map((item, index) => `${index + 1}. ${item.title}\n${item.taskId} ${item.chatId}`).join('\n')}\n保留 ${excluded.length} 个项目协调群。\n解散会永久删除群聊天记录。确认此清单后请发送：${plan.confirmationText}`, `group-cleanup-plan:${id}`);
    });
    return plan;
  }
  confirm(coordinatorTaskId: string, planId: string, messageId: string): CleanupPlan {
    const plan = this.read(coordinatorTaskId, planId);
    const input = this.store.inputs(coordinatorTaskId).find(candidate => candidate.id === messageId);
    if (!input || input.provenance.kind !== 'user' || input.origin !== 'user') throw new Error('Cleanup confirmation requires an actual owner message, not an agent relay');
    const message = input.provenance.message;
    if (message.senderId !== this.userOpenId || message.chatId !== this.store.task(coordinatorTaskId).chatId
      || message.createdAt < plan.createdAt || message.text.trim() !== plan.confirmationText)
      throw new Error('Owner must confirm the frozen cleanup list using its exact confirmation text');
    if (plan.confirmationMessageId && plan.confirmationMessageId !== messageId) throw new Error('Cleanup list is already confirmed');
    plan.confirmationMessageId = messageId;
    this.save(plan);
    return plan;
  }
  async apply(coordinatorTaskId: string, planId: string): Promise<CleanupPlan> {
    const plan = this.read(coordinatorTaskId, planId);
    if (!plan.confirmationMessageId) throw new Error('Cleanup list has not been confirmed by the owner');
    for (const item of plan.items) {
      if (['dissolved', 'already_gone', 'skipped'].includes(item.status)) continue;
      const task = this.store.task(item.taskId);
      if (this.protected(task.id) || plan.excluded.some(entry => entry.chatId === item.chatId)
        || this.store.tasks().some(candidate => candidate.chatId === item.chatId && this.protected(candidate.id))) {
        item.status = 'skipped'; item.error = '项目协调群不参与解散'; this.save(plan); continue;
      }
      try {
        await this.transport.verifyGroup(item.chatId);
      } catch (error) {
        if (error instanceof TaskGroupUnavailable && error.code === 232009) {
          retireTaskGroup(this.store, item.taskId, item.chatId);
          item.status = 'already_gone'; item.error = null; this.save(plan); continue;
        }
        item.status = 'failed'; item.error = errorMessage(error); this.save(plan); break;
      }
      item.status = 'attempting'; item.error = null; this.save(plan);
      try {
        await this.transport.dissolveGroup(item.chatId);
        retireTaskGroup(this.store, item.taskId, item.chatId);
        item.status = 'dissolved'; this.save(plan);
      } catch (error) {
        item.status = error instanceof FeishuApiError ? 'failed' : 'uncertain'; item.error = errorMessage(error); this.save(plan); break;
      }
      await delay(50);
    }
    return plan;
  }
  read(coordinatorTaskId: string, planId: string): CleanupPlan {
    const raw = this.store.meta(key(planId));
    if (raw === null) throw new Error('Unknown cleanup plan');
    const plan = planSchema.parse(JSON.parse(raw));
    if (plan.coordinatorTaskId !== coordinatorTaskId) throw new Error('Cleanup plan belongs to another coordinator');
    return plan;
  }
  private save(plan: CleanupPlan): void { this.store.setMeta(key(plan.id), JSON.stringify(plan)); }
}
