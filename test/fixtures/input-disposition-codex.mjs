import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { threads: [], calls: [] };
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const persist = () => writeFileSync(path, JSON.stringify(state));
const view = thread => ({ ...thread, historyMode: 'paginated', turns: [] });
const user = params => ({ id: `user-${state.calls.length}`, type: 'userMessage', clientId: params.clientUserMessageId, content: params.input });

createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (!request.method) return;
  const params = request.params ?? {};
  state.calls.push({ method: request.method, ...params });
  let result;
  const thread = state.threads.find(item => item.id === params.threadId);
  switch (request.method) {
    case 'initialize': result = { userAgent: 'isolated-disposition-fixture' }; break;
    case 'initialized': persist(); return;
    case 'thread/start': {
      const created = { id: `thread-${state.threads.length + 1}`, status: { type: 'idle' }, turns: [],
        coordinator: params.developerInstructions.includes('Project role: coordinator.'), instructions: params.developerInstructions };
      state.threads.push(created); result = { thread: view(created) }; break;
    }
    case 'thread/resume':
      if (params.developerInstructions) thread.instructions = params.developerInstructions;
      result = { thread: view(thread) }; break;
    case 'thread/read': result = { thread: view(thread) }; break;
    case 'thread/turns/list': {
      const turns = params.sortDirection === 'desc' ? [...thread.turns].reverse() : thread.turns;
      result = { data: params.limit ? turns.slice(0, params.limit) : turns, nextCursor: null }; break;
    }
    case 'turn/start': {
      if (params.clientUserMessageId === 'old-unknown') {
        persist(); send({ id: request.id, error: { code: -32000, message: 'Synthetic provider rejection before accepting this input' } }); return;
      }
      const turn = { id: `turn-${thread.turns.length + 1}`, status: thread.coordinator ? 'inProgress' : 'completed', itemsView: 'full', items: [user(params)] };
      thread.turns.push(turn); thread.status = { type: thread.coordinator ? 'active' : 'idle' }; result = { turn }; break;
    }
    case 'turn/steer': thread.turns.at(-1).items.push(user(params)); result = { turnId: thread.turns.at(-1).id }; break;
    case 'turn/interrupt': {
      const turn = thread.turns.at(-1); turn.status = 'interrupted'; thread.status = { type: 'idle' };
      send({ method: 'turn/completed', params: { threadId: thread.id, turn } }); result = {}; break;
    }
    default: throw new Error(`Unsupported isolated method ${request.method}`);
  }
  persist(); send({ id: request.id, result });
});
