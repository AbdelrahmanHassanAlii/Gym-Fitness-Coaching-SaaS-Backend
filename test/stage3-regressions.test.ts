import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import type { AppConfig } from '../src/config/config.types';
import type { RequestContext } from '../src/core/request-context/request-context';
import type { AuthSessionDocument } from '../src/modules/auth/auth.types';
import type { UserDocument } from '../src/modules/identity/identity.types';
import type { PlatformMembershipDocument } from '../src/modules/platform/platform.types';
import { WorkspaceMembershipRepository } from '../src/modules/workspaces/workspace.repository';
import { WorkspaceApplicationService } from '../src/modules/workspaces/workspace.service';
import type {
  BranchDocument,
  MembershipBranchAssignmentDocument,
  WorkspaceDocument,
  WorkspaceMembershipDocument,
} from '../src/modules/workspaces/workspace.types';

describe('Stage 3 regression fixes', () => {
  test('workspace membership suspension closes the open engagement period without appending', async () => {
    const collection = new RecordingMembershipCollection(
      membershipDocument({ status: 'SUSPENDED' }),
    );
    const repository = new WorkspaceMembershipRepository(fakeDatabase(collection));

    await repository.transition(
      collection.document.workspaceId,
      collection.document._id,
      ['ACTIVE'],
      'SUSPENDED',
      new Date('2026-09-08T10:00:00.000Z'),
    );

    expect(collection.lastFilter).toEqual(
      expect.objectContaining({
        _id: collection.document._id,
        workspaceId: collection.document.workspaceId,
        status: { $in: ['ACTIVE'] },
        engagementPeriods: { $elemMatch: { endedAt: { $exists: false } } },
      }),
    );
    expect(collection.lastUpdate).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'SUSPENDED',
          'engagementPeriods.$[activePeriod].endedAt': new Date('2026-09-08T10:00:00.000Z'),
        }),
      }),
    );
    expect(collection.lastUpdate?.$push).toBeUndefined();
    expect(collection.lastOptions).toEqual(
      expect.objectContaining({
        arrayFilters: [{ 'activePeriod.endedAt': { $exists: false } }],
      }),
    );
  });

  test('workspace membership resume appends one new period only when no period is open', async () => {
    const collection = new RecordingMembershipCollection(membershipDocument({ status: 'ACTIVE' }));
    const repository = new WorkspaceMembershipRepository(fakeDatabase(collection));

    await repository.transition(
      collection.document.workspaceId,
      collection.document._id,
      ['SUSPENDED', 'ENDED'],
      'ACTIVE',
      new Date('2026-09-08T11:00:00.000Z'),
    );

    expect(collection.lastFilter).toEqual(
      expect.objectContaining({
        status: { $in: ['SUSPENDED', 'ENDED'] },
        engagementPeriods: { $not: { $elemMatch: { endedAt: { $exists: false } } } },
      }),
    );
    expect(collection.lastUpdate).toEqual(
      expect.objectContaining({
        $set: { status: 'ACTIVE', updatedAt: new Date('2026-09-08T11:00:00.000Z') },
        $unset: { endedAt: '' },
        $push: { engagementPeriods: { startedAt: new Date('2026-09-08T11:00:00.000Z') } },
      }),
    );
  });

  test('workspace membership explicit reactivation is workspace-scoped and requires no open period', async () => {
    const collection = new RecordingMembershipCollection(membershipDocument({ status: 'ACTIVE' }));
    const repository = new WorkspaceMembershipRepository(fakeDatabase(collection));

    await repository.reactivate(
      collection.document.workspaceId,
      collection.document._id,
      ['TRAINER'],
      new Date('2026-09-08T12:00:00.000Z'),
    );

    expect(collection.lastFilter).toEqual(
      expect.objectContaining({
        _id: collection.document._id,
        workspaceId: collection.document.workspaceId,
        status: { $in: ['SUSPENDED', 'ENDED'] },
        engagementPeriods: { $not: { $elemMatch: { endedAt: { $exists: false } } } },
      }),
    );
    expect(collection.lastUpdate).toEqual(
      expect.objectContaining({
        $push: { engagementPeriods: { startedAt: new Date('2026-09-08T12:00:00.000Z') } },
      }),
    );
  });

  test('PATCH /me rejects forbidden identity and security fields', async () => {
    const ids = idsFixture();
    const app = await buildApp(
      routeContainer({
        user: userDocument(ids.userId),
        session: sessionDocument(ids.userId, ids.sessionId),
        workspaces: {
          async updateMe() {
            throw new Error('updateMe must not be reached for invalid profile payloads');
          },
        },
      }),
    );

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { authorization: 'Bearer valid' },
      payload: { firstName: 'Ada', emailVerifiedAt: new Date().toISOString(), passwordHash: 'x' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    await app.close();
  });

  test('missing Stage 3 endpoint routes are registered and delegate explicit route IDs', async () => {
    const ids = idsFixture();
    const calls: Array<{
      method: string;
      workspaceId?: string;
      branchId?: string;
      membershipId?: string;
    }> = [];
    const app = await buildApp(
      routeContainer({
        user: userDocument(ids.userId),
        session: sessionDocument(ids.userId, ids.sessionId),
        workspaces: {
          async updateMe(_ctx: unknown, body: Record<string, unknown>) {
            calls.push({ method: 'updateMe' });
            return { body };
          },
          async updateWorkspace(_ctx: unknown, workspaceId: string) {
            calls.push({ method: 'updateWorkspace', workspaceId });
            return { workspaceId };
          },
          async getBranch(_ctx: unknown, workspaceId: string, branchId: string) {
            calls.push({ method: 'getBranch', workspaceId, branchId });
            return { workspaceId, branchId };
          },
          async updateBranch(_ctx: unknown, workspaceId: string, branchId: string) {
            calls.push({ method: 'updateBranch', workspaceId, branchId });
            return { workspaceId, branchId };
          },
          async getMembership(_ctx: unknown, workspaceId: string, membershipId: string) {
            calls.push({ method: 'getMembership', workspaceId, membershipId });
            return { workspaceId, membershipId };
          },
        },
      }),
    );

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { authorization: 'Bearer valid' },
      payload: { firstName: 'Ada' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${ids.workspaceId}`,
      headers: { authorization: 'Bearer valid' },
      payload: { name: 'Updated Gym' },
    });
    await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ids.workspaceId}/branches/${ids.branchId}`,
      headers: { authorization: 'Bearer valid' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${ids.workspaceId}/branches/${ids.branchId}`,
      headers: { authorization: 'Bearer valid' },
      payload: { timezone: 'Africa/Cairo' },
    });
    await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ids.workspaceId}/memberships/${ids.membershipId}`,
      headers: { authorization: 'Bearer valid' },
    });

    expect(calls).toEqual([
      { method: 'updateMe' },
      { method: 'updateWorkspace', workspaceId: ids.workspaceId },
      { method: 'getBranch', workspaceId: ids.workspaceId, branchId: ids.branchId },
      { method: 'updateBranch', workspaceId: ids.workspaceId, branchId: ids.branchId },
      { method: 'getMembership', workspaceId: ids.workspaceId, membershipId: ids.membershipId },
    ]);
    await app.close();
  });

  test('workspace creation audit contains the newly created workspace ID', async () => {
    const ids = idsFixture();
    const auditWrites: Array<Record<string, unknown>> = [];
    const service = serviceWith({
      user: userDocument(ids.userId),
      platformMembership: {
        _id: ids.platformMembershipObjectId,
        userId: ids.userObjectId,
        status: 'ACTIVE',
        permissionProfileIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      workspace: workspaceDocument(ids),
      workspaceMembership: membershipDocument({ ids }),
      auditWrites,
    });

    await service.createWorkspace(requestContext(ids), {
      type: 'GYM',
      name: 'Titan Gym',
      ownerUserId: ids.userId,
      timezone: 'Africa/Cairo',
      defaultLanguage: 'en',
    });

    expect(auditWrites[0]).toEqual(
      expect.objectContaining({
        eventType: 'WorkspaceCreated',
        workspaceId: ids.workspaceObjectId,
        actor: expect.objectContaining({
          userId: ids.userObjectId,
          platformMembershipId: ids.platformMembershipObjectId,
        }),
      }),
    );
  });

  test('Platform membership creation writes audit and outbox in the same unit of work', async () => {
    const ids = idsFixture();
    const auditWrites: Array<Record<string, unknown>> = [];
    const outboxWrites: Array<Record<string, unknown>> = [];
    const targetUserId = new ObjectId();
    const createdPlatformMembershipId = new ObjectId();
    const service = serviceWith({
      user: userDocument(ids.userId),
      targetUser: userDocument(targetUserId.toHexString()),
      platformMembership: {
        _id: ids.platformMembershipObjectId,
        userId: ids.userObjectId,
        status: 'ACTIVE',
        permissionProfileIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      createdPlatformMembership: {
        _id: createdPlatformMembershipId,
        userId: targetUserId,
        status: 'ACTIVE',
        permissionProfileIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      auditWrites,
      outboxWrites,
    });

    await service.createPlatformMembership(requestContext(ids), targetUserId.toHexString());

    expect(auditWrites).toContainEqual(
      expect.objectContaining({ eventType: 'PlatformMembershipCreated' }),
    );
    expect(outboxWrites).toContainEqual(
      expect.objectContaining({
        eventType: 'PlatformMembershipCreated',
        aggregateType: 'platform_membership',
        aggregateId: createdPlatformMembershipId,
      }),
    );
  });

  test('branch assignment create and remove write outbox events', async () => {
    const ids = idsFixture();
    const outboxWrites: Array<Record<string, unknown>> = [];
    const assignmentId = new ObjectId();
    const service = serviceWith({
      user: userDocument(ids.userId),
      workspace: workspaceDocument(ids),
      workspaceMembership: membershipDocument({ ids }),
      branch: branchDocument(ids),
      assignment: {
        _id: assignmentId,
        workspaceId: ids.workspaceObjectId,
        membershipId: ids.membershipObjectId,
        branchId: ids.branchObjectId,
        active: true,
        startedAt: new Date(),
        createdAt: new Date(),
      },
      outboxWrites,
    });

    await service.assignMembershipBranch(
      requestContext(ids),
      ids.workspaceId,
      ids.membershipId,
      ids.branchId,
    );
    await service.removeMembershipBranchAssignment(
      requestContext(ids),
      ids.workspaceId,
      ids.membershipId,
      ids.branchId,
    );

    expect(outboxWrites.map((event) => event.eventType)).toEqual([
      'MembershipBranchAssigned',
      'MembershipBranchAssignmentEnded',
    ]);
  });

  test('wrong-workspace branch IDs fail before branch assignment creation', async () => {
    const ids = idsFixture();
    let createCalled = false;
    const service = serviceWith({
      user: userDocument(ids.userId),
      workspace: workspaceDocument(ids),
      workspaceMembership: membershipDocument({ ids }),
      branch: null,
      assignmentCreateHook() {
        createCalled = true;
      },
    });

    await expect(
      service.assignMembershipBranch(
        requestContext(ids),
        ids.workspaceId,
        ids.membershipId,
        ids.branchId,
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
    expect(createCalled).toBe(false);
  });

  test('Platform guard rejects missing Platform membership', async () => {
    const ids = idsFixture();
    const service = serviceWith({
      user: userDocument(ids.userId),
      platformMembership: null,
    });

    await expect(
      service.createWorkspace(requestContext(ids), {
        type: 'GYM',
        name: 'Titan Gym',
        ownerUserId: ids.userId,
        timezone: 'Africa/Cairo',
        defaultLanguage: 'en',
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_ACCESS_DENIED' });
  });

  test('Platform guard rejects active membership without server-authoritative MFA', async () => {
    const ids = idsFixture();
    const service = serviceWith({
      user: userDocument(ids.userId),
      platformMembership: platformMembershipDocument(ids, 'ACTIVE'),
    });

    await expect(
      service.createWorkspace(
        { ...requestContext(ids), mfaSatisfied: false },
        {
          type: 'GYM',
          name: 'Titan Gym',
          ownerUserId: ids.userId,
          timezone: 'Africa/Cairo',
          defaultLanguage: 'en',
        },
      ),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
  });

  test('Platform guard rejects suspended and ended Platform memberships', async () => {
    for (const status of ['SUSPENDED', 'ENDED'] as const) {
      const ids = idsFixture();
      const service = serviceWith({
        user: userDocument(ids.userId),
        platformMembership: platformMembershipDocument(ids, status),
      });

      await expect(
        service.createWorkspace(requestContext(ids), {
          type: 'GYM',
          name: 'Titan Gym',
          ownerUserId: ids.userId,
          timezone: 'Africa/Cairo',
          defaultLanguage: 'en',
        }),
      ).rejects.toMatchObject({ code: 'PLATFORM_ACCESS_DENIED' });
    }
  });

  test('Platform guard accepts recovery-code sessions when mfaSatisfied is true', async () => {
    const ids = idsFixture();
    const service = serviceWith({
      user: userDocument(ids.userId),
      platformMembership: platformMembershipDocument(ids, 'ACTIVE'),
      workspace: workspaceDocument(ids),
      workspaceMembership: membershipDocument({ ids }),
    });

    const result = await service.createWorkspace(
      { ...requestContext(ids), authenticationMethods: ['pwd', 'recovery_code'] },
      {
        type: 'GYM',
        name: 'Titan Gym',
        ownerUserId: ids.userId,
        timezone: 'Africa/Cairo',
        defaultLanguage: 'en',
      },
    );

    expect(result.workspace.id).toBe(ids.workspaceId);
  });

  test('/me/workspaces returns only active memberships whose workspaces are active', async () => {
    const ids = idsFixture();
    const inactiveIds = idsFixture();
    const inactiveWorkspaceIds = idsFixture();
    const service = serviceWith({
      user: userDocument(ids.userId),
      workspace: workspaceDocument(ids),
      workspaceMembership: membershipDocument({ ids }),
      activeMemberships: [
        membershipDocument({ ids }),
        membershipDocument({ ids: inactiveIds, status: 'SUSPENDED' }),
        membershipDocument({ ids: inactiveWorkspaceIds }),
      ],
      workspaceById(workspaceId) {
        if (workspaceId.equals(ids.workspaceObjectId)) return workspaceDocument(ids);
        if (workspaceId.equals(inactiveWorkspaceIds.workspaceObjectId)) {
          return { ...workspaceDocument(inactiveWorkspaceIds), status: 'SUSPENDED' };
        }
        return null;
      },
    });

    const result = await service.listMyWorkspaces(requestContext(ids));

    expect(result).toHaveLength(1);
    expect(result[0]?.workspace.id).toBe(ids.workspaceId);
  });
});

class RecordingMembershipCollection {
  lastFilter?: Record<string, unknown>;
  lastUpdate?: Record<string, unknown>;
  lastOptions?: Record<string, unknown>;

  constructor(readonly document: WorkspaceMembershipDocument) {}

  async insertOne() {
    return {};
  }

  find() {
    return { sort: () => ({ toArray: async () => [] }), toArray: async () => [] };
  }

  async findOne() {
    return this.document;
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>,
  ) {
    this.lastFilter = filter;
    this.lastUpdate = update;
    this.lastOptions = options;
    return this.document;
  }
}

function serviceWith(input: {
  user: UserDocument;
  targetUser?: UserDocument;
  platformMembership?: PlatformMembershipDocument | null;
  createdPlatformMembership?: PlatformMembershipDocument;
  workspace?: WorkspaceDocument;
  workspaceMembership?: WorkspaceMembershipDocument;
  activeMemberships?: WorkspaceMembershipDocument[];
  workspaceById?: (workspaceId: ObjectId) => WorkspaceDocument | null;
  branch?: BranchDocument | null;
  assignment?: MembershipBranchAssignmentDocument;
  auditWrites?: Array<Record<string, unknown>>;
  outboxWrites?: Array<Record<string, unknown>>;
  assignmentCreateHook?: () => void;
}) {
  const auditWrites = input.auditWrites ?? [];
  const outboxWrites = input.outboxWrites ?? [];
  return new WorkspaceApplicationService(
    {
      async withTransaction(operation: (tx: unknown) => Promise<unknown>) {
        return await operation({ session: 'tx' });
      },
    } as never,
    {
      async findById(userId: ObjectId) {
        if (input.targetUser?._id.equals(userId)) return input.targetUser;
        if (input.user._id.equals(userId)) return input.user;
        return null;
      },
      async updateProfile() {
        return input.user;
      },
    } as never,
    {
      async findActiveByUserId() {
        return input.platformMembership?.status === 'ACTIVE' ? input.platformMembership : null;
      },
      async findByUserId() {
        return null;
      },
      async createActive() {
        return input.createdPlatformMembership;
      },
    } as never,
    {
      async create() {
        return input.workspace;
      },
      async findById(workspaceId: ObjectId) {
        return input.workspaceById?.(workspaceId) ?? input.workspace ?? null;
      },
      async update() {
        return input.workspace;
      },
    } as never,
    {
      async createActive() {
        return input.workspaceMembership;
      },
      async findByUserInWorkspace() {
        return input.workspaceMembership ?? null;
      },
      async findByIdInWorkspace() {
        return input.workspaceMembership ?? null;
      },
      async listByWorkspace() {
        return input.workspaceMembership ? [input.workspaceMembership] : [];
      },
      async listActiveByUser() {
        return (
          input.activeMemberships?.filter((membership) => membership.status === 'ACTIVE') ?? []
        );
      },
    } as never,
    {
      async findByIdInWorkspace() {
        return input.branch ?? null;
      },
      async update() {
        return input.branch;
      },
    } as never,
    {
      async createActive() {
        input.assignmentCreateHook?.();
        return input.assignment;
      },
      async endActive() {
        return true;
      },
    } as never,
    {} as never,
    {
      randomSecret() {
        return 'secret';
      },
      hashHighEntropySecret(value: string) {
        return `digest:${value}`;
      },
    } as never,
    {
      async write(event: Record<string, unknown>) {
        auditWrites.push(event);
      },
    } as never,
    {
      async write(event: Record<string, unknown>) {
        outboxWrites.push(event);
      },
    } as never,
  );
}

function fakeDatabase(collection: RecordingMembershipCollection) {
  return {
    db: {
      collection() {
        return collection;
      },
    },
  } as never;
}

function routeContainer(input: {
  user: UserDocument;
  session: AuthSessionDocument;
  workspaces: Record<string, unknown>;
}) {
  return {
    config: testConfig(),
    database: {
      async ping() {
        return true;
      },
    },
    jwt: {
      verifyAccessToken() {
        return {
          sub: input.user._id.toHexString(),
          sid: input.session._id.toHexString(),
          jti: 'jwt-id',
          iat: 1,
          exp: Date.now() + 60_000,
          amr: input.session.authenticationMethods,
        };
      },
    },
    authSessions: {
      async findActive() {
        return input.session;
      },
    },
    accessControl: {
      async authorize() {
        return { allowed: true };
      },
    },
    auth: {},
    workspaces: {
      async me() {
        return {};
      },
      ...input.workspaces,
    },
  } as never;
}

function idsFixture() {
  const userObjectId = new ObjectId();
  const sessionObjectId = new ObjectId();
  const workspaceObjectId = new ObjectId();
  const membershipObjectId = new ObjectId();
  const branchObjectId = new ObjectId();
  const platformMembershipObjectId = new ObjectId();
  return {
    userObjectId,
    userId: userObjectId.toHexString(),
    sessionObjectId,
    sessionId: sessionObjectId.toHexString(),
    workspaceObjectId,
    workspaceId: workspaceObjectId.toHexString(),
    membershipObjectId,
    membershipId: membershipObjectId.toHexString(),
    branchObjectId,
    branchId: branchObjectId.toHexString(),
    platformMembershipObjectId,
  };
}

function userDocument(userId: string): UserDocument {
  return {
    _id: new ObjectId(userId),
    email: 'ada@example.com',
    normalizedEmail: 'ada@example.com',
    passwordHash: 'hash',
    emailVerifiedAt: new Date(),
    firstName: 'Ada',
    lastName: 'Lovelace',
    preferredLanguage: 'en',
    timezone: 'Africa/Cairo',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function sessionDocument(userId: string, sessionId: string): AuthSessionDocument {
  return {
    _id: new ObjectId(sessionId),
    userId: new ObjectId(userId),
    status: 'ACTIVE',
    clientType: 'API',
    refreshTokenTransport: 'JSON',
    ipAddress: '127.0.0.1',
    authenticationMethods: ['pwd'],
    restrictedUntilVerified: false,
    createdAt: new Date(),
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
}

function workspaceDocument(ids: ReturnType<typeof idsFixture>): WorkspaceDocument {
  return {
    _id: ids.workspaceObjectId,
    type: 'GYM',
    name: 'Titan Gym',
    ownerUserId: ids.userObjectId,
    status: 'ACTIVE',
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function membershipDocument(input: {
  ids?: ReturnType<typeof idsFixture>;
  status?: 'ACTIVE' | 'SUSPENDED' | 'ENDED';
}): WorkspaceMembershipDocument {
  const ids = input.ids ?? idsFixture();
  return {
    _id: ids.membershipObjectId,
    workspaceId: ids.workspaceObjectId,
    userId: ids.userObjectId,
    roles: ['TRAINER'],
    status: input.status ?? 'ACTIVE',
    joinedAt: new Date('2026-09-08T09:00:00.000Z'),
    engagementPeriods: [{ startedAt: new Date('2026-09-08T09:00:00.000Z') }],
    permissionProfileIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function branchDocument(ids: ReturnType<typeof idsFixture>): BranchDocument {
  return {
    _id: ids.branchObjectId,
    workspaceId: ids.workspaceObjectId,
    name: 'Main Branch',
    code: 'MAIN',
    timezone: 'Africa/Cairo',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function platformMembershipDocument(
  ids: ReturnType<typeof idsFixture>,
  status: 'ACTIVE' | 'SUSPENDED' | 'ENDED',
): PlatformMembershipDocument {
  return {
    _id: ids.platformMembershipObjectId,
    userId: ids.userObjectId,
    status,
    permissionProfileIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function requestContext(ids: ReturnType<typeof idsFixture>): RequestContext {
  return {
    userId: ids.userId,
    authSessionId: ids.sessionId,
    mfaSatisfied: true,
    restrictedUntilVerified: false,
    ipAddress: '127.0.0.1',
    locale: 'en',
    timezone: 'Africa/Cairo',
    correlationId: 'correlation-id',
  };
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
      otpHmacSecret: 'secret',
      totpEncryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      loginIdentifierIpWindowMs: 15 * 60 * 1000,
      loginIdentifierIpMaxAttempts: 5,
      loginIdentifierIpBlockMs: 15 * 60 * 1000,
      loginIpWindowMs: 15 * 60 * 1000,
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
      id: 'test',
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
