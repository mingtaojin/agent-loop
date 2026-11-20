import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveExecution } from '../src/live-execution.js';
import { executionKey, type ExecutionEvent, type ExecutionHistory } from '../src/execution-events.js';
const event = (text: string, kind: ExecutionEvent['kind'] = 'agent_delta', itemId = 'item'): ExecutionEvent => ({ threadId: 'thread', turnId: 'turn', itemId, kind, label: 'Agent', text, createdAt: 123 });
const history = (text: string, kind: ExecutionEvent['kind'] = 'agent_delta'): ExecutionHistory => [{ ...event(text, kind), key: executionKey(event(text, kind)), createdAt: null }];

test('history and live snapshots replace by item identity without duplicated deltas or invented timestamps', async () => {
  const feed = new LiveExecution({ readHistory: async () => history('hello') });
  feed.publish('task', event('hello', 'agent_start')); feed.publish('task', event(' world'));
  const snapshot = await feed.read('task', 'thread');
  assert.equal(snapshot.entries.length, 1); assert.equal(snapshot.entries[0]?.text, 'hello world');
  assert.equal(feed.since(snapshot.cursor)?.length, 0);
  const final = new LiveExecution({ readHistory: async () => history('hello world', 'agent_message') });
  final.publish('task', event(' world'));
  assert.deepEqual((await final.read('task', 'thread')).entries.map(item => [item.text, item.createdAt]), [['hello world', null]]);
});

test('bounded replay resets evicted and previous process cursors while isolating current Threads', () => {
  const feed = new LiveExecution(undefined, 2), beginning = feed.cursor;
  feed.publish('task', event('one', 'agent_message', 'one'));
  const resumable = feed.cursor;
  feed.publish('task', event('two', 'agent_message', 'two'));
  feed.publish('other', { ...event('three', 'agent_message', 'three'), threadId: 'other-thread' });
  assert.equal(feed.current('task', 'thread').length, 1);
  assert.equal(feed.since(beginning), null);
  assert.equal(feed.since(resumable)?.length, 2);
  assert.equal(new LiveExecution().since(feed.cursor), null);
  assert.deepEqual(feed.current('task', 'replacement-thread'), []);
});

test('a failed history read leaves current live entries visible and an explicit unavailable state', async () => {
  const feed = new LiveExecution({ readHistory: async () => { throw new Error('sensitive upstream body'); } });
  feed.publish('task', event('current progress', 'agent_start'));
  const snapshot = await feed.read('task', 'thread');
  assert.equal(snapshot.history.kind, 'unavailable'); assert.equal(snapshot.entries[0]?.text, 'current progress');
  assert.doesNotMatch(JSON.stringify(snapshot), /sensitive/);
});

test('notification arriving while history is read is included at the returned stream cursor', async () => {
  let release!: (value: ExecutionHistory) => void;
  const feed = new LiveExecution({ readHistory: () => new Promise(resolve => { release = resolve; }) });
  const reading = feed.read('task', 'thread');
  feed.publish('task', event('hello world', 'agent_start'));
  release(history('hello'));
  const snapshot = await reading;
  assert.equal(snapshot.entries[0]?.text, 'hello world');
  assert.deepEqual(feed.since(snapshot.cursor), []);
});

test('a history-only partial reloads an unanchored delta and reconnect resets subscribers', async () => {
  let canonical = 'hello';
  const feed = new LiveExecution({ readHistory: async () => history(canonical) });
  await feed.read('task', 'thread');
  feed.publish('task', event(' world'));
  assert.deepEqual(feed.current('task'), []);
  canonical = 'hello world';
  assert.equal((await feed.read('task', 'thread')).entries[0]?.text, canonical);
  const before = feed.cursor; let reset = false;
  feed.subscribe(change => { if (change.event === null) reset = true; });
  feed.reset();
  assert.equal(reset, true); assert.equal(feed.since(before), null); assert.deepEqual(feed.current('task'), []);
});

test('a complete item arriving during history read replaces an older complete snapshot', async () => {
  let release!: (value: ExecutionHistory) => void;
  const feed = new LiveExecution({ readHistory: () => new Promise(resolve => { release = resolve; }) });
  const reading = feed.read('task', 'thread');
  feed.publish('task', event('final corrected answer', 'agent_message'));
  release(history('older complete answer', 'agent_message'));
  assert.equal((await reading).entries[0]?.text, 'final corrected answer');
});

