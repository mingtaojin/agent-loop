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

export const executionConfigSchema = z.strictObject({
  coordinator: executionProfileSchema,
  worker: executionProfileSchema,
});
export type ExecutionConfig = z.infer<typeof executionConfigSchema>;

export const supportedExecutionBackends = ['codex'] as const;

export function assertSupportedExecutionBackends(config: ExecutionConfig): void {
  for (const role of ['coordinator', 'worker'] as const) {
    const profile = config[role];
    if (!(supportedExecutionBackends as readonly string[]).includes(profile.backend)) {
      throw new Error(`Unsupported execution backend for ${role}: ${profile.backend}`);
    }
  }
}
