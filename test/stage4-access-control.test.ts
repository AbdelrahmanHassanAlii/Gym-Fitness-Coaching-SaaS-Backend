import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import type { AppConfig } from '../src/config/config.types';
import { AccessControlService } from '../src/core/access-control/access-control.service';
import { AppError } from '../src/core/errors/app-error';
import type { RequestContext } from '../src/core/request-context/request-context';
import { Permissions } from '../src/modules/permissions/permission.registry';
import type { PermissionScope } from '../src/modules/permissions/permission.types';

describe('Stage 4 access control', () => {
  test('single profile ALLOW authorizes and single profile DENY denies', async () => {
    const ids = testIds();
    await expect(
      serviceWith({
        ids,
        profiles: [profile(ids, [{ permission: Permissions.StaffRead, effect: 'ALLOW' }])],
      }).authorize(ctx(ids), workspaceRequest(ids, Permissions.StaffRead)),
    ).resolves.toMatchObject({ allowed: true, source: 'PROFILE', effect: 'ALLOW' });

    await expect(
      serviceWith({
        ids,
        profiles: [profile(ids, [{ permission: Permissions.StaffRead, effect: 'DENY' }])],
      }).authorize(ctx(ids), workspaceRequest(ids, Permissions.StaffRead)),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  test('profile DENY wins over ALLOW regardless of profile order', async () => {
    const ids = testIds();
    const allowProfile = profile(ids, [
      { permission: Permissions.StaffPermissionsManage, effect: 'ALLOW' },
    ]);
    const denyProfile = profile(ids, [
      { permission: Permissions.StaffPermissionsManage, effect: 'DENY' },
    ]);

    for (const profiles of [
      [allowProfile, denyProfile],
      [denyProfile, allowProfile],
    ]) {
      await expect(
        serviceWith({ ids, profiles }).authorize(
          ctx(ids),
          workspaceRequest(ids, Permissions.StaffPermissionsManage),
        ),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
  });

  test('explicit overrides supersede profile baseline', async () => {
    const ids = testIds();
    await expect(
      serviceWith({
        ids,
        profiles: [
          profile(ids, [{ permission: Permissions.StaffPermissionsManage, effect: 'DENY' }]),
        ],
        grants: [grant(ids, Permissions.StaffPermissionsManage, 'ALLOW')],
      }).authorize(ctx(ids), workspaceRequest(ids, Permissions.StaffPermissionsManage)),
    ).resolves.toMatchObject({ source: 'EXPLICIT_GRANT', effect: 'ALLOW' });

    await expect(
      serviceWith({
        ids,
        profiles: [
          profile(ids, [{ permission: Permissions.StaffPermissionsManage, effect: 'ALLOW' }]),
        ],
        grants: [grant(ids, Permissions.StaffPermissionsManage, 'DENY')],
      }).authorize(ctx(ids), workspaceRequest(ids, Permissions.StaffPermissionsManage)),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await expect(
      serviceWith({
        ids,
        grants: [grant(ids, Permissions.StaffPermissionsManage, 'ALLOW')],
      }).authorize(ctx(ids), workspaceRequest(ids, Permissions.StaffPermissionsManage)),
    ).resolves.toMatchObject({ source: 'EXPLICIT_GRANT', effect: 'ALLOW' });

    await expect(
      serviceWith({
        ids,
        grants: [grant(ids, Permissions.StaffPermissionsManage, 'DENY')],
      }).authorize(ctx(ids), workspaceRequest(ids, Permissions.StaffPermissionsManage)),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  test('expired grants are ignored and equal-specificity DENY is order independent', async () => {
    const ids = testIds();
    const expired = new Date(Date.now() - 60_000);
    await expect(
      serviceWith({
        ids,
        grants: [grant(ids, Permissions.StaffRead, 'ALLOW', { expiresAt: expired })],
      }).authorize(ctx(ids), workspaceRequest(ids, Permissions.StaffRead)),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await expect(
      serviceWith({
        ids,
        profiles: [profile(ids, [{ permission: Permissions.StaffRead, effect: 'ALLOW' }])],
        grants: [grant(ids, Permissions.StaffRead, 'DENY', { expiresAt: expired })],
      }).authorize(ctx(ids), workspaceRequest(ids, Permissions.StaffRead)),
    ).resolves.toMatchObject({ allowed: true, source: 'PROFILE' });

    for (const effects of [
      ['ALLOW', 'DENY'],
      ['DENY', 'ALLOW'],
    ] as const) {
      await expect(
        serviceWith({
          ids,
          grants: effects.map((effect) => grant(ids, Permissions.StaffRead, effect)),
        }).authorize(ctx(ids), workspaceRequest(ids, Permissions.StaffRead)),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
  });

  test('archived profiles and unknown database-only keys cannot authorize', async () => {
    const ids = testIds();
    await expect(
      serviceWith({
        ids,
        profiles: [
          profile(ids, [{ permission: Permissions.StaffRead, effect: 'ALLOW' }], {
            status: 'ARCHIVED',
          }),
        ],
      }).authorize(ctx(ids), workspaceRequest(ids, Permissions.StaffRead)),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await expect(
      serviceWith({
        ids,
        profiles: [profile(ids, [{ permission: 'db.only.permission', effect: 'ALLOW' }])],
      }).authorize(ctx(ids), workspaceRequest(ids, 'db.only.permission')),
    ).rejects.toMatchObject({ code: 'PERMISSION_UNKNOWN' });
  });

  test('branch hard eligibility denies archived, cross-workspace, and ended assignments', async () => {
    const ids = testIds();
    const request = workspaceRequest(ids, Permissions.BranchesUpdate, {
      type: 'BRANCH',
      resourceIds: [ids.branchId],
    });
    const allow = profile(ids, [{ permission: Permissions.BranchesUpdate, effect: 'ALLOW' }]);

    await expect(
      serviceWith({
        ids,
        profiles: [allow],
        branchAssignments: [assignment(ids)],
      }).authorize(ctx(ids), request),
    ).resolves.toMatchObject({ allowed: true });

    await expect(
      serviceWith({
        ids,
        profiles: [allow],
        branches: [branch(ids, 'ARCHIVED')],
        branchAssignments: [assignment(ids)],
      }).authorize(ctx(ids), request),
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });

    await expect(
      serviceWith({
        ids,
        profiles: [allow],
        branches: [],
        branchAssignments: [assignment(ids)],
      }).authorize(ctx(ids), request),
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });

    await expect(
      serviceWith({
        ids,
        profiles: [allow],
        branchAssignments: [],
      }).authorize(ctx(ids), request),
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  });

  test('membership lifecycle and Platform MFA remain hard prerequisites', async () => {
    const ids = testIds();
    await expect(
      serviceWith({
        ids,
        workspaceMembershipStatus: 'SUSPENDED',
        profiles: [profile(ids, [{ permission: Permissions.StaffRead, effect: 'ALLOW' }])],
      }).authorize(ctx(ids), workspaceRequest(ids, Permissions.StaffRead)),
    ).rejects.toMatchObject({ code: 'WORKSPACE_MEMBERSHIP_REQUIRED' });

    await expect(
      serviceWith({
        ids,
        workspaceMembershipStatus: 'ENDED',
        grants: [grant(ids, Permissions.StaffRead, 'ALLOW')],
      }).authorize(ctx(ids), workspaceRequest(ids, Permissions.StaffRead)),
    ).rejects.toMatchObject({ code: 'WORKSPACE_MEMBERSHIP_REQUIRED' });

    const platformProfile = profile(
      ids,
      [{ permission: Permissions.PlatformPermissionsManage, effect: 'ALLOW' }],
      { context: 'PLATFORM' },
    );
    await expect(
      serviceWith({
        ids,
        profiles: [platformProfile],
        platformMembership: platformMembership(ids, 'ACTIVE', [platformProfile]),
      }).authorize(ctx(ids, { mfaSatisfied: false }), {
        context: 'PLATFORM',
        permission: Permissions.PlatformPermissionsManage,
        scope: { type: 'WORKSPACE' },
      }),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });

    await expect(
      serviceWith({
        ids,
        profiles: [platformProfile],
        platformMembership: platformMembership(ids, 'ACTIVE', [platformProfile]),
      }).authorize(ctx(ids, { mfaSatisfied: true }), {
        context: 'PLATFORM',
        permission: Permissions.PlatformPermissionsManage,
        scope: { type: 'WORKSPACE' },
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  test('effective-access inspection reflects central evaluation and excludes expired grants', async () => {
    const ids = testIds();
    const service = serviceWith({
      ids,
      profiles: [
        profile(ids, [
          { permission: Permissions.StaffRead, effect: 'ALLOW' },
          { permission: Permissions.StaffPermissionsManage, effect: 'ALLOW' },
        ]),
      ],
      grants: [
        grant(ids, Permissions.StaffRead, 'DENY', { expiresAt: new Date(Date.now() - 60_000) }),
      ],
    });

    const result = await service.effectiveAccessForWorkspaceMembership(
      ctx(ids),
      ids.workspaceId,
      ids.membershipId,
    );
    const staffRead = result.permissions.find(
      (permission) => permission.permission === Permissions.StaffRead,
    );

    expect(staffRead).toMatchObject({ allowed: true, effect: 'ALLOW', source: 'PROFILE' });
    expect(result.grants).toEqual([]);
  });
});

describe('Stage 4 route authorization metadata', () => {
  test('branch mutation routes call central access service before handlers', async () => {
    const ids = testIds();
    let handlerCalled = false;
    const calls: Array<Record<string, unknown>> = [];
    const app = await buildApp(
      routeContainer(ids, {
        async authorize(_ctx: RequestContext, input: Record<string, unknown>) {
          calls.push(input);
          throw new AppError({
            code: 'PERMISSION_DENIED',
            httpStatus: 403,
            message: 'Permission denied.',
          });
        },
        workspaces: {
          async updateBranch() {
            handlerCalled = true;
            return {};
          },
        },
      }),
    );

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${ids.workspaceId}/branches/${ids.branchId}`,
      headers: { authorization: 'Bearer valid' },
      payload: { name: 'Updated' },
    });

    expect(response.statusCode).toBe(403);
    expect(handlerCalled).toBe(false);
    expect(calls[0]).toMatchObject({
      context: 'WORKSPACE',
      permission: Permissions.BranchesUpdate,
    });
    await app.close();
  });

  test('branch mutation route allows the handler after central authorization passes', async () => {
    const ids = testIds();
    let handlerCalled = false;
    const app = await buildApp(
      routeContainer(ids, {
        async authorize() {
          return { allowed: true };
        },
        workspaces: {
          async updateBranch() {
            handlerCalled = true;
            return { ok: true };
          },
        },
      }),
    );

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${ids.workspaceId}/branches/${ids.branchId}`,
      headers: { authorization: 'Bearer valid' },
      payload: { name: 'Updated' },
    });

    expect(response.statusCode).toBe(200);
    expect(handlerCalled).toBe(true);
    await app.close();
  });
});

function serviceWith(input: {
  ids: ReturnType<typeof testIds>;
  profiles?: Array<Record<string, unknown>>;
  managementProfiles?: Array<Record<string, unknown>>;
  grants?: Array<Record<string, unknown>>;
  branches?: Array<Record<string, unknown>>;
  branchAssignments?: Array<Record<string, unknown>>;
  workspaceMembershipStatus?: 'ACTIVE' | 'SUSPENDED' | 'ENDED';
  platformMembership?: Record<string, unknown> | null;
}) {
  const profiles = input.managementProfiles ?? input.profiles ?? [];
  return new AccessControlService(
    { findActiveByUserId: async () => input.platformMembership ?? null } as never,
    { findById: async () => ({ _id: input.ids.workspaceId, status: 'ACTIVE' }) } as never,
    {
      listByIdsInWorkspace: async () => input.branches ?? [branch(input.ids, 'ACTIVE')],
    } as never,
    {
      findByIdInWorkspace: async () => ({
        _id: input.ids.membershipId,
        workspaceId: input.ids.workspaceId,
        userId: input.ids.userId,
        status: input.workspaceMembershipStatus ?? 'ACTIVE',
        permissionProfileIds: profiles.map((item) => item._id as ObjectId),
        accessVersion: 0,
      }),
      findByUserInWorkspace: async () => ({
        _id: input.ids.membershipId,
        workspaceId: input.ids.workspaceId,
        userId: input.ids.userId,
        status: input.workspaceMembershipStatus ?? 'ACTIVE',
        permissionProfileIds: profiles.map((item) => item._id as ObjectId),
        accessVersion: 0,
      }),
    } as never,
    { listActive: async () => input.branchAssignments ?? [] } as never,
    { findManyByIds: async () => profiles } as never,
    { listCurrent: async () => input.grants ?? [] } as never,
  ) as AccessControlService;
}

function testIds() {
  return {
    userId: new ObjectId(),
    workspaceId: new ObjectId(),
    membershipId: new ObjectId(),
    profileId: new ObjectId(),
    grantId: new ObjectId(),
    branchId: new ObjectId(),
    sessionId: new ObjectId(),
    platformMembershipId: new ObjectId(),
  };
}

function ctx(
  ids: ReturnType<typeof testIds>,
  options: { mfaSatisfied?: boolean } = {},
): RequestContext {
  return {
    correlationId: 'test-correlation',
    userId: ids.userId.toHexString(),
    authSessionId: ids.sessionId.toHexString(),
    ...(options.mfaSatisfied === undefined ? {} : { mfaSatisfied: options.mfaSatisfied }),
    ipAddress: '127.0.0.1',
    locale: 'en',
    timezone: 'Africa/Cairo',
  };
}

function workspaceRequest(
  ids: ReturnType<typeof testIds>,
  permission: string,
  scope: PermissionScope = { type: 'WORKSPACE' },
) {
  return {
    context: 'WORKSPACE' as const,
    workspaceId: ids.workspaceId,
    permission,
    scope,
  };
}

function profile(
  ids: ReturnType<typeof testIds>,
  permissions: Array<{ permission: string; effect: 'ALLOW' | 'DENY' }>,
  options: {
    context?: 'PLATFORM' | 'WORKSPACE';
    status?: 'ACTIVE' | 'ARCHIVED';
    workspaceId?: ObjectId;
  } = {},
) {
  return {
    _id: new ObjectId(),
    context: options.context ?? 'WORKSPACE',
    workspaceId:
      options.context === 'PLATFORM' ? undefined : (options.workspaceId ?? ids.workspaceId),
    name: 'Profile',
    permissions,
    isSystemDefault: false,
    status: options.status ?? 'ACTIVE',
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function grant(
  ids: ReturnType<typeof testIds>,
  permission: string,
  effect: 'ALLOW' | 'DENY',
  options: {
    scope?: { type: 'WORKSPACE' | 'BRANCH'; resourceIds?: ObjectId[] };
    expiresAt?: Date;
  } = {},
) {
  return {
    _id: new ObjectId(),
    context: 'WORKSPACE',
    workspaceId: ids.workspaceId,
    subjectType: 'WORKSPACE_MEMBERSHIP',
    subjectId: ids.membershipId,
    permission,
    effect,
    scope: options.scope ?? { type: 'WORKSPACE' },
    createdBy: ids.userId,
    createdAt: new Date(),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
  };
}

function branch(ids: ReturnType<typeof testIds>, status: 'ACTIVE' | 'ARCHIVED') {
  return {
    _id: ids.branchId,
    workspaceId: ids.workspaceId,
    name: 'Main',
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function assignment(ids: ReturnType<typeof testIds>) {
  return {
    _id: new ObjectId(),
    workspaceId: ids.workspaceId,
    membershipId: ids.membershipId,
    branchId: ids.branchId,
    active: true,
    startedAt: new Date(),
    createdAt: new Date(),
  };
}

function platformMembership(
  ids: ReturnType<typeof testIds>,
  status: 'ACTIVE' | 'SUSPENDED' | 'ENDED',
  profiles: Array<Record<string, unknown>>,
) {
  return {
    _id: ids.platformMembershipId,
    userId: ids.userId,
    status,
    permissionProfileIds: profiles.map((item) => item._id),
    accessVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function routeContainer(
  ids: ReturnType<typeof testIds>,
  input: {
    authorize: (ctx: RequestContext, input: Record<string, unknown>) => Promise<unknown>;
    workspaces?: Record<string, unknown>;
  },
) {
  return {
    config: testConfig(),
    database: { async ping() {} },
    jwt: {
      verifyAccessToken() {
        return {
          sub: ids.userId.toHexString(),
          sid: ids.sessionId.toHexString(),
          jti: 'jwt-id',
          iat: 1,
          exp: Date.now() + 60_000,
          amr: ['pwd'],
        };
      },
    },
    authSessions: {
      async findActive() {
        return {
          _id: ids.sessionId,
          userId: ids.userId,
          status: 'ACTIVE',
          authenticationMethods: ['pwd'],
          restrictedUntilVerified: false,
          createdAt: new Date(),
          lastSeenAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
    },
    auth: {},
    accessControl: { authorize: input.authorize },
    permissions: {},
    workspaces: {
      async me() {
        return {};
      },
      ...input.workspaces,
    },
  } as never;
}

function testConfig(): AppConfig {
  return {
    env: 'test',
    app: {
      host: '0.0.0.0',
      port: 3000,
      docsEnabled: false,
      trustProxy: false,
      allowedOrigins: [],
    },
    mongo: {
      uri: 'mongodb://localhost:27017/test',
      dbName: 'test',
      connectTimeoutMs: 500,
    },
    logging: { level: 'silent' },
    auth: {
      jwtActiveKeyId: 'test',
      jwtPrivateKey: 'unused',
      jwtPublicKeys: {},
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      webRefreshCookieSameSite: 'LAX',
      otpHmacSecret: 'test-hmac-secret',
      challengeTtlSeconds: 600,
      challengeMaxAttempts: 5,
      challengeResendCooldownSeconds: 60,
      challengeMaxSendsPerHour: 5,
      mfaChallengeTtlSeconds: 300,
      mfaChallengeMaxAttempts: 5,
      recoveryCodeCount: 10,
      totpEncryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      loginIdentifierIpWindowMs: 900_000,
      loginIdentifierIpMaxAttempts: 5,
      loginIdentifierIpBlockMs: 900_000,
      loginIpWindowMs: 900_000,
      loginIpMaxAttempts: 30,
      passwordResetIdentifierMaxPerHour: 3,
      passwordResetIpMaxPerHour: 10,
    },
    worker: {
      id: 'worker-test',
      outboxPollIntervalMs: 1000,
      outboxLockMs: 30_000,
      outboxMaxAttempts: 8,
      jobLeaseMs: 30_000,
    },
    support: {
      defaultSessionMinutes: 30,
      maxSessionMinutes: 60,
    },
  };
}