test('an unanchored suffix arriving during hydration remains a replay gap until a fresh read', async () => {
  let release!: (value: ExecutionHistory) => void;
  const feed = new LiveExecution({ readHistory: () => new Promise(resolve => { release = resolve; }) });
  const reading = feed.read('task', 'thread');
  feed.publish('task', event(' world'));
  release(history('hello'));
  const snapshot = await reading;
  assert.equal(snapshot.history.kind, 'unavailable');
  assert.equal(snapshot.entries[0]?.text, 'hello');
  assert.equal(feed.since(snapshot.cursor), null);
  feed.publish('task', event('!'));
  assert.deepEqual(feed.current('task'), []);
  const recovering = feed.read('task', 'thread');
  release(history('hello world!'));
  assert.equal((await recovering).entries[0]?.text, 'hello world!');
  feed.publish('task', event(' Next'));
  assert.deepEqual(feed.current('task'), []);
  const completed = feed.read('task', 'thread');
  release(history('hello world! Next', 'agent_message'));
  assert.equal((await completed).history.kind, 'available');
});

test('a final item recovered from history rejects late delta text', async () => {
  const feed = new LiveExecution({ readHistory: async () => history('complete answer', 'agent_message') });
  await feed.read('task', 'thread');
  feed.publish('task', event('late suffix'));
  assert.equal(feed.current('task')[0]?.text, 'complete answer');
  assert.equal(feed.current('task')[0]?.kind, 'agent_message');
});

test('an evicted prefix cannot be replaced by the next suffix', async () => {
  const feed = new LiveExecution({ readHistory: async () => history('hello') }, 1);
  await feed.read('task', 'thread');
  feed.publish('other', event('other', 'agent_message', 'other'));
  const before = feed.cursor;
  feed.publish('task', event(' world'));
  assert.deepEqual(feed.current('task'), []);
  assert.equal(feed.since(before), null);
});

test('throwing subscribers cannot interrupt publish or reconnect reset', () => {
  const feed = new LiveExecution();
  const received: string[] = [];
  feed.subscribe(() => { throw new Error('subscriber failed'); });
  feed.subscribe(change => { received.push(change.event?.text ?? 'reset'); });
  assert.doesNotThrow(() => feed.publish('task', event('complete', 'agent_message')));
  assert.doesNotThrow(() => feed.reset());
  assert.deepEqual(received, ['complete', 'reset']);
});

test('an active history snapshot ahead of notifications cannot regress to a shorter live prefix', async () => {
  let release!: (value: ExecutionHistory) => void;
  const feed = new LiveExecution({ readHistory: () => new Promise(resolve => { release = resolve; }) });
  feed.publish('task', event('hello', 'agent_start'));
  const reading = feed.read('task', 'thread');
  feed.publish('task', event(' world'));
  release(history('hello world!'));
  assert.equal((await reading).entries[0]?.text, 'hello world!');
});

test('conflicting active snapshots request rehydration without guessing an overlap', async () => {
  const feed = new LiveExecution({ readHistory: async () => history('canonical prefix') });
  feed.publish('task', event('different prefix', 'agent_start'));
  const snapshot = await feed.read('task', 'thread');
  assert.equal(snapshot.history.kind, 'unavailable');
  assert.equal(snapshot.entries[0]?.text, 'canonical prefix');
  assert.equal(feed.since(snapshot.cursor), null);
  assert.deepEqual(feed.current('task'), []);
});

test('repeated lagging partial reads cannot acknowledge an observed suffix', async () => {
  let canonical = 'hello';
  let kind: ExecutionEvent['kind'] = 'agent_delta';
  const feed = new LiveExecution({ readHistory: async () => history(canonical, kind) });
  feed.publish('task', event(' world'));
  const first = await feed.read('task', 'thread');
  const second = await feed.read('task', 'thread');
  assert.equal(first.history.kind, 'unavailable');
  assert.equal(second.history.kind, 'unavailable');
  assert.equal(feed.since(second.cursor), null);
  feed.publish('task', event('!'));
  assert.deepEqual(feed.current('task'), []);
  canonical = 'hello world!';
  assert.equal((await feed.read('task', 'thread')).history.kind, 'unavailable');
  kind = 'agent_message';
  const recovered = await feed.read('task', 'thread');
  assert.equal(recovered.history.kind, 'available');
  assert.equal(recovered.entries[0]?.text, canonical);
  feed.publish('task', event(' Next'));
  assert.equal(feed.current('task')[0]?.text, 'hello world!');
});

test('oversized live snapshots request canonical history instead of publishing truncated final text', async () => {
  const complete = 'a'.repeat(40000) + ' final';
  const feed = new LiveExecution({ readHistory: async () => history(complete, 'agent_message') });
  const before = feed.cursor;
  feed.publish('task', event(complete, 'agent_message'));
  assert.equal(feed.since(before), null);
  assert.deepEqual(feed.current('task'), []);
  const recovered = await feed.read('task', 'thread');
  assert.equal(recovered.history.kind, 'available');
  assert.equal(recovered.entries[0]?.text, complete);
  feed.publish('task', event('late delta'));
  assert.deepEqual(feed.current('task'), []);
});


