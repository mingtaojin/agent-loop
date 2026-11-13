import { recoverSavedIntake, recoverSavedSupplement, openDirectGroup } from '../test/saved-intake.js';
import { tickWithCoordinator } from '../test/coordinated-runtime.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { loadConfig, configSchema } from '../src/config.js';
import { AgentLoop } from '../src/loop.js';
import { CodexAppServer } from '../src/adapters/codex.js';
import { FeishuFake, GitHubFake } from '../test/fakes.js';
import { WorkspaceProvider } from '../src/workspace.js';
import type { IncomingMessage } from '../src/domain.js';

type SelectionRequest = Omit<Parameters<CodexAppServer['selectWorkspace']>[0], 'signal'>;
type SelectionEvidence = {
  request: SelectionRequest;
  response: Awaited<ReturnType<CodexAppServer['selectWorkspace']>>;
  childrenBefore: number[];
  childrenAfter: number[];
};
type ExecutionExpectation = {
  name: string;
  directory: string;
  resultFile: string;
  marker: string;
  evidenceToken: string;
  supplements: string[];
  source: IncomingMessage;
  answer: IncomingMessage | null;
};

const production = await loadConfig(resolve(process.env.CODEX_VERIFY_CONFIG ?? 'config.json'));
const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-loop-workspace-live-')));
const projectRoot = join(root, 'projects');
const audio = join(projectRoot, 'audio'), portal = join(projectRoot, 'portal');
await mkdir(join(audio, 'modules', 'engine'), { recursive: true });
await mkdir(join(portal, 'versions', 'v1'), { recursive: true });
for (const { directory, service, token } of [
  { directory: audio, service: 'SPECTRAL_DESK_482', token: 'AUDIO_README_638' },
  { directory: portal, service: 'ACCOUNT_GATE_973', token: 'PORTAL_README_295' },
]) {
  await writeFile(join(directory, 'README.md'), `Synthetic project. Service identity: ${service}.\nEvidence token: ${token}\n`);
  await writeFile(join(directory, 'AGENTS.md'), 'Only this temporary fixture and supplied task attachments are in scope. Do not delegate, use network, commit, deploy, access real projects, or modify existing files. Only the result file explicitly requested for the current task may be created in this project. Generate its cwd with the running Node process.cwd(), read README.md for its evidence token, and read any supplied evidence attachments.\n');
}
await writeFile(join(audio, 'modules', 'engine', 'README.md'), 'Nested module, not a separate project entry.\n');
await writeFile(join(portal, 'versions', 'v1', 'README.md'), 'Nested version, not a separate project entry.\n');
const config = configSchema.parse({
  dataDir: join(root, 'data'), repositories: [],
  engineering: { ...production.engineering, projectRoot },
  feishu: { userOpenId: 'fixture-owner' }, recovery: { maxAttempts: 0 },
  codex: { ...production.codex, approvalPolicy: 'never', sandbox: 'workspace-write' },
});
assert.deepEqual(config.repositories, []);
assert.equal(config.engineering?.projectRoot, projectRoot);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ![
  production.feishu.appIdEnv, production.feishu.appSecretEnv, production.github.tokenEnv,
].includes(name)));
const codex = new CodexAppServer({ ...config.codex, env });
const feishu = new FeishuFake();
const selections: SelectionEvidence[] = [];
const executions: Record<string, unknown>[] = [];
const report: Record<string, unknown> = {
  root, projectRoot, startedAt: new Date().toISOString(), selections, executions,
  boundaries: 'Real Codex with temporary fixtures and synthetic platforms. No production tasks or real-project writes, external platform writes, deployments, restarts, or native permission grants.',
  permissions: { sandbox: config.codex.sandbox, approvalPolicy: config.codex.approvalPolicy },
};
const reportPath = join(root, 'report.json');
console.log(JSON.stringify({ fixture: root, report: reportPath }));
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
const execute = promisify(execFile);

