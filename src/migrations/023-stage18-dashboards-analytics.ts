import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

const stage18PermissionKeys = new Set([
  'dashboard.trainer.read',
  'dashboard.gym.read',
  'dashboard.relationship.read',
  'analytics.training.read',
  'analytics.progress.read',
  'analytics.nutrition.read',
  'analytics.adherence.read',
]);

export const migration023Stage18DashboardsAnalytics: Migration = {
  id: '023-stage18-dashboards-analytics',
  description: 'Add Stage 18 dashboard analytics permissions and query indexes',
  async up(db) {
    await db.collection('coaching_relationships').createIndexes([
      {
        key: { workspaceId: 1, status: 1, homeBranchId: 1, _id: 1 },
        name: 'relationships_dashboard_scope',
      },
      {
        key: { workspaceId: 1, traineeUserId: 1, status: 1 },
        name: 'relationships_self_dashboard',
      },
    ]);
    await db
      .collection('branches')
      .createIndexes([
        { key: { workspaceId: 1, status: 1, name: 1, _id: 1 }, name: 'branches_dashboard_page' },
      ]);
    await db.collection('workspace_memberships').createIndexes([
      {
        key: { workspaceId: 1, status: 1, roles: 1 },
        name: 'memberships_active_staff_dashboard',
      },
    ]);
    await db.collection('trainee_staff_assignments').createIndexes([
      {
        key: { workspaceId: 1, staffMembershipId: 1, assignmentType: 1, active: 1, startedAt: -1 },
        name: 'assignments_staff_dashboard',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, active: 1, assignmentType: 1 },
        name: 'assignments_relationship_active',
      },
    ]);
    await db.collection('workout_sessions').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, status: 1, completedAt: -1, _id: -1 },
        name: 'workouts_relationship_completed_window',
      },
      {
        key: { workspaceId: 1, completedAt: -1, _id: -1 },
        partialFilterExpression: { status: 'COMPLETED' },
        name: 'workouts_recent_completed_activity',
      },
    ]);
    await db.collection('program_progress_events').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, occurredAt: 1, type: 1 },
        name: 'program_progress_relationship_window',
      },
    ]);
    await db.collection('nutrition_plans').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, status: 1 },
        name: 'nutrition_plans_active_relationship_dashboard',
      },
    ]);
    await db.collection('checkin_instances').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, status: 1, dueAt: 1, _id: 1 },
        name: 'checkins_attention_status',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, dueAt: 1, status: 1 },
        name: 'checkins_compliance_window',
      },
      {
        key: { workspaceId: 1, status: 1, submittedAt: -1, _id: -1 },
        name: 'checkins_recent_submitted_activity',
      },
    ]);
    await db.collection('documents').createIndexes([
      {
        key: { workspaceId: 1, category: 1, status: 1, createdAt: -1, _id: -1 },
        name: 'documents_recent_inbody_activity',
      },
    ]);
    await db.collection('personal_record_events').createIndexes([
      {
        key: { workspaceId: 1, eventType: 1, occurredAt: -1, _id: -1 },
        name: 'personal_records_recent_activity',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, eventType: 1, occurredAt: -1, _id: -1 },
        name: 'personal_records_relationship_window',
      },
    ]);
    await db.collection('measurement_entries').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, metricDefinitionId: 1, measuredAt: 1, _id: 1 },
        name: 'measurements_relationship_metric_window',
      },
    ]);
    const now = new Date();
    for (const definition of permissionDefinitions.filter((item) =>
      stage18PermissionKeys.has(item.key),
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
      const permissions = profile.permissions.filter((permission) =>
        stage18PermissionKeys.has(permission.permission),
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
