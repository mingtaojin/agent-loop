import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manualTaskTitle, normalizeManualTaskText } from '../src/domain.js';

test('manual text normalization removes one optional command at its boundary', () => {
  const cases: [string, string][] = [
    [' \t\r\nDiscuss directly\nKeep details.  ', 'Discuss directly\nKeep details.'],
    ['/new Discuss the legacy task', 'Discuss the legacy task'],
    [' \t\r\n/new\t Discuss the legacy task  ', 'Discuss the legacy task'],
    ['/new /new Strip once', '/new Strip once'],
    ['/news task', '/news task'], ['/new-task', '/new-task'], ['mention /new task', 'mention /new task'],
    ['', ''], [' \t\r\n', ''], ['/new', ''], [' \n/new \t', ''],
  ];
  for (const [text, expected] of cases) {
    assert.equal(normalizeManualTaskText(text), expected);
  }
});

test('manual titles normalize before applying caller limits and use the existing attachment fallback', () => {
  const long = 'x'.repeat(220);
  assert.equal(manualTaskTitle({ text: ` \n/new ${long}  `, maxLength: 100 }), 'x'.repeat(100));
  assert.equal(manualTaskTitle({ text: long, maxLength: 200 }), 'x'.repeat(200));
  assert.equal(manualTaskTitle({ text: ' \n/new \t', maxLength: 100 }), '新讨论');
  assert.equal(manualTaskTitle({ text: '', maxLength: 200 }), '新讨论');
  assert.equal(manualTaskTitle({ text: '/new-task', maxLength: 100 }), '/new-task');
  assert.equal(manualTaskTitle({ text: '/new /new Keep once', maxLength: 200 }), '/new Keep once');
});
