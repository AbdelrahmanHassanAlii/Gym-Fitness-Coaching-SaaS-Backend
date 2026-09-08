import { ObjectId } from 'mongodb';
import type { Migration } from './migration.types';

const staffRoles = ['GYM_MANAGER', 'TRAINER', 'ASSISTANT_TRAINER', 'NUTRITIONIST'];

export const migration009Stage5ExistingWorkspaceBackfill: Migration = {
  id: '009-stage5-existing-workspace-backfill',
  description: 'Backfill Stage 5 usage and pending subscriptions for existing workspaces',
  async up(db) {
    const now = new Date();
    const workspaces = await db
      .collection('workspaces')
      .find({}, { projection: { _id: 1 } })
      .toArray();

    for (const workspace of workspaces) {
      const memberships = await db
        .collection('workspace_memberships')
        .find(
          { workspaceId: workspace._id, status: 'ACTIVE' },
          { projection: { userId: 1, roles: 1 } },
        )
        .toArray();
      const activeStaff = new Set(
        memberships
          .filter((membership) =>
            (membership.roles ?? []).some((role: string) => staffRoles.includes(role)),
          )
          .map((membership) => membership.userId.toString()),
      ).size;

      await db.collection('workspace_usage').updateOne(
        { workspaceId: workspace._id },
        {
          $setOnInsert: {
            _id: new ObjectId(),
            workspaceId: workspace._id,
            activeTrainees: 0,
            activeStaff,
            storageBytes: 0,
            reservedStorageBytes: 0,
            calculatedAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );

      await db.collection('subscriptions').updateOne(
        { workspaceId: workspace._id },
        {
          $setOnInsert: {
            _id: new ObjectId(),
            workspaceId: workspace._id,
            lifecycleStatus: 'PENDING_ACTIVATION',
            version: 0,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
    }
  },
};
