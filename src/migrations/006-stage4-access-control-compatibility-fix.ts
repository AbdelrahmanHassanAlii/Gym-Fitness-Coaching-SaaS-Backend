import { ObjectId } from 'mongodb';
import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

export const migration006Stage4AccessControlCompatibilityFix: Migration = {
  id: '006-stage4-access-control-compatibility-fix',
  description: 'Prevent unsafe Stage 4 Platform Super Admin compatibility assignments',
  async up(db) {
    const now = new Date();
    const knownKeys = permissionDefinitions.map((definition) => definition.key);
    for (const definition of permissionDefinitions) {
      await db.collection('permission_definitions').updateOne(
        { key: definition.key },
        {
          $set: { ...definition, state: 'ACTIVE', updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
    }
    await db
      .collection('permission_definitions')
      .updateMany(
        { key: { $nin: knownKeys }, state: 'ACTIVE' },
        { $set: { state: 'DEPRECATED', deprecatedAt: now, updatedAt: now } },
      );

    const workspaceIds = await db
      .collection('workspaces')
      .find({}, { projection: { _id: 1 } })
      .toArray();
    for (const profile of systemPermissionProfiles) {
      const profileTargets =
        profile.context === 'WORKSPACE'
          ? workspaceIds.map((workspace) => ({ workspaceId: workspace._id }))
          : [{ workspaceId: undefined }];
      for (const target of profileTargets) {
        const workspaceId = target.workspaceId;
        await db.collection('permission_profiles').updateOne(
          {
            context: profile.context,
            ...(workspaceId ? { workspaceId } : {}),
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
              ...(workspaceId ? { workspaceId } : {}),
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

    const superAdminProfile = await db.collection('permission_profiles').findOne({
      context: 'PLATFORM',
      roleKey: 'PLATFORM_SUPER_ADMIN',
      isSystemDefault: true,
      status: 'ACTIVE',
    });
    if (!superAdminProfile?._id) return;

    const ambiguousMemberships = await db
      .collection('platform_memberships')
      .find(
        {
          status: 'ACTIVE',
          permissionProfileIds: superAdminProfile._id,
        },
        { projection: { _id: 1, userId: 1, permissionProfileIds: 1 } },
      )
      .toArray();

    if (ambiguousMemberships.length === 0) return;

    await db.collection('migration_operator_reviews').insertMany(
      ambiguousMemberships.map((membership) => ({
        _id: new ObjectId(),
        migrationId: '006-stage4-access-control-compatibility-fix',
        issue: 'AMBIGUOUS_PLATFORM_SUPER_ADMIN_ASSIGNMENT',
        platformMembershipId: membership._id,
        userId: membership.userId,
        profileId: superAdminProfile._id,
        message:
          'This Platform Super Admin profile assignment may have been introduced by migration 005 and must be reviewed before migration 006 can proceed.',
        createdAt: now,
      })),
      { ordered: false },
    );

    throw new Error(
      `Migration 006 found ${ambiguousMemberships.length} ambiguous Platform Super Admin assignment(s). Review migration_operator_reviews before proceeding.`,
    );
  },
};
