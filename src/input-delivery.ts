import { z } from 'zod';

const id = z.string().min(1).max(512).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value), 'Invalid identifier');
const explanation = z.string().min(1).max(8192).refine(value => value.trim().length > 0, 'An explanation is required');
export const supersedeInputSchema = z.strictObject({
  action: z.literal('supersede_input'), requestId: id, taskId: id, threadId: id, inputId: id,
  successorInputId: id, authorizationInputId: id, reason: explanation, evidence: explanation,
});
export type SupersedeInput = z.infer<typeof supersedeInputSchema>;
export const inputDispositionSchema = z.strictObject({
  kind: z.literal('superseded'), request: supersedeInputSchema, projectId: id, actorTaskId: id,
  recordedAt: z.number().int().nonnegative(), observedTurnId: id.nullable(),
  delivery: z.strictObject({ status: z.literal('uncertain'), error: z.string().nullable(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
});
export type InputDisposition = z.infer<typeof inputDispositionSchema>;
export const inboxStatusSchema = z.enum(['pending', 'delivering', 'delivered', 'failed', 'uncertain', 'held']);
type InputDelivery = { status: z.infer<typeof inboxStatusSchema>; disposition?: InputDisposition };

export function inputBlocksDelivery(input: InputDelivery): boolean {
  return !input.disposition && (input.status === 'delivering' || input.status === 'uncertain');
}
export function inputNeedsDelivery(input: InputDelivery): boolean {
  if (input.disposition) return false;
  switch (input.status) {
    case 'pending': case 'held': case 'delivering': case 'uncertain': return true;
    case 'delivered': case 'failed': return false;
    default: { const exhaustive: never = input.status; return exhaustive; }
  }
}
