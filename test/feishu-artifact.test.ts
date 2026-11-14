import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { FeishuApiError } from '../src/ports.js';
import { FeishuArtifactAdapter, type FeishuArtifactApi } from '../src/adapters/feishu-artifact.js';
import { FeishuArtifactConflictError, FeishuArtifactValidationError, InMemoryArtifactDeliveryLedger, type ArtifactDeliveryRecord } from '../src/feishu-artifact.js';
import { StoreArtifactDeliveryLedger } from '../src/feishu-artifact-ledger.js';
import { Store } from '../src/store.js';
import { UncertainOperationError } from '../src/domain.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const owner = 'oc_fixture';

function apiFixture() {
  const uploads = { images: [] as NonNullable<Parameters<FeishuArtifactApi['image']['create']>[0]>[], files: [] as NonNullable<Parameters<FeishuArtifactApi['file']['create']>[0]>[] };
  const messages: NonNullable<Parameters<FeishuArtifactApi['message']['create']>[0]>[] = [];
  const api: FeishuArtifactApi = {
    image: { create: async input => { assert.ok(input); uploads.images.push(input); return { image_key: 'img_fixture' }; } },
    file: { create: async input => { assert.ok(input); uploads.files.push(input); return { file_key: 'file_fixture' }; } },
    message: { create: async input => { assert.ok(input); messages.push(input); return { code: 0, data: { message_id: `om_${messages.length}` } }; } },
  };
  return { api, uploads, messages };
}

