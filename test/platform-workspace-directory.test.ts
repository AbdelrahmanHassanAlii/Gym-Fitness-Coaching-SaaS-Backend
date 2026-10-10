import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { type Db, ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import { type AppContainer, createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { AppError } from '../src/core/errors/app-error';
import { migrations } from '../src/migrations';
import { MigrationRunner } from '../src/migrations/migration-runner';
import type { AuthSessionDocument } from '../src/modules/auth/auth.types';
import type { UserDocument } from '../src/modules/identity/identity.types';
import { Permissions } from '../src/modules/permissions/permission.registry';

const INTEGRATION_TIMEOUT_MS = 30_000;
let integrationContainer: AppContainer | undefined;
let integrationApp: FastifyInstance | undefined;

beforeAll(async () => {
  integrationContainer = await createAppContainer(
    integrationConfig(`platform_workspace_directory_${new ObjectId()}`),
  );
  await new MigrationRunner(integrationContainer.database.db, migrations).migrate();
  integrationApp = await buildApp(integrationContainer);
}, INTEGRATION_TIMEOUT_MS);

afterEach(async () => {
  if (!integrationContainer) return;
  const collections = await integrationContainer.database.db.listCollections().toArray();
  for (const collection of collections) {
    if (collection.name === 'db_migrations') continue;
    await integrationContainer.database.db.collection(collection.name).deleteMany({});
  }
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (integrationApp) await integrationApp.close();
  if (integrationContainer) {
    await integrationContainer.database.db.dropDatabase();
    await integrationContainer.database.close();
  }
}, INTEGRATION_TIMEOUT_MS);

describe('Platform workspace directory HTTP contract', () => {
  test('returns the bounded directory envelope through the Platform route', async () => {
    const userId = new ObjectId();
    const session = activeSession(userId);
    const row = {
      id: new ObjectId().toHexString(),
      name: 'Atlas Gym',
      status: 'ACTIVE' as const,
      createdAt: '2026-10-09T10:00:00.000Z',
    };
    const app = await buildApp(
      fakeContainer({
        user: activeUser(userId),
        session,
        listPlatformWorkspaceDirectory: async () => ({
          data: [row],
          meta: { nextCursor: null, hasMore: false },
        }),
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/workspaces?limit=50',
      headers: { authorization: 'Bearer valid' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json() as unknown).toEqual({
      data: [row],
      meta: { nextCursor: null, hasMore: false },
    });
    await app.close();
  });

  test('rejects resolved support context before authorization or directory access', async () => {
    const userId = new ObjectId();
    const calls: string[] = [];
    const app = await buildApp(
      fakeContainer({
        user: activeUser(userId),
        session: activeSession(userId),
        resolveSupportContext: async (ctx) => {
          ctx.supportSessionId = new ObjectId().toHexString();
        },
        authorize: async () => {
          calls.push('authorize');
          return { allowed: true };
        },
        listPlatformWorkspaceDirectory: async () => {
          calls.push('directory');
          return { data: [], meta: { nextCursor: null, hasMore: false } };
        },
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/workspaces',
      headers: {
        authorization: 'Bearer valid',
        'x-support-session-id': new ObjectId().toHexString(),
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('SUPPORT_ACCESS_FORBIDDEN');
    expect(calls).toEqual([]);
    await app.close();
  });

  test('uses the existing Platform permission and preserves route-level auth failures', async () => {
    const userId = new ObjectId();
    const authorizationRequests: unknown[] = [];
    const session = activeSession(userId);
    const app = await buildApp(
      fakeContainer({
        user: activeUser(userId),
        session,
        authorize: async (_ctx, request) => {
          authorizationRequests.push(request);
          throw new AppError({ code: 'PERMISSION_DENIED', httpStatus: 403, message: 'Denied.' });
        },
        listPlatformWorkspaceDirectory: async () => ({
          data: [],
          meta: { nextCursor: null, hasMore: false },
        }),
      }),
    );

    const missing = await app.inject({ method: 'GET', url: '/api/v1/platform/workspaces' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe('AUTH_REQUIRED');

    session.restrictedUntilVerified = true;
    const restricted = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/workspaces',
      headers: { authorization: 'Bearer valid' },
    });
    expect(restricted.statusCode).toBe(403);
    expect(restricted.json().error.code).toBe('AUTH_SESSION_RESTRICTED');

    session.restrictedUntilVerified = false;
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/workspaces',
      headers: { authorization: 'Bearer valid' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('PERMISSION_DENIED');
    expect(authorizationRequests).toEqual([
      {
        context: 'PLATFORM',
        permission: Permissions.PlatformWorkspacesManage,
        scope: { type: 'WORKSPACE' },
      },
    ]);
    await app.close();
  });

  test('publishes strict OpenAPI query, response, and error contracts', async () => {
    const userId = new ObjectId();
    const app = await buildApp(
      fakeContainer({
        user: activeUser(userId),
        session: activeSession(userId),
        listPlatformWorkspaceDirectory: async () => ({
          data: [],
          meta: { nextCursor: null, hasMore: false },
        }),
      }),
    );
    await app.ready();
    const document = app.swagger() as unknown as {
      paths: Record<
        string,
        {
          get: {
            parameters: Array<{ name: string; schema: Record<string, unknown> }>;
            responses: Record<string, unknown>;
          };
        }
      >;
    };
    const operation = document.paths['/api/v1/platform/workspaces']?.get;
    expect(operation).toBeDefined();
    expect(operation?.parameters.map((parameter) => parameter.name)).toEqual(['cursor', 'limit']);
    expect(
      operation?.parameters.find((parameter) => parameter.name === 'limit')?.schema,
    ).toMatchObject({ type: 'integer', minimum: 1, maximum: 100, default: 50 });
    expect(Object.keys(operation?.responses ?? {})).toEqual(['200', '400', '401', '403', '422']);
    await app.close();
  });
});

describe('Platform workspace directory integration', () => {
  test(
    'enforces MFA, active Platform membership, and effective permission',
    async () => {
      const mfaMissing = await seedPlatformActor({ mfaSatisfied: false });
      expect((await directory(mfaMissing.token)).json().error.code).toBe('TWO_FACTOR_REQUIRED');

      await clearBusinessCollections();
      const noMembership = await seedPlatformActor({ membership: false });
      expect((await directory(noMembership.token)).json().error.code).toBe(
        'PLATFORM_MEMBERSHIP_REQUIRED',
      );

      await clearBusinessCollections();
      const inactive = await seedPlatformActor({ membershipStatus: 'SUSPENDED' });
      expect((await directory(inactive.token)).json().error.code).toBe(
        'PLATFORM_MEMBERSHIP_REQUIRED',
      );

      await clearBusinessCollections();
      const denied = await seedPlatformActor({ allow: false });
      expect((await directory(denied.token)).json().error.code).toBe('PERMISSION_DENIED');

      await clearBusinessCollections();
      const allowed = await seedPlatformActor();
      const response = await directory(allowed.token);
      expect(response.statusCode).toBe(200);
      expect(response.json() as unknown).toEqual({
        data: [],
        meta: { nextCursor: null, hasMore: false },
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'strictly validates query parameters, limits, and cursors',
    async () => {
      const actor = await seedPlatformActor();
      for (const query of [
        'limit=0',
        'limit=-1',
        'limit=1.5',
        'limit=nope',
        'limit=101',
        'search=x',
      ]) {
        const response = await directory(actor.token, query);
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('VALIDATION_FAILED');
      }
      for (const cursor of ['', 'not-an-object-id', new ObjectId().toHexString().toUpperCase()]) {
        const response = await directory(actor.token, `cursor=${encodeURIComponent(cursor)}`);
        expect(response.statusCode).toBe(422);
        expect(response.json().error.code).toBe('CURSOR_INVALID');
      }
      expect((await directory(actor.token, 'limit=100')).statusCode).toBe(200);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'uses exact limit and limit-plus-one semantics with a default limit of 50',
    async () => {
      const actor = await seedPlatformActor();
      await seedWorkspaces(51);
      const defaultPage = await directory(actor.token);
      expect(defaultPage.json().data).toHaveLength(50);
      expect(defaultPage.json().meta.hasMore).toBe(true);
      expect(defaultPage.json().meta.nextCursor).toBe(defaultPage.json().data[49].id);

      await integrationDb().collection('workspaces').deleteMany({});
      await seedWorkspaces(2);
      const exact = await directory(actor.token, 'limit=2');
      expect(exact.json().data).toHaveLength(2);
      expect(exact.json().meta).toEqual({ nextCursor: null, hasMore: false });

      await integrationDb().collection('workspaces').deleteMany({});
      await seedWorkspaces(3);
      const overflow = await directory(actor.token, 'limit=2');
      expect(overflow.json().data).toHaveLength(2);
      expect(overflow.json().meta).toEqual({
        nextCursor: overflow.json().data[1].id,
        hasMore: true,
      });
      const replayOne = await directory(
        actor.token,
        `limit=2&cursor=${overflow.json().meta.nextCursor}`,
      );
      const replayTwo = await directory(
        actor.token,
        `limit=2&cursor=${overflow.json().meta.nextCursor}`,
      );
      expect(replayOne.json()).toEqual(replayTwo.json());
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'traverses multiple pages in _id DESC order without duplicates or missing rows',
    async () => {
      const actor = await seedPlatformActor();
      const ids = await seedWorkspaces(7);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const response = await directory(
          actor.token,
          `limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        );
        expect(response.statusCode).toBe(200);
        const body = response.json();
        seen.push(...body.data.map((row: { id: string }) => row.id));
        cursor = body.meta.nextCursor;
        if (cursor) expect(body.meta.hasMore).toBe(true);
        else expect(body.meta.hasMore).toBe(false);
      } while (cursor);

      expect(seen).toEqual(ids.map((id) => id.toHexString()).reverse());
      expect(new Set(seen).size).toBe(7);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'keeps pre-existing traversal consistent across a newer insert and shows it after refresh',
    async () => {
      const actor = await seedPlatformActor();
      const ids = await seedWorkspaces(5);
      const first = await directory(actor.token, 'limit=2');
      const firstBody = first.json();
      const inserted = new ObjectId('ffffffffffffffffffffffff');
      await insertWorkspace(inserted, 'Inserted after page one', 'ACTIVE');
      const remainder: string[] = [];
      let cursor: string | null = firstBody.meta.nextCursor;
      while (cursor) {
        const response = await directory(actor.token, `limit=2&cursor=${cursor}`);
        const body = response.json();
        remainder.push(...body.data.map((row: { id: string }) => row.id));
        cursor = body.meta.nextCursor;
      }

      const firstIds = firstBody.data.map((row: { id: string }) => row.id);
      expect(new Set([...firstIds, ...remainder]).size).toBe(5);
      expect([...firstIds, ...remainder]).toEqual(ids.map((id) => id.toHexString()).reverse());
      expect(remainder).not.toContain(firstIds[0]);
      expect((await directory(actor.token, 'limit=2')).json().data[0].id).toBe(
        inserted.toHexString(),
      );
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'returns every workspace status and exactly the four public row fields',
    async () => {
      const actor = await seedPlatformActor();
      const statuses = [
        'PENDING_ACTIVATION',
        'ACTIVE',
        'RESTRICTED',
        'SUSPENDED',
        'ARCHIVED',
      ] as const;
      for (const [index, status] of statuses.entries()) {
        await insertWorkspace(objectIdFor(index + 1), `Workspace ${status}`, status);
      }
      const response = await directory(actor.token, 'limit=10');
      expect(response.statusCode).toBe(200);
      const rows = response.json().data as Array<Record<string, unknown>>;
      expect(rows.map((row) => row.status).sort()).toEqual([...statuses].sort());
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'name', 'status']);
        expect(row).not.toHaveProperty('ownerUserId');
        expect(row).not.toHaveProperty('type');
        expect(row).not.toHaveProperty('timezone');
        expect(row).not.toHaveProperty('defaultLanguage');
        expect(row).not.toHaveProperty('country');
        expect(row).not.toHaveProperty('city');
        expect(row).not.toHaveProperty('governorate');
        expect(row).not.toHaveProperty('subscription');
        expect(row).not.toHaveProperty('counts');
        expect(row).not.toHaveProperty('policies');
        expect(row).not.toHaveProperty('memberships');
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

function fakeContainer(input: {
  user: UserDocument;
  session: AuthSessionDocument;
  listPlatformWorkspaceDirectory: (query: { cursor?: string; limit?: number }) => Promise<unknown>;
  resolveSupportContext?: (ctx: { supportSessionId?: string }) => Promise<void>;
  authorize?: (ctx: unknown, request: unknown) => Promise<unknown>;
}) {
  return {
    config: testConfig(),
    database: { async ping() {} },
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
      authorize: input.authorize ?? (async () => ({ allowed: true })),
    },
    supportAccess: {
      resolveForRequest: input.resolveSupportContext ?? (async () => {}),
    },
    auth: {},
    workspaces: {
      listPlatformWorkspaceDirectory: input.listPlatformWorkspaceDirectory,
    },
  } as never;
}

function activeUser(userId: ObjectId): UserDocument {
  const now = new Date();
  return {
    _id: userId,
    email: 'platform@example.test',
    normalizedEmail: 'platform@example.test',
    passwordHash: 'hash',
    firstName: 'Platform',
    lastName: 'Admin',
    preferredLanguage: 'en',
    timezone: 'Africa/Cairo',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };
}

function activeSession(userId: ObjectId): AuthSessionDocument {
  const now = new Date();
  return {
    _id: new ObjectId(),
    userId,
    status: 'ACTIVE',
    refreshTokenTransport: 'JSON',
    authenticationMethods: ['pwd'],
    restrictedUntilVerified: false,
    mfaSatisfiedAt: now,
    ipAddress: '127.0.0.1',
    clientType: 'API',
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
  };
}

function testConfig(): AppConfig {
  return {
    env: 'test',
    app: {
      host: '127.0.0.1',
      port: 0,
      docsEnabled: false,
      trustProxy: false,
      allowedOrigins: [],
    },
    logging: { level: 'silent' },
  } as unknown as AppConfig;
}

function integrationConfig(dbName: string): AppConfig {
  return {
    env: 'test',
    app: {
      host: '127.0.0.1',
      port: 0,
      docsEnabled: false,
      trustProxy: false,
      allowedOrigins: [],
    },
    mongo: { uri: mongoUri(), dbName, connectTimeoutMs: 500 },
    logging: { level: 'silent' },
    audit: { retentionPolicy: 'INDEFINITE' },
    auth: {
      jwtActiveKeyId: 'local',
      jwtPrivateKey: [
        '-----BEGIN PRIVATE KEY-----',
        'MC4CAQAwBQYDK2VwBCIEIP27WzZ2lrwob/CusOSRmtVPlS0TPTrBOFjTuBztUPm8',
        '-----END PRIVATE KEY-----',
      ].join('\n'),
      jwtPublicKeys: {
        local: [
          '-----BEGIN PUBLIC KEY-----',
          'MCowBQYDK2VwAyEAVk4E+7jo4OHXHcYC1lvT+vqaViaFNdUPnMcuSDPpp60=',
          '-----END PUBLIC KEY-----',
        ].join('\n'),
      },
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      webRefreshCookieSameSite: 'LAX',
      otpHmacSecret: 'secret',
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
      id: 'test',
      outboxPollIntervalMs: 1000,
      outboxLockMs: 30_000,
      outboxMaxAttempts: 8,
      jobLeaseMs: 30_000,
    },
    notifications: { deliveryBatchSize: 25, deliveryClaimMs: 60_000, deliveryMaxAttempts: 5 },
    subscriptions: { trialExpiryAction: 'FROZEN', paidGraceDays: 0, frozenToExpiredDays: 30 },
    support: { defaultSessionMinutes: 30, maxSessionMinutes: 60 },
  };
}

function appInstance(): FastifyInstance {
  if (!integrationApp) throw new Error('Integration app is not initialized.');
  return integrationApp;
}

function containerInstance(): AppContainer {
  if (!integrationContainer) throw new Error('Integration container is not initialized.');
  return integrationContainer;
}

function integrationDb(): Db {
  return containerInstance().database.db;
}

async function clearBusinessCollections() {
  const collections = await integrationDb().listCollections().toArray();
  for (const collection of collections) {
    if (collection.name === 'db_migrations') continue;
    await integrationDb().collection(collection.name).deleteMany({});
  }
}

async function seedPlatformActor(
  options: {
    allow?: boolean;
    membership?: boolean;
    membershipStatus?: 'ACTIVE' | 'SUSPENDED';
    mfaSatisfied?: boolean;
  } = {},
) {
  const now = new Date();
  const userId = new ObjectId();
  const profileId = new ObjectId();
  await integrationDb().collection('users').insertOne(activeUser(userId));
  if (options.membership !== false) {
    if (options.allow !== false) {
      await integrationDb()
        .collection('permission_profiles')
        .insertOne({
          _id: profileId,
          context: 'PLATFORM',
          name: `Directory profile ${profileId.toHexString()}`,
          permissions: [{ permission: Permissions.PlatformWorkspacesManage, effect: 'ALLOW' }],
          isSystemDefault: false,
          status: 'ACTIVE',
          version: 0,
          createdAt: now,
          updatedAt: now,
        });
    }
    await integrationDb()
      .collection('platform_memberships')
      .insertOne({
        _id: new ObjectId(),
        userId,
        status: options.membershipStatus ?? 'ACTIVE',
        permissionProfileIds: options.allow === false ? [] : [profileId],
        accessVersion: 0,
        createdAt: now,
        updatedAt: now,
      });
  }
  const session = await containerInstance().authSessions.create({
    userId,
    authenticationMethods: ['pwd'],
    restrictedUntilVerified: false,
    ipAddress: '127.0.0.1',
    clientType: 'API',
    transport: 'JSON',
    ...(options.mfaSatisfied === false ? {} : { mfaSatisfiedAt: now }),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
  });
  return {
    token: containerInstance().jwt.createAccessToken({
      userId: userId.toHexString(),
      authSessionId: session._id.toHexString(),
      authenticationMethods: ['pwd'],
    }),
  };
}

async function directory(token: string, query = '') {
  return await appInstance().inject({
    method: 'GET',
    url: `/api/v1/platform/workspaces${query ? `?${query}` : ''}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function seedWorkspaces(count: number) {
  const ids = Array.from({ length: count }, (_, index) => objectIdFor(index + 1));
  for (const [index, id] of ids.entries()) {
    await insertWorkspace(id, `Workspace ${index + 1}`, 'ACTIVE');
  }
  return ids;
}

function objectIdFor(sequence: number) {
  return new ObjectId(sequence.toString(16).padStart(24, '0'));
}

async function insertWorkspace(
  id: ObjectId,
  name: string,
  status: 'PENDING_ACTIVATION' | 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED' | 'ARCHIVED',
) {
  const now = new Date('2026-10-09T10:00:00.000Z');
  await integrationDb()
    .collection('workspaces')
    .insertOne({
      _id: id,
      type: 'GYM',
      name,
      ownerUserId: new ObjectId(),
      status,
      timezone: 'Africa/Cairo',
      defaultLanguage: 'en',
      country: 'EG',
      city: 'Cairo',
      governorate: 'Cairo',
      subscription: { plan: 'SHOULD_NOT_LEAK' },
      counts: { staff: 99 },
      policies: ['SHOULD_NOT_LEAK'],
      memberships: ['SHOULD_NOT_LEAK'],
      createdAt: now,
      updatedAt: now,
    });
}

function mongoUri() {
  return (
    process.env.MONGODB_URI ??
    'mongodb://localhost:27017/gym_platform?replicaSet=rs0&directConnection=true'
  );
}
