import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { testExecution } from './test-config.js';

const execute = promisify(execFile);
const entry = resolve('src/cli.ts');
const loader = resolve('node_modules/tsx/dist/loader.mjs');
const appId = 'synthetic-single-file-app';
const appSecret = 'synthetic-single-file-secret';
const token = 'synthetic-single-file-token';
const config = { execution: testExecution, github: { token }, feishu: { appId, appSecret, userOpenId: 'owner' } };

async function invoke(root: string, command: string, args: string[] = []) {
  try {
    const result = await execute(process.execPath, ['--import', loader, '--', entry, command, '--config', 'config.json', ...args], {
      cwd: root, timeout: 10_000, env: { ...process.env, FEISHU_APP_ID: 'wrong-env-app', FEISHU_APP_SECRET: 'wrong-env-secret', GITHUB_TOKEN: 'wrong-env-token' },
    });
    return { code: 0, ...result };
  } catch (error) {
    assert.ok(error instanceof Error && 'code' in error && 'stdout' in error && 'stderr' in error);
    assert.equal(typeof error.stdout, 'string'); assert.equal(typeof error.stderr, 'string');
    return { code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) };
  }
}

function noCredentials(output: string) {
  for (const secret of [appId, appSecret, token]) assert.equal(output.includes(secret), false);
}

test('one private JSON file drives doctor and ignores dotenv and conflicting credential environment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'single-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.json'), JSON.stringify(config));
  const first = await invoke(root, 'doctor');
  assert.equal(first.code, 0, first.stderr); assert.equal(JSON.parse(first.stdout).ready, true);
  noCredentials(first.stdout + first.stderr);
  await writeFile(join(root, '.env'), 'NODE_OPTIONS=--invalid-dotenv-option\nFEISHU_APP_ID=dotenv-app\nFEISHU_APP_SECRET=dotenv-secret\nGITHUB_TOKEN=dotenv-token\n');
  const second = await invoke(root, 'doctor');
  assert.equal(second.code, 0, second.stderr); assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout));
  await writeFile(join(root, 'config.json'), JSON.stringify({ ...config, feishu: { userOpenId: 'owner' } }));
  const missing = await invoke(root, 'doctor');
  assert.equal(missing.code, 1); assert.equal(JSON.parse(missing.stdout).ready, false);
  assert.deepEqual(JSON.parse(missing.stdout).credentials, [
    { name: 'feishu.appId', present: false }, { name: 'feishu.appSecret', present: false },
  ]);
  const run = await invoke(root, 'run');
  assert.equal(run.code, 1); assert.match(run.stderr, /feishu.appId/); noCredentials(run.stderr);
});

test('GitHub token remains conditional and missing JSON token never falls back to the environment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'conditional-token-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const empty of [undefined, '', ' ', 'REPLACE_WITH_GITHUB_TOKEN']) {
    const raw = { ...config, github: { token: empty } };
    await writeFile(join(root, 'config.json'), JSON.stringify(raw));
    assert.equal((await invoke(root, 'collect')).code, 0);
    await writeFile(join(root, 'config.json'), JSON.stringify({ ...raw, repositories: [{ name: 'fixture/issues', criteria: {} }] }));
    for (const command of ['run', 'collect']) {
      const result = await invoke(root, command);
      assert.equal(result.code, 1); assert.match(result.stderr, /github.token/); noCredentials(result.stdout + result.stderr);
    }
    const doctor = await invoke(root, 'doctor');
    assert.equal(doctor.code, 1); assert.equal(JSON.parse(doctor.stdout).credentials[0].present, false);
  }
});

test('legacy options, credential selectors, and invalid JSON fail without disclosing credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'invalid-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.json'), JSON.stringify(config));
  const legacyOption = await invoke(root, 'doctor', ['--env-file', 'removed.env']);
  assert.equal(legacyOption.code, 1, legacyOption.stderr); assert.match(legacyOption.stderr, /env-file/);
  await assert.rejects(execute('npm', ['start', '--', 'doctor', '--config', join(root, 'config.json'), '--env-file', 'removed.env']), error => {
    assert.ok(error instanceof Error && 'stderr' in error);
    assert.match(String(error.stderr), /Unknown option '--env-file'/); return true;
  });
  const invalid = [
    JSON.stringify(config).slice(0, -1) + `, "invalid": "${appSecret}" bad }`,
    JSON.stringify({ ...config, feishu: { ...config.feishu, appIdEnv: appId, appSecretEnv: appSecret } }),
    JSON.stringify({ ...config, github: { ...config.github, tokenEnv: token } }),
    JSON.stringify({ ...config, execution: { ...testExecution, worker: { ...testExecution.worker, backend: appSecret } } }),
    JSON.stringify({ ...config, [appSecret]: true }),
  ];
  for (const raw of invalid) {
    await writeFile(join(root, 'config.json'), raw);
    const result = await invoke(root, 'doctor');
    assert.equal(result.code, 1); assert.match(result.stderr, /Invalid configuration/); noCredentials(result.stdout + result.stderr);
  }
});
