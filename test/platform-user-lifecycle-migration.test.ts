import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { migrations } from '../src/migrations';
import { migration027PlatformUserLifecycleManagement } from '../src/migrations/027-platform-user-lifecycle-management';
import { managementPermissions } from '../src/modules/platform/platform-authority.guard';
import { type SummaryHarness, summaryHarness } from './platform-workspace-summary.helpers';

let h: SummaryHarness;
beforeAll(async () => {
  h = await summaryHarness('platform_lifecycle_migration');
}, 30_000);
afterEach(async () => {
  if (h) await h.clear();
}, 30_000);
afterAll(async () => {
  if (h) await h.close();
}, 30_000);

async function recovery(version?: number) {
  const userId = new ObjectId();
  const profileId = new ObjectId();
  await h.db.collection('users').insertOne({ _id: userId, status: 'ACTIVE' });
  await h.db.collection('permission_profiles').insertOne({
    _id: profileId,
    name: `Recovery ${profileId}`,
    context: 'PLATFORM',
    status: 'ACTIVE',
    permissions: managementPermissions.map((permission) => ({ permission, effect: 'ALLOW' })),
  });
  const membership = {
    _id: new ObjectId(),
    userId,
    status: 'ACTIVE',
    permissionProfileIds: [profileId],
    accessVersion: 42,
    sentinel: 'preserve',
    ...(version === undefined ? {} : { version }),
  };
  await h.db.collection('platform_memberships').insertOne(membership);
  return membership;
}

test('027 is last, backfills only missing revisions and initializes a stable rerunnable guard', async () => {
  expect(migrations).toHaveLength(27);
  expect(migrations.at(-1)).toBe(migration027PlatformUserLifecycleManagement);
  const missing = await recovery();
  const existing = await recovery(7);
  await migration027PlatformUserLifecycleManagement.up(h.db);
  await migration027PlatformUserLifecycleManagement.up(h.db);
  expect(await h.db.collection('platform_memberships').findOne({ _id: missing._id })).toEqual({
    ...missing,
    version: 0,
  });
  expect(await h.db.collection('platform_memberships').findOne({ _id: existing._id })).toEqual(
    existing,
  );
  expect(
    await h.db
      .collection<{ _id: string; revision: number }>('platform_authority_guards')
      .findOne({}),
  ).toEqual({
    _id: 'management-authority',
    revision: 0,
  });
});

test('027 rejects invalid revisions without replacing them', async () => {
  const member = await recovery(0);
  for (const version of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
    await h.db
      .collection('platform_memberships')
      .updateOne({ _id: member._id }, { $set: { version } });
    await expect(migration027PlatformUserLifecycleManagement.up(h.db)).rejects.toThrow(
      'Invalid Platform membership version',
    );
    expect(
      (await h.db.collection('platform_memberships').findOne({ _id: member._id }))?.version,
    ).toBe(version);
  }
});

test('027 surfaces pre-existing depletion without inventing an administrator', async () => {
  await h.db
    .collection('platform_memberships')
    .insertOne({ userId: new ObjectId(), status: 'ENDED', permissionProfileIds: [] });
  await expect(migration027PlatformUserLifecycleManagement.up(h.db)).rejects.toMatchObject({
    code: 'PLATFORM_LAST_MANAGEMENT_AUTHORITY_REQUIRED',
  });
  expect(await h.db.collection('users').countDocuments()).toBe(0);
  expect(await h.db.collection('platform_authority_guards').countDocuments()).toBe(0);
});

test('empty database is explicitly unprovisioned; new memberships initialize version zero', async () => {
  await migration027PlatformUserLifecycleManagement.up(h.db);
  const member = await h.container.platformMemberships.createActive(new ObjectId());
  expect(member.version).toBe(0);
  expect(member.accessVersion).toBe(0);
});
