import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [mode, recordPath] = process.argv.slice(2);
const schemaError = JSON.stringify({ type: 'error', error: { message: "Invalid schema for response_format 'codex_output_schema': 'schema.properties.choice.oneOf' is not permitted when strict is true.", type: 'invalid_request_error', param: 'text.format.schema', code: 'invalid_json_schema' }, status: 400 });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let current;
let selection = false;
let cwd;
const record = message => appendFileSync(recordPath, JSON.stringify({ pid: process.pid, ...message }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  record(message);
  if (message.method === 'initialized') return;
  const p = message.params;
  if (message.method === 'initialize') { send({ id: message.id, result: { userAgent: 'workspace-selection-fixture' } }); return; }
  if (message.method === 'thread/start') {
    selection = p.ephemeral === true;
    cwd = p.cwd;
    if (selection && (p.sandbox !== 'read-only' || p.approvalPolicy !== 'never' || p.dynamicTools?.length !== 0)) throw new Error('Selector permissions or tools were not isolated');
    current = { id: `${selection ? 'temporary' : 'formal'}-${process.pid}`, status: { type: 'idle' }, turns: [] };
    send({ id: message.id, result: { thread: current, cwd: selection && mode === 'wrong-cwd' ? '/unexpected' : cwd, approvalPolicy: selection && mode === 'wrong-policy' ? 'on-request' : p.approvalPolicy, approvalsReviewer: 'user', sandbox: { type: selection && mode !== 'wrong-sandbox' ? 'readOnly' : 'workspaceWrite', networkAccess: false }, model: 'fixture', modelProvider: 'fixture' } });
    return;
  }
  if (message.method === 'thread/read' || message.method === 'thread/resume') {
    if (selection) throw new Error('Ephemeral history must not be read or resumed');
    send({ id: message.id, result: { thread: current } }); return;
  }
  if (message.method === 'turn/start') {
    if (selection && (!p.outputSchema?.properties?.choice || p.approvalPolicy !== 'never' || p.sandboxPolicy?.type !== 'readOnly' || p.sandboxPolicy.networkAccess !== false)) throw new Error('Selector turn lacks structured output or read-only policy');
    const invalidSchema = mode === 'invalid-schema' || mode === 'invalid-schema-rpc' || (mode === 'strict-schema' && JSON.stringify(p.outputSchema).includes('"oneOf"'));
    if (selection && mode === 'invalid-schema-rpc') { send({ id: message.id, error: { code: -32600, message: schemaError } }); return; }
    const turn = { id: `turn-${process.pid}`, status: 'inProgress', items: [] };
    current.turns = [turn]; current.status = { type: 'active' };
    const scope = { threadId: current.id, turnId: turn.id };
    const complete = () => {
      if (selection && mode === 'crash') process.exit(27);
      if (selection && mode === 'approval') { send({ id: 'forbidden-approval', method: 'item/commandExecution/requestApproval', params: { ...scope, itemId: 'command', startedAtMs: Date.now(), command: 'touch forbidden', cwd } }); return; }
      if (selection && mode === 'slow') return;
      const choice = ['project', 'unknown-project', 'project-path', 'missing-project-id', 'missing-project-reason'].includes(mode)
        ? { kind: 'project', projectId: mode === 'unknown-project' ? 'invented-project' : 'project-fixture', reason: 'Matches task evidence', ...(mode === 'project-path' ? { path: '/invented/path' } : {}) }
        : ['none', 'missing-none-reason'].includes(mode) ? { kind: 'none', reason: 'Discussion only' } : ['question', 'missing-question'].includes(mode) ? { kind: 'question', question: 'Which configured project should be used?' } : { kind: 'repository', repositoryName: mode === 'unknown-repository' ? 'outside/project' : 'example/project', reason: 'Matches task evidence' };
      if (mode === 'missing-repository') delete choice.repositoryName;
      if (['missing-reason', 'missing-project-reason', 'missing-none-reason'].includes(mode)) delete choice.reason;
      if (mode === 'missing-project-id') delete choice.projectId;
      if (mode === 'missing-question') delete choice.question;
      const text = selection ? mode === 'malformed' ? 'not JSON' : JSON.stringify({ choice }) : 'Formal task result';
      const commentary = { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Temporary directory selection commentary' };
      const answer = { id: 'answer', type: 'agentMessage', phase: 'final_answer', text };
      if (selection) send({ method: 'item/completed', params: { ...scope, item: commentary } });
      const transient = ['rate-limit', 'schema-word-in-prose', 'schema-word-with-different-code'].includes(mode);
      if ((!invalidSchema && !transient && mode !== 'failed') || !selection) send({ method: 'item/completed', params: { ...scope, item: answer } });
      turn.status = selection && (mode === 'failed' || invalidSchema || transient) ? 'failed' : 'completed';
      const transientError = mode === 'schema-word-in-prose' ? 'Temporary unavailable: invalid_json_schema is an example code, not this failure'
        : JSON.stringify({ error: { message: mode === 'rate-limit' ? 'Rate limit reached' : 'Temporary unavailable: invalid_json_schema is an example code', code: 'rate_limit_exceeded' }, status: 429 });
      turn.error = turn.status === 'failed' ? { message: invalidSchema ? schemaError : transient ? transientError : 'Selection failed in fixture' } : null;
      if (!selection) turn.items.push(answer);
      current.status = { type: 'idle' };
      send({ method: 'turn/completed', params: { threadId: current.id, turn } });
    };
    if (selection && mode === 'early-completion') complete();
    send({ id: message.id, result: { turn: { ...turn, status: 'inProgress' } } });
    if (!(selection && mode === 'early-completion')) complete();
    return;
  }
  throw new Error('Unexpected fixture request ' + message.method);
});
