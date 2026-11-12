import assert from 'node:assert/strict';
import { test } from 'node:test';
import { incomingSchema, taskSchema } from '../src/domain.js';
import type { StoredExecutionEvent } from '../src/execution-events.js';
import { documentConversationText, projectDocumentConversation } from '../src/feishu-document-conversation.js';
import type { Inbox } from '../src/store.js';
import { progressContent } from '../src/feishu-progress-view.js';

const initial = incomingSchema.parse({ id: 'initial', chatId: 'private', senderId: 'owner', text: 'First question', attachments: [], createdAt: 1 });
const task = taskSchema.parse({ id: 'task', sourceId: 'source', source: { kind: 'manual', message: initial },
  contextDirectory: '/tmp', resources: [], status: 'running', reason: null, prompt: '', promptHash: '', skillPath: null,
  chatId: 'chat', threadId: 'thread', turnId: 'second', executionStatus: 'running', lastHandledTurnId: null,
  requests: [], createdAt: 1, updatedAt: 10 });
const event = (seq: number, kind: StoredExecutionEvent['kind'], text: string, turnId = 'first'): StoredExecutionEvent =>
  ({ seq, taskId: task.id, threadId: 'thread', turnId, itemId: 'same-id', kind, text, label: kind, createdAt: seq + 1 });

test('Feishu timestamps display UTC+8 across date and year boundaries without changing stored timestamps', () => {
  const createdAt = Date.parse('2026-12-31T16:30:00.123Z');
  const view = projectDocumentConversation(taskSchema.parse({ ...task,
    source: { kind: 'manual', message: { ...initial, createdAt: createdAt - 3600000 } },
  }), [], [{ ...event(1, 'agent_message', 'Answer'), createdAt }]);
  const text = documentConversationText(view, 3000);
  assert.ok(text.includes('最近对话事件：2027-01-01T00:30:00.123+08:00'));
  assert.ok(text.includes('助手 · 2027-01-01T00:30:00.123+08:00'));
  assert.ok(text.includes('用户 · 2026-12-31T23:30:00.123+08:00'));
  assert.equal(view.lastExecutionEventAt, createdAt);
  assert.equal(view.messages[1]?.createdAt, createdAt);
  assert.ok(progressContent({ status: 'running', lastExecutionEventAt: createdAt, cursor: 1,
    assistant: [], tool: null, notice: null }).includes('最近执行事件：2027-01-01T00:30:00.123+08:00'));
  assert.ok(documentConversationText({ ...view, lastExecutionEventAt: null }, 3000).includes('最近对话事件：尚无事件'));
});

test('conversation deduplicates original input, preserves directory replies and attachments, excludes synthetic inputs and tools', () => {
  const input = (seq: number, message: Inbox['message'] = initial): Inbox => ({ seq, id: message.id, task_id: task.id, message,
    provenance: { kind: 'user', message }, status: 'pending', origin: 'user', error: null,
    requestId: null, route: 'workspace-selection', selectionHandled: false });
  const reply = { ...initial, id: 'reply', text: 'Use this project', createdAt: 4,
    attachments: [{ key: 'image-key', kind: 'image' as const, name: 'screenshot.png' }] };
  const synthetic = { ...input(3, { ...initial, id: 'synthetic', text: 'PRIVATE_RECOVERY', createdAt: 5 }), origin: 'resume' as const };
  const view = projectDocumentConversation(task, [input(1), input(2, reply), synthetic], [
    event(1, 'agent_delta', 'Partial'), event(2, 'agent_message', 'First answer'),
    event(3, 'tool_start', 'PRIVATE_COMMAND'), event(4, 'tool_output', 'PRIVATE_OUTPUT'),
    event(5, 'agent_delta', 'Second ', 'second'), event(6, 'agent_delta', 'answer', 'second'),
    event(7, 'agent_message', 'Second answer', 'second'), event(8, 'agent_delta', ' ignored', 'second'),
  ]);
  const text = documentConversationText(view, 3000);
  assert.equal(text.match(/First question/g)?.length, 1);
  assert.match(text, /Second answer[\s\S]*Use this project[\s\S]*First answer[\s\S]*First question/);
  assert.match(text, /附件：screenshot.png/);
  assert.equal(text.match(/Second answer/g)?.length, 1);
  assert.doesNotMatch(text, /PRIVATE_|image-key|Partial|ignored/);
});

