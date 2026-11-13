import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { CodexAppServer } from '../src/adapters/codex.js';
import { normalizeDaemonSettings } from '../src/adapters/codex-daemon.js';
import { configSchema } from '../src/config.js';
import { UncertainOperationError } from '../src/domain.js';

const messageSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), result: z.unknown().optional() });
const inputSchema = z.array(z.object({ type: z.string(), text: z.string().optional() }));
type Turn = { id: string; status: 'inProgress' | 'completed' | 'interrupted'; items: object[] };
type Thread = { id: string; status: { type: 'idle' | 'active' }; turns: Turn[] };

async function fixture(t: TestContext, initialStatus = 'running') {
  const root = await mkdtemp('/tmp/shared-codex-');
  const socketPath = join(root, 'daemon.sock');
  const statePath = join(root, 'state.json');
  const callsPath = join(root, 'control.jsonl');
  const executable = join(root, 'codex');
  await writeFile(statePath, JSON.stringify({ status: initialStatus, socketPath }));
  await writeFile(executable, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst path = ${JSON.stringify(statePath)};\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');\nif (args.join(' ') === 'app-server daemon version') process.stdout.write(fs.readFileSync(path, 'utf8'));\nelse if (args.join(' ') === 'app-server daemon start') { const value = JSON.parse(fs.readFileSync(path, 'utf8')); if (value.failStart) process.exit(9); setTimeout(() => { value.status = 'running'; fs.writeFileSync(path, JSON.stringify(value)); }, 30); }\nelse process.exit(10);\n`, { mode: 0o700 });
  const http = createServer();
  const service = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(socketPath, resolve));
  const threads = new Map<string, { thread: Thread; ephemeral: boolean; socket: WebSocket }>();
  const records: { connection: number; message: z.infer<typeof messageSchema> }[] = [];
  const clients: CodexAppServer[] = [];
  let connections = 0;
  let loseNext: 'turn/start' | 'turn/steer' | undefined;
  let silentStart = false;
  let holdSelections = false;
  let failReadThread: string | undefined;
  let failInitialization = false;
  const send = (socket: WebSocket, value: object) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value)); };
  const broadcast = (value: object) => { for (const socket of service.clients) send(socket, value); };
  const terminal = (saved: { thread: Thread }, status: 'completed' | 'interrupted') => {
    const turn = saved.thread.turns.at(-1)!;
    turn.status = status; saved.thread.status = { type: 'idle' };
    broadcast({ method: 'turn/completed', params: { threadId: saved.thread.id, turn } });
  };
  service.on('connection', socket => {
    const connection = ++connections;
    socket.on('message', data => {
      const message = messageSchema.parse(JSON.parse(data.toString()));
      records.push({ connection, message });
      const params = message.params ?? {};
      const reply = (result: unknown) => send(socket, { id: message.id, result });
      if (message.method === 'initialize') {
        if (failInitialization) { send(socket, { id: message.id, error: { code: -32600, message: 'Fixture initialization rejected' } }); return; }
        reply({ userAgent: 'shared-fixture' }); return;
      }
      if (message.method === 'initialized' || !message.method) return;
      if (message.method === 'thread/start') {
        const thread: Thread = { id: `thread-${threads.size + 1}`, status: { type: 'idle' }, turns: [] };
        const ephemeral = params.ephemeral === true;
        threads.set(thread.id, { thread, ephemeral, socket });
        reply({ thread, cwd: params.cwd, approvalPolicy: params.approvalPolicy, sandbox: { type: ephemeral ? 'readOnly' : 'workspaceWrite', networkAccess: false } }); return;
      }
      const threadId = z.string().parse(params.threadId);
      const saved = threads.get(threadId);
      assert.ok(saved, `Known fixture Thread ${threadId}`);
      if (message.method === 'thread/read' || message.method === 'thread/resume') {
        if (message.method === 'thread/read' && threadId === failReadThread) { send(socket, { id: message.id, error: { code: -32600, message: 'Fixture history unavailable' } }); return; }
        if (saved.ephemeral && (params.includeTurns || message.method === 'thread/resume')) { send(socket, { id: message.id, error: { code: -32600, message: 'ephemeral threads do not support includeTurns or resume' } }); return; }
        reply({ thread: { ...saved.thread, turns: params.includeTurns || message.method === 'thread/resume' ? saved.thread.turns : [] } }); return;
      }
      if (message.method === 'thread/unsubscribe') { reply({ status: 'unsubscribed' }); return; }
      if (message.method === 'turn/interrupt') {
        assert.equal(params.turnId, saved.thread.turns.at(-1)?.id);
        terminal(saved, 'interrupted'); reply({}); return;
      }
      if (message.method === 'turn/start' || message.method === 'turn/steer') {
        const item = { id: `input-${records.length}`, type: 'userMessage', clientId: params.clientUserMessageId, content: inputSchema.parse(params.input) };
        if (message.method === 'turn/start') {
          const turn: Turn = { id: `turn-${threadId}-${saved.thread.turns.length + 1}`, status: 'inProgress', items: [item] };
          saved.thread.turns.push(turn); saved.thread.status = { type: 'active' };
          if (!silentStart) broadcast({ method: 'turn/started', params: { threadId, turn } });
        } else saved.thread.turns.at(-1)!.items.push(item);
        if (loseNext === message.method) { loseNext = undefined; socket.terminate(); return; }
        reply(message.method === 'turn/start' ? { turn: saved.thread.turns.at(-1) } : { turnId: saved.thread.turns.at(-1)!.id });
        if (saved.ephemeral && !holdSelections) {
          const answer = { id: `answer-${threadId}`, type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ choice: { kind: 'none', reason: 'Discussion only' } }) };
          saved.thread.turns.at(-1)!.items.push(answer);
          broadcast({ method: 'item/completed', params: { threadId, turnId: saved.thread.turns.at(-1)!.id, item: answer } });
          terminal(saved, 'completed');
        }
        return;
      }
      throw new Error(`Unexpected fixture method ${message.method}`);
    });
  });
  t.after(async () => {
    await Promise.allSettled(clients.map(client => client.close()));
    for (const socket of service.clients) socket.terminate();
    await new Promise<void>(resolve => service.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const client = (options: Partial<ConstructorParameters<typeof CodexAppServer>[0]> = {}) => {
    const value = new CodexAppServer({ executable, approvalPolicy: 'on-request', sandbox: 'workspace-write', requestTimeoutMs: 1000, ...options });
    clients.push(value); return value;
  };
  const selection = (server: CodexAppServer, signal?: AbortSignal) => server.selectWorkspace({ taskId: 'selector', cwd: root, input: [{ kind: 'text', text: 'Discuss architecture' }], answers: [], candidates: [], signal });
  const wait = async (predicate: () => boolean) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); } throw new Error('Fixture condition did not occur'); };
  return { root, socketPath, client, selection, threads, records, broadcast, terminal, wait,
    failRead: (threadId: string) => { failReadThread = threadId; },
    initialization: (fail: boolean) => { failInitialization = fail; },
    hold: () => { holdSelections = true; }, lose: (method: typeof loseNext, silent = false) => { loseNext = method; silentStart = silent; },
    state: (value: object) => writeFile(statePath, JSON.stringify(value)),
    controls: async () => (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => z.array(z.string()).parse(JSON.parse(line))),
  };
}

