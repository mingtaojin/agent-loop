import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Client } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { UncertainOperationError } from '../domain.js';
import { FeishuApiError } from '../ports.js';
import { artifactDeliveryRecordSchema, localArtifactRequestSchema, type ArtifactDeliveryLedger, FeishuArtifactConflictError, FeishuArtifactValidationError, InMemoryArtifactDeliveryLedger, type ArtifactDeliveryRecord, type FeishuArtifactPort, type FeishuArtifactReceipt, type LocalArtifactRequest } from '../feishu-artifact.js';

export type FeishuArtifactApi = {
  image: Pick<Client['im']['v1']['image'], 'create'>;
  file: Pick<Client['im']['v1']['file'], 'create'>;
  message: Pick<Client['im']['v1']['message'], 'create'>;
};
export type FeishuArtifactApiFactory = FeishuArtifactApi | (() => FeishuArtifactApi);

export interface FeishuArtifactPolicy {
  maxImageBytes?: number;
  maxFileBytes?: number;
}

const sdkLimits = { image: 10 * 1024 * 1024, file: 30 * 1024 * 1024 } as const;
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.ico', '.tiff', '.heic']);
const imageSignature = (extension: string, bytes: Buffer): boolean => {
  if (extension === '.png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === '.jpg' || extension === '.jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === '.gif') return bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (extension === '.bmp') return bytes.subarray(0, 2).toString('ascii') === 'BM';
  if (extension === '.webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (extension === '.ico') return bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]));
  if (extension === '.tiff') return bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]));
  if (extension === '.heic') return bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  return false;
};
const id = z.string().min(1);

function stableUuid(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
}

function sameArtifact(record: ArtifactDeliveryRecord, artifact: ValidatedArtifact): boolean {
  return record.chatId === artifact.chatId && record.kind === artifact.kind && record.name === artifact.name
    && record.bytes === artifact.bytes && record.sha256 === artifact.sha256;
}

type ValidatedArtifact = LocalArtifactRequest & { name: string; bytes: number; sha256: string; data: Buffer };

