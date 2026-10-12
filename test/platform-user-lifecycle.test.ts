import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { AppError } from '../src/core/errors/app-error';
import { OutboxProcessor } from '../src/core/events/outbox.processor';
import { fingerprint } from '../src/core/idempotency/idempotency.service';
import { createLogger } from '../src/core/logging/logger';
import { Permissions, permissionDefinitions } from '../src/modules/permissions/permission.registry';
import { registerPlatformLifecycleOutboxHandlers } from '../src/modules/platform/platform-lifecycle.outbox-handlers';
import { type SummaryHarness, summaryHarness } from './platform-workspace-summary.helpers';

let h: SummaryHarness;
beforeAll(async () => {
  h = await summaryHarness('platform_user_lifecycle');
}, 30_000);
beforeEach(async () => {
  if ((await h.db.collection('permission_definitions').countDocuments()) === 0)
    await h.db.collection('permission_definitions').insertMany(
      permissionDefinitions.map((definition) => ({
        ...definition,
        state: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );
});
afterEach(async () => {
  if (h) await h.clear();
}, 30_000);
afterAll(async () => {
  if (h) await h.close();
}, 30_000);

test('management-state returns only versioned membership state under lifecycle authority', async () => {
  const actor = await h.actor(Permissions.PlatformMembershipsManage);
  const target = await h.actor(Permissions.PlatformMembershipsRead);
  await h.db.collection('platform_memberships').updateMany({}, { $set: { version: 0 } });
  const membership = await h.db
    .collection('platform_memberships')
    .findOne({ userId: target.userId });
  const response = await h.app.inject({
    method: 'GET',
    url: `/api/v1/platform/users/${target.userId}/management-state`,
    headers: { authorization: `Bearer ${actor.token}` },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.json<Record<string, unknown>>()).toEqual({
    data: {
      userId: target.userId.toHexString(),
      platformMembership: {
        id: membership?._id.toHexString(),
        status: 'ACTIVE',
        version: 0,
        suspendedAt: null,
        endedAt: null,
      },
    },
  });
  const wrong = await h.app.inject({
    method: 'GET',
    url: `/api/v1/platform/users/${new ObjectId()}/management-state`,
    headers: { authorization: `Bearer ${target.token}` },
  });
  expect(wrong.statusCode).toBe(403);
});

async function operator() {
  const actor = await h.actor(Permissions.PlatformMembershipsManage);
  const membership = await h.db
    .collection('platform_memberships')
    .findOne({ userId: actor.userId });
  await h.db.collection('permission_profiles').updateOne(
    { _id: membership?.permissionProfileIds[0] },
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
  await h.db.collection('platform_memberships').updateMany({}, { $set: { version: 0 } });
  await h.db
    .collection<{ _id: string; revision: number }>('platform_authority_guards')
    .updateOne(
      { _id: 'management-authority' },
      { $setOnInsert: { revision: 0 } },
      { upsert: true },
    );
  return actor;
}

function command(
  token: string,
  userId: ObjectId | string,
  action: string,
  version = 0,
  key = `${action}-${new ObjectId()}`,
) {
  return h.app.inject({
    method: 'POST',
    url: `/api/v1/platform/users/${userId}/${action}`,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    payload: { expectedVersion: version },
  });
}

test('suspend is atomic, minimized and idempotent; replay still requires current authority', async () => {
  const target = await h.actor(Permissions.PlatformMembershipsRead);
  const actor = await operator();
  const first = await command(actor.token, target.userId, 'suspend', 0, 'suspend-once');
  expect(first.statusCode).toBe(200);
  expect(
    first.json<{ data: { platformMembership: { status: string; version: number } } }>().data
      .platformMembership,
  ).toMatchObject({ status: 'SUSPENDED', version: 1 });
  const replay = await command(actor.token, target.userId, 'suspend', 0, 'suspend-once');
  expect(replay.body).toBe(first.body);
  expect(
    (await command(actor.token, target.userId, 'suspend', 1, 'suspend-once')).json<{
      error: { code: string };
    }>().error.code,
  ).toBe('IDEMPOTENCY_KEY_REUSED');
  expect(
    await h.db
      .collection('audit_events')
      .countDocuments({ eventType: 'PlatformMembershipSuspended' }),
  ).toBe(1);
  expect(
    await h.db
      .collection('outbox_events')
      .countDocuments({ eventType: 'PlatformMembershipSuspended' }),
  ).toBe(1);
  const member = await h.db.collection('platform_memberships').findOne({ userId: target.userId });
  expect(member).toMatchObject({ version: 1, accessVersion: 1 });
  await h.db
    .collection('platform_memberships')
    .updateOne({ userId: actor.userId }, { $set: { status: 'SUSPENDED' } });
  expect((await command(actor.token, target.userId, 'suspend', 0, 'suspend-once')).statusCode).toBe(
    403,
  );
});

async function target(status = 'ACTIVE', accountStatus = 'ACTIVE') {
  const actor = await h.actor(Permissions.PlatformMembershipsRead);
  await h.db
    .collection('users')
    .updateOne({ _id: actor.userId }, { $set: { status: accountStatus } });
  await h.db.collection('platform_memberships').updateOne(
    { userId: actor.userId },
    {
      $set: {
        version: 0,
        status,
        ...(status === 'SUSPENDED' ? { suspendedAt: new Date('2026-01-01') } : {}),
        ...(status === 'ENDED' ? { endedAt: new Date('2026-01-02') } : {}),
      },
    },
  );
  return actor;
}

function errorCode(response: { json<T>(): T }) {
  return response.json<{ error: { code: string } }>().error.code;
}

for (const status of ['ACTIVE', 'SUSPENDED', 'ENDED']) {
  for (const action of ['suspend', 'reactivate', 'end']) {
    const allowed =
      action === 'suspend'
        ? status === 'ACTIVE'
        : action === 'reactivate'
          ? status !== 'ACTIVE'
          : status !== 'ENDED';
    test(`${status} ${action}: ${allowed ? 'valid transition' : 'explicit invalid transition'}`, async () => {
      const actor = await operator();
      const member = await target(status);
      const before = await h.db
        .collection('platform_memberships')
        .findOne({ userId: member.userId });
      const result = await command(actor.token, member.userId, action);
      expect(result.statusCode).toBe(allowed ? 200 : 409);
      if (!allowed) {
        expect(errorCode(result)).toBe('PLATFORM_MEMBERSHIP_TRANSITION_INVALID');
        return;
      }
      const state = result.json<{
        data: {
          platformMembership: {
            status: string;
            version: number;
            suspendedAt: string | null;
            endedAt: string | null;
          };
        };
      }>().data.platformMembership;
      expect(state.version).toBe(1);
      expect(state.status).toBe(
        action === 'suspend' ? 'SUSPENDED' : action === 'end' ? 'ENDED' : 'ACTIVE',
      );
      if (action === 'reactivate') {
        expect(state.suspendedAt).toBeNull();
        expect(state.endedAt).toBeNull();
      }
      if (action === 'end' && status === 'SUSPENDED')
        expect(state.suspendedAt).toBe(before?.suspendedAt.toISOString());
      const after = await h.db
        .collection('platform_memberships')
        .findOne({ userId: member.userId });
      expect(after?.permissionProfileIds).toEqual(before?.permissionProfileIds);
      expect(after?.accessVersion).toBe(1);
      const eventType = `PlatformMembership${action === 'suspend' ? 'Suspended' : action === 'reactivate' ? 'Reactivated' : 'Ended'}`;
      const audit = await h.db.collection('audit_events').findOne({ eventType });
      expect(audit?.before).toEqual({ status, version: 0 });
      expect(audit?.after).toMatchObject({
        previousStatus: status,
        previousVersion: 0,
        status: state.status,
        version: 1,
        command: action,
      });
      expect(JSON.stringify(audit)).not.toContain('email');
      expect(await h.db.collection('outbox_events').countDocuments({ eventType })).toBe(1);
      const repeated = await command(actor.token, member.userId, action, 1);
      expect(errorCode(repeated)).toBe('PLATFORM_MEMBERSHIP_TRANSITION_INVALID');
    });
  }
}

test('authorization precedes target disclosure and authorities remain independent', async () => {
  const path = `/api/v1/platform/users/${new ObjectId()}/management-state`;
  expect((await h.app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
  for (const [options, code] of [
    [{ restricted: true }, 'AUTH_SESSION_RESTRICTED'],
    [{ mfa: false }, 'TWO_FACTOR_REQUIRED'],
    [{ membership: false }, 'PLATFORM_MEMBERSHIP_REQUIRED'],
    [{ membershipStatus: 'SUSPENDED' }, 'PLATFORM_MEMBERSHIP_INACTIVE'],
    [{ membershipStatus: 'ENDED' }, 'PLATFORM_MEMBERSHIP_INACTIVE'],
    [{ deny: true }, 'PERMISSION_DENIED'],
  ] as const) {
    const actor = await h.actor(Permissions.PlatformMembershipsManage, options);
    const response = await h.app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: `Bearer ${actor.token}` },
    });
    expect(errorCode(response)).toBe(code);
    expect(errorCode(await command(actor.token, new ObjectId(), 'end'))).toBe(code);
  }
  for (const permission of [
    Permissions.PlatformMembershipsRead,
    Permissions.PlatformPermissionsManage,
  ]) {
    const actor = await h.actor(permission);
    expect(errorCode(await command(actor.token, new ObjectId(), 'end'))).toBe('PERMISSION_DENIED');
  }
  const actor = await h.actor(Permissions.PlatformMembershipsManage);
  await h.db
    .collection('users')
    .updateOne({ _id: actor.userId }, { $set: { status: 'SUSPENDED' } });
  expect((await command(actor.token, new ObjectId(), 'end')).statusCode).toBe(401);
  await h.db.collection('users').deleteOne({ _id: actor.userId });
  expect((await command(actor.token, new ObjectId(), 'end')).statusCode).toBe(401);
  for (const role of ['GYM_OWNER', 'TRAINER']) {
    const gym = await h.actor(Permissions.PlatformMembershipsManage, { membership: false });
    await h.db.collection('workspace_memberships').insertOne({
      userId: gym.userId,
      workspaceId: new ObjectId(),
      status: 'ACTIVE',
      roles: [role],
    });
    expect(errorCode(await command(gym.token, new ObjectId(), 'end'))).toBe(
      'PLATFORM_MEMBERSHIP_REQUIRED',
    );
  }
});

test('support is rejected before account lookup, even by the global hook', async () => {
  const actor = await operator();
  const member = await target();
  for (const suffix of ['management-state', 'suspend', 'reactivate', 'end']) {
    for (const id of [member.userId, new ObjectId(), 'malformed']) {
      const response = await h.app.inject({
        method: suffix === 'management-state' ? 'GET' : 'POST',
        url: `/api/v1/platform/users/${id}/${suffix}`,
        headers: {
          authorization: `Bearer ${actor.token}`,
          'x-support-session-id': 'must-not-be-resolved',
          'idempotency-key': `support-${id}-${suffix}`,
        },
        ...(suffix === 'management-state' ? {} : { payload: { expectedVersion: 0 } }),
      });
      expect(errorCode(response)).toBe('SUPPORT_ACCESS_FORBIDDEN');
    }
  }
});

test('self-target denied for all lifecycle actions including legacy routes', async () => {
  const actor = await operator();
  const membership = await h.db
    .collection('platform_memberships')
    .findOne({ userId: actor.userId });
  for (const action of ['suspend', 'reactivate', 'end']) {
    expect(errorCode(await command(actor.token, actor.userId, action))).toBe(
      'PLATFORM_MEMBERSHIP_SELF_MUTATION_FORBIDDEN',
    );
    const legacy = await h.app.inject({
      method: 'POST',
      url: `/api/v1/platform/memberships/${membership?._id}/${action}`,
      headers: { authorization: `Bearer ${actor.token}` },
    });
    expect(errorCode(legacy)).toBe('PLATFORM_MEMBERSHIP_SELF_MUTATION_FORBIDDEN');
  }
});

test('unknown, malformed and nonmember targets share generic 404; stale revision precedes transition', async () => {
  const actor = await operator();
  const nonmember = await h.actor(Permissions.PlatformMembershipsRead, { membership: false });
  for (const id of [new ObjectId(), nonmember.userId, 'malformed']) {
    expect(errorCode(await command(actor.token, id, 'suspend'))).toBe('USER_NOT_FOUND');
  }
  const member = await target('ENDED');
  expect(errorCode(await command(actor.token, member.userId, 'suspend', 1))).toBe(
    'PLATFORM_MEMBERSHIP_VERSION_CONFLICT',
  );
});

test('reactivation checks account inside transaction and preserves explicit grants', async () => {
  const actor = await operator();
  const member = await target('ENDED', 'SUSPENDED');
  expect(errorCode(await command(actor.token, member.userId, 'reactivate'))).toBe(
    'PLATFORM_MEMBERSHIP_TARGET_ACCOUNT_INACTIVE',
  );
  await h.db.collection('users').updateOne({ _id: member.userId }, { $set: { status: 'ACTIVE' } });
  const membership = await h.db
    .collection('platform_memberships')
    .findOne({ userId: member.userId });
  const grant = {
    _id: new ObjectId(),
    subjectId: membership?._id,
    subjectType: 'PLATFORM_MEMBERSHIP',
    context: 'PLATFORM',
    permission: Permissions.PlatformMembershipsRead,
    effect: 'ALLOW',
    scope: { type: 'WORKSPACE' },
  };
  await h.db.collection('access_grants').insertOne(grant);
  expect((await command(actor.token, member.userId, 'reactivate')).statusCode).toBe(200);
  expect(await h.db.collection('access_grants').findOne({ _id: grant._id })).toEqual(grant);
});

for (const [status, actions] of [
  ['ACTIVE', ['suspend', 'end']],
  ['ACTIVE', ['suspend', 'suspend']],
  ['SUSPENDED', ['reactivate', 'end']],
  ['ENDED', ['reactivate', 'reactivate']],
] as const) {
  test(`same-target ${status} ${actions.join('/')} race has one CAS winner`, async () => {
    const actor = await operator();
    const member = await target(status);
    const results = await Promise.all(
      actions.map((action) => command(actor.token, member.userId, action)),
    );
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    for (const result of results)
      if (result.statusCode === 409)
        expect(errorCode(result)).toBe('PLATFORM_MEMBERSHIP_VERSION_CONFLICT');
    expect(await h.db.collection('audit_events').countDocuments()).toBe(1);
    expect(await h.db.collection('outbox_events').countDocuments()).toBe(1);
  });
}

test('concurrent cross-target administrator removal cannot deplete either authority', async () => {
  const a = await operator();
  const b = await operator();
  const results = await Promise.all([
    command(a.token, b.userId, 'suspend'),
    command(b.token, a.userId, 'suspend'),
  ]);
  expect(results.filter((result) => result.statusCode === 200)).toHaveLength(1);
  expect(await h.db.collection('platform_memberships').countDocuments({ status: 'ACTIVE' })).toBe(
    1,
  );
});

test('last permissions manager is protected across lifecycle and legacy assignment/grant/profile writes', async () => {
  const actor = await h.actor(Permissions.PlatformMembershipsManage);
  const last = await h.actor(Permissions.PlatformPermissionsManage);
  await h.db.collection('platform_memberships').updateMany({}, { $set: { version: 0 } });
  const membership = await h.db.collection('platform_memberships').findOne({ userId: last.userId });
  expect(errorCode(await command(actor.token, last.userId, 'suspend'))).toBe(
    'PLATFORM_LAST_MANAGEMENT_AUTHORITY_REQUIRED',
  );
  const legacy = await h.app.inject({
    method: 'POST',
    url: `/api/v1/platform/memberships/${membership?._id}/end`,
    headers: { authorization: `Bearer ${actor.token}` },
  });
  expect(errorCode(legacy)).toBe('PLATFORM_LAST_MANAGEMENT_AUTHORITY_REQUIRED');
  // Assignment now forbids self mutation before recovery evaluation. A different
  // actor with temporary authority still cannot remove the final durable holder.
  const actorMembership = await h.db
    .collection('platform_memberships')
    .findOne({ userId: actor.userId });
  await h.db.collection('access_grants').insertOne({
    subjectId: actorMembership?._id,
    subjectType: 'PLATFORM_MEMBERSHIP',
    context: 'PLATFORM',
    permission: Permissions.PlatformPermissionsManage,
    effect: 'ALLOW',
    scope: { type: 'WORKSPACE' },
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  for (const [method, suffix, payload] of [
    ['PUT', 'permission-profiles', { expectedVersion: 0, profileIds: [] }],
    [
      'PUT',
      'access',
      {
        expectedVersion: 0,
        grants: [
          {
            permission: Permissions.PlatformPermissionsManage,
            effect: 'DENY',
            scope: { type: 'WORKSPACE' },
          },
        ],
      },
    ],
  ] as const) {
    const result = await h.app.inject({
      method,
      url: `/api/v1/platform/memberships/${membership?._id}/${suffix}`,
      headers: { authorization: `Bearer ${actor.token}` },
      payload,
    });
    expect(errorCode(result)).toBe('PLATFORM_LAST_MANAGEMENT_AUTHORITY_REQUIRED');
  }
  await h.db
    .collection('permission_profiles')
    .updateOne({ _id: membership?.permissionProfileIds[0] }, { $set: { version: 0 } });
  const result = await h.app.inject({
    method: 'POST',
    url: `/api/v1/platform/permission-profiles/${membership?.permissionProfileIds[0]}/archive`,
    headers: { authorization: `Bearer ${last.token}` },
    payload: { expectedVersion: 0 },
  });
  expect(errorCode(result)).toBe('PLATFORM_LAST_MANAGEMENT_AUTHORITY_REQUIRED');
  expect(await h.db.collection('audit_events').countDocuments()).toBe(0);
});

test('expired or expiring ALLOW and archived or DENY-shadowed profiles cannot be sole recovery authority', async () => {
  const actor = await h.actor(Permissions.PlatformMembershipsManage);
  const last = await h.actor(Permissions.PlatformPermissionsManage);
  const candidate = await h.actor(Permissions.PlatformPermissionsManage, { deny: true });
  await h.db.collection('platform_memberships').updateMany({}, { $set: { version: 0 } });
  const candidateMembership = await h.db
    .collection('platform_memberships')
    .findOne({ userId: candidate.userId });
  for (const expiresAt of [new Date(Date.now() - 1000), new Date(Date.now() + 1000)]) {
    await h.db.collection('access_grants').deleteMany({ subjectId: candidateMembership?._id });
    await h.db.collection('access_grants').insertOne({
      subjectId: candidateMembership?._id,
      subjectType: 'PLATFORM_MEMBERSHIP',
      context: 'PLATFORM',
      permission: Permissions.PlatformPermissionsManage,
      effect: 'ALLOW',
      scope: { type: 'WORKSPACE' },
      expiresAt,
    });
    expect(errorCode(await command(actor.token, last.userId, 'end'))).toBe(
      'PLATFORM_LAST_MANAGEMENT_AUTHORITY_REQUIRED',
    );
  }
  await h.db.collection('access_grants').deleteMany({});
  await h.db
    .collection('permission_profiles')
    .updateOne(
      { _id: candidateMembership?.permissionProfileIds[0] },
      { $set: { status: 'ARCHIVED' } },
    );
  expect(errorCode(await command(actor.token, last.userId, 'end'))).toBe(
    'PLATFORM_LAST_MANAGEMENT_AUTHORITY_REQUIRED',
  );
});

test('last durable users manager is protected even when actor has temporary lifecycle authority', async () => {
  const last = await operator();
  const actor = await target();
  const membership = await h.db
    .collection('platform_memberships')
    .findOne({ userId: actor.userId });
  await h.db.collection('access_grants').insertOne({
    subjectId: membership?._id,
    subjectType: 'PLATFORM_MEMBERSHIP',
    context: 'PLATFORM',
    permission: Permissions.PlatformMembershipsManage,
    effect: 'ALLOW',
    scope: { type: 'WORKSPACE' },
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect(errorCode(await command(actor.token, last.userId, 'end'))).toBe(
    'PLATFORM_LAST_MANAGEMENT_AUTHORITY_REQUIRED',
  );
});

for (const failure of ['audit', 'outbox', 'completion', 'guard', 'cas'] as const) {
  test(`${failure} failure rolls back membership, revisions, guard and business events`, async () => {
    const actor = await operator();
    const member = await target();
    const before = await h.db.collection('platform_memberships').findOne({ userId: member.userId });
    const guardBefore = await h.db.collection('platform_authority_guards').findOne({});
    const error = new AppError({
      code: 'INTERNAL_ERROR',
      httpStatus: 500,
      message: 'Injected failure.',
    });
    const mock =
      failure === 'audit'
        ? spyOn(h.container.audit, 'write')
        : failure === 'outbox'
          ? spyOn(h.container.outbox, 'write')
          : failure === 'completion'
            ? spyOn(h.container.idempotency, 'completeWithinTransaction')
            : failure === 'guard'
              ? spyOn(h.container.platformAuthorityGuard, 'serialize')
              : spyOn(h.container.platformMemberships, 'transition');
    mock.mockRejectedValueOnce(error);
    try {
      expect((await command(actor.token, member.userId, 'suspend')).statusCode).toBe(500);
    } finally {
      mock.mockRestore();
    }
    expect(
      await h.db.collection('platform_memberships').findOne({ userId: member.userId }),
    ).toEqual(before);
    expect(await h.db.collection('platform_authority_guards').findOne({})).toEqual(guardBefore);
    expect(await h.db.collection('audit_events').countDocuments()).toBe(0);
    expect(await h.db.collection('outbox_events').countDocuments()).toBe(0);
    expect(
      await h.db.collection('idempotency_records').countDocuments({ state: 'COMPLETED' }),
    ).toBe(0);
  });
}

test('future authorization retires after suspend/end without session revocation; reactivation restores eligibility', async () => {
  const actor = await operator();
  const member = await target();
  const read = () =>
    h.app.inject({
      method: 'GET',
      url: '/api/v1/platform/users',
      headers: { authorization: `Bearer ${member.token}` },
    });
  expect((await read()).statusCode).toBe(200);
  const sessions = await h.db.collection('auth_sessions').find({ userId: member.userId }).toArray();
  expect((await command(actor.token, member.userId, 'suspend')).statusCode).toBe(200);
  expect((await read()).statusCode).toBe(403);
  expect((await command(actor.token, member.userId, 'reactivate', 1)).statusCode).toBe(200);
  expect((await read()).statusCode).toBe(200);
  expect((await command(actor.token, member.userId, 'end', 2)).statusCode).toBe(200);
  expect((await read()).statusCode).toBe(403);
  expect(await h.db.collection('auth_sessions').find({ userId: member.userId }).toArray()).toEqual(
    sessions,
  );
});

test('strict body/header validation rejects unsafe revisions and extra fields', async () => {
  const actor = await operator();
  const member = await target();
  for (const expectedVersion of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/platform/users/${member.userId}/end`,
      headers: { authorization: `Bearer ${actor.token}`, 'idempotency-key': 'validation' },
      payload: { expectedVersion },
    });
    expect(response.statusCode).toBe(400);
  }
  for (const key of [undefined, '', '   ']) {
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/platform/users/${member.userId}/end`,
      headers: {
        authorization: `Bearer ${actor.token}`,
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      payload: { expectedVersion: 0 },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('IDEMPOTENCY_KEY_REQUIRED');
  }
  const extra = await h.app.inject({
    method: 'POST',
    url: `/api/v1/platform/users/${member.userId}/end`,
    headers: { authorization: `Bearer ${actor.token}`, 'idempotency-key': 'extra' },
    payload: { expectedVersion: 0, accessVersion: 0 },
  });
  expect(extra.statusCode).toBe(400);
});

test('concurrent same-key requests mutate once and completed response is a stable snapshot', async () => {
  const actor = await operator();
  const member = await target();
  const results = await Promise.all([
    command(actor.token, member.userId, 'suspend', 0, 'race-key'),
    command(actor.token, member.userId, 'suspend', 0, 'race-key'),
  ]);
  expect(results.some((result) => result.statusCode === 200)).toBe(true);
  for (const result of results)
    if (result.statusCode !== 200)
      expect(errorCode(result)).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
  const original = results.find((result) => result.statusCode === 200);
  if (!original) throw new Error('Missing race winner');
  expect((await command(actor.token, member.userId, 'reactivate', 1)).statusCode).toBe(200);
  expect((await command(actor.token, member.userId, 'suspend', 0, 'race-key')).body).toBe(
    original.body,
  );
  expect(
    await h.db
      .collection('audit_events')
      .countDocuments({ eventType: 'PlatformMembershipSuspended' }),
  ).toBe(1);
});

test('a concurrent different-body retry conflicts while the original command is processing', async () => {
  const actor = await operator();
  const member = await target();
  let entered = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = h.container.audit.write.bind(h.container.audit);
  const mock = spyOn(h.container.audit, 'write').mockImplementationOnce(async (input, tx) => {
    entered();
    await gate;
    await write(input, tx);
  });
  const first = command(actor.token, member.userId, 'suspend', 0, 'in-flight');
  try {
    await reached;
    expect(errorCode(await command(actor.token, member.userId, 'suspend', 1, 'in-flight'))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(errorCode(await command(actor.token, member.userId, 'suspend', 0, 'in-flight'))).toBe(
      'IDEMPOTENCY_REQUEST_IN_PROGRESS',
    );
  } finally {
    release();
    mock.mockRestore();
  }
  expect((await first).statusCode).toBe(200);
  expect(await h.db.collection('audit_events').countDocuments()).toBe(1);
  expect(await h.db.collection('outbox_events').countDocuments()).toBe(1);
});

test('failed and stale processing attempts recover with the same intent; mismatch never mutates', async () => {
  const actor = await operator();
  const member = await target();
  const mock = spyOn(h.container.outbox, 'write').mockRejectedValueOnce(
    new Error('Injected timeout'),
  );
  try {
    expect((await command(actor.token, member.userId, 'suspend', 0, 'failed-key')).statusCode).toBe(
      500,
    );
  } finally {
    mock.mockRestore();
  }
  expect((await command(actor.token, member.userId, 'suspend', 0, 'failed-key')).statusCode).toBe(
    200,
  );
  const next = await target();
  const routeKey = `POST /api/v1/platform/users/${next.userId}/suspend`;
  const requestHash = fingerprint({
    userId: next.userId.toHexString(),
    command: 'suspend',
    body: { expectedVersion: 0 },
  });
  await h.db.collection('idempotency_records').insertOne({
    actorId: actor.userId.toHexString(),
    routeKey,
    key: 'stale-key',
    requestHash,
    state: 'PROCESSING',
    createdAt: new Date(Date.now() - 600_000),
    updatedAt: new Date(Date.now() - 600_000),
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect(errorCode(await command(actor.token, next.userId, 'suspend', 1, 'stale-key'))).toBe(
    'IDEMPOTENCY_KEY_REUSED',
  );
  expect((await command(actor.token, next.userId, 'suspend', 0, 'stale-key')).statusCode).toBe(200);
  expect(
    await h.db
      .collection('audit_events')
      .countDocuments({ eventType: 'PlatformMembershipSuspended' }),
  ).toBe(2);
});

test('direct internal writers propagate revisions and cannot remove final management authority', async () => {
  const actor = await operator();
  const member = await target();
  const membership = await h.container.platformMemberships.findByUserId(member.userId);
  if (!membership) throw new Error('Missing fixture');
  await h.container.platformMemberships.replacePermissionProfiles(membership._id, 0, []);
  expect(await h.container.platformMemberships.findById(membership._id)).toMatchObject({
    version: 1,
    accessVersion: 1,
  });
  await h.container.accessGrants.replaceCurrent(
    'PLATFORM_MEMBERSHIP',
    membership._id,
    'PLATFORM',
    undefined,
    [],
    actor.userId,
  );
  expect(await h.container.platformMemberships.findById(membership._id)).toMatchObject({
    version: 2,
    accessVersion: 2,
  });
  const admin = await h.container.platformMemberships.findByUserId(actor.userId);
  if (!admin) throw new Error('Missing fixture');
  await expect(
    h.container.platformMemberships.replacePermissionProfiles(admin._id, 0, []),
  ).rejects.toMatchObject({ code: 'PLATFORM_LAST_MANAGEMENT_AUTHORITY_REQUIRED' });
  await expect(
    h.container.accessGrants.replaceCurrent(
      'PLATFORM_MEMBERSHIP',
      admin._id,
      'PLATFORM',
      undefined,
      [
        {
          permission: Permissions.PlatformPermissionsManage,
          effect: 'DENY',
          scope: { type: 'WORKSPACE' },
        },
      ],
      actor.userId,
    ),
  ).rejects.toMatchObject({ code: 'PLATFORM_LAST_MANAGEMENT_AUTHORITY_REQUIRED' });
  expect(await h.container.platformMemberships.findById(admin._id)).toMatchObject({
    version: 0,
    accessVersion: 0,
  });
});

test('profile permission edits/archive revise assigned active and inactive memberships; name edit does not', async () => {
  await operator();
  const a = await target();
  const b = await target('ENDED');
  const membership = await h.container.platformMemberships.findByUserId(a.userId);
  const profileId = membership?.permissionProfileIds[0];
  if (!profileId) throw new Error('Missing fixture');
  await h.db
    .collection('permission_profiles')
    .updateOne({ _id: profileId }, { $set: { version: 0 } });
  await h.db
    .collection('platform_memberships')
    .updateOne({ userId: b.userId }, { $set: { permissionProfileIds: [profileId] } });
  await h.container.permissionProfiles.update(profileId, 0, { name: 'Renamed' });
  expect(await h.container.platformMemberships.findByUserId(a.userId)).toMatchObject({
    version: 0,
    accessVersion: 0,
  });
  await h.container.permissionProfiles.update(profileId, 1, { permissions: [] });
  for (const userId of [a.userId, b.userId])
    expect(await h.container.platformMemberships.findByUserId(userId)).toMatchObject({
      version: 1,
      accessVersion: 1,
    });
  await h.container.permissionProfiles.archive(profileId, 2);
  for (const userId of [a.userId, b.userId])
    expect(await h.container.platformMemberships.findByUserId(userId)).toMatchObject({
      version: 2,
      accessVersion: 2,
    });
});

for (const kind of ['profiles', 'grants', 'profile-update', 'profile-archive'] as const) {
  test(`lifecycle races with ${kind} without losing revision or authority input changes`, async () => {
    const actor = await operator();
    const member = await target();
    const membership = await h.container.platformMemberships.findByUserId(member.userId);
    if (!membership) throw new Error('Missing fixture');
    const profileId = membership.permissionProfileIds[0];
    if (!profileId) throw new Error('Missing fixture');
    await h.db
      .collection('permission_profiles')
      .updateOne({ _id: profileId }, { $set: { version: 0 } });
    const write =
      kind === 'profiles'
        ? h.app.inject({
            method: 'PUT',
            url: `/api/v1/platform/memberships/${membership._id}/permission-profiles`,
            headers: { authorization: `Bearer ${actor.token}` },
            payload: { expectedVersion: 0, profileIds: [] },
          })
        : kind === 'grants'
          ? h.app.inject({
              method: 'PUT',
              url: `/api/v1/platform/memberships/${membership._id}/access`,
              headers: { authorization: `Bearer ${actor.token}` },
              payload: { expectedVersion: 0, grants: [] },
            })
          : h.app.inject({
              method: kind === 'profile-update' ? 'PATCH' : 'POST',
              url: `/api/v1/platform/permission-profiles/${profileId}${kind === 'profile-archive' ? '/archive' : ''}`,
              headers: { authorization: `Bearer ${actor.token}` },
              payload: {
                expectedVersion: 0,
                ...(kind === 'profile-update' ? { permissions: [] } : {}),
              },
            });
    const results = await Promise.all([command(actor.token, member.userId, 'suspend'), write]);
    expect(results.every((result) => [200, 409].includes(result.statusCode))).toBe(true);
    const successful = results.filter((result) => result.statusCode === 200).length;
    const current = await h.container.platformMemberships.findById(membership._id);
    expect(current?.version).toBe(successful);
    expect(current?.accessVersion).toBe(successful);
    expect(successful).toBeGreaterThanOrEqual(1);
    expect(await h.db.collection('audit_events').countDocuments()).toBe(successful);
    expect(await h.db.collection('outbox_events').countDocuments()).toBe(successful);
  });
}

test('OpenAPI documents strict management schemas and point lookups use existing identity indexes', async () => {
  const actor = await operator();
  const member = await target();
  const document = h.app.swagger();
  for (const command of ['management-state', 'suspend', 'reactivate', 'end']) {
    const path = document.paths?.[`/api/v1/platform/users/{userId}/${command}`];
    expect(path).toBeDefined();
    const operation = command === 'management-state' ? path?.get : path?.post;
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '500',
    ]);
  }
  const membership = await h.container.platformMemberships.findByUserId(member.userId);
  if (!membership) throw new Error('Missing fixture');
  for (const [collection, query] of [
    ['users', { _id: member.userId }],
    ['platform_memberships', { userId: member.userId }],
    ['platform_memberships', { _id: membership._id, version: 0 }],
    ['platform_authority_guards', { _id: 'management-authority' }],
  ] as const) {
    const plan = await h.db
      .collection<{ _id: ObjectId | string; userId?: ObjectId; version?: number }>(collection)
      .find(query)
      .explain('executionStats');
    expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(1);
  }
  expect((await command(actor.token, member.userId, 'end')).headers['cache-control']).toBe(
    'private, no-store',
  );
});

test('lifecycle facts are acknowledged without invented notifications or session effects', async () => {
  const actor = await operator();
  const member = await target();
  await command(actor.token, member.userId, 'suspend');
  await command(actor.token, member.userId, 'reactivate', 1);
  await command(actor.token, member.userId, 'end', 2);
  const sessions = await h.db.collection('auth_sessions').find({}).toArray();
  const processor = new OutboxProcessor(
    h.container.database,
    h.container.config,
    createLogger(h.container.config),
  );
  registerPlatformLifecycleOutboxHandlers(processor);
  for (let i = 0; i < 3; i++) expect(await processor.processOne()).toBe(true);
  expect(await processor.processOne()).toBe(false);
  expect(
    await h.db.collection('outbox_events').countDocuments({ status: 'PROCESSED', attempts: 0 }),
  ).toBe(3);
  expect(await h.db.collection('auth_sessions').find({}).toArray()).toEqual(sessions);
  expect(await h.db.collection('notifications').countDocuments()).toBe(0);
});

test('service-level support defense runs before any target membership lookup', async () => {
  const actor = await operator();
  const session = h.container.jwt.verifyAccessToken(actor.token);
  const ctx = {
    userId: actor.userId.toHexString(),
    authSessionId: session.sid,
    mfaSatisfied: true,
    supportSessionId: new ObjectId().toHexString(),
    correlationId: 'support-defense',
    locale: 'en',
    timezone: 'Africa/Cairo',
    ipAddress: '127.0.0.1',
  };
  const lookup = spyOn(h.container.platformMemberships, 'findByUserId').mockRejectedValue(
    new Error('Target lookup must not run'),
  );
  try {
    await expect(
      h.container.platformUserManagement.state(ctx, new ObjectId().toHexString()),
    ).rejects.toMatchObject({ code: 'SUPPORT_ACCESS_FORBIDDEN' });
    await expect(
      h.container.unitOfWork.withTransaction((tx) =>
        h.container.platformUserManagement.transition(
          ctx,
          new ObjectId().toHexString(),
          'end',
          0,
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'SUPPORT_ACCESS_FORBIDDEN' });
    expect(lookup).not.toHaveBeenCalled();
  } finally {
    lookup.mockRestore();
  }
});

test('legacy lifecycle maintains wire DTO and management revision without bypassing lockout', async () => {
  const actor = await operator();
  const member = await target();
  const membership = await h.container.platformMemberships.findByUserId(member.userId);
  if (!membership) throw new Error('Missing fixture');
  const response = await h.app.inject({
    method: 'POST',
    url: `/api/v1/platform/memberships/${membership._id}/suspend`,
    headers: { authorization: `Bearer ${actor.token}` },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json<{ data: Record<string, unknown> }>().data).toMatchObject({
    status: 'SUSPENDED',
    accessVersion: 1,
    permissionProfileIds: membership.permissionProfileIds.map((id) => id.toHexString()),
  });
  expect(response.json<{ data: Record<string, unknown> }>().data).not.toHaveProperty('version');
  expect(await h.container.platformMemberships.findById(membership._id)).toMatchObject({
    version: 1,
    accessVersion: 1,
  });
  expect(errorCode(await command(actor.token, member.userId, 'reactivate', 0))).toBe(
    'PLATFORM_MEMBERSHIP_VERSION_CONFLICT',
  );
});
