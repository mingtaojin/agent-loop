import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import { submissionSchema, submissionReceiptSchema, type Submission, type SubmissionReceipt } from './domain.js';

const errorCodeSchema = z.enum(['invalid_input', 'conflict', 'unavailable', 'not_ready', 'busy', 'unauthorized', 'unknown_outcome']);
const failureSchema = z.strictObject({
  requestId: z.string().nullable(), error: z.strictObject({ code: errorCodeSchema, message: z.string() }),
});
const endpointSchema = z.strictObject({ version: z.literal(1), socketPath: z.string().min(1), token: z.string().regex(/^[0-9a-f]{64}$/) });
type Settings = Config['submission'];
export class SubmissionError extends Error {
  constructor(readonly code: z.infer<typeof errorCodeSchema>, message: string, readonly requestId: string | null = null) { super(message); }
  toJSON(): z.infer<typeof failureSchema> { return { requestId: this.requestId, error: { code: this.code, message: this.message } }; }
}
export function decodeSubmissionText(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new SubmissionError('invalid_input', 'Input must be valid UTF-8'); }
}
export function parseSubmission(value: unknown, maxPromptBytes: number): Submission {
  const result = submissionSchema.safeParse(value);
  if (!result.success) throw new SubmissionError('invalid_input', result.error.message);
  if (Buffer.byteLength(result.data.prompt, 'utf8') > maxPromptBytes) throw new SubmissionError('invalid_input', `Prompt exceeds ${maxPromptBytes} bytes`, result.data.requestId);
  return result.data;
}
async function boundedBytes(stream: AsyncIterable<unknown>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new SubmissionError('invalid_input', 'Expected a byte stream');
    length += chunk.byteLength;
    if (length > limit) throw new SubmissionError('invalid_input', `Input exceeds ${limit} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function readSubmissionPrompt(path: string, maxPromptBytes: number): Promise<string> {
  const stream = path === '-' ? process.stdin : createReadStream(path);
  return decodeSubmissionText(await boundedBytes(stream, maxPromptBytes));
}
const endpointPath = (dataDir: string) => join(dataDir, 'submission-endpoint.json');
const wireLimit = (settings: Settings) => settings.maxPromptBytes * 6 + 4096;
function authorized(header: string | undefined, token: string): boolean {
  const actual = Buffer.from(header ?? ''); const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class SubmissionService {
  private readonly token = randomBytes(32).toString('hex');
  private readonly handlers = new Set<Promise<void>>();
  private readonly server;
  private directory: string | null = null;
  private state: 'new' | 'opening' | 'ready' | 'closing' | 'closed' = 'new';
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  constructor(private readonly dataDir: string, private readonly settings: Settings,
    private readonly submit: (input: Submission) => Promise<SubmissionReceipt>) {
    this.server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      const work = this.handle(request, response);
      this.handlers.add(work);
      void work.finally(() => this.handlers.delete(work)).catch(() => undefined);
    });
    this.server.headersTimeout = settings.requestTimeoutMs;
    this.server.requestTimeout = settings.requestTimeoutMs;
    this.server.keepAliveTimeout = 1000;
    this.server.on('connection', socket => socket.setTimeout(settings.requestTimeoutMs, () => socket.destroy()));
  }
  start(): Promise<void> {
    if (this.state === 'closing' || this.state === 'closed') return Promise.reject(new SubmissionError('not_ready', 'Runtime is stopping'));
    this.opening ??= this.publish();
    return this.opening;
  }
  private async publish(): Promise<void> {
    this.state = 'opening';
    const temporary = endpointPath(this.dataDir) + `.${this.token}.tmp`;
    try {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await chmod(this.dataDir, 0o700);
      this.directory = await mkdtemp(join(tmpdir(), 'al-submit-'));
      await chmod(this.directory, 0o700);
      const socketPath = join(this.directory, 'rpc.sock');
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(socketPath, () => { this.server.off('error', reject); resolve(); });
      });
      await chmod(socketPath, 0o600);
      await writeFile(temporary, JSON.stringify({ version: 1, socketPath, token: this.token }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, endpointPath(this.dataDir));
      if (!this.closing) this.state = 'ready';
    } finally { await rm(temporary, { force: true }); }
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let requestId: string | null = null;
    const timer = setTimeout(() => request.destroy(), this.settings.requestTimeoutMs);
    response.setHeader('content-type', 'application/json');
    response.setHeader('connection', 'close');
    try {
      if (request.method !== 'POST' || request.url !== '/submit') throw new SubmissionError('invalid_input', 'Use POST /submit');
      if (!authorized(request.headers.authorization, this.token)) throw new SubmissionError('unauthorized', 'Invalid local submission capability');
      if (this.state !== 'ready') throw new SubmissionError('not_ready', 'Runtime is not accepting submissions');
      if (this.handlers.size >= this.settings.maxConcurrentRequests) throw new SubmissionError('busy', 'Too many submission requests');
      const raw: unknown = JSON.parse(decodeSubmissionText(await boundedBytes(request.iterator({ destroyOnReturn: false }), wireLimit(this.settings))));
      const input = parseSubmission(raw, this.settings.maxPromptBytes);
      requestId = input.requestId;
      if (this.state !== 'ready') throw new SubmissionError('not_ready', 'Runtime is stopping', requestId);
      const receipt = await this.submit(input);
      response.writeHead(200).end(JSON.stringify(receipt));
    } catch (error) {
      const failure = error instanceof SubmissionError ? error
        : error instanceof SyntaxError ? new SubmissionError('invalid_input', 'Invalid JSON request', requestId)
        : new SubmissionError('unknown_outcome', 'Submission outcome is unknown; reconcile by request ID', requestId);
      const statuses = { invalid_input: 400, unauthorized: 403, conflict: 409, busy: 429, not_ready: 503, unavailable: 503, unknown_outcome: 500 };
      response.writeHead(statuses[failure.code]).end(JSON.stringify(failure.toJSON()));
    } finally {
      clearTimeout(timer);
      if (!request.complete) response.once('finish', () => request.destroy());
    }
  }
  close(): Promise<void> {
    this.closing ??= this.stop();
    return this.closing;
  }
  private async stop(): Promise<void> {
    this.state = 'closing';
    await this.opening?.catch(() => undefined);
    try {
      const saved = endpointSchema.parse(JSON.parse(await readFile(endpointPath(this.dataDir), 'utf8')));
      if (saved.token === this.token) await rm(endpointPath(this.dataDir), { force: true });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        if (!(error instanceof z.ZodError || error instanceof SyntaxError)) throw error;
      }
    }
    const closed = new Promise<void>((resolve, reject) => {
      this.server.close(error => error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING') ? reject(error) : resolve());
    });
    await Promise.allSettled([...this.handlers]);
    this.server.closeAllConnections();
    await closed;
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.state = 'closed';
  }
}

async function readEndpoint(dataDir: string) {
  const file = await open(endpointPath(dataDir), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Endpoint must be a private file owned by this user');
    return endpointSchema.parse(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}
export async function submitPrompt(options: { dataDir: string; settings: Settings; input: Submission }): Promise<SubmissionReceipt> {
  const { input, settings } = options;
  let endpoint: z.infer<typeof endpointSchema>;
  try { endpoint = await readEndpoint(options.dataDir); }
  catch { throw new SubmissionError('unavailable', 'Runtime endpoint is unavailable', input.requestId); }
  return new Promise<SubmissionReceipt>((resolve, reject) => {
    let sent = false;
    const fail = () => reject(new SubmissionError(sent ? 'unknown_outcome' : 'unavailable',
      sent ? 'Submission outcome is unknown; query status or retry the same request ID and prompt' : 'Runtime is unavailable', input.requestId));
    const call = request({ socketPath: endpoint.socketPath, method: 'POST', path: '/submit', agent: false,
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' } }, response => {
      void (async () => {
        const raw: unknown = JSON.parse(decodeSubmissionText(await boundedBytes(response, 65_536)));
        if (response.statusCode !== 200) {
          const failure = failureSchema.parse(raw);
          reject(new SubmissionError(failure.error.code, failure.error.message, input.requestId)); return;
        }
        const receipt = submissionReceiptSchema.parse(raw);
        if (receipt.requestId !== input.requestId) { fail(); return; }
        resolve(receipt);
      })().catch(fail);
    });
    call.on('socket', socket => socket.once('connect', () => { sent = true; }));
    call.once('error', fail);
    const timer = setTimeout(() => call.destroy(new Error('Submission timed out')), settings.requestTimeoutMs);
    call.once('close', () => clearTimeout(timer));
    call.end(JSON.stringify(input));
  });
}
