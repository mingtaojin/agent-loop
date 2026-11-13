import { SurfaceCodex, testProject, restoreSurface, tickSurface } from './coordinated-surfaces.js';
import { workerCalls } from './coordinated-runtime.js';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { configSchema } from '../src/config.js';
import { CodexAppServer } from '../src/adapters/codex.js';
import type { AgentInput, IncomingMessage } from '../src/domain.js';
import { AgentLoop } from '../src/loop.js';
import { WorkspaceProvider } from '../src/workspace.js';
import { CodexFake, FeishuFake, GitHubFake } from './fakes.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agent-image-inputs-'));
  const config = configSchema.parse({ dataDir: root, projects: [testProject(root)], feishu: { userOpenId: 'owner' } });
  const codex = new SurfaceCodex(), feishu = new FeishuFake();
  const loop = new AgentLoop(config, { codex, feishu, github: new GitHubFake(), workspace: {
    async ensure(input) { if (input.kind === 'project-directory') return input.directory; const path = join(root, input.resourceId); await mkdir(path, { recursive: true }); return path; },
    async head() { return 'head'; },
  } });
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  const message = (id: string, keys: string[], chatId = 'private'): IncomingMessage => ({
    id, chatId, chatType: chatId === 'private' ? 'p2p' : 'group', senderId: 'owner',
    text: 'Keep the complete description.\nAnd its second line.', createdAt: Date.now(),
    attachments: keys.map(key => ({ key, name: `${key}.png`, kind: 'image' })),
  });
  const task = () => { const task = loop.tasks().find(task => !task.sourceId.startsWith('project:')); assert.ok(task); return task; };
  return { root, config, loop, codex, feishu, message, task };
}

const referenceSchema = z.object({ messageId: z.string(), name: z.string(), path: z.string() });
function references(input: AgentInput[]): z.infer<typeof referenceSchema>[] {
  assert.ok(input.every(item => item.kind === 'text'), 'Image messages must contain only ordinary text inputs');
  return input.flatMap(item => {
    if (item.kind !== 'text' || !item.text.startsWith('Image attachment as data: ')) return [];
    const value = referenceSchema.parse(JSON.parse(item.text.slice('Image attachment as data: '.length).split('\n')[0] ?? ''));
    assert.ok(isAbsolute(value.path));
    return [{ messageId: value.messageId, name: value.name, path: value.path }];
  });
}

test('initial images reach selection and formal delivery as text references to intact local files', async t => {
  const f = await fixture(t);
  const bytes = [Buffer.from('first original image\0'), Buffer.from('second original image\0')];
  for (const [index, data] of bytes.entries()) f.feishu.resources.set(`image-${index}`, data);
  const message = f.message('initial-images', ['image-0', 'image-1']);
  await restoreSurface(f.loop, message);
  const selected = f.codex.selections[0]?.input, formal = workerCalls(f.loop, f.codex).starts[0]?.input;
  assert.ok(selected && formal);
  assert.deepEqual(formal[0], { kind: 'text', text: message.text });
  const refs = references(formal);
  assert.equal(refs.length, 2);
  assert.deepEqual(references(selected), refs);
  assert.deepEqual(refs.map(ref => [ref.messageId, ref.name]), [['initial-images', 'image-0.png'], ['initial-images', 'image-1.png']]);
  assert.deepEqual(await Promise.all(refs.map(ref => readFile(ref.path))), bytes);
  assert.notEqual(refs[0]?.path, refs[1]?.path);
  assert.equal(f.feishu.downloads.length, 2);
});

