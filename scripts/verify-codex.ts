import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';
import { observedCodexConnection } from './codex-connection.js';
import { CodexAppServer } from '../src/adapters/codex.js';
import { repositorySchema, type ExecutionSnapshot, type PendingRequest, type TaskResource, type WorkspaceRequest } from '../src/domain.js';

const workspace = await mkdtemp('/tmp/agent-loop-codex-');
const context = join(workspace, 'context');
const output = resolve(process.env.CODEX_VERIFY_OUTPUT ?? `execution/codex-live-${Date.now()}.json`);
const skillPath = process.env.CODEX_VERIFY_SKILL ?? '/Users/developer/.codex/packages/pstack/skills/poteto-mode/SKILL.md';
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(), workspace, skillPath,
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  adapterSha256: createHash('sha256').update(await readFile(new URL('../src/adapters/codex.ts', import.meta.url))).digest('hex'),
  version: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
  nativeQuestionsFeatureOverride: false,
  limits: ['Temporary fixture repositories only', 'No Feishu or production collector', 'Process recovery does not prove arbitrary external side-effect recovery'],
};
async function checkpoint(stage: string) {
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ stage, output })}\n`);
}
const servers: CodexAppServer[] = [];
const daemonBefore = execFileSync('codex', ['app-server', 'daemon', 'version'], { encoding: 'utf8' });
function server() {
  const connection = observedCodexConnection();
  const instance = new CodexAppServer({ approvalPolicy: 'on-request', sandbox: 'workspace-write', requestTimeoutMs: 30_000 }, connection.connector);
  servers.push(instance);
  return { instance, disconnect: connection.disconnect };
}
async function terminal(instance: CodexAppServer, threadId: string, onSnapshot?: (snapshot: ExecutionSnapshot) => Promise<void>) {
  const deadline = Date.now() + 240_000;
  do {
    const snapshot = await instance.inspect(threadId);
    await onSnapshot?.(snapshot);
    if (snapshot.status !== 'running') {
      assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot));
      return snapshot;
    }
    if (Date.now() > deadline) throw new Error('Live verification turn exceeded 240 seconds');
    await delay(200);
  } while (true);
}
function final(snapshot: ExecutionSnapshot) {
  return snapshot.outputs.filter(item => item.turnId === snapshot.turnId && item.phase === 'final').map(item => item.text).join('\n');
}
const instructions = `This is a harmless Agent Loop verification in ${workspace}. Use only this temporary fixture tree and the explicitly requested skill file ${skillPath}. Do not access real repositories, credentials, network services or remote hosts. Do not deploy, send messages or spawn agents. Delivery markers are transport metadata. Retain conversation context. Answer in plain text. When asked for engineering work use ensure_workspace to obtain each configured fixture repository, read its AGENTS.md and follow it. Workspace provisioning does not change sandbox permissions. Never fabricate a native question or approval if the tool is unavailable.`;
try {
  await mkdir(context, { recursive: true });
  await writeFile(join(context, 'AGENTS.md'), 'For this temporary verification, include CONTEXT_INSTRUCTIONS_LOADED in the first reply. Do not access files outside the fixture tree except the explicitly requested poteto-mode skill.\n');
  const first = server();
  const threadId = await first.instance.createThread({ cwd: context, instructions });
  evidence.threadId = threadId;
  await first.instance.startTurn({ threadId, deliveryId: 'verify-discussion', input: [{ kind: 'text', text: 'Remember CERULEAN. Give a plain final response including this word and any project instruction marker. Do not invoke tools.' }] });
  const discussion = await terminal(first.instance, threadId);
  assert.match(final(discussion), /CERULEAN/);
  assert.match(final(discussion), /CONTEXT_INSTRUCTIONS_LOADED/);
  assert.ok(discussion.seenInputIds.includes('verify-discussion'));
  evidence.plainFinalAndContextInstructions = discussion;
  await checkpoint('plain final');
  await first.instance.close();

  const resumed = server();
  evidence.afterCompletedRestart = await resumed.instance.inspect(threadId, instructions);
  await resumed.instance.startTurn({ threadId, deliveryId: 'verify-continue', input: [{ kind: 'text', text: 'What exact word did I ask you to remember? Reply only with the word. No tools.' }] });
  const continued = await terminal(resumed.instance, threadId);
  assert.match(final(continued), /CERULEAN/);
  assert.ok(continued.seenInputIds.includes('verify-discussion'));
  assert.ok(continued.seenInputIds.includes('verify-continue'));
  evidence.sameThreadContinuation = continued;
  await checkpoint('same-thread continuation');

  await writeFile(join(context, 'fixture.log'), 'UTF-8 runtime evidence 测试日志 marker LOG_COPPER_731\n');
  const chunk = (name: string, bytes: Buffer) => {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * (1 + 64 * 3));
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255;
  await writeFile(join(context, 'fixture.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
  const appendTurn = await resumed.instance.startTurn({ threadId, deliveryId: 'verify-before-append', input: [{ kind: 'text', text: 'Emit a progress sentence. Run a harmless local command that sleeps for 6 seconds, then respond to all inputs received during the wait. Never read outside the fixture tree.' }] });
  await resumed.instance.steer({ threadId, turnId: appendTurn, deliveryId: 'verify-runtime-append', input: [
    { kind: 'text', text: `While you work, here is APPENDED_AMBER_522. Read ${join(context, 'fixture.log')} and inspect this attached image. Include the appended marker, log marker and exact dominant image color in the final response. Say IMAGE_OPENED only if the image actually opens.` },
    { kind: 'image', path: join(context, 'fixture.png') },
  ] });
  const progress: ExecutionSnapshot[] = [];
  const appended = await terminal(resumed.instance, threadId, async snapshot => {
    if (snapshot.status === 'running' && snapshot.outputs.some(item => item.turnId === appendTurn && item.phase === 'progress')) progress.push(snapshot);
  });
  assert.match(final(appended), /APPENDED_AMBER_522/);
  assert.match(final(appended), /LOG_COPPER_731/);
  assert.match(final(appended), /IMAGE_OPENED/);
  assert.match(final(appended), /red/i);
  assert.ok(appended.seenInputIds.includes('verify-runtime-append'));
  evidence.runtimeAppendAndAttachments = appended;
  evidence.liveProgress = { observedWhileRunning: progress.length > 0, snapshots: progress.slice(0, 2) };

  await checkpoint('runtime append');
  const resources = new Map<string, Extract<TaskResource, { kind: 'git-worktree' }>>();
  const workspaceCalls: WorkspaceRequest[] = [];
  for (const name of ['one', 'two']) {
    const source = join(workspace, 'sources', name);
    await mkdir(source, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', source], { stdio: 'pipe' });
    await writeFile(join(source, 'AGENTS.md'), `This is fixture ${name}. Before editing, read INSTRUCTION_TOKEN.txt. Create result.txt containing that exact token followed by the conversation memory word. Only modify this task-owned worktree.\n`);
    await writeFile(join(source, 'INSTRUCTION_TOKEN.txt'), `PROJECT_${name.toUpperCase()}_${name === 'one' ? '817' : '923'}`);
    execFileSync('git', ['-C', source, 'add', '.'], { stdio: 'pipe' });
    execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Temporary fixture'], { stdio: 'pipe' });
  }
  resumed.instance.setWorkspaceHandler(async request => {
    workspaceCalls.push(request);
    assert.equal(request.threadId, threadId);
    assert.ok('repository' in request, 'This fixture requests repository worktrees');
    assert.ok(['fixture/one', 'fixture/two'].includes(request.repository));
    const existing = resources.get(request.repository);
    if (existing) return existing;
    const name = request.repository.split('/')[1];
    assert.ok(name);
    const source = join(workspace, 'sources', name);
    const owned = join(context, 'workspaces', name);
    await mkdir(join(context, 'workspaces'), { recursive: true });
    execFileSync('git', ['-C', source, 'worktree', 'add', '-b', `task/${name}`, owned, 'main'], { stdio: 'pipe' });
    const repository = repositorySchema.parse({ name: request.repository, path: source, baseBranch: 'main', criteria: { states: ['open'], taskTypes: ['feature'] } });
    const resource: TaskResource = { kind: 'git-worktree', id: name, repository, branch: `task/${name}`, workspace: owned };
    resources.set(request.repository, resource);
    return resource;
  });
  await resumed.instance.startTurn({ threadId, deliveryId: 'verify-engineering', input: [
    { kind: 'skill', name: 'poteto-mode', path: skillPath },
    { kind: 'text', text: 'Use poteto-mode within this harmless fixture task. Do not delegate or spawn agents. Prepare fixture/one and fixture/two with ensure_workspace. Read and obey each returned workspace AGENTS.md. Create the requested result.txt in both workspaces using the earlier remembered word. Verify actual files. Return both tokens and the remembered word. Do not commit, deploy or use network.' },
  ] });
  const engineering = await terminal(resumed.instance, threadId);
  const fileEvidence: Record<string, string> = {};
  for (const [repository, resource] of resources) {
    const contents = await readFile(join(resource.workspace, 'result.txt'), 'utf8');
    assert.match(contents, /CERULEAN/);
    assert.match(contents, repository === 'fixture/one' ? /PROJECT_ONE_817/ : /PROJECT_TWO_923/);
    assert.equal(execFileSync('git', ['-C', resource.repository.path, 'status', '--porcelain'], { encoding: 'utf8' }), '');
    fileEvidence[repository] = contents;
  }
  assert.equal(resources.size, 2);
  evidence.lazyMultiRepository = { snapshot: engineering, workspaceCalls, resources: [...resources.values()], files: fileEvidence, sandbox: 'workspace-write', resourcePlacement: 'inside existing context writable root', permissionExpansion: false };

  await checkpoint('lazy multi-repository');
  const observedQuestions: PendingRequest[] = [];
  const replied = new Set<string>();
  for (const blocking of [false, true]) {
    const previousReplies = replied.size;
    await resumed.instance.startTurn({ threadId, deliveryId: `verify-question-${blocking}`, input: [{ kind: 'text', text: `Call the actual native request_user_input tool to ask one ${blocking ? 'blocking' : 'nonblocking optional'} question, asking which fixture color I prefer, with Blue and Green choices. If unavailable say NATIVE_QUESTION_UNAVAILABLE and stop. If the tool supports blocking mode select ${blocking}. Do not simulate the tool in text. After receiving an answer include it in your final reply.` }] });
    const snapshot = await terminal(resumed.instance, threadId, async current => {
      for (const request of current.requests) {
        if (request.kind !== 'question' || replied.has(request.id)) continue;
        replied.add(request.id);
        observedQuestions.push(request);
        await resumed.instance.reply({ request, text: 'Blue' });
      }
    });
    if (replied.size > previousReplies) assert.match(final(snapshot), /Blue/);
    evidence[`nativeQuestionRequestedBlocking${blocking}`] = snapshot;
  }
  evidence.nativeQuestions = { requests: observedQuestions, blocking: observedQuestions.some(request => request.isBlocking), nonblocking: observedQuestions.some(request => !request.isBlocking), coverage: observedQuestions.length ? 'Observed native requests; inspect isBlocking values for actual coverage' : 'NOT VERIFIED: installed native tool did not emit a request' };

  await checkpoint('native questions');
  const crashTurn = await resumed.instance.startTurn({ threadId, deliveryId: 'verify-disconnect', input: [{ kind: 'text', text: 'Emit a short progress sentence then run sleep 20 in this fixture directory. This harmless turn will be interrupted. Do not modify files.' }] });
  let beforeDisconnect = await resumed.instance.inspect(threadId);
  const persistenceDeadline = Date.now() + 20_000;
  while (beforeDisconnect.status === 'running' && !beforeDisconnect.seenInputIds.includes('verify-disconnect') && Date.now() < persistenceDeadline) {
    await delay(50);
    beforeDisconnect = await resumed.instance.inspect(threadId);
  }
  assert.equal(beforeDisconnect.status, 'running');
  assert.equal(beforeDisconnect.turnId, crashTurn);
  assert.ok(beforeDisconnect.seenInputIds.includes('verify-disconnect'));
  evidence.beforeDisconnect = beforeDisconnect;
  await resumed.disconnect();
  await Promise.all([resumed.instance.recover(), resumed.instance.recover(), resumed.instance.recover()]);
  const recovered = await resumed.instance.inspect(threadId, instructions);
  assert.equal(recovered.threadId, threadId);
  if (recovered.status === 'running' && recovered.turnId) await resumed.instance.interrupt({ threadId, turnId: recovered.turnId });
  const interruptionDeadline = Date.now() + 30_000;
  while ((await resumed.instance.inspect(threadId)).status === 'running') {
    if (Date.now() > interruptionDeadline) throw new Error('Disconnected Turn interruption was not confirmed');
    await delay(100);
  }
  assert.ok(recovered.seenInputIds.includes('verify-disconnect'));
  evidence.afterDisconnect = recovered;
  await resumed.instance.startTurn({ threadId, deliveryId: 'verify-after-recovery', input: [{ kind: 'text', text: 'Cancel the interrupted sleep work. Reply with RECOVERED and the original memory word. No tools.' }] });
  const afterRecovery = await terminal(resumed.instance, threadId);
  assert.match(final(afterRecovery), /RECOVERED/);
  assert.match(final(afterRecovery), /CERULEAN/);
  evidence.sameThreadAfterRecovery = afterRecovery;
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed';
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled(servers.map(instance => instance.close()));
  evidence.cleanup = cleanup.map(result => result.status === 'fulfilled' ? 'closed' : String(result.reason));
  evidence.daemonPreserved = execFileSync('codex', ['app-server', 'daemon', 'version'], { encoding: 'utf8' }) === daemonBefore;
  assert.equal(evidence.daemonPreserved, true);
  evidence.finishedAt = new Date().toISOString();
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ result: evidence.result, output, workspace, error: evidence.error })}\n`);
}