const create = (client: CodexAppServer, cwd: string, extra: { model?: string } = {}) => client.createThread({ cwd, instructions: 'Read-only fixture work only', ...extra });
const start = (client: CodexAppServer, threadId: string, deliveryId = 'input') => client.startTurn({ threadId, deliveryId, input: [{ kind: 'text', text: 'Wait' }] });

test('formal clients and isolated selectors reuse a running daemon and preserve Thread settings', async t => {
  const f = await fixture(t);
  const formal = f.client({ command: [f.root + '/codex', 'app-server', '-c', 'model="main-model"', '-c', 'model_provider="provider"', '-c', 'model_reasoning_effort="xhigh"'], selectionModel: 'selector-model' });
  const unrelated = f.client();
  const [threadId, thirdParty] = await Promise.all([create(formal, f.root), create(unrelated, f.root)]);
  const unrelatedTurn = await start(unrelated, thirdParty);
  await f.selection(formal);
  const starts = f.records.filter(row => row.message.method === 'thread/start');
  const selected = starts.find(row => row.message.params?.ephemeral);
  assert.equal(selected?.message.params?.model, 'selector-model');
  assert.equal(selected?.message.params?.approvalPolicy, 'never');
  assert.equal(selected?.message.params?.sandbox, 'read-only');
  assert.deepEqual(selected?.message.params?.dynamicTools, []);
  const main = starts.find(row => row.message.params?.model === 'main-model');
  assert.equal(main?.message.params?.modelProvider, 'provider');
  assert.deepEqual(main?.message.params?.config, { model_reasoning_effort: 'xhigh' });
  assert.notEqual(main?.connection, selected?.connection);
  assert.equal((await f.controls()).filter(args => args.at(-1) === 'start').length, 0);
  await formal.close();
  assert.equal((await unrelated.inspect(thirdParty)).turnId, unrelatedTurn);
  assert.equal((await unrelated.inspect(thirdParty)).status, 'running');
  await unrelated.interrupt({ threadId: thirdParty, turnId: unrelatedTurn });
  await start(unrelated, thirdParty, 'after-other-client-closed');
  assert.equal(f.threads.get(threadId)?.thread.status.type, 'idle');
});

