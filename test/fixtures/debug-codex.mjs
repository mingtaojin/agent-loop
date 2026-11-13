import { createInterface } from 'node:readline';

const threads = new Map();
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
const view = thread => ({ ...thread, status: { type: thread.turns.at(-1)?.status === 'inProgress' ? 'active' : 'idle' } });

createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params: p } = JSON.parse(line);
  if (method === 'initialized') return;
  let result;
  switch (method) {
    case 'initialize': result = { userAgent: 'debug-fixture' }; break;
    case 'thread/start': {
      const thread = { id: (p.ephemeral ? 'temporary-' : 'thread-') + (threads.size + 1), turns: [], ephemeral: p.ephemeral };
      threads.set(thread.id, thread); result = { thread: view(thread), cwd: p.cwd, approvalPolicy: p.approvalPolicy, sandbox: { type: 'readOnly', networkAccess: false } }; break;
    }
    case 'thread/resume': case 'thread/read': result = { thread: view(threads.get(p.threadId)) }; break;
    case 'turn/start': {
      const thread = threads.get(p.threadId);
      const turn = { id: 'turn-' + (thread.turns.length + 1), status: 'inProgress', items: [{ id: 'user', type: 'userMessage', clientId: p.clientUserMessageId, content: p.input }] };
      thread.turns.push(turn);
      send({ id, result: { turn } });
      const scope = { threadId: thread.id, turnId: turn.id };
      if (thread.ephemeral) {
        const text = p.input.find(item => item.type === 'text' && item.text.startsWith('Directory-selection data: '))?.text;
        const data = text ? JSON.parse(text.split('\n')[0].slice('Directory-selection data: '.length)) : {};
        const candidate = data.candidates?.find(item => item.kind === 'project');
        const choice = candidate ? { kind: 'project', projectId: candidate.id, reason: 'Configured surface project' }
          : { kind: 'none', reason: 'No supplied project' };
        const answer = { id: 'selection', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ choice }) };
        turn.items.push(answer); turn.status = 'completed';
        notify('item/completed', { ...scope, item: answer });
        notify('turn/completed', { threadId: thread.id, turn });
        return;
      }
      notify('turn/started', { threadId: thread.id, turn });
      notify('item/agentMessage/delta', { ...scope, itemId: 'agent', delta: '正在检查运行状态，' });
      notify('item/started', { ...scope, item: { id: 'command', type: 'commandExecution', command: 'npm run check', status: 'inProgress' } });
      notify('item/commandExecution/outputDelta', { ...scope, itemId: 'command', delta: 'TypeScript checking…\n' });
      notify('error', { ...scope, error: { message: 'Selected model is at capacity. Please try a different model.' }, willRetry: true });
      notify('item/reasoning/textDelta', { ...scope, itemId: 'private', delta: 'private reasoning must not be recorded' });
      return;
    }
    case 'turn/steer': {
      const thread = threads.get(p.threadId), turn = thread.turns.at(-1);
      turn.items.push({ id: 'followup', type: 'userMessage', clientId: p.clientUserMessageId, content: p.input });
      send({ id, result: { turnId: turn.id } });
      const scope = { threadId: thread.id, turnId: turn.id };
      notify('item/agentMessage/delta', { ...scope, itemId: 'agent', delta: '校验已完成。' });
      const command = { id: 'command', type: 'commandExecution', command: 'npm run check', status: 'completed', aggregatedOutput: 'TypeScript checking…\nPassed', exitCode: 0 };
      const answer = { id: 'agent', type: 'agentMessage', phase: 'final_answer', text: '正在检查运行状态，校验已完成。' };
      turn.items.push(command, answer);
      notify('item/completed', { ...scope, item: command });
      notify('item/completed', { ...scope, item: answer });
      turn.status = 'completed'; notify('turn/completed', { threadId: thread.id, turn });
      return;
    }
    case 'turn/interrupt': {
      threads.get(p.threadId).turns.at(-1).status = 'interrupted'; result = {}; break;
    }
    default: throw new Error('Unexpected fixture method ' + method);
  }
  send({ id, result });
});
