import assert from 'node:assert/strict';
import { z } from 'zod';
import type { AgentLoop } from '../src/loop.js';
import { intakeMaterialVersion } from '../src/project-runtime.js';

const dispatchReceipt = z.object({ taskId: z.string() });

export async function delegateIntake(loop: AgentLoop, taskId: string, prompt = 'Investigate the supplied request within its original scope.') {
  let route = loop.projects.intakeRoute(taskId);
  if (!route) {
    const project = loop.config.projects[0];
    assert.ok(project, 'The fixture must define a project coordinator');
    const task = loop.store.task(taskId);
    const inputs = loop.store.inputs(taskId);
    await loop.projects.acceptIntake(taskId, project.id, {
      text: inputs.filter(input => input.status !== 'dropped').map(input => input.message.text).join('\n\n'),
      version: intakeMaterialVersion(task, inputs),
    });
    await loop.tick();
    route = loop.projects.intakeRoute(taskId);
  }
  assert.ok(route, 'The request must reach its coordinator before delegation');
  const before = loop.store.task(taskId);
  assert.equal(before.purpose, 'intake');
  assert.equal(before.threadId, null);
  assert.equal(loop.projects.ledger.membership(taskId), null);
  const inbox = loop.store.inputs(taskId).map(input => ({ id: input.id, message: input.message, provenance: input.provenance }));
  const receipt = dispatchReceipt.parse(await loop.projectAction(route.coordinatorTaskId, {
    action: 'dispatch', requestId: `delegate-${taskId}`, intakeTaskId: taskId, role: 'worker', prompt,
  }));
  assert.equal(receipt.taskId, taskId);
  await loop.tick();
  const worker = loop.store.task(taskId);
  assert.equal(worker.purpose, 'execution');
  assert.equal(worker.sourceId, before.sourceId);
  assert.deepEqual(worker.source, before.source);
  assert.deepEqual(loop.store.inputs(taskId).slice(0, inbox.length)
    .map(input => ({ id: input.id, message: input.message, provenance: input.provenance })), inbox);
  assert.equal(loop.projects.ledger.membership(taskId)?.role, 'worker');
  return worker;
}
