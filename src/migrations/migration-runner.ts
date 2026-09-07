import type { Db } from 'mongodb';
import type { Migration } from './migration.types';

interface MigrationRecord {
  migrationId: string;
  description: string;
  appliedAt: Date;
}

export class MigrationRunner {
  constructor(
    private readonly db: Db,
    private readonly migrations: Migration[],
  ) {}

  async status(): Promise<Array<{ id: string; description: string; applied: boolean }>> {
    const appliedRecords = await this.db
      .collection<MigrationRecord>('db_migrations')
      .find({}, { projection: { migrationId: 1 } })
      .toArray();
    const applied = new Set(appliedRecords.map((record) => record.migrationId));

    return this.migrations.map((migration) => ({
      id: migration.id,
      description: migration.description,
      applied: applied.has(migration.id),
    }));
  }

  async migrate(): Promise<void> {
    const collection = this.db.collection<MigrationRecord>('db_migrations');
    await collection.createIndex({ migrationId: 1 }, { unique: true });

    for (const migration of this.migrations) {
      const existing = await collection.findOne({ migrationId: migration.id });
      if (existing) continue;

      await migration.up(this.db);
      await collection.insertOne({
        migrationId: migration.id,
        description: migration.description,
        appliedAt: new Date(),
      });
    }
  }
}
