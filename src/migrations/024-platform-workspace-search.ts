import type { AnyBulkWriteOperation } from 'mongodb';
import { workspaceNameSearchPrefixes } from '../modules/workspaces/workspace-search';
import type { Migration } from './migration.types';

const BACKFILL_BATCH_SIZE = 250;

interface WorkspaceSearchBackfillDocument {
  _id: unknown;
  name: string;
  nameSearchPrefixes?: string[];
}

export const migration024PlatformWorkspaceSearch: Migration = {
  id: '024-platform-workspace-search',
  description: 'Backfill Platform workspace prefix search keys and indexes',
  async up(db) {
    const workspaces = db.collection<WorkspaceSearchBackfillDocument>('workspaces');
    const cursor = workspaces
      .find({}, { projection: { _id: 1, name: 1, nameSearchPrefixes: 1 } })
      .batchSize(BACKFILL_BATCH_SIZE);
    let operations: AnyBulkWriteOperation<WorkspaceSearchBackfillDocument>[] = [];

    const flush = async () => {
      if (operations.length === 0) return;
      await workspaces.bulkWrite(operations, { ordered: false });
      operations = [];
    };

    for await (const workspace of cursor) {
      const expected = workspaceNameSearchPrefixes(workspace.name);
      if (sameStrings(workspace.nameSearchPrefixes, expected)) continue;
      operations.push({
        updateOne: {
          filter: { _id: workspace._id },
          update: { $set: { nameSearchPrefixes: expected } },
        },
      });
      if (operations.length >= BACKFILL_BATCH_SIZE) await flush();
    }
    await flush();

    const verification = workspaces
      .find({}, { projection: { _id: 1, name: 1, nameSearchPrefixes: 1 } })
      .batchSize(BACKFILL_BATCH_SIZE);
    for await (const workspace of verification) {
      if (!sameStrings(workspace.nameSearchPrefixes, workspaceNameSearchPrefixes(workspace.name))) {
        throw new Error(
          `Workspace search backfill verification failed for ${String(workspace._id)}.`,
        );
      }
    }

    await workspaces.createIndexes([
      { key: { status: 1, _id: -1 }, name: 'workspaces_status_id' },
      {
        key: { nameSearchPrefixes: 1, _id: -1 },
        name: 'workspaces_name_search_prefixes_id',
      },
      {
        key: { status: 1, nameSearchPrefixes: 1, _id: -1 },
        name: 'workspaces_status_name_search_prefixes_id',
      },
    ]);
  },
};

function sameStrings(actual: string[] | undefined, expected: string[]): boolean {
  return (
    actual !== undefined &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}
