import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

const stage9PermissionKeys = new Set([
  'workouts.read',
  'workouts.create',
  'workouts.update',
  'workouts.complete',
  'workouts.abandon',
  'workouts.correct',
  'workouts.day.skip',
  'workouts.day.defer',
  'personal_records.read',
]);

export const migration014Stage9WorkoutExecution: Migration = {
  id: '014-stage9-workout-execution',
  description: 'Create Stage 9 workout execution collections, indexes, and permission seeds',
  async up(db) {
    await db.collection('workout_sessions').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, status: 1, _id: 1 },
        name: 'workout_sessions_relationship_status',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, _id: 1 },
        name: 'workout_sessions_relationship_history',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, programId: 1, _id: 1 },
        name: 'workout_sessions_program_history',
      },
      {
        key: { workspaceId: 1, relationshipId: 1 },
        unique: true,
        partialFilterExpression: { status: 'IN_PROGRESS' },
        name: 'workout_sessions_one_in_progress_per_relationship',
      },
    ]);

    await db.collection('personal_records').createIndexes([
      {
        key: {
          workspaceId: 1,
          relationshipId: 1,
          exerciseId: 1,
          recordType: 1,
          qualifierKey: 1,
        },
        unique: true,
        name: 'personal_records_projection_unique',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, exerciseId: 1, _id: 1 },
        name: 'personal_records_relationship_exercise',
      },
    ]);

    await db.collection('personal_record_events').createIndexes([
      {
        key: { workspaceId: 1, relationshipId: 1, occurredAt: 1, _id: 1 },
        name: 'personal_record_events_relationship_order',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, exerciseId: 1, occurredAt: 1, _id: 1 },
        name: 'personal_record_events_exercise_order',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, sourceWorkoutId: 1 },
        name: 'personal_record_events_source_workout',
      },
    ]);

    const now = new Date();
    for (const definition of permissionDefinitions.filter((item) =>
      stage9PermissionKeys.has(item.key),
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
        stage9PermissionKeys.has(permission.permission),
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