async function childProcesses(): Promise<number[]> {
  const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,comm=']);
  return stdout.split('\n').flatMap(line => {
    const [pid, parent, ...command] = line.trim().split(/\s+/);
    return Number(parent) === process.pid && !/(^|\/)ps$/.test(command.join(' ')) ? [Number(pid)] : [];
  }).sort((a, b) => a - b);
}

async function projectFiles(directory = projectRoot, prefix = ''): Promise<Record<string, string | null>> {
  const files: Record<string, string | null> = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name), name = join(prefix, entry.name);
    assert.ok(entry.isDirectory() || entry.isFile(), `Unexpected fixture entry ${path}`);
    files[name] = entry.isDirectory() ? null : await readFile(path, 'utf8');
    if (entry.isDirectory()) Object.assign(files, await projectFiles(path, name));
  }
  return files;
}

const expectedFiles = await projectFiles();
const select = codex.selectWorkspace.bind(codex);
codex.selectWorkspace = async input => {
  const { signal, ...request } = input;
  const captured = structuredClone(request);
  assert.deepEqual(captured.candidates.map(candidate => candidate.name).sort(), ['audio', 'portal']);
  assert.ok(captured.candidates.every(candidate => 'kind' in candidate && candidate.kind === 'project'));
  const filesBefore = await projectFiles();
  const childrenBefore = await childProcesses();
  const response = await select(input);
  const childrenAfter = await childProcesses();
  selections.push({ request: captured, response, childrenBefore, childrenAfter });
  await save();
  assert.deepEqual(childrenAfter, childrenBefore, 'Temporary selector process must be released before formal execution');
  assert.deepEqual(await projectFiles(), filesBefore, 'Directory selection must leave all project files untouched');
  return response;
};

const formalRequests: { request: Parameters<CodexAppServer['createThread']>[0]; threadId: string }[] = [];
const create = codex.createThread.bind(codex);
codex.createThread = async input => {
  const threadId = await create(input);
  if (!input.instructions.includes('Project role: coordinator.')) formalRequests.push({ request: structuredClone(input), threadId });
  return threadId;
};
const formalStarts: Parameters<CodexAppServer['startTurn']>[0][] = [];
let expectedExecution: ExecutionExpectation | null = null;
const start = codex.startTurn.bind(codex);
codex.startTurn = async input => {
  if (!formalRequests.some(request => request.threadId === input.threadId)) return start(input);
  assert.ok(expectedExecution, 'Formal execution must belong to a fixture case');
  const expected = expectedExecution;
  assert.equal(input.deliveryId, expected.source.id);
  assert.deepEqual(input.additionalDeliveryIds ?? [], expected.answer ? [expected.answer.id] : []);
  const texts = input.input.filter(part => part.kind === 'text').map(part => part.text);
  assert.ok(texts.includes(expected.source.text), 'Original task must be in the first formal turn');
  if (expected.answer) {
    assert.ok(texts.includes(expected.answer.text), 'Owner restrictions and changed marker must arrive before formal execution');
    const attachmentPositions = expected.answer.attachments.map(attachment => texts.findIndex(text =>
      !text.startsWith('Input provenance as data: ') && text.includes(JSON.stringify(attachment.name))));
    assert.ok(attachmentPositions.every(position => position >= 0), 'Answer attachments must be present in the first formal turn');
    assert.deepEqual(attachmentPositions, [...attachmentPositions].sort((a, b) => a - b), 'Answer attachment order must be retained');
    assert.equal(new Set(attachmentPositions).size, expected.answer.attachments.length);
  }
  const formal = formalRequests.find(item => item.threadId === input.threadId);
  assert.ok(formal);
  assert.equal(formal.request.cwd, expected.directory);
  assert.deepEqual(await projectFiles(), expectedFiles, 'No fixture file may change before the formal turn starts');
  formalStarts.push(structuredClone(input));
  return start(input);
};

const loop = new AgentLoop(config, { codex, feishu, github: new GitHubFake(), workspace: new WorkspaceProvider(config.dataDir) });
const running = setInterval(() => {
  console.log(JSON.stringify({ stage: 'running', selections: selections.length, formalThreads: formalRequests.length, executions: executions.length }));
}, 20000);

