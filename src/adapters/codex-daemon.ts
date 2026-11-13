import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { z } from 'zod';
import { reasoningEffortSchema } from '../project.js';

export interface CodexConnection {
  send(message: string): Promise<void>;
  close(): Promise<void>;
}
export type CodexConnector = (handlers: { message: (message: string) => void; error: (error: Error) => void }) => Promise<CodexConnection>;
export const daemonSettingsSchema = z.object({
  command: z.array(z.string().min(1)).min(1).optional(),
  executable: z.string().min(1).optional(),
  socketPath: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  modelProvider: z.string().min(1).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
});
export function normalizeDaemonSettings(input: z.infer<typeof daemonSettingsSchema>) {
  const { command, ...settings } = daemonSettingsSchema.parse(input);
  const executable = settings.executable ?? command?.[0] ?? 'codex';
  if (command && settings.executable && command[0] !== settings.executable) throw new Error('codex.command and codex.executable disagree. Use codex.executable for the shared daemon.');
  const overrides: { model?: string; modelProvider?: string; reasoningEffort?: z.infer<typeof reasoningEffortSchema> } = {};
  if (command && command.length > 1) {
    if (command[1] !== 'app-server') throw new Error('codex.command must use the official app-server entry. Use codex.executable and Thread model/modelProvider/reasoningEffort settings.');
    for (let index = 2; index < command.length; index += 2) {
      const flag = command[index], assignment = command[index + 1];
      if ((flag !== '-c' && flag !== '--config') || !assignment) throw new Error(`Unsupported codex.command argument ${JSON.stringify(flag)}. Shared daemon mode accepts only model, model_provider and model_reasoning_effort overrides. Move them to codex.model, codex.modelProvider and codex.reasoningEffort.`);
      const match = /^(model|model_provider|model_reasoning_effort)\s*=\s*(.+)$/.exec(assignment);
      if (!match) throw new Error(`Cannot migrate codex.command override ${JSON.stringify(assignment)}. Shared daemon mode never changes global configuration. Use Thread model, modelProvider and reasoningEffort settings.`);
      const raw = match[2]!;
      let value: unknown = raw;
      if (raw.startsWith('"')) { try { value = JSON.parse(raw); } catch { throw new Error(`Invalid quoted Codex override ${assignment}`); } }
      else if (raw.startsWith("'") && raw.endsWith("'")) value = raw.slice(1, -1);
      const text = z.string().min(1).parse(value);
      if (match[1] === 'model') overrides.model = text;
      else if (match[1] === 'model_provider') overrides.modelProvider = text;
      else overrides.reasoningEffort = reasoningEffortSchema.parse(text);
    }
  }
  return { executable, socketPath: settings.socketPath, model: settings.model ?? overrides.model, modelProvider: settings.modelProvider ?? overrides.modelProvider, reasoningEffort: settings.reasoningEffort ?? overrides.reasoningEffort };
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
