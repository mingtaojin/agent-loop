import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeishuDocumentAdapter, type FeishuDocumentApi } from '../src/adapters/feishu-document.js';
import { documentChunks, documentTextElements } from '../src/feishu-document-text.js';
import { DocumentRequestRejected, TaskGroupBindingChanged, type FeishuDocumentProgressPort, type ProgressWriteGuard } from '../src/ports.js';

const success = (data: unknown) => ({ code: 0, data });
const block = (text: string, blockId = 'block') => ({ block_id: blockId, block_type: 2, text: { elements: [{ text_run: { content: text } }] } });
function fixture() {
  const calls: { kind: string; input: unknown; time: number }[] = [];
  let now = 0;
  const replies = new Map<string, unknown>();
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const request = (kind: string) => async (input: unknown) => {
    calls.push({ kind, input, time: now });
    const handler = handlers.get(kind);
    if (handler) return handler(input);
    return replies.get(kind);
  };
  const api = { document: { create: request('document') }, children: { create: request('block'), get: request('children'), batchDelete: request('delete') },
    block: { get: request('read'), patch: request('write') }, members: { create: request('grant'), list: request('members') },
    tabs: { create: request('tab'), listTabs: request('tabs') } };
  const adapter = new FeishuDocumentAdapter(() => api as unknown as FeishuDocumentApi,
    { now: () => now, sleep: async ms => { now += ms; } });
  return { adapter, calls, replies, handlers };
}

const guardedWrites: { name: string; run(port: FeishuDocumentProgressPort, guard: ProgressWriteGuard): Promise<unknown> }[] = [
  { name: 'document', run: (port, guard) => port.createDocument({ title: 'Progress' }, guard) },
  { name: 'block', run: (port, guard) => port.createBlock({ documentId: 'doc', text: 'Text', clientToken: 'token' }, guard) },
  { name: 'write', run: (port, guard) => port.replaceContent({ documentId: 'doc', blockId: 'block', text: 'Text', clientToken: 'token' }, guard) },
  { name: 'delete', run: (port, guard) => port.removeBlocks({ documentId: 'doc', parentBlockId: 'parent', blockIds: ['owned'], clientToken: 'token' }, guard) },
  { name: 'grant', run: (port, guard) => port.grantGroupRead({ documentId: 'doc', chatId: 'group' }, guard) },
  { name: 'tab', run: (port, guard) => port.createTab({ chatId: 'group', documentUrl: 'https://tenant.feishu.cn/docx/doc' }, guard) },
];
for (const operation of guardedWrites) test(`retiring a binding before SDK dispatch cancels queued document ${operation.name}`, async () => {
  const f = fixture();
  f.replies.set('read', success({ block: block('Original') }));
  f.replies.set('children', success({ items: [block('Owned', 'owned')], has_more: false }));
  await f.adapter.readBlock({ documentId: 'doc', blockId: 'block' });
  let current = true;
  const writing = operation.run(f.adapter, () => { if (!current) throw new TaskGroupBindingChanged(); });
  current = false;
  await assert.rejects(writing, TaskGroupBindingChanged);
  assert.equal(f.calls.filter(call => call.kind === operation.name).length, 0);
});

