import { type Db, type Document, ObjectId } from 'mongodb';
import { Database } from '../src/core/database/database';
import { PlatformMembershipStatuses } from '../src/modules/platform/platform.types';
import {
  platformUserAccountProjection,
  platformUserDirectoryIndex,
  platformUserDirectoryPipeline,
  platformUserMembershipProjection,
} from '../src/modules/platform-users/platform-user.repository';
import { summaryIntegrationConfig } from '../test/platform-workspace-summary.helpers';

// Read-only verifier. Fixtures/migrations belong to the isolated test harness, never this script.
export async function verifyPlatformUserPlans(db: Db): Promise<void> {
  const later = new ObjectId((1200).toString(16).padStart(24, '0'));
  for (const status of [undefined, ...PlatformMembershipStatuses]) {
    for (const afterId of [undefined, later]) {
      const query = { limit: 50, ...(status ? { status } : {}), ...(afterId ? { afterId } : {}) };
      const explain = await db
        .collection('platform_memberships')
        .aggregate(platformUserDirectoryPipeline(query), {
          hint: platformUserDirectoryIndex(query),
        })
        .explain('executionStats');
      assertPlan(
        `${status ?? 'unfiltered'}.${afterId ? 'later' : 'first'}`,
        explain,
        platformUserDirectoryIndex(query),
        true,
      );
    }
  }
  const userId = new ObjectId((10000 - 1499).toString(16).padStart(24, '0'));
  for (const [name, predicate, index] of [
    [
      'email.hit',
      { normalizedEmail: { $eq: 'plan-1499@example.com', $type: 'string' } },
      'users_normalized_email_unique',
    ],
    [
      'email.miss',
      { normalizedEmail: { $eq: 'not-present@example.com', $type: 'string' } },
      'users_normalized_email_unique',
    ],
    ['id.hit', { _id: userId }, '_id_'],
    ['id.miss', { _id: new ObjectId('ffffffffffffffffffffffff') }, '_id_'],
    ['detail.account', { _id: userId }, '_id_'],
  ] as const) {
    assertPlan(
      name,
      await db
        .collection('users')
        .find(predicate, {
          projection: platformUserAccountProjection,
          hint: index,
        })
        .limit(1)
        .explain('executionStats'),
      index,
    );
  }
  for (const [name, predicate] of [
    ['email.membership', { userId }],
    ['id.membership', { userId }],
    ['detail.membership', { userId }],
    ['search.filter.cursor', { userId, status: 'ACTIVE', _id: { $lt: later } }],
    ['membership.miss', { userId: new ObjectId('ffffffffffffffffffffffff') }],
  ] as const) {
    assertPlan(
      name,
      await db
        .collection('platform_memberships')
        .find(predicate, {
          projection: platformUserMembershipProjection,
          hint: 'platform_memberships_user_unique',
        })
        .limit(1)
        .explain('executionStats'),
      'platform_memberships_user_unique',
    );
  }
}

function assertPlan(name: string, explain: Document, expectedIndex: string, joined = false) {
  const cursor = explain.stages?.find((stage: Document) => stage.$cursor)?.$cursor ?? explain;
  const stages = new Set<string>();
  const indexes = new Set<string>();
  function walk(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'stage' && typeof entry === 'string') stages.add(entry.toUpperCase());
      if (key === 'indexName' && typeof entry === 'string') indexes.add(entry);
      if (typeof entry === 'object') walk(entry);
    }
  }
  walk(cursor.queryPlanner.winningPlan);
  walk(cursor.executionStats.executionStages);
  let foreignScans = 0;
  const foreignIndexes: string[] = [];
  for (const stage of explain.stages ?? []) {
    if (stage.$sort) stages.add('SORT');
    if (stage.$lookup) {
      foreignScans += stage.collectionScans ?? 0;
      foreignIndexes.push(...(stage.indexesUsed ?? []));
    }
  }
  const collscan = stages.has('COLLSCAN') || foreignScans > 0;
  const blockingSort = stages.has('SORT');
  console.log(
    JSON.stringify({
      name,
      indexes: [...indexes],
      foreignIndexes,
      totalKeysExamined: cursor.executionStats.totalKeysExamined,
      totalDocsExamined: cursor.executionStats.totalDocsExamined,
      collscan,
      blockingSort,
    }),
  );
  const broadPointLookup =
    !joined &&
    (cursor.executionStats.totalKeysExamined > 1 || cursor.executionStats.totalDocsExamined > 1);
  if (
    collscan ||
    blockingSort ||
    broadPointLookup ||
    !indexes.has(expectedIndex) ||
    (joined && !foreignIndexes.includes('_id_'))
  ) {
    throw new Error(`Unsafe Platform user plan: ${name}`);
  }
}

if (import.meta.main) {
  const dbName = process.env.PLATFORM_USER_PLAN_DB;
  if (!dbName?.startsWith('platform_user_plans_'))
    throw new Error(
      'Set PLATFORM_USER_PLAN_DB to an existing isolated platform_user_plans_ fixture database.',
    );
  const database = await Database.connect(summaryIntegrationConfig(dbName));
  try {
    await verifyPlatformUserPlans(database.db);
  } finally {
    await database.close();
  }
}