test('FeishuArtifactAdapter sends validated images and files and reuses sent receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-loop-artifact-'));
  try {
    const imagePath = join(directory, 'concept.png');
    const filePath = join(directory, 'evidence.log');
    await writeFile(imagePath, png); await writeFile(filePath, 'fixture log\n');
    const fixture = apiFixture();
    const adapter = new FeishuArtifactAdapter(fixture.api, { maxImageBytes: 100, maxFileBytes: 100 });
    const image = await adapter.sendLocalArtifact({ kind: 'image', chatId: owner, id: 'image-1', path: imagePath });
    const repeated = await adapter.sendLocalArtifact({ kind: 'image', chatId: owner, id: 'image-1', path: imagePath });
    const file = await adapter.sendLocalArtifact({ kind: 'file', chatId: owner, id: 'file-1', path: filePath });
    assert.deepEqual(repeated, image);
    assert.equal(image.kind, 'image'); assert.equal(image.key, 'img_fixture'); assert.equal(image.name, 'concept.png'); assert.equal(image.bytes, png.length);
    assert.equal(file.kind, 'file'); assert.equal(file.key, 'file_fixture'); assert.equal(file.name, 'evidence.log');
    assert.equal(fixture.uploads.images.length, 1); assert.equal(fixture.uploads.files.length, 1); assert.equal(fixture.messages.length, 2);
    assert.deepEqual(fixture.uploads.images[0]?.data, { image_type: 'message', image: png });
    assert.deepEqual(fixture.uploads.files[0]?.data, { file_type: 'stream', file_name: 'evidence.log', file: Buffer.from('fixture log\n') });
    assert.equal(fixture.messages[0]?.data.msg_type, 'image'); assert.equal(fixture.messages[1]?.data.msg_type, 'file');
    assert.equal(fixture.messages[0]?.data.content, JSON.stringify({ image_key: 'img_fixture' }));
    assert.equal(fixture.messages[1]?.data.content, JSON.stringify({ file_key: 'file_fixture' }));
    assert.equal(fixture.messages[0]?.data.content.includes(imagePath), false);
    assert.match(fixture.messages[0]?.data.uuid ?? '', /^[0-9a-f-]{36}$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('FeishuArtifactAdapter rejects invalid local artifacts before SDK calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-loop-artifact-invalid-'));
  try {
    const fixture = apiFixture();
    const adapter = new FeishuArtifactAdapter(fixture.api, { maxImageBytes: 8, maxFileBytes: 8 });
    const wrong = join(directory, 'wrong.png'); const empty = join(directory, 'empty.log'); const large = join(directory, 'large.log');
    await writeFile(wrong, 'not an image'); await writeFile(empty, ''); await writeFile(large, '123456789');
    await assert.rejects(adapter.sendLocalArtifact({ kind: 'image', chatId: owner, id: 'wrong', path: wrong }), FeishuArtifactValidationError);
    await assert.rejects(adapter.sendLocalArtifact({ kind: 'file', chatId: owner, id: 'empty', path: empty }), FeishuArtifactValidationError);
    await assert.rejects(adapter.sendLocalArtifact({ kind: 'file', chatId: owner, id: 'large', path: large }), FeishuArtifactValidationError);
    await assert.rejects(adapter.sendLocalArtifact({ kind: 'file', chatId: owner, id: 'relative', path: 'relative.log' }), FeishuArtifactValidationError);
    assert.equal(fixture.uploads.images.length + fixture.uploads.files.length, 0); assert.equal(fixture.messages.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('FeishuArtifactAdapter retains uploaded keys across a known message rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-loop-artifact-retry-'));
  try {
    const path = join(directory, 'concept.png'); await writeFile(path, png);
    const fixture = apiFixture(); let reject = true;
    fixture.api.message.create = async input => { assert.ok(input); fixture.messages.push(input); return reject ? { code: 999, msg: 'denied' } : { code: 0, data: { message_id: 'om_retry' } }; };
    const adapter = new FeishuArtifactAdapter(fixture.api, {}, new InMemoryArtifactDeliveryLedger());
    await assert.rejects(adapter.sendLocalArtifact({ kind: 'image', chatId: owner, id: 'retry', path }), error => error instanceof FeishuApiError && error.code === 999);
    reject = false;
    const receipt = await adapter.sendLocalArtifact({ kind: 'image', chatId: owner, id: 'retry', path });
    assert.equal(receipt.messageId, 'om_retry'); assert.equal(fixture.uploads.images.length, 1); assert.equal(fixture.messages.length, 2);
    assert.equal(fixture.messages[0]?.data.uuid, fixture.messages[1]?.data.uuid);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('FeishuArtifactAdapter classifies unknown upload and send outcomes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-loop-artifact-unknown-'));
  try {
    const path = join(directory, 'concept.png'); await writeFile(path, png);
    const uploadFixture = apiFixture(); uploadFixture.api.image.create = async () => { throw new Error('connection reset'); };
    await assert.rejects(new FeishuArtifactAdapter(uploadFixture.api).sendLocalArtifact({ kind: 'image', chatId: owner, id: 'upload-unknown', path }), UncertainOperationError);
    const sendFixture = apiFixture(); sendFixture.api.message.create = async input => { assert.ok(input); sendFixture.messages.push(input); throw new Error('connection reset'); };
    await assert.rejects(new FeishuArtifactAdapter(sendFixture.api).sendLocalArtifact({ kind: 'image', chatId: owner, id: 'send-unknown', path }), UncertainOperationError);
    assert.equal(sendFixture.uploads.images.length, 1); assert.equal(sendFixture.messages.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('FeishuArtifactAdapter rejects delivery ID conflicts and coalesces concurrent calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-loop-artifact-concurrent-'));
  try {
    const path = join(directory, 'concept.png'); await writeFile(path, png);
    const fixture = apiFixture(); let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fixture.api.image.create = async input => { assert.ok(input); fixture.uploads.images.push(input); await gate; return { image_key: 'img_concurrent' }; };
    const adapter = new FeishuArtifactAdapter(fixture.api);
    const first = adapter.sendLocalArtifact({ kind: 'image', chatId: owner, id: 'same', path });
    await new Promise(resolve => setImmediate(resolve));
    const second = adapter.sendLocalArtifact({ kind: 'image', chatId: owner, id: 'same', path });
    release?.();
    assert.deepEqual(await Promise.all([first, second]).then(values => values[0]), await second);
    await assert.rejects(adapter.sendLocalArtifact({ kind: 'image', chatId: 'other', id: 'same', path }), FeishuArtifactConflictError);
    assert.equal(fixture.uploads.images.length, 1); assert.equal(fixture.messages.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('StoreArtifactDeliveryLedger persists the artifact idempotency record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-loop-artifact-ledger-'));
  try {
    const record: ArtifactDeliveryRecord = { id: 'persisted', chatId: owner, kind: 'file', name: 'run.log', bytes: 4, sha256: '0'.repeat(64), key: 'file_key', status: 'sent', messageId: 'om_sent' };
    const first = new Store(directory); await new StoreArtifactDeliveryLedger(first).write(record); first.close();
    const second = new Store(directory); assert.deepEqual(await new StoreArtifactDeliveryLedger(second).read(record.id), record); second.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
