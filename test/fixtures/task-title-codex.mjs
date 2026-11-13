import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [mode, recordPath] = process.argv.slice(2);
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const record = message => appendFileSync(recordPath, JSON.stringify({ pid: process.pid, ...message }) + '\n');
let thread;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  record(message);
  const p = message.params;
  if (message.method === 'initialized') return;
  if (message.method === 'initialize') { send({ id: message.id, result: { userAgent: 'task-title-fixture' } }); return; }
  if (message.method === 'thread/start') {
    if (p.ephemeral !== true || p.sandbox !== 'read-only' || p.approvalPolicy !== 'never' || p.dynamicTools?.length !== 0) throw new Error('Title summary was not isolated');
    thread = { id: `temporary-${process.pid}`, status: { type: 'idle' }, turns: [] };
    send({ id: message.id, result: { thread, cwd: p.cwd, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, model: 'fixture', modelProvider: 'fixture' } });
    return;
  }
  if (message.method === 'turn/start') {
    if (!p.outputSchema?.properties?.title || p.sandboxPolicy?.type !== 'readOnly') throw new Error('Title turn lacks structured output or read-only policy');
    const turn = { id: `turn-${process.pid}`, status: 'inProgress', items: [] };
    send({ id: message.id, result: { turn } });
    if (mode === 'slow') return;
    const scope = { threadId: thread.id, turnId: turn.id };
    const text = mode === 'malformed' ? 'not JSON' : JSON.stringify({ title: '2.4.1 后处理根因定位' });
    send({ method: 'item/completed', params: { ...scope, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text } } });
    send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed', error: null } } });
    return;
  }
  throw new Error('Unexpected fixture request ' + message.method);
});