test('rendered line limit includes labels and blank lines and keeps long Unicode lines whole', () => {
  const lines = Array.from({ length: 3001 }, (_, i) => `line-${i.toString().padStart(4, '0')}`);
  const view = projectDocumentConversation(task, [], [event(1, 'agent_message', lines.join('\r\n'))]);
  const text = documentConversationText(view, 3000);
  assert.equal(text.split('\n').length, 3000);
  assert.doesNotMatch(text, /line-0000|\r/); assert.match(text, /line-3000\n\[仅展示最近对话/);
  const long = '文😀'.repeat(40_000);
  const longView = projectDocumentConversation(task, [], [event(1, 'agent_message', long)]);
  assert.ok(documentConversationText(longView, 3000).includes(long));
  for (const maxLines of [1, 2, 3, 4, 15]) assert.equal(documentConversationText(view, maxLines).split('\n').length, maxLines);
});

test('newest messages appear first while lines within each message keep their reading order', () => {
  const view = projectDocumentConversation(task, [], [
    event(1, 'agent_message', 'Older first line\nOlder second line'),
    event(2, 'agent_message', 'Newest first line\nNewest second line', 'second'),
  ]);
  const before = structuredClone(view.messages);
  const text = documentConversationText(view, 3000);
  assert.match(text, /Newest first line\nNewest second line[\s\S]*Older first line\nOlder second line[\s\S]*First question/);
  assert.deepEqual(view.messages, before);
});

test('line retention removes oldest messages rather than newest messages in a descending document', () => {
  const events = Array.from({ length: 12 }, (_, index) => ({
    ...event(index + 1, 'agent_message', `message-${index}-first\nmessage-${index}-second`), itemId: `message-${index}`,
  }));
  const text = documentConversationText(projectDocumentConversation(task, [], events), 16);
  assert.ok(text.split('\n').length <= 16);
  assert.match(text, /message-11-first\nmessage-11-second[\s\S]*message-10-first\nmessage-10-second/);
  assert.doesNotMatch(text, /message-0-|First question/);
});

test('one-shot event iterable preserves exact messages, ordering, completion and metadata', () => {
  const events: StoredExecutionEvent[] = [
    { ...event(1, 'agent_delta', 'Discarded'), createdAt: 10 },
    { ...event(2, 'agent_delta', 'Other\r'), itemId: 'interleaved', createdAt: 10 },
    { ...event(3, 'agent_delta', '\nline'), itemId: 'interleaved', createdAt: 8 },
    { ...event(4, 'agent_message', ''), createdAt: 7 },
    { ...event(5, 'agent_delta', 'Ignored after completion'), createdAt: 90 },
    { ...event(6, 'agent_message', 'Second turn', 'second'), createdAt: 10 },
    { ...event(7, 'agent_message', 'Other thread', 'second'), threadId: 'other-thread', createdAt: 9 },
    { ...event(8, 'agent_delta', 'Null delta', 'second'), itemId: null, createdAt: 10 },
    { ...event(9, 'agent_message', 'Null complete', 'second'), itemId: null, createdAt: 10 },
    { ...event(10, 'turn_end', 'completed', 'second'), createdAt: 100 },
    { ...event(11, 'turn_status', 'running', 'second'), createdAt: 110 },
    { ...event(12, 'turn_end', 'failed'), createdAt: 120 },
  ];
  let iterations = 0;
  const once: Iterable<StoredExecutionEvent> = {
    [Symbol.iterator]() { assert.equal(++iterations, 1); return events.values(); },
  };
  const streamed = projectDocumentConversation(task, [], once);
  assert.deepEqual(streamed, {
    status: 'completed', cursor: 12, lastExecutionEventAt: 90,
    messages: [
      { key: '["user","initial"]', role: 'user', text: 'First question', createdAt: 1, sequence: 0, completed: true },
      { key: '["assistant","other-thread","second","same-id"]', role: 'assistant', text: 'Other thread', createdAt: 9, sequence: 7, completed: true },
      { key: '["assistant","thread","first","same-id"]', role: 'assistant', text: '', createdAt: 10, sequence: 1, completed: true },
      { key: '["assistant","thread","first","interleaved"]', role: 'assistant', text: 'Other\nline', createdAt: 10, sequence: 2, completed: false },
      { key: '["assistant","thread","second","same-id"]', role: 'assistant', text: 'Second turn', createdAt: 10, sequence: 6, completed: true },
      { key: '["assistant","thread","second",8]', role: 'assistant', text: 'Null delta', createdAt: 10, sequence: 8, completed: false },
      { key: '["assistant","thread","second",9]', role: 'assistant', text: 'Null complete', createdAt: 10, sequence: 9, completed: true },
    ],
  });
  const fromArray = projectDocumentConversation(task, [], events);
  assert.deepEqual(streamed, fromArray);
  for (const maxLines of [1, 2, 3, 4, 8, 3000]) {
    assert.equal(documentConversationText(streamed, maxLines), documentConversationText(fromArray, maxLines));
  }
});
