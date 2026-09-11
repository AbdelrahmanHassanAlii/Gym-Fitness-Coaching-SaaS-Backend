import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

const stage10PermissionKeys = new Set([
  'foods.read',
  'foods.create',
  'foods.update',
  'foods.archive',
  'system_foods.read',
  'system_foods.create',
  'system_foods.update',
  'system_foods.archive',
  'nutrition.plans.read',
  'nutrition.plans.create',
  'nutrition.plans.update',
  'nutrition.plans.activate',
  'nutrition.plans.complete',
  'nutrition.plans.archive',
]);

export const migration015Stage10Nutrition: Migration = {
  id: '015-stage10-nutrition',
  description: 'Create Stage 10 nutrition collections, indexes, and permission seeds',
  async up(db) {
    await db.collection('foods').createIndexes([
      {
        key: { scope: 1, status: 1, _id: 1 },
        name: 'foods_scope_status',
      },
      {
        key: { workspaceId: 1, scope: 1, status: 1, _id: 1 },
        name: 'foods_workspace_scope_status',
      },
      {
        key: { workspaceId: 1, ownerMembershipId: 1, status: 1, _id: 1 },
        name: 'foods_private_owner_lookup',
      },
      {
        key: { scope: 1, workspaceId: 1, ownerMembershipId: 1, normalizedNames: 1 },
        unique: true,
        partialFilterExpression: { status: 'ACTIVE' },
        name: 'foods_active_normalized_name_unique',
      },
    ]);

    await db.collection('nutrition_plans').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, status: 1, _id: 1 },
        name: 'nutrition_plans_relationship_status',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, _id: 1 },
        name: 'nutrition_plans_relationship_history',
      },
      {
        key: { workspaceId: 1, relationshipId: 1 },
        unique: true,
        partialFilterExpression: { status: 'ACTIVE' },
        name: 'nutrition_plans_one_active_per_relationship',
      },
    ]);

    await db.collection('nutrition_plan_revisions').createIndexes([
      {
        key: { nutritionPlanId: 1, revision: 1 },
        unique: true,
        name: 'nutrition_plan_revisions_plan_revision_unique',
      },
      {
        key: { nutritionPlanId: 1, revision: -1 },
        name: 'nutrition_plan_revisions_plan_order',
      },
    ]);

    const now = new Date();
    for (const definition of permissionDefinitions.filter((item) =>
      stage10PermissionKeys.has(item.key),
    )) {
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
    for (const profile of systemPermissionProfiles) {
      const targets =
        profile.context === 'WORKSPACE'
          ? workspaceIds.map((workspace) => ({ workspaceId: workspace._id }))
          : [{ workspaceId: undefined }];
      const permissions = profile.permissions.filter((permission) =>
        stage10PermissionKeys.has(permission.permission),
      );
      if (permissions.length === 0) continue;
      for (const target of targets) {
        const filter = {
          context: profile.context,
          ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
          roleKey: profile.roleKey,
          isSystemDefault: true,
        };
        const existing = await db.collection('permission_profiles').findOne(filter, {
          projection: { _id: 1 },
        });
        if (!existing) {
          await db.collection('permission_profiles').updateOne(
            filter,
            {
              $setOnInsert: {
                context: profile.context,
                ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
                roleKey: profile.roleKey,
                isSystemDefault: true,
                name: profile.name,
                permissions: profile.permissions,
                status: 'ACTIVE',
                version: 0,
                createdAt: now,
                updatedAt: now,
              },
            },
            { upsert: true },
          );
          continue;
        }
        await db.collection('permission_profiles').updateOne(filter, {
          $set: { name: profile.name, status: 'ACTIVE', updatedAt: now },
          $addToSet: { permissions: { $each: permissions } },
        });
      }
    }
  },
};
