import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceTargetSchema, type TaskResource, type WorkspaceTarget } from './domain.js';

export class WorkspaceBridge {
  private readonly capabilities = new Map<string, { token: string; file: string }>();
  private server: Server | null = null;
  private directory: string | null = null;
  private opening: Promise<string> | null = null;
  constructor(private readonly dataDir: string, private readonly ensure: (taskId: string, target: WorkspaceTarget) => Promise<TaskResource>) {}

  private open(): Promise<string> {
    this.opening ??= (async () => {
      this.directory = await mkdtemp(join(tmpdir(), 'agent-loop-ipc-'));
      const socket = join(this.directory, 'workspace.sock');
      this.server = createServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        try {
          if (request.method !== 'POST' || request.url !== '/workspace') { response.writeHead(404).end('{}'); return; }
          const capability = [...this.capabilities].find(([, value]) => request.headers.authorization === `Bearer ${value.token}`);
          if (!capability) { response.writeHead(403).end('{"error":"Invalid task capability"}'); return; }
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of request) {
            const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > 16_384) { response.writeHead(413).end('{"error":"Request too large"}'); request.destroy(); return; }
            chunks.push(bytes);
          }
          const input = workspaceTargetSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          const resource = await this.ensure(capability[0], input);
          response.end(JSON.stringify(resource));
        } catch (error) {
          response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(socket, () => { this.server!.off('error', reject); resolve(); });
      });
      return socket;
    })();
    return this.opening;
  }
  async grant(taskId: string): Promise<string> {
    const current = this.capabilities.get(taskId);
    if (current) return current.file;
    const socketPath = await this.open();
    const directory = join(this.dataDir, 'workspace-capabilities');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const capability = { token: randomBytes(32).toString('hex'), file: join(directory, `${taskId}.json`) };
    await writeFile(capability.file, JSON.stringify({ socketPath, token: capability.token }), { mode: 0o600 });
    this.capabilities.set(taskId, capability);
    return capability.file;
  }
  async close(): Promise<void> {
    await this.opening?.catch(() => undefined);
    if (this.server) await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.capabilities.clear();
  }
}
