import { ObjectId } from 'mongodb';
import { Database } from '../src/core/database/database';
import { migrations } from '../src/migrations';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { summaryIntegrationConfig } from '../test/platform-workspace-summary.helpers';

const database = await Database.connect(
  summaryIntegrationConfig(`workspace_count_plans_${new ObjectId()}`),
);
try {
  await new MigrationRunner(database.db, migrations).migrate();
  const workspaceIds = Array.from({ length: 12 }, () => new ObjectId());
  const target = workspaceIds[0];
  if (!target) throw new Error('Missing target fixture.');
  for (const workspaceId of workspaceIds) {
    await database.db.collection('branches').insertMany(
      Array.from({ length: 200 }, (_, i) => ({
        _id: new ObjectId(),
        workspaceId,
        status: i % 4 === 0 ? 'ARCHIVED' : 'ACTIVE',
      })),
    );
    await database.db.collection('coaching_relationships').insertMany(
      Array.from({ length: 200 }, (_, i) => ({
        _id: new ObjectId(),
        workspaceId,
        traineeUserId: new ObjectId(),
        status: ['ACTIVE', 'NEEDS_REASSIGNMENT', 'ENDED', 'PENDING'][i % 4],
      })),
    );
    await database.db.collection('workspace_memberships').insertMany(
      Array.from({ length: 200 }, (_, i) => ({
        _id: new ObjectId(),
        workspaceId,
        userId: new ObjectId(),
        status: i % 5 === 0 ? 'ENDED' : 'ACTIVE',
        roles: i % 3 === 0 ? ['TRAINEE'] : ['GYM_OWNER', 'TRAINER', 'NUTRITIONIST'],
      })),
    );
  }
  const queries = [
    {
      name: 'branches.active',
      collection: 'branches',
      predicate: { workspaceId: target, status: 'ACTIVE' },
    },
    {
      name: 'trainees.active',
      collection: 'coaching_relationships',
      predicate: { workspaceId: target, status: 'ACTIVE' },
    },
    {
      name: 'trainees.needsReassignment',
      collection: 'coaching_relationships',
      predicate: { workspaceId: target, status: 'NEEDS_REASSIGNMENT' },
    },
    {
      name: 'staff.activeIncludingOwners',
      collection: 'workspace_memberships',
      predicate: {
        workspaceId: target,
        status: 'ACTIVE',
        roles: {
          $in: ['GYM_OWNER', 'GYM_MANAGER', 'TRAINER', 'ASSISTANT_TRAINER', 'NUTRITIONIST'],
        },
      },
    },
  ];
  for (const query of queries) {
    // countDocuments uses this match/group pipeline; no hint or sort is supplied.
    const explain = await database.db
      .collection(query.collection)
      .aggregate([{ $match: query.predicate }, { $group: { _id: 1, n: { $sum: 1 } } }])
      .explain('executionStats');
    const cursor =
      explain.stages?.find((stage: Record<string, unknown>) => '$cursor' in stage)?.$cursor ??
      explain;
    const winningPlan = cursor.queryPlanner.winningPlan;
    const stages: string[] = [];
    const indexes: string[] = [];
    function walk(value: unknown) {
      if (!value || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'stage' && typeof entry === 'string') stages.push(entry);
        if (key === 'indexName' && typeof entry === 'string') indexes.push(entry);
        if (typeof entry === 'object') walk(entry);
      }
    }
    walk(winningPlan);
    const result = {
      name: query.name,
      winningPlan,
      indexes: [...new Set(indexes)],
      totalKeysExamined: cursor.executionStats.totalKeysExamined,
      totalDocsExamined: cursor.executionStats.totalDocsExamined,
      count: await database.db.collection(query.collection).countDocuments(query.predicate),
      collscan: stages.includes('COLLSCAN'),
      blockingSort: stages.includes('SORT'),
    };
    console.log(JSON.stringify(result));
    if (result.collscan || result.blockingSort || result.indexes.length === 0) {
      throw new Error(`Unsafe count plan: ${query.name}`);
    }
  }
} finally {
  await database.db.dropDatabase();
  await database.close();
}
