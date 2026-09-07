import type { Collection } from 'mongodb';
import type { Database } from '../database/database';
import type { TransactionContext } from '../database/unit-of-work';
import type { AuditEventInput } from './audit.types';

interface AuditEventDocument extends AuditEventInput {
  occurredAt: Date;
}

export class AuditWriter {
  private readonly collection: Collection<AuditEventDocument>;

  constructor(database: Database) {
    this.collection = database.db.collection<AuditEventDocument>('audit_events');
  }

  async write(input: AuditEventInput, tx?: TransactionContext): Promise<void> {
    const document: AuditEventDocument = {
      ...input,
      occurredAt: input.occurredAt ?? new Date(),
    };

    await this.collection.insertOne(document, tx ? { session: tx.session } : undefined);
  }
}
