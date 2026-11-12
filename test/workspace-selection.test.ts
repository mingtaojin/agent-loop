import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import { criteriaSchema, type IncomingMessage, type WorkspaceChoice } from '../src/domain.js';
import { WorkspaceProvider } from '../src/workspace.js';
import { CodexFake, FeishuFake, GitHubFake, issue } from './fakes.js';

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, discovery = false) {
  const root = await mkdtemp(join(tmpdir(), 'agent-workspace-selection-'));
  const project = join(root, 'project'), other = join(root, 'other');
  await mkdir(project); await mkdir(other);
  const promptPath = join(root, 'task.md');
  await writeFile(promptPath, 'Formal engineering policy: follow the user scope.');
  const config = configSchema.parse({ dataDir: join(root, 'data'), engineering: { promptPath, ...(discovery ? { projectRoot: join(root, 'projects') } : {}) },
    repositories: discovery ? [] : [
      { name: 'example/project', path: project, baseBranch: 'main', workspace: { kind: 'project-directory', path: project } },
      { name: 'example/other', path: other, baseBranch: 'main', workspace: { kind: 'project-directory', path: other } },
    ], feishu: { userOpenId: 'owner' }, recovery: { maxAttempts: 2, retryDelayMs: 1 },
  });
  if (discovery) {
    await mkdir(join(root, 'projects'));
  }
  const codex = new CodexFake(), feishu = new FeishuFake(), github = new GitHubFake();
  const ports = { codex, feishu, github, workspace: new WorkspaceProvider(config.dataDir) };
  let loop = new AgentLoop(config, ports);
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  const message = (id: string, text: string, chatId = 'private', chatType: 'p2p' | 'group' = 'p2p'): IncomingMessage => ({ id, text, chatId, chatType, senderId: 'owner', attachments: [], createdAt: Date.now() });
  const task = () => { const value = loop.tasks()[0]; assert.ok(value); return value; };
  return { root, project, other, config, codex, feishu, github, ports, task, message,
    get loop() { return loop; },
    async manual() { await loop.receive(message('initial', 'Investigate the original task')); return task(); },
    async restart() { await loop.close(); loop = new AgentLoop(config, ports); await loop.recover(); },
  };
}

function selected(repositoryName = 'example/project'): WorkspaceChoice {
  return { kind: 'repository', repositoryName, reason: 'PRIVATE_SELECTION_REASON_ONLY' };
}

test('discovery selects only first-level projects without Git and starts the formal task there', async t => {
  const f = await fixture(t, true);
  const root = join(f.root, 'projects'), project = join(root, 'multi-repository');
  await mkdir(join(project, 'nested-version'), { recursive: true });
  await mkdir(join(root, 'notes')); await mkdir(join(root, '.metadata'));
  await writeFile(join(root, '.DS_Store'), 'metadata');
  await writeFile(join(project, 'local-change.txt'), 'preserve this work');
  f.codex.selectWorkspace = async input => {
    assert.deepEqual(input.candidates.map(candidate => candidate.name).sort(), ['multi-repository', 'notes']);
    const candidate = input.candidates.find(candidate => candidate.name === 'multi-repository');
    assert.ok(candidate && 'kind' in candidate && candidate.kind === 'project');
    assert.equal(candidate.entryPath, project);
    assert.equal(candidate.canonicalPath, await realpath(project));
    assert.equal('baseBranch' in candidate, false);
    return { temporaryThreadId: 'discovery-selector', choice: { kind: 'project', projectId: candidate.id, reason: 'PRIVATE_SELECTION_REASON_ONLY' } };
  };
  const task = await f.manual();
  assert.equal(task.status, 'running');
  assert.equal(f.codex.created[0]?.cwd, await realpath(project));
  const resource = task.resources[0]; assert.ok(resource && resource.kind === 'project');
  assert.equal(resource.project.entryPath, project);
  assert.equal('repository' in resource, false);
  assert.equal(await readFile(join(project, 'local-change.txt'), 'utf8'), 'preserve this work');
  assert.doesNotMatch(JSON.stringify(f.codex.created) + JSON.stringify(f.codex.starts), /PRIVATE_SELECTION_REASON_ONLY/);
});

