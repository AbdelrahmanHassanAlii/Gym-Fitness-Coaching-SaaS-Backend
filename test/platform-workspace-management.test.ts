import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { type Db, MongoClient, ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import { type AppContainer, createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { migrations } from '../src/migrations';
import { migration025PlatformWorkspaceManagement } from '../src/migrations/025-platform-workspace-management';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { Permissions } from '../src/modules/permissions/permission.registry';
import { workspaceNameSearchPrefixes } from '../src/modules/workspaces/workspace-search';

const TIMEOUT = 30_000;
interface InjectResponse {
  statusCode: number;
  json(): {
    data: { workspace: Record<string, unknown> };
    error: { code: string };
  };
}
let container: AppContainer;
let app: FastifyInstance;

beforeAll(async () => {
  container = await createAppContainer(config(`platform_workspace_management_${new ObjectId()}`));
  await new MigrationRunner(container.database.db, migrations).migrate();
  app = await buildApp(container);
}, TIMEOUT);

afterEach(async () => {
  for (const collection of await container.database.db.listCollections().toArray()) {
    if (collection.name !== 'db_migrations') {
      await container.database.db.collection(collection.name).deleteMany({});
    }
  }
}, TIMEOUT);

afterAll(async () => {
  await app.close();
  await container.database.db.dropDatabase();
  await container.database.close();
}, TIMEOUT);

describe('Platform workspace management contracts', () => {
  test('creates exactly once, revalidates the owner in the transaction, and returns a minimized versioned DTO', async () => {
    const actor = await seedPlatformActor();
    const owner = await seedUser('owner@example.com');
    const body = {
      type: 'GYM',
      name: 'Atlas Gym',
      ownerUserId: owner.toHexString(),
      timezone: 'Africa/Cairo',
      defaultLanguage: 'en',
      country: 'EG',
    };
    const first = await command(
      'POST',
      '/api/v1/platform/workspaces',
      actor.token,
      body,
      'create-1',
    );
    const replay = await command(
      'POST',
      '/api/v1/platform/workspaces',
      actor.token,
      body,
      'create-1',
    );
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(Object.keys(first.json().data.workspace).sort()).toEqual(
      [
        'country',
        'createdAt',
        'defaultLanguage',
        'id',
        'name',
        'status',
        'timezone',
        'type',
        'version',
      ].sort(),
    );
    expect(first.json().data.workspace).toMatchObject({ status: 'ACTIVE', version: 0 });
    expect(await db().collection('workspaces').countDocuments()).toBe(1);
    expect(await db().collection('workspace_memberships').countDocuments()).toBe(1);
    expect(
      await db().collection('audit_events').countDocuments({ eventType: 'WorkspaceCreated' }),
    ).toBe(1);
    expect(
      await db().collection('outbox_events').countDocuments({ eventType: 'WorkspaceCreated' }),
    ).toBe(1);
    const mismatch = await command(
      'POST',
      '/api/v1/platform/workspaces',
      actor.token,
      { ...body, name: 'Different Gym' },
      'create-1',
    );
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('rejects support, invalid timezone, and an owner made inactive before authoritative create', async () => {
    const actor = await seedPlatformActor();
    const owner = await seedUser('owner@example.com');
    const body = {
      type: 'GYM',
      name: 'Atlas Gym',
      ownerUserId: owner.toHexString(),
      timezone: 'Not/AZone',
      defaultLanguage: 'en',
    };
    const invalid = await command(
      'POST',
      '/api/v1/platform/workspaces',
      actor.token,
      body,
      'bad-zone',
    );
    expect(invalid.statusCode).toBe(400);
    await db()
      .collection('users')
      .updateOne({ _id: owner }, { $set: { status: 'SUSPENDED' } });
    const inactive = await command(
      'POST',
      '/api/v1/platform/workspaces',
      actor.token,
      { ...body, timezone: 'UTC' },
      'inactive-owner',
    );
    expect(inactive.statusCode).toBe(404);
    expect(await db().collection('workspaces').countDocuments()).toBe(0);
    const originalResolve = container.supportAccess.resolveForRequest.bind(container.supportAccess);
    container.supportAccess.resolveForRequest = async (ctx) => {
      ctx.supportSessionId = new ObjectId().toHexString();
      return {} as never;
    };
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/v1/platform/workspaces',
        headers: {
          authorization: `Bearer ${actor.token}`,
          'idempotency-key': 'support-create',
          'x-support-session-id': new ObjectId().toHexString(),
        },
        payload: { ...body, timezone: 'UTC' },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('SUPPORT_ACCESS_FORBIDDEN');
    } finally {
      container.supportAccess.resolveForRequest = originalResolve;
    }
  });

  test('lists only ACTIVE minimized owner candidates using bounded opaque keyset pagination and exact email search', async () => {
    const actor = await seedPlatformActor();
    const first = await seedUser('first@example.com', 'ACTIVE', 'First', 'Owner');
    await seedUser('inactive@example.com', 'SUSPENDED');
    for (let index = 0; index < 2; index += 1) await seedUser(`user${index}@example.com`);
    const page = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/workspace-owner-candidates?limit=2',
      headers: { authorization: `Bearer ${actor.token}` },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().data).toHaveLength(2);
    expect(page.json().meta.hasMore).toBe(true);
    expect(Object.keys(page.json().data[0]).sort()).toEqual(['displayName', 'email', 'id']);
    const searched = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/workspace-owner-candidates?q=FIRST%40EXAMPLE.COM',
      headers: { authorization: `Bearer ${actor.token}` },
    });
    expect(searched.json().data).toEqual([
      { id: first.toHexString(), displayName: 'First Owner', email: 'first@example.com' },
    ]);
  });

  test('reassigns ownership with CAS, maintains one authoritative owner, and replays idempotently', async () => {
    const actor = await seedPlatformActor();
    const oldOwner = await seedUser('old@example.com');
    const newOwner = await seedUser('new@example.com');
    const workspace = await seedWorkspace(oldOwner, 'ACTIVE');
    await seedOwnerMembership(workspace, oldOwner, ['GYM_OWNER']);
    const body = { ownerUserId: newOwner.toHexString(), expectedVersion: 0 };
    const first = await command(
      'POST',
      `/api/v1/platform/workspaces/${workspace}/owner`,
      actor.token,
      body,
      'owner-1',
    );
    const replay = await command(
      'POST',
      `/api/v1/platform/workspaces/${workspace}/owner`,
      actor.token,
      body,
      'owner-1',
    );
    expect(first.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(first.json().data.workspace.version).toBe(1);
    expect(
      await db()
        .collection('workspace_memberships')
        .countDocuments({ roles: 'GYM_OWNER', status: 'ACTIVE' }),
    ).toBe(1);
    const stale = await command(
      'POST',
      `/api/v1/platform/workspaces/${workspace}/owner`,
      actor.token,
      { ownerUserId: oldOwner.toHexString(), expectedVersion: 0 },
      'owner-stale',
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('WORKSPACE_VERSION_CONFLICT');
    expect(
      await db()
        .collection('audit_events')
        .find({}, { projection: { eventType: 1 } })
        .toArray(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'WorkspaceOwnershipTransferred' }),
      ]),
    );
    expect(
      await db()
        .collection('outbox_events')
        .countDocuments({ eventType: 'WorkspaceOwnershipTransferred' }),
    ).toBe(1);
  });

  test('enforces lifecycle transitions, version CAS, same-state no-op, and exact-once events', async () => {
    const actor = await seedPlatformActor();
    const owner = await seedUser('owner@example.com');
    const workspace = await seedWorkspace(owner, 'ACTIVE');
    const restricted = await lifecycle(workspace, 'restrict', 0, actor.token, 'restrict-1');
    expect(restricted.statusCode).toBe(200);
    expect(restricted.json().data.workspace).toMatchObject({ status: 'RESTRICTED', version: 1 });
    const replay = await lifecycle(workspace, 'restrict', 0, actor.token, 'restrict-1');
    expect(replay.json()).toEqual(restricted.json());
    const invalid = await lifecycle(workspace, 'restore', 1, actor.token, 'restore-invalid');
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json().error.code).toBe('INVALID_WORKSPACE_STATUS_TRANSITION');
    const same = await lifecycle(workspace, 'restrict', 1, actor.token, 'restrict-same');
    expect(same.statusCode).toBe(200);
    expect(same.json().data.workspace.version).toBe(1);
    expect(
      await db()
        .collection('audit_events')
        .find({}, { projection: { eventType: 1 } })
        .toArray(),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventType: 'WorkspaceRestricted' })]),
    );
    expect(
      await db().collection('outbox_events').countDocuments({ eventType: 'WorkspaceRestricted' }),
    ).toBe(1);
  });

  test('enforces every allowed lifecycle transition and rejects every forbidden source class', async () => {
    const actor = await seedPlatformActor();
    const owner = await seedUser('matrix-owner@example.com');
    const allowed = [
      ['PENDING_ACTIVATION', 'activate', 'ACTIVE'],
      ['RESTRICTED', 'activate', 'ACTIVE'],
      ['SUSPENDED', 'activate', 'ACTIVE'],
      ['ACTIVE', 'restrict', 'RESTRICTED'],
      ['ACTIVE', 'suspend', 'SUSPENDED'],
      ['RESTRICTED', 'suspend', 'SUSPENDED'],
      ['PENDING_ACTIVATION', 'archive', 'ARCHIVED'],
      ['ACTIVE', 'archive', 'ARCHIVED'],
      ['RESTRICTED', 'archive', 'ARCHIVED'],
      ['SUSPENDED', 'archive', 'ARCHIVED'],
      ['ARCHIVED', 'restore', 'ACTIVE'],
    ] as const;
    for (const [from, commandName, to] of allowed) {
      const workspace = await seedWorkspace(owner, from);
      const response = await lifecycle(
        workspace,
        commandName,
        0,
        actor.token,
        `allowed-${from}-${commandName}`,
      );
      expect(response.statusCode, `${from} -> ${commandName}`).toBe(200);
      expect(response.json().data.workspace).toMatchObject({ status: to, version: 1 });
    }

    const forbidden = [
      ['ARCHIVED', 'restrict'],
      ['ARCHIVED', 'suspend'],
      ['PENDING_ACTIVATION', 'restrict'],
      ['PENDING_ACTIVATION', 'suspend'],
    ] as const;
    for (const [from, commandName] of forbidden) {
      const workspace = await seedWorkspace(owner, from);
      const response = await lifecycle(
        workspace,
        commandName,
        0,
        actor.token,
        `forbidden-${from}-${commandName}`,
      );
      expect(response.statusCode, `${from} -/-> ${commandName}`).toBe(409);
      expect(response.json().error.code).toBe('INVALID_WORKSPACE_STATUS_TRANSITION');
    }
  });

  test('allows only one concurrent owner transfer and one concurrent lifecycle mutation per version', async () => {
    const actor = await seedPlatformActor();
    const originalOwner = await seedUser('concurrent-old@example.com');
    const ownerA = await seedUser('concurrent-a@example.com');
    const ownerB = await seedUser('concurrent-b@example.com');
    const ownerWorkspace = await seedWorkspace(originalOwner, 'ACTIVE');
    await seedOwnerMembership(ownerWorkspace, originalOwner, ['GYM_OWNER']);
    const transfers = await Promise.all([
      command(
        'POST',
        `/api/v1/platform/workspaces/${ownerWorkspace}/owner`,
        actor.token,
        { ownerUserId: ownerA.toHexString(), expectedVersion: 0 },
        'concurrent-owner-a',
      ),
      command(
        'POST',
        `/api/v1/platform/workspaces/${ownerWorkspace}/owner`,
        actor.token,
        { ownerUserId: ownerB.toHexString(), expectedVersion: 0 },
        'concurrent-owner-b',
      ),
    ]);
    expect(transfers.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(
      await db()
        .collection('workspace_memberships')
        .countDocuments({ roles: 'GYM_OWNER', status: 'ACTIVE' }),
    ).toBe(1);

    const lifecycleWorkspace = await seedWorkspace(originalOwner, 'ACTIVE');
    const commands = await Promise.all([
      lifecycle(lifecycleWorkspace, 'restrict', 0, actor.token, 'concurrent-restrict'),
      lifecycle(lifecycleWorkspace, 'suspend', 0, actor.token, 'concurrent-suspend'),
    ]);
    expect(commands.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(
      (await db().collection('workspaces').findOne({ _id: lifecycleWorkspace }))?.version,
    ).toBe(1);
  });

  test('rejects resolved support context before every management lookup or mutation', async () => {
    const actor = await seedPlatformActor();
    const owner = await seedUser('support-owner@example.com');
    const workspace = await seedWorkspace(owner, 'ACTIVE');
    const originalResolve = container.supportAccess.resolveForRequest.bind(container.supportAccess);
    container.supportAccess.resolveForRequest = async (ctx) => {
      ctx.supportSessionId = new ObjectId().toHexString();
      return {} as never;
    };
    try {
      const cases: Array<{
        method: 'GET' | 'POST';
        url: string;
        payload?: Record<string, unknown>;
      }> = [
        { method: 'GET', url: '/api/v1/platform/workspace-owner-candidates' },
        {
          method: 'POST' as const,
          url: '/api/v1/platform/workspaces',
          payload: {
            type: 'GYM',
            name: 'Denied',
            ownerUserId: owner.toHexString(),
            timezone: 'UTC',
            defaultLanguage: 'en',
          },
        },
        {
          method: 'POST',
          url: `/api/v1/platform/workspaces/${workspace}/owner`,
          payload: { ownerUserId: owner.toHexString(), expectedVersion: 0 },
        },
        ...['activate', 'restrict', 'suspend', 'archive', 'restore'].map((commandName) => ({
          method: 'POST' as const,
          url: `/api/v1/platform/workspaces/${workspace}/${commandName}`,
          payload: { expectedVersion: 0 },
        })),
      ];
      for (const [index, item] of cases.entries()) {
        const response = await app.inject({
          method: item.method,
          url: item.url,
          headers: {
            authorization: `Bearer ${actor.token}`,
            'x-support-session-id': new ObjectId().toHexString(),
            'idempotency-key': `support-denied-${index}`,
          },
          ...(item.payload ? { payload: item.payload } : {}),
        });
        expect(response.statusCode, item.url).toBe(403);
        expect(response.json().error.code).toBe('SUPPORT_ACCESS_FORBIDDEN');
      }
      expect(await db().collection('idempotency_records').countDocuments()).toBe(0);
      expect(await db().collection('audit_events').countDocuments()).toBe(0);
      expect(await db().collection('outbox_events').countDocuments()).toBe(0);
    } finally {
      container.supportAccess.resolveForRequest = originalResolve;
    }
  });

  test('owner candidate query plans are indexed without collection scan or blocking sort', async () => {
    for (let index = 0; index < 100; index += 1) {
      await seedUser(`explain-${index}@example.com`, index % 2 === 0 ? 'ACTIVE' : 'SUSPENDED');
    }
    const users = db().collection('users');
    const cases = [
      {
        query: { status: 'ACTIVE' },
        expectedIndex: 'users_status_id',
        sorted: true,
      },
      {
        query: { status: 'ACTIVE', normalizedEmail: 'explain-2@example.com' },
        expectedIndex: 'users_normalized_email_status',
        sorted: false,
      },
    ];
    for (const item of cases) {
      const cursor = users.find(item.query);
      if (item.sorted) cursor.sort({ _id: -1 });
      const explain = await cursor.limit(51).explain('executionStats');
      const summary = summarizePlan(explain.queryPlanner.winningPlan);
      expect(summary.stages).not.toContain('COLLSCAN');
      expect(summary.stages).not.toContain('SORT');
      expect(summary.indexes).toContain(item.expectedIndex);
    }
  });

  test('wires new routes to the locked Platform authority prerequisites', async () => {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/workspace-owner-candidates',
    });
    expect(unauthenticated.statusCode).toBe(401);

    for (const options of [
      { mfaSatisfied: false },
      { membership: false },
      { allow: false },
      { restricted: true },
    ]) {
      const actor = await seedPlatformActor(options);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/platform/workspace-owner-candidates',
        headers: { authorization: `Bearer ${actor.token}` },
      });
      expect(response.statusCode, JSON.stringify(options)).toBe(403);
    }
  });

  test('publishes exact management routes, idempotency headers, and non-placeholder success schemas', async () => {
    await app.ready();
    const document = app.swagger() as unknown as {
      paths: Record<
        string,
        Record<
          string,
          {
            parameters?: Array<{ name: string; in: string; required?: boolean }>;
            responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
          }
        >
      >;
    };
    const commandPaths = [
      '/api/v1/platform/workspaces',
      '/api/v1/platform/workspaces/{workspaceId}/owner',
      '/api/v1/platform/workspaces/{workspaceId}/activate',
      '/api/v1/platform/workspaces/{workspaceId}/restrict',
      '/api/v1/platform/workspaces/{workspaceId}/suspend',
      '/api/v1/platform/workspaces/{workspaceId}/archive',
      '/api/v1/platform/workspaces/{workspaceId}/restore',
    ];
    for (const path of commandPaths) {
      const operation = document.paths[path]?.post;
      expect(operation, path).toBeDefined();
      expect(operation?.parameters?.some((parameter) => parameter.name === 'idempotency-key')).toBe(
        true,
      );
      const success = operation?.responses[path === '/api/v1/platform/workspaces' ? '201' : '200'];
      expect(success?.content?.['application/json']?.schema).toBeDefined();
      expect(Object.keys(operation?.responses ?? {})).toEqual(
        expect.arrayContaining(['400', '401', '403', '404', '409']),
      );
    }
    expect(document.paths['/api/v1/platform/workspace-owner-candidates']?.get).toBeDefined();
  });
});

