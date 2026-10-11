import { afterAll, afterEach, beforeAll, expect, spyOn } from 'bun:test';
import { ObjectId } from 'mongodb';
import type { UserStatus } from '../src/modules/identity/identity.types';
import { Permissions } from '../src/modules/permissions/permission.registry';
import type { PlatformMembershipStatus } from '../src/modules/platform/platform.types';
import {
  type SummaryHarness,
  summaryGet,
  summaryHarness,
} from './platform-workspace-summary.helpers';

export function userReadHarness(prefix: string) {
  let h: SummaryHarness;
  beforeAll(async () => {
    h = await summaryHarness(prefix);
  }, 30_000);
  afterEach(async () => {
    if (h) await h.clear();
  }, 30_000);
  afterAll(async () => {
    if (h) await h.close();
  }, 30_000);
  return () => h;
}

export async function member(
  h: SummaryHarness,
  options: {
    userId?: ObjectId;
    membershipId?: ObjectId;
    status?: UserStatus;
    membershipStatus?: PlatformMembershipStatus;
    firstName?: string;
    lastName?: string;
    email?: string | null;
    membership?: boolean;
  } = {},
) {
  const userId = options.userId ?? new ObjectId();
  const membershipId = options.membershipId ?? new ObjectId();
  const now = new Date('2026-10-11T10:00:00.000Z');
  const email = options.email === undefined ? `member-${userId}@example.com` : options.email;
  await h.db.collection('users').insertOne({
    _id: userId,
    firstName: options.firstName ?? 'Hassan',
    lastName: options.lastName ?? 'Member',
    ...(email === null ? {} : { email, normalizedEmail: email.trim().toLowerCase() }),
    status: options.status ?? 'ACTIVE',
    createdAt: now,
    updatedAt: now,
    passwordHash: 'NEVER-EXPOSE',
    passwordUpdatedAt: now,
    phone: '+201000000000',
    normalizedPhone: `+${userId}`,
    emailVerifiedAt: now,
    phoneVerifiedAt: now,
    preferredLanguage: 'ar',
    timezone: 'Africa/Cairo',
    authMetadata: { secret: 'NEVER-EXPOSE' },
  });
  if (options.membership !== false)
    await h.db.collection('platform_memberships').insertOne({
      _id: membershipId,
      userId,
      status: options.membershipStatus ?? 'ACTIVE',
      createdAt: now,
      updatedAt: now,
      suspendedAt: now,
      endedAt: now,
      permissionProfileIds: [new ObjectId()],
      accessVersion: 27,
      grants: ['NEVER-EXPOSE'],
    });
  return { userId, membershipId, now };
}

export async function allowed(h: SummaryHarness) {
  return await h.actor(Permissions.PlatformMembershipsRead);
}
export { summaryGet };

export async function assertUserReadAuthority(h: SummaryHarness, path: string) {
  expect((await summaryGet(h.app, path)).statusCode).toBe(401);
  for (const [options, code] of [
    [{ restricted: true }, 'AUTH_SESSION_RESTRICTED'],
    [{ mfa: false }, 'TWO_FACTOR_REQUIRED'],
    [{ membership: false }, 'PLATFORM_MEMBERSHIP_REQUIRED'],
    [{ membershipStatus: 'SUSPENDED' }, 'PLATFORM_MEMBERSHIP_REQUIRED'],
    [{ membershipStatus: 'ENDED' }, 'PLATFORM_MEMBERSHIP_REQUIRED'],
    [{ deny: true }, 'PERMISSION_DENIED'],
  ] as const) {
    const actor = await h.actor(Permissions.PlatformMembershipsRead, options);
    const result = await summaryGet(h.app, path, actor.token);
    expect(result.statusCode).toBe(403);
    expect(result.json().error.code).toBe(code);
  }
  const wrong = await h.actor(Permissions.PlatformMembershipsManage);
  expect((await summaryGet(h.app, path, wrong.token)).statusCode).toBe(403);
  for (const roles of [['GYM_OWNER'], ['TRAINER'], ['TRAINEE']]) {
    const actor = await h.actor(Permissions.PlatformMembershipsRead, { membership: false });
    await h.db.collection('workspace_memberships').insertOne({
      _id: new ObjectId(),
      userId: actor.userId,
      workspaceId: new ObjectId(),
      status: 'ACTIVE',
      roles,
    });
    expect((await summaryGet(h.app, path, actor.token)).statusCode).toBe(403);
  }
  const actor = await allowed(h);
  const result = await summaryGet(h.app, path, actor.token);
  expect(result.statusCode).toBe(200);
  expect(result.headers['cache-control']).toBe('private, no-store');
}

export async function assertUserSupportDenial(h: SummaryHarness, path: string) {
  const actor = await allowed(h);
  const resolve = spyOn(h.container.supportAccess, 'resolveForRequest').mockImplementation(
    async (ctx) => {
      ctx.supportSessionId = new ObjectId().toHexString();
      // The request hook uses the resolved context, not the returned record.
      return { session: { _id: new ObjectId() } } as Awaited<
        ReturnType<typeof h.container.supportAccess.resolveForRequest>
      >;
    },
  );
  const authorize = spyOn(h.container.accessControl, 'authorize');
  try {
    // A resolved support request must stop before the service and its target reads.
    const directory = spyOn(h.container.platformUsers, 'directory');
    const detail = spyOn(h.container.platformUsers, 'detail');
    try {
      const response = await h.app.inject({
        method: 'GET',
        url: path,
        headers: {
          authorization: `Bearer ${actor.token}`,
          'x-support-session-id': 'resolved-support',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('SUPPORT_ACCESS_FORBIDDEN');
      expect(authorize).not.toHaveBeenCalled();
      expect(directory).not.toHaveBeenCalled();
      expect(detail).not.toHaveBeenCalled();
    } finally {
      directory.mockRestore();
      detail.mockRestore();
    }
  } finally {
    resolve.mockRestore();
    authorize.mockRestore();
  }
}