test('fresh discovery reflects directory changes while established Threads survive an unavailable new root', async t => {
  const f = await fixture(t, true), root = join(f.root, 'projects');
  await mkdir(join(root, 'first'));
  const seen: string[][] = [];
  f.codex.selectWorkspace = async input => {
    seen.push(input.candidates.map(candidate => candidate.name));
    const candidate = input.candidates[0]; assert.ok(candidate && 'kind' in candidate && candidate.kind === 'project');
    return { temporaryThreadId: `discovery-${seen.length}`, choice: { kind: 'project', projectId: candidate.id, reason: 'fits' } };
  };
  const first = await f.manual(); assert.ok(first.threadId);
  await mkdir(join(root, 'second'));
  await f.loop.receive(f.message('second-task', 'Use the next project'));
  assert.deepEqual(seen[1]?.sort(), ['first', 'second']);
  await rm(join(root, 'second'), { recursive: true });
  await f.loop.receive(f.message('third-task', 'Use the remaining project'));
  assert.deepEqual(seen[2], ['first']);
  assert.ok(f.config.engineering);
  f.config.engineering.projectRoot = join(f.root, 'missing-new-root');
  await f.restart();
  assert.equal(f.loop.tasks().find(task => task.id === first.id)?.threadId, first.threadId);
  assert.ok(f.loop.tasks().every(task => task.status !== 'failed'));
  assert.equal(seen.length, 3);
});

test('source-only GitHub collection uses discovered projects without expanding collection scope', async t => {
  const f = await fixture(t, true), project = join(f.root, 'projects', 'unregistered-local');
  await mkdir(project);
  f.config.repositories = configSchema.parse({ feishu: { userOpenId: 'owner' }, repositories: [{ name: 'example/project', criteria: criteriaSchema.parse({}) }] }).repositories;
  const listed: string[] = [], list = f.github.list.bind(f.github);
  f.github.list = async function* (repository) { listed.push(repository.name); yield* list(repository); };
  f.github.sources = [issue(1), issue(2, { repository: 'outside/not-collected' }), issue(3, { labels: ['enhancement'], nativeType: 'Feature' })];
  f.codex.selectWorkspace = async input => {
    assert.deepEqual(input.candidates.map(candidate => candidate.name), ['unregistered-local']);
    const candidate = input.candidates[0]; assert.ok(candidate && 'kind' in candidate && candidate.kind === 'project');
    return { temporaryThreadId: 'github-selector', choice: { kind: 'project', projectId: candidate.id, reason: 'fits the issue' } };
  };
  await f.loop.collect(); await f.loop.tick();
  assert.deepEqual(listed, ['example/project']);
  assert.equal(f.loop.tasks().length, 1);
  assert.equal(f.task().sourceId, 'issue-1');
  assert.equal(f.codex.created[0]?.cwd, await realpath(project));
});

test('a discovery read failure is reported before any selector or formal Thread can treat it as empty', async t => {
  const f = await fixture(t, true);
  await rm(join(f.root, 'projects'), { recursive: true });
  await f.manual();
  assert.equal(f.codex.selections.length, 0);
  assert.equal(f.codex.created.length, 0);
  assert.ok(f.task().reason);
});

test('discovery rejects invented identity and a symlink retargeted after the candidate snapshot', async t => {
  const f = await fixture(t, true), entry = join(f.root, 'projects', 'linked');
  await symlink(f.project, entry);
  f.codex.selectWorkspace = async input => {
    const candidate = input.candidates[0]; assert.ok(candidate && 'kind' in candidate && candidate.kind === 'project');
    await rm(entry); await symlink(f.other, entry);
    return { temporaryThreadId: 'retarget-selector', choice: { kind: 'project', projectId: candidate.id, reason: 'fits' } };
  };
  await f.manual();
  assert.equal(f.codex.created.length, 0);
  assert.equal(f.task().workspaceSelection.kind, 'selected');
  assert.equal(f.task().status, 'failed');
  f.codex.selectWorkspace = async () => ({ temporaryThreadId: 'invented', choice: { kind: 'project', projectId: 'invented-id', reason: 'guess' } });
  await f.loop.receive(f.message('invented-task', 'Pick a project'));
  assert.equal(f.codex.created.length, 0);
  assert.ok(f.loop.tasks().every(task => task.resources.length === 0));
});

