import type { Migration } from './migration.types';

export const migration010Stage5WorkspaceUsageRevision: Migration = {
  id: '010-stage5-workspace-usage-revision',
  description: 'Initialize workspace usage revision token for Stage 5 reconciliation safety',
  async up(db) {
    await db
      .collection('workspace_usage')
      .updateMany({ revision: { $exists: false } }, { $set: { revision: 0 } });
  },
};
