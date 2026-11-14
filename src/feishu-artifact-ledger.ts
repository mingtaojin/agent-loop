import type { Store } from './store.js';
import { artifactDeliveryRecordSchema, type ArtifactDeliveryLedger, type ArtifactDeliveryRecord } from './feishu-artifact.js';

export class StoreArtifactDeliveryLedger implements ArtifactDeliveryLedger {
  constructor(private readonly store: Store, private readonly prefix = 'feishu-artifact:') {}
  async read(id: string): Promise<ArtifactDeliveryRecord | null> {
    const value = this.store.meta(`${this.prefix}${id}`);
    return value ? artifactDeliveryRecordSchema.parse(JSON.parse(value)) : null;
  }
  async write(record: ArtifactDeliveryRecord): Promise<void> {
    this.store.setMeta(`${this.prefix}${record.id}`, JSON.stringify(artifactDeliveryRecordSchema.parse(record)));
  }
}