test('follow-up images and retries use text paths while later text never reattaches prior images', async t => {
  const f = await fixture(t);
  f.feishu.resources.set('first', Buffer.from('first-image'));
  await restoreSurface(f.loop, f.message('initial', ['first']));
  const chatId = f.task().chatId; assert.ok(chatId);
  f.feishu.resources.set('next', Buffer.from('next-image'));
  f.feishu.downloadFailures.add('next');
  const failed = f.message('followup', ['next'], chatId);
  await restoreSurface(f.loop, failed);
  assert.equal(workerCalls(f.loop, f.codex).steers.length, 0);
  assert.equal(f.loop.store.inputs(f.task().id).at(-1)?.status, 'failed');
  assert.deepEqual(f.loop.store.inputs(f.task().id).at(-1)?.message, failed);
  assert.ok(f.feishu.sent.some(output => output.chatId === chatId && output.text.includes('附件准备失败')));
  f.feishu.downloadFailures.delete('next');
  await f.loop.retryAttachment(f.task().id, failed.id);
  const input = workerCalls(f.loop, f.codex).steers.at(-1)?.input; assert.ok(input);
  const refs = references(input); assert.equal(refs.length, 1);
  assert.equal(refs[0]?.messageId, failed.id);
  const ref = refs[0]; assert.ok(ref);
  assert.deepEqual(await readFile(ref.path), Buffer.from('next-image'));
  await restoreSurface(f.loop, f.message('text-only', [], chatId));
  const textOnly = workerCalls(f.loop, f.codex).steers.at(-1)?.input; assert.ok(textOnly);
  assert.deepEqual(references(textOnly), []);
  assert.ok(!JSON.stringify(textOnly).includes(ref.path));
  const threadId = f.task().threadId; assert.ok(threadId);
  f.codex.complete(threadId, 'Finished'); await tickSurface(f.loop);
  await restoreSurface(f.loop, f.message('next-turn', ['next'], chatId));
  const newTurn = workerCalls(f.loop, f.codex).starts.at(-1); assert.ok(newTurn);
  assert.equal(newTurn.deliveryId, 'next-turn');
  assert.equal(references(newTurn.input).length, 1);
});

test('image paths remain absolute with a relative data directory and a different selected workspace', async t => {
  const f = await fixture(t);
  f.config.dataDir = relative(process.cwd(), f.root);
  f.config.repositories = configSchema.parse({ feishu: { userOpenId: 'owner' }, repositories: [{
    name: 'fixture/project', path: f.root, baseBranch: 'main', workspace: { kind: 'project-directory', path: f.root },
  }] }).repositories;
  f.codex.selectionResults.push({ kind: 'project', projectId: 'coordinated:fixture', reason: 'Fixture workspace' });
  const bytes = Buffer.from('original image bytes'); f.feishu.resources.set('image', bytes);
  await restoreSurface(f.loop, f.message('workspace-image', ['image']));
  const input = workerCalls(f.loop, f.codex).starts[0]?.input; assert.ok(input);
  const ref = references(input)[0]; assert.ok(ref);
  const cwd = workerCalls(f.loop, f.codex).created[0]?.cwd; assert.ok(cwd);
  assert.notEqual(cwd, f.task().contextDirectory);
  assert.deepEqual(await readFile(ref.path), bytes);
});

for (const failure of ['missing', 'directory', 'empty', 'unreadable'] as const) {
  test(`a cached ${failure} image fails preparation before formal delivery and retains its original message`, {
    skip: failure === 'unreadable' && process.getuid?.() === 0,
  }, async t => {
    const f = await fixture(t);
    const bytes = Buffer.from('original cached image'); f.feishu.resources.set('cached', bytes);
    const select = f.codex.selectWorkspace.bind(f.codex);
    let imagePath = '';
    f.codex.selectWorkspace = async input => {
      const result = await select(input);
      const download = f.feishu.downloads[0]; assert.ok(download);
      imagePath = download.destination.replace(/\.partial$/, '');
      if (failure === 'unreadable') await chmod(imagePath, 0o000);
      else {
        await rm(imagePath);
        if (failure === 'directory') await mkdir(imagePath);
        if (failure === 'empty') await writeFile(imagePath, '');
      }
      return result;
    };
    const message = f.message(`cached-${failure}`, ['cached']);
    await restoreSurface(f.loop, message);
    assert.equal(workerCalls(f.loop, f.codex).starts.length, 0);
    const saved = f.loop.store.inputs(f.task().id)[0]; assert.ok(saved);
    assert.equal(saved.status, 'failed'); assert.deepEqual(saved.message, message);
    assert.ok(f.loop.store.outputs(f.task().id).some(output => output.text.includes('附件准备失败') && output.status === 'dropped'));
    assert.ok(f.feishu.sent.every(output => output.chatId !== message.chatId));
    if (failure === 'unreadable') await chmod(imagePath, 0o600);
    else { await rm(imagePath, { recursive: true, force: true }); await writeFile(imagePath, bytes); }
    await f.loop.retryAttachment(f.task().id, message.id); await tickSurface(f.loop);
    const formal = workerCalls(f.loop, f.codex).starts[0]?.input; assert.ok(formal);
    assert.equal(references(formal).length, 1);
    assert.equal(f.feishu.downloads.length, 1);
  });
}

