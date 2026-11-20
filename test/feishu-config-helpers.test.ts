import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { testExecution } from './test-config.js';

const appId = 'synthetic-helper-app-id', appSecret = 'synthetic-helper-app-secret', token = 'synthetic-helper-github-token';
const original = { dataDir: './relative-data', execution: testExecution, github: { token },
  feishu: { appId, appSecret, userOpenId: 'REPLACE_WITH_YOUR_OPEN_ID' } };

for (const mode of ['pair', 'verify'] as const) test(`${mode} helper uses JSON credentials and protects its output`, async t => {
  const root = await mkdtemp(join(tmpdir(), `feishu-${mode}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = mode === 'pair' ? original : { ...original, feishu: { ...original.feishu, userOpenId: 'paired-owner' } };
  await writeFile(join(root, 'config.json'), JSON.stringify(raw));
  await writeFile(join(root, '.env'), 'FEISHU_APP_ID=wrong-dotenv-id\nFEISHU_APP_SECRET=wrong-dotenv-secret\n');
  const sdk = `
    import { existsSync, readFileSync } from 'node:fs';
    export const Domain = { Feishu: 'fixture' };
    export const LoggerLevel = { error: 0 };
    export const defaultHttpInstance = { request() { throw new Error('Network is forbidden'); } };
    function check(options) {
      if (options.appId !== ${JSON.stringify(appId)} || options.appSecret !== ${JSON.stringify(appSecret)}) throw new Error('JSON credentials not received');
      options.logger.error({ appId: options.appId, appSecret: options.appSecret });
    }
    export class Client {
      constructor(options) {
        check(options);
        ${mode === 'verify' ? `throw new Error('verify fixture reached ' + options.appSecret);` : ''}
        this.im = { message: { create: async () => ({ code: 0 }) } };
      }
    }
    export class EventDispatcher { register(handlers) { this.handlers = handlers; return this; } }
    export class WSClient {
      constructor(options) { check(options); }
      async start({ eventDispatcher }) {
        this.timer = setInterval(async () => {
          if (!existsSync('pair-command')) return;
          clearInterval(this.timer);
          await eventDispatcher.handlers['im.message.receive_v1']({
            sender: { sender_type: 'user', sender_id: { open_id: 'paired-owner' } },
            message: { message_type: 'text', content: JSON.stringify({ text: readFileSync('pair-command', 'utf8') }) }
          });
        }, 10);
      }
      close() { clearInterval(this.timer); }
    }
  `;
  const hook = join(root, 'sdk-hook.mjs');
  await writeFile(hook, `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === '@larksuiteoapi/node-sdk') return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(sdk)}`)}, shortCircuit: true };
      return nextResolve(specifier, context);
    } });`);
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), '--import', hook, '--', resolve(`scripts/${mode}-feishu.ts`), '--config', 'config.json'], {
    cwd: root, timeout: 10_000, env: { ...process.env, FEISHU_APP_ID: 'wrong-env-id', FEISHU_APP_SECRET: 'wrong-env-secret' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', sent = false;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    if (mode === 'pair' && !sent && stdout.includes('\n')) {
      const first = JSON.parse(stdout.split('\n')[0]!);
      sent = true;
      void writeFile(join(root, 'pair-command'), first.pairingCommand);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const exit = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', code => done(code)); });
  assert.equal(exit, mode === 'pair' ? 0 : 1, stderr);
  for (const secret of [appId, appSecret, token]) assert.equal((stdout + stderr).includes(secret), false);
  assert.match(stderr, /REDACTED/);
  if (mode === 'pair') {
    const records = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records[0].appId, undefined); assert.equal(records[1].paired, true);
    const actual = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
    assert.deepEqual(actual, { ...original, feishu: { ...original.feishu, userOpenId: 'paired-owner' } });
  } else {
    assert.match(stderr, /verify fixture reached/);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')), raw);
  }
});