test('concurrent clients start an absent daemon once through the official entry', async t => {
  const f = await fixture(t, 'stopped');
  await Promise.all([create(f.client(), f.root), create(f.client(), f.root)]);
  assert.equal((await f.controls()).filter(args => args.join(' ') === 'app-server daemon start').length, 1);
});

test('daemon start failure and failed initial discovery recover without private fallback', async t => {
  const f = await fixture(t, 'stopped');
  await f.state({ status: 'stopped', socketPath: f.socketPath, failStart: true });
  const server = f.client();
  await assert.rejects(create(server, f.root), /Command failed/);
  assert.equal(f.threads.size, 0);
  await f.state({ status: 'running', socketPath: f.socketPath });
  await server.recover();
  await create(server, f.root);
  assert.equal(f.threads.size, 1);
});

for (const method of ['turn/start', 'turn/steer'] as const) test(`${method} response loss reconciles the same Thread without replaying input`, async t => {
  const f = await fixture(t); const server = f.client();
  const threadId = await create(server, f.root);
  const turnId = method === 'turn/steer' ? await start(server, threadId) : undefined;
  f.lose(method);
  if (turnId) await assert.rejects(server.steer({ threadId, turnId, deliveryId: 'uncertain', input: [{ kind: 'text', text: 'Steer' }] }), UncertainOperationError);
  else await assert.rejects(start(server, threadId, 'uncertain'), UncertainOperationError);
  await server.recover();
  const snapshot = await server.inspect(threadId);
  assert.equal(snapshot.status, 'running');
  assert.ok(snapshot.seenInputIds.includes('uncertain'));
  assert.equal(f.records.filter(row => row.message.method === method && (row.message.params?.clientUserMessageId === 'uncertain')).length, 1);
  await server.close();
  assert.equal(f.threads.get(threadId)?.thread.status.type, 'idle');
});

test('selector response loss cleans its exact notified Turn through a replacement connection', async t => {
  const f = await fixture(t); const server = f.client(); f.hold(); f.lose('turn/start');
  await assert.rejects(f.selection(server), UncertainOperationError);
  const temporary = [...f.threads.values()].find(saved => saved.ephemeral)!;
  assert.equal(temporary.thread.turns[0]?.status, 'interrupted');
  assert.equal(temporary.thread.status.type, 'idle');
  const reads = f.records.filter(row => row.message.method === 'thread/read');
  assert.ok(reads.every(row => row.message.params?.includeTurns === false));
  assert.ok(f.records.some(row => row.message.method === 'thread/unsubscribe'));
  assert.ok(!f.records.some(row => row.message.method === 'thread/resume'));
});

test('selector abort stops only its owned active Turn and drains its subscription', async t => {
  const f = await fixture(t); f.hold(); const server = f.client(); const unrelated = f.client();
  const otherId = await create(unrelated, f.root); await start(unrelated, otherId);
  const controller = new AbortController(); const pending = f.selection(server, controller.signal);
  const rejection = assert.rejects(pending, /aborted/);
  await f.wait(() => [...f.threads.values()].some(saved => saved.ephemeral && saved.thread.status.type === 'active'));
  controller.abort(); await rejection;
  assert.equal([...f.threads.values()].find(saved => saved.ephemeral)?.thread.status.type, 'idle');
  assert.equal((await unrelated.inspect(otherId)).status, 'running');
  assert.ok(f.records.some(row => row.message.method === 'thread/unsubscribe' && row.message.params?.threadId !== otherId));
});

test('an active selector with no observable Turn identity reports uncertain cleanup', async t => {
  const f = await fixture(t); const server = f.client(); f.hold(); f.lose('turn/start', true);
  await assert.rejects(f.selection(server), error => error instanceof UncertainOperationError && /no identifiable Turn/.test(error.message));
  const temporary = [...f.threads.values()].find(saved => saved.ephemeral)!;
  assert.equal(temporary.thread.status.type, 'active');
  assert.ok(!f.records.some(row => row.message.method === 'turn/interrupt'));
  f.terminal(temporary, 'interrupted');
});

