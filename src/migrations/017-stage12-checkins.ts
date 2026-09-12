import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

const stage12PermissionKeys = new Set([
  'checkins.templates.read',
  'checkins.templates.create',
  'checkins.templates.update',
  'checkins.templates.archive',
  'checkins.assignments.read',
  'checkins.assign',
  'checkins.assignments.update',
  'checkins.assignments.end',
  'checkins.read',
  'checkins.submit',
  'checkins.review',
]);

export const migration017Stage12CheckIns: Migration = {
  id: '017-stage12-checkins',
  description: 'Create Stage 12 check-in collections, indexes, and permission seeds',
  async up(db) {
    await db.collection('checkin_templates').createIndexes([
      { key: { workspaceId: 1, status: 1, _id: 1 }, name: 'checkin_templates_workspace_status' },
      {
        key: { workspaceId: 1, normalizedName: 1 },
        unique: true,
        partialFilterExpression: { status: 'ACTIVE' },
        name: 'checkin_templates_active_name_unique',
      },
    ]);

    await db.collection('checkin_template_revisions').createIndexes([
      {
        key: { templateId: 1, revision: 1 },
        unique: true,
        name: 'checkin_template_revisions_template_revision_unique',
      },
      {
        key: { workspaceId: 1, templateId: 1, revision: -1 },
        name: 'checkin_template_revisions_template_history',
      },
    ]);

    await db.collection('checkin_assignments').createIndexes([
      { key: { relationshipId: 1, active: 1 }, name: 'checkin_assignments_relationship_active' },
      {
        key: { workspaceId: 1, relationshipId: 1, active: 1, _id: 1 },
        name: 'checkin_assignments_workspace_relationship_active',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, templateId: 1 },
        unique: true,
        partialFilterExpression: { active: true },
        name: 'checkin_assignments_active_template_unique',
      },
    ]);

    await db.collection('checkin_instances').createIndexes([
      { key: { relationshipId: 1, dueAt: 1 }, name: 'checkin_instances_relationship_due' },
      { key: { workspaceId: 1, status: 1, dueAt: 1 }, name: 'checkin_instances_status_due' },
      {
        key: { assignmentId: 1, periodKey: 1 },
        unique: true,
        name: 'checkin_instances_assignment_period_unique',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, dueAt: -1, _id: -1 },
        name: 'checkin_instances_relationship_history',
      },
      { key: { status: 1, opensAt: 1, _id: 1 }, name: 'checkin_instances_due_promotion' },
    ]);

    const now = new Date();
    for (const definition of permissionDefinitions.filter((item) =>
      stage12PermissionKeys.has(item.key),
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
      if (profile.context !== 'WORKSPACE') continue;
      const permissions = profile.permissions.filter((permission) =>
        stage12PermissionKeys.has(permission.permission),
      );
      if (permissions.length === 0) continue;
      for (const workspace of workspaceIds) {
        await db.collection('permission_profiles').updateOne(
          {
            context: profile.context,
            workspaceId: workspace._id,
            roleKey: profile.roleKey,
            isSystemDefault: true,
          },
          {
            $set: { name: profile.name, status: 'ACTIVE', updatedAt: now },
            $addToSet: { permissions: { $each: permissions } },
          },
        );
      }
    }
  },
};