test('same-name projects under changed roots never rebind saved resources or established Threads', async t => {
  const f = await fixture(t, true);
  const firstPath = join(f.root, 'projects', 'same-name'), secondRoot = join(f.root, 'another-root'), secondPath = join(secondRoot, 'same-name');
  await mkdir(firstPath); await mkdir(secondPath, { recursive: true });
  f.codex.selectWorkspace = async input => {
    const candidate = input.candidates[0]; assert.ok(candidate && 'kind' in candidate);
    return { temporaryThreadId: 'same-name-selector', choice: { kind: 'project', projectId: candidate.id, reason: 'fits' } };
  };
  const original = await f.manual(); const resource = original.resources[0];
  assert.ok(original.threadId && resource && resource.kind === 'project');
  assert.ok(f.config.engineering); f.config.engineering.projectRoot = secondRoot;
  await f.restart();
  assert.equal(f.task().threadId, original.threadId);
  assert.deepEqual(f.task().resources, original.resources);
  assert.deepEqual(await f.loop.ensureWorkspace(original.id, { projectId: resource.project.id }), resource);
  await f.loop.receive(f.message('new-root-task', 'Use the same named project in the new root'));
  const newTask = f.loop.tasks().find(task => task.id !== original.id); assert.ok(newTask);
  const newResource = newTask.resources[0]; assert.ok(newResource && newResource.kind === 'project');
  assert.equal(f.codex.created[1]?.cwd, await realpath(secondPath));
  assert.notEqual(newResource.project.id, resource.project.id);
  assert.notEqual(newResource.id, resource.id);
  const additional = await f.loop.ensureWorkspace(original.id, { projectId: newResource.project.id });
  assert.equal(additional.workspace, await realpath(secondPath));
  assert.deepEqual(f.task().resources.find(item => item.id === resource.id), resource);
  await rm(firstPath, { recursive: true }); await f.restart();
  assert.equal(f.task().status, 'failed');
  assert.equal(f.task().threadId, original.threadId);
  assert.equal(f.task().resources.find(item => item.id === resource.id)?.workspace, resource.workspace);
});

test('dynamic project acquisition and retained shell bridge preserve original resources and native requests', async t => {
  const f = await fixture(t, true), root = join(f.root, 'projects');
  await mkdir(join(root, 'initial')); await mkdir(join(root, 'extra')); await mkdir(join(root, 'bridge-extra'));
  let extraId = '', bridgeId = '';
  f.codex.selectWorkspace = async input => {
    const initial = input.candidates.find(candidate => candidate.name === 'initial');
    const extra = input.candidates.find(candidate => candidate.name === 'extra');
    const bridge = input.candidates.find(candidate => candidate.name === 'bridge-extra');
    assert.ok(initial && 'kind' in initial && extra && 'kind' in extra); extraId = extra.id;
    assert.ok(bridge && 'kind' in bridge); bridgeId = bridge.id;
    return { temporaryThreadId: 'extra-selector', choice: { kind: 'project', projectId: initial.id, reason: 'PRIVATE_SELECTION_REASON_ONLY' } };
  };
  const task = await f.manual(); assert.ok(task.threadId && task.turnId);
  const original = structuredClone(task.resources);
  assert.match(f.codex.created[0]?.instructions ?? '', new RegExp(extraId));
  assert.match(f.codex.created[0]?.instructions ?? '', /ensure_workspace.*projectId/);
  const nativeRequest = { id: 'history-request', threadId: task.threadId, turnId: task.turnId, kind: 'question' as const,
    prompt: 'Preserved native question', method: 'item/tool/requestUserInput', payload: {}, isBlocking: true, connectionEpoch: 'epoch' };
  f.codex.snapshot(task.threadId).requests.push(nativeRequest);
  await f.loop.tick(); assert.ok(f.codex.workspaceHandler);
  const extra = await f.codex.workspaceHandler({ threadId: task.threadId, turnId: task.turnId, callId: 'extra-project', projectId: extraId });
  assert.equal(extra.workspace, await realpath(join(root, 'extra')));
  assert.deepEqual(f.task().resources.filter(resource => resource.id !== extra.id), original);
  assert.deepEqual(f.task().requests, [nativeRequest]);
  const retained = f.task(); retained.workspaceSelection = { kind: 'pending' }; f.loop.store.saveTask(retained);
  await f.loop.tick();
  const client = resolve('src/workspace-client.ts'), capability = join(f.config.dataDir, 'workspace-capabilities', `${task.id}.json`);
  const execute = promisify(execFile);
  const bridged = await execute(process.execPath, [client, capability, '--project', extraId]);
  assert.deepEqual(JSON.parse(bridged.stdout), extra);
  const bridgeNew = await execute(process.execPath, [client, capability, '--project', bridgeId]);
  assert.equal(JSON.parse(bridgeNew.stdout).workspace, await realpath(join(root, 'bridge-extra')));
  assert.equal(f.task().resources.length, 3);
  assert.equal(f.task().threadId, task.threadId);
  assert.deepEqual(f.task().requests, [nativeRequest]);
  assert.doesNotMatch(JSON.stringify(f.codex.created) + JSON.stringify(f.codex.starts), /PRIVATE_SELECTION_REASON_ONLY/);
  await f.restart();
  assert.deepEqual(f.task().resources.filter(resource => original.some(saved => saved.id === resource.id)), original);
  assert.deepEqual(f.task().requests, [nativeRequest]);
});

