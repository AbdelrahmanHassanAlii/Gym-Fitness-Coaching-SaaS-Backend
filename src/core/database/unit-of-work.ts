import type { ClientSession, TransactionOptions } from 'mongodb';
import type { Database } from './database';

export interface TransactionContext {
  session: ClientSession;
}

const defaultTransactionOptions: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
};

export class UnitOfWork {
  constructor(private readonly database: Database) {}

  async withTransaction<T>(
    operation: (tx: TransactionContext) => Promise<T>,
    options: TransactionOptions = defaultTransactionOptions,
  ): Promise<T> {
    const session = this.database.client.startSession();
    try {
      return await session.withTransaction(() => operation({ session }), options);
    } finally {
      await session.endSession();
    }
  }
}