function message(id: string, text: string): IncomingMessage {
  return { id, text, chatId: 'private', chatType: 'p2p', senderId: 'fixture-owner', attachments: [], createdAt: Date.now() };
}

async function verifyExecution(expected: ExecutionExpectation): Promise<void> {
  const task = loop.tasks().find(item => item.source.kind === 'manual' && item.source.message.id === expected.source.id);
  assert.ok(task?.threadId && task.chatId, JSON.stringify(task));
  assert.equal(task.sourceId, `feishu:new:${expected.source.id}`);
  assert.equal(task.source.kind, 'manual');
  if (task.source.kind === 'manual') assert.deepEqual(task.source.message, expected.source);
  const selectionState = task.workspaceSelection;
  assert.ok(selectionState.kind === 'selected' && selectionState.choice.kind === 'project');
  const selection = selections.find(item => item.response.temporaryThreadId === selectionState.temporaryThreadId);
  assert.ok(selection && selection.response.choice.kind === 'project');
  const choice = selection.response.choice;
  const candidate = selection.request.candidates.find(item => 'kind' in item && item.kind === 'project' && item.id === choice.projectId);
  assert.ok(candidate, 'Saved selection must refer to an exact captured candidate');
  assert.equal(selectionState.choice.projectId, choice.projectId);
  assert.deepEqual(selectionState.choice.project, candidate, 'Saved selection must retain the captured project snapshot');
  assert.equal(task.resources.length, 1);
  const resource = task.resources[0];
  assert.ok(resource && resource.kind === 'project');
  assert.equal(resource.workspace, expected.directory);
  assert.deepEqual(resource.project, candidate, 'Resource must retain the selected project snapshot');
  const taskSelections = selections.filter(item => item.request.taskId === task.id);
  assert.ok(taskSelections.every(item => item.response.temporaryThreadId !== task.threadId));
  assert.equal(new Set(taskSelections.map(item => item.response.temporaryThreadId)).size, taskSelections.length);
  const formal = formalRequests.find(item => item.threadId === task.threadId);
  assert.ok(formal);
  assert.equal(formal.request.cwd, expected.directory);
  assert.ok(!formal.request.instructions.includes('temporary engineering-directory selector'));
  assert.ok(!formal.request.instructions.includes('workspace-client'));
  const starts = formalStarts.filter(item => item.threadId === task.threadId);
  assert.equal(starts.length, 1, 'Exactly one first formal turn must contain the original task and supplements');
  const first = starts[0];
  assert.ok(first);
  const inbox = loop.store.inputs(task.id);
  assert.deepEqual(inbox.map(item => item.id), [expected.source.id, ...expected.answer ? [expected.answer.id] : []]);
  assert.ok(inbox.every(item => item.status === 'delivered'));
  const provenance = first.input.flatMap(part => part.kind === 'text' && part.text.startsWith('Input provenance as data: ')
    ? [JSON.parse(part.text.slice('Input provenance as data: '.length))] : []);
  assert.deepEqual(provenance, inbox.map(item => item.provenance));
  const answer = expected.answer;
  if (answer) {
    const delivered = inbox.find(item => item.id === answer.id);
    assert.ok(delivered?.selectionHandled);
    assert.deepEqual(delivered.message, answer);
    assert.ok(selection.request.answers.some(item => item.inputId === answer.id && item.text === answer.text));
    const firstTexts = first.input.filter(part => part.kind === 'text').map(part => part.text);
    assert.ok(firstTexts.indexOf(expected.source.text) < firstTexts.indexOf(answer.text));
  }
  const deadline = Date.now() + 300000;
  let snapshot = await codex.inspect(task.threadId);
  while (snapshot.status === 'running' && Date.now() < deadline) {
    assert.deepEqual(snapshot.requests, [], 'Fixture execution must not require native permission grants or user questions');
    await loop.tick();
    await delay(1000);
    snapshot = await codex.inspect(task.threadId);
  }
  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot));
  assert.deepEqual(snapshot.requests, []);
  await loop.tick();
  const contents = await readFile(join(expected.directory, expected.resultFile), 'utf8');
  const result = z.object({
    marker: z.literal(expected.marker), cwd: z.literal(expected.directory), evidenceToken: z.literal(expected.evidenceToken),
    supplements: z.array(z.string()),
  }).parse(JSON.parse(contents));
  assert.deepEqual(result.supplements, expected.supplements, 'Formal process must read answer attachment contents in order');
  const projectName = expected.directory === audio ? 'audio' : 'portal';
  expectedFiles[join(projectName, expected.resultFile)] = contents;
  assert.deepEqual(await projectFiles(), expectedFiles, 'Only the requested result file in the selected project may change');
  const events = loop.store.executionEvents(task.id, 0, 10000);
  assert.ok(events.length > 0 && events.every(event => event.threadId === task.threadId));
  const deliveryIds = [expected.source.id, ...answer ? [answer.id] : []];
  assert.ok(deliveryIds.every(id => snapshot.seenInputIds.includes(id)), 'Actual formal history must retain every delivery identity');
  executions.push({
    name: expected.name, taskId: task.id, sourceId: task.sourceId,
    temporaryThreadIds: taskSelections.map(item => item.response.temporaryThreadId), formalThreadId: task.threadId,
    candidate, resource, formalCwd: formal.request.cwd, resultFile: join(expected.directory, expected.resultFile), result,
    firstTurnDeliveryIds: [first.deliveryId, ...first.additionalDeliveryIds ?? []], seenInputIds: snapshot.seenInputIds,
    userSupplementInFirstTurn: answer !== null, selectionChildrenReleased: true, formalEventsOnly: true,
  });
  await save();
}

