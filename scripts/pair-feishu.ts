import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Client, WSClient, EventDispatcher, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { loadConfig, readConfigInput } from '../src/config.js';
import { credentialSafeLogger, publicJson } from '../src/credentials.js';
import { errorMessage } from '../src/domain.js';

async function main(): Promise<void> {
  const args = parseArgs({ options: { config: { type: 'string', default: 'config.json' } } });
  const loaded = await loadConfig(args.values.config);
  const appId = loaded.feishu.appId.require('feishu.appId');
  const appSecret = loaded.feishu.appSecret.require('feishu.appSecret');
  const code = randomBytes(4).toString('hex');
  const command = `绑定 ${code}`;
  const client = new Client({ appId, appSecret, domain: Domain.Feishu, loggerLevel: LoggerLevel.error, logger: credentialSafeLogger });
  const socket = new WSClient({ appId, appSecret, domain: Domain.Feishu, loggerLevel: LoggerLevel.error, logger: credentialSafeLogger });
  const eventSchema = z.object({ sender: z.object({ sender_type: z.literal('user'), sender_id: z.object({ open_id: z.string().min(1) }) }), message: z.object({ message_type: z.literal('text'), content: z.string() }) });
  let bound = false;
  const timer = setTimeout(() => { process.stderr.write('绑定超时，请重新运行。\n'); socket.close({ force: true }); process.exitCode = 1; }, 20 * 60_000);
  const stop = () => { clearTimeout(timer); socket.close({ force: true }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await socket.start({ eventDispatcher: new EventDispatcher({ loggerLevel: LoggerLevel.error, logger: credentialSafeLogger }).register({
    'im.message.receive_v1': async raw => {
      const result = eventSchema.safeParse(raw);
      if (bound || !result.success) return;
      const text = z.object({ text: z.string() }).parse(JSON.parse(result.data.message.content)).text;
      if (text.trim() !== command) return;
      bound = true;
      try {
        const config = z.record(z.string(), z.unknown()).parse(await readConfigInput(args.values.config));
        const feishu = z.record(z.string(), z.unknown()).parse(config.feishu);
        config.feishu = { ...feishu, userOpenId: result.data.sender.sender_id.open_id };
        await writeFile(args.values.config, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
        const reply = await client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: result.data.sender.sender_id.open_id, msg_type: 'text', content: JSON.stringify({ text: 'Agent Loop 已绑定你的账号。后续每个任务使用独立群，文字、截图、日志和确认都会回到对应任务会话。' }) } });
        if (reply.code !== 0) throw new Error(`飞书回复失败 ${reply.code}`);
        process.stdout.write(publicJson({ paired: true, config: args.values.config }) + '\n');
      } finally { stop(); }
    },
  }) });
  process.stdout.write(publicJson({ pairingCommand: command, instruction: '在飞书中打开 Agent Loop 小助手，发送 pairingCommand。' }) + '\n');
}
main().catch(error => { process.stderr.write(errorMessage(error) + '\n'); process.exitCode = 1; });
