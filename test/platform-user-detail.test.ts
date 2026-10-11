import { describe, expect, spyOn, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { PlatformMembershipStatuses } from '../src/modules/platform/platform.types';
import {
  allowed,
  assertUserReadAuthority,
  assertUserSupportDenial,
  member,
  summaryGet,
  userReadHarness,
} from './platform-user-read.helpers';

const harness = userReadHarness('platform_user_detail');
const base = '/api/v1/platform/users';

describe('Platform user detail', () => {
  test('existing actor authority and support rejection apply to detail too', async () => {
    const h = harness();
    const target = await member(h);
    await assertUserReadAuthority(h, `${base}/${target.userId}`);
    await assertUserSupportDenial(h, `${base}/${target.userId}`);
  });
  test('service support rejection is defensive before authorization or target reads', async () => {
    const h = harness();
    const authorize = spyOn(h.container.accessControl, 'authorize');
    try {
      await expect(
        h.container.platformUsers.detail(
          {
            correlationId: 'support',
            ipAddress: '127.0.0.1',
            locale: 'en',
            timezone: 'UTC',
            supportSessionId: 'support',
          },
          new ObjectId().toHexString(),
        ),
      ).rejects.toMatchObject({ code: 'SUPPORT_ACCESS_FORBIDDEN', httpStatus: 403 });
      expect(authorize).not.toHaveBeenCalled();
    } finally {
      authorize.mockRestore();
    }
  });
  test('strict minimized detail separates account and all membership statuses', async () => {
    const h = harness();
    const actor = await allowed(h);
    for (const status of PlatformMembershipStatuses) {
      const target = await member(h, { status: 'LOCKED', membershipStatus: status });
      const response = await summaryGet(h.app, `${base}/${target.userId}`, actor.token);
      expect(response.statusCode).toBe(200);
      expect(response.json() as unknown).toEqual({
        data: {
          id: target.userId.toHexString(),
          displayName: 'Hassan Member',
          email: `member-${target.userId}@example.com`,
          status: 'LOCKED',
          createdAt: target.now.toISOString(),
          updatedAt: target.now.toISOString(),
          platformMembership: {
            id: target.membershipId.toHexString(),
            status,
            createdAt: target.now.toISOString(),
            updatedAt: target.now.toISOString(),
            suspendedAt: target.now.toISOString(),
            endedAt: target.now.toISOString(),
          },
        },
      });
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).not.toContain('NEVER-EXPOSE');
    }
  });
  test('missing optional identity and lifecycle timestamps are omitted', async () => {
    const h = harness();
    const actor = await allowed(h);
    const target = await member(h, { firstName: '', lastName: '', email: null });
    await h.db
      .collection('platform_memberships')
      .updateOne({ _id: target.membershipId }, { $unset: { suspendedAt: '', endedAt: '' } });
    const response = await summaryGet(h.app, `${base}/${target.userId}`, actor.token);
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json().data).sort()).toEqual([
      'createdAt',
      'id',
      'platformMembership',
      'status',
      'updatedAt',
    ]);
    expect(Object.keys(response.json().data.platformMembership).sort()).toEqual([
      'createdAt',
      'id',
      'status',
      'updatedAt',
    ]);
  });
  test('unknown, account without membership and dangling membership return same 404', async () => {
    const h = harness();
    const actor = await allowed(h);
    const outside = await member(h, { membership: false });
    const danglingId = new ObjectId();
    await h.db
      .collection('platform_memberships')
      .insertOne({ _id: new ObjectId(), userId: danglingId, status: 'ACTIVE' });
    for (const id of [outside.userId, danglingId, new ObjectId()]) {
      const response = await summaryGet(h.app, `${base}/${id}`, actor.token);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('USER_NOT_FOUND');
    }
    for (const id of ['invalid', 'ABCDEFABCDEFABCDEFABCDEF', '0'.repeat(23)]) {
      expect((await summaryGet(h.app, `${base}/${id}`, actor.token)).statusCode).toBe(400);
    }
    expect(
      (await summaryGet(h.app, `${base}/${actor.userId}?workspaceId=x`, actor.token)).statusCode,
    ).toBe(400);
  });
  test('OpenAPI documents strict query/DTO/error contracts and read-only routes', async () => {
    const h = harness();
    await h.app.ready();
    const schema = h.app.swagger();
    const directory = schema.paths?.['/api/v1/platform/users'];
    const detail = schema.paths?.['/api/v1/platform/users/{userId}'];
    expect(Object.keys(directory ?? {})).toEqual(['get']);
    expect(Object.keys(detail ?? {})).toEqual(['get']);
    expect(
      directory?.get?.parameters?.map((param) => ('name' in param ? param.name : '')).sort(),
    ).toEqual(['cursor', 'limit', 'platformMembershipStatus', 'q']);
    expect(Object.keys(directory?.get?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '422',
      '500',
    ]);
    expect(Object.keys(detail?.get?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '500',
    ]);
    // Response JSON schemas must remain nested strict objects, not empty placeholders.
    const text = JSON.stringify([directory, detail]);
    expect(text).toContain('additionalProperties');
    expect(text).not.toContain('passwordHash');
    expect(text).toContain('SUPPORT_ACCESS_FORBIDDEN');
    expect(text).toContain('platform_users.read');
  });
});
