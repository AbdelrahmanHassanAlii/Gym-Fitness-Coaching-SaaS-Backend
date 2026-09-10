import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

const stage8PermissionKeys = new Set([
  'exercises.read',
  'exercises.create',
  'exercises.update',
  'exercises.archive',
  'program_templates.read',
  'program_templates.create',
  'program_templates.update',
  'program_templates.archive',
  'programs.read',
  'programs.create',
  'programs.update',
  'programs.activate',
  'programs.complete',
  'programs.archive',
  'system_exercises.read',
  'system_exercises.create',
  'system_exercises.update',
  'system_exercises.archive',
]);

export const migration013Stage8TrainingFoundation: Migration = {
  id: '013-stage8-training-foundation',
  description: 'Create Stage 8 training foundation collections, indexes, and permission seeds',
  async up(db) {
    await db.collection('exercises').createIndexes([
      {
        key: { workspaceId: 1, scope: 1, status: 1, _id: 1 },
        name: 'exercises_workspace_scope_status',
      },
      {
        key: { workspaceId: 1, ownerMembershipId: 1, status: 1, _id: 1 },
        name: 'exercises_private_owner_lookup',
      },
      {
        key: { scope: 1, workspaceId: 1, ownerMembershipId: 1, normalizedNames: 1 },
        unique: true,
        partialFilterExpression: { status: 'ACTIVE' },
        name: 'exercises_active_normalized_name_unique',
      },
    ]);

    await db.collection('program_templates').createIndexes([
      {
        key: { workspaceId: 1, scope: 1, status: 1, _id: 1 },
        name: 'program_templates_workspace_scope_status',
      },
      {
        key: { workspaceId: 1, ownerMembershipId: 1, status: 1, _id: 1 },
        name: 'program_templates_private_owner_lookup',
      },
    ]);

    await db.collection('program_template_revisions').createIndexes([
      {
        key: { templateId: 1, revision: 1 },
        unique: true,
        name: 'program_template_revisions_template_revision_unique',
      },
    ]);

    await db.collection('programs').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, status: 1 },
        name: 'programs_workspace_relationship_status',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, _id: 1 },
        name: 'programs_relationship_listing',
      },
      {
        key: { workspaceId: 1, relationshipId: 1 },
        unique: true,
        partialFilterExpression: { status: 'ACTIVE' },
        name: 'programs_one_active_per_relationship',
      },
    ]);

    await db.collection('program_revisions').createIndexes([
      {
        key: { programId: 1, revision: 1 },
        unique: true,
        name: 'program_revisions_program_revision_unique',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, programId: 1 },
        name: 'program_revisions_workspace_relationship_program',
      },
    ]);

    await db.collection('program_progress').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, programId: 1 },
        unique: true,
        name: 'program_progress_program_unique',
      },
    ]);

    await db.collection('program_progress_events').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, programId: 1, occurredAt: 1, _id: 1 },
        name: 'program_progress_events_program_order',
      },
    ]);

    const now = new Date();
    for (const definition of permissionDefinitions.filter((item) =>
      stage8PermissionKeys.has(item.key),
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
      const stage8Permissions = profile.permissions.filter((permission) =>
        stage8PermissionKeys.has(permission.permission),
      );
      if (stage8Permissions.length === 0) continue;
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
          $addToSet: { permissions: { $each: stage8Permissions } },
        });
      }
    }
  },
};
