import type { ClientSession, TransactionOptions } from 'mongodb';
import type { Database } from './database';

export interface TransactionContext {
  session: ClientSession;
  beforeCommit?: Map<string, () => Promise<void>>;
  platformAccessRevisionSubjects?: Set<string>;
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
      return await session.withTransaction(async () => {
        const tx: TransactionContext = { session, beforeCommit: new Map() };
        const result = await operation(tx);
        for (const check of tx.beforeCommit?.values() ?? []) await check();
        return result;
      }, options);
    } finally {
      await session.endSession();
    }
  }
}
