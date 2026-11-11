import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Store } from '../src/store.js';

const execute = promisify(execFile);
const cli = resolve('node_modules/tsx/dist/cli.mjs');
const entry = resolve('src/cli.ts');

test('doctor reports discovered projects and source-only collection without requiring local repository mappings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-doctor-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'projects', 'multi-repo', 'nested'), { recursive: true });
  await mkdir(join(root, 'projects', '.metadata')); await writeFile(join(root, 'fixture.env'), '');
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({
    engineering: { projectRoot: './projects' }, repositories: [{ name: 'explicit/issues', criteria: {} }],
    github: { tokenEnv: 'FIXTURE_DOCTOR_TOKEN' },
    feishu: { userOpenId: 'owner', appIdEnv: 'FIXTURE_DOCTOR_APP', appSecretEnv: 'FIXTURE_DOCTOR_SECRET' },
  }));
  const env = { ...process.env, FIXTURE_DOCTOR_TOKEN: 'fixture', FIXTURE_DOCTOR_APP: 'fixture', FIXTURE_DOCTOR_SECRET: 'fixture' };
  const run = () => execute(process.execPath, [cli, entry, 'doctor', '--config', configPath, '--env-file', join(root, 'fixture.env')], { cwd: root, env });
  const output = JSON.parse((await run()).stdout);
  assert.equal(output.ready, true); assert.equal(output.discovery.readable, true);
  assert.equal(output.discovery.projectRoot, join(root, 'projects'));
  assert.deepEqual(output.discovery.projects.map((project: { name: string }) => project.name), ['multi-repo']);
  assert.equal(output.repositories[0].sourceOnly, true);
  assert.equal('path' in output.repositories[0], false);
  await rm(join(root, 'projects'), { recursive: true });
  await assert.rejects(run(), error => {
    assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string');
    const failed = JSON.parse(error.stdout);
    assert.equal(failed.ready, false); assert.equal(failed.discovery.readable, false);
    assert.match(failed.discovery.error, /ENOENT/);
    assert.equal('projects' in failed.discovery, false);
    return true;
  });
});

