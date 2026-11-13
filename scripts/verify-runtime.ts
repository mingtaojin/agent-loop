import { recoverSavedIntake, openDirectGroup } from '../test/saved-intake.js';
import { projectConfigSchema } from '../src/project.js';
import { tickWithCoordinator } from '../test/coordinated-runtime.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import { observedCodexConnection } from './codex-connection.js';
import { CodexAppServer } from '../src/adapters/codex.js';
import { WorkspaceProvider } from '../src/workspace.js';
import { taskSchema, type IncomingMessage, type PendingRequest } from '../src/domain.js';
import { Store } from '../src/store.js';
import { FeishuFake, GitHubFake } from '../test/fakes.js';

const execute = promisify(execFile);
const fixtureRoot = resolve(process.env.RUNTIME_VERIFY_ROOT ?? '.scratch/verification/runtime-fixtures');
await mkdir(fixtureRoot, { recursive: true });
const root = await mkdtemp(join(fixtureRoot, 'workspace-permission-fixture-'));
const output = resolve(`execution/runtime-live-${Date.now()}.json`);
const protocol = join(root, 'protocol.jsonl');
const evidence: Record<string, unknown> = { root, startedAt: new Date().toISOString(), scope: 'Actual AgentLoop, SQLite and WorkspaceProvider with real Codex. Feishu and GitHub are local fakes. Only temporary fixture commands may be approved.', sandbox: 'workspace-write', approvals: [] };
const approvals: { request: PendingRequest; result: string }[] = [];
const quote = (text: string) => `'${text.replaceAll("'", "'\"'\"'")}'`;
const config = configSchema.parse({ dataDir: join(root, 'data'), feishu: { userOpenId: 'fixture-owner' }, engineering: { skillPath: '/Users/developer/.codex/packages/pstack/skills/poteto-mode/SKILL.md' }, codex: { approvalPolicy: 'on-request', sandbox: 'workspace-write', requestTimeoutMs: 30000 } });
for (const name of ['one', 'two']) {
  const path = join(root, name); await mkdir(path);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Runtime Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) await execute('git', ['-C', path, ...args]);
  await writeFile(join(path, 'AGENTS.md'), `This is an isolated verification fixture. Include FIXTURE_${name.toUpperCase()}_RULE in your final answer. Preserve all existing files.\n`);
  await writeFile(join(path, 'tracked.txt'), 'base\n');
  await execute('git', ['-C', path, 'add', '.']); await execute('git', ['-C', path, 'commit', '-m', 'Fixture']);
  await writeFile(join(path, 'tracked.txt'), 'user dirty file\n'); await writeFile(join(path, 'untracked.txt'), 'user untracked file\n');
  config.repositories.push({ name: `fixture/${name}`, path, baseBranch: 'main', criteria: { states: ['open'], assigneesAny: [], taskTypes: ['bug'], labelsAll: [], labelsAny: [], labelsNone: [], nativeTypes: { Bug: 'bug' }, typeLabels: { bug: 'bug' } } });
}
config.projects.push(projectConfigSchema.parse({ id: 'fixture', name: 'Fixture', directory: root, repositories: config.repositories.map(repository => ({ name: repository.name, criteria: repository.criteria })), instructions: 'Isolated verification. The harness dispatches intakes explicitly. Do not dispatch additional tasks, access network or real projects, or perform delivery operations.' }));
const feishu = new FeishuFake(), github = new GitHubFake();
const servers: CodexAppServer[] = [];
let codex = new CodexAppServer(config.codex, observedCodexConnection({ recordPath: protocol }).connector); servers.push(codex);
let loop = new AgentLoop(config, { codex, feishu, github, workspace: new WorkspaceProvider(config.dataDir) });
const message = (id: string, text: string, chatId = 'private', chatType: 'p2p' | 'group' = 'p2p'): IncomingMessage => ({ id, text, chatId, chatType, senderId: 'fixture-owner', attachments: [], createdAt: Date.now() });
const allowed = new Set<string>();
function authorizedCommand(command: string): boolean {
  return [...allowed].some(expected => [expected, `/bin/zsh -lc ${quote(expected)}`, `/bin/bash -lc ${quote(expected)}`, `/bin/zsh -lc ${JSON.stringify(expected)}`, `/bin/bash -lc ${JSON.stringify(expected)}`].includes(command.trim()));
}
async function settle(taskId: string) {
  const handled = new Set<string>();
  for (const deadline = Date.now() + 240000; Date.now() < deadline; await delay(1000)) {
    await loop.tick();
    const task = loop.store.task(taskId);
    for (const request of task.requests) {
      if (handled.has(request.id)) continue;
      handled.add(request.id);
      if (request.kind !== 'approval' || !request.payload || typeof request.payload !== 'object' || !('command' in request.payload) || typeof request.payload.command !== 'string' || !authorizedCommand(request.payload.command)) {
        evidence.unapprovedRequest = request;
        throw new Error('Verification refused a request outside the exact temporary command allowlist');
      }
      await loop.approve({ id: `fixture:${request.id}`, taskId, threadId: request.threadId, turnId: request.turnId, requestId: request.id, decision: 'approve', chatId: task.chatId!, senderId: 'fixture-owner', epoch: request.connectionEpoch });
      await loop.control(taskId, 'status');
      approvals.push({ request, result: loop.store.approvals(taskId).at(-1)?.status ?? 'missing' });
    }
    if (task.status === 'idle') return task;
    if (task.status === 'failed') throw new Error(task.reason ?? 'Runtime task failed');
  }
  throw new Error('Live Runtime fixture exceeded verification deadline');
}
function engineering(taskId: string, label: string): string {
  const commands = config.repositories.map(repository => {
    const id = createHash('sha256').update(repository.name).digest('hex').slice(0, 16);
    const path = join(config.dataDir, 'workspaces', `${taskId}--${id}`, 'runtime-result.txt');
    const command = `printf ${label}_${repository.name.endsWith('one') ? 'ONE' : 'TWO'} > ${quote(path)}`;
    allowed.add(command);
    return `${repository.name}: ${command}`;
  });
  const capability = join(config.dataDir, 'workspace-capabilities', `${taskId}.json`);
  for (const repository of config.repositories) allowed.add(`${quote(process.execPath)} ${quote(resolve('src/workspace-client.ts'))} ${quote(capability)} ${quote(repository.name)}`);
  return `Use the configured poteto-mode skill for this tiny authorized engineering task. No delegates, external network, credentials, or real repositories. Obtain fixture/one and fixture/two through ensure_workspace, or the current Runtime shell fallback if native tool is unavailable. Do not create worktrees yourself. Read each returned AGENTS.md. In each returned workspace execute its exact command below using the shell tool, requesting native command permission if the sandbox blocks access. Do not use apply_patch or change other files. Give one progress update and a plain final answer including the project instruction markers and our earlier memory word.\n${commands.join('\n')}`;
}
try {
  await recoverSavedIntake(loop, message('new', 'This request belongs to the supplied Fixture project. Remember RUNTIME_NEW_MEMORY. Reply briefly without tools.'));
  await tickWithCoordinator(loop);
  for (const saved of loop.tasks()) if (loop.projects.ledger.membership(saved.id)?.role === 'worker') await openDirectGroup(loop, saved.id);
  const task = loop.tasks().find(task => !task.sourceId.startsWith('project:'));  assert.ok(task);
  await settle(task.id); assert.equal(loop.store.task(task.id).resources.length, 1);
  await loop.receive(message('engineering', engineering(task.id, 'RUNTIME_NEW'), task.chatId!, 'group'));
  await settle(task.id);
  let current = loop.store.task(task.id); assert.equal(current.resources.filter(resource => resource.kind !== 'project').length, 2);
  for (const resource of current.resources.filter(resource => resource.kind !== 'project')) {
    assert.equal(resource.kind, 'git-worktree', 'This fixture requests configured repository worktrees');
    assert.equal(await readFile(join(resource.workspace, 'runtime-result.txt'), 'utf8'), `RUNTIME_NEW_${resource.repository.name.endsWith('one') ? 'ONE' : 'TWO'}`);
  }
  evidence.newThread = { task: current, outputs: loop.store.outputs(task.id), approvals: loop.store.approvals(task.id) };
  await loop.close();

  const legacyCwd = join(root, 'legacy-context'); await mkdir(legacyCwd);
  const legacy = new CodexAppServer(config.codex, observedCodexConnection({ recordPath: protocol, legacy: true }).connector); servers.push(legacy);
  const legacyThread = await legacy.createThread({ cwd: legacyCwd, instructions: 'Harmless temporary fixture. Remember the user memory word. Do not use tools yet. Future engineering uses current Runtime instructions. No network, credentials or real repositories.' });
  await legacy.startTurn({ threadId: legacyThread, deliveryId: 'legacy-memory', input: [{ kind: 'text', text: 'Remember RUNTIME_LEGACY_MEMORY and reply briefly.' }] });
  for (const deadline = Date.now() + 120000; Date.now() < deadline; await delay(1000)) { if ((await legacy.inspect(legacyThread)).status !== 'running') break; }
  const before = await legacy.inspect(legacyThread); assert.equal(before.status, 'completed'); await legacy.close();
  const store = new Store(config.dataDir);
  const legacyId = 'legacy-fixture'; const oldMessage = message('legacy-source', '/new legacy discussion');
  store.saveTask(taskSchema.parse({ id: legacyId, sourceId: 'manual-legacy', source: { kind: 'manual', message: oldMessage }, contextDirectory: legacyCwd, resources: [], status: 'idle', reason: null, prompt: 'legacy', promptHash: 'legacy', skillPath: config.engineering?.skillPath ?? null, chatId: 'chat-legacy', threadId: legacyThread, turnId: before.turnId, executionStatus: 'completed', lastHandledTurnId: before.turnId, requests: [], createdAt: Date.now(), updatedAt: Date.now(), legacy: { status: 'waiting_user', prUrl: null } }));
  feishu.groups.set(legacyId, 'chat-legacy');
  codex = new CodexAppServer(config.codex, observedCodexConnection({ recordPath: protocol }).connector); servers.push(codex); loop = new AgentLoop(config, { codex, feishu, github, workspace: new WorkspaceProvider(config.dataDir) }, store);
  await loop.projects.adopt(legacyId, 'fixture');
  await loop.recover();
  await loop.receive(message('legacy-engineering', engineering(legacyId, 'RUNTIME_LEGACY'), 'chat-legacy', 'group'));
  await settle(legacyId);
  current = loop.store.task(legacyId); assert.equal(current.threadId, legacyThread); assert.equal(current.resources.filter(resource => resource.kind !== 'project').length, 2);
  for (const resource of current.resources.filter(resource => resource.kind !== 'project')) {
    assert.equal(resource.kind, 'git-worktree', 'This fixture requests configured repository worktrees');
    assert.equal(await readFile(join(resource.workspace, 'runtime-result.txt'), 'utf8'), `RUNTIME_LEGACY_${resource.repository.name.endsWith('one') ? 'ONE' : 'TWO'}`);
  }
  const legacyText = loop.store.outputs(legacyId).map(value => value.text).join('\n');
  assert.match(legacyText, /RUNTIME_LEGACY_MEMORY/); assert.match(legacyText, /FIXTURE_ONE_RULE/); assert.match(legacyText, /FIXTURE_TWO_RULE/);
  evidence.legacyThread = { before, task: current, outputs: loop.store.outputs(legacyId), approvals: loop.store.approvals(legacyId) };
  for (const repository of config.repositories) {
    assert.ok('path' in repository, 'This fixture configures local repository paths');
    assert.equal(await readFile(join(repository.path, 'tracked.txt'), 'utf8'), 'user dirty file\n');
    assert.equal(await readFile(join(repository.path, 'untracked.txt'), 'utf8'), 'user untracked file\n');
  }
  evidence.result = 'passed';
} catch (error) { evidence.result = 'failed'; evidence.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  evidence.approvals = approvals;
  try { await loop.close(); evidence.cleanup = 'closed'; } catch (error) { evidence.cleanup = String(error); }
  evidence.serverCleanup = await Promise.all(servers.map(async server => { try { await server.close(); return 'closed'; } catch (error) { return String(error); } }));
  evidence.protocol = protocol; evidence.finishedAt = new Date().toISOString();
  await mkdir(resolve('execution'), { recursive: true }); await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, result: evidence.result, error: evidence.error })}\n`);
}