export class FeishuArtifactAdapter implements FeishuArtifactPort {
  private readonly limits: { image: number; file: number };
  private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<FeishuArtifactReceipt> }>();
  private apiInstance: FeishuArtifactApi | undefined;
  constructor(private readonly apiFactory: FeishuArtifactApiFactory, policy: FeishuArtifactPolicy = {}, private readonly ledger: ArtifactDeliveryLedger = new InMemoryArtifactDeliveryLedger()) {
    const image = policy.maxImageBytes ?? sdkLimits.image;
    const file = policy.maxFileBytes ?? sdkLimits.file;
    if (!Number.isSafeInteger(image) || image <= 0 || !Number.isSafeInteger(file) || file <= 0) throw new Error('Feishu artifact limits must be positive safe integers');
    this.limits = { image: Math.min(image, sdkLimits.image), file: Math.min(file, sdkLimits.file) };
  }
  private get api(): FeishuArtifactApi {
    return this.apiInstance ??= typeof this.apiFactory === 'function' ? this.apiFactory() : this.apiFactory;
  }
  private async validate(input: LocalArtifactRequest): Promise<ValidatedArtifact> {
    const parsed = localArtifactRequestSchema.safeParse(input);
    if (!parsed.success) throw new FeishuArtifactValidationError(parsed.error.issues.map(issue => issue.message).join('; '));
    const path = parsed.data.path;
    const metadata = await lstat(path).catch(error => { throw new FeishuArtifactValidationError(`Artifact path is unavailable: ${error instanceof Error ? error.message : String(error)}`); });
    if (!metadata.isFile()) throw new FeishuArtifactValidationError('Artifact path must be a regular file');
    const name = basename(path);
    if (!name || /[\u0000-\u001f\u007f]/u.test(name)) throw new FeishuArtifactValidationError('Artifact file name contains a control character');
    const maxBytes = this.limits[parsed.data.kind];
    if (metadata.size <= 0) throw new FeishuArtifactValidationError('Artifact file cannot be empty');
    if (metadata.size > maxBytes) throw new FeishuArtifactValidationError(`Artifact exceeds ${maxBytes} bytes`);
    const data = await readFile(path).catch(error => { throw new FeishuArtifactValidationError(`Artifact cannot be read: ${error instanceof Error ? error.message : String(error)}`); });
    if (data.length <= 0) throw new FeishuArtifactValidationError('Artifact file cannot be empty');
    if (data.length > maxBytes) throw new FeishuArtifactValidationError(`Artifact exceeds ${maxBytes} bytes`);
    const extension = extname(name).toLowerCase();
    if (parsed.data.kind === 'image' && (!imageExtensions.has(extension) || !imageSignature(extension, data))) throw new FeishuArtifactValidationError(`Artifact is not a supported ${extension || 'image'} file`);
    return { ...parsed.data, name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), data };
  }
  private receipt(record: ArtifactDeliveryRecord): FeishuArtifactReceipt {
    const messageId = id.safeParse(record.messageId);
    if (record.status !== 'sent' || !messageId.success) throw new UncertainOperationError('Feishu artifact ledger has no confirmed message ID');
    return { id: record.id, chatId: record.chatId, kind: record.kind, name: record.name, bytes: record.bytes, sha256: record.sha256, key: record.key, messageId: messageId.data };
  }
  private async upload(artifact: ValidatedArtifact): Promise<string> {
    try {
      if (artifact.kind === 'image') {
        const response = await this.api.image.create({ data: { image_type: 'message', image: artifact.data } });
        const key = response?.image_key;
        if (!key) throw new Error('Feishu image upload returned no image_key');
        return key;
      }
      const response = await this.api.file.create({ data: { file_type: 'stream', file_name: artifact.name, file: artifact.data } });
      const key = response?.file_key;
      if (!key) throw new Error('Feishu file upload returned no file_key');
      return key;
    } catch (error) {
      if (error instanceof UncertainOperationError) throw error;
      throw new UncertainOperationError(`Feishu ${artifact.kind} upload outcome is unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async send(artifact: ValidatedArtifact, key: string): Promise<string> {
    let response: Awaited<ReturnType<FeishuArtifactApi['message']['create']>>;
    try {
      response = await this.api.message.create({ params: { receive_id_type: 'chat_id' }, data: {
        receive_id: artifact.chatId, msg_type: artifact.kind,
        content: JSON.stringify(artifact.kind === 'image' ? { image_key: key } : { file_key: key }), uuid: stableUuid(`artifact:${artifact.id}`),
      } });
    } catch (error) {
      throw new UncertainOperationError(`Feishu artifact message outcome is unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response || typeof response.code !== 'number') throw new UncertainOperationError('Feishu artifact message returned an incomplete response');
    if (response.code !== 0) throw new FeishuApiError(response.code, response.msg ?? 'message rejected');
    const messageId = id.safeParse(response.data?.message_id);
    if (!messageId.success) throw new UncertainOperationError('Feishu artifact message returned no valid message_id');
    return messageId.data;
  }
  async sendLocalArtifact(input: LocalArtifactRequest): Promise<FeishuArtifactReceipt> {
    const artifact = await this.validate(input);
    const fingerprint = JSON.stringify([artifact.chatId, artifact.kind, artifact.name, artifact.bytes, artifact.sha256]);
    const active = this.inFlight.get(artifact.id);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new FeishuArtifactConflictError(`Artifact delivery ID ${artifact.id} is already active for different content`);
      return active.promise;
    }
    const promise = this.deliver(artifact);
    this.inFlight.set(artifact.id, { fingerprint, promise });
    try { return await promise; }
    finally { if (this.inFlight.get(artifact.id)?.promise === promise) this.inFlight.delete(artifact.id); }
  }
  private async deliver(artifact: ValidatedArtifact): Promise<FeishuArtifactReceipt> {
    const previous = await this.ledger.read(artifact.id);
    if (previous && !sameArtifact(previous, artifact)) throw new FeishuArtifactConflictError(`Artifact delivery ID ${artifact.id} does not match its recorded content`);
    if (previous?.status === 'sent') return this.receipt(previous);
    const key = previous?.key ?? await this.upload(artifact);
    if (!previous) await this.ledger.write({ id: artifact.id, chatId: artifact.chatId, kind: artifact.kind, name: artifact.name, bytes: artifact.bytes, sha256: artifact.sha256, key, status: 'uploaded' });
    const messageId = await this.send(artifact, key);
    const record: ArtifactDeliveryRecord = { id: artifact.id, chatId: artifact.chatId, kind: artifact.kind, name: artifact.name, bytes: artifact.bytes, sha256: artifact.sha256, key, status: 'sent', messageId };
    try { await this.ledger.write(record); }
    catch (error) { throw new UncertainOperationError(`Feishu artifact ledger write outcome is unknown: ${error instanceof Error ? error.message : String(error)}`); }
    return this.receipt(record);
  }
}
