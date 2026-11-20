import { z } from 'zod';

export const executionRoleSchema = z.enum(['coordinator', 'worker']);
export type ExecutionRole = z.infer<typeof executionRoleSchema>;

export const reasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const executionProfileSchema = z.strictObject({
  backend: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningEffort: reasoningEffortSchema,
});
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;

export const workerExecutionIdentitySchema = z.strictObject({
  profile: executionProfileSchema,
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('dispatch'), coordinatorTaskId: z.string().min(1), requestId: z.string().min(1) }),
    z.strictObject({ kind: z.literal('legacy-task-metadata'), modelKey: z.string().min(1), effortKey: z.string().min(1) }),
  ]),
});
export type WorkerExecutionIdentity = z.infer<typeof workerExecutionIdentitySchema>;

export const workerExecutionProfilesSchema = z.array(executionProfileSchema).min(1)
  .superRefine((profiles, context) => {
    const seen = new Set<string>();
    for (const [index, profile] of profiles.entries()) {
      const identity = JSON.stringify(profile);
      if (seen.has(identity)) context.addIssue({ code: 'custom', path: [index], message: 'Worker execution profiles must be unique' });
      seen.add(identity);
    }
  });
export type WorkerExecutionProfiles = z.infer<typeof workerExecutionProfilesSchema>;

export function sameExecutionProfile(left: ExecutionProfile, right: ExecutionProfile): boolean {
  return left.backend === right.backend && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}

export class HistoricalExecutionIdentityError extends Error {
  constructor(taskId: string) {
    super(`Historical Worker ${taskId} has no reliable saved execution identity; coordinator review is required before resume`);
  }
}

export const executionConfigSchema = z.strictObject({
  coordinator: executionProfileSchema,
  worker: z.union([executionProfileSchema, workerExecutionProfilesSchema]).transform(value => Array.isArray(value) ? value : [value]),
});
export type ExecutionConfig = z.infer<typeof executionConfigSchema>;

export const supportedExecutionBackends = ['codex'] as const;

export function assertSupportedExecutionBackends(config: ExecutionConfig): void {
  for (const [role, profile] of [
    ['coordinator', config.coordinator] as const,
    ...config.worker.map((candidate, index) => [`worker[${index}]`, candidate] as const),
  ]) {
    if (!(supportedExecutionBackends as readonly string[]).includes(profile.backend)) {
      throw new Error(`Unsupported execution backend for ${role}: ${profile.backend}`);
    }
  }
}
