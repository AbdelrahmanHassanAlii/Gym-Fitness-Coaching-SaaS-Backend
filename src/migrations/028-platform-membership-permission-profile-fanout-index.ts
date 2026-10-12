import type { Migration } from './migration.types';

export const migration028PlatformMembershipPermissionProfileFanoutIndex: Migration = {
  id: '028-platform-membership-permission-profile-fanout-index',
  description: 'Index assigned Platform permission profiles across all membership statuses',
  async up(db) {
    await db
      .collection('platform_memberships')
      .createIndex(
        { permissionProfileIds: 1 },
        { name: 'platform_memberships_permission_profile_ids' },
      );
  },
};