test('SDK arguments use exact persisted tokens, inert text, narrow group permission and explicit document URL', async () => {
  const f = fixture();
  f.replies.set('document', success({ document: { document_id: 'doc' } }));
  assert.equal(await f.adapter.createDocument({ title: '执行进度' }), 'doc');
  assert.deepEqual(f.calls.at(-1)?.input, { data: { title: '执行进度' } });
  const text = '<at user_id="all">@all</at> **literal**\nline';
  f.replies.set('block', success({ children: [block(text)], client_token: 'saved-token' }));
  assert.equal(await f.adapter.createBlock({ documentId: 'doc', text, clientToken: 'saved-token' }), 'block');
  assert.deepEqual(f.calls.at(-1)?.input, { path: { document_id: 'doc', block_id: 'doc' }, params: { document_revision_id: -1, client_token: 'saved-token' },
    data: { children: [{ block_type: 2, text: { elements: [{ text_run: { content: text } }] } }], index: -1 } });
  f.replies.set('write', success({ block: block(text), client_token: 'write-token' }));
  await f.adapter.replaceContent({ documentId: 'doc', blockId: 'block', text, clientToken: 'write-token' });
  assert.deepEqual(f.calls.at(-1)?.input, { path: { document_id: 'doc', block_id: 'block' }, params: { document_revision_id: -1, client_token: 'write-token' },
    data: { update_text_elements: { elements: [{ text_run: { content: text } }] } } });
  f.replies.set('grant', success({ member: { member_type: 'openchat', member_id: 'chat', perm: 'view' } }));
  await f.adapter.grantGroupRead({ documentId: 'doc', chatId: 'chat' });
  assert.deepEqual(f.calls.at(-1)?.input, { path: { token: 'doc' }, params: { type: 'docx', need_notification: false }, data: { member_type: 'openchat', member_id: 'chat', perm: 'view' } });
  const documentUrl = 'https://tenant.feishu.cn/docx/doc';
  f.replies.set('tab', success({ chat_tabs: [{ tab_id: 'tab', tab_type: 'doc', tab_content: { doc: documentUrl } }] }));
  assert.equal(await f.adapter.createTab({ chatId: 'chat', documentUrl }), 'tab');
  assert.deepEqual(f.calls.at(-1)?.input, { path: { chat_id: 'chat' }, data: { chat_tabs: [{ tab_name: '执行进度', tab_type: 'doc', tab_content: { doc: documentUrl } }] } });
  assert.deepEqual(f.calls.map(call => call.time), [0, 500, 1000, 1500, 2000]);
});

test('real permission rejection without data and Axios HTTP400 are definitive; internal/malformed/transport outcomes remain unknown', async () => {
  const f = fixture();
  const rejected = { code: 99991672, msg: 'Access denied. One of the following scopes is required: [docx:document]' };
  f.replies.set('document', rejected);
  await assert.rejects(f.adapter.createDocument({ title: '执行进度' }), DocumentRequestRejected);
  f.handlers.set('document', async () => { throw { response: { status: 400, data: rejected } }; });
  await assert.rejects(f.adapter.createDocument({ title: '执行进度' }), DocumentRequestRejected);
  f.handlers.delete('document');
  for (const reply of [{ code: 0 }, success({ document: {} }), { code: 1771001, msg: 'server internal error' }, { code: 1066001, msg: 'Internal Error' }]) {
    f.replies.set('document', reply);
    await assert.rejects(f.adapter.createDocument({ title: '执行进度' }), error => error instanceof Error && !(error instanceof DocumentRequestRejected));
  }
  f.handlers.set('document', async () => { throw new Error('ETIMEDOUT'); });
  await assert.rejects(f.adapter.createDocument({ title: '执行进度' }), error => error instanceof Error && !(error instanceof DocumentRequestRejected));
});

test('reconcile exact initial text across pages, skip unrelated rich text, reject duplicates and incomplete scans', async () => {
  const f = fixture(); let page = 0;
  f.handlers.set('children', async () => ++page === 1
    ? success({ items: [{ block_id: 'other', block_type: 2, text: { elements: [{ mention_user: { user_id: 'someone' } }] } }], has_more: true, page_token: 'next' })
    : success({ items: [block('initial')], has_more: false }));
  assert.equal(await f.adapter.findBlock({ documentId: 'doc', text: 'initial' }), 'block');
  assert.deepEqual(f.calls.at(-1)?.input, { path: { document_id: 'doc', block_id: 'doc' }, params: { document_revision_id: -1, page_size: 500, page_token: 'next' } });
  f.handlers.delete('children');
  f.replies.set('children', success({ items: [block('initial'), block('initial', 'duplicate')], has_more: false }));
  await assert.rejects(f.adapter.findBlock({ documentId: 'doc', text: 'initial' }), /Multiple matching/);
  for (const data of [{ items: [], has_more: true }, { items: [] }, { items: [], has_more: true, page_token: 'repeat' }]) {
    f.replies.set('children', success(data)); await assert.rejects(f.adapter.findBlock({ documentId: 'doc', text: 'initial' }));
  }
});

