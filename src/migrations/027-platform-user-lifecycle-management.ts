import {
  assertPlatformRecoveryAuthority,
  PLATFORM_AUTHORITY_GUARD_ID,
} from '../modules/platform/platform-authority.guard';
import type { Migration } from './migration.types';

export const migration027PlatformUserLifecycleManagement: Migration = {
  id: '027-platform-user-lifecycle-management',
  description:
    'Backfill Platform membership management revision and verify durable recovery authority',
  async up(db) {
    const memberships = db.collection('platform_memberships');
    // Validate before backfill; never overwrite malformed existing revisions.
    const cursor = memberships
      .find({ version: { $exists: true } }, { projection: { _id: 1, version: 1 } })
      .batchSize(250);
    for await (const member of cursor) {
      if (!Number.isSafeInteger(member.version) || member.version < 0)
        throw new Error(`Invalid Platform membership version: ${String(member._id)}.`);
    }
    if (await memberships.findOne({}, { projection: { _id: 1 } }))
      await assertPlatformRecoveryAuthority(db);
    // Empty databases are explicitly unprovisioned; bootstrap must establish both authorities.
    await memberships.updateMany({ version: { $exists: false } }, { $set: { version: 0 } });
    await db
      .collection<{ _id: string; revision: number }>('platform_authority_guards')
      .updateOne(
        { _id: PLATFORM_AUTHORITY_GUARD_ID },
        { $setOnInsert: { revision: 0 } },
        { upsert: true },
      );
  },
};
