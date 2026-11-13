import { openDirectGroup } from './saved-intake.js';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { AgentLoop } from '../src/loop.js';
import { projectConfigSchema } from '../src/project.js';
import type { CodexFake } from './fakes.js';
import type { FeishuFake } from './fakes.js';
import type { IncomingMessage } from '../src/domain.js';
import { setTimeout as delay } from 'node:timers/promises';

export function testProject(directory: string) {
  return projectConfigSchema.parse({ id: 'fixture', name: 'Fixture', directory, repositories: [] });
}

export async function dispatchIntake(loop: AgentLoop, taskId: string, prompt = 'Handle the original request within its authorized scope.') {
  const before = loop.store.task(taskId);
  const route = loop.projects.intakeRoute(taskId);
  assert.ok(route, 'The request must reach a project coordinator before dispatch');
  assert.equal(before.purpose, 'intake');
  assert.equal(before.threadId, null);
  assert.equal(before.chatId, null);
  assert.equal(loop.projects.ledger.membership(taskId), null);
  const inbox = loop.store.inputs(taskId);
  const result = z.object({ taskId: z.string() }).parse(await loop.projectAction(route.coordinatorTaskId, {
    action: 'dispatch', requestId: `accept-${taskId}`, intakeTaskId: taskId, role: 'worker', prompt,
  }));
  assert.equal(result.taskId, taskId);
  const worker = loop.store.task(taskId);
  assert.equal(worker.purpose, 'execution');
  assert.deepEqual(worker.source, before.source);
  assert.equal(worker.sourceId, before.sourceId);
  assert.deepEqual(loop.store.inputs(taskId), inbox);
  assert.deepEqual(loop.projects.ledger.membership(taskId), { projectId: route.projectId, role: 'worker' });
  return worker;
}

export async function tickWithCoordinator(loop: AgentLoop) {
  for (let attempt = 0; attempt < 500; attempt++) {
    await loop.tick();
    const pending = loop.tasks().some(task => task.purpose === 'intake' && task.status === 'pending'
      && !task.reason && !loop.projects.intakeRoute(task.id));
    if (!pending) break;
    await delay(2);
  }
  for (const task of loop.tasks()) {
    if (task.purpose !== 'intake' || task.status === 'paused' || task.status === 'failed' || !loop.projects.intakeRoute(task.id)) continue;
    await dispatchIntake(loop, task.id);
  }
  for (let attempt = 0; attempt < 1000; attempt++) {
    await loop.tick();
    if (!loop.tasks().some(task => loop.projects.ledger.membership(task.id)?.role === 'worker'
      && task.status !== 'failed' && task.status !== 'paused'
      && (task.executionStatus === 'unbound'
        || loop.store.inputs(task.id).some(input => input.status === 'pending' || input.status === 'delivering')))) break;
    await delay(5);
  }
}

export async function tickWithDirectGroups(loop: AgentLoop) {
  await tickWithCoordinator(loop);
  for (const task of loop.tasks()) if (loop.projects.ledger.membership(task.id)?.role === 'worker') await openDirectGroup(loop, task.id);
  await loop.tick();
}

export function workerGroupCount(loop: AgentLoop, feishu: FeishuFake) {
  return [...feishu.groups.keys()].filter(taskId => loop.projects.ledger.membership(taskId)?.role === 'worker').length;
}

export async function instructWorker(loop: AgentLoop, taskId: string, requestId: string, text: string) {
  const member = loop.projects.ledger.membership(taskId);
  assert.ok(member);
  const project = loop.projects.ledger.project(member.projectId);
  assert.ok(project);
  await loop.projectAction(project.coordinatorTaskId, { action: 'send', requestId, taskId, text });
  await loop.tick();
}

export function workerCalls(loop: AgentLoop, codex: CodexFake) {
  const tasks = loop.tasks();
  const threads = new Set(tasks.filter(task => loop.projects.ledger.membership(task.id)?.role === 'worker').map(task => task.threadId));
  const coordinatorDirectories = new Set(tasks.filter(task => loop.projects.ledger.membership(task.id)?.role === 'coordinator').map(task => task.contextDirectory));
  return {
    starts: codex.starts.filter(call => threads.has(call.threadId)),
    steers: codex.steers.filter(call => threads.has(call.threadId)),
    created: codex.created.filter(call => !coordinatorDirectories.has(call.cwd)),
    interrupts: codex.interrupts.filter(call => threads.has(call.threadId)),
    replies: codex.replies.filter(call => threads.has(call.request.threadId)),
  };
}