test('member and tab reconciliation match exact IDs, preserve existing higher permission and reject wrong successful writes', async () => {
  const f = fixture();
  for (const perm of ['view', 'edit', 'full_access']) {
    f.replies.set('members', success({ items: [{ member_type: 'openchat', member_id: 'chat', perm }] }));
    assert.equal(await f.adapter.hasGroupRead({ documentId: 'doc', chatId: 'chat' }), true);
    assert.deepEqual(f.calls.at(-1)?.input, { path: { token: 'doc' }, params: { type: 'docx' } });
  }
  f.replies.set('members', success({ items: [{ member_type: 'openid', member_id: 'chat', perm: 'view' }] }));
  assert.equal(await f.adapter.hasGroupRead({ documentId: 'doc', chatId: 'chat' }), false);
  const documentUrl = 'https://tenant.feishu.cn/docx/doc';
  f.replies.set('tabs', success({ chat_tabs: [{ tab_id: 'wrong', tab_name: '执行进度', tab_type: 'doc', tab_content: { doc: documentUrl + '2' } }] }));
  assert.equal(await f.adapter.findTab({ chatId: 'chat', documentUrl }), null);
  const tab = { tab_id: 'right', tab_type: 'doc', tab_content: { doc: documentUrl } };
  f.replies.set('tabs', success({ chat_tabs: [tab] })); assert.equal(await f.adapter.findTab({ chatId: 'chat', documentUrl }), 'right');
  f.replies.set('tabs', success({ chat_tabs: [tab, tab] })); await assert.rejects(f.adapter.findTab({ chatId: 'chat', documentUrl }), /Multiple/);
  f.replies.set('write', success({ block: block('expected', 'wrong'), client_token: 'token' }));
  await assert.rejects(f.adapter.replaceContent({ documentId: 'doc', blockId: 'block', text: 'expected', clientToken: 'token' }), /identity mismatch/);
  f.replies.set('grant', success({ member: { member_type: 'openid', member_id: 'chat', perm: 'view' } }));
  await assert.rejects(f.adapter.grantGroupRead({ documentId: 'doc', chatId: 'chat' }));
});

test('pacing bounds all SDK starts to two per second without waiting for another task network response', async () => {
  const f = fixture(); let release = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.handlers.set('document', async () => { await blocked; return success({ document: { document_id: 'slow' } }); });
  f.replies.set('tabs', success({ chat_tabs: [] }));
  const first = f.adapter.createDocument({ title: '执行进度' });
  const second = f.adapter.findTab({ chatId: 'another-chat', documentUrl: 'https://tenant.feishu.cn/docx/another' });
  assert.equal(await second, null);
  assert.deepEqual(f.calls.map(call => [call.kind, call.time]), [['document', 0], ['tabs', 500]]);
  release(); assert.equal(await first, 'slow');
  await Promise.all(Array.from({ length: 5 }, () => f.adapter.findTab({ chatId: 'chat', documentUrl: 'https://tenant.feishu.cn/docx/doc' })));
  assert.deepEqual(f.calls.map(call => call.time), [0, 500, 1000, 1500, 2000, 2500, 3000]);
});

test('long Unicode text uses bounded inert text runs without splitting surrogate pairs', async () => {
  const f = fixture(); const text = '文😀<at>\\\n'.repeat(600);
  f.replies.set('write', success({ block: block(text), client_token: 'token' }));
  await f.adapter.replaceContent({ documentId: 'doc', blockId: 'block', text, clientToken: 'token' });
  const input = f.calls.at(-1)?.input;
  assert.ok(input && typeof input === 'object' && 'data' in input);
  const serialized = JSON.stringify(input);
  assert.ok(Buffer.byteLength(serialized) < 24_000); assert.doesNotMatch(serialized, /"mention_user"|"link"|\\ud[89a-f][0-9a-f]{2}/i);
  assert.ok(serialized.match(/"text_run"/g)!.length > 1);
});

