import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAppServer } from '../src/adapters/codex.js';
const workspace = await mkdtemp('/tmp/agent-loop-codex-question-');
const evidence: Record<string, unknown> = { workspace, startedAt: new Date().toISOString(), mode: 'native plan mode via verification-only proxy', scope: 'The production adapter does not select workflow mode.' };
const server = new CodexAppServer({ command: [process.execPath, resolve('scripts/fixtures/codex-plan-proxy.mjs')], approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 30000 });
try {
  const threadId = await server.createThread({ cwd: workspace, instructions: 'Harmless native question verification. Do not use shell, files, network or delegates. Ask only the requested question via the real native request_user_input tool.' });
  evidence.threadId = threadId;
  await server.startTurn({ threadId, deliveryId: 'blocking-question', input: [{ kind: 'text', text: 'Use the actual request_user_input tool to ask which fixture color I prefer. Choices Blue and Green. Wait for my response, then give a final response including the chosen color. Do not ask the question in plain text, do not call other tools and do not ask further questions.' }] });
  const requests = [];
  const responded = new Set<string>();
  let completed = false;
  for (const deadline = Date.now() + 120000; Date.now() < deadline; await delay(200)) {
    const snapshot = await server.inspect(threadId);
    evidence.latest = snapshot;
    for (const request of snapshot.requests) {
      if (request.kind !== 'question' || responded.has(request.id)) continue;
      requests.push(request);
      responded.add(request.id);
      await server.reply({ request, text: 'Blue' });
    }
    if (snapshot.status !== 'running') {
      assert.equal(snapshot.status, 'completed');
      assert.match(snapshot.outputs.filter(item => item.turnId === snapshot.turnId).map(item => item.text).join('\n'), /Blue/);
      completed = true;
      break;
    }
  }
  evidence.requests = requests;
  assert.ok(completed, 'native question turn completed');
  assert.ok(requests.some(request => request.isBlocking), 'observed a blocking native request');
  evidence.result = 'passed';
} catch (error) { evidence.result = 'failed'; evidence.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  try { await server.close(); evidence.cleanup = 'closed'; } catch (error) { evidence.cleanup = String(error); }
  const output = resolve(`execution/codex-question-${Date.now()}.json`);
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, result: evidence.result, error: evidence.error })}\n`);
}
