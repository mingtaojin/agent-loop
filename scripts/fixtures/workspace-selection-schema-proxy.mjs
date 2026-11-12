import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [record, schemaMode, command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
const save = value => appendFileSync(record, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (schemaMode === 'original' && message.method === 'turn/start') {
    const choice = message.params.outputSchema.properties.choice;
    choice.oneOf = choice.anyOf;
    delete choice.anyOf;
  }
  if (message.method === 'turn/start') save({ method: message.method, outputSchema: message.params.outputSchema, sandboxPolicy: message.params.sandboxPolicy });
  child.stdin.write(line + '\n');
});
createInterface({ input: child.stdout }).on('line', line => {
  const message = JSON.parse(line);
  const result = message.result;
  if (result?.modelProvider) save({ model: result.model, modelProvider: result.modelProvider, cwd: result.cwd, sandbox: result.sandbox, approvalPolicy: result.approvalPolicy });
  if (message.method === 'error' || message.method === 'turn/completed' || message.error) save(message);
  process.stdout.write(line + '\n');
});
process.stdin.on('end', () => child.stdin.end());
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 1));