test('overflow creation uses its saved parent, index and token while reads remain scoped to one block', async () => {
  const f = fixture(), text = 'overflow';
  f.replies.set('block', success({ children: [block(text, 'child')], client_token: 'child-token' }));
  assert.equal(await f.adapter.createBlock({ documentId: 'doc', parentBlockId: 'managed', index: 3, text, clientToken: 'child-token' }), 'child');
  assert.deepEqual(f.calls.at(-1)?.input, { path: { document_id: 'doc', block_id: 'managed' },
    params: { document_revision_id: -1, client_token: 'child-token' },
    data: { children: [{ block_type: 2, text: { elements: [{ text_run: { content: text } }] } }], index: 3 } });
  f.replies.set('read', success({ block: block(text, 'child') }));
  assert.equal(await f.adapter.readBlock({ documentId: 'doc', blockId: 'child' }), text);
  assert.deepEqual(f.calls.at(-1)?.input, { path: { document_id: 'doc', block_id: 'child' }, params: { document_revision_id: -1 } });
  await assert.rejects(f.adapter.createBlock({ documentId: 'doc', parentBlockId: 'managed', index: -2, text, clientToken: 'invalid' }));
  assert.equal(f.calls.length, 2);
});

test('indexed reconciliation adopts only the exact child position across a complete paginated listing', async () => {
  const f = fixture(); let page = 0;
  f.handlers.set('children', async () => ++page % 2 === 1
    ? success({ items: [block('repeated', 'older'), { block_id: 'rich', block_type: 2, text: { elements: [{ mention_user: { user_id: 'someone' } }] } }], has_more: true, page_token: 'next' })
    : success({ items: [block('repeated', 'intended')], has_more: false }));
  const input = { documentId: 'doc', parentBlockId: 'managed', text: 'repeated', index: 2 };
  assert.equal(await f.adapter.findBlock(input), 'intended');
  assert.deepEqual(f.calls.at(-1)?.input, { path: { document_id: 'doc', block_id: 'managed' },
    params: { document_revision_id: -1, page_size: 500, page_token: 'next' } });
  assert.equal(await f.adapter.findBlock({ ...input, index: 3 }), null);
  await assert.rejects(f.adapter.findBlock({ ...input, index: 1 }), /saved index/);
  await assert.rejects(f.adapter.findBlock({ ...input, text: 'different' }), /saved index/);
  await assert.rejects(f.adapter.findBlock({ ...input, index: undefined }), /Multiple matching/);
  f.handlers.set('children', async () => success({ items: [block('repeated', 'intended')], has_more: true }));
  await assert.rejects(f.adapter.findBlock({ ...input, index: 0 }), /Incomplete/);
});

test('removeBlocks deletes only the completely listed saved suffix with the exact token and paced SDK calls', async () => {
  const f = fixture(); let page = 0;
  f.handlers.set('children', async () => ++page === 1
    ? success({ items: [block('retained', 'keep'), block('one', 'owned-1')], has_more: true, page_token: 'next' })
    : success({ items: [block('two', 'owned-2')], has_more: false }));
  f.replies.set('delete', success({ client_token: 'remove-token', document_revision_id: 42 }));
  await f.adapter.removeBlocks({ documentId: 'doc', parentBlockId: 'managed', blockIds: ['owned-1', 'owned-2'], clientToken: 'remove-token' });
  assert.deepEqual(f.calls.at(-1)?.input, { path: { document_id: 'doc', block_id: 'managed' },
    params: { document_revision_id: -1, client_token: 'remove-token' }, data: { start_index: 1, end_index: 3 } });
  assert.deepEqual(f.calls.map(call => [call.kind, call.time]), [['children', 0], ['children', 500], ['delete', 1000]]);
});

test('removeBlocks rejects partial absence, wrong ordering, unrelated suffixes and incomplete or duplicate listings', async () => {
  const input = { documentId: 'doc', parentBlockId: 'managed', blockIds: ['owned-1', 'owned-2'], clientToken: 'remove-token' };
  for (const ids of [['owned-1'], ['owned-2', 'owned-1'], ['owned-1', 'owned-2', 'stranger'], ['owned-1', 'stranger', 'owned-2']]) {
    const f = fixture();
    f.replies.set('children', success({ items: ids.map(id => block(id, id)), has_more: false }));
    await assert.rejects(f.adapter.removeBlocks(input), /complete expected suffix/);
    assert.equal(f.calls.filter(call => call.kind === 'delete').length, 0);
  }
  const f = fixture();
  f.replies.set('children', success({ items: [block('one', 'owned-1')], has_more: true }));
  await assert.rejects(f.adapter.removeBlocks(input), /Incomplete/);
  f.replies.set('children', success({ items: [block('one', 'owned-1'), block('duplicate', 'owned-1')], has_more: false }));
  await assert.rejects(f.adapter.removeBlocks(input), /Duplicate document child/);
  await assert.rejects(f.adapter.removeBlocks({ ...input, blockIds: ['owned-1', 'owned-1'] }), /Duplicate owned/);
  assert.equal(f.calls.filter(call => call.kind === 'delete').length, 0);
});