for (const scenario of [
  { name: 'default Bug scope', taskTypes: undefined, expectedNumbers: [], classification: 'feature' },
  { name: 'enabled Feature scope', taskTypes: ['feature'], expectedNumbers: [1, 2], classification: 'feature' },
  { name: 'enabled custom type', taskTypes: ['refactor'], expectedNumbers: [1, 2], classification: 'refactor' },
  { name: 'disabled custom type', taskTypes: ['bug'], expectedNumbers: [], classification: 'refactor' },
]) test(`CLI collection preserves ${scenario.name}, follows pages and starts no Feishu or Codex`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-cli-'));
  await mkdir(join(root, 'repository'));
  await writeFile(join(root, 'prompt.md'), 'Diagnose and wait.');
  await writeFile(join(root, 'SKILL.md'), '# Skill');
  const requests: string[] = [];
  let apiUrl = '';
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    assert.equal(request.headers.authorization, 'Bearer test-token');
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/comments?per_page=100')) { response.end('[]'); return; }
    const secondPage = request.url === '/repos/example/project/issues?page=2';
    if (!secondPage) response.setHeader('link', `<${apiUrl}/repos/example/project/issues?page=2>; rel="next"`);
    const number = /issues\/2$/.test(request.url ?? '') || secondPage ? 2 : 1;
    const value = { node_id: `I_FEATURE_${number}`, number, html_url: `https://github.com/example/project/issues/${number}`, title: 'A feature', body: 'A request', state: 'open', assignees: [{ login: 'owner' }], labels: [{ name: scenario.classification }], type: secondPage ? null : { name: scenario.classification }, updated_at: '2026-11-04T00:00:00Z' };
    response.end(JSON.stringify(/issues\/\d+$/.test(request.url ?? '') ? value : [value]));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await rm(root, { recursive: true, force: true }); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  apiUrl = `http://127.0.0.1:${address.port}`;
  await writeFile(join(root, 'config.json'), JSON.stringify({
    dataDir: './data', repositories: [{ name: 'example/project', path: './repository', baseBranch: 'main', criteria: { assigneesAny: ['owner'], taskTypes: scenario.taskTypes, nativeTypes: { [scenario.classification]: scenario.classification }, typeLabels: { [scenario.classification]: scenario.classification } } }],
    engineering: { promptPath: './prompt.md', skillPath: './SKILL.md' },
    github: { tokenEnv: 'TEST_GITHUB_TOKEN', apiUrl },
    feishu: { appIdEnv: 'UNSET_FEISHU_APP_ID', appSecretEnv: 'UNSET_FEISHU_SECRET', userOpenId: 'REPLACE_WITH_YOUR_OPEN_ID' },
    codex: { command: ['unavailable-codex-must-not-run'] },
  }));
  const options = { cwd: root, env: { ...process.env, TEST_GITHUB_TOKEN: 'test-token' }, timeout: 15_000 };
  const collect = await execute(process.execPath, [cli, entry, 'collect', '--config', 'config.json'], options);
  assert.deepEqual(JSON.parse(collect.stdout), { collectedTasks: scenario.expectedNumbers.length, diagnostics: [] });
  assert.equal(requests.filter(url => !/issues\/\d+/.test(url)).length, 2);
  assert.ok(requests[0]?.includes('assignee=owner'));
  assert.equal(requests[1], '/repos/example/project/issues?page=2');
  const repeated = await execute(process.execPath, [cli, entry, 'collect', '--config', 'config.json'], options);
  assert.deepEqual(JSON.parse(repeated.stdout), { collectedTasks: scenario.expectedNumbers.length, diagnostics: [] });
  const store = new Store(join(root, 'data'), { readOnly: true });
  const tasks = store.tasks();
  const reasons = store.sources().map(record => record.reason);
  store.close();
  assert.deepEqual(tasks.map(task => [(task.source.kind === 'github' ? task.source.issue.number : null), task.status, task.resources, task.chatId, task.threadId]),
    scenario.expectedNumbers.map(number => [number, 'pending', [], null, null]));
  assert.deepEqual(reasons, scenario.expectedNumbers.length ? [scenario.classification, scenario.classification] : ['type_not_enabled', 'type_not_enabled']);
  const status = await execute(process.execPath, [cli, entry, 'status', '--config', 'config.json'], { ...options, env: { ...process.env } });
  assert.deepEqual(JSON.parse(status.stdout), { tasks: tasks.map(task => ({
    id: task.id, source: task.source.kind === 'github' ? task.source.issue.url : task.sourceId, status: 'pending', reason: null, chatId: null,
    threadId: null, resources: [], messages: [], outgoing: [],
  })), diagnostics: [] });
});

async function listen(port = 0) {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { port: address.port, close: () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) };
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for CLI state');
    await delay(20);
  }
}

