import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [recordPath, command, ...args] = process.argv.slice(2);
if (!recordPath || !command) throw new Error('Expected record path and App Server command');
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  appendFileSync(recordPath, JSON.stringify({ direction: 'request', ...message }) + '\n');
  child.stdin.write(line + '\n');
});
createInterface({ input: child.stdout }).on('line', line => {
  const message = JSON.parse(line);
  if (['item/completed', 'turn/completed'].includes(message.method)) {
    appendFileSync(recordPath, JSON.stringify({ direction: 'event', ...message }) + '\n');
  }
  process.stdout.write(line + '\n');
});
child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.on('exit', code => process.exit(code ?? 1));
process.stdin.on('end', () => child.stdin.end());
