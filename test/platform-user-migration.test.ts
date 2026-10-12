import { expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { Database } from '../src/core/database/database';
import { migrations } from '../src/migrations';
import { migration026PlatformUserDirectoryIndexes } from '../src/migrations/026-platform-user-directory-indexes';
import { summaryIntegrationConfig } from './platform-workspace-summary.helpers';

test('026 remains index-only and rerunnable without document changes', async () => {
  expect(migrations.slice(0, 27)).toHaveLength(27);
  expect(migrations[25]).toBe(migration026PlatformUserDirectoryIndexes);
  const database = await Database.connect(
    summaryIntegrationConfig(`platform_user_migration_${new ObjectId()}`),
  );
  try {
    const collection = database.db.collection('platform_memberships');
    await collection.insertOne({ _id: new ObjectId(), status: 'SUSPENDED', sentinel: 'unchanged' });
    const before = await collection.find({}).toArray();
    await migration026PlatformUserDirectoryIndexes.up(database.db);
    await migration026PlatformUserDirectoryIndexes.up(database.db);
    expect(await collection.find({}).toArray()).toEqual(before);
    const indexes = await collection.listIndexes().toArray();
    expect(indexes).toHaveLength(2);
    expect(indexes.find((index) => index.name === 'platform_memberships_status_id')?.key).toEqual({
      status: 1,
      _id: -1,
    });
  } finally {
    await database.db.dropDatabase();
    await database.close();
  }
}, 30_000);
