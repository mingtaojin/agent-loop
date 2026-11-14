import { isAbsolute } from 'node:path';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
export const localArtifactRequestSchema = z.strictObject({
  kind: z.enum(['image', 'file']),
  chatId: nonEmpty,
  id: nonEmpty,
  root: z.string().min(1).refine(isAbsolute, 'Artifact root must be absolute'),
  path: z.string().min(1).refine(isAbsolute, 'Artifact path must be absolute'),
});
export type LocalArtifactRequest = z.infer<typeof localArtifactRequestSchema>;

export interface FeishuArtifactReceipt {
  id: string;
  chatId: string;
  kind: LocalArtifactRequest['kind'];
  name: string;
  bytes: number;
  sha256: string;
  key: string;
  messageId: string;
}

export interface FeishuArtifactPort {
  sendLocalArtifact(input: LocalArtifactRequest): Promise<FeishuArtifactReceipt>;
}

export type ArtifactDeliveryRecord = Omit<FeishuArtifactReceipt, 'messageId'> & {
  root: string;
  status: 'uploaded' | 'sent';
  messageId?: string;
};
export const artifactDeliveryRecordSchema = z.strictObject({
  id: z.string().min(1), chatId: z.string().min(1), kind: z.enum(['image', 'file']), root: z.string().min(1), name: z.string().min(1),
  bytes: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/), key: z.string().min(1),
  status: z.enum(['uploaded', 'sent']), messageId: z.string().min(1).optional(),
});

export interface ArtifactDeliveryLedger {
  read(id: string): Promise<ArtifactDeliveryRecord | null>;
  write(record: ArtifactDeliveryRecord): Promise<void>;
}

export class FeishuArtifactValidationError extends Error {}
export class FeishuArtifactConflictError extends Error {}

export class InMemoryArtifactDeliveryLedger implements ArtifactDeliveryLedger {
  private readonly records = new Map<string, ArtifactDeliveryRecord>();
  async read(id: string): Promise<ArtifactDeliveryRecord | null> { return structuredClone(this.records.get(id) ?? null); }
  async write(record: ArtifactDeliveryRecord): Promise<void> { this.records.set(record.id, structuredClone(record)); }
}
