import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createWriteStream } from 'node:fs';
const native = spawn('codex', ['app-server'], { stdio: 'pipe' });
const log = createWriteStream(process.argv[2], { flags: 'a', mode: 0o600 });
native.stdout.on('data', bytes => { log.write(bytes); process.stdout.write(bytes); });
native.stderr.pipe(process.stderr);
native.on('exit', code => { log.end(); process.exit(code ?? 1); });
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (process.argv.includes('--legacy') && message.method === 'thread/start') delete message.params.dynamicTools;
  native.stdin.write(`${JSON.stringify(message)}\n`);
});