async function runFixture(t: TestContext, options: {
  port?: number; command?: string; startup?: 'ready' | 'fail' | 'slow'; closeFails?: boolean; signalWhileBinding?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-cli-manual-'));
  if (!options.port) {
    const reservation = await listen(); options.port = reservation.port; await reservation.close();
  }
  await writeFile(join(root, 'config.json'), JSON.stringify({
    dataDir: './data', repositories: [], github: { tokenEnv: 'UNSET_MANUAL_ONLY_GITHUB' },
    dashboard: { port: options.port }, executionPollMs: 50,
    feishu: { appIdEnv: 'FIXTURE_FEISHU_APP', appSecretEnv: 'FIXTURE_FEISHU_SECRET', userOpenId: 'ou_fixture' },
    codex: { command: ['unavailable-codex-must-not-run-until-input'] },
  }));
  const sdk = `
    import { existsSync, writeFileSync } from 'node:fs';
    export const Domain = { Feishu: 'fixture' };
    export const LoggerLevel = { error: 0 };
    export const defaultHttpInstance = { request() { throw new Error('Unexpected network call'); } };
    export class Client { constructor() { throw new Error('No task should call Feishu HTTP'); } }
    export class EventDispatcher { register(handlers) { if (!handlers['im.message.receive_v1']) throw new Error('No receiver'); return this; } }
    export class WSClient {
      constructor(options) { this.options = options; }
      async start() {
        writeFileSync('feishu-started', 'yes');
        ${options.startup === 'fail' ? "throw new Error('Fixture Feishu startup failed');" : ''}
        ${options.startup === 'slow' ? "while (!existsSync('finish-startup')) await new Promise(resolve => setTimeout(resolve, 10));" : ''}
        this.options.onReady();
      }
      close() { ${options.closeFails ? "throw new Error('Fixture Feishu cleanup failed');" : ''} }
    }
  `;
  const hook = join(root, 'sdk-hook.mjs');
  await writeFile(hook, `import { registerHooks } from 'node:module';
    import http from 'node:http'; import https from 'node:https';
    http.request = https.request = () => { throw new Error('External network forbidden in fixture'); };
    ${options.signalWhileBinding ? `
      const listen = http.Server.prototype.listen;
      http.Server.prototype.listen = function(...args) {
        const ready = args.pop();
        return listen.call(this, ...args, () => {
          process.kill(process.pid, 'SIGTERM');
          setTimeout(ready, 100);
        });
      };
    ` : ''}
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === '@larksuiteoapi/node-sdk') return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(sdk)}`)}, shortCircuit: true };
      return nextResolve(specifier, context);
    } });`);
  const env: NodeJS.ProcessEnv = { ...process.env, FIXTURE_FEISHU_APP: 'fixture-app', FIXTURE_FEISHU_SECRET: 'fixture-secret' };
  delete env.UNSET_MANUAL_ONLY_GITHUB;
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), '--import', hook, entry, options.command ?? 'run', '--config', 'config.json'], { cwd: root, env, timeout: 20_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; await rm(root, { recursive: true, force: true });
  });
  return { root, child, exited, url: `http://127.0.0.1:${options.port}`, port: options.port,
    stdout: () => stdout, stderr: () => stderr };
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) test(`actual CLI run serves dashboard and releases runtime resources on ${signal}`, async t => {
  const fixture = await runFixture(t);
  await waitFor(() => {
    assert.equal(fixture.child.exitCode, null, fixture.stderr());
    return fixture.stdout().trimEnd().endsWith('}');
  });
  assert.deepEqual(JSON.parse(fixture.stdout()), { event: 'started', dataDir: join(await realpath(fixture.root), 'data'), tasks: 0,
    dashboard: { url: fixture.url, listenAddress: `127.0.0.1:${fixture.port}`, networkUrls: [] } });
  const page = await fetch(fixture.url);
  assert.equal(page.status, 200); assert.match(await page.text(), /实时输出/);
  const snapshot = await (await fetch(fixture.url + '/api/snapshot')).json();
  assert.equal(snapshot.runtime.pid, fixture.child.pid); assert.equal(snapshot.runtime.status, 'running');
  assert.deepEqual(snapshot.tasks, []);
  await waitFor(async () => (await (await fetch(fixture.url + '/api/snapshot')).json()).runtime.lastSeenAt > snapshot.runtime.lastSeenAt);
  assert.throws(() => new Store(join(fixture.root, 'data')), /已有 Agent Loop/);
  fixture.child.kill(signal);
  assert.deepEqual(await fixture.exited, { code: 0, signal: null });
  assert.equal(fixture.stderr(), '');
  const rebound = await listen(fixture.port); await rebound.close();
  const store = new Store(join(fixture.root, 'data'));
  try {
    assert.equal(store.tasks().length, 0); assert.deepEqual(store.diagnostics(), []);
    const heartbeat = JSON.parse(store.meta('runtime-heartbeat') ?? 'null');
    assert.equal(heartbeat.pid, fixture.child.pid); assert.equal(heartbeat.status, 'stopped');
  } finally { store.close(); }
});

