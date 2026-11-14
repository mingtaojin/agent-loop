import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentLoop } from '../src/loop.js';
import { taskSchema, normalizeManualTaskText, type IncomingMessage } from '../src/domain.js';

export function seedSavedIntake(loop: AgentLoop, message: IncomingMessage) {
  const sourceId = `feishu:new:${message.id}`;
  const existing = loop.store.taskForSource(sourceId);
  if (existing) return existing;
  const id = randomUUID(), prompt = 'Preserve the original request and its authorization.';
  const task = taskSchema.parse({ id, sourceId, source: { kind: 'manual', message }, purpose: 'intake',
    contextDirectory: join(loop.config.dataDir, 'tasks', id), resources: [],
    status: 'pending', reason: null, prompt, promptHash: createHash('sha256').update(prompt).digest('hex'), skillPath: null,
    chatId: null, threadId: null, turnId: null, lastHandledTurnId: null, requests: [], createdAt: message.createdAt, updatedAt: message.createdAt });
  loop.store.transaction(() => {
    loop.store.saveTask(task);
    loop.store.receive(task.id, { ...message, text: normalizeManualTaskText(message.text) }, 'user', { kind: 'user', message });
  });
  return task;
}

export async function recoverSavedIntake(loop: AgentLoop, message: IncomingMessage) {
  const task = seedSavedIntake(loop, message);
  await loop.tick();
  return loop.store.task(task.id);
}

export async function recoverSavedSupplement(loop: AgentLoop, taskId: string, message: IncomingMessage) {
  loop.store.receive(taskId, message, 'user');
  await loop.tick();
}

export async function openDirectGroup(loop: AgentLoop, taskId: string) {
  const member = loop.projects.ledger.membership(taskId);
  if (!member || member.role === 'coordinator') throw new Error('Fixture must target a delegated Worker');
  const coordinator = loop.projects.ledger.project(member.projectId)?.coordinatorTaskId;
  if (!coordinator) throw new Error('Fixture project coordinator missing');
  await loop.projectAction(coordinator, { action: 'open_group', requestId: `fixture-open-${taskId}`, taskId });
  return loop.store.task(taskId);
}