describe('migration 025', () => {
  test(
    'backfills versions in deterministic bounded pages, reruns safely, and creates only required owner indexes',
    async () => {
      const client = new MongoClient(mongoUri());
      await client.connect();
      const migrationDb = client.db(`workspace_management_migration_${new ObjectId()}`);
      try {
        await migrationDb.collection('workspaces').insertMany(
          Array.from({ length: 253 }, (_, index) => ({
            _id: new ObjectId((253 - index).toString(16).padStart(24, '0')),
            name: `Workspace ${index}`,
          })),
        );
        await migration025PlatformWorkspaceManagement.up(migrationDb);
        await migration025PlatformWorkspaceManagement.up(migrationDb);
        expect(await migrationDb.collection('workspaces').countDocuments({ version: 0 })).toBe(253);
        expect(await migrationDb.collection('users').indexExists('users_status_id')).toBe(true);
        expect(
          await migrationDb.collection('users').indexExists('users_normalized_email_status'),
        ).toBe(true);
      } finally {
        await migrationDb.dropDatabase();
        await client.close();
      }
    },
    TIMEOUT,
  );
});

async function seedPlatformActor(
  options: {
    allow?: boolean;
    membership?: boolean;
    mfaSatisfied?: boolean;
    restricted?: boolean;
  } = {},
) {
  const userId = await seedUser(`actor-${new ObjectId()}@example.com`);
  const now = new Date();
  const profileId = new ObjectId();
  if (options.membership !== false) {
    if (options.allow !== false) {
      await db()
        .collection('permission_profiles')
        .insertOne({
          _id: profileId,
          context: 'PLATFORM',
          name: `Workspace managers ${profileId.toHexString()}`,
          permissions: [{ permission: Permissions.PlatformWorkspacesManage, effect: 'ALLOW' }],
          isSystemDefault: false,
          status: 'ACTIVE',
          version: 0,
          createdAt: now,
          updatedAt: now,
        });
    }
    await db()
      .collection('platform_memberships')
      .insertOne({
        _id: new ObjectId(),
        userId,
        status: 'ACTIVE',
        permissionProfileIds: options.allow === false ? [] : [profileId],
        accessVersion: 0,
        createdAt: now,
        updatedAt: now,
      });
  }
  const session = await container.authSessions.create({
    userId,
    authenticationMethods: ['pwd'],
    restrictedUntilVerified: options.restricted ?? false,
    ...(options.mfaSatisfied === false ? {} : { mfaSatisfiedAt: now }),
    ipAddress: '127.0.0.1',
    clientType: 'API',
    transport: 'JSON',
    expiresAt: new Date(now.getTime() + 3_600_000),
  });
  return {
    token: container.jwt.createAccessToken({
      userId: userId.toHexString(),
      authSessionId: session._id.toHexString(),
      authenticationMethods: ['pwd'],
    }),
  };
}

