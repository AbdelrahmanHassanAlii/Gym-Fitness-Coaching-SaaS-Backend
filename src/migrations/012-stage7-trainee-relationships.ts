import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

const stage7PermissionKeys = new Set([
  'trainees.read',
  'trainees.update',
  'trainees.invite',
  'trainees.accept',
  'trainees.reject',
  'trainees.end',
  'trainees.reactivate',
  'trainees.assignments.primary.manage',
  'trainees.assignments.assistant.manage',
  'trainees.assignments.nutritionist.manage',
  'trainees.migrate_out',
  'trainees.migrate_in',
]);

export const migration012Stage7TraineeRelationships: Migration = {
  id: '012-stage7-trainee-relationships',
  description: 'Create Stage 7 trainee relationship collections, indexes, and permission seeds',
  async up(db) {
    await db.collection('coaching_relationships').createIndexes([
      {
        key: { workspaceId: 1, traineeUserId: 1 },
        unique: true,
        name: 'coaching_relationships_workspace_trainee_unique',
      },
      {
        key: { workspaceId: 1, status: 1, updatedAt: -1 },
        name: 'coaching_relationships_workspace_status_updated',
      },
    ]);

    await db.collection('trainee_staff_assignments').createIndexes([
      {
        key: { relationshipId: 1, assignmentType: 1, active: 1 },
        unique: true,
        partialFilterExpression: { assignmentType: 'PRIMARY_TRAINER', active: true },
        name: 'trainee_assignments_one_active_primary',
      },
      {
        key: { relationshipId: 1, staffMembershipId: 1, assignmentType: 1, active: 1 },
        unique: true,
        partialFilterExpression: { active: true },
        name: 'trainee_assignments_active_staff_type_unique',
      },
      {
        key: { workspaceId: 1, staffMembershipId: 1, assignmentType: 1, active: 1 },
        name: 'trainee_assignments_active_staff_lookup',
      },
      {
        key: { relationshipId: 1, active: 1 },
        name: 'trainee_assignments_relationship_active',
      },
    ]);

    await db
      .collection('referral_codes')
      .createIndexes([{ key: { code: 1 }, unique: true, name: 'referral_codes_code_unique' }]);

    const now = new Date();
    for (const definition of permissionDefinitions.filter((item) =>
      stage7PermissionKeys.has(item.key),
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
    for (const profile of systemPermissionProfiles.filter((item) => item.context === 'WORKSPACE')) {
      for (const workspace of workspaceIds) {
        const filter = {
          context: 'WORKSPACE',
          workspaceId: workspace._id,
          roleKey: profile.roleKey,
          isSystemDefault: true,
        };
        const stage7Permissions = profile.permissions.filter((permission) =>
          stage7PermissionKeys.has(permission.permission),
        );
        const existing = await db.collection('permission_profiles').findOne(filter, {
          projection: { _id: 1 },
        });
        if (!existing) {
          await db.collection('permission_profiles').updateOne(
            filter,
            {
              $setOnInsert: {
                context: 'WORKSPACE',
                workspaceId: workspace._id,
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
        await db.collection('permission_profiles').updateOne(
          {
            context: 'WORKSPACE',
            workspaceId: workspace._id,
            roleKey: profile.roleKey,
            isSystemDefault: true,
          },
          {
            $set: {
              name: profile.name,
              status: 'ACTIVE',
              updatedAt: now,
            },
            ...(stage7Permissions.length > 0
              ? { $addToSet: { permissions: { $each: stage7Permissions } } }
              : {}),
          },
        );
      }
    }
  },
};
