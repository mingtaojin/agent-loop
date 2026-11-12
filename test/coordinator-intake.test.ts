import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import { ProjectLedger } from '../src/project.js';
import { discoverProjects } from '../src/project-discovery.js';
import type { IncomingMessage } from '../src/domain.js';
import { CodexFake, FeishuFake, GitHubFake, issue } from './fakes.js';
import { delegateIntake } from './coordinated-fixture.js';

test('a configured repository without an explicit project never creates an ordinary execution Thread', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coordinator-intake-'));
  const directory = join(root, 'project');
  await mkdir(directory);
  const config = configSchema.parse({ dataDir: join(root, 'data'), feishu: { userOpenId: 'owner' },
    repositories: [{ name: 'example/project', path: directory, baseBranch: 'main' }],
  });
  const github = new GitHubFake(), feishu = new FeishuFake(), codex = new CodexFake();
  github.sources = [issue(1)];
  const loop = new AgentLoop(config, { github, feishu, codex, workspace: {
    async ensure(input) { return input.kind === 'project-directory' ? input.directory : directory; },
    async head() { return 'fixture-head'; },
  } });
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  await loop.collect();
  await loop.tick();
  const ledger = new ProjectLedger(loop.store);
  for (const task of loop.tasks().filter(task => task.threadId)) {
    assert.ok(ledger.membership(task.id), 'every formal Thread must have project ownership');
  }
  assert.equal(loop.tasks().filter(task => ledger.membership(task.id)?.role === 'worker').length, 0,
    'the Runtime must wait for the coordinator to delegate');
});

test('private requests for the same project reach one coordinator and await its delegation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coordinator-private-'));
  const projectRoot = join(root, 'projects'), directory = join(projectRoot, 'app');
  await mkdir(directory, { recursive: true });
  const config = configSchema.parse({ dataDir: join(root, 'data'), feishu: { userOpenId: 'owner' },
    engineering: { projectRoot }, projects: [{ id: 'app', name: 'Application', directory,
      repositories: [{ name: 'example/app', labelsAny: ['bug'] }] }],
  });
  const github = new GitHubFake(), feishu = new FeishuFake(), codex = new CodexFake();
  const [candidate] = await discoverProjects(projectRoot);
  assert.ok(candidate);
  codex.selectionResults.push(...Array.from({ length: 2 }, () => ({ kind: 'project' as const,
    projectId: candidate.id, reason: 'The user requested Application work' })));
  let acquisitions = 0;
  const loop = new AgentLoop(config, { github, feishu, codex, workspace: {
    async ensure() { acquisitions++; return directory; },
    async head() { return 'fixture-head'; },
  } });
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  const message = (id: string, text: string): IncomingMessage => ({ id, text, chatId: 'private', chatType: 'p2p',
    senderId: 'owner', attachments: [], createdAt: Date.now() });
  const first = message('first-request', 'Investigate an Application bug');
  await loop.receive(first);
  await loop.receive(first);
  await loop.receive(message('second-request', 'Clarify a new Application requirement'));
  await loop.tick();
  const ledger = new ProjectLedger(loop.store);
  const state = ledger.project('app');
  assert.ok(state);
  assert.equal(state.members.length, 1, 'only a coordinator exists before it delegates');
  assert.equal(loop.tasks().filter(task => task.threadId).length, 1);
  const delivered = loop.store.inputs(state.coordinatorTaskId);
  const original = loop.store.taskForSource(`feishu:new:${first.id}`); assert.ok(original);
  assert.equal(original.purpose, 'intake'); assert.equal(original.threadId, null); assert.equal(original.chatId, null);
  assert.deepEqual(loop.store.inputs(original.id)[0]?.message, first);
  const envelopes = delivered.filter(input => input.provenance.kind === 'agent'
    && input.provenance.taskId === original.id && input.provenance.category === 'intake_request');
  assert.equal(envelopes.length, 1);
  assert.notEqual(envelopes[0]?.message.id, first.id);
  assert.ok(envelopes[0]?.message.text.includes(first.id));
  assert.ok(envelopes[0]?.message.text.includes(first.text));
  assert.ok(delivered.some(input => input.message.text.includes('Clarify a new Application requirement')));
  assert.equal(feishu.groups.size, 1, 'requests reuse the project group');
  assert.equal(acquisitions, 0, 'intake does not prepare a Worker workspace');
  const intakeItem = z.object({ taskId: z.string(), source: z.object({ title: z.string(), label: z.string() }),
    status: z.string(), reason: z.string().nullable(), materialPath: z.string() });
  const overview = z.object({ counts: z.object({ tasks: z.number(), intakes: z.number() }),
    members: z.array(z.object({ taskId: z.string() })), tasks: z.array(z.object({ taskId: z.string() })), intakes: z.array(intakeItem) })
    .parse(await loop.projectAction(state.coordinatorTaskId, { action: 'status' }));
  assert.deepEqual(overview.counts, { tasks: 1, intakes: 2 });
  assert.deepEqual(overview.members.map(item => item.taskId), [state.coordinatorTaskId]);
  assert.deepEqual(overview.tasks.map(item => item.taskId), [state.coordinatorTaskId]);
  const page = z.object({ items: z.array(intakeItem), nextOffset: z.number().nullable() })
    .parse(await loop.projectAction(state.coordinatorTaskId, { action: 'status', section: 'intakes', limit: 1 }));
  assert.equal(page.items.length, 1); assert.equal(page.nextOffset, 1);
  const saved = overview.intakes.find(item => item.taskId === original.id); assert.ok(saved);
  assert.equal(saved.materialPath, join(original.contextDirectory, 'intake-request.txt'));
  const material = await readFile(saved.materialPath, 'utf8');
  assert.ok(material.includes(first.id)); assert.ok(material.includes(first.text));
  await delegateIntake(loop, original.id);
  const remaining = z.object({ items: z.array(intakeItem), counts: z.object({ intakes: z.number() }) })
    .parse(await loop.projectAction(state.coordinatorTaskId, { action: 'status', section: 'intakes' }));
  assert.equal(remaining.counts.intakes, 1); assert.ok(remaining.items.every(item => item.taskId !== original.id));
});

