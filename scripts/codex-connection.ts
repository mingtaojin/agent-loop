import { appendFile } from 'node:fs/promises';
import { z } from 'zod';
import { normalizeDaemonSettings, sharedDaemonConnector, type CodexConnection, type CodexConnector } from '../src/adapters/codex-daemon.js';

const messageSchema = z.object({ method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), result: z.object({ model: z.string().optional() }).passthrough().optional() }).passthrough();
export function observedCodexConnection(options: { recordPath?: string; legacy?: boolean; plan?: boolean; tryResumeTools?: boolean } = {}) {
  let connection: CodexConnection | undefined;
  let model: string | undefined;
  let fail: ((error: Error) => void) | undefined;
  const connect = sharedDaemonConnector(normalizeDaemonSettings({}), 30_000);
  const connector: CodexConnector = async handlers => {
    const current = await connect({
      ...handlers,
      message: data => {
        const message = messageSchema.parse(JSON.parse(data));
        model = message.result?.model ?? model;
        if (options.recordPath) void appendFile(options.recordPath, JSON.stringify({ direction: 'event', ...message }) + '\n');
        handlers.message(data);
      },
    });
    connection = current;
    fail = handlers.error;
    return {
      ...current,
      send: async data => {
        const message = messageSchema.parse(JSON.parse(data));
        if (message.params && options.legacy && message.method === 'thread/start') delete message.params.dynamicTools;
        if (message.params && options.tryResumeTools && message.method === 'thread/resume') message.params.dynamicTools = [{ type: 'function', name: 'ensure_workspace', description: 'Get a fixture workspace.', inputSchema: { type: 'object', properties: { repository: { type: 'string' } }, required: ['repository'], additionalProperties: false } }];
        if (message.params && options.plan && message.method === 'turn/start') {
          if (!model) throw new Error('Native Thread did not return its model');
          message.params.collaborationMode = { mode: 'plan', settings: { model, reasoning_effort: null, developer_instructions: null } };
        }
        if (options.recordPath) await appendFile(options.recordPath, JSON.stringify({ direction: 'request', ...message }) + '\n');
        await current.send(JSON.stringify(message));
      },
    };
  };
  return { connector, disconnect: async () => { await connection?.close(); fail?.(new Error('Verification disconnected its own Codex connection')); } };
}
