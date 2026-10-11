import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { Permissions, permissionDefinitions } from '../src/modules/permissions/permission.registry';
import type { PlatformMembershipDocument } from '../src/modules/platform/platform.types';
import {
  assertAssignedMembershipRevisionCapacity,
  assertPlatformRecoveryAuthority,
  PLATFORM_AUTHORITY_SCAN_LIMIT as limit,
} from '../src/modules/platform/platform-authority.guard';
import { type SummaryHarness, summaryHarness } from './platform-workspace-summary.helpers';

let h: SummaryHarness;
beforeAll(async () => {
  h = await summaryHarness('platform_authority_bounds');
}, 30_000);
afterEach(async () => {
  await h.clear();
}, 30_000);
afterAll(async () => {
  if (h) await h.close();
}, 30_000);

const boundError = {
  code: 'PLATFORM_AUTHORITY_EVALUATION_LIMIT_EXCEEDED',
  httpStatus: 409,
};

async function operator() {
  if ((await h.db.collection('permission_definitions').countDocuments()) === 0)
    await h.db
      .collection('permission_definitions')
      .insertMany(permissionDefinitions.map((definition) => ({ ...definition, state: 'ACTIVE' })));
  const actor = await h.actor(Permissions.PlatformMembershipsManage);
  const member = await h.container.platformMemberships.findByUserId(actor.userId);
  if (!member) throw new Error('Missing fixture membership');
  const profileId = member.permissionProfileIds[0];
  if (!profileId) throw new Error('Missing fixture profile');
  await h.db.collection('permission_profiles').updateOne(
    { _id: profileId },
    {
      $set: {
        version: 0,
        permissions: [
          { permission: Permissions.PlatformMembershipsManage, effect: 'ALLOW' },
          { permission: Permissions.PlatformPermissionsManage, effect: 'ALLOW' },
        ],
      },
    },
  );
  await h.db
    .collection('platform_memberships')
    .updateOne({ _id: member._id }, { $set: { version: 0 } });
  return { ...actor, membershipId: member._id, profileId };
}