test('coordinator promotion during intake handoff keeps the Worker executable with its original input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coordinator-handoff-race-'));
  const config = configSchema.parse({ dataDir: join(root, 'data'), feishu: { userOpenId: 'owner' },
    projects: [{ id: 'app', name: 'Application', directory: root, repositories: [] }] });
  const github = new GitHubFake(), feishu = new FeishuFake(), codex = new CodexFake();
  codex.selectionResults.push({ kind: 'project', projectId: 'coordinated:app', reason: 'Selected project' });
  const loop = new AgentLoop(config, { github, feishu, codex, workspace: {
    async ensure(input) { return input.kind === 'project-directory' ? input.directory : root; },
    async head() { return 'fixture-head'; },
  } });
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  await loop.collect(); await loop.tick();
  const accept = loop.projects.acceptIntake.bind(loop.projects);
  loop.projects.acceptIntake = async (taskId, projectId, material) => {
    await accept(taskId, projectId, material);
    const route = loop.projects.intakeRoute(taskId); assert.ok(route);
    await loop.projectAction(route.coordinatorTaskId, { action: 'dispatch', requestId: 'during-handoff', intakeTaskId: taskId,
      role: 'worker', prompt: 'Follow the original request and preserve its scope.' });
  };
  await loop.receive({ id: 'handoff-owner-input', text: 'Investigate only; do not edit or deploy.', chatId: 'private', chatType: 'p2p',
    senderId: 'owner', attachments: [], createdAt: Date.now() });
  const worker = loop.store.taskForSource('feishu:new:handoff-owner-input'); assert.ok(worker?.threadId);
  assert.equal(worker.purpose, 'execution'); assert.equal(worker.status, 'running');
  assert.equal(loop.projects.ledger.membership(worker.id)?.role, 'worker');
  const start = codex.starts.find(call => call.threadId === worker.threadId); assert.ok(start);
  assert.ok(JSON.stringify(start.input).includes('Investigate only; do not edit or deploy.'));
});
