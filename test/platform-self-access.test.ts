import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import type { AppConfig } from '../src/config/config.types';
import { AccessControlService } from '../src/core/access-control/access-control.service';
import type { RequestContext } from '../src/core/request-context/request-context';
import { Permissions, permissionDefinitions } from '../src/modules/permissions/permission.registry';
import { PermissionApplicationService } from '../src/modules/permissions/permission.service';
import { PlatformMembershipRepository } from '../src/modules/platform/platform.repository';
import { WorkspaceApplicationService } from '../src/modules/workspaces/workspace.service';

describe('WEB-021 Platform self access contracts', () => {
  test('self context returns only the authenticated actor Platform membership identity', async () => {
    const ids = testIds();
    const membership = platformMembership(ids, 'SUSPENDED', 7);
    const service = workspaceService(ids, membership);

    await expect(service.platformContext(ctx(ids))).resolves.toEqual({
      context: 'PLATFORM',
      accessContext: 'USER',
      membership: {
        id: ids.platformMembershipId.toHexString(),
        status: 'SUSPENDED',
        accessVersion: 7,
        updatedAt: membership.updatedAt.toISOString(),
      },
    });
  });

  test('self context enforces real actor, unrestricted session, MFA, membership, and no support', async () => {
    const ids = testIds();
    const active = platformMembership(ids, 'ACTIVE', 4);
    await expect(workspaceService(ids, active).platformContext(ctx(ids))).resolves.toMatchObject({
      membership: { status: 'ACTIVE', accessVersion: 4 },
    });
    await expect(workspaceService(ids, null).platformContext(ctx(ids))).rejects.toMatchObject({
      code: 'PLATFORM_MEMBERSHIP_REQUIRED',
    });
    await expect(
      workspaceService(ids, active).platformContext(ctx(ids, { mfaSatisfied: false })),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
    await expect(
      workspaceService(ids, active).platformContext(ctx(ids, { restrictedUntilVerified: true })),
    ).rejects.toMatchObject({ code: 'AUTH_SESSION_RESTRICTED' });
    await expect(
      workspaceService(ids, active).platformContext(
        ctx(ids, { supportSessionId: new ObjectId().toHexString() }),
      ),
    ).rejects.toMatchObject({ code: 'SUPPORT_ACCESS_FORBIDDEN' });

    for (const status of ['SUSPENDED', 'ENDED'] as const) {
      await expect(
        workspaceService(ids, platformMembership(ids, status, 5)).platformContext(ctx(ids)),
      ).resolves.toMatchObject({ membership: { status, accessVersion: 5 } });
    }
  });

  test('Platform decisions are minimized, ordered, and version-bound', async () => {
    const ids = testIds();
    const expiresAt = new Date(Date.now() + 60_000);
    const profile = {
      _id: ids.profileId,
      context: 'PLATFORM' as const,
      name: 'Platform operator',
      permissions: [{ permission: Permissions.PlatformWorkspacesManage, effect: 'ALLOW' as const }],
      isSystemDefault: false,
      status: 'ACTIVE' as const,
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const membership = platformMembership(ids, 'ACTIVE', 7, [ids.profileId]);
    const service = accessService(
      membership,
      [profile],
      [
        {
          _id: new ObjectId(),
          context: 'PLATFORM' as const,
          subjectType: 'PLATFORM_MEMBERSHIP' as const,
          subjectId: membership._id,
          permission: Permissions.AuditPlatformRead,
          effect: 'DENY' as const,
          scope: { type: 'WORKSPACE' as const },
          createdBy: ids.userId,
          createdAt: new Date(),
          expiresAt,
        },
      ],
    );

    await expect(
      service.platformEffectiveAccessDecisions(ctx(ids), {
        expectedAccessVersion: 7,
        requests: [
          { permission: Permissions.PlatformWorkspacesManage },
          { permission: Permissions.AuditPlatformRead },
          { permission: Permissions.PlatformMembershipsRead },
        ],
      }),
    ).resolves.toEqual({
      context: 'PLATFORM',
      accessContext: 'USER',
      membershipId: ids.platformMembershipId.toHexString(),
      membershipStatus: 'ACTIVE',
      accessVersion: 7,
      validUntil: expiresAt.toISOString(),
      decisions: [
        { permission: Permissions.AuditPlatformRead, allowed: false, effect: 'DENY' },
        { permission: Permissions.PlatformMembershipsRead, allowed: false, effect: 'DENY' },
        { permission: Permissions.PlatformWorkspacesManage, allowed: true, effect: 'ALLOW' },
      ],
    });
  });

  test('Platform decisions validate membership, session, permission context, and request set', async () => {
    const ids = testIds();
    const active = platformMembership(ids, 'ACTIVE', 7);
    const request = {
      expectedAccessVersion: 7,
      requests: [{ permission: Permissions.PlatformMembershipsRead }],
    };

    await expect(
      accessService(null).platformEffectiveAccessDecisions(ctx(ids), request),
    ).rejects.toMatchObject({ code: 'PLATFORM_MEMBERSHIP_REQUIRED' });
    for (const status of ['SUSPENDED', 'ENDED'] as const) {
      await expect(
        accessService(platformMembership(ids, status, 7)).platformEffectiveAccessDecisions(
          ctx(ids),
          request,
        ),
      ).rejects.toMatchObject({ code: 'PLATFORM_MEMBERSHIP_INACTIVE' });
    }
    await expect(
      accessService(active).platformEffectiveAccessDecisions(
        ctx(ids, { mfaSatisfied: false }),
        request,
      ),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
    await expect(
      accessService(active).platformEffectiveAccessDecisions(
        ctx(ids, { supportSessionId: new ObjectId().toHexString() }),
        request,
      ),
    ).rejects.toMatchObject({ code: 'SUPPORT_ACCESS_FORBIDDEN' });
    await expect(
      accessService(active).platformEffectiveAccessDecisions(
        ctx(ids, { restrictedUntilVerified: true }),
        request,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_SESSION_RESTRICTED' });
    await expect(
      accessService(active).platformEffectiveAccessDecisions(ctx(ids), {
        ...request,
        requests: [{ permission: 'unknown.permission' }],
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_UNKNOWN', httpStatus: 422 });
    await expect(
      accessService(active).platformEffectiveAccessDecisions(ctx(ids), {
        ...request,
        requests: [{ permission: Permissions.TraineesRead }],
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_SCOPE_INVALID', httpStatus: 422 });
    await expect(
      accessService(active).platformEffectiveAccessDecisions(ctx(ids), {
        ...request,
        requests: [
          { permission: Permissions.PlatformMembershipsRead },
          { permission: Permissions.PlatformMembershipsRead },
        ],
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DECISION_REQUEST_DUPLICATE', httpStatus: 409 });

    const platformKeys = permissionDefinitions
      .filter((definition) => definition.allowedContexts.includes('PLATFORM'))
      .map((definition) => definition.key);
    const maximum = await accessService(active).platformEffectiveAccessDecisions(ctx(ids), {
      ...request,
      requests: platformKeys.slice(0, 25).map((permission) => ({ permission })),
    });
    expect(maximum.decisions).toHaveLength(25);
    await expect(
      accessService(active).platformEffectiveAccessDecisions(ctx(ids), {
        ...request,
        requests: Array.from({ length: 26 }, () => ({
          permission: Permissions.PlatformMembershipsRead,
        })),
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DECISION_BATCH_TOO_LARGE', httpStatus: 422 });
  });

  test('Workspace Route A continues to reject Platform-only permissions', async () => {
    const ids = testIds();
    await expect(
      accessService(platformMembership(ids, 'ACTIVE', 1)).currentEffectiveAccessDecisions(
        ctx(ids),
        ids.workspaceId,
        {
          expectedAccessVersion: 1,
          requests: [{ permission: Permissions.PlatformMembershipsRead, scope: 'WORKSPACE' }],
        },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_SCOPE_INVALID' });
  });

  test('Platform decisions fail closed on stale and concurrently changing access', async () => {
    const ids = testIds();
    const active = platformMembership(ids, 'ACTIVE', 7);
    const request = {
      expectedAccessVersion: 7,
      requests: [{ permission: Permissions.PlatformMembershipsRead }],
    };
    for (const expectedAccessVersion of [6, 8]) {
      await expect(
        accessService(active).platformEffectiveAccessDecisions(ctx(ids), {
          ...request,
          expectedAccessVersion,
        }),
      ).rejects.toMatchObject({ code: 'PLATFORM_MEMBERSHIP_ACCESS_VERSION_CONFLICT' });
    }
    await expect(
      accessService(active, [], [], {
        reread: platformMembership(ids, 'ACTIVE', 8),
      }).platformEffectiveAccessDecisions(ctx(ids), request),
    ).rejects.toMatchObject({ code: 'PLATFORM_MEMBERSHIP_ACCESS_VERSION_CONFLICT' });
    for (const status of ['SUSPENDED', 'ENDED'] as const) {
      await expect(
        accessService(active, [], [], {
          reread: platformMembership(ids, status, 8),
        }).platformEffectiveAccessDecisions(ctx(ids), request),
      ).rejects.toMatchObject({ code: 'PLATFORM_MEMBERSHIP_ACCESS_VERSION_CONFLICT' });
    }
  });

  test('Platform decisions suppress stale output when lifecycle changes during evaluation', async () => {
    const ids = testIds();
    const ordering: string[] = [];
    const collection = new MutablePlatformMembershipCollection(
      platformMembership(ids, 'ACTIVE', 7),
      ordering,
    );
    const memberships = new PlatformMembershipRepository(fakeDatabase(collection));
    const evaluationPaused = deferred<void>();
    const resumeEvaluation = deferred<void>();
    const service = new AccessControlService(
      memberships,
      { async findById() {} } as never,
      {} as never,
      {
        async findByUserInWorkspace() {
          return null;
        },
      } as never,
      {} as never,
      {
        async findManyByIds() {
          ordering.push('evaluation-paused');
          evaluationPaused.resolve();
          await resumeEvaluation.promise;
          ordering.push('evaluation-resumed');
          return [];
        },
      } as never,
      {
        async listCurrent() {
          return [];
        },
      } as never,
    );

    const outcomePromise = service
      .platformEffectiveAccessDecisions(ctx(ids), {
        expectedAccessVersion: 7,
        requests: [{ permission: Permissions.PlatformMembershipsRead }],
      })
      .then(
        (data) => ({ data }),
        (error: unknown) => ({ error }),
      );

    await evaluationPaused.promise;
    const transitioned = await memberships.transition(
      ids.platformMembershipId,
      ['ACTIVE'],
      'SUSPENDED',
      new Date('2026-10-09T03:00:00.000Z'),
    );
    ordering.push('mutation-committed');
    expect(transitioned).toMatchObject({ status: 'SUSPENDED', accessVersion: 8 });
    resumeEvaluation.resolve();

    const outcome = await outcomePromise;
    expect(outcome).toMatchObject({
      error: {
        code: 'PLATFORM_MEMBERSHIP_ACCESS_VERSION_CONFLICT',
        httpStatus: 409,
      },
    });
    expect('data' in outcome).toBe(false);
    expect(ordering).toEqual([
      'membership-read-initial',
      'evaluation-paused',
      'mutation-committed',
      'evaluation-resumed',
      'membership-read-final',
    ]);
  });

  test('explicit DENY wins and validUntil is the earliest relevant current expiry', async () => {
    const ids = testIds();
    const membership = platformMembership(ids, 'ACTIVE', 2);
    const unrelatedEarlier = new Date(Date.now() + 10_000);
    const earlier = new Date(Date.now() + 30_000);
    const later = new Date(Date.now() + 60_000);
    const expired = new Date(Date.now() - 30_000);
    const grants = [
      platformGrant(ids, membership, Permissions.PlatformMembershipsRead, 'ALLOW', later),
      platformGrant(ids, membership, Permissions.PlatformMembershipsRead, 'DENY', earlier),
      platformGrant(ids, membership, Permissions.AuditPlatformRead, 'ALLOW', unrelatedEarlier),
      platformGrant(ids, membership, Permissions.PlatformWorkspacesManage, 'ALLOW', expired),
    ];
    const result = await accessService(membership, [], grants).platformEffectiveAccessDecisions(
      ctx(ids),
      {
        expectedAccessVersion: 2,
        requests: [
          { permission: Permissions.PlatformMembershipsRead },
          { permission: Permissions.PlatformWorkspacesManage },
        ],
      },
    );
    expect(result.validUntil).toBe(earlier.toISOString());
    expect(result.decisions).toEqual([
      { permission: Permissions.PlatformMembershipsRead, allowed: false, effect: 'DENY' },
      { permission: Permissions.PlatformWorkspacesManage, allowed: false, effect: 'DENY' },
    ]);
  });
});

describe('WEB-021 Platform self access HTTP contracts', () => {
  test('GET /me/platform-context has a strict self-scoped response and rejects query targets', async () => {
    const ids = testIds();
    const data = {
      context: 'PLATFORM' as const,
      accessContext: 'USER' as const,
      membership: {
        id: ids.platformMembershipId.toHexString(),
        status: 'ACTIVE' as const,
        accessVersion: 3,
        updatedAt: '2026-10-09T01:00:00.000Z',
      },
    };
    const app = await buildApp(routeContainer(ids, { platformContext: async () => data }));

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/platform-context',
      headers: { authorization: 'Bearer valid' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json() as unknown).toEqual({ data });

    const targeted = await app.inject({
      method: 'GET',
      url: `/api/v1/me/platform-context?membershipId=${new ObjectId().toHexString()}`,
      headers: { authorization: 'Bearer valid' },
    });
    expect(targeted.statusCode).toBe(400);
    expect(targeted.json().error.code).toBe('VALIDATION_FAILED');
    await app.close();
  });

  test('POST /platform/me/effective-access/decisions exposes no target fields and validates shape', async () => {
    const ids = testIds();
    const calls: unknown[] = [];
    const decisions = accessService(platformMembership(ids, 'ACTIVE', 3));
    const app = await buildApp(
      routeContainer(
        ids,
        {},
        {
          async platformEffectiveAccessDecisions(_ctx: RequestContext, input: unknown) {
            calls.push(input);
            return await decisions.platformEffectiveAccessDecisions(
              ctx(ids),
              input as Parameters<typeof decisions.platformEffectiveAccessDecisions>[1],
            );
          },
        },
      ),
    );
    const validBody = {
      expectedAccessVersion: 3,
      requests: [{ permission: Permissions.PlatformMembershipsRead }],
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/me/effective-access/decisions',
      headers: { authorization: 'Bearer valid', 'idempotency-key': 'ignored-by-route' },
      payload: validBody,
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([validBody]);

    const openapi = app.swagger() as unknown as {
      paths: Record<
        string,
        { post: { requestBody: { content: { 'application/json': { schema: unknown } } } } }
      >;
    };
    const decisionOperation = openapi.paths['/api/v1/platform/me/effective-access/decisions'];
    expect(decisionOperation).toBeDefined();
    if (!decisionOperation) throw new Error('Platform decision route missing from OpenAPI');
    const requestSchema = decisionOperation.post.requestBody.content['application/json'].schema as {
      properties: { requests: { minItems?: number; maxItems?: number } };
    };
    expect(requestSchema.properties.requests).toMatchObject({ minItems: 1, maxItems: 25 });

    const platformKeys = permissionDefinitions
      .filter((definition) => definition.allowedContexts.includes('PLATFORM'))
      .map((definition) => definition.key);
    const maximum = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/me/effective-access/decisions',
      headers: { authorization: 'Bearer valid' },
      payload: {
        expectedAccessVersion: 3,
        requests: platformKeys.slice(0, 25).map((permission) => ({ permission })),
      },
    });
    expect(maximum.statusCode).toBe(200);
    expect(maximum.json().data.decisions).toHaveLength(25);

    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/me/effective-access/decisions',
      headers: { authorization: 'Bearer valid' },
      payload: {
        expectedAccessVersion: 3,
        requests: Array.from({ length: 26 }, () => ({
          permission: Permissions.PlatformMembershipsRead,
        })),
      },
    });
    expect(tooLarge.statusCode).toBe(422);
    expect(tooLarge.json().error.code).toBe('ACCESS_DECISION_BATCH_TOO_LARGE');

    for (const payload of [
      { ...validBody, membershipId: ids.platformMembershipId.toHexString() },
      { ...validBody, workspaceId: new ObjectId().toHexString() },
      { ...validBody, expectedAccessVersion: -1 },
      { expectedAccessVersion: 3, requests: [] },
      {
        expectedAccessVersion: 3,
        requests: [{ permission: 'x', userId: ids.userId.toHexString() }],
      },
    ]) {
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/v1/platform/me/effective-access/decisions',
        headers: { authorization: 'Bearer valid' },
        payload,
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('VALIDATION_FAILED');
    }
    await app.close();
  });
});

describe('WEB-021 Platform accessVersion propagation', () => {
  test('every existing Platform membership lifecycle transition increments accessVersion', async () => {
    const ids = testIds();
    for (const [from, to] of [
      ['ACTIVE', 'SUSPENDED'],
      ['SUSPENDED', 'ACTIVE'],
      ['ACTIVE', 'ENDED'],
      ['SUSPENDED', 'ENDED'],
    ] as const) {
      const collection = new RecordingPlatformMembershipCollection(platformMembership(ids, to, 8));
      const repository = new PlatformMembershipRepository(fakeDatabase(collection));
      await repository.transition(ids.platformMembershipId, [from], to, new Date());
      expect(collection.lastFilter).toMatchObject({ status: { $in: [from] } });
      expect(collection.lastUpdate).toMatchObject({ $inc: { accessVersion: 1 } });
    }
  });

  test('assigned-profile propagation updates only memberships containing that profile', async () => {
    const ids = testIds();
    const collection = new RecordingPlatformMembershipCollection(
      platformMembership(ids, 'ACTIVE', 8),
    );
    const repository = new PlatformMembershipRepository(fakeDatabase(collection));
    const now = new Date('2026-10-09T02:00:00.000Z');
    await repository.bumpAccessVersionForAssignedProfile(ids.profileId, now);
    expect(collection.lastManyFilter).toEqual({ permissionProfileIds: ids.profileId });
    expect(collection.lastManyUpdate).toEqual({
      $set: { updatedAt: now },
      $inc: { accessVersion: 1 },
    });
  });

  test('assigned-profile propagation increments affected membership and leaves unrelated version unchanged', async () => {
    const ids = testIds();
    const unrelatedIds = {
      ...ids,
      userId: new ObjectId(),
      platformMembershipId: new ObjectId(),
    };
    const affected = platformMembership(ids, 'ACTIVE', 8, [ids.profileId]);
    const unrelated = platformMembership(unrelatedIds, 'ACTIVE', 12);
    const collection = new PersistedPlatformMembershipCollection([affected, unrelated]);
    const repository = new PlatformMembershipRepository(fakeDatabase(collection));

    await repository.bumpAccessVersionForAssignedProfile(
      ids.profileId,
      new Date('2026-10-09T02:30:00.000Z'),
    );

    await expect(repository.findById(affected._id)).resolves.toMatchObject({ accessVersion: 9 });
    await expect(repository.findById(unrelated._id)).resolves.toMatchObject({ accessVersion: 12 });
  });

  test('Platform profile permission update and archive propagate, while rename-only update does not', async () => {
    const ids = testIds();
    const bumped: string[] = [];
    const service = permissionService(ids, bumped);
    await service.updateProfile(ctx(ids), ids.profileId.toHexString(), undefined, {
      expectedVersion: 0,
      permissions: [{ permission: Permissions.PlatformMembershipsRead, effect: 'ALLOW' }],
    });
    await service.updateProfile(ctx(ids), ids.profileId.toHexString(), undefined, {
      expectedVersion: 0,
      name: 'Renamed only',
    });
    await service.updateProfile(ctx(ids), ids.profileId.toHexString(), undefined, {
      expectedVersion: 0,
      permissions: [],
    });
    await service.archiveProfile(ctx(ids), ids.profileId.toHexString(), undefined, 0);
    expect(bumped).toEqual([ids.profileId.toHexString(), ids.profileId.toHexString()]);
  });

  test('explicit Platform grant replacement increments membership accessVersion before replacement', async () => {
    const ids = testIds();
    const events: string[] = [];
    const service = permissionService(ids, [], events);
    await service.replacePlatformAccess(ctx(ids), ids.platformMembershipId.toHexString(), {
      expectedVersion: 9,
      grants: [
        {
          permission: Permissions.PlatformMembershipsRead,
          effect: 'ALLOW',
          scope: { type: 'WORKSPACE' },
        },
      ],
    });
    expect(events.slice(0, 2)).toEqual(['bump:9', 'replace-grants']);
  });

  test('assigned Platform profile replacement preserves the existing CAS version bump', async () => {
    const ids = testIds();
    const events: string[] = [];
    const service = permissionService(ids, [], events);
    const result = await service.replacePlatformMembershipProfiles(
      ctx(ids),
      ids.platformMembershipId.toHexString(),
      { expectedVersion: 9, profileIds: [ids.profileId.toHexString()] },
    );
    expect(events).toContain('replace-profiles:9');
    expect(result.accessVersion).toBe(10);
  });
});

function workspaceService(
  ids: ReturnType<typeof testIds>,
  membership: ReturnType<typeof platformMembership> | null,
) {
  return new WorkspaceApplicationService(
    {} as never,
    {
      async findById(userId: ObjectId) {
        return userId.equals(ids.userId)
          ? { _id: ids.userId, status: 'ACTIVE', firstName: 'A', lastName: 'User' }
          : null;
      },
    } as never,
    {
      async findByUserId() {
        return membership;
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function accessService(
  membership: ReturnType<typeof platformMembership> | null,
  profiles: Array<Record<string, unknown>> = [],
  grants: Array<Record<string, unknown>> = [],
  options: { reread?: ReturnType<typeof platformMembership> | null } = {},
) {
  return new AccessControlService(
    {
      async findByUserId() {
        return membership;
      },
      async findById() {
        return options.reread === undefined ? membership : options.reread;
      },
    } as never,
    {
      async findById() {
        return { _id: membership?._id ?? new ObjectId(), status: 'ACTIVE' };
      },
    } as never,
    {} as never,
    {
      async findByUserInWorkspace() {
        if (!membership) return null;
        return {
          _id: membership._id,
          workspaceId: membership._id,
          userId: membership.userId,
          status: 'ACTIVE',
          permissionProfileIds: [],
          accessVersion: membership.accessVersion,
        };
      },
      async findByIdInWorkspace() {
        return null;
      },
    } as never,
    {} as never,
    {
      async findManyByIds() {
        return profiles;
      },
    } as never,
    {
      async listCurrent() {
        return grants;
      },
    } as never,
  );
}

function platformGrant(
  ids: ReturnType<typeof testIds>,
  membership: ReturnType<typeof platformMembership>,
  permission: string,
  effect: 'ALLOW' | 'DENY',
  expiresAt?: Date,
) {
  return {
    _id: new ObjectId(),
    context: 'PLATFORM' as const,
    subjectType: 'PLATFORM_MEMBERSHIP' as const,
    subjectId: membership._id,
    permission,
    effect,
    scope: { type: 'WORKSPACE' as const },
    createdBy: ids.userId,
    createdAt: new Date(),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function testIds() {
  return {
    userId: new ObjectId(),
    sessionId: new ObjectId(),
    platformMembershipId: new ObjectId(),
    profileId: new ObjectId(),
    workspaceId: new ObjectId(),
    workspaceMembershipId: new ObjectId(),
  };
}

function platformMembership(
  ids: ReturnType<typeof testIds>,
  status: 'ACTIVE' | 'SUSPENDED' | 'ENDED',
  accessVersion: number,
  permissionProfileIds: ObjectId[] = [],
) {
  return {
    _id: ids.platformMembershipId,
    userId: ids.userId,
    status,
    permissionProfileIds,
    accessVersion,
    createdAt: new Date('2026-10-09T00:00:00.000Z'),
    updatedAt: new Date('2026-10-09T01:00:00.000Z'),
  };
}

function ctx(
  ids: ReturnType<typeof testIds>,
  overrides: Partial<RequestContext> = {},
): RequestContext {
  return {
    correlationId: 'web-021-test',
    userId: ids.userId.toHexString(),
    authSessionId: ids.sessionId.toHexString(),
    mfaSatisfied: true,
    ipAddress: '127.0.0.1',
    locale: 'en',
    timezone: 'Africa/Cairo',
    ...overrides,
  };
}

function routeContainer(
  ids: ReturnType<typeof testIds>,
  workspaceOverrides: Record<string, unknown> = {},
  accessOverrides: Record<string, unknown> = {},
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
          amr: ['pwd', 'mfa'],
        };
      },
    },
    authSessions: {
      async findActive() {
        return {
          _id: ids.sessionId,
          userId: ids.userId,
          status: 'ACTIVE',
          authenticationMethods: ['pwd', 'mfa'],
          mfaSatisfiedAt: new Date(),
          restrictedUntilVerified: false,
          createdAt: new Date(),
          lastSeenAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
    },
    auth: {},
    accessControl: { authorize: async () => ({ allowed: true }), ...accessOverrides },
    permissions: {},
    workspaces: {
      async me() {
        return {};
      },
      ...workspaceOverrides,
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
    mongo: { uri: 'mongodb://localhost:27017/test', dbName: 'test', connectTimeoutMs: 500 },
    logging: { level: 'silent' },
    auth: {
      jwtActiveKeyId: 'test',
      jwtPrivateKey: 'unused',
      jwtPublicKeys: {},
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      webRefreshCookieSameSite: 'LAX',
      otpHmacSecret: 'test-hmac-secret',
      totpEncryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      loginIdentifierIpWindowMs: 900_000,
      loginIdentifierIpMaxAttempts: 5,
      loginIdentifierIpBlockMs: 900_000,
      loginIpWindowMs: 900_000,
      loginIpMaxAttempts: 30,
      challengeTtlSeconds: 600,
      challengeMaxAttempts: 5,
      challengeResendCooldownSeconds: 60,
      challengeMaxSendsPerHour: 5,
      mfaChallengeTtlSeconds: 300,
      mfaChallengeMaxAttempts: 5,
      recoveryCodeCount: 10,
      passwordResetIdentifierMaxPerHour: 3,
      passwordResetIpMaxPerHour: 10,
    },
    worker: {
      id: 'web-021-test',
      outboxPollIntervalMs: 1000,
      outboxLockMs: 30_000,
      outboxMaxAttempts: 8,
      jobLeaseMs: 30_000,
    },
    subscriptions: { trialExpiryAction: 'FROZEN', paidGraceDays: 0, frozenToExpiredDays: 30 },
    support: { defaultSessionMinutes: 30, maxSessionMinutes: 60 },
  };
}

function permissionService(
  ids: ReturnType<typeof testIds>,
  bumped: string[],
  events: string[] = [],
) {
  const existing = {
    _id: ids.profileId,
    context: 'PLATFORM' as const,
    name: 'Profile',
    permissions: [],
    isSystemDefault: false,
    status: 'ACTIVE' as const,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return new PermissionApplicationService(
    {
      async withTransaction<T>(callback: (tx: unknown) => Promise<T>) {
        return await callback({});
      },
    } as never,
    {
      async findActiveByKey(permission: string) {
        return permissionDefinitions.find((definition) => definition.key === permission) ?? null;
      },
    } as never,
    {
      async findById() {
        return existing;
      },
      async findManyByIds() {
        return [existing];
      },
      async update() {
        return { ...existing, version: 1 };
      },
      async archive() {
        return { ...existing, status: 'ARCHIVED' as const, version: 1 };
      },
    } as never,
    {
      async listCurrent() {
        return [];
      },
      async replaceCurrent(
        _subjectType: string,
        _subjectId: ObjectId,
        _context: string,
        _workspaceId: ObjectId | undefined,
        grants: Array<Record<string, unknown>>,
      ) {
        events.push('replace-grants');
        return grants.map((grant) => ({
          _id: new ObjectId(),
          context: 'PLATFORM',
          subjectType: 'PLATFORM_MEMBERSHIP',
          subjectId: ids.platformMembershipId,
          ...grant,
          createdBy: ids.userId,
          createdAt: new Date(),
        }));
      },
    } as never,
    {
      async canDelegate() {
        return true;
      },
    } as never,
    {
      async findById() {
        return platformMembership(ids, 'ACTIVE', 9);
      },
      async bumpAccessVersion(_membershipId: ObjectId, expectedVersion: number) {
        events.push(`bump:${expectedVersion}`);
        return platformMembership(ids, 'ACTIVE', expectedVersion + 1);
      },
      async replacePermissionProfiles(
        _membershipId: ObjectId,
        expectedVersion: number,
        profileIds: ObjectId[],
      ) {
        events.push(`replace-profiles:${expectedVersion}`);
        return {
          ...platformMembership(ids, 'ACTIVE', expectedVersion + 1, profileIds),
          _id: ids.platformMembershipId,
        };
      },
      async bumpAccessVersionForAssignedProfile(profileId: ObjectId) {
        bumped.push(profileId.toHexString());
        return 1;
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    { async write() {} } as never,
    { async write() {} } as never,
  );
}

class RecordingPlatformMembershipCollection {
  lastFilter?: Record<string, unknown>;
  lastUpdate?: Record<string, unknown>;
  lastManyFilter?: Record<string, unknown>;
  lastManyUpdate?: Record<string, unknown>;

  constructor(readonly document: ReturnType<typeof platformMembership>) {}

  async findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>) {
    this.lastFilter = filter;
    this.lastUpdate = update;
    return this.document;
  }

  async updateMany(filter: Record<string, unknown>, update: Record<string, unknown>) {
    this.lastManyFilter = filter;
    this.lastManyUpdate = update;
    return { modifiedCount: 1 };
  }
}

class MutablePlatformMembershipCollection {
  constructor(
    private document: ReturnType<typeof platformMembership>,
    private readonly ordering: string[],
  ) {}

  async findOne(filter: { _id?: ObjectId; userId?: ObjectId }) {
    if (filter.userId) {
      this.ordering.push('membership-read-initial');
      if (!filter.userId.equals(this.document.userId)) return null;
    }
    if (filter._id) {
      this.ordering.push('membership-read-final');
      if (!filter._id.equals(this.document._id)) return null;
    }
    return this.snapshot();
  }

  async findOneAndUpdate(
    filter: { _id: ObjectId; status: { $in: string[] } },
    update: {
      $set: Partial<ReturnType<typeof platformMembership>>;
      $inc: { accessVersion: number };
      $unset?: Record<string, string>;
    },
  ) {
    if (
      !filter._id.equals(this.document._id) ||
      !filter.status.$in.includes(this.document.status)
    ) {
      return null;
    }
    this.document = {
      ...this.document,
      ...update.$set,
      accessVersion: this.document.accessVersion + update.$inc.accessVersion,
    };
    return this.snapshot();
  }

  private snapshot() {
    return { ...this.document, permissionProfileIds: [...this.document.permissionProfileIds] };
  }
}

class PersistedPlatformMembershipCollection {
  constructor(private readonly documents: Array<ReturnType<typeof platformMembership>>) {}

  async findOne(filter: { _id?: ObjectId }) {
    const document = this.documents.find((candidate) => filter._id?.equals(candidate._id));
    return document ? this.snapshot(document) : null;
  }

  async updateMany(
    filter: { permissionProfileIds: ObjectId },
    update: { $set: { updatedAt: Date }; $inc: { accessVersion: number } },
  ) {
    let modifiedCount = 0;
    for (const document of this.documents) {
      if (
        !document.permissionProfileIds.some((profileId) =>
          profileId.equals(filter.permissionProfileIds),
        )
      ) {
        continue;
      }
      document.updatedAt = update.$set.updatedAt;
      document.accessVersion += update.$inc.accessVersion;
      modifiedCount += 1;
    }
    return { modifiedCount };
  }

  private snapshot(document: ReturnType<typeof platformMembership>) {
    return { ...document, permissionProfileIds: [...document.permissionProfileIds] };
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeDatabase(
  collection:
    | RecordingPlatformMembershipCollection
    | MutablePlatformMembershipCollection
    | PersistedPlatformMembershipCollection,
) {
  return { db: { collection: () => collection } } as never;
}
