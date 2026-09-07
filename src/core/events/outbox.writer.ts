import type { Collection } from 'mongodb';
import type { Database } from '../database/database';
import type { TransactionContext } from '../database/unit-of-work';
import type { OutboxEventDocument, OutboxEventInput } from './outbox.types';

export class OutboxWriter {
  private readonly collection: Collection<OutboxEventDocument>;

  constructor(database: Database) {
    this.collection = database.db.collection<OutboxEventDocument>('outbox_events');
  }

  async write(input: OutboxEventInput, tx?: TransactionContext): Promise<void> {
    const document: OutboxEventDocument = {
      ...input,
      status: 'PENDING',
      attempts: 0,
      occurredAt: input.occurredAt ?? new Date(),
    };

    await this.collection.insertOne(document, tx ? { session: tx.session } : undefined);
  }
}