test('saved legacy selections and resources restore after mappings are removed and a new discovery root is unavailable', async t => {
  const f = await fixture(t); f.codex.selectionResults.push(selected());
  const task = await f.manual(); const original = structuredClone(task.resources);
  f.config.repositories = [];
  assert.ok(f.config.engineering); f.config.engineering.projectRoot = join(f.root, 'missing-root');
  await f.restart();
  assert.equal(f.task().threadId, task.threadId);
  assert.notEqual(f.task().status, 'failed');
  assert.deepEqual(await f.loop.ensureWorkspace(task.id, 'EXAMPLE/PROJECT'), original[0]);
  assert.deepEqual(f.task().resources, original);
  const preThread = f.task(); preThread.threadId = null; preThread.turnId = null; preThread.status = 'pending';
  f.loop.store.saveTask(preThread); await f.loop.tick();
  assert.notEqual(f.task().status, 'failed');
  assert.equal(f.codex.selections.length, 1);
  assert.deepEqual(f.task().resources, original);
});

test('legacy local mappings do not augment discovery candidates or allow a repository choice with projectRoot set', async t => {
  const f = await fixture(t);
  const root = join(f.root, 'discovery'); await mkdir(join(root, 'only-discovered'), { recursive: true });
  assert.ok(f.config.engineering); f.config.engineering.projectRoot = root;
  let names: string[] = [];
  f.codex.selectWorkspace = async input => {
    names = input.candidates.map(candidate => candidate.name);
    return { temporaryThreadId: 'legacy-cannot-leak', choice: selected() };
  };
  await f.manual();
  assert.deepEqual(names, ['only-discovered']);
  assert.equal(f.codex.created.length, 0); assert.deepEqual(f.task().resources, []);
});

test('a saved selection resumes its original project snapshot before resource preparation after a root change', async t => {
  const f = await fixture(t, true), project = join(f.root, 'projects', 'chosen'); await mkdir(project);
  f.codex.selectWorkspace = async input => {
    const candidate = input.candidates[0]; assert.ok(candidate && 'kind' in candidate);
    return { temporaryThreadId: 'saved-choice', choice: { kind: 'project', projectId: candidate.id, reason: 'fits' } };
  };
  const ensure = f.ports.workspace.ensure.bind(f.ports.workspace);
  f.ports.workspace.ensure = async () => { throw new Error('Preparation temporarily unavailable'); };
  const task = await f.manual();
  assert.equal(task.workspaceSelection.kind, 'selected'); assert.deepEqual(task.resources, []);
  assert.ok(f.config.engineering); f.config.engineering.projectRoot = join(f.root, 'unavailable-new-root');
  f.ports.workspace.ensure = ensure;
  await f.loop.control(task.id, 'resume');
  assert.equal(f.codex.created[0]?.cwd, await realpath(project));
  assert.equal(f.task().status, 'running');
});

test('legacy selection snapshot prepares its saved directory when config mappings disappear before preparation', async t => {
  const f = await fixture(t); f.codex.selectionResults.push(selected());
  const ensure = f.ports.workspace.ensure.bind(f.ports.workspace);
  f.ports.workspace.ensure = async () => { throw new Error('Preparation temporarily unavailable'); };
  const task = await f.manual();
  assert.equal(task.workspaceSelection.kind, 'selected'); assert.deepEqual(task.resources, []);
  f.config.repositories = []; f.ports.workspace.ensure = ensure;
  await f.loop.control(task.id, 'resume');
  assert.equal(f.codex.created[0]?.cwd, await realpath(f.project));
  assert.equal(f.task().status, 'running');
  assert.equal(f.codex.selections.length, 1);
});

