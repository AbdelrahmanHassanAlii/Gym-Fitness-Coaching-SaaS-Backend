import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

const stage16PermissionKeys = new Set([
  'support.policies.read',
  'support.policies.create',
  'support.policies.update',
  'support.policies.disable',
  'support.policies.archive',
  'support.sessions.read',
  'support.sessions.start',
  'support.sessions.end_own',
  'support.sessions.revoke',
  'support.sensitive.read',
  'support.sensitive_files.read',
]);

export const migration021Stage16SupportAccess: Migration = {
  id: '021-stage16-support-access',
  description: 'Add Stage 16 support access collections, indexes, and permission seeds',
  async up(db) {
    await db.collection('portal_access_policies').createIndexes([
      {
        key: { platformMembershipId: 1, enabled: 1, archivedAt: 1 },
        name: 'portal_access_policies_owner_enabled_archive',
      },
      {
        key: { validFrom: 1, validUntil: 1 },
        name: 'portal_access_policies_validity',
      },
    ]);

    await db.collection('support_access_requests').createIndexes([
      {
        key: { requestedByPlatformMembershipId: 1, createdAt: -1, _id: -1 },
        name: 'support_access_requests_requester_created',
      },
      {
        key: { targetWorkspaceId: 1, createdAt: -1, _id: -1 },
        name: 'support_access_requests_workspace_created',
      },
    ]);

    await db.collection('support_sessions').createIndexes([
      {
        key: { realActorPlatformMembershipId: 1, status: 1, startedAt: -1 },
        name: 'support_sessions_actor_status',
      },
      { key: { policyId: 1, status: 1 }, name: 'support_sessions_policy_status' },
      {
        key: { targetWorkspaceId: 1, status: 1, startedAt: -1 },
        name: 'support_sessions_workspace_status',
      },
      {
        key: { parentAuthSessionId: 1, status: 1 },
        name: 'support_sessions_parent_auth_status',
      },
      { key: { status: 1, expiresAt: 1, _id: 1 }, name: 'support_sessions_status_expiry' },
    ]);

    const now = new Date();
    for (const definition of permissionDefinitions.filter((item) =>
      stage16PermissionKeys.has(item.key),
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

    for (const profile of systemPermissionProfiles.filter((item) => item.context === 'PLATFORM')) {
      const permissions = profile.permissions.filter((permission) =>
        stage16PermissionKeys.has(permission.permission),
      );
      if (permissions.length === 0) continue;
      await db.collection('permission_profiles').updateOne(
        {
          context: profile.context,
          roleKey: profile.roleKey,
          isSystemDefault: true,
        },
        {
          $set: { name: profile.name, status: 'ACTIVE', updatedAt: now },
          $addToSet: { permissions: { $each: permissions } },
        },
      );
    }
  },
};