test('removeBlocks reconciles a lost delete ACK by observing all owned IDs absent without a second delete', async () => {
  const f = fixture(); let removed = false;
  f.handlers.set('children', async () => success({ items: removed ? [block('untouched', 'other')] : [block('owned', 'owned')], has_more: false }));
  f.handlers.set('delete', async () => { removed = true; throw new Error('lost ACK'); });
  const input = { documentId: 'doc', parentBlockId: 'managed', blockIds: ['owned'], clientToken: 'same-token' };
  await assert.rejects(f.adapter.removeBlocks(input), /lost ACK/);
  await f.adapter.removeBlocks(input);
  assert.equal(f.calls.filter(call => call.kind === 'delete').length, 1);
  const count = f.calls.length;
  await f.adapter.removeBlocks({ ...input, blockIds: [] });
  assert.equal(f.calls.length, count);
});

test('removeBlocks validates the successful SDK response and keeps ambiguous outcomes distinguishable from rejection', async () => {
  const f = fixture();
  f.replies.set('children', success({ items: [block('owned', 'owned')], has_more: false }));
  const input = { documentId: 'doc', parentBlockId: 'managed', blockIds: ['owned'], clientToken: 'saved-token' };
  for (const reply of [success({ client_token: 'wrong' }), success({}), { code: 1771001, msg: 'Internal Error' }]) {
    f.replies.set('delete', reply);
    await assert.rejects(f.adapter.removeBlocks(input), error => error instanceof Error && !(error instanceof DocumentRequestRejected));
  }
  f.replies.set('delete', { code: 99991672, msg: 'Access denied' });
  await assert.rejects(f.adapter.removeBlocks(input), DocumentRequestRejected);
});

test('documentChunks preserves Unicode, escaped characters, CRLF and oversized lines without a total byte cap', async () => {
  for (const text of ['', 'short\r\nline\n', '文😀<at>\\\n'.repeat(20_000), '\u0000\t"\\😀'.repeat(20_000), '😀'.repeat(100_001)]) {
    const chunks = documentChunks(text);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.length > 0);
    if (text.length > 24_000) assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.doesNotMatch(chunk, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      const elements = documentTextElements(chunk);
      assert.ok(Buffer.byteLength(JSON.stringify(elements)) <= 24_000);
      assert.ok(elements.every(element => element.text_run.content.length <= 1000));
    }
  }
});

test('documentChunks prefers complete newline boundaries and every chunk passes the real adapter payload guard', async () => {
  const text = ('line\r\n' + '文😀'.repeat(800) + '\n').repeat(15), chunks = documentChunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.slice(0, -1).every(chunk => chunk.endsWith('\n')));
  const f = fixture();
  f.handlers.set('block', async input => {
    assert.ok(input && typeof input === 'object' && 'data' in input && 'params' in input);
    const data = input.data, params = input.params;
    assert.ok(data && typeof data === 'object' && 'children' in data && Array.isArray(data.children));
    assert.ok(params && typeof params === 'object' && 'client_token' in params);
    return success({ children: [Object.assign({ block_id: 'created' }, data.children[0])], client_token: params.client_token });
  });
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(await f.adapter.createBlock({ documentId: 'doc', parentBlockId: 'managed', index, text: chunk, clientToken: `token-${index}` }), 'created');
  }
  const count = f.calls.length;
  await assert.rejects(f.adapter.createBlock({ documentId: 'doc', text, clientToken: 'too-large' }), /payload limit/);
  assert.equal(f.calls.length, count, 'oversized individual requests fail before SDK dispatch');
});
