import { describe, expect, test } from 'bun:test';
import { MongoClient, ObjectId } from 'mongodb';
import { migration024PlatformWorkspaceSearch } from '../src/migrations/024-platform-workspace-search';
import { WorkspaceRepository } from '../src/modules/workspaces/workspace.repository';
import {
  normalizeWorkspaceSearchQuery,
  normalizeWorkspaceSearchText,
  workspaceNameSearchPrefixes,
} from '../src/modules/workspaces/workspace-search';

describe('Platform workspace name search normalization', () => {
  test('normalizes English and Arabic whitespace without transliteration', () => {
    expect(normalizeWorkspaceSearchText('  ATLAS\t  Gym  ')).toBe('atlas gym');
    expect(normalizeWorkspaceSearchText('  نادي\n  القاهرة  ')).toBe('نادي القاهرة');
  });

  test('generates unique non-empty prefixes by Unicode code point up to 64', () => {
    expect(workspaceNameSearchPrefixes('😀A')).toEqual(['😀', '😀a']);
    expect(workspaceNameSearchPrefixes('aaaa')).toEqual(['a', 'aa', 'aaa', 'aaaa']);
    const long = workspaceNameSearchPrefixes('😀'.repeat(70));
    expect(long).toHaveLength(64);
    expect(Array.from(long.at(-1) ?? '')).toHaveLength(64);
    expect(long).not.toContain('');
  });

  test('treats blank q as absent and rejects more than 64 normalized code points', () => {
    expect(normalizeWorkspaceSearchQuery(' \t\n ')).toBeUndefined();
    expect(normalizeWorkspaceSearchQuery(' A  Gym ')).toBe('a gym');
    expect(normalizeWorkspaceSearchQuery('😀'.repeat(64))).toBe('😀'.repeat(64));
    expect(() => normalizeWorkspaceSearchQuery('😀'.repeat(65))).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED', httpStatus: 400 }),
    );
  });
});

