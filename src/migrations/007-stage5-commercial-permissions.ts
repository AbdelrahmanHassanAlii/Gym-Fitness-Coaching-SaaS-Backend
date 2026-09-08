import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

const stage5Keys = new Set([
  'plans.read',
  'plans.create',
  'plans.update',
  'plans.archive',
  'plans.versions.create',
  'subscriptions.read',
  'subscriptions.start_trial',
  'subscriptions.change_plan',
  'subscriptions.change_terms',
  'subscriptions.freeze',
  'subscriptions.reactivate',
  'subscriptions.cancel',
  'payments.read',
  'payments.approve',
  'payments.reject',
  'billing.subscription.read',
  'billing.usage.read',
  'billing.payments.read',
  'billing.payments.create',
]);

export const migration007Stage5CommercialPermissions: Migration = {
  id: '007-stage5-commercial-permissions',
  description: 'Seed Stage 5 commercial permission definitions and system profiles',
  async up(db) {
    const now = new Date();
    for (const definition of permissionDefinitions.filter((item) => stage5Keys.has(item.key))) {
      await db.collection('permission_definitions').updateOne(
        { key: definition.key },
        {
          $set: { ...definition, state: 'ACTIVE', updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
    }

    const workspaceIds = await db
      .collection('workspaces')
      .find({}, { projection: { _id: 1 } })
      .toArray();
    const profileSeeds = systemPermissionProfiles.filter(
      (profile) =>
        profile.roleKey === 'PLATFORM_SUPER_ADMIN' ||
        profile.roleKey === 'SUBSCRIPTION_ADMIN' ||
        profile.roleKey === 'GYM_OWNER',
    );

    for (const profile of profileSeeds) {
      const targets =
        profile.context === 'WORKSPACE'
          ? workspaceIds.map((workspace) => ({ workspaceId: workspace._id }))
          : [{ workspaceId: undefined }];
      for (const target of targets) {
        await db.collection('permission_profiles').updateOne(
          {
            context: profile.context,
            ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
            roleKey: profile.roleKey,
            isSystemDefault: true,
          },
          {
            $set: {
              name: profile.name,
              permissions: profile.permissions,
              status: 'ACTIVE',
              updatedAt: now,
            },
            $setOnInsert: {
              context: profile.context,
              ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
              roleKey: profile.roleKey,
              isSystemDefault: true,
              version: 0,
              createdAt: now,
            },
          },
          { upsert: true },
        );
      }
    }
  },
};
