import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAppServer } from '../src/adapters/codex.js';
import { RejectedInputError, type PendingRequest } from '../src/domain.js';
const workspace = await mkdtemp('/tmp/agent-loop-codex-approval-');
const evidence: Record<string, unknown> = { workspace, startedAt: new Date().toISOString(), sandbox: 'read-only', approvalPolicy: 'on-request', scope: 'Only approve the exact harmless fixture command after validating its native request.' };
const server = new CodexAppServer({ command: ['codex', 'app-server'], approvalPolicy: 'on-request', sandbox: 'read-only', requestTimeoutMs: 30000 });
try {
  const threadId = await server.createThread({ cwd: workspace, instructions: `Harmless native approval verification. Access only ${workspace}. Never use network, credentials, other repositories or delegates. Run only the exact fixture command supplied by the user. Request native approval for that command. If rejected, stop without trying alternative execution. Do not emulate approvals in text.` });
  evidence.threadId = threadId;
  for (const decision of ['reject', 'approve'] as const) {
    const target = `${workspace}/${decision}.txt`;
    const command = `printf NATIVE_${decision.toUpperCase()} > ${target}`;
    await server.startTurn({ threadId, deliveryId: `native-${decision}`, input: [{ kind: 'text', text: `This test authorizes asking for a native command approval for exactly this harmless command: ${command}\nUse the native exec command tool with sandbox_permissions=require_escalated and a one-line justification. The test controller will ${decision} this request. Do not use apply_patch, another command, or ordinary chat as approval. After the native decision, report the result and stop.` }] });
    const requests: PendingRequest[] = [];
    const responses: unknown[] = [];
    const answered = new Set<string>();
    let completed = false;
    for (const deadline = Date.now() + 120000; Date.now() < deadline; await delay(200)) {
      const snapshot = await server.inspect(threadId);
      evidence[`${decision}Latest`] = snapshot;
      for (const request of snapshot.requests) {
        if (!['approval', 'permissions'].includes(request.kind) || answered.has(request.id)) continue;
        requests.push(request);
        answered.add(request.id);
        assert.equal(request.kind, 'approval', 'Only an exact command approval is authorized in this verification');
        assert.ok(typeof request.payload === 'object' && request.payload !== null && 'command' in request.payload);
        assert.ok([command, `/bin/zsh -lc '${command}'`, `/bin/bash -lc '${command}'`].includes(String(request.payload.command)), 'Approve only the exact fixture command or its native shell wrapper');
        await assert.rejects(server.reply({ request, text: 'approve' }), RejectedInputError);
        const result = await server.respondApproval({ request, decision });
        responses.push({ id: request.id, decision, result });
        assert.equal(result, 'confirmed');
        await assert.rejects(server.respondApproval({ request, decision }), RejectedInputError);
      }
      if (snapshot.status !== 'running') { assert.equal(snapshot.status, 'completed'); completed = true; break; }
    }
    evidence[decision] = { requests, responses, completed };
    assert.ok(completed);
    if (requests.length === 0) { evidence.result = 'NOT VERIFIED: model did not emit a native approval'; break; }
    if (decision === 'reject') await assert.rejects(readFile(target, 'utf8'), { code: 'ENOENT' });
    else assert.equal(await readFile(target, 'utf8'), 'NATIVE_APPROVE');
  }
  evidence.result ??= 'passed';
} catch (error) { evidence.result = 'failed'; evidence.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  try { await server.close(); evidence.cleanup = 'closed'; } catch (error) { evidence.cleanup = String(error); }
  const output = resolve(`execution/codex-approval-${Date.now()}.json`);
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, result: evidence.result, error: evidence.error })}\n`);
}
