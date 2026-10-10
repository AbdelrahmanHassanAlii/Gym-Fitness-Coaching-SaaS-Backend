import type { ObjectId } from 'mongodb';
import type { Migration } from './migration.types';

const BATCH_SIZE = 250;

export const migration025PlatformWorkspaceManagement: Migration = {
  id: '025-platform-workspace-management',
  description: 'Backfill workspace management versions and owner candidate index',
  async up(db) {
    const workspaces = db.collection('workspaces');
    let afterId: ObjectId | undefined;
    while (true) {
      const page = await workspaces
        .find(afterId ? { _id: { $gt: afterId } } : {}, { projection: { _id: 1, version: 1 } })
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .toArray();
      if (page.length === 0) break;
      const missing = page.filter((workspace) => !Number.isInteger(workspace.version));
      if (missing.length > 0) {
        await workspaces.bulkWrite(
          missing.map((workspace) => ({
            updateOne: {
              filter: { _id: workspace._id, version: { $exists: false } },
              update: { $set: { version: 0 } },
            },
          })),
          { ordered: false },
        );
      }
      afterId = page.at(-1)?._id;
    }

    const invalid = await workspaces.findOne(
      { version: { $not: { $type: 'int' } } },
      { projection: { _id: 1 } },
    );
    if (invalid) throw new Error(`Workspace version backfill failed for ${String(invalid._id)}.`);

    await db.collection('users').createIndexes([
      { key: { status: 1, _id: -1 }, name: 'users_status_id' },
      {
        key: { normalizedEmail: 1, status: 1 },
        name: 'users_normalized_email_status',
      },
    ]);
  },
};