test('temporary workspace choice sets the formal cwd without copying selection history or instructions', async t => {
  const f = await fixture(t); f.codex.selectionResults.push(selected());
  const task = await f.manual();
  assert.equal(f.codex.selections.length, 1);
  assert.equal(f.codex.created.length, 1);
  assert.equal(f.codex.created[0]?.cwd, await realpath(f.project));
  assert.equal(task.resources[0]?.workspace, await realpath(f.project));
  assert.notEqual(task.threadId, task.workspaceSelection.kind === 'selected' ? task.workspaceSelection.temporaryThreadId : null);
  assert.match(JSON.stringify(f.codex.starts[0]?.input), /Investigate the original task/);
  assert.doesNotMatch(JSON.stringify(f.codex.selections[0]?.input), /Formal engineering policy/);
  assert.doesNotMatch(JSON.stringify(f.codex.created) + JSON.stringify(f.codex.starts), /PRIVATE_SELECTION_REASON_ONLY|workspace-capabilities|workspace-client/);
  assert.equal(f.feishu.sent.some(output => output.text.includes('PRIVATE_SELECTION_REASON_ONLY')), false);
  assert.ok(task.threadId && task.chatId);
  f.codex.complete(task.threadId, 'Completed the investigation'); await f.loop.tick();
  await f.loop.receive(f.message('followup', 'Continue the original matter', task.chatId, 'group'));
  assert.equal(f.codex.selections.length, 1);
  assert.equal(f.codex.starts.at(-1)?.threadId, task.threadId);
});

test('a discussion can choose no engineering directory and retain its formal conversation after restart', async t => {
  const f = await fixture(t); f.codex.selectionResults.push({ kind: 'none', reason: 'This is a discussion' });
  const task = await f.manual(); assert.ok(task.threadId);
  assert.equal(f.codex.created[0]?.cwd, task.contextDirectory);
  assert.deepEqual(task.resources, []);
  f.codex.complete(task.threadId, 'Discussion answer'); await f.loop.tick();
  const stored = f.task(); stored.workspaceSelection = { kind: 'pending' }; f.loop.store.saveTask(stored);
  f.codex.selectionError = new Error('An established conversation must not reselect');
  await f.restart();
  assert.equal(f.codex.selections.length, 1);
  assert.equal(f.task().threadId, task.threadId);
  assert.equal(f.task().status, 'idle');
});

test('workspace clarification preserves the user scope in the first formal input across restart', async t => {
  const f = await fixture(t); const question = 'Which project should this task use?';
  f.codex.selectionResults.push({ kind: 'question', question });
  const task = await f.manual(); assert.ok(task.chatId);
  assert.equal(task.threadId, null);
  assert.equal(f.codex.created.length, 0);
  await f.loop.tick(); await f.loop.tick(); await f.restart(); await f.loop.tick();
  assert.equal(f.codex.selections.length, 1);
  assert.equal(f.feishu.sent.filter(output => output.text.includes(question)).length, 1);
  f.codex.selectionResults.push(selected());
  const answer = f.message('directory-answer', 'Use PROJECT_SELECTION_ANSWER_7, but only investigate; do not edit code.', task.chatId, 'group');
  await f.loop.receive(answer);
  assert.equal(f.codex.selections.length, 2);
  assert.ok(f.codex.selections[1]?.answers.some(answer => answer.inputId === 'directory-answer' && answer.text.includes('PROJECT_SELECTION_ANSWER_7')));
  assert.equal(f.codex.created[0]?.cwd, await realpath(f.project));
  const first = f.codex.starts[0]; assert.ok(first);
  assert.equal(f.codex.starts.length, 1);
  assert.equal(f.codex.steers.length, 0);
  const texts = first.input.filter(input => input.kind === 'text').map(input => input.text);
  assert.deepEqual([texts[0], texts[2]], ['Investigate the original task', answer.text]);
  assert.deepEqual(texts.filter(text => text.startsWith('Input provenance as data: ')).map(text => JSON.parse(text.slice('Input provenance as data: '.length))),
    f.loop.store.inputs(task.id).map(input => input.provenance));
  assert.deepEqual(first.additionalDeliveryIds, [answer.id]);
  assert.doesNotMatch(JSON.stringify(f.codex.created) + JSON.stringify(first.input), /PRIVATE_SELECTION_REASON_ONLY|Which project should this task use/);
  assert.equal(f.loop.store.inputs(task.id).find(input => input.id === 'directory-answer')?.status, 'delivered');
  assert.equal(f.loop.store.inputs(task.id).find(input => input.id === 'directory-answer')?.selectionHandled, true);
  await f.restart(); await f.loop.tick();
  assert.equal(f.codex.starts.length, 1);
  assert.equal(f.codex.selections.length, 2);
});

