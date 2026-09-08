import type { Migration } from './migration.types';

export const migration004Stage3WorkspacesIndexes: Migration = {
  id: '004-stage3-workspaces-indexes',
  description: 'Create Stage 3 Platform, workspace, branch and invitation indexes',
  async up(db) {
    await db.collection('platform_memberships').createIndexes([
      {
        key: { userId: 1 },
        unique: true,
        name: 'platform_memberships_user_unique',
      },
      { key: { status: 1 }, name: 'platform_memberships_status' },
    ]);

    await db.collection('workspaces').createIndexes([
      { key: { status: 1, createdAt: -1 }, name: 'workspaces_status_created' },
      { key: { ownerUserId: 1, status: 1 }, name: 'workspaces_owner_status' },
    ]);

    await db.collection('workspace_memberships').createIndexes([
      {
        key: { workspaceId: 1, userId: 1 },
        unique: true,
        name: 'workspace_memberships_workspace_user_unique',
      },
      { key: { userId: 1, status: 1 }, name: 'workspace_memberships_user_status' },
      { key: { workspaceId: 1, status: 1 }, name: 'workspace_memberships_workspace_status' },
    ]);

    await db.collection('branches').createIndexes([
      { key: { workspaceId: 1, status: 1 }, name: 'branches_workspace_status' },
      {
        key: { workspaceId: 1, code: 1 },
        unique: true,
        partialFilterExpression: { code: { $type: 'string' } },
        name: 'branches_workspace_code_unique',
      },
    ]);

    await db.collection('membership_branch_assignments').createIndexes([
      {
        key: { workspaceId: 1, membershipId: 1, branchId: 1 },
        unique: true,
        partialFilterExpression: { active: true },
        name: 'membership_branch_assignments_active_unique',
      },
      {
        key: { workspaceId: 1, membershipId: 1, active: 1 },
        name: 'membership_branch_assignments_membership_active',
      },
      {
        key: { workspaceId: 1, branchId: 1, active: 1 },
        name: 'membership_branch_assignments_branch_active',
      },
    ]);

    await db.collection('invitations').createIndexes([
      {
        key: { tokenDigest: 1 },
        unique: true,
        name: 'invitations_token_digest_unique',
      },
      {
        key: { workspaceId: 1, normalizedEmail: 1 },
        unique: true,
        partialFilterExpression: {
          status: 'PENDING',
          normalizedEmail: { $type: 'string' },
        },
        name: 'invitations_pending_workspace_email_unique',
      },
      {
        key: { workspaceId: 1, normalizedPhone: 1 },
        unique: true,
        partialFilterExpression: {
          status: 'PENDING',
          normalizedPhone: { $type: 'string' },
        },
        name: 'invitations_pending_workspace_phone_unique',
      },
      { key: { workspaceId: 1, status: 1, expiresAt: 1 }, name: 'invitations_workspace_status' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'invitations_expiry_ttl' },
    ]);
  },
};