test('assembled input size is independent of image bytes for equal-length text and references', async t => {
  const f = await fixture(t);
  f.feishu.resources.set('small', Buffer.alloc(1024, 0x61));
  f.feishu.resources.set('large', Buffer.alloc(1024 * 1024, 0x62));
  await restoreSurface(f.loop, f.message('small', ['small']));
  await restoreSurface(f.loop, f.message('large', ['large']));
  const inputs = workerCalls(f.loop, f.codex).starts.map(start => start.input);
  assert.equal(inputs.length, 2);
  for (const input of inputs) assert.equal(references(input).length, 1);
  const sizes = inputs.map(input => Buffer.byteLength(JSON.stringify(input)));
  assert.equal(sizes[0], sizes[1]);
});

test('the actual App Server selector and formal requests contain text paths and never image inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-image-protocol-'));
  const protocol = join(root, 'protocol.jsonl');
  const config = configSchema.parse({ dataDir: join(root, 'data'), feishu: { userOpenId: 'owner' },
    repositories: [{ name: 'example/project', path: root, baseBranch: 'main', workspace: { kind: 'project-directory', path: root } }],
    codex: { command: [process.execPath, resolve('scripts/fixtures/record-app-server.mjs'), protocol,
      process.execPath, resolve('test/fixtures/workspace-selection-codex.mjs'), 'repository', join(root, 'fixture.jsonl')],
    sandbox: 'read-only', approvalPolicy: 'never', requestTimeoutMs: 2000 },
  });
  const codex = new CodexAppServer(config.codex), feishu = new FeishuFake();
  const loop = new AgentLoop(config, { codex, feishu, github: new GitHubFake(), workspace: new WorkspaceProvider(config.dataDir) });
  t.after(async () => { await loop.close(); await rm(root, { recursive: true, force: true }); });
  const bytes = Buffer.alloc(1024 * 1024, 0x71); feishu.resources.set('original', bytes);
  const message: IncomingMessage = { id: 'wire-image', text: 'Keep this description intact', chatId: 'private', chatType: 'p2p',
    senderId: 'owner', createdAt: Date.now(), attachments: [{ key: 'original', name: 'original.png', kind: 'image' }] };
  await restoreSurface(loop, message); await tickSurface(loop);
  const task = loop.tasks()[0]; assert.ok(task?.chatId);
  await restoreSurface(loop, { ...message, id: 'wire-text', chatId: task.chatId, chatType: 'group', text: 'Continue with text', attachments: [] });
  const recordSchema = z.object({ direction: z.string(), method: z.string().optional(), params: z.unknown().optional() });
  const inputSchema = z.object({ threadId: z.string(), input: z.array(z.object({ type: z.literal('text'), text: z.string() })) });
  const rows = (await readFile(protocol, 'utf8')).trim().split('\n').map(line => recordSchema.parse(JSON.parse(line)));
  const requests = rows.filter(row => row.direction === 'request' && row.method === 'turn/start').map(row => inputSchema.parse(row.params));
  const relevant = requests.filter(request => request.threadId === task.threadId
    || references(request.input.map(item => ({ kind: 'text', text: item.text }))).length > 0);
  assert.equal(relevant.length, 3);
  const refs = relevant.map(request => references(request.input.map(item => ({ kind: 'text', text: item.text }))));
  assert.deepEqual(refs.map(items => items.length), [1, 1, 0]);
  assert.deepEqual(refs[0], refs[1]);
  const ref = refs[1]?.[0]; assert.ok(ref);
  assert.deepEqual(await readFile(ref.path), bytes);
  assert.doesNotMatch(JSON.stringify(requests), /localImage|data:image|base64/);
  t.diagnostic(JSON.stringify({ originalBytes: bytes.length, inputBytes: requests.map(request => Buffer.byteLength(JSON.stringify(request.input))) }));
});
