import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { dashboardScript } from '../src/dashboard-page.js';

class Element {
  childNodes: Element[] = [];
  textContent = '';
  className = '';
  value = '';
  hidden = false;
  checked = false;
  dataset = {};
  classList = { toggle() {}, add() {} };
  append(...children: Element[]) { this.childNodes.push(...children); }
  replaceChildren(...children: Element[]) { this.childNodes = children; }
  addEventListener() {}
  removeAttribute() {}
  scrollIntoView() {}
}

async function browser(options: { threadId: string | null; unavailable?: boolean; runtime?: { pid: number; lastSeenAt: number; intervalMs: number; status: 'running' | 'stopped' } }) {
  const elements = new Map<string, Element>();
  const element = (id: string) => { let result = elements.get(id); if (!result) { result = new Element(); elements.set(id, result); } return result; };
  const requests: string[] = [];
  const streams: Stream[] = [];
  class Stream {
    closed = false;
    listeners = new Map<string, (message: { data: string }) => void>();
    constructor(readonly url: string) { streams.push(this); }
    close() { this.closed = true; }
    addEventListener(name: string, listener: (message: { data: string }) => void) { this.listeners.set(name, listener); }
    emit(name: string, value: unknown = {}) { this.listeners.get(name)?.({ data: JSON.stringify(value) }); }
  }
  let now = 0, unavailable = options.unavailable ?? false, snapshotUnavailable = false;
  const task = { id: 'task', title: 'Task', threadId: options.threadId, status: 'running', role: 'worker', updatedAt: 0 };
  const context = createContext({
    document: { getElementById: element, createElement: () => new Element(), createDocumentFragment: () => new Element(), querySelectorAll: () => [] },
    EventSource: Stream,
    Date: class extends Date { static override now() { return now; } },
    window: { addEventListener() {}, setInterval() {}, setTimeout() {} },
    fetch: async (url: string) => {
      requests.push(url);
      if (url === '/api/snapshot' && snapshotUnavailable) throw new Error('Snapshot unavailable');
      return { ok: true, status: 200, json: async () => url === '/api/snapshot'
        ? { tasks: [task], projects: [], now, runtime: options.runtime ?? null, dataDir: '/test' }
        : { task, threadId: task.threadId, cursor: 'epoch:0', history: { kind: unavailable ? 'unavailable' : 'available' }, timeline: unavailable ? [] : [{ id: 'historical', kind: 'agent_message', text: 'Recovered answer', createdAt: 0 }], inputs: [], outputs: [], diagnostics: [] } };
    },
  });
  runInContext(dashboardScript, context);
  await new Promise<void>(resolve => setImmediate(resolve));
  return {
    streams, requests, element,
    async select() { await runInContext('selectTask("task")', context); },
    failSnapshot() { snapshotUnavailable = true; },
    recoverSnapshot() { snapshotUnavailable = false; },
    recover() { unavailable = false; },
    rebind(threadId: string) { task.threadId = threadId; unavailable = true; },
    async refresh(elapsed = 0) { now += elapsed; await runInContext('refresh()', context); },
  };
}

test('the selected bound task retries unavailable history with backoff and recovers without another selection', async () => {
  const page = await browser({ threadId: 'thread', unavailable: true });
  await page.select();
  const reads = () => page.requests.filter(url => url === '/api/tasks/task').length;
  assert.equal(reads(), 1);
  await page.refresh(500); assert.equal(reads(), 1);
  await page.refresh(500); assert.equal(reads(), 2);
  await page.refresh(1000); assert.equal(reads(), 2);
  page.recover();
  await page.refresh(1000); assert.equal(reads(), 3);
  assert.equal(page.element('page-error').hidden, true);
  assert.equal(page.element('event-count').textContent, '1 条事件');
  await page.refresh(60000); assert.equal(reads(), 3);
});

test('reset notifications do not create an immediate detail subscription loop for an unbound task', async () => {
  const page = await browser({ threadId: null });
  await page.select();
  assert.equal(page.streams.length, 1);
  const first = page.streams[0]!;
  assert.match(first.url, /threadId=$/);
  first.emit('reset'); first.emit('reset');
  await page.refresh(999);
  assert.equal(page.streams.length, 1);
  await page.refresh(1);
  assert.equal(page.streams.length, 2);
  assert.equal(first.closed, true);
  await page.refresh(60000);
  assert.equal(page.streams.length, 2);
});

test('live item upserts retain at most five hundred visible timeline entries', async () => {
  const page = await browser({ threadId: 'thread' });
  await page.select();
  const stream = page.streams[0]!;
  for (let index = 0; index < 510; index++) stream.emit('execution', { taskId: 'task', threadId: 'thread', key: String(index), turnId: 'turn', kind: 'agent_message', text: 'Message ' + index, createdAt: index });
  assert.equal(page.element('event-count').textContent, '500 条事件');
  stream.emit('execution', { taskId: 'task', threadId: 'thread', key: '509', turnId: 'turn', kind: 'agent_message', text: 'Updated message', createdAt: 509 });
  assert.equal(page.element('event-count').textContent, '500 条事件');
});

test('unavailable history after Thread rebind does not preserve the previous Thread timeline', async () => {
  const page = await browser({ threadId: 'thread-a' });
  await page.select();
  assert.equal(page.element('event-count').textContent, '1 条事件');
  page.rebind('thread-b');
  await page.refresh(1000);
  assert.equal(page.element('event-count').textContent, '0 条事件');
  assert.equal(page.element('page-error').hidden, false);
});

test('overview polling reads no task history before explicit task selection', async () => {
  const page = await browser({ threadId: 'thread' });
  await page.refresh(1000);
  await page.refresh(1000);
  assert.deepEqual(page.requests, ['/api/snapshot', '/api/snapshot', '/api/snapshot']);
  assert.equal(page.streams.length, 0);
  await page.select();
  assert.equal(page.requests.filter(url => url === '/api/tasks/task').length, 1);
  await page.refresh(1000);
  assert.equal(page.requests.filter(url => url === '/api/tasks/task').length, 1);
});

test('snapshot failures mark task status as last known while heartbeat age keeps advancing', async () => {
  const page = await browser({ threadId: 'thread', runtime: { pid: 10, status: 'running', lastSeenAt: 0, intervalMs: 1000 } });
  await page.select();
  assert.equal(page.element('runtime-status').textContent, '服务心跳正常');
  page.failSnapshot();
  await page.refresh(16000);
  assert.match(page.element('runtime-status').textContent, /服务心跳已过期/);
  assert.match(page.element('task-badge').textContent, /最后已知/);
  assert.match(page.element('page-error').textContent, /最后已知状态/);
  page.recoverSnapshot(); await page.refresh(1000);
  assert.doesNotMatch(page.element('task-badge').textContent, /最后已知/);
  assert.equal(page.element('page-error').hidden, true);
});

test('selected detail ignores an execution event from a different Thread', async () => {
  const page = await browser({ threadId: 'thread' }); await page.select();
  const stream = page.streams[0]!;
  stream.emit('execution', { taskId: 'task', threadId: 'previous-thread', key: 'old', turnId: 'turn', kind: 'agent_message', text: 'Old Thread', createdAt: 1 });
  assert.equal(page.element('event-count').textContent, '1 条事件');
  stream.emit('execution', { taskId: 'task', threadId: 'thread', key: 'new', turnId: 'turn', kind: 'agent_message', text: 'Current Thread', createdAt: 2 });
  assert.equal(page.element('event-count').textContent, '2 条事件');
});
