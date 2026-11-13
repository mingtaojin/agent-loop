import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CodexAppServer as SharedCodex, type CodexOptions } from '../../src/adapters/codex.js';
import type { CodexConnector } from '../../src/adapters/codex-daemon.js';

export function stdioFixture(command: string[], env = process.env): CodexConnector {
  return async handlers => {
    const [executable, ...args] = command;
    if (!executable) throw new Error('Missing fixture executable');
    const child = spawn(executable, args, { stdio: 'pipe', env });
    let closing = false;
    let stderr = '';
    const writeErrors = new WeakSet<Error>();
    child.stderr.on('data', data => { stderr += String(data); });
    child.on('error', handlers.error);
    child.stdin.on('error', error => { if (!writeErrors.has(error)) handlers.error(error); });
    child.on('exit', code => { if (!closing) handlers.error(new Error(`Fixture exited ${code}: ${stderr}`)); });
    createInterface({ input: child.stdout }).on('line', handlers.message);
    return {
      send: async message => {
        const value = JSON.parse(message);
        if (value.method === 'thread/unsubscribe') { queueMicrotask(() => handlers.message(JSON.stringify({ id: value.id, result: { status: 'unsubscribed' } }))); return; }
        await new Promise<void>((resolve, reject) => child.stdin.write(message + '\n', error => {
          if (error) { writeErrors.add(error); reject(error); }
          else resolve();
        }));
      },
      close: async () => {
        closing = true;
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill();
        await exited;
      },
    };
  };
}
export class CodexAppServer extends SharedCodex {
  constructor(options: CodexOptions) {
    const { command = ['codex', 'app-server'], ...settings } = options;
    super(settings, stdioFixture(command, options.env));
  }
}
