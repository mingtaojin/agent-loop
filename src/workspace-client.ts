import { readFile } from 'node:fs/promises';
import { request } from 'node:http';

const [capabilityPath, target, projectId] = process.argv.slice(2);
try {
  if (!capabilityPath || !target || (target === '--project' ? !projectId || process.argv.length !== 5 : process.argv.length !== 4)) throw new Error('Usage: workspace-client <task-capability-file> <configured-repository> | --project <project-id>');
  const parsed: unknown = JSON.parse(await readFile(capabilityPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('socketPath' in parsed) || typeof parsed.socketPath !== 'string' || !('token' in parsed) || typeof parsed.token !== 'string') throw new Error('Invalid workspace capability');
  const { socketPath, token } = parsed;
  const body = JSON.stringify(target === '--project' ? { projectId } : { repository: target });
  const result = await new Promise<string>((resolve, reject) => {
    const outgoing = request({ socketPath, path: '/workspace', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (incoming.statusCode !== 200) reject(new Error(text)); else resolve(text);
      });
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
  process.stdout.write(`${result}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
