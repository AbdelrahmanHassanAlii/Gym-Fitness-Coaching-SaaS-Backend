import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import { type AppContainer, createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { migrations } from '../src/migrations';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { Permissions } from '../src/modules/permissions/permission.registry';
import type { PermissionProfileDocument } from '../src/modules/permissions/permission.types';

let container: AppContainer;
let app: FastifyInstance;
beforeAll(async () => {
  container = await createAppContainer(integrationConfig(`web022_${new ObjectId()}`));
  await new MigrationRunner(container.database.db, migrations).migrate();
  app = await buildApp(container);
}, 30_000);
afterEach(async () => {
  for (const collection of await container.database.db.listCollections().toArray()) {
    if (collection.name !== 'db_migrations')
      await container.database.db.collection(collection.name).deleteMany({});
  }
});
afterAll(async () => {
  await app?.close();
  if (container) {
    await container.database.db.dropDatabase();
    await container.database.close();
  }
});

async function fixture() {
  const userId = new ObjectId(),
    membershipId = new ObjectId(),
    profileId = new ObjectId();
  const workspaceId = new ObjectId(),
    policyId = new ObjectId(),
    now = new Date();
  await container.database.db.collection('users').insertOne({
    _id: userId,
    status: 'ACTIVE',
    firstName: 'Support',
    lastName: 'Operator',
    preferredLanguage: 'en',
    createdAt: now,
    updatedAt: now,
  });
  await container.database.db.collection('platform_memberships').insertOne({
    _id: membershipId,
    userId,
    status: 'ACTIVE',
    permissionProfileIds: [profileId],
    accessVersion: 0,
    createdAt: now,
    updatedAt: now,
  });
  await container.database.db.collection('permission_profiles').insertOne({
    _id: profileId,
    name: `WEB-022 ${profileId}`,
    context: 'PLATFORM',
    status: 'ACTIVE',
    permissions: [
      Permissions.SupportSessionsStart,
      Permissions.SupportSessionsEndOwn,
      Permissions.SupportSessionsRevoke,
      Permissions.SupportPoliciesRead,
      Permissions.SupportPoliciesDisable,
      Permissions.SupportPoliciesArchive,
    ].map((permission) => ({ permission, effect: 'ALLOW' })),
    version: 0,
    createdAt: now,
  });
  await container.database.db.collection('workspaces').insertOne({
    _id: workspaceId,
    name: 'Support Target',
    type: 'GYM',
    status: 'ACTIVE',
    timezone: 'Africa/Cairo',
    defaultLanguage: 'ar',
    ownerUserId: new ObjectId(),
    createdAt: now,
  });
  await container.database.db.collection('portal_access_policies').insertOne({
    _id: policyId,
    platformMembershipId: membershipId,
    allowedTargetTypes: ['GYM'],
    allowedWorkspaceIds: [workspaceId],
    allowedIpRanges: ['127.0.0.1'],
    allowedSessionTypes: ['READ_ONLY'],
    maxSessionDurationMinutes: 60,
    notificationRequired: false,
    allowSensitiveData: false,
    allowSensitiveFileDownload: false,
    enabled: true,
    revision: 0,
    createdBy: new ObjectId(),
    createdAt: now,
  });
  const auth = await login(userId);
  const body = {
    targetType: 'GYM',
    targetWorkspaceId: workspaceId.toHexString(),
    contextType: 'WORKSPACE_SUPPORT',
    sessionType: 'READ_ONLY',
    requestedDurationMinutes: 30,
    reason: 'Diagnose reported workspace issue',
    reference: 'ticket-22',
  };
  const key = new ObjectId().toHexString();
  return { userId, membershipId, profileId, workspaceId, policyId, ...auth, body, key };
}
async function login(userId: ObjectId) {
  const session = await container.authSessions.create({
    userId,
    authenticationMethods: ['pwd'],
    restrictedUntilVerified: false,
    mfaSatisfiedAt: new Date(),
    ipAddress: '127.0.0.1',
    clientType: 'API',
    transport: 'JSON',
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return {
    authId: session._id,
    token: container.jwt.createAccessToken({
      userId: userId.toHexString(),
      authSessionId: session._id.toHexString(),
      authenticationMethods: ['pwd'],
    }),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function start(f: Fixture) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/platform/support/access-requests',
    headers: { authorization: `Bearer ${f.token}`, 'idempotency-key': f.key },
    payload: f.body,
  });
}
async function context(f: Fixture, sessionId: string, remoteAddress = '127.0.0.1') {
  return app.inject({
    method: 'GET',
    url: '/api/v1/me/support-context',
    remoteAddress,
    headers: { authorization: `Bearer ${f.token}`, 'x-support-session-id': sessionId },
  });
}
async function started() {
  const f = await fixture();
  const response = await start(f);
  expect(response.statusCode).toBe(201);
  expect(response.headers['cache-control']).toBe('private, no-store');
  return {
    ...f,
    sessionId: response.json().data.supportSession.id as string,
    acknowledgement: response.json(),
  };
}

describe('WEB-022 current management authorization and completed replay', () => {
  test('completed replay reauthorizes after retrieving stored acknowledgement', async () => {
    const f = await started();
    const replayService = container.idempotency as unknown as {
      resolveExisting: (record: unknown) => Promise<unknown>;
    };
    const resolve = replayService.resolveExisting.bind(replayService);
    const spy = spyOn(replayService, 'resolveExisting').mockImplementationOnce(async (record) => {
      const result = await resolve(record);
      await container.database.db
        .collection('permission_profiles')
        .updateOne({ _id: f.profileId }, { $set: { permissions: [] } });
      return result;
    });
    try {
      const response = await start(f);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('PERMISSION_DENIED');
      expect(await container.database.db.collection('support_sessions').countDocuments()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
  test.each([
    ['permission', 'PERMISSION_DENIED', 403],
    ['account', 'AUTH_REQUIRED', 401],
    ['membership', 'PLATFORM_MEMBERSHIP_INACTIVE', 403],
    ['mfa', 'TWO_FACTOR_REQUIRED', 403],
    ['restricted', 'AUTH_SESSION_RESTRICTED', 403],
  ] as const)(
    'completed replay after %s loss fails without another start',
    async (kind, code, status) => {
      const f = await started();
      if (kind === 'permission')
        await container.database.db
          .collection('permission_profiles')
          .updateOne({ _id: f.profileId }, { $set: { permissions: [] } });
      if (kind === 'account')
        await container.database.db
          .collection('users')
          .updateOne({ _id: f.userId }, { $set: { status: 'SUSPENDED' } });
      if (kind === 'membership')
        await container.database.db
          .collection('platform_memberships')
          .updateOne({ _id: f.membershipId }, { $set: { status: 'ENDED' } });
      if (kind === 'mfa')
        await container.database.db
          .collection('auth_sessions')
          .updateOne({ _id: f.authId }, { $unset: { mfaSatisfiedAt: '' } });
      if (kind === 'restricted')
        await container.database.db
          .collection('auth_sessions')
          .updateOne({ _id: f.authId }, { $set: { restrictedUntilVerified: true } });
      const response = await start(f);
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBe(code);
      expect(response.headers['cache-control']).toBe('private, no-store');
      for (const collection of [
        'support_sessions',
        'support_access_requests',
        'idempotency_records',
      ])
        expect(await container.database.db.collection(collection).countDocuments()).toBe(1);
      expect(
        await container.database.db
          .collection('audit_events')
          .countDocuments({ eventType: 'SupportSessionStarted' }),
      ).toBe(1);
      expect(
        await container.database.db
          .collection('outbox_events')
          .countDocuments({ eventType: 'SupportSessionStarted' }),
      ).toBe(1);
    },
  );
  test.each(['ENDED', 'REVOKED', 'EXPIRED', 'SECURITY_TERMINATED'])(
    'replay of %s session remains historical and cannot authorize entry',
    async (status) => {
      const f = await started();
      await container.database.db
        .collection('support_sessions')
        .updateOne({ _id: new ObjectId(f.sessionId) }, { $set: { status }, $inc: { version: 1 } });
      const replay = await start(f);
      expect(replay.statusCode).toBe(201);
      // BSON preserves optional undefined fields as null in stored acknowledgements.
      // Preserve the existing replay shape; assert original command identity/state.
      expect(replay.json()).toMatchObject(f.acknowledgement);
      expect(replay.headers['cache-control']).toBe('private, no-store');
      const validation = await context(f, f.sessionId);
      expect(validation.statusCode).toBe(403);
      expect(validation.json().error.code).toBe('SUPPORT_SESSION_NOT_ACTIVE');
      expect(validation.headers['cache-control']).toBe('private, no-store');
      expect(await container.database.db.collection('support_sessions').countDocuments()).toBe(1);
      expect(
        (
          await container.database.db
            .collection('support_sessions')
            .findOne({ _id: new ObjectId(f.sessionId) })
        )?.status,
      ).toBe(status);
    },
  );
  test('same key with changed body retains fingerprint conflict', async () => {
    const f = await started();
    const response = await start({ ...f, body: { ...f.body, reason: 'Different command intent' } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
  test('inactive account denies management GET and runtime bootstrap', async () => {
    const f = await started();
    await container.database.db
      .collection('users')
      .updateOne({ _id: f.userId }, { $set: { status: 'SUSPENDED' } });
    for (const url of [
      '/api/v1/platform/support/policies',
      `/api/v1/platform/support/sessions/${f.sessionId}`,
      '/api/v1/me/support-context',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: {
          authorization: `Bearer ${f.token}`,
          ...(url.endsWith('support-context') ? { 'x-support-session-id': f.sessionId } : {}),
        },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('AUTH_REQUIRED');
    }
  });
});

describe('WEB-022 selected runtime context', () => {
  test('start then context returns exact private DTO without native membership or global reads', async () => {
    const f = await started();
    const auditCount = await container.database.db.collection('audit_events').countDocuments();
    const response = await context(f, f.sessionId);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const data = response.json().data;
    expect(Object.keys(response.json())).toEqual(['data']);
    expect(Object.keys(data).sort()).toEqual(['supportSession', 'workspace']);
    expect(Object.keys(data.supportSession).sort()).toEqual([
      'contextType',
      'expiresAt',
      'id',
      'policyRevision',
      'sessionType',
      'startedAt',
      'status',
      'version',
    ]);
    expect(data.supportSession).toMatchObject({
      id: f.sessionId,
      status: 'ACTIVE',
      version: 0,
      contextType: 'WORKSPACE_SUPPORT',
      sessionType: 'READ_ONLY',
      policyRevision: 0,
    });
    expect(data.workspace).toEqual({
      id: f.workspaceId.toHexString(),
      name: 'Support Target',
      type: 'GYM',
      status: 'ACTIVE',
      timezone: 'Africa/Cairo',
      defaultLanguage: 'ar',
    });
    expect(await container.database.db.collection('workspace_memberships').countDocuments()).toBe(
      0,
    );
    expect(await container.database.db.collection('audit_events').countDocuments()).toBe(
      auditCount,
    );
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/platform/support/sessions/${f.sessionId}`,
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(detail.statusCode).toBe(403);
    expect(detail.json().error.code).toBe('PERMISSION_DENIED');
    expect(detail.headers['cache-control']).toBe('private, no-store');
    for (const forbidden of [
      'parentAuthSessionId',
      'realActorUserId',
      'sourceIp',
      'allowedIpRanges',
      'policySnapshot',
      'permissions',
      'grants',
      'token',
      'reason',
      'reference',
      'notificationRequired',
    ])
      expect(response.body).not.toContain(`"${forbidden}"`);
  });
  test('different parent login and IP retain canonical runtime denial', async () => {
    const f = await started();
    const otherLogin = await login(f.userId);
    const response = await context({ ...f, ...otherLogin }, f.sessionId);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('SUPPORT_SESSION_PARENT_MISMATCH');
    const second = await started();
    const ip = await context(second, second.sessionId, '127.0.0.2');
    expect(ip.statusCode).toBe(403);
    expect(['IP_NOT_ALLOWED', 'SUPPORT_SESSION_IP_MISMATCH']).toContain(ip.json().error.code);
  });
  test.each(['disable', 'archive', 'validity', 'expiry'])(
    'context fails after %s before workspace entry',
    async (change) => {
      const f = await started();
      if (change === 'disable' || change === 'archive') {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/platform/support/policies/${f.policyId}/${change}`,
          headers: { authorization: `Bearer ${f.token}` },
          payload: { expectedVersion: 0 },
        });
        expect(response.statusCode).toBe(200);
      } else if (change === 'validity')
        await container.database.db
          .collection('portal_access_policies')
          .updateOne({ _id: f.policyId }, { $set: { validUntil: new Date(0) } });
      else
        await container.database.db
          .collection('support_sessions')
          .updateOne({ _id: new ObjectId(f.sessionId) }, { $set: { expiresAt: new Date(0) } });
      const response = await context(f, f.sessionId);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe(
        change === 'validity'
          ? 'POLICY_EXPIRED'
          : change === 'expiry'
            ? 'SUPPORT_SESSION_EXPIRED'
            : 'SUPPORT_SESSION_NOT_ACTIVE',
      );
    },
  );
  test('missing, malformed header and query-selected sessions cannot bootstrap', async () => {
    const f = await started();
    for (const selected of [undefined, '', 'invalid']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me/support-context',
        headers: {
          authorization: `Bearer ${f.token}`,
          ...(selected === undefined ? {} : { 'x-support-session-id': selected }),
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('private, no-store');
    }
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/me/support-context?sessionId=${f.sessionId}`,
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(response.statusCode).toBe(400);
  });
  test('OpenAPI requires header and strict bounded response; migrations remain 28', () => {
    const schema = app.swagger().paths?.['/api/v1/me/support-context']?.get;
    expect(schema).toBeDefined();
    expect(schema?.parameters).toContainEqual(
      expect.objectContaining({ in: 'header', name: 'x-support-session-id', required: true }),
    );
    expect(JSON.stringify(schema?.responses?.['200'])).toContain('"additionalProperties":false');
    expect(migrations).toHaveLength(28);
    expect(migrations.at(-1)?.id).toContain('028');
  });
});

describe('WEB-022 explicit support management denial and cache boundary', () => {
  test('implicit HEAD management routes retain fresh account authority', async () => {
    const f = await fixture();
    await container.database.db
      .collection('users')
      .updateOne({ _id: f.userId }, { $set: { status: 'SUSPENDED' } });
    const response = await app.inject({
      method: 'HEAD',
      url: '/api/v1/platform/support/policies',
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
  test('session read success and end/revoke retain distinct permissions and version CAS', async () => {
    const f = await started();
    await container.database.db
      .collection<PermissionProfileDocument>('permission_profiles')
      .updateOne(
        { _id: f.profileId },
        {
          $push: { permissions: { permission: Permissions.SupportSessionsRead, effect: 'ALLOW' } },
        },
      );
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/platform/support/sessions/${f.sessionId}`,
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers['cache-control']).toBe('private, no-store');
    const ended = await app.inject({
      method: 'POST',
      url: `/api/v1/platform/support/sessions/${f.sessionId}/end`,
      headers: { authorization: `Bearer ${f.token}` },
      payload: { expectedVersion: 0 },
    });
    expect(ended.statusCode).toBe(200);
    expect(ended.json().data).toMatchObject({ status: 'ENDED', version: 1 });
    const invalid = await context(f, f.sessionId);
    expect(invalid.statusCode).toBe(403);
    const second = await start({ ...f, key: new ObjectId().toHexString() });
    const id = second.json().data.supportSession.id;
    const revoked = await app.inject({
      method: 'POST',
      url: `/api/v1/platform/support/sessions/${id}/revoke`,
      headers: { authorization: `Bearer ${f.token}` },
      payload: { expectedVersion: 0 },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().data).toMatchObject({ status: 'REVOKED', version: 1 });
    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/platform/support/sessions/${id}/end`,
      headers: { authorization: `Bearer ${f.token}` },
      payload: { expectedVersion: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('SUPPORT_SESSION_VERSION_CONFLICT');
  });
  test.each([
    ['GET', '/api/v1/platform/support/policies'],
    ['GET', `/api/v1/platform/support/sessions/${new ObjectId()}`],
    ['POST', '/api/v1/platform/support/access-requests'],
    ['POST', `/api/v1/platform/support/sessions/${new ObjectId()}/end`],
    ['POST', `/api/v1/platform/support/sessions/${new ObjectId()}/revoke`],
  ] as const)(
    '%s %s denies even an invalid support selector before lookup',
    async (method, url) => {
      const f = await fixture();
      const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${f.token}`, 'x-support-session-id': 'not-a-session' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('SUPPORT_ACCESS_FORBIDDEN');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(
        await container.database.db.collection('support_access_requests').countDocuments(),
      ).toBe(0);
    },
  );
  test('unauthenticated and domain errors are also no-store', async () => {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/support/policies',
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['cache-control']).toBe('private, no-store');
    const f = await fixture();
    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/platform/support/policies/${new ObjectId()}`,
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['cache-control']).toBe('private, no-store');
  });
});

function integrationConfig(dbName: string): AppConfig {
  return {
    env: 'test',
    app: {
      host: '0.0.0.0',
      port: 3000,
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
    notifications: {
      deliveryBatchSize: 25,
      deliveryClaimMs: 60_000,
      deliveryMaxAttempts: 5,
    },
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
