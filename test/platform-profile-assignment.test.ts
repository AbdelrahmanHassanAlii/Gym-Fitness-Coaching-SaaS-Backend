import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Collection, MongoServerError, ObjectId } from 'mongodb';
import { fingerprint } from '../src/core/idempotency/idempotency.service';
import { Permissions, permissionDefinitions } from '../src/modules/permissions/permission.registry';
import { isPlatformAssignmentFact } from '../src/modules/platform/platform-assignment.fact';
import { PlatformDelegation } from '../src/modules/platform/platform-delegation';
import {
  AssignmentBody,
  AssignmentResponse,
  SelectorResponse,
} from '../src/modules/platform-users/platform-profile-assignment.schemas';
import { type SummaryHarness, summaryHarness } from './platform-workspace-summary.helpers';

let h: SummaryHarness;
beforeAll(async () => {
  h = await summaryHarness('platform_profile_assignment');
  await h.clear();
}, 30_000);
beforeEach(async () => {
  await h.db.collection('permission_definitions').insertMany(
    permissionDefinitions.map((d) => ({
      ...d,
      state: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
});
afterEach(async () => {
  await h.clear();
}, 30_000);
afterAll(async () => {
  await h.close();
}, 30_000);
type Actor = Awaited<ReturnType<SummaryHarness['actor']>>;
const path = (id: ObjectId | string) =>
  `/api/v1/platform/users/${id}/permission-profile-assignment`;
async function member(actor: Actor) {
  return await h.db.collection('platform_memberships').findOne({ userId: actor.userId });
}
async function operator(extra: string[] = []) {
  const actor = await h.actor(Permissions.PlatformPermissionsManage);
  const row = await member(actor);
  await h.db.collection('permission_profiles').updateOne(
    { _id: row?.permissionProfileIds[0] },
    {
      $set: {
        version: 0,
        permissions: [
          Permissions.PlatformPermissionsManage,
          Permissions.PlatformMembershipsManage,
          ...extra,
        ].map((permission) => ({ permission, effect: 'ALLOW' })),
      },
    },
  );
  await h.db
    .collection('platform_memberships')
    .updateOne({ userId: actor.userId }, { $set: { version: 0 } });
  return actor;
}
async function target() {
  const actor = await h.actor(Permissions.PlatformMembershipsRead);
  await h.db
    .collection('platform_memberships')
    .updateOne({ userId: actor.userId }, { $set: { version: 0, accessVersion: 7 } });
  return actor;
}
async function profile(
  permissions: Array<{ permission: string; effect: 'ALLOW' | 'DENY' }> = [],
  fields: Record<string, unknown> = {},
) {
  const id = new ObjectId();
  await h.db.collection('permission_profiles').insertOne({
    _id: id,
    name: `Profile ${id}`,
    context: 'PLATFORM',
    status: 'ACTIVE',
    permissions,
    version: 0,
    isSystemDefault: false,
    ...fields,
  });
  return id;
}
async function put(
  actor: Actor,
  id: ObjectId,
  profileIds: ObjectId[],
  version = 0,
  key = new ObjectId().toHexString(),
) {
  return h.app.inject({
    method: 'PUT',
    url: path(id),
    headers: { authorization: `Bearer ${actor.token}`, 'idempotency-key': key },
    payload: { expectedVersion: version, profileIds: profileIds.map(String) },
  });
}
async function get(actor: Actor, id: ObjectId) {
  return h.app.inject({ url: path(id), headers: { authorization: `Bearer ${actor.token}` } });
}
async function context(actor: Actor) {
  const session = await h.db.collection('auth_sessions').findOne({ userId: actor.userId });
  return {
    userId: String(actor.userId),
    authSessionId: String(session?._id),
    mfaSatisfied: true,
    correlationId: new ObjectId().toHexString(),
    ipAddress: '127.0.0.1',
    locale: 'en',
    timezone: 'UTC',
  };
}
async function grant(
  actor: Actor,
  permission: string,
  effect: 'ALLOW' | 'DENY',
  scope: { type: string; resourceIds?: ObjectId[] } = { type: 'WORKSPACE' },
  expiresAt?: Date,
) {
  const row = await member(actor);
  await h.db.collection('access_grants').insertOne({
    context: 'PLATFORM',
    subjectId: row?._id,
    subjectType: 'PLATFORM_MEMBERSHIP',
    permission,
    effect,
    scope,
    createdBy: new ObjectId(),
    createdAt: new Date(),
    ...(expiresAt ? { expiresAt } : {}),
  });
}
const read = Permissions.PlatformMembershipsRead;
const entry = (effect: 'ALLOW' | 'DENY') => ({ permission: read, effect });

test('strict DTOs, archived/unavailable references, all target states and privacy', async () => {
  const actor = await operator();
  const user = await target();
  const archived = await profile([], { status: 'ARCHIVED' });
  const foreign = await profile([], { context: 'WORKSPACE', name: 'Private foreign name' });
  const missing = new ObjectId();
  await h.db
    .collection('platform_memberships')
    .updateOne(
      { userId: user.userId },
      { $set: { permissionProfileIds: [missing, foreign, archived] } },
    );
  for (const status of ['ACTIVE', 'SUSPENDED', 'ENDED']) {
    await h.db
      .collection('platform_memberships')
      .updateOne({ userId: user.userId }, { $set: { status } });
    const response = await get(actor, user.userId);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const dto = response.json().data;
    expect(Object.keys(dto).sort()).toEqual(['permissionProfiles', 'platformMembership', 'userId']);
    expect(dto.platformMembership).toEqual({
      id: String((await member(user))?._id),
      status,
      version: 0,
    });
    expect(dto.permissionProfiles.map((p: { id: string }) => p.id)).toEqual(
      [String(missing), String(foreign), String(archived)].sort(),
    );
    expect(dto.permissionProfiles.find((p: { id: string }) => p.id === String(foreign))).toEqual({
      id: String(foreign),
      name: null,
      status: 'UNAVAILABLE',
    });
    expect(
      dto.permissionProfiles.find((p: { id: string }) => p.id === String(archived)).status,
    ).toBe('ARCHIVED');
    expect(JSON.stringify(dto)).not.toContain('accessVersion');
    expect(JSON.stringify(dto)).not.toContain('Private foreign');
  }
});

for (const [options, code] of [
  [{ restricted: true }, 'AUTH_SESSION_RESTRICTED'],
  [{ mfa: false }, 'TWO_FACTOR_REQUIRED'],
  [{ membership: false }, 'PLATFORM_MEMBERSHIP_REQUIRED'],
  [{ membershipStatus: 'SUSPENDED' }, 'PLATFORM_MEMBERSHIP_INACTIVE'],
  [{ deny: true }, 'PERMISSION_DENIED'],
] as const) {
  test(`authority denies ${code} before unknown target`, async () => {
    const actor = await h.actor(Permissions.PlatformPermissionsManage, options);
    const response = await get(actor, new ObjectId());
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(code);
  });
}
test('anonymous/revoked/inactive account and users-only/workspace roles have no permission-management authority', async () => {
  expect((await h.app.inject({ url: path(new ObjectId()) })).statusCode).toBe(401);
  for (const permission of [Permissions.PlatformMembershipsManage, read]) {
    const actor = await h.actor(permission);
    expect((await get(actor, new ObjectId())).json().error.code).toBe('PERMISSION_DENIED');
  }
  const gym = await h.actor(read, { membership: false });
  await h.db.collection('workspace_memberships').insertOne({
    userId: gym.userId,
    workspaceId: new ObjectId(),
    roles: ['GYM_OWNER'],
    status: 'ACTIVE',
    permissionProfileIds: [],
  });
  expect((await get(gym, new ObjectId())).json().error.code).toBe('PLATFORM_MEMBERSHIP_REQUIRED');
  const actor = await h.actor(Permissions.PlatformPermissionsManage);
  await h.db
    .collection('users')
    .updateOne({ _id: actor.userId }, { $set: { status: 'SUSPENDED' } });
  expect((await get(actor, new ObjectId())).statusCode).toBe(401);
  await h.db.collection('users').updateOne({ _id: actor.userId }, { $set: { status: 'ACTIVE' } });
  await h.db
    .collection('auth_sessions')
    .updateOne({ userId: actor.userId }, { $set: { status: 'REVOKED' } });
  expect((await get(actor, new ObjectId())).statusCode).toBe(401);
});
test('support header and service context deny all new operations before target lookup', async () => {
  const actor = await operator();
  const ctx = { ...(await context(actor)), supportSessionId: String(new ObjectId()) };
  for (const method of ['GET', 'PUT'] as const) {
    const response = await h.app.inject({
      method,
      url: path(new ObjectId()),
      headers: {
        authorization: `Bearer ${actor.token}`,
        'x-support-session-id': String(new ObjectId()),
      },
      ...(method === 'PUT' ? { payload: { expectedVersion: 0, profileIds: [] } } : {}),
    });
    expect(response.json().error.code).toBe('SUPPORT_ACCESS_FORBIDDEN');
  }
  const response = await h.app.inject({
    url: '/api/v1/platform/permission-profile-selector',
    headers: {
      authorization: `Bearer ${actor.token}`,
      'x-support-session-id': String(new ObjectId()),
    },
  });
  expect(response.json().error.code).toBe('SUPPORT_ACCESS_FORBIDDEN');
  await expect(
    h.container.platformProfileAssignment.state(ctx, String(new ObjectId())),
  ).rejects.toMatchObject({ code: 'SUPPORT_ACCESS_FORBIDDEN' });
  await expect(h.container.platformProfileAssignment.selector(ctx)).rejects.toMatchObject({
    code: 'SUPPORT_ACCESS_FORBIDDEN',
  });
  await expect(
    h.container.unitOfWork.withTransaction((tx) =>
      h.container.platformProfileAssignment.replace(
        ctx,
        String(new ObjectId()),
        { expectedVersion: 0, profileIds: [] },
        tx,
      ),
    ),
  ).rejects.toMatchObject({ code: 'SUPPORT_ACCESS_FORBIDDEN' });
});
test('unknown/nonmember targets, malformed IDs, ACTIVE state and self have deterministic errors', async () => {
  const actor = await operator();
  const user = await target();
  expect((await get(actor, new ObjectId())).json().error.code).toBe('USER_NOT_FOUND');
  const nonmember = await h.actor(read, { membership: false });
  expect((await get(actor, nonmember.userId)).json().error.code).toBe('USER_NOT_FOUND');
  expect(
    (await h.app.inject({ url: path('bad'), headers: { authorization: `Bearer ${actor.token}` } }))
      .statusCode,
  ).toBe(400);
  expect((await put(actor, actor.userId, [])).json().error.code).toBe(
    'PLATFORM_PERMISSION_SELF_MUTATION_FORBIDDEN',
  );
  for (const status of ['SUSPENDED', 'ENDED']) {
    await h.db
      .collection('platform_memberships')
      .updateOne({ userId: user.userId }, { $set: { status } });
    expect((await put(actor, user.userId, [])).json().error.code).toBe(
      'PLATFORM_PERMISSION_TARGET_MEMBERSHIP_INACTIVE',
    );
  }
  await h.db
    .collection('platform_memberships')
    .updateOne({ userId: user.userId }, { $set: { status: 'ACTIVE' } });
  await h.db.collection('users').updateOne({ _id: user.userId }, { $set: { status: 'SUSPENDED' } });
  expect((await put(actor, user.userId, [])).json().error.code).toBe(
    'PLATFORM_MEMBERSHIP_TARGET_ACCOUNT_INACTIVE',
  );
});
test('input boundaries, duplicate rejection, system defaults, missing/archived/foreign profiles', async () => {
  const actor = await operator();
  const user = await target();
  const ids = await Promise.all(Array.from({ length: 21 }, () => profile()));
  const duplicateId = ids[0];
  if (!duplicateId) throw new Error('Missing fixture profile');
  expect((await put(actor, user.userId, ids)).statusCode).toBe(400);
  expect((await put(actor, user.userId, [duplicateId, duplicateId])).json().error.code).toBe(
    'PERMISSION_PROFILE_DUPLICATE',
  );
  for (const id of [
    new ObjectId(),
    await profile([], { status: 'ARCHIVED' }),
    await profile([], { context: 'WORKSPACE' }),
  ])
    expect((await put(actor, user.userId, [id])).json().error.code).toBe(
      'PERMISSION_PROFILE_NOT_FOUND',
    );
  for (const payload of [
    { expectedVersion: '0', profileIds: [] },
    { expectedVersion: -1, profileIds: [] },
    { expectedVersion: 0, profileIds: ['BAD'] },
    { expectedVersion: 0, profileIds: [], extra: true },
  ])
    expect(
      (
        await h.app.inject({
          method: 'PUT',
          url: path(user.userId),
          headers: {
            authorization: `Bearer ${actor.token}`,
            'idempotency-key': String(new ObjectId()),
          },
          payload,
        })
      ).statusCode,
    ).toBe(400);
  const response = await put(actor, user.userId, ids.slice(0, 20).reverse());
  expect(response.statusCode).toBe(200);
  expect(response.json().data.permissionProfiles.map((p: { id: string }) => p.id)).toEqual(
    ids.slice(0, 20).map(String).sort(),
  );
  const system = await profile([], { isSystemDefault: true });
  expect((await put(actor, user.userId, [system], 1)).statusCode).toBe(200);
});
test('selector minimized pagination, name order, limits and system defaults', async () => {
  const actor = await operator();
  await Promise.all(
    Array.from({ length: 105 }, (_, i) =>
      profile([], { name: `A ${String(i).padStart(3, '0')}`, isSystemDefault: i === 0 }),
    ),
  );
  await profile([], { status: 'ARCHIVED', name: 'A archived' });
  await profile([], { context: 'WORKSPACE', name: 'A foreign' });
  const selector = async (query: string) =>
    h.app.inject({
      url: `/api/v1/platform/permission-profile-selector${query}`,
      headers: { authorization: `Bearer ${actor.token}` },
    });
  for (const limit of [1, 50, 100]) {
    const response = await selector(`?limit=${limit}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.permissionProfiles.length).toBe(limit);
    expect(Object.keys(response.json().data.permissionProfiles[0]).sort()).toEqual(['id', 'name']);
    expect(response.headers['cache-control']).toBe('private, no-store');
  }
  expect((await selector('')).json().data.permissionProfiles.length).toBe(50);
  expect((await selector('?limit=101')).statusCode).toBe(400);
  expect((await selector('?cursor=bad')).statusCode).toBe(400);
  const first = (await selector('?limit=100')).json().data;
  const second = (
    await selector(`?limit=100&cursor=${encodeURIComponent(first.nextCursor)}`)
  ).json().data;
  expect(
    new Set(
      [...first.permissionProfiles, ...second.permissionProfiles].map((p: { id: string }) => p.id),
    ).size,
  ).toBe(106);
  expect(second.nextCursor).toBeNull();
  const plan = await h.db
    .collection('permission_profiles')
    .find(
      { context: 'PLATFORM', status: 'ACTIVE', name: { $gt: 'A 050' } },
      { projection: { name: 1 } },
    )
    .sort({ name: 1 })
    .limit(2)
    .explain('executionStats');
  const winning = JSON.stringify(plan.queryPlanner.winningPlan);
  expect(winning).toContain('permission_profiles_platform_name_unique');
  expect(winning).not.toContain('COLLSCAN');
  expect(winning).not.toContain('"stage":"SORT"');
  expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(2);
});
test('changing assignment increments management/access revisions once and writes safe events; canonical replay', async () => {
  const actor = await operator();
  const user = await target();
  const a = await profile();
  const b = await profile();
  const key = String(new ObjectId());
  const response = await put(actor, user.userId, [b, a], 0, key);
  expect(response.statusCode).toBe(200);
  expect((await member(user))?.version).toBe(1);
  expect((await member(user))?.accessVersion).toBe(8);
  expect((await put(actor, user.userId, [a, b], 0, key)).json()).toEqual(response.json());
  expect(
    await h.db
      .collection('audit_events')
      .countDocuments({ eventType: 'MembershipPermissionProfilesReplaced' }),
  ).toBe(1);
  expect(
    await h.db
      .collection('outbox_events')
      .countDocuments({ eventType: 'MembershipPermissionProfilesReplaced' }),
  ).toBe(1);
  expect((await put(actor, user.userId, [a], 0, key)).statusCode).toBe(409);
  expect((await put(actor, user.userId, [a, b], 1, key)).statusCode).toBe(409);
  await h.db
    .collection('users')
    .updateOne({ _id: actor.userId }, { $set: { status: 'SUSPENDED' } });
  expect((await put(actor, user.userId, [a, b], 0, key)).statusCode).toBe(401);
});
test('fresh no-op performs no membership write/revision/event; stale no-op conflicts and empty assignment succeeds', async () => {
  const actor = await operator([read]);
  const user = await target();
  const ids = (await member(user))?.permissionProfileIds;
  const before = await member(user);
  const write = spyOn(Collection.prototype, 'findOneAndUpdate');
  let response: Awaited<ReturnType<typeof put>>;
  try {
    response = await put(actor, user.userId, ids);
    expect(write).not.toHaveBeenCalled();
  } finally {
    write.mockRestore();
  }
  expect(response.statusCode).toBe(200);
  expect(await member(user)).toEqual(before);
  expect(
    await h.db
      .collection('audit_events')
      .countDocuments({ eventType: 'MembershipPermissionProfilesReplaced' }),
  ).toBe(0);
  expect(
    await h.db
      .collection('outbox_events')
      .countDocuments({ eventType: 'MembershipPermissionProfilesReplaced' }),
  ).toBe(0);
  expect(await h.db.collection('idempotency_records').countDocuments({ state: 'COMPLETED' })).toBe(
    1,
  );
  expect((await put(actor, user.userId, ids, 1)).json().error.code).toBe(
    'PLATFORM_MEMBERSHIP_VERSION_CONFLICT',
  );
  expect((await put(actor, user.userId, [])).statusCode).toBe(200);
});
test('missing/blank Idempotency-Key rejected; failed command can recover with the same key', async () => {
  const actor = await operator();
  const user = await target();
  for (const key of [undefined, '   ']) {
    const response = await h.app.inject({
      method: 'PUT',
      url: path(user.userId),
      headers: {
        authorization: `Bearer ${actor.token}`,
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      payload: { expectedVersion: 0, profileIds: [] },
    });
    expect(response.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  }
  const id = new ObjectId();
  const key = String(new ObjectId());
  expect((await put(actor, user.userId, [id], 0, key)).statusCode).toBe(404);
  await h.db.collection('permission_profiles').insertOne({
    _id: id,
    name: 'Recovered',
    context: 'PLATFORM',
    status: 'ACTIVE',
    permissions: [],
  });
  expect((await put(actor, user.userId, [id], 0, key)).statusCode).toBe(200);
});
test('DENY removal requires durable delegation including future target DENY expiry', async () => {
  const actor = await operator();
  const user = await target();
  const deny = await profile([entry('DENY')]);
  const allow = await profile([entry('ALLOW')]);
  await h.db
    .collection('platform_memberships')
    .updateOne({ userId: user.userId }, { $set: { permissionProfileIds: [deny, allow] } });
  expect((await put(actor, user.userId, [allow])).json().error.code).toBe('DELEGATION_DENIED');
  await grant(actor, read, 'ALLOW', { type: 'WORKSPACE' }, new Date(Date.now() + 3_600_000));
  await grant(user, read, 'DENY', { type: 'WORKSPACE' }, new Date(Date.now() + 1_800_000));
  expect((await put(actor, user.userId, [allow])).json().error.code).toBe('DELEGATION_DENIED');
  await h.db.collection('access_grants').deleteMany({ subjectId: (await member(actor))?._id });
  await grant(actor, read, 'ALLOW');
  expect((await put(actor, user.userId, [allow])).statusCode).toBe(200);
});
test('explicit target ALLOW masks existing profile DENY; unexpired/expired grants evaluated', async () => {
  const actor = await operator([read]);
  const user = await target();
  const deny = await profile([entry('DENY')]);
  const allow = await profile([entry('ALLOW')]);
  await h.db
    .collection('platform_memberships')
    .updateOne({ userId: user.userId }, { $set: { permissionProfileIds: [deny, allow] } });
  await grant(user, read, 'ALLOW');
  await grant(user, read, 'DENY', { type: 'SELF' }, new Date(Date.now() - 1000));
  expect((await put(actor, user.userId, [allow])).statusCode).toBe(200);
});
test('scope-complete delegation rejects narrower actor authority and a DENY inside broader ALLOW', async () => {
  const actor = await operator();
  const user = await target();
  const permission = Permissions.AuditSensitiveRead;
  const p = await profile([{ permission, effect: 'ALLOW' }]);
  await grant(actor, permission, 'ALLOW', { type: 'SELF' });
  expect((await put(actor, user.userId, [p])).json().error.code).toBe('DELEGATION_DENIED');
  await grant(actor, permission, 'ALLOW');
  await grant(actor, permission, 'DENY', { type: 'BRANCH', resourceIds: [new ObjectId()] } as {
    type: string;
  });
  expect((await put(actor, user.userId, [p])).json().error.code).toBe('DELEGATION_DENIED');
});
for (const command of ['update', 'archive'] as const)
  test(`legacy profile ${command} cannot expose another profile ALLOW; positive counterpart`, async () => {
    const actor = await operator();
    const user = await target();
    const deny = await profile([entry('DENY')]);
    const allow = await profile([entry('ALLOW')]);
    await h.db
      .collection('platform_memberships')
      .updateOne({ userId: user.userId }, { $set: { permissionProfileIds: [deny, allow] } });
    const ctx = await context(actor);
    const run = () =>
      command === 'update'
        ? h.container.permissions.updateProfile(ctx, String(deny), undefined, {
            expectedVersion: 0,
            permissions: [],
          })
        : h.container.permissions.archiveProfile(ctx, String(deny), undefined, 0);
    await expect(run()).rejects.toMatchObject({ code: 'DELEGATION_DENIED' });
    expect((await member(user))?.version).toBe(0);
    await grant(actor, read, 'ALLOW');
    await run();
    expect((await member(user))?.version).toBe(1);
  });
test('name-only profile edit avoids membership revision churn', async () => {
  const actor = await operator();
  const user = await target();
  const p = await profile();
  await h.db
    .collection('platform_memberships')
    .updateOne({ userId: user.userId }, { $set: { permissionProfileIds: [p] } });
  const before = await member(user);
  await h.container.permissions.updateProfile(await context(actor), String(p), undefined, {
    expectedVersion: 0,
    name: 'Renamed',
  });
  expect(await member(user)).toEqual(before);
});
test('legacy wire still uses accessVersion and rejects self', async () => {
  const actor = await operator();
  const user = await target();
  const m = await member(user);
  const p = await profile();
  const ctx = await context(actor);
  await expect(
    h.container.permissions.replacePlatformMembershipProfiles(
      ctx,
      String((await member(actor))?._id),
      { expectedVersion: 0, profileIds: [] },
    ),
  ).rejects.toMatchObject({ code: 'PLATFORM_PERMISSION_SELF_MUTATION_FORBIDDEN' });
  const result = await h.container.permissions.replacePlatformMembershipProfiles(
    ctx,
    String(m?._id),
    { expectedVersion: 7, profileIds: [String(p)] },
  );
  expect(result).toEqual({
    membershipId: String(m?._id),
    profileIds: [String(p)],
    accessVersion: 8,
  });
  expect((await member(user))?.version).toBe(1);
});
for (const permission of [
  Permissions.PlatformMembershipsManage,
  Permissions.PlatformPermissionsManage,
])
  test(`final durable ${permission} holder protected independently`, async () => {
    const actor = await operator();
    const user = await target();
    const actorMember = await member(actor);
    await h.db.collection('permission_profiles').updateOne(
      { _id: actorMember?.permissionProfileIds[0] },
      {
        $set: {
          permissions: [
            { permission: Permissions.PlatformPermissionsManage, effect: 'ALLOW' },
            ...(permission === Permissions.PlatformPermissionsManage
              ? [{ permission: Permissions.PlatformMembershipsManage, effect: 'ALLOW' }]
              : []),
          ],
        },
      },
    );
    if (permission === Permissions.PlatformPermissionsManage)
      await grant(actor, permission, 'DENY', { type: 'SELF' });
    const p = await profile([{ permission, effect: 'ALLOW' }]);
    await h.db
      .collection('platform_memberships')
      .updateOne({ userId: user.userId }, { $set: { permissionProfileIds: [p] } });
    if (permission === Permissions.PlatformPermissionsManage) {
      await h.db.collection('permission_profiles').updateOne(
        { _id: actorMember?.permissionProfileIds[0] },
        {
          $set: {
            permissions: [{ permission: Permissions.PlatformMembershipsManage, effect: 'ALLOW' }],
          },
        },
      );
      await grant(
        actor,
        permission,
        'ALLOW',
        { type: 'WORKSPACE' },
        new Date(Date.now() + 3_600_000),
      );
    }
    expect((await put(actor, user.userId, [])).json().error.code).toBe(
      'PLATFORM_LAST_MANAGEMENT_AUTHORITY_REQUIRED',
    );
  });
test('same-version concurrent assignment has one winner and one event pair', async () => {
  const actor = await operator();
  const user = await target();
  const a = await profile();
  const b = await profile();
  const results = await Promise.all([put(actor, user.userId, [a]), put(actor, user.userId, [b])]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect((await member(user))?.version).toBe(1);
  expect((await member(user))?.accessVersion).toBe(8);
  expect(
    await h.db
      .collection('outbox_events')
      .countDocuments({ eventType: 'MembershipPermissionProfilesReplaced' }),
  ).toBe(1);
});
for (const command of ['suspend', 'end', 'reactivate'] as const)
  test(`assignment serializes with lifecycle ${command}`, async () => {
    const actor = await operator();
    const user = await target();
    const p = await profile();
    if (command === 'reactivate')
      await h.db
        .collection('platform_memberships')
        .updateOne({ userId: user.userId }, { $set: { status: 'SUSPENDED' } });
    const results = await Promise.all([
      put(actor, user.userId, [p]),
      h.app.inject({
        method: 'POST',
        url: `/api/v1/platform/users/${user.userId}/${command}`,
        headers: {
          authorization: `Bearer ${actor.token}`,
          'idempotency-key': String(new ObjectId()),
        },
        payload: { expectedVersion: 0 },
      }),
    ]);
    expect(results.filter((r) => r.statusCode === 200).length).toBe(1);
    expect((await member(user))?.version).toBe(1);
    expect((await member(user))?.accessVersion).toBe(8);
  });
for (const point of [
  'profiles',
  'delegation',
  'guard',
  'cas',
  'audit',
  'outbox',
  'idempotency',
] as const)
  test(`rollback at ${point} leaves no partial durable change`, async () => {
    const actor = await operator();
    const user = await target();
    const p = await profile();
    const before = await member(user);
    const guardBefore = await h.db.collection('platform_authority_guards').findOne({});
    const spy =
      point === 'profiles'
        ? spyOn(PlatformDelegation.prototype, 'inputs')
        : point === 'delegation'
          ? spyOn(PlatformDelegation.prototype, 'increase')
          : point === 'guard'
            ? spyOn(h.container.platformAuthorityGuard, 'serialize')
            : point === 'cas'
              ? spyOn(Collection.prototype, 'findOneAndUpdate')
              : point === 'audit'
                ? spyOn(h.container.audit, 'write')
                : point === 'outbox'
                  ? spyOn(h.container.outbox, 'write')
                  : spyOn(h.container.idempotency, 'completeWithinTransaction');
    spy.mockImplementation(() => {
      throw new Error('Injected assignment failure');
    });
    try {
      expect((await put(actor, user.userId, [p])).statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await member(user)).toEqual(before);
    expect(await h.db.collection('platform_authority_guards').findOne({})).toEqual(guardBefore);
    expect(
      await h.db
        .collection('audit_events')
        .countDocuments({ eventType: 'MembershipPermissionProfilesReplaced' }),
    ).toBe(0);
    expect(
      await h.db
        .collection('outbox_events')
        .countDocuments({ eventType: 'MembershipPermissionProfilesReplaced' }),
    ).toBe(0);
    expect(
      await h.db.collection('idempotency_records').countDocuments({ state: 'COMPLETED' }),
    ).toBe(0);
  });
test('historical read accepts 10000 without truncation and rejects 10001', async () => {
  const actor = await operator();
  const user = await target();
  const missing = new ObjectId();
  for (const length of [10000, 10001]) {
    await h.db
      .collection('platform_memberships')
      .updateOne(
        { userId: user.userId },
        { $set: { permissionProfileIds: Array.from({ length }, () => missing) } },
      );
    const response = await get(actor, user.userId);
    expect(response.statusCode).toBe(length === 10000 ? 200 : 409);
    if (length === 10000) expect(response.json().data.permissionProfiles.length).toBe(10000);
    else expect(response.json().error.code).toBe('PLATFORM_AUTHORITY_EVALUATION_LIMIT_EXCEEDED');
  }
});
test('OpenAPI is strict and assignment facts are informational but malformed facts fail', async () => {
  await h.app.ready();
  const spec = h.app.swagger();
  const route = spec.paths?.['/api/v1/platform/users/{userId}/permission-profile-assignment'];
  expect(route?.get).toBeDefined();
  expect(route?.put).toBeDefined();
  const actor = await operator();
  const user = await target();
  expect((await put(actor, user.userId, [await profile()])).statusCode).toBe(200);
  const event = await h.db
    .collection('outbox_events')
    .findOne({ eventType: 'MembershipPermissionProfilesReplaced' });
  expect(isPlatformAssignmentFact(event as never)).toBe(true);
  await h.container.notifications.handleOutboxEvent(event as never);
  expect(await h.db.collection('notifications').countDocuments()).toBe(0);
  expect(() => isPlatformAssignmentFact({ ...event, aggregateType: 'bad' } as never)).toThrow();
});

test('assignment and explicit-grant replacement share revision serialization', async () => {
  const actor = await operator([read]);
  const user = await target();
  const row = await member(user);
  const p = await profile();
  const results = await Promise.all([
    put(actor, user.userId, [p]).then((r) => r.statusCode),
    h.container.permissions
      .replacePlatformAccess(await context(actor), String(row?._id), {
        expectedVersion: 7,
        grants: [],
      })
      .then(
        () => 200,
        (error) => error.httpStatus,
      ),
  ]);
  expect(results.sort()).toEqual([200, 409]);
  expect((await member(user))?.version).toBe(1);
  expect((await member(user))?.accessVersion).toBe(8);
});

for (const command of ['update', 'archive'] as const)
  test(`assignment reloads profile after concurrent ${command}`, async () => {
    const actor = await operator();
    const editor = await operator([read]);
    const user = await target();
    const p = await profile();
    const ctx = await context(editor);
    const [assignment, edit] = await Promise.all([
      put(actor, user.userId, [p]),
      command === 'update'
        ? h.container.permissions.updateProfile(ctx, String(p), undefined, {
            expectedVersion: 0,
            permissions: [entry('ALLOW')],
          })
        : h.container.permissions.archiveProfile(ctx, String(p), undefined, 0),
    ]);
    expect(edit.status).toBe(command === 'update' ? 'ACTIVE' : 'ARCHIVED');
    expect([200, command === 'update' ? 403 : 404]).toContain(assignment.statusCode);
    const row = await member(user);
    if (assignment.statusCode === 200) {
      expect(row?.version).toBe(2);
      expect(row?.accessVersion).toBe(9);
    } else {
      expect(row?.version).toBe(0);
      expect(row?.accessVersion).toBe(7);
    }
  });

test('transaction retry reauthorizes actor after authority removal', async () => {
  const actor = await operator();
  await operator();
  const user = await target();
  const p = await profile();
  const row = await member(actor);
  const original = h.container.platformAuthorityGuard.authorize.bind(
    h.container.platformAuthorityGuard,
  );
  let transactionalAttempts = 0;
  const spy = spyOn(h.container.platformAuthorityGuard, 'authorize').mockImplementation(
    async (ctx, permission, tx) => {
      if (tx && ++transactionalAttempts === 1) {
        await h.db
          .collection('permission_profiles')
          .updateOne({ _id: row?.permissionProfileIds[0] }, { $set: { permissions: [] } });
        const error = new MongoServerError({ message: 'retry with changed actor authority' });
        error.addErrorLabel('TransientTransactionError');
        throw error;
      }
      return original(ctx, permission, tx);
    },
  );
  try {
    expect((await put(actor, user.userId, [p])).json().error.code).toBe('PERMISSION_DENIED');
  } finally {
    spy.mockRestore();
  }
  expect(transactionalAttempts).toBeGreaterThanOrEqual(2);
  expect((await member(user))?.version).toBe(0);
  expect(await h.db.collection('outbox_events').countDocuments()).toBe(0);
});

test('concurrent guarded authority removal prevents stale actor assignment', async () => {
  const remover = await operator();
  const actor = await operator();
  const user = await target();
  const p = await profile();
  const before = await member(user);
  const key = new ObjectId().toHexString();
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const removalSerialized = deferred();
  const assignmentContending = deferred();
  const releaseRemoval = deferred();
  const original = Collection.prototype.updateOne;
  let guardAttempts = 0;
  let realConflict = false;
  // Only pause after the real first guard write and observe the competing write.
  // Neither authorization, serialization nor MongoDB retry errors are simulated.
  const spy = spyOn(Collection.prototype, 'updateOne').mockImplementation(async function (
    this: Collection,
    ...args: Parameters<Collection['updateOne']>
  ) {
    if (this.collectionName !== 'platform_authority_guards') return original.apply(this, args);
    const attempt = ++guardAttempts;
    const write = original.apply(this, args);
    if (attempt === 2) assignmentContending.resolve();
    try {
      const result = await write;
      if (attempt === 1) {
        removalSerialized.resolve();
        await releaseRemoval.promise;
      }
      return result;
    } catch (error) {
      if (error instanceof MongoServerError && error.hasErrorLabel('TransientTransactionError'))
        realConflict = true;
      throw error;
    }
  });
  try {
    const removal = put(remover, actor.userId, []);
    await removalSerialized.promise;
    const assignment = put(actor, user.userId, [p], 0, key);
    await assignmentContending.promise;
    releaseRemoval.resolve();
    const [removed, rejected] = await Promise.all([removal, assignment]);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data.permissionProfiles).toEqual([]);
    expect((await member(actor))?.permissionProfileIds).toEqual([]);
    expect(realConflict).toBe(true);
    expect(guardAttempts).toBeGreaterThanOrEqual(3);
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe('PERMISSION_DENIED');
    const after = await member(user);
    expect(after?.permissionProfileIds).toEqual(before?.permissionProfileIds);
    expect(after?.version).toBe(before?.version);
    expect(after?.accessVersion).toBe(before?.accessVersion);
    expect(
      await h.db.collection('audit_events').countDocuments({
        eventType: 'MembershipPermissionProfilesReplaced',
        'entity.id': before?._id,
      }),
    ).toBe(0);
    expect(
      await h.db.collection('outbox_events').countDocuments({
        eventType: 'MembershipPermissionProfilesReplaced',
        aggregateId: before?._id,
      }),
    ).toBe(0);
    expect(await h.db.collection('idempotency_records').findOne({ key })).toMatchObject({
      state: 'FAILED',
    });
  } finally {
    releaseRemoval.resolve();
    spy.mockRestore();
  }
}, 30_000);

test('IN_PROGRESS/stale recovery and post-commit response loss replay preserve one logical event', async () => {
  const actor = await operator();
  const user = await target();
  const p = await profile();
  const key = String(new ObjectId());
  const now = new Date();
  await h.db.collection('idempotency_records').insertOne({
    actorId: String(actor.userId),
    routeKey: `PUT ${path(user.userId)}`,
    key,
    requestHash: fingerprint({
      userId: String(user.userId),
      body: { expectedVersion: 0, profileIds: [String(p)] },
    }),
    state: 'PROCESSING',
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  expect((await put(actor, user.userId, [p], 0, key)).statusCode).toBe(409);
  await h.db
    .collection('idempotency_records')
    .updateOne({ key }, { $set: { updatedAt: new Date(Date.now() - 600_000) } });
  // The caller discards this committed response, then retries the same command.
  expect((await put(actor, user.userId, [p], 0, key)).statusCode).toBe(200);
  expect((await put(actor, user.userId, [p], 0, key)).statusCode).toBe(200);
  expect(await h.db.collection('outbox_events').countDocuments()).toBe(1);
  expect((await member(user))?.version).toBe(1);
  const actorRow = await member(actor);
  await h.db.collection('permission_profiles').updateOne(
    { _id: actorRow?.permissionProfileIds[0] },
    {
      $set: {
        permissions: [{ permission: Permissions.PlatformMembershipsManage, effect: 'ALLOW' }],
      },
    },
  );
  expect((await put(actor, user.userId, [p], 0, key)).json().error.code).toBe('PERMISSION_DENIED');
});

test('authority entry/scope budget fails closed instead of truncating', async () => {
  const actor = await operator([read]);
  const user = await target();
  const p = await profile(Array.from({ length: 10001 }, () => entry('ALLOW')));
  expect((await put(actor, user.userId, [p])).json().error.code).toBe(
    'PLATFORM_AUTHORITY_EVALUATION_LIMIT_EXCEEDED',
  );
  expect((await member(user))?.version).toBe(0);
});

test('strict DTO decoders reject leaked fields, invalid status/name pairs and unbounded revisions', () => {
  const id = String(new ObjectId());
  const data = {
    userId: id,
    platformMembership: { id, status: 'ACTIVE', version: 0 },
    permissionProfiles: [{ id, name: null, status: 'UNAVAILABLE' }],
  };
  expect(Value.Check(AssignmentResponse, { data })).toBe(true);
  for (const candidate of [
    { data: { ...data, accessVersion: 0 } },
    { data: { ...data, platformMembership: { ...data.platformMembership, email: 'private' } } },
    { data: { ...data, permissionProfiles: [{ id, status: 'UNAVAILABLE', name: 'Foreign' }] } },
    { data: { ...data, permissionProfiles: [{ id, status: 'ACTIVE', name: null }] } },
    {
      data: {
        ...data,
        permissionProfiles: [{ id, status: 'ACTIVE', name: 'Name', permissions: [] }],
      },
    },
  ])
    expect(Value.Check(AssignmentResponse, candidate)).toBe(false);
  expect(
    Value.Check(SelectorResponse, {
      data: { permissionProfiles: [{ id, name: 'Name' }], nextCursor: null },
    }),
  ).toBe(true);
  expect(
    Value.Check(SelectorResponse, {
      data: { permissionProfiles: [{ id, name: 'Name', isSystemDefault: true }], nextCursor: null },
    }),
  ).toBe(false);
  expect(
    Value.Check(AssignmentBody, { expectedVersion: Number.MAX_SAFE_INTEGER, profileIds: [] }),
  ).toBe(true);
  for (const expectedVersion of [Number.MAX_SAFE_INTEGER + 1, -1, 0.5])
    expect(Value.Check(AssignmentBody, { expectedVersion, profileIds: [] })).toBe(false);
});

test('completed replay reauthorizes after result retrieval', async () => {
  const actor = await operator();
  const user = await target();
  const p = await profile();
  const key = String(new ObjectId());
  expect((await put(actor, user.userId, [p], 0, key)).statusCode).toBe(200);
  const original = h.container.idempotency.runInTransaction.bind(h.container.idempotency);
  const row = await member(actor);
  const replay = spyOn(h.container.idempotency, 'runInTransaction').mockImplementation(
    async (...args) => {
      const result = await original(...args);
      await h.db
        .collection('permission_profiles')
        .updateOne({ _id: row?.permissionProfileIds[0] }, { $set: { permissions: [] } });
      return result;
    },
  );
  try {
    expect((await put(actor, user.userId, [p], 0, key)).json().error.code).toBe(
      'PERMISSION_DENIED',
    );
  } finally {
    replay.mockRestore();
  }
  expect(await h.db.collection('outbox_events').countDocuments()).toBe(1);
});

test('future exposure cannot bypass an applicable temporary actor DENY', async () => {
  const actor = await operator([read]);
  const user = await target();
  const deny = await profile([entry('DENY')]);
  const allow = await profile([entry('ALLOW')]);
  await h.db
    .collection('platform_memberships')
    .updateOne({ userId: user.userId }, { $set: { permissionProfileIds: [deny, allow] } });
  await grant(actor, read, 'DENY', { type: 'WORKSPACE' }, new Date(Date.now() + 60_000));
  await grant(user, read, 'DENY', { type: 'WORKSPACE' }, new Date(Date.now() + 120_000));
  await expect(
    h.container.permissions.archiveProfile(await context(actor), String(deny), undefined, 0),
  ).rejects.toMatchObject({ code: 'DELEGATION_DENIED' });
});

for (const command of ['update', 'archive'] as const)
  test(`${command} checks combined resource requests beyond individual atoms`, async () => {
    const permission = Permissions.AuditSensitiveRead;
    const actor = await operator([permission]);
    const user = await target();
    const deny = await profile([{ permission, effect: 'DENY' }]);
    const allow = await profile([{ permission, effect: 'ALLOW' }]);
    await h.db
      .collection('platform_memberships')
      .updateOne({ userId: user.userId }, { $set: { permissionProfileIds: [deny, allow] } });
    const a = new ObjectId();
    const b = new ObjectId();
    await grant(user, permission, 'ALLOW', { type: 'MULTIPLE_BRANCHES', resourceIds: [a] });
    await grant(user, permission, 'ALLOW', { type: 'MULTIPLE_BRANCHES', resourceIds: [b] });
    await grant(actor, permission, 'DENY', { type: 'MULTIPLE_BRANCHES', resourceIds: [a, b] });
    const ctx = await context(actor);
    const run = () =>
      command === 'update'
        ? h.container.permissions.updateProfile(ctx, String(deny), undefined, {
            expectedVersion: 0,
            permissions: [],
          })
        : h.container.permissions.archiveProfile(ctx, String(deny), undefined, 0);
    await expect(run()).rejects.toMatchObject({ code: 'DELEGATION_DENIED' });
    expect((await member(user))?.version).toBe(0);
    await h.db.collection('access_grants').deleteMany({ subjectId: (await member(actor))?._id });
    await run();
    expect((await member(user))?.version).toBe(1);
  });
