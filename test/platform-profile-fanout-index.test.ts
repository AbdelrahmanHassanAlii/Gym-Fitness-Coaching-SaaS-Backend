import { expect, test } from 'bun:test';
import { type Document, ObjectId } from 'mongodb';
import { Database } from '../src/core/database/database';
import { migrations } from '../src/migrations';
import { migration004Stage3WorkspacesIndexes } from '../src/migrations/004-stage3-workspaces-indexes';
import { migration026PlatformUserDirectoryIndexes } from '../src/migrations/026-platform-user-directory-indexes';
import { migration028PlatformMembershipPermissionProfileFanoutIndex as migration } from '../src/migrations/028-platform-membership-permission-profile-fanout-index';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { assertAssignedMembershipRevisionCapacity } from '../src/modules/platform/platform-authority.guard';
import { summaryIntegrationConfig } from './platform-workspace-summary.helpers';

const indexName = 'platform_memberships_permission_profile_ids';

function stages(plan: Document): Document[] {
  return [
    plan,
    ...Object.values(plan).flatMap((value) => {
      if (Array.isArray(value))
        return value.flatMap((item) => (item && typeof item === 'object' ? stages(item) : []));
      return value && typeof value === 'object' ? stages(value) : [];
    }),
  ];
}

function indexedPlan(explain: Document, maximum: number) {
  const nodes = stages(explain.queryPlanner.winningPlan);
  expect(nodes.some((node) => node.stage === 'COLLSCAN')).toBe(false);
  expect(nodes.some((node) => node.stage === 'IXSCAN' && node.indexName === indexName)).toBe(true);
  expect(explain.executionStats.totalDocsExamined).toBeLessThanOrEqual(maximum);
  expect(explain.executionStats.totalKeysExamined).toBeLessThanOrEqual(maximum + 1);
}

test('permission profile fanout migration is registered after the locked 027 prefix', () => {
  expect(migrations).toHaveLength(28);
  expect(migrations.at(-1)?.id).toBe('028-platform-membership-permission-profile-fanout-index');
});

test('028 is additive, rerunnable, preserves historical documents and runner identity', async () => {
  const database = await Database.connect(
    summaryIntegrationConfig(`fanout_migration_${new ObjectId()}`),
  );
  try {
    const db = database.db;
    const members = db.collection('platform_memberships');
    const profileId = new ObjectId();
    await members.insertMany([
      {
        userId: new ObjectId(),
        status: 'ACTIVE',
        permissionProfileIds: [profileId, profileId],
        version: 3,
        accessVersion: 7,
      },
      {
        userId: new ObjectId(),
        status: 'SUSPENDED',
        permissionProfileIds: Array.from({ length: 21 }, () => new ObjectId()),
      },
      { userId: new ObjectId(), status: 'ENDED', permissionProfileIds: [] },
      { userId: new ObjectId(), permissionProfileIds: null },
      { userId: new ObjectId(), permissionProfileIds: 'legacy' },
      { userId: new ObjectId() },
    ]);
    await migration004Stage3WorkspacesIndexes.up(db);
    await migration026PlatformUserDirectoryIndexes.up(db);
    const before = await members.find({}).sort({ _id: 1 }).toArray();
    const existingIndexes = await members.indexes();
    const collections = (await db.listCollections().toArray()).map((item) => item.name).sort();
    await migration.up(db);
    await migration.up(db);
    expect(await members.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    expect((await db.listCollections().toArray()).map((item) => item.name).sort()).toEqual(
      collections,
    );
    const indexes = await members.indexes();
    expect(indexes.filter((index) => index.name !== indexName)).toEqual(existingIndexes);
    const created = indexes.find((index) => index.name === indexName);
    expect(created?.key).toEqual({ permissionProfileIds: 1 });
    expect(created?.unique ?? false).toBe(false);
    expect(created?.sparse ?? false).toBe(false);
    expect(created?.partialFilterExpression).toBeUndefined();
    const runner = new MigrationRunner(db, [migration]);
    await runner.migrate();
    await runner.migrate();
    expect(await db.collection('db_migrations').countDocuments({ migrationId: migration.id })).toBe(
      1,
    );
    expect(await members.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
  } finally {
    await database.db.dropDatabase();
    await database.close();
  }
}, 30_000);

test('unhinted fanout hit, miss, overflow and revision-update plans stay indexed across statuses', async () => {
  const database = await Database.connect(
    summaryIntegrationConfig(`fanout_plans_${new ObjectId()}`),
  );
  try {
    const db = database.db;
    const members = db.collection('platform_memberships');
    const low = new ObjectId();
    const high = new ObjectId();
    const other = new ObjectId();
    for (let offset = 0; offset < 25000; offset += 1000) {
      await members.insertMany(
        Array.from({ length: 1000 }, (_, j) => {
          const i = offset + j;
          return {
            userId: new ObjectId(),
            status: ['ACTIVE', 'SUSPENDED', 'ENDED'][i % 3],
            permissionProfileIds: [i < 10 ? low : i < 12010 ? high : other],
            version: 0,
            accessVersion: 0,
          };
        }),
      );
    }
    await migration004Stage3WorkspacesIndexes.up(db);
    await migration026PlatformUserDirectoryIndexes.up(db);
    await migration.up(db);
    for (const [profileId, expected] of [
      [low, 10],
      [new ObjectId(), 0],
      [high, 10001],
    ] as const) {
      const explain = await members
        .find({ permissionProfileIds: profileId }, { projection: { version: 1 } })
        .limit(10001)
        .explain('executionStats');
      indexedPlan(explain, expected);
      expect(explain.executionStats.nReturned).toBe(expected);
    }
    await expect(assertAssignedMembershipRevisionCapacity(db, high)).rejects.toMatchObject({
      code: 'PLATFORM_AUTHORITY_EVALUATION_LIMIT_EXCEEDED',
    });
    const update = {
      update: 'platform_memberships',
      updates: [
        {
          q: { permissionProfileIds: low },
          u: { $inc: { version: 1, accessVersion: 1 } },
          multi: true,
        },
      ],
    };
    indexedPlan(await db.command({ explain: update, verbosity: 'executionStats' }), 10);
    expect(await members.countDocuments({ version: 1 })).toBe(0); // Explain does not write.
    const session = database.client.startSession();
    try {
      await session.withTransaction(async () => {
        await assertAssignedMembershipRevisionCapacity(db, low, { session });
        const rows = await members.find({ permissionProfileIds: low }, { session }).toArray();
        expect(new Set(rows.map((row) => row.status))).toEqual(
          new Set(['ACTIVE', 'SUSPENDED', 'ENDED']),
        );
        const result = await members.updateMany(
          { permissionProfileIds: low },
          { $inc: { version: 1, accessVersion: 1 } },
          { session },
        );
        expect(result.modifiedCount).toBe(10);
      });
    } finally {
      await session.endSession();
    }
    expect(await members.countDocuments({ version: 1, accessVersion: 1 })).toBe(10);
  } finally {
    await database.db.dropDatabase();
    await database.close();
  }
}, 60_000);