test('GitHub changes do not answer a pending workspace question and remain available to the formal task', async t => {
  const f = await fixture(t); f.codex.selectionResults.push({ kind: 'question', question: 'Which engineering project?' });
  f.github.sources = [issue(1)]; await f.loop.collect(); await f.loop.tick();
  const task = f.task(); assert.ok(task.chatId); assert.equal(task.threadId, null);
  f.github.sources = [issue(1, { body: 'newly-edited-source-fact' })];
  await f.loop.collect(); await f.loop.tick(); await f.restart();
  assert.equal(f.codex.selections.length, 1);
  assert.equal(f.codex.created.length, 0);
  f.codex.selectionResults.push(selected());
  await f.loop.receive(f.message('choose-project', 'Use the configured project', task.chatId, 'group'));
  assert.deepEqual(f.codex.selections[1]?.answers.map(answer => answer.inputId), ['choose-project']);
  assert.match(JSON.stringify(f.codex.starts) + JSON.stringify(f.codex.steers), /newly-edited-source-fact/);
});

test('uncertain formal thread creation cannot replay selection or create another formal thread on restart', async t => {
  const f = await fixture(t); f.codex.selectionResults.push(selected()); f.codex.loseCreateAck = true;
  await f.manual();
  assert.equal(f.task().workspaceSelection.kind, 'selected');
  assert.equal(f.codex.selections.length, 1);
  assert.equal(f.codex.created.length, 1);
  await f.restart(); await f.loop.tick();
  assert.equal(f.codex.selections.length, 1);
  assert.equal(f.codex.created.length, 1);
  assert.equal(f.task().threadId, null);
  assert.equal(f.task().status, 'failed');
});

test('an unconfigured model choice never becomes an engineering resource or formal thread', async t => {
  const f = await fixture(t); f.codex.selectionResults.push(selected('outside/unconfigured'));
  await f.manual();
  assert.equal(f.codex.created.length, 0);
  assert.equal(f.codex.starts.length, 0);
  assert.deepEqual(f.task().resources, []);
  assert.ok(f.task().reason);
});

test('temporary selector failures exhaust the configured recovery limit before a formal thread exists', async t => {
  const f = await fixture(t); f.codex.selectionError = new Error('Temporary selector unavailable');
  await f.manual();
  for (let attempt = 0; attempt < 4; attempt++) { await delay(5); await f.loop.tick(); }
  assert.equal(f.codex.selections.length, 3);
  assert.equal(f.task().status, 'failed');
  assert.equal(f.codex.created.length, 0);
  await f.loop.tick(); assert.equal(f.codex.selections.length, 3);
});

test('selector failure keeps raw diagnostics but sends a readable recovery message to the group', async t => {
  const f = await fixture(t);
  const raw = JSON.stringify({ type: 'error', error: { message: 'oneOf is not permitted when strict is true', code: 'invalid_json_schema' }, status: 400 });
  f.codex.selectionError = new Error(raw);
  await f.manual();
  for (let attempt = 0; attempt < 4; attempt++) { await delay(5); await f.loop.tick(); }
  assert.equal(f.task().status, 'failed');
  assert.equal(f.task().reason, raw);
  const messages = f.feishu.sent.map(output => output.text).join('\n');
  assert.match(messages, /工程目录选择失败/);
  assert.match(messages, /继续/);
  assert.doesNotMatch(messages, /oneOf|invalid_json_schema|"status":400/);
});

test('original attachments keep their identity and bytes through workspace clarification', async t => {
  const f = await fixture(t); const bytes = Buffer.from('original-log-evidence-23\n');
  f.feishu.resources.set('log-key', bytes);
  f.codex.selectionResults.push({ kind: 'question', question: 'Which project contains this log producer?' });
  await f.loop.receive({ ...f.message('initial-log', 'Investigate this log'), attachments: [{ key: 'log-key', kind: 'file', name: 'evidence.log' }] });
  const task = f.task(); assert.ok(task.chatId);
  f.codex.selectionResults.push(selected());
  await f.loop.receive(f.message('attachment-project-answer', 'Use the configured engineering project', task.chatId, 'group'));
  assert.equal(f.feishu.downloads.length, 1);
  assert.equal(f.feishu.downloads[0]?.messageId, 'initial-log');
  const download = f.feishu.downloads[0]; assert.ok(download);
  const path = download.destination.replace(/\.partial$/, '');
  assert.deepEqual(await readFile(path), bytes);
  assert.ok(f.codex.starts[0]?.input.some(input => input.kind === 'text' && input.text.includes(path)));
});

