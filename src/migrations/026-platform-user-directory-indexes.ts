import type { Migration } from './migration.types';

export const migration026PlatformUserDirectoryIndexes: Migration = {
  id: '026-platform-user-directory-indexes',
  description: 'Add ordered Platform membership status directory index',
  async up(db) {
    await db
      .collection('platform_memberships')
      .createIndex({ status: 1, _id: -1 }, { name: 'platform_memberships_status_id' });
  },
};