async function seedUser(email: string, status = 'ACTIVE', firstName = 'Test', lastName = 'Owner') {
  const id = new ObjectId();
  const now = new Date();
  await db().collection('users').insertOne({
    _id: id,
    email,
    normalizedEmail: email.toLowerCase(),
    passwordHash: 'hash',
    firstName,
    lastName,
    preferredLanguage: 'en',
    timezone: 'UTC',
    status,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedWorkspace(ownerUserId: ObjectId, status: string) {
  const id = new ObjectId();
  const now = new Date();
  await db()
    .collection('workspaces')
    .insertOne({
      _id: id,
      type: 'GYM',
      name: 'Atlas Gym',
      nameSearchPrefixes: workspaceNameSearchPrefixes('Atlas Gym'),
      version: 0,
      ownerUserId,
      status,
      timezone: 'UTC',
      defaultLanguage: 'en',
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

async function seedOwnerMembership(workspaceId: ObjectId, userId: ObjectId, roles: string[]) {
  const now = new Date();
  await db()
    .collection('workspace_memberships')
    .insertOne({
      _id: new ObjectId(),
      workspaceId,
      userId,
      roles,
      status: 'ACTIVE',
      joinedAt: now,
      engagementPeriods: [{ startedAt: now }],
      permissionProfileIds: [],
      accessVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
}

async function command(
  method: 'POST',
  url: string,
  token: string,
  payload: Record<string, unknown>,
  key: string,
): Promise<InjectResponse> {
  return (await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    payload,
  })) as InjectResponse;
}

async function lifecycle(
  workspaceId: ObjectId,
  commandName: string,
  expectedVersion: number,
  token: string,
  key: string,
) {
  return await command(
    'POST',
    `/api/v1/platform/workspaces/${workspaceId}/${commandName}`,
    token,
    { expectedVersion },
    key,
  );
}

function db(): Db {
  return container.database.db;
}

function config(database: string): AppConfig {
  return {
    env: 'test',
    app: {
      host: '127.0.0.1',
      port: 0,
      docsEnabled: false,
      trustProxy: false,
      allowedOrigins: [],
    },
    mongo: { uri: mongoUri(), dbName: database, connectTimeoutMs: 500 },
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

function mongoUri() {
  return (
    process.env.MONGODB_URI ??
    'mongodb://localhost:27017/gym_platform?replicaSet=rs0&directConnection=true'
  );
}

function summarizePlan(plan: unknown): { stages: string[]; indexes: string[] } {
  const stages: string[] = [];
  const indexes: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (typeof object.stage === 'string') stages.push(object.stage);
    if (typeof object.indexName === 'string') indexes.push(object.indexName);
    for (const nested of Object.values(object)) {
      if (Array.isArray(nested)) nested.forEach(visit);
      else visit(nested);
    }
  };
  visit(plan);
  return { stages, indexes };
}
