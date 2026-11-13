import assert from 'node:assert/strict';
import type { Task } from '../src/domain.js';
import type { ProjectState } from '../src/project.js';

export function assertProbeTaskInventory(tasks: readonly Task[], state: ProjectState,
  original: readonly Pick<Task, 'id' | 'sourceId'>[]) {
  const admitted = ['live-issue-101', 'live-issue-102', 'live-issue-104'];
  const identities = (items: readonly Pick<Task, 'id' | 'sourceId'>[]) => items
    .map(task => ({ id: task.id, sourceId: task.sourceId })).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(tasks.length, 4, 'Exactly the coordinator and three admitted Issue tasks must exist');
  assert.equal(new Set(tasks.map(task => task.id)).size, tasks.length);
  assert.deepEqual(identities(tasks), identities(original), 'Every collected task and source identity must survive dispatch and restart');
  assert.deepEqual(state.issues.map(issue => issue.id).sort(), admitted);
  const coordinator = tasks.find(task => task.id === state.coordinatorTaskId); assert.ok(coordinator);
  assert.equal(coordinator.purpose, 'execution');
  const issues = tasks.filter(task => task.id !== coordinator.id);
  assert.deepEqual(issues.map(task => task.sourceId).sort(), admitted);
  for (const task of issues) {
    assert.equal(task.source.kind, 'github');
    assert.ok(task.source.kind === 'github' && task.source.issue.id === task.sourceId);
  }
  const executions = tasks.filter(task => task.purpose === 'execution');
  const intakes = tasks.filter(task => task.purpose === 'intake');
  assert.deepEqual(state.members.map(member => member.taskId).sort(), executions.map(task => task.id).sort(),
    'Every execution must be an authorized project member');
  assert.deepEqual(state.members.find(member => member.taskId === coordinator.id), { taskId: coordinator.id, role: 'coordinator' });
  for (const task of executions) {
    if (task.id === coordinator.id) continue;
    assert.equal(task.sourceId, 'live-issue-101', 'Only Issue 101 may be promoted to execution');
    assert.deepEqual(state.members.find(member => member.taskId === task.id),
      { taskId: task.id, role: 'worker', issueId: 'live-issue-101' });
  }
  for (const task of intakes) {
    assert.ok(task.status === 'pending' || task.status === 'idle', `Intake ${task.sourceId} may only await routing or delegation`);
    assert.equal(task.executionStatus, 'unbound');
    assert.equal(task.threadId, null, 'An undelegated intake must not hide an executing thread');
    assert.equal(task.turnId, null);
    assert.equal(task.requests.length, 0);
  }
  return { executions, intakes };
}
