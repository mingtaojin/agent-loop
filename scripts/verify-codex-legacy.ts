import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAppServer } from '../src/adapters/codex.js';
const workspace = await mkdtemp('/tmp/agent-loop-codex-legacy-');
const evidence: Record<string, unknown> = { workspace, startedAt: new Date().toISOString(), protocol: 'codex-cli 0.166.0', purpose: 'Create a real Thread without dynamic tools, then try adding the tool during same-Thread resume.' };
const servers: CodexAppServer[] = [];
const instructions = 'Harmless protocol verification in a temporary empty directory. No shell, external network, credentials, or real repositories. Only call ensure_workspace if that exact native tool is available. If unavailable, say NATIVE_WORKSPACE_TOOL_UNAVAILABLE. Remember user context.';
function server(tryResumeTools = false) {
  const instance = new CodexAppServer({ command: [process.execPath, resolve('scripts/fixtures/codex-legacy-proxy.mjs'), ...(tryResumeTools ? ['--try-resume-tools'] : [])], approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 30000 });
  servers.push(instance);
  return instance;
}
async function terminal(instance: CodexAppServer, threadId: string) {
  for (const deadline = Date.now() + 120000; Date.now() < deadline; await delay(200)) {
    const snapshot = await instance.inspect(threadId);
    if (snapshot.status !== 'running') return snapshot;
  }
  throw new Error('Native legacy probe exceeded 120 seconds');
}
try {
  const original = server();
  const threadId = await original.createThread({ cwd: workspace, instructions: `${instructions} Include OLD_RUNTIME_INSTRUCTION in every final reply.` });
  evidence.threadId = threadId;
  await original.startTurn({ threadId, deliveryId: 'legacy-before', input: [{ kind: 'text', text: 'Remember LEGACY_VIOLET. Reply with this word without tools.' }] });
  const beforeMigration = await terminal(original, threadId);
  evidence.beforeMigration = beforeMigration;
  assert.match(beforeMigration.outputs.map(item => item.text).join('\n'), /OLD_RUNTIME_INSTRUCTION/);
  await original.close();
  const resumed = server(true);
  const calls: unknown[] = [];
  resumed.setWorkspaceHandler(async request => { calls.push(request); throw new Error('Probe records availability without creating a repository'); });
  evidence.resumed = await resumed.inspect(threadId, `${instructions} Include NEW_RUNTIME_INSTRUCTION in every final reply. The current Runtime instructs you to use ensure_workspace for fixture/one.`);
  await resumed.startTurn({ threadId, deliveryId: 'legacy-after', input: [{ kind: 'text', text: 'Give the exact memory word and call the actual ensure_workspace tool for fixture/one if it is available. Do not simulate the tool. If unavailable say NATIVE_WORKSPACE_TOOL_UNAVAILABLE.' }] });
  const snapshot = await terminal(resumed, threadId);
  const text = snapshot.outputs.filter(item => item.turnId === snapshot.turnId).map(item => item.text).join('\n');
  assert.match(text, /LEGACY_VIOLET/);
  evidence.afterMigration = snapshot;
  evidence.workspaceCalls = calls;
  evidence.instructionOverride = { newMarkerPresent: text.includes('NEW_RUNTIME_INSTRUCTION'), oldMarkerPresent: text.includes('OLD_RUNTIME_INSTRUCTION') };
  assert.match(text, /NEW_RUNTIME_INSTRUCTION/);
  assert.doesNotMatch(text, /OLD_RUNTIME_INSTRUCTION/);
  evidence.result = calls.length ? 'TOOL AVAILABLE' : /NATIVE_WORKSPACE_TOOL_UNAVAILABLE/.test(text) ? 'CONFIRMED GAP: same-Thread resume ignored dynamicTools' : 'INCONCLUSIVE';
} catch (error) { evidence.result = 'failed'; evidence.error = String(error); process.exitCode = 1; }
finally {
  evidence.cleanup = await Promise.all(servers.map(async instance => { try { await instance.close(); return 'closed'; } catch (error) { return String(error); } }));
  const output = resolve(`execution/codex-legacy-${Date.now()}.json`);
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, result: evidence.result })}\n`);
}
