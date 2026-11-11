import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const native = spawn('codex', ['app-server'], { stdio: 'pipe' });
let model;
createInterface({ input: native.stdout }).on('line', line => {
  const message = JSON.parse(line);
  if (message.result?.thread && typeof message.result.model === 'string') model = message.result.model;
  process.stdout.write(`${line}\n`);
});
native.stderr.pipe(process.stderr);
native.on('exit', code => process.exit(code ?? 1));
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'turn/start') {
    if (!model) throw new Error('Native thread configuration did not return its model');
    message.params.collaborationMode = { mode: 'plan', settings: { model, reasoning_effort: null, developer_instructions: null } };
  }
  native.stdin.write(`${JSON.stringify(message)}\n`);
});