test('input arriving during selection is reconsidered before the formal cwd is fixed', { timeout: 3000 }, async t => {
  const f = await fixture(t); const entered = gate(), release = gate();
  f.codex.selectionResults.push(selected(), selected('example/other'));
  const select = f.codex.selectWorkspace.bind(f.codex); let first = true;
  f.codex.selectWorkspace = async input => {
    const result = await select(input);
    if (first) { first = false; entered.resolve(); await release.promise; }
    return result;
  };
  const initial = f.manual();
  try {
    await entered.promise;
    const task = f.task(); assert.ok(task.chatId);
    const correction = f.loop.receive(f.message('selection-correction', 'This concerns example/other, not the initial project', task.chatId, 'group'));
    await delay(0); release.resolve(); await Promise.all([initial, correction]);
    assert.equal(f.codex.created.length, 1);
    assert.equal(f.codex.created[0]?.cwd, await realpath(f.other));
    assert.equal(f.codex.selections.length, 2);
    assert.match(JSON.stringify(f.codex.selections[1]), /selection-correction|example\/other/);
  } finally { release.resolve(); await initial; }
});

test('closing the service aborts active temporary selection before creating a formal thread', { timeout: 3000 }, async t => {
  const f = await fixture(t); const entered = gate(), release = gate(); let aborted = false;
  f.codex.selectWorkspace = async input => {
    assert.ok(input.signal);
    input.signal.addEventListener('abort', () => { aborted = true; release.resolve(); }, { once: true });
    entered.resolve(); await release.promise;
    input.signal.throwIfAborted();
    return { temporaryThreadId: 'selection-cancelled', choice: { kind: 'none', reason: 'finished after cancellation' } };
  };
  const initial = f.manual();
  try {
    await entered.promise;
    const closing = f.loop.close(); await delay(10);
    assert.equal(aborted, true);
    await closing; await initial;
    assert.equal(f.codex.created.length, 0);
  } finally { release.resolve(); await initial; }
});

test('input received while a chosen directory is being prepared is reconsidered before formal creation', { timeout: 3000 }, async t => {
  const f = await fixture(t); const entered = gate(), release = gate();
  const ensure = f.ports.workspace.ensure.bind(f.ports.workspace); let first = true;
  f.ports.workspace.ensure = async input => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return ensure(input);
  };
  f.codex.selectionResults.push(selected(), selected('example/other'));
  const initial = f.manual();
  try {
    await entered.promise;
    const task = f.task(); assert.ok(task.chatId);
    const correction = f.loop.receive(f.message('preparation-correction', 'The engineering directory must be example/other', task.chatId, 'group'));
    await delay(0); release.resolve(); await Promise.all([initial, correction]);
    assert.equal(f.codex.selections.length, 2);
    assert.equal(f.codex.created.length, 1);
    assert.equal(f.codex.created[0]?.cwd, await realpath(f.other));
    assert.match(JSON.stringify(f.codex.selections[1]?.input), /preparation-correction|example\/other/);
  } finally { release.resolve(); await initial; }
});

test('shutdown during directory preparation does not create or start a formal conversation', { timeout: 3000 }, async t => {
  const f = await fixture(t); const entered = gate(), release = gate();
  const ensure = f.ports.workspace.ensure.bind(f.ports.workspace);
  f.ports.workspace.ensure = async input => { entered.resolve(); await release.promise; return ensure(input); };
  f.codex.selectionResults.push(selected());
  const initial = f.manual();
  try {
    await entered.promise;
    const closing = f.loop.close(); await delay(0); release.resolve();
    await Promise.all([initial, closing]);
    assert.equal(f.codex.created.length, 0);
    assert.equal(f.codex.starts.length, 0);
  } finally { release.resolve(); await initial; }
});

test('directory clarification attachments retain their identity in the selector and first formal input', async t => {
  const f = await fixture(t); const bytes = Buffer.from('shared-project-evidence-41\n');
  f.feishu.resources.set('answer-evidence', bytes);
  f.codex.selectionResults.push({ kind: 'question', question: 'Which project should be used?' }, selected());
  const task = await f.manual(); assert.ok(task.chatId);
  await f.loop.receive({ ...f.message('answer-with-file', 'Use the project identified by this evidence', task.chatId, 'group'),
    attachments: [{ key: 'answer-evidence', kind: 'file', name: 'selection-evidence.log' }] });
  assert.equal(f.feishu.downloads.length, 1);
  const download = f.feishu.downloads[0]; assert.ok(download);
  assert.equal(download.messageId, 'answer-with-file');
  const path = download.destination.replace(/\.partial$/, '');
  assert.deepEqual(await readFile(path), bytes);
  assert.ok(f.codex.selections[1]?.input.some(input => input.kind === 'text' && input.text.includes(path)));
  assert.ok(f.codex.starts[0]?.input.some(input => input.kind === 'text' && input.text.includes(path)));
  assert.match(JSON.stringify(f.codex.starts[0]?.input), /selection-evidence\.log|answer-evidence/);
  assert.equal(f.loop.store.inputs(task.id).find(input => input.id === 'answer-with-file')?.status, 'delivered');
  await f.restart();
  assert.equal(f.feishu.downloads.length, 1);
  assert.equal(f.codex.starts.length, 1);
});

