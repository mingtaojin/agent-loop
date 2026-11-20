import { LiveExecution } from './live-execution.js';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, networkInterfaces } from 'node:os';
import { z } from 'zod';
import { Store } from './store.js';
import { boundedDashboardText, dashboardResources, ProjectDashboardReader } from './dashboard-reader.js';
import { errorMessage, presentTaskSource } from './domain.js';
import { dashboardHtml, dashboardCss, dashboardScript } from './dashboard-page.js';

const heartbeatSchema = z.object({ pid: z.number(), lastSeenAt: z.number(), intervalMs: z.number(), status: z.enum(['running', 'stopped']) });

export async function startDashboard(options: { execution?: LiveExecution; dataDir: string; port: number; host?: '127.0.0.1' | '0.0.0.0' }) {
  const execution = options.execution ?? new LiveExecution();
  const listenHost = options.host ?? '0.0.0.0';
  const networkAddresses = () => Object.values(networkInterfaces()).flatMap(addresses => (addresses ?? []).filter(address => address.family === 'IPv4' && !address.internal).map(address => address.address));
  let store: Store | null = null;
  const clients = new Set<ServerResponse>();
  let dashboardReader: ProjectDashboardReader | null = null;
  const readerFor = (db: Store) => dashboardReader ??= new ProjectDashboardReader(db, execution);
  let readModelCache: { version: number; cursor: string; expiresAt: number; tasks: ReturnType<Store['tasks']>; projects: ReturnType<ProjectDashboardReader['projects']>; diagnostics: ReturnType<Store['diagnostics']> } | null = null;
  const readStore = () => {
    if (!store && existsSync(join(options.dataDir, 'tasks.sqlite'))) store = new Store(options.dataDir, { readOnly: true });
    return store;
  };
  // Open the read-only connection before listening so the first API request measures the
  // dashboard query rather than SQLite connection and schema setup.
  readStore();
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  };
  const readModel = () => {
    const now = Date.now();
    const db = readStore();
    const version = db?.dataVersion() ?? 0;
    if (readModelCache && readModelCache.version === version && readModelCache.cursor === execution.cursor && readModelCache.expiresAt > now) return readModelCache;
    const tasks = db?.tasks() ?? [];
    const projects = db ? readerFor(db).projects(tasks) : [];
    const diagnostics = db?.diagnostics() ?? [];
    readModelCache = { version, cursor: execution.cursor, expiresAt: now + 250, tasks, projects, diagnostics };
    return readModelCache;
  };
  const snapshot = () => {
    const now = Date.now();
    const db = readStore();
    const model = readModel();
    const rawHeartbeat = db?.meta('runtime-heartbeat');
    const heartbeat = rawHeartbeat ? heartbeatSchema.safeParse(JSON.parse(rawHeartbeat)) : null;
    const value = {
      dataDir: options.dataDir, now, runtime: heartbeat?.success ? heartbeat.data : null,
      tasks: model.tasks.map(task => ({
        id: task.id, title: presentTaskSource(task.source, 200).title,
        sourceLabel: presentTaskSource(task.source, 200).label,
        sourceKind: task.source.kind, sourceUrl: task.source.kind === 'github' ? task.source.issue.url : null,
        status: task.status, executionStatus: task.executionStatus, reason: task.reason,
        threadId: task.threadId, turnId: task.turnId, chatId: task.chatId,
        createdAt: task.createdAt, updatedAt: task.updatedAt, recovery: task.recovery,
        requests: task.requests.map(request => ({ kind: request.kind, prompt: boundedDashboardText(request.prompt) })),
        resources: dashboardResources(task.resources),
      })), projects: model.projects, diagnostics: model.diagnostics,
    };
    return value;
  };
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const host = request.headers.host ?? '';
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : options.port;
    const allowedHosts = ['127.0.0.1', 'localhost', ...(listenHost === '0.0.0.0' ? ['0.0.0.0', hostname(), hostname().split('.')[0], ...networkAddresses()] : [])].map(name => name + ':' + port);
    if (!allowedHosts.includes(host) || (request.headers.origin && request.headers.origin !== 'http://' + host)) {
      json(response, 403, { error: '仅允许监听地址上的同源访问' }); return;
    }
    if (request.method !== 'GET') { response.setHeader('allow', 'GET'); json(response, 405, { error: '调试面板只读' }); return; }
    const url = new URL(request.url ?? '/', 'http://' + host);
    const assets = new Map([
      ['/', { type: 'text/html; charset=utf-8', body: dashboardHtml }],
      ['/app.css', { type: 'text/css; charset=utf-8', body: dashboardCss }],
      ['/app.js', { type: 'text/javascript; charset=utf-8', body: dashboardScript }],
    ]);
    const asset = assets.get(url.pathname);
    if (asset) { response.writeHead(200, { 'content-type': asset.type }); response.end(asset.body); return; }
    try {
      if (url.pathname === '/api/snapshot') { json(response, 200, snapshot()); return; }
      if (url.pathname === '/api/projects') {
        json(response, 200, readModel().projects); return;
      }
      const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
      if (projectMatch?.[1]) {
        const projectId = decodeURIComponent(projectMatch[1]);
        const project = readModel().projects.find(candidate => candidate.id === projectId) ?? null;
        if (!project) { json(response, 404, { error: '项目不存在' }); return; }
        json(response, 200, project); return;
      }
      const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (taskMatch?.[1]) {
        const taskId = decodeURIComponent(taskMatch[1]);
        const db = readStore();
        const tasks = db?.tasks() ?? [];
        if (!db || !tasks.some(task => task.id === taskId)) { json(response, 404, { error: '任务不存在' }); return; }
        const detail = await readerFor(db).taskDetail(taskId, tasks);
        if (!detail) { json(response, 404, { error: '任务不存在' }); return; }
        json(response, 200, {
          inputs: db.inputs(taskId).map(input => ({ id: input.id, text: boundedDashboardText(input.message.text), createdAt: input.message.createdAt, origin: input.origin, status: input.status, error: input.error ? boundedDashboardText(input.error) : null, attachments: input.message.attachments.map(attachment => ({ name: attachment.name, kind: attachment.kind })) })),
          outputs: db.outputs(taskId).map(output => ({ ...output, text: boundedDashboardText(output.text), error: output.error ? boundedDashboardText(output.error) : null })), projectId: detail?.projectId ?? null, task: detail?.task ?? null,
          threadId: detail?.threadId ?? null, cursor: detail?.cursor ?? execution.cursor, history: detail?.history, timeline: detail?.timeline ?? [], reports: detail?.reports ?? [], diagnostics: detail?.diagnostics ?? [],
        }); return;
      }
      if (url.pathname !== '/api/events') { json(response, 404, { error: '未找到' }); return; }
      const taskId = url.searchParams.get('taskId');
      const after = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? execution.cursor;
      if (!taskId || typeof after !== 'string' || !/^[^:]+:\d+$/.test(after)) { json(response, 400, { error: '无效的任务或事件游标' }); return; }
      const db = readStore();
      if (!db?.tasks().some(task => task.id === taskId)) { json(response, 404, { error: '任务不存在' }); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      response.write('retry: 1000\n\n');
      clients.add(response);
      let cursor = after;
      const threadId = url.searchParams.has('threadId') ? url.searchParams.get('threadId') || null : db.task(taskId).threadId;
      let blocked = false;
      let lastKeepAlive = Date.now();
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer); unsubscribe(); clients.delete(response);
      };
      const end = (event: string) => {
        finish();
        if (response.destroyed || response.writableEnded) return;
        response.end(event);
      };
      response.on('drain', () => { blocked = false; });
      const send = () => {
        if (closed || response.destroyed || response.writableEnded) { finish(); return; }
        if (blocked) { if (execution.since(cursor) === null || response.writableLength > 262144) end('event: reset\ndata: {}\n\n'); return; }
        try {
          const changes = execution.since(cursor);
          const task = db.tasks().find(candidate => candidate.id === taskId);
          if (changes === null || !task || task.threadId !== threadId) {
            end('event: reset\ndata: {}\n\n'); return;
          }
          for (const change of changes) {
            cursor = change.cursor;
            if (change.event.taskId !== taskId || change.event.threadId !== threadId) continue;
            if (!response.write('id: ' + cursor + '\nevent: execution\ndata: ' + JSON.stringify(change.event) + '\n\n')) { blocked = true; break; }
          }
          if (Date.now() - lastKeepAlive > 10_000 && !blocked) {
            lastKeepAlive = Date.now();
            blocked = !response.write(': heartbeat\n\n');
          }
        } catch (error) {
          end('event: stream-error\ndata: ' + JSON.stringify({ error: errorMessage(error) }) + '\n\n');
        }
      };
      const unsubscribe = execution.subscribe(() => send());
      const timer = setInterval(send, 1_000);
      response.on('close', finish);
      response.on('finish', finish);
      response.on('error', () => { finish(); response.destroy(); });
      send();
    } catch (error) { json(response, 500, { error: errorMessage(error) }); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, listenHost, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('调试面板未取得监听端口');
  let closing: Promise<void> | undefined;
  return {
    url: 'http://127.0.0.1:' + address.port,
    listenAddress: listenHost + ':' + address.port,
    networkUrls: listenHost === '0.0.0.0' ? networkAddresses().map(ip => 'http://' + ip + ':' + address.port) : [],
    close() {
      closing ??= (async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            for (const client of clients) client.end();
            server.closeAllConnections();
          });
        } finally { store?.close(); }
      })();
      return closing;
    },
  };
}