test('foreign native requests and events are ignored before progress or tool handlers', async t => {
  const f = await fixture(t); const server = f.client(); let tools = 0; const events: string[] = [];
  server.setWorkspaceHandler(async () => { tools++; throw new Error('Foreign request escaped'); });
  server.setEventHandler(event => { events.push(event.text); });
  const threadId = await create(server, f.root); await start(server, threadId);
  f.broadcast({ id: 'foreign-tool', method: 'item/tool/call', params: { threadId: 'foreign', turnId: 'foreign-turn', callId: 'foreign', tool: 'ensure_workspace', arguments: { repository: 'foreign/project' } } });
  f.broadcast({ id: 'foreign-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'foreign', turnId: 'foreign-turn' } });
  f.broadcast({ method: 'item/completed', params: { threadId: 'foreign', turnId: 'foreign-turn', item: { id: 'foreign-output', type: 'agentMessage', text: 'FOREIGN_OUTPUT', phase: 'final_answer' } } });
  await delay(30);
  const snapshot = await server.inspect(threadId);
  assert.equal(tools, 0); assert.deepEqual(snapshot.requests, []); assert.deepEqual(snapshot.outputs, []);
  assert.equal(events.some(text => text.includes('FOREIGN_OUTPUT')), false);
  assert.equal(f.records.some(row => row.message.id === 'foreign-tool' || row.message.id === 'foreign-approval'), false);
});

test('legacy daemon argv migration rejects unknown global settings before connecting', () => {
  assert.throws(() => normalizeDaemonSettings({ command: ['codex', 'app-server', '--enable', 'feature'] }), /Unsupported.*argument/);
  assert.throws(() => normalizeDaemonSettings({ command: ['codex', 'app-server', '-c', 'sandbox_mode="danger-full-access"'] }), /never changes global/);
  assert.throws(() => new CodexAppServer({ command: ['sh', '-c', 'codex app-server'], approvalPolicy: 'never', sandbox: 'read-only', requestTimeoutMs: 1000 }), /official app-server/);
});


test('selector deadline interrupts its active Turn before reporting timeout', async t => {
  const f = await fixture(t); f.hold(); const server = f.client({ requestTimeoutMs: 600 });
  await assert.rejects(f.selection(server), /timed out/);
  const temporary = [...f.threads.values()].find(saved => saved.ephemeral);
  assert.equal(temporary?.thread.status.type, 'idle');
  assert.equal(temporary?.thread.turns[0]?.status, 'interrupted');
});

test('shutdown attempts every owned Thread after one cleanup failure and preserves other clients', async t => {
  const f = await fixture(t); const owner = f.client(); const unrelated = f.client();
  const first = await create(owner, f.root), second = await create(owner, f.root), third = await create(unrelated, f.root);
  await start(owner, first); await start(owner, second); await start(unrelated, third);
  f.failRead(first);
  await assert.rejects(owner.close(), /cleanup could not be confirmed/);
  assert.equal(f.threads.get(second)?.thread.status.type, 'idle');
  assert.equal((await unrelated.inspect(third)).status, 'running');
  f.terminal(f.threads.get(first)!, 'interrupted');
});

test('initial handshake failure is recoverable and explicit socket configuration skips daemon control', async t => {
  const f = await fixture(t); f.initialization(true);
  const server = f.client({ socketPath: f.socketPath, executable: '/unavailable-cli-not-needed' });
  await assert.rejects(create(server, f.root), /initialization rejected/);
  f.initialization(false); await server.recover(); await create(server, f.root);
});

test('configuration normalizes legacy Thread overrides and rejects unmigratable argv before runtime', () => {
  const config = configSchema.parse({ feishu: { userOpenId: 'owner' }, codex: { command: ['codex', 'app-server', '-c', 'model="legacy-model"', '-c', 'model_provider="legacy-provider"', '-c', 'model_reasoning_effort="high"'] } });
  assert.equal(config.codex.executable, 'codex'); assert.equal(config.codex.command, undefined);
  assert.equal(config.codex.model, 'legacy-model'); assert.equal(config.codex.modelProvider, 'legacy-provider'); assert.equal(config.codex.reasoningEffort, 'high');
  assert.throws(() => configSchema.parse({ feishu: { userOpenId: 'owner' }, codex: { command: ['codex', 'app-server', '-c', 'network_access=true'] } }), /Cannot migrate/);
});