function membership(status = 'ACTIVE', permissionProfileIds: ObjectId[] = []) {
  return {
    _id: new ObjectId(),
    userId: new ObjectId(),
    status,
    permissionProfileIds,
    version: 0,
    accessVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function state(actor: { token: string; userId: ObjectId }) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/platform/users/${actor.userId}/management-state`,
    headers: { authorization: `Bearer ${actor.token}` },
  });
}

function expectBoundResponse(response: { statusCode: number; json<T>(): T }) {
  expect(response.statusCode).toBe(409);
  expect(response.json<{ error: { code: string } }>().error.code).toBe(boundError.code);
}

test('actor assigned-profile inputs accept the boundary and reject one extra before target lookup', async () => {
  const actor = await operator();
  const profiles = Array.from({ length: limit - 1 }, () => ({
    _id: new ObjectId(),
    context: 'PLATFORM',
    status: 'ACTIVE',
    name: `Bounds ${new ObjectId()}`,
    permissions: [],
  }));
  await h.db.collection('permission_profiles').insertMany(profiles);
  const ids = [actor.profileId, ...profiles.map((profile) => profile._id)];
  await h.db
    .collection('platform_memberships')
    .updateOne({ _id: actor.membershipId }, { $set: { permissionProfileIds: ids } });
  expect((await state(actor)).statusCode).toBe(200);
  await assertPlatformRecoveryAuthority(h.db);
  await h.db
    .collection('platform_memberships')
    .updateOne(
      { _id: actor.membershipId },
      { $set: { permissionProfileIds: [...ids, new ObjectId()] } },
    );
  expectBoundResponse(await state(actor));
}, 30_000);

test('actor retrieved grants accept the boundary and reject one extra', async () => {
  const actor = await operator();
  const grant = {
    subjectId: actor.membershipId,
    subjectType: 'PLATFORM_MEMBERSHIP',
    context: 'PLATFORM',
    permission: Permissions.PlatformMembershipsRead,
    effect: 'ALLOW',
  };
  // Distinct stored resource scopes are ineligible for this Platform permission.
  // Retrieval must still be bounded before applicability is evaluated.
  const storedGrant = () => ({
    ...grant,
    scope: { type: 'SPECIFIC_TRAINEES', resourceIds: [new ObjectId()] },
  });
  await h.db.collection('access_grants').insertMany(Array.from({ length: limit }, storedGrant));
  expect((await state(actor)).statusCode).toBe(200);
  await h.db.collection('access_grants').insertOne(storedGrant());
  expectBoundResponse(await state(actor));
}, 30_000);

test('recovery membership scan accepts the boundary and rejects one extra ACTIVE membership', async () => {
  await operator();
  await h.db
    .collection('platform_memberships')
    .insertMany(Array.from({ length: limit - 1 }, () => membership()));
  await assertPlatformRecoveryAuthority(h.db);
  await h.db.collection('platform_memberships').insertOne(membership());
  await expect(assertPlatformRecoveryAuthority(h.db)).rejects.toMatchObject(boundError);
}, 30_000);

test('recovery counts aggregate profile references even when memberships share a profile', async () => {
  const actor = await operator();
  await h.db
    .collection('platform_memberships')
    .insertMany(Array.from({ length: limit - 1 }, () => membership('ACTIVE', [actor.profileId])));
  await assertPlatformRecoveryAuthority(h.db);
  // The membership count stays at the boundary; aggregate references alone exceed it.
  await h.db
    .collection<PlatformMembershipDocument>('platform_memberships')
    .updateOne({ _id: actor.membershipId }, { $push: { permissionProfileIds: new ObjectId() } });
  await expect(assertPlatformRecoveryAuthority(h.db)).rejects.toMatchObject(boundError);
}, 30_000);

test('recovery retrieved management grants accept the boundary and reject one extra', async () => {
  const actor = await operator();
  const subjects = Array.from({ length: limit / 2 }, () => membership());
  await h.db.collection('platform_memberships').insertMany(subjects);
  const grant = {
    subjectType: 'PLATFORM_MEMBERSHIP',
    context: 'PLATFORM',
    permission: Permissions.PlatformMembershipsManage,
    effect: 'ALLOW',
    scope: { type: 'WORKSPACE' },
    expiresAt: new Date(0),
  };
  await h.db
    .collection('access_grants')
    .insertMany(
      subjects.flatMap((subject) =>
        [Permissions.PlatformMembershipsManage, Permissions.PlatformPermissionsManage].map(
          (permission) => ({ ...grant, subjectId: subject._id, permission }),
        ),
      ),
    );
  await assertPlatformRecoveryAuthority(h.db);
  await h.db.collection('access_grants').insertOne({ ...grant, subjectId: actor.membershipId });
  await expect(assertPlatformRecoveryAuthority(h.db)).rejects.toMatchObject(boundError);
}, 30_000);

test('profile propagation accepts its affected-membership boundary and rejects one extra inactive assignment', async () => {
  const profileId = new ObjectId();
  await h.db
    .collection('platform_memberships')
    .insertMany(Array.from({ length: limit }, () => membership('ENDED', [profileId])));
  await assertAssignedMembershipRevisionCapacity(h.db, profileId);
  await h.db.collection('platform_memberships').insertOne(membership('ENDED', [profileId]));
  await expect(assertAssignedMembershipRevisionCapacity(h.db, profileId)).rejects.toMatchObject(
    boundError,
  );
}, 30_000);

test('pre-commit recovery bound failure rolls back lifecycle state, both revisions, guard, events and completion', async () => {
  const actor = await operator();
  const target = await h.actor(Permissions.PlatformMembershipsRead, {
    membershipStatus: 'SUSPENDED',
  });
  await h.db
    .collection('platform_memberships')
    .updateOne(
      { userId: target.userId },
      { $set: { version: 0, suspendedAt: new Date('2026-01-01') } },
    );
  await h.db
    .collection('platform_memberships')
    .insertMany(Array.from({ length: limit - 1 }, () => membership()));
  const guards = h.db.collection<{ _id: string; revision: number }>('platform_authority_guards');
  await guards.insertOne({ _id: 'management-authority', revision: 7 });
  const before = await h.db.collection('platform_memberships').findOne({ userId: target.userId });
  const guardBefore = await guards.findOne({});
  const response = await h.app.inject({
    method: 'POST',
    url: `/api/v1/platform/users/${target.userId}/reactivate`,
    headers: { authorization: `Bearer ${actor.token}`, 'idempotency-key': 'bound-rollback' },
    payload: { expectedVersion: 0 },
  });
  expectBoundResponse(response);
  expect(await h.db.collection('platform_memberships').findOne({ userId: target.userId })).toEqual(
    before,
  );
  expect(await guards.findOne({})).toEqual(guardBefore);
  expect(await h.db.collection('audit_events').countDocuments()).toBe(0);
  expect(await h.db.collection('outbox_events').countDocuments()).toBe(0);
  expect(await h.db.collection('idempotency_records').countDocuments({ state: 'COMPLETED' })).toBe(
    0,
  );
  expect(
    await h.db.collection('idempotency_records').findOne({ key: 'bound-rollback' }),
  ).toMatchObject({ state: 'FAILED' });
}, 30_000);

for (const command of ['update', 'archive'] as const) {
  test(`profile ${command} affected-membership bound failure rolls back profile, every revision, guard and events`, async () => {
    const actor = await operator();
    const profile = await h.container.permissionProfiles.create({
      context: 'PLATFORM',
      name: 'Bounded assigned profile',
      permissions: [],
    });
    await h.db
      .collection('platform_memberships')
      .insertMany(Array.from({ length: limit + 1 }, () => membership('ENDED', [profile._id])));
    const guards = h.db.collection<{ _id: string; revision: number }>('platform_authority_guards');
    await guards.insertOne({ _id: 'management-authority', revision: 9 });
    const beforeMembers = await h.db
      .collection('platform_memberships')
      .find({ permissionProfileIds: profile._id })
      .sort({ _id: 1 })
      .toArray();
    const response = await h.app.inject({
      method: command === 'update' ? 'PATCH' : 'POST',
      url: `/api/v1/platform/permission-profiles/${profile._id}${command === 'archive' ? '/archive' : ''}`,
      headers: { authorization: `Bearer ${actor.token}` },
      payload: {
        expectedVersion: 0,
        ...(command === 'update'
          ? {
              permissions: [{ permission: Permissions.PlatformMembershipsManage, effect: 'ALLOW' }],
            }
          : {}),
      },
    });
    expectBoundResponse(response);
    expect(await h.container.permissionProfiles.findById(profile._id)).toEqual(profile);
    expect(
      await h.db
        .collection('platform_memberships')
        .find({ permissionProfileIds: profile._id })
        .sort({ _id: 1 })
        .toArray(),
    ).toEqual(beforeMembers);
    expect(await guards.findOne({})).toEqual({ _id: 'management-authority', revision: 9 });
    expect(await h.db.collection('audit_events').countDocuments()).toBe(0);
    expect(await h.db.collection('outbox_events').countDocuments()).toBe(0);
  }, 30_000);
}
