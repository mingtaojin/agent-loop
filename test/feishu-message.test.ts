import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { renderFeishuMessage } from '../src/adapters/feishu-message.js';

const postSchema = z.object({ zh_cn: z.object({ content: z.array(z.array(z.object({ tag: z.literal('md'), text: z.string() }))) }) });
function markdown(raw: string): string {
  const rendered = renderFeishuMessage(raw);
  assert.equal(rendered.msg_type, 'post');
  const post = postSchema.parse(JSON.parse(rendered.content));
  assert.equal(post.zh_cn.content.length, 1);
  assert.equal(post.zh_cn.content[0]?.length, 1);
  const node = post.zh_cn.content[0]?.[0]; assert.ok(node);
  return node.text;
}

test('native Markdown keeps headings, tables, lists, links and code intact', () => {
  const raw = '# Result\n\n**Ready**\n\n- Item\n\n| Item | State |\n| --- | --- |\n| A | Done |\n\n'
    + '[report](https://example.com/a_(b)?x=1&y=2)\n\n```ts\nconst value = "<at user_id=all>";\n```';
  assert.equal(markdown(raw), raw);
  assert.equal(markdown('Task queued.\nWaiting for input.'), 'Task queued.\nWaiting for input.');
});

test('local citations preserve labels and source positions without exposing long link destinations', () => {
  for (const target of ['/Users/demo/source.ts:42:3', '/Users/demo/source.ts#L42C3', 'file:///Users/demo/source.ts#L42C3']) {
    const displayed = markdown(`[implementation](${target})`);
    assert.ok(displayed.includes('implementation'));
    assert.ok(displayed.includes('source.ts:42'));
    assert.ok(!displayed.includes('/Users/'));
    assert.ok(!displayed.includes('file:'));
  }
  const windows = markdown('[source](C:\\Users\\demo\\source.ts:12)');
  assert.ok(windows.includes('source.ts:12'));
  assert.ok(!windows.includes('C:'));
  const spaces = markdown('[details](</Users/demo/My Project/read(me).ts#L7>)');
  assert.ok(spaces.includes('details'));
  assert.ok(spaces.includes('read(me).ts:7'));
  assert.ok(!spaces.includes('/Users/'));
  const pathLabel = markdown('[/Users/demo/source.ts:42](/Users/demo/source.ts#L42)');
  assert.ok(pathLabel.includes('source.ts:42'));
  assert.ok(!pathLabel.includes('/Users/'));
});

test('reference citations are resolved while remote and relative references remain unchanged', () => {
  const raw = '[source][local]\n\n[local]: /Users/demo/source.ts#L24\n\n[web][remote]\n\n[remote]: https://example.com/report';
  const displayed = markdown(raw);
  assert.ok(displayed.includes('source.ts:24'));
  assert.ok(!displayed.includes('/Users/'));
  assert.ok(displayed.includes('[web][remote]'));
  assert.ok(displayed.includes('[remote]: https://example.com/report'));
  const relative = '[guide](docs/guide.md) and [section](#details)';
  assert.equal(markdown(relative), relative);
  const protocolRelative = '[web](//example.com/report)';
  assert.equal(markdown(protocolRelative), protocolRelative);
});

test('citation normalization does not edit code or escaped link examples', () => {
  const examples = [
    '`[source](/Users/demo/source.ts:9)`',
    '```md\n[source](/Users/demo/source.ts:9)\n<at user_id=all>\n```',
    '    [source](/Users/demo/source.ts:9)\n    <at user_id=all>',
    '\\[source](/Users/demo/source.ts:9)',
  ];
  for (const raw of examples) assert.equal(markdown(raw), raw);
});

test('raw mention markup is literal while code examples and autolinks keep their content', () => {
  const raw = '<at user_id="all">all</at> and <at user_id="ou_owner">owner</at>\n\n'
    + '`<at user_id="all">`\n\n<https://example.com/report>';
  const displayed = markdown(raw);
  assert.ok(displayed.includes('&lt;at'));
  assert.ok(displayed.includes('&lt;/at'));
  assert.ok(displayed.includes('`<at user_id="all">`'));
  assert.ok(displayed.includes('<https://example.com/report>'));
});

test('escaping HTML preserves blockquote and list continuation markers', () => {
  for (const raw of ['> <div>\n> body\n> </div>', '- <div>\n  body\n  </div>', '> <span\n> title="example">body</span>']) {
    const displayed = markdown(raw);
    const expected = raw.replace(/</g, '&lt;');
    assert.equal(displayed, expected);
  }
});

test('literal HTML cannot consume a following Markdown code example', () => {
  const code = '```ts\nconst literal = "<at user_id=all> [source](/Users/demo/file.ts:9)";\n```';
  const displayed = markdown('<div>\n' + code + '\n</div>');
  assert.equal(displayed, '&lt;div>\n' + code + '\n&lt;/div>');
});

test('the byte budget accounts for nested JSON escaping and never truncates a fallback answer', () => {
  for (const raw of ['结果🙂'.repeat(6000), '"\\\n'.repeat(7000), '```ts\n' + 'x'.repeat(30_000) + '\n```']) {
    const rendered = renderFeishuMessage(raw);
    assert.equal(rendered.msg_type, 'text');
    assert.deepEqual(JSON.parse(rendered.content), { text: raw });
  }
  for (const count of [1, 100, 500, 1500, 2500]) {
    const raw = '"\\结果🙂\n'.repeat(count);
    const rendered = renderFeishuMessage(raw);
    if (rendered.msg_type === 'post') {
      assert.ok(Buffer.byteLength(JSON.stringify({ receive_id: 'oc_owner', ...rendered, uuid: 'a'.repeat(32) })) < 30_000);
      assert.equal(markdown(raw), raw);
    } else assert.deepEqual(JSON.parse(rendered.content), { text: raw });
  }
});
