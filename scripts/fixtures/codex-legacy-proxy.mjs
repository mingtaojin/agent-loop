import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const native = spawn('codex', ['app-server'], { stdio: 'pipe' });
native.stdout.pipe(process.stdout);
native.stderr.pipe(process.stderr);
native.on('exit', code => process.exit(code ?? 1));
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'thread/start') delete message.params.dynamicTools;
  if (message.method === 'thread/resume' && process.argv.includes('--try-resume-tools')) {
    message.params.dynamicTools = [{ type: 'function', name: 'ensure_workspace', description: 'Get a fixture workspace.', inputSchema: { type: 'object', properties: { repository: { type: 'string' } }, required: ['repository'], additionalProperties: false } }];
  }
  native.stdin.write(`${JSON.stringify(message)}\n`);
});