test('oversized anchored partials recover without accepting a shorter repeated prefix', async () => {
  const chunk = '文😀\n'.repeat(10000);
  let canonical = chunk;
  const feed = new LiveExecution({ readHistory: async () => history(canonical) });
  feed.publish('task', event('', 'agent_start'));
  feed.publish('task', event(chunk));
  const recovered = await feed.read('task', 'thread');
  assert.equal(recovered.history.kind, 'available');
  assert.equal(recovered.entries[0]?.text, chunk);
  assert.deepEqual(feed.current('task'), []);
  feed.publish('task', event(chunk));
  const stale = await feed.read('task', 'thread');
  assert.equal(stale.history.kind, 'unavailable');
  assert.equal(feed.since(stale.cursor), null);
  canonical += chunk;
  const advanced = await feed.read('task', 'thread');
  assert.equal(advanced.history.kind, 'available');
  assert.equal(advanced.entries[0]?.text, canonical);
  assert.equal((await feed.read('task', 'thread')).history.kind, 'available');
});

test('oversized prefix coverage preserves Unicode across split surrogate deltas', async () => {
  const prefix = 'x'.repeat(40000);
  let canonical = prefix;
  const feed = new LiveExecution({ readHistory: async () => history(canonical) });
  feed.publish('task', event('', 'agent_start'));
  feed.publish('task', event(prefix + '\ud83d'));
  feed.publish('task', event('\ude00'));
  canonical += '😀';
  const recovered = await feed.read('task', 'thread');
  assert.equal(recovered.history.kind, 'available');
  assert.equal(recovered.entries[0]?.text, canonical);
});


test('repeated unanchored text cannot establish the position of a lost prefix', async () => {
  let release!: (value: ExecutionHistory) => void;
  const feed = new LiveExecution({ readHistory: () => new Promise(resolve => { release = resolve; }) });
  const first = feed.read('task', 'thread');
  feed.publish('task', event('ha'));
  release(history('haha'));
  assert.equal((await first).history.kind, 'unavailable');
  const second = feed.read('task', 'thread');
  release(history('haha'));
  const repeated = await second;
  assert.equal(repeated.history.kind, 'unavailable');
  assert.equal(feed.since(repeated.cursor), null);
  feed.publish('task', event('!'));
  assert.deepEqual(feed.current('task'), []);
  const final = feed.read('task', 'thread');
  release(history('hahaha!', 'agent_message'));
  assert.equal((await final).entries[0]?.text, 'hahaha!');
});

test('history ahead of an anchored stream does not duplicate delayed notifications', async () => {
  const feed = new LiveExecution({ readHistory: async () => history('hello world') });
  feed.publish('task', event('hello', 'agent_start'));
  assert.equal((await feed.read('task', 'thread')).entries[0]?.text, 'hello world');
  feed.publish('task', event(' world'));
  assert.equal(feed.current('task')[0]?.text, 'hello world');
  feed.publish('task', event('!'));
  assert.equal(feed.current('task')[0]?.text, 'hello world!');
});


test('evicting an unresolved suffix cannot certify a lagging partial history', async () => {
  let canonical = history('hello');
  const feed = new LiveExecution({ readHistory: async () => canonical }, 1);
  feed.publish('task', event(' world'));
  feed.publish('other', { ...event('other finished', 'agent_message', 'other'), threadId: 'other-thread' });
  const lagging = await feed.read('task', 'thread');
  assert.equal(lagging.history.kind, 'unavailable');
  assert.equal(lagging.entries[0]?.text, 'hello');
  assert.equal(feed.since(lagging.cursor), null);
  assert.equal((await feed.read('task', 'thread')).history.kind, 'unavailable');
  canonical = history('hello world', 'agent_message');
  const ended = { ...event('completed', 'turn_end'), itemId: null };
  canonical.push({ ...ended, key: executionKey(ended) });
  const completed = await feed.read('task', 'thread');
  assert.equal(completed.history.kind, 'available');
  assert.equal(completed.entries[0]?.text, 'hello world');
});

test('canonical turn identities exclude merged live turns and failed reads', async () => {
  let unavailable = false;
  const feed = new LiveExecution({ readHistory: async () => {
    if (unavailable) throw new Error('offline');
    return history('historical answer', 'agent_message');
  } });
  feed.publish('task', { ...event('current answer', 'agent_message', 'new-item'), turnId: 'new-turn' });
  const snapshot = await feed.read('task', 'thread');
  assert.deepEqual(snapshot.canonicalTurnIds, ['turn']);
  assert.ok(snapshot.entries.some(item => item.turnId === 'new-turn'));
  unavailable = true;
  assert.deepEqual((await feed.read('task', 'thread')).canonicalTurnIds, []);
});
