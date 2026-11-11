import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Client, WSClient, EventDispatcher, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';

const args = parseArgs({ options: { config: { type: 'string', default: 'config.json' } } });
process.loadEnvFile('.env');
const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
if (!appId || !appSecret) throw new Error('缺少飞书应用环境变量');
const code = randomBytes(4).toString('hex');
const command = `绑定 ${code}`;
const client = new Client({ appId, appSecret, domain: Domain.Feishu, loggerLevel: LoggerLevel.error });
const socket = new WSClient({ appId, appSecret, domain: Domain.Feishu, loggerLevel: LoggerLevel.error });
const eventSchema = z.object({ sender: z.object({ sender_type: z.literal('user'), sender_id: z.object({ open_id: z.string().min(1) }) }), message: z.object({ message_type: z.literal('text'), content: z.string() }) });
let bound = false;
const timer = setTimeout(() => { process.stderr.write('绑定超时，请重新运行。\n'); socket.close({ force: true }); process.exitCode = 1; }, 20 * 60_000);
const stop = () => { clearTimeout(timer); socket.close({ force: true }); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
await socket.start({ eventDispatcher: new EventDispatcher({ loggerLevel: LoggerLevel.error }).register({
  'im.message.receive_v1': async raw => {
    const result = eventSchema.safeParse(raw);
    if (bound || !result.success) return;
    const text = z.object({ text: z.string() }).parse(JSON.parse(result.data.message.content)).text;
    if (text.trim() !== command) return;
    bound = true;
    try {
      const config = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(args.values.config, 'utf8')));
      const feishu = z.record(z.string(), z.unknown()).parse(config.feishu);
      config.feishu = { ...feishu, userOpenId: result.data.sender.sender_id.open_id };
      await writeFile(args.values.config, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
      const reply = await client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: result.data.sender.sender_id.open_id, msg_type: 'text', content: JSON.stringify({ text: 'Agent Loop 已绑定你的账号。后续每个任务使用独立群，文字、截图、日志和确认都会回到对应任务会话。' }) } });
      if (reply.code !== 0) throw new Error(`飞书回复失败 ${reply.code}`);
      process.stdout.write(JSON.stringify({ paired: true, config: args.values.config }) + '\n');
    } finally { stop(); }
  },
}) });
process.stdout.write(JSON.stringify({ pairingCommand: command, appId, instruction: '在飞书中打开 Agent Loop 小助手，发送 pairingCommand。' }) + '\n');
