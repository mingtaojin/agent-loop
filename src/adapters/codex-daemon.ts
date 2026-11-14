import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { z } from 'zod';

export interface CodexConnection {
  send(message: string): Promise<void>;
  close(): Promise<void>;
}
export type CodexConnector = (handlers: { message: (message: string) => void; error: (error: Error) => void }) => Promise<CodexConnection>;
export const daemonSettingsSchema = z.object({
  command: z.array(z.string().min(1)).min(1).optional(),
  executable: z.string().min(1).optional(),
  socketPath: z.string().min(1).optional(),
});
export function normalizeDaemonSettings(input: z.infer<typeof daemonSettingsSchema>) {
  const { command, ...settings } = daemonSettingsSchema.parse(input);
  const executable = settings.executable ?? command?.[0] ?? 'codex';
  if (command && settings.executable && command[0] !== settings.executable) throw new Error('execution.backends.codex.command and executable disagree.');
  if (command && command.length > 2) {
    throw new Error('execution.backends.codex.command cannot contain model overrides; configure role execution profiles instead.');
  }
  return { executable, socketPath: settings.socketPath };
}
export type DaemonSettings = ReturnType<typeof normalizeDaemonSettings>;
const execute = promisify(execFile);
const statusSchema = z.object({ status: z.string(), socketPath: z.string().nullish() });
const starts = new Map<string, Promise<void>>();

export function sharedDaemonConnector(settings: DaemonSettings, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): CodexConnector {
  return async handlers => {
    let socketPath = settings.socketPath;
    if (!socketPath) {
      const status = async () => {
        const { stdout } = await execute(settings.executable, ['app-server', 'daemon', 'version'], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true });
        try { return statusSchema.parse(JSON.parse(stdout)); }
        catch { throw new Error('Codex daemon discovery returned an incompatible response. Install a CLI with app-server daemon support.'); }
      };
      let discovered = await status();
      if (discovered.status !== 'running') {
        if (!['stopped', 'notRunning', 'not_running'].includes(discovered.status)) throw new Error(`Codex daemon reported unsupported status ${discovered.status}`);
        const key = `${settings.executable}\0${env.CODEX_HOME ?? ''}\0${env.HOME ?? ''}`;
        let starting = starts.get(key);
        if (!starting) {
          starting = (async () => {
            const current = await status();
            if (current.status === 'running') return;
            if (!['stopped', 'notRunning', 'not_running'].includes(current.status)) throw new Error(`Codex daemon reported unsupported status ${current.status}`);
            await execute(settings.executable, ['app-server', 'daemon', 'start'], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true });
          })();
          starts.set(key, starting);
          void starting.finally(() => { if (starts.get(key) === starting) starts.delete(key); }).catch(() => undefined);
        }
        await starting;
        discovered = await status();
      }
      if (discovered.status !== 'running' || !discovered.socketPath) throw new Error('Codex daemon did not become running with a socketPath after start');
      socketPath = discovered.socketPath;
    }
    return await new Promise<CodexConnection>((resolve, reject) => {
      const socket = new WebSocket('ws://localhost', { createConnection: () => connect({ path: socketPath }), handshakeTimeout: timeoutMs });
      let opened = false;
      let closing = false;
      socket.on('message', (data, binary) => {
        if (binary) { handlers.error(new Error('Codex daemon returned a binary protocol message')); return; }
        handlers.message(data.toString());
      });
      socket.on('error', error => { if (!opened) reject(error); else if (!closing) handlers.error(error); });
      socket.on('close', () => { if (!opened) reject(new Error('Codex daemon connection closed before handshake')); else if (!closing) handlers.error(new Error('Codex daemon connection closed; reconcile before retrying')); });
      socket.once('open', () => {
        opened = true;
        resolve({
          send: message => new Promise<void>((sent, failed) => socket.send(message, error => error ? failed(error) : sent())),
          close: () => new Promise<void>(closed => {
            closing = true;
            if (socket.readyState === WebSocket.CLOSED) { closed(); return; }
            socket.once('close', () => { clearTimeout(timer); closed(); });
            const timer = setTimeout(() => socket.terminate(), Math.min(timeoutMs, 1000));
            socket.close();
          }),
        });
      });
    });
  };
}