test('CLI run rejects an occupied dashboard port before starting Feishu and releases the writer lock', async t => {
  const occupied = await listen(); t.after(() => occupied.close());
  const fixture = await runFixture(t, { port: occupied.port });
  assert.deepEqual(await fixture.exited, { code: 1, signal: null });
  assert.match(fixture.stderr(), /EADDRINUSE/); assert.equal(fixture.stdout(), '');
  await assert.rejects(access(join(fixture.root, 'feishu-started')));
  const store = new Store(join(fixture.root, 'data')); store.close();
});

for (const closeFails of [false, true]) test(`CLI startup failure closes dashboard even when runtime cleanup ${closeFails ? 'fails' : 'succeeds'}`, async t => {
  const fixture = await runFixture(t, { startup: 'fail', closeFails });
  assert.deepEqual(await fixture.exited, { code: 1, signal: null });
  assert.match(fixture.stderr(), /Fixture Feishu startup failed/); assert.equal(fixture.stdout(), '');
  if (closeFails) assert.match(fixture.stderr(), /Fixture Feishu cleanup failed/);
  const rebound = await listen(fixture.port); await rebound.close();
  const store = new Store(join(fixture.root, 'data')); store.close();
});

test('CLI repeated signals during runtime startup close both services without announcing started', async t => {
  const fixture = await runFixture(t, { startup: 'slow' });
  await waitFor(() => access(join(fixture.root, 'feishu-started')).then(() => true, () => false));
  await waitFor(() => fetch(fixture.url).then(response => { void response.body?.cancel(); return response.status === 200; }, () => false));
  fixture.child.kill('SIGTERM');
  await waitFor(() => fetch(fixture.url).then(response => { void response.body?.cancel(); return false; }, () => true));
  fixture.child.kill('SIGTERM');
  await writeFile(join(fixture.root, 'finish-startup'), 'yes');
  assert.deepEqual(await fixture.exited, { code: 0, signal: null });
  assert.equal(fixture.stdout(), ''); assert.equal(fixture.stderr(), '');
  const rebound = await listen(fixture.port); await rebound.close();
  const store = new Store(join(fixture.root, 'data'));
  try { assert.equal(JSON.parse(store.meta('runtime-heartbeat') ?? 'null').status, 'stopped'); }
  finally { store.close(); }
});

test('CLI signal while dashboard binding is pending still closes it and skips runtime startup', async t => {
  const fixture = await runFixture(t, { signalWhileBinding: true });
  assert.deepEqual(await fixture.exited, { code: 0, signal: null });
  assert.equal(fixture.stdout(), ''); assert.equal(fixture.stderr(), '');
  await assert.rejects(access(join(fixture.root, 'feishu-started')));
  const rebound = await listen(fixture.port); await rebound.close();
  const store = new Store(join(fixture.root, 'data')); store.close();
});

test('CLI help and accepted commands remove standalone dashboard', async () => {
  const help = await execute(process.execPath, [cli, entry, '--help']);
  assert.doesNotMatch(help.stdout, /dashboard/);
  await assert.rejects(execute(process.execPath, [cli, entry, 'dashboard']), error => {
    assert.ok(error instanceof Error && 'stderr' in error && typeof error.stderr === 'string');
    assert.match(error.stderr, /未知命令 dashboard/); return true;
  });
});

for (const command of ['doctor', 'collect', 'status']) test(`CLI ${command} does not bind dashboard or start Feishu`, async t => {
  const occupied = await listen(); t.after(() => occupied.close());
  const fixture = await runFixture(t, { command, port: occupied.port });
  assert.deepEqual(await fixture.exited, { code: 0, signal: null });
  assert.equal(fixture.stderr(), ''); assert.ok(JSON.parse(fixture.stdout()));
  await assert.rejects(access(join(fixture.root, 'feishu-started')));
});
