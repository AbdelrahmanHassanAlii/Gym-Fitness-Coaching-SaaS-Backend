import { ObjectId } from 'mongodb';
import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

const stage11PermissionKeys = new Set([
  'metric_definitions.read',
  'metric_definitions.create',
  'metric_definitions.update',
  'metric_definitions.archive',
  'measurements.read',
  'measurements.create',
  'measurements.update',
  'progress_photos.read',
  'progress_photos.create',
  'progress_photos.update_visibility',
  'progress_photos.delete',
  'health.read',
  'health.update',
  'health.food_allergies.read',
  'notes.read',
  'notes.create',
  'notes.update',
  'notes.archive',
  'adherence.read',
  'adherence.configure',
  'adherence.update',
  'adherence.correct',
]);

export const migration016Stage11Progress: Migration = {
  id: '016-stage11-progress',
  description: 'Create Stage 11 progress collections, indexes, and permission seeds',
  async up(db) {
    await db.collection('metric_definitions').createIndexes([
      {
        key: { scope: 1, status: 1, _id: 1 },
        name: 'metric_definitions_scope_status',
      },
      {
        key: { workspaceId: 1, scope: 1, status: 1, _id: 1 },
        name: 'metric_definitions_workspace_scope_status',
      },
      {
        key: { workspaceId: 1, ownerMembershipId: 1, status: 1, _id: 1 },
        name: 'metric_definitions_private_owner_lookup',
      },
      {
        key: { scope: 1, workspaceId: 1, ownerMembershipId: 1, normalizedKey: 1 },
        unique: true,
        partialFilterExpression: { status: 'ACTIVE', normalizedKey: { $exists: true } },
        name: 'metric_definitions_active_key_unique',
      },
      {
        key: { scope: 1, workspaceId: 1, ownerMembershipId: 1, normalizedName: 1 },
        unique: true,
        partialFilterExpression: { status: 'ACTIVE' },
        name: 'metric_definitions_active_name_unique',
      },
    ]);

    await db.collection('measurement_entries').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, metricDefinitionId: 1, measuredAt: -1, _id: -1 },
        name: 'measurement_entries_metric_history',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, measuredAt: -1, _id: -1 },
        name: 'measurement_entries_relationship_history',
      },
    ]);

    await db.collection('progress_photo_entries').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, capturedAt: -1, _id: -1 },
        name: 'progress_photo_entries_relationship_history',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, visibility: 1, capturedAt: -1, _id: -1 },
        name: 'progress_photo_entries_visibility_history',
      },
    ]);

    await db.collection('trainee_health_profiles').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1 },
        unique: true,
        name: 'trainee_health_profiles_relationship_unique',
      },
    ]);

    await db.collection('coaching_notes').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, visibility: 1, createdAt: -1, _id: -1 },
        name: 'coaching_notes_visibility_history',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, authorMembershipId: 1, createdAt: -1, _id: -1 },
        name: 'coaching_notes_author_history',
      },
    ]);

    await db.collection('adherence_configs').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1 },
        unique: true,
        name: 'adherence_configs_relationship_unique',
      },
    ]);

    await db.collection('daily_tracking_entries').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, localDate: 1 },
        unique: true,
        name: 'daily_tracking_entries_relationship_date_unique',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, localDate: -1 },
        name: 'daily_tracking_entries_relationship_history',
      },
    ]);

    const now = new Date();
    const systemMetricId = new ObjectId('000000000000000000000111');
    await db.collection('metric_definitions').updateOne(
      { key: 'BODY_WEIGHT', scope: 'SYSTEM' },
      {
        $set: {
          scope: 'SYSTEM',
          workspaceId: null,
          ownerMembershipId: null,
          key: 'BODY_WEIGHT',
          normalizedKey: 'body_weight',
          name: 'Body Weight',
          normalizedName: 'body weight',
          valueType: 'NUMBER',
          unit: 'KG',
          category: 'BODY',
          status: 'ACTIVE',
          version: 0,
          updatedAt: now,
          updatedBy: systemMetricId,
        },
        $setOnInsert: {
          createdAt: now,
          createdBy: systemMetricId,
        },
      },
      { upsert: true },
    );

    for (const definition of permissionDefinitions.filter((item) =>
      stage11PermissionKeys.has(item.key),
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
        stage11PermissionKeys.has(permission.permission),
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
