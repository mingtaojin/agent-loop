import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { FeishuAdapter } from '../src/adapters/feishu.js';
import { loadConfig } from '../src/config.js';
import { UncertainOperationError } from '../src/domain.js';

const args = parseArgs({ options: { config: { type: 'string', default: 'config.json' }, listen: { type: 'boolean', default: false } } });
process.loadEnvFile('.env');
const config = await loadConfig(args.values.config);
assert.ok(!config.feishu.userOpenId.startsWith('REPLACE_'), 'Pair the owner first');
const appId = z.string().min(1).parse(process.env[config.feishu.appIdEnv]);
const appSecret = z.string().min(1).parse(process.env[config.feishu.appSecretEnv]);
const api = new Client({ appId, appSecret, loggerLevel: LoggerLevel.error });
const adapter = new FeishuAdapter({ appId, appSecret, userOpenId: config.feishu.userOpenId });
const runId = randomUUID();
const directory = resolve('.scratch/verification', `feishu-${Date.now()}`);
await mkdir(directory, { recursive: true });
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), runId, limitations: ['Resource round trips use bot-sent synthetic fixtures; they do not prove owner-uploaded screenshot or log handling through Codex.'] };
const save = () => writeFile(`${directory}/result.json`, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
try {
  const group = { taskId: 'connectivity-check-v1', title: 'Agent Loop 联通验证', sourceUrl: 'https://github.com/crysound/OpenTest-Internal' };
  const chatId = await adapter.ensureGroup(group);
  evidence.chatId = chatId;
  await adapter.verifyGroup(chatId);
  const listDeadline = Date.now() + 60_000;
  while (true) {
    try {
      assert.equal(await adapter.ensureGroup({ ...group, reconcileOnly: true }), chatId);
      break;
    } catch (error) {
      if (!(error instanceof UncertainOperationError) || Date.now() >= listDeadline) throw error;
      await delay(2000);
    }
  }
  evidence.groupVerifiedAndReused = true;
  await adapter.send({ chatId, id: `${runId}:start`, text: '这是 Agent Loop 联通验证群，仅用于验证消息和附件，不会启动业务任务。接下来发送一张测试图片和一份不含业务数据的测试日志。' });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=', 'base64');
  const log = Buffer.from(`Agent Loop 联通验证\nnonce=${runId}\n`, 'utf8');
  const imageKey = z.object({ image_key: z.string().min(1) }).parse(await api.im.image.create({ data: { image_type: 'message', image } })).image_key;
  const fileKey = z.object({ file_key: z.string().min(1) }).parse(await api.im.file.create({ data: { file_type: 'stream', file_name: 'agent-loop-test.log', file: log } })).file_key;
  const resources = [
    { kind: 'image' as const, key: imageKey, name: 'fixture.png', original: image },
    { kind: 'file' as const, key: fileKey, name: 'fixture.log', original: log },
  ];
  const checks = [];
  for (const resource of resources) {
    const content = resource.kind === 'image' ? { image_key: resource.key } : { file_key: resource.key };
    const response = await api.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: resource.kind, content: JSON.stringify(content), uuid: randomUUID() } });
    const sent = z.object({ code: z.literal(0), data: z.object({ message_id: z.string().min(1), body: z.object({ content: z.string() }) }) }).parse(response).data;
    const messageId = sent.message_id;
    const sentContent: unknown = JSON.parse(sent.body.content);
    const key = resource.kind === 'image'
      ? z.object({ image_key: z.string().min(1) }).parse(sentContent).image_key
      : z.object({ file_key: z.string().min(1) }).parse(sentContent).file_key;
    const destination = `${directory}/${resource.name}`;
    await adapter.download({ messageId, attachment: { ...resource, key }, destination, maxBytes: config.maxAttachmentBytes });
    const actual = await readFile(destination);
    assert.deepEqual(actual, resource.original, `${resource.kind} bytes must survive the round trip`);
    checks.push({ kind: resource.kind, messageId, bytes: actual.length, sha256: sha256(actual), exactMatch: true });
    evidence.resources = checks;
    await save();
  }
  evidence.resources = checks;
  evidence.ownerHistoryCount = (await adapter.history({ chatId, since: 0 })).length;
  evidence.apiResult = 'passed';
  await save();
  if (args.values.listen) {
    const command = `验证 ${runId.slice(0, 8)}`;
    evidence.ownerCommand = command;
    evidence.ownerMessage = 'pending';
    await save();
    let finish: () => void = () => {};
    const received = new Promise<void>(resolve => { finish = resolve; });
    const timer = setTimeout(finish, 10 * 60_000);
    let matched = false;
    try {
      await adapter.start(async message => {
        if (message.chatId !== chatId || message.text.trim() !== command || matched) return;
        matched = true;
        try {
          const history = await adapter.history({ chatId, since: message.createdAt - 1000 });
          assert.ok(history.some(item => item.id === message.id), 'Live owner message must appear in history');
          await adapter.send({ chatId, id: `${runId}:owner`, text: '验证通过：已实时收到你的消息，历史补收也能找到同一条消息。测试图片和日志下载后的内容与原文件完全一致。' });
          evidence.ownerMessage = { id: message.id, liveReceived: true, foundInHistory: true, replySent: true };
        } catch (error) { evidence.ownerMessageError = String(error); }
        finally { finish(); }
      }, error => { evidence.connectionError = String(error); finish(); });
      await adapter.send({ chatId, id: `${runId}:command`, text: `图片和日志传输验证已通过。请在本群发送「${command}」，完成你的群消息接收验证。` });
      process.stdout.write(`${JSON.stringify({ chatId, ownerCommand: command, evidence: `${directory}/result.json` })}\n`);
      await received;
      assert.equal(typeof evidence.ownerMessage, 'object', 'Owner message verification was not completed');
      assert.equal(evidence.ownerMessageError, undefined);
      assert.equal(evidence.connectionError, undefined);
    } finally { clearTimeout(timer); }
  }
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed';
  evidence.error = String(error);
  process.exitCode = 1;
} finally {
  await adapter.close();
  evidence.finishedAt = new Date().toISOString();
  await save();
  process.stdout.write(`${JSON.stringify({ result: evidence.result, evidence: `${directory}/result.json`, error: evidence.error })}\n`);
}