test('a consumed directory answer stays pending for the formal task without repeating selection on restart', async t => {
  const f = await fixture(t);
  f.codex.selectionResults.push({ kind: 'question', question: 'Which project?' }, { kind: 'question', question: 'Which of its variants?' }, selected());
  const task = await f.manual(); assert.ok(task.chatId);
  await f.loop.receive(f.message('first-answer', 'Project A; investigate only.', task.chatId, 'group'));
  const first = f.loop.store.inputs(task.id).find(input => input.id === 'first-answer'); assert.ok(first);
  assert.equal(first.selectionHandled, true); assert.equal(first.status, 'pending');
  await f.loop.tick(); await f.restart(); await f.loop.tick();
  assert.equal(f.codex.selections.length, 2); assert.equal(f.codex.starts.length, 0);
  await f.loop.receive(f.message('second-answer', 'Use variant A1; preserve local changes.', task.chatId, 'group'));
  assert.deepEqual(f.codex.selections[2]?.answers.map(answer => answer.inputId), ['first-answer', 'second-answer']);
  const start = f.codex.starts[0]; assert.ok(start);
  assert.deepEqual(start.additionalDeliveryIds, ['first-answer', 'second-answer']);
  const texts = start.input.filter(input => input.kind === 'text').map(input => input.text);
  assert.ok(texts.indexOf('Project A; investigate only.') < texts.indexOf('Use variant A1; preserve local changes.'));
  assert.ok(f.loop.store.inputs(task.id).every(input => input.status === 'delivered'));
});

for (const historyAvailable of [true, false]) test(`initial task and directory supplements reconcile together when acknowledgement is lost (history=${historyAvailable})`, async t => {
  const f = await fixture(t);
  f.codex.selectionResults.push({ kind: 'question', question: 'Which project?' }, selected());
  const task = await f.manual(); assert.ok(task.chatId);
  f.codex.loseInputAck = true;
  await f.loop.receive(f.message('scope-answer', 'Use project A; do not edit code.', task.chatId, 'group'));
  assert.ok(f.loop.store.inputs(task.id).every(input => input.status === 'uncertain'));
  const established = f.task(); assert.ok(established.threadId);
  if (!historyAvailable) f.codex.snapshot(established.threadId).seenInputIds = [];
  await f.restart(); await f.loop.tick();
  assert.equal(f.codex.starts.length, 1); assert.equal(f.codex.steers.length, 0);
  assert.equal(f.codex.selections.length, 2);
  assert.ok(f.loop.store.inputs(task.id).every(input => input.status === (historyAvailable ? 'delivered' : 'uncertain')));
});

test('a missing previously selected attachment holds the first formal turn until the supplement can be restored', async t => {
  const f = await fixture(t); const bytes = Buffer.from('user-scope-evidence\n');
  f.feishu.resources.set('scope-log', bytes);
  f.codex.selectionResults.push({ kind: 'question', question: 'Which project?' }, selected());
  const task = await f.manual(); assert.ok(task.chatId);
  let path = '';
  const create = f.codex.createThread.bind(f.codex);
  f.codex.createThread = async input => {
    const download = f.feishu.downloads[0]; assert.ok(download);
    path = download.destination.replace(/\.partial$/, ''); await rm(path);
    return create(input);
  };
  await f.loop.receive({ ...f.message('scope-file-answer', 'Use project A and follow these investigation limits.', task.chatId, 'group'),
    attachments: [{ key: 'scope-log', kind: 'file', name: 'limits.log' }] });
  await f.loop.tick(); await f.restart();
  assert.equal(f.codex.starts.length, 0);
  assert.equal(f.loop.store.inputs(task.id).find(input => input.id === 'scope-file-answer')?.status, 'failed');
  await writeFile(path, bytes);
  await f.loop.retryAttachment(task.id, 'scope-file-answer');
  assert.equal(f.codex.starts.length, 1);
  assert.ok(f.codex.starts[0]?.input.some(input => input.kind === 'text' && input.text.includes(path)));
  assert.equal(f.codex.selections.length, 2);
});
