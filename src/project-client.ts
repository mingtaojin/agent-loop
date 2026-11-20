import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { z } from 'zod';
import { projectToolCallSchema } from './project.js';

try {
  const [capabilityPath, toolOrPath, namedPath] = process.argv.slice(2);
  const tool = namedPath ? toolOrPath : 'project_action';
  const actionPath = namedPath ?? toolOrPath;
  if (!capabilityPath || !actionPath || ![4, 5].includes(process.argv.length)) throw new Error('Usage: project-client <task-capability-file> [project_action|send_agent_message|send_group_message] <arguments-json-file>');
  const capability = z.strictObject({ socketPath: z.string(), token: z.string() }).parse(JSON.parse(await readFile(capabilityPath, 'utf8')));
  const body = JSON.stringify(projectToolCallSchema.parse({ tool, arguments: JSON.parse(await readFile(actionPath, 'utf8')) }));
  const result = await new Promise<string>((resolve, reject) => {
    const outgoing = request({ socketPath: capability.socketPath, path: '/project', method: 'POST',
      headers: { authorization: `Bearer ${capability.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (incoming.statusCode === 200) resolve(text); else reject(new Error(text));
      });
      incoming.on('error', reject);
    });
    outgoing.setTimeout(120_000, () => outgoing.destroy(new Error('Project operation timed out; retry with the same request ID and content')));
    outgoing.on('error', reject);
    outgoing.end(body);
  });
  process.stdout.write(result + '\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
