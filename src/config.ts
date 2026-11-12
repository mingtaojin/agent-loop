import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { collectionRepositorySchema } from './domain.js';
import { projectConfigSchema } from './project.js';

const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use an environment variable name, not a credential');
const positiveMilliseconds = z.number().int().positive();
export const documentMaxLinesSchema = z.number().int().positive().max(100_000).default(3000);
export const documentBaseUrlSchema = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && url.pathname === '/' && !url.search && !url.hash;
}, 'Use an HTTPS tenant origin without credentials, path, query or fragment').transform(value => new URL(value).origin);

export const configSchema = z.strictObject({
  dataDir: z.string().min(1).default('./data'),
  submission: z.strictObject({
    maxPromptBytes: z.number().int().positive().max(16 * 1024 * 1024).default(1024 * 1024),
    maxConcurrentRequests: z.number().int().positive().max(128).default(16),
    requestTimeoutMs: positiveMilliseconds.max(120_000).default(10_000),
  }).default({ maxPromptBytes: 1024 * 1024, maxConcurrentRequests: 16, requestTimeoutMs: 10_000 }),
  dashboard: z.strictObject({ host: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(8787) }).default({ host: '127.0.0.1', port: 8787 }),
  repositories: z.array(collectionRepositorySchema).default([]).refine(
    repositories => new Set(repositories.map(repository => repository.name.toLowerCase())).size === repositories.length,
    'Repository names must be unique',
  ),
  engineering: z.strictObject({ projectRoot: z.string().trim().min(1).optional(), promptPath: z.string().min(1).optional(), skillPath: z.string().min(1).optional() }).optional(),
  projects: z.array(projectConfigSchema).default([]).superRefine((projects, context) => {
    const ids = new Set<string>(), repositories = new Set<string>();
    for (const project of projects) {
      if (ids.has(project.id)) context.addIssue({ code: 'custom', message: 'Project IDs must be unique' });
      ids.add(project.id);
      for (const repository of project.repositories) {
        const name = repository.name.toLowerCase();
        if (repositories.has(name)) context.addIssue({ code: 'custom', message: 'A repository can belong to only one coordinated project' });
        repositories.add(name);
      }
    }
  }),
  recovery: z.strictObject({ maxAttempts: z.number().int().nonnegative().default(3), retryDelayMs: positiveMilliseconds.default(1000) }).default({ maxAttempts: 3, retryDelayMs: 1000 }),
  github: z.strictObject({
    tokenEnv: environmentName.default('GITHUB_TOKEN'),
    apiUrl: z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)).default('https://api.github.com'),
    requestTimeoutMs: positiveMilliseconds.default(30_000),
  }).default(() => ({ tokenEnv: 'GITHUB_TOKEN', apiUrl: 'https://api.github.com', requestTimeoutMs: 30_000 })),
  feishu: z.strictObject({
    appIdEnv: environmentName.default('FEISHU_APP_ID'),
    appSecretEnv: environmentName.default('FEISHU_APP_SECRET'),
    userOpenId: z.string().min(1),
    progress: z.strictObject({
      enabled: z.boolean().default(false),
      surface: z.enum(['card', 'document']).default('card'),
      documentBaseUrl: documentBaseUrlSchema.optional(),
      intervalMs: positiveMilliseconds.min(1000).default(1000),
      maxLines: documentMaxLinesSchema,
      dashboardUrl: z.url().max(2048).refine(value => ['http:', 'https:'].includes(new URL(value).protocol)).optional(),
    }).refine(value => !value.enabled || value.surface !== 'document' || !!value.documentBaseUrl,
      'documentBaseUrl is required for enabled document progress').default({ enabled: false, surface: 'card', intervalMs: 1000, maxLines: 3000 }),
  }),
  codex: z.strictObject({
    command: z.array(z.string().min(1)).min(1).default(['codex', 'app-server']),
    model: z.string().min(1).optional(),
    selectionModel: z.string().min(1).optional(),
    approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).default('on-request'),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
    requestTimeoutMs: positiveMilliseconds.default(120_000),
  }).default({ command: ['codex', 'app-server'], approvalPolicy: 'on-request', sandbox: 'workspace-write', requestTimeoutMs: 120_000 }),
  pollIntervalMs: positiveMilliseconds.default(30_000),
  executionPollMs: positiveMilliseconds.default(2_000),
  maxAttachmentBytes: z.number().int().positive().default(20 * 1024 * 1024),
});

export type Config = z.infer<typeof configSchema>;

export async function loadConfig(path: string): Promise<Config> {
  const configPath = resolve(path);
  const directory = dirname(configPath);
  const raw: unknown = JSON.parse(await readFile(configPath, 'utf8'));
  const config = configSchema.parse(raw);
  config.dataDir = resolve(directory, config.dataDir);
  for (const project of config.projects) {
    project.directory = resolve(directory, project.directory);
    if (!(await stat(project.directory)).isDirectory()) throw new Error(`Project directory must exist: ${project.directory}`);
  }
  config.repositories = config.repositories.map(repository => !('path' in repository) ? repository : ({ ...repository, path: resolve(directory, repository.path),
    ...(repository.workspace?.kind === 'project-directory'
      ? { workspace: { ...repository.workspace, path: resolve(directory, repository.workspace.path) } } : {}),
  }));
  const guidance = config.engineering;
  if (guidance) {
    if (guidance.projectRoot) guidance.projectRoot = resolve(directory, guidance.projectRoot);
    if (guidance.promptPath) guidance.promptPath = resolve(directory, guidance.promptPath);
    if (guidance.skillPath) guidance.skillPath = resolve(directory, guidance.skillPath);
    for (const file of [guidance.promptPath, guidance.skillPath]) {
      if (!file) continue;
      await access(file, constants.R_OK);
      if (!(await stat(file)).isFile() || !(await readFile(file, 'utf8')).trim()) throw new Error(`Engineering guidance must be a readable, nonempty file: ${file}`);
    }
  }
  return config;
}