try {
  await save();
  const automatic: ExecutionExpectation = {
    name: 'automatic', directory: audio, resultFile: 'automatic-result.json', marker: 'AUTO_DISCOVERY_482',
    evidenceToken: 'AUDIO_README_638', supplements: [], answer: null,
    source: message('fixture-auto-source', 'Locate the first-level project whose README.md identifies service SPECTRAL_DESK_482. Read candidates only as needed to choose the project. Then in the formal task read its README.md and create only automatic-result.json using a running Node process. Set marker="AUTO_DISCOVERY_482", cwd=process.cwd(), evidenceToken to the value read from README.md, and supplements=[]. Read the actual result back and verify it. Do not delegate, access network or real projects, change existing files, commit, deploy, or write into another project. The matching README is sufficient evidence; no owner confirmation is needed.'),
  };
  expectedExecution = automatic;
  await recoverSavedIntake(loop, automatic.source); await tickWithCoordinator(loop);
  for (const saved of loop.tasks()) if (loop.projects.ledger.membership(saved.id)?.role === 'worker') await openDirectGroup(loop, saved.id);
  assert.equal(selections.length, 1);
  assert.equal(selections[0]?.response.choice.kind, 'project');
  assert.equal(formalRequests.length, 1);
  await verifyExecution(automatic);

  const answered: ExecutionExpectation = {
    name: 'directory-answer', directory: portal, resultFile: 'answer-result.json', marker: 'ANSWER_DISCOVERY_761',
    evidenceToken: 'PORTAL_README_295', supplements: ['ANSWER_EVIDENCE_FIRST_847', 'ANSWER_EVIDENCE_SECOND_526'], answer: null,
    source: message('fixture-answer-source', 'Create answer-result.json in one of the audio or portal projects, with marker="ORIGINAL_MARKER_761", cwd from the running Node process.cwd(), evidenceToken read from the chosen README.md, and supplements=[]. Read the actual result back and verify it. The target is intentionally unspecified and must first be confirmed by the owner, even if directory inspection suggests a possible target. Ask which directory and wait. Only the chosen project result file may be created. Do not modify existing files, delegate, access network or real projects, commit, or deploy.'),
  };
  expectedExecution = answered;
  await recoverSavedIntake(loop, answered.source);
  const waiting = loop.tasks().find(item => item.source.kind === 'manual' && item.source.message.id === answered.source.id);
  assert.ok(waiting && !waiting.chatId && !waiting.threadId);
  assert.ok(loop.store.meta(`project-intake-question:${waiting.id}`));
  assert.equal(waiting.resources.length, 0);
  assert.equal(selections.length, 2);
  assert.equal(selections[1]?.response.choice.kind, 'question');
  assert.equal(formalRequests.length, 1, 'Directory question must not start a formal task');
  assert.equal(formalStarts.length, 1);
  assert.deepEqual(await projectFiles(), expectedFiles);
  const directoryQuestion = z.object({ question: z.string() }).parse(JSON.parse(loop.store.meta(`project-intake-question:${waiting.id}`)!)).question;
  assert.ok(feishu.sent.some(output => output.chatId === answered.source.chatId && output.text.includes(directoryQuestion)));

  answered.answer = {
    ...message('fixture-directory-answer', 'Use the portal project. Supplement the original task before executing it. Replace the original marker with "ANSWER_DISCOVERY_761". Read both attached evidence files in the supplied order and put their trimmed contents into supplements. Restrictions still apply. Only portal/answer-result.json may be created; do not change existing files, write into audio, delegate, access network or real projects, commit, or deploy. Use the actual running Node process.cwd() and read the portal README.md evidence token.'),
    chatId: answered.source.chatId, chatType: 'p2p',
    attachments: [
      { kind: 'file', key: 'fixture-answer-first', name: 'first-evidence.txt' },
      { kind: 'file', key: 'fixture-answer-second', name: 'second-evidence.txt' },
    ],
  };
  for (const [index, attachment] of answered.answer.attachments.entries()) {
    const supplement = answered.supplements[index];
    assert.ok(supplement);
    feishu.resources.set(attachment.key, Buffer.from(`${supplement}\n`));
  }
  const savedAnswerTask = loop.store.taskForSource(`feishu:new:${answered.source.id}`); assert.ok(savedAnswerTask);
  await recoverSavedSupplement(loop, savedAnswerTask.id, answered.answer); await tickWithCoordinator(loop);
  for (const saved of loop.tasks()) if (loop.projects.ledger.membership(saved.id)?.role === 'worker') await openDirectGroup(loop, saved.id);
  assert.equal(selections.length, 3);
  assert.equal(formalRequests.length, 2);
  await verifyExecution(answered);
  assert.equal(new Set(formalRequests.map(item => item.threadId)).size, 2);
  assert.equal(formalStarts.length, 2);
  expectedExecution = null;

  const captured = selections[0]?.request;
  assert.ok(captured);
  const discussion = await codex.selectWorkspace({
    taskId: 'fixture-discussion', cwd: root, candidates: structuredClone(captured.candidates),
    input: [{ kind: 'text', text: 'Discuss only the arithmetic of 2+2. Do not access or modify any project.' }], answers: [],
  });
  assert.equal(discussion.choice.kind, 'none');
  report.discussion = discussion;
  await save();
  const question = await codex.selectWorkspace({
    taskId: 'fixture-question', cwd: root, candidates: structuredClone(captured.candidates),
    input: [{ kind: 'text', text: 'Fix login in either audio or portal. The target is deliberately unspecified. Only the owner can identify it; ask which directory before doing any work.' }], answers: [],
  });
  assert.equal(question.choice.kind, 'question');
  report.question = question;
  assert.equal(formalRequests.length, 2);
  assert.deepEqual(await projectFiles(), expectedFiles);
  assert.equal(new Set(selections.map(item => item.response.temporaryThreadId)).size, selections.length);
  assert.ok(selections.every(selection => formalRequests.every(formal => formal.threadId !== selection.response.temporaryThreadId)));
  report.passed = true;
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ passed: true, report: reportPath, executions, discussion: discussion.choice.kind, ambiguity: question.choice.kind }));
} catch (error) {
  report.passed = false;
  report.error = String(error);
  report.diagnostics = loop.store.diagnostics();
  await save();
  throw error;
} finally {
  clearInterval(running);
  await loop.close();
}
