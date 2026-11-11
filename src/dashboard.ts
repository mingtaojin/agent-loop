import { createServer, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, networkInterfaces } from 'node:os';
import { z } from 'zod';
import { Store } from './store.js';
import { errorMessage, presentTaskSource } from './domain.js';
import { dashboardHtml, dashboardCss, dashboardScript } from './dashboard-page.js';

const cursorSchema = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const heartbeatSchema = z.object({ pid: z.number(), lastSeenAt: z.number(), intervalMs: z.number(), status: z.enum(['running', 'stopped']) });

export async function startDashboard(options: { dataDir: string; port: number; host?: '127.0.0.1' | '0.0.0.0' }) {
  const listenHost = options.host ?? '127.0.0.1';
  const networkAddresses = () => Object.values(networkInterfaces()).flatMap(addresses => (addresses ?? []).filter(address => address.family === 'IPv4' && !address.internal).map(address => address.address));
  let store: Store | null = null;
  const clients = new Set<ServerResponse>();
  const readStore = () => {
    if (!store && existsSync(join(options.dataDir, 'tasks.sqlite'))) store = new Store(options.dataDir, { readOnly: true });
    return store;
  };
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  };
  const snapshot = () => {
    const db = readStore();
    const rawHeartbeat = db?.meta('runtime-heartbeat');
    const heartbeat = rawHeartbeat ? heartbeatSchema.safeParse(JSON.parse(rawHeartbeat)) : null;
    return {
      dataDir: options.dataDir, now: Date.now(), runtime: heartbeat?.success ? heartbeat.data : null,
      tasks: (db?.tasks() ?? []).map(task => ({
        id: task.id, title: presentTaskSource(task.source, 200).title,
        sourceLabel: presentTaskSource(task.source, 200).label,
        sourceKind: task.source.kind, sourceUrl: task.source.kind === 'github' ? task.source.issue.url : null,
        status: task.status, executionStatus: task.executionStatus, reason: task.reason,
        workspaceSelection: task.workspaceSelection,
        threadId: task.threadId, turnId: task.turnId, chatId: task.chatId,
        createdAt: task.createdAt, updatedAt: task.updatedAt, recovery: task.recovery,
        requests: task.requests.map(request => ({ kind: request.kind, prompt: request.prompt })),
        resources: task.resources.map(resource => resource.kind === 'project'
          ? { kind: resource.kind, project: resource.project, workspace: resource.workspace }
          : { repository: resource.repository.name, workspace: resource.workspace }),
      })), diagnostics: db?.diagnostics() ?? [],
    };
  };
  const server = createServer((request, response) => {
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
      const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (taskMatch?.[1]) {
        const taskId = decodeURIComponent(taskMatch[1]);
        const db = readStore();
        if (!db?.tasks().some(task => task.id === taskId)) { json(response, 404, { error: '任务不存在' }); return; }
        json(response, 200, {
          inputs: db.inputs(taskId).map(input => ({ id: input.id, text: input.message.text, createdAt: input.message.createdAt, origin: input.origin, route: input.route, selectionHandled: input.selectionHandled, status: input.status, error: input.error, attachments: input.message.attachments.map(attachment => ({ name: attachment.name, kind: attachment.kind })) })),
          outputs: db.outputs(taskId),
        }); return;
      }
      if (url.pathname !== '/api/events') { json(response, 404, { error: '未找到' }); return; }
      const taskId = url.searchParams.get('taskId');
      const after = cursorSchema.safeParse(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
      if (!taskId || !after.success) { json(response, 400, { error: '无效的任务或事件游标' }); return; }
      const db = readStore();
      if (!db?.tasks().some(task => task.id === taskId)) { json(response, 404, { error: '任务不存在' }); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      response.write('retry: 1000\n\n');
      clients.add(response);
      let cursor = after.data;
      let blocked = false;
      let lastKeepAlive = Date.now();
      response.on('drain', () => { blocked = false; });
      const send = () => {
        if (blocked || response.destroyed) return;
        try {
          for (const event of db.executionEvents(taskId, cursor)) {
            cursor = event.seq;
            if (!response.write('id: ' + event.seq + '\nevent: execution\ndata: ' + JSON.stringify(event) + '\n\n')) { blocked = true; break; }
          }
          if (Date.now() - lastKeepAlive > 10_000 && !blocked) {
            lastKeepAlive = Date.now();
            blocked = !response.write(': heartbeat\n\n');
          }
        } catch (error) {
          response.write('event: stream-error\ndata: ' + JSON.stringify({ error: errorMessage(error) }) + '\n\n');
          response.end();
        }
      };
      const timer = setInterval(send, 250);
      response.on('close', () => { clearInterval(timer); clients.delete(response); });
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