describe('Platform workspace search migration', () => {
  test('sorts both backfill and verification traversal by ascending _id', async () => {
    const sorts: Array<Record<string, number>> = [];
    const cursor = {
      sort(specification: Record<string, number>) {
        sorts.push(specification);
        return this;
      },
      batchSize() {
        return this;
      },
      async *[Symbol.asyncIterator]() {},
    };
    const db = {
      collection() {
        return {
          find() {
            return cursor;
          },
          async bulkWrite() {},
          async createIndexes() {},
        };
      },
    };

    await migration024PlatformWorkspaceSearch.up(db as never);

    expect(sorts).toEqual([{ _id: 1 }, { _id: 1 }]);
  });

  test('backfills missing and stale prefixes in batches and creates only the approved indexes', async () => {
    const client = new MongoClient(mongoUri());
    await client.connect();
    const db = client.db(`platform_workspace_search_migration_${new ObjectId()}`);
    try {
      const workspaces = db.collection('workspaces');
      const shuffledId = (position: number) =>
        new ObjectId((253 - position).toString(16).padStart(24, '0'));
      await workspaces.insertMany([
        ...Array.from({ length: 251 }, (_, index) => ({
          _id: shuffledId(index),
          name: `Atlas Gym ${index}`,
          status: 'ACTIVE',
        })),
        { _id: shuffledId(251), name: ' نادي   القاهرة ', status: 'ARCHIVED' },
        {
          _id: shuffledId(252),
          name: '😀'.repeat(70),
          status: 'RESTRICTED',
          nameSearchPrefixes: ['stale'],
        },
      ]);

      await migration024PlatformWorkspaceSearch.up(db);
      await migration024PlatformWorkspaceSearch.up(db);

      const arabic = await workspaces.findOne({ name: ' نادي   القاهرة ' });
      expect(arabic?.nameSearchPrefixes).toEqual([
        'ن',
        'نا',
        'ناد',
        'نادي',
        'نادي ',
        'نادي ا',
        'نادي ال',
        'نادي الق',
        'نادي القا',
        'نادي القاه',
        'نادي القاهر',
        'نادي القاهرة',
      ]);
      const long = await workspaces.findOne({ name: '😀'.repeat(70) });
      expect(long?.nameSearchPrefixes).toHaveLength(64);
      expect(Array.from(long?.nameSearchPrefixes.at(-1) ?? '')).toHaveLength(64);
      expect(await workspaces.countDocuments({ nameSearchPrefixes: { $exists: true } })).toBe(253);

      const indexes = await workspaces.indexes();
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'workspaces_status_id', key: { status: 1, _id: -1 } }),
          expect.objectContaining({
            name: 'workspaces_name_search_prefixes_id',
            key: { nameSearchPrefixes: 1, _id: -1 },
          }),
          expect.objectContaining({
            name: 'workspaces_status_name_search_prefixes_id',
            key: { status: 1, nameSearchPrefixes: 1, _id: -1 },
          }),
        ]),
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  }, 30_000);

  test('keeps create and rename search keys synchronized without rewriting them on other updates', async () => {
    const client = new MongoClient(mongoUri());
    await client.connect();
    const db = client.db(`platform_workspace_search_writes_${new ObjectId()}`);
    try {
      const repository = new WorkspaceRepository({ db } as never);
      const created = await repository.create({
        type: 'GYM',
        name: 'Atlas   Gym',
        ownerUserId: new ObjectId(),
        status: 'ACTIVE',
        timezone: 'Africa/Cairo',
        defaultLanguage: 'en',
      });
      expect(created.nameSearchPrefixes.at(-1)).toBe('atlas gym');

      const nonNameUpdate = await repository.update(created._id, { timezone: 'UTC' });
      expect(nonNameUpdate.nameSearchPrefixes).toEqual(created.nameSearchPrefixes);

      const renamed = await repository.update(created._id, { name: 'Nile Club' });
      expect(renamed.nameSearchPrefixes.at(-1)).toBe('nile club');
      expect(
        await db.collection('workspaces').countDocuments({ nameSearchPrefixes: 'atlas' }),
      ).toBe(0);
      expect(await db.collection('workspaces').countDocuments({ nameSearchPrefixes: 'nile' })).toBe(
        1,
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  }, 30_000);

  test('uses indexed unhinted plans without collection scans or blocking sorts', async () => {
    const client = new MongoClient(mongoUri());
    await client.connect();
    const db = client.db(`platform_workspace_search_explain_${new ObjectId()}`);
    try {
      const workspaces = db.collection('workspaces');
      const documents = Array.from({ length: 2_000 }, (_, index) => {
        const name = index % 2 === 0 ? `Atlas Gym ${index}` : `نادي القاهرة ${index}`;
        return {
          _id: new ObjectId(),
          name,
          status: index % 4 === 0 ? 'ACTIVE' : 'ARCHIVED',
          nameSearchPrefixes: workspaceNameSearchPrefixes(name),
        };
      });
      await workspaces.insertMany(documents);
      await migration024PlatformWorkspaceSearch.up(db);
      const cursorDocument = documents[1_800];
      if (!cursorDocument) {
        throw new Error('Expected representative workspace at cursor boundary');
      }
      const cursor = cursorDocument._id;
      const cases = [
        {
          filter: { _id: { $lt: cursor } },
          index: '_id_',
        },
        {
          filter: { status: 'ACTIVE', _id: { $lt: cursor } },
          index: 'workspaces_status_id',
        },
        {
          filter: { nameSearchPrefixes: 'atlas', _id: { $lt: cursor } },
          index: 'workspaces_name_search_prefixes_id',
        },
        {
          filter: {
            status: 'ACTIVE',
            nameSearchPrefixes: 'atlas',
            _id: { $lt: cursor },
          },
          index: 'workspaces_status_name_search_prefixes_id',
        },
      ];
      for (const item of cases) {
        const result = await workspaces
          .find(item.filter)
          .sort({ _id: -1 })
          .limit(51)
          .explain('executionStats');
        const summary = summarizePlan(result.queryPlanner.winningPlan);
        expect(summary.stages).not.toContain('COLLSCAN');
        expect(summary.stages).not.toContain('SORT');
        expect(summary.indexes).toContain(item.index);
        expect(result.executionStats.totalKeysExamined).toBeGreaterThan(0);
        expect(result.executionStats.totalDocsExamined).toBe(result.executionStats.nReturned);
      }
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  }, 30_000);
});

function summarizePlan(plan: unknown): { stages: string[]; indexes: string[] } {
  const stages = new Set<string>();
  const indexes = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.stage === 'string') stages.add(record.stage);
    if (typeof record.indexName === 'string') indexes.add(record.indexName);
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(plan);
  return { stages: [...stages], indexes: [...indexes] };
}

function mongoUri() {
  return (
    process.env.MONGODB_URI ??
    'mongodb://127.0.0.1:27017/gym_platform?replicaSet=rs0&directConnection=true'
  );
}
