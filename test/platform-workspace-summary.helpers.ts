import { expect, spyOn } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { migrations } from '../src/migrations';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { Permissions } from '../src/modules/permissions/permission.registry';
import type { ResolvedSupportContext } from '../src/modules/support-access/support-access.types';

export async function summaryHarness(prefix: string) {
  const container = await createAppContainer(
    summaryIntegrationConfig(`${prefix}_${new ObjectId()}`),
  );
  await new MigrationRunner(container.database.db, migrations).migrate();
  const app = await buildApp(container);
  const db = container.database.db;
  return {
    container,
    app,
    db,
    async clear() {
      for (const { name } of await db.listCollections().toArray()) {
        if (name !== 'db_migrations') await db.collection(name).deleteMany({});
      }
    },
    async close() {
      await app.close();
      await db.dropDatabase();
      await container.database.close();
    },
    async workspace(status = 'ACTIVE') {
      const workspaceId = new ObjectId();
      await db.collection('workspaces').insertOne({
        _id: workspaceId,
        name: 'Summary Gym',
        type: 'GYM',
        status,
        ownerUserId: new ObjectId(),
        timezone: 'Africa/Cairo',
        defaultLanguage: 'en',
        version: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return workspaceId;
    },
    async actor(
      permission: string,
      options: {
        membership?: boolean;
        membershipStatus?: string;
        mfa?: boolean;
        restricted?: boolean;
        deny?: boolean;
      } = {},
    ) {
      const userId = new ObjectId();
      const profileId = new ObjectId();
      const now = new Date();
      await db.collection('users').insertOne({
        _id: userId,
        status: 'ACTIVE',
        firstName: 'Platform',
        lastName: 'Operator',
        createdAt: now,
        updatedAt: now,
      });
      if (options.membership !== false) {
        await db.collection('permission_profiles').insertOne({
          _id: profileId,
          context: 'PLATFORM',
          name: `Summary ${profileId}`,
          status: 'ACTIVE',
          permissions: [
            { permission, effect: 'ALLOW' },
            ...(options.deny ? [{ permission, effect: 'DENY' }] : []),
          ],
          isSystemDefault: false,
          createdAt: now,
          updatedAt: now,
        });
        await db.collection('platform_memberships').insertOne({
          _id: new ObjectId(),
          userId,
          status: options.membershipStatus ?? 'ACTIVE',
          permissionProfileIds: [profileId],
          accessVersion: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
      const session = await container.authSessions.create({
        userId,
        authenticationMethods: ['pwd'],
        restrictedUntilVerified: options.restricted ?? false,
        ipAddress: '127.0.0.1',
        clientType: 'API',
        transport: 'JSON',
        ...(options.mfa === false ? {} : { mfaSatisfiedAt: now }),
        expiresAt: new Date(now.getTime() + 3_600_000),
      });
      return {
        userId,
        token: container.jwt.createAccessToken({
          userId: userId.toHexString(),
          authSessionId: session._id.toHexString(),
          authenticationMethods: ['pwd'],
        }),
      };
    },
    async snapshot() {
      const snapshot: Record<string, unknown> = {};
      for (const { name } of await db.listCollections().toArray()) {
        snapshot[name] = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
      }
      return snapshot;
    },
  };
}

export type SummaryHarness = Awaited<ReturnType<typeof summaryHarness>>;

export async function summaryGet(app: FastifyInstance, path: string, token?: string) {
  return await app.inject({
    method: 'GET',
    url: path,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
}

export async function assertSummaryAuthorization(
  h: SummaryHarness,
  suffix: 'subscription-summary' | 'counts',
  permission: string,
) {
  const workspaceId = await h.workspace();
  const path = `/api/v1/platform/workspaces/${workspaceId}/${suffix}`;
  expect((await summaryGet(h.app, path)).statusCode).toBe(401);
  for (const [options, code] of [
    [{ restricted: true }, 'AUTH_SESSION_RESTRICTED'],
    [{ mfa: false }, 'TWO_FACTOR_REQUIRED'],
    [{ membership: false }, 'PLATFORM_MEMBERSHIP_REQUIRED'],
    [{ membershipStatus: 'SUSPENDED' }, 'PLATFORM_MEMBERSHIP_REQUIRED'],
    [{ deny: true }, 'PERMISSION_DENIED'],
  ] as const) {
    const actor = await h.actor(permission, options);
    const response = await summaryGet(h.app, path, actor.token);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(code);
  }
  const otherPermission =
    suffix === 'counts' ? Permissions.SubscriptionsRead : Permissions.PlatformWorkspacesManage;
  const wrongPermission = await h.actor(otherPermission);
  expect((await summaryGet(h.app, path, wrongPermission.token)).statusCode).toBe(403);
  for (const roles of [['GYM_OWNER'], ['TRAINER'], ['TRAINEE']]) {
    const actor = await h.actor(permission, { membership: false });
    await h.db.collection('workspace_memberships').insertOne({
      _id: new ObjectId(),
      workspaceId,
      userId: actor.userId,
      roles,
      status: 'ACTIVE',
      permissionProfileIds: [],
    });
    expect((await summaryGet(h.app, path, actor.token)).statusCode).toBe(403);
  }
  const allowed = await h.actor(permission);
  expect((await summaryGet(h.app, path, allowed.token)).statusCode).toBe(200);
}

export async function assertSummarySupportDenial(
  h: SummaryHarness,
  suffix: 'subscription-summary' | 'counts',
  permission: string,
) {
  const workspaceId = await h.workspace();
  const actor = await h.actor(permission);
  const before = await h.snapshot();
  const now = new Date();
  const platformMembershipId = new ObjectId();
  const policyId = new ObjectId();
  const resolved: ResolvedSupportContext = {
    session: {
      _id: new ObjectId(),
      requestId: new ObjectId(),
      policyId,
      policyRevision: 0,
      realActorUserId: actor.userId,
      realActorPlatformMembershipId: platformMembershipId,
      parentAuthSessionId: new ObjectId(),
      targetWorkspaceId: workspaceId,
      contextType: 'WORKSPACE_SUPPORT',
      sessionType: 'READ_ONLY',
      sourceIp: '127.0.0.1',
      reason: 'Summary support boundary test',
      notificationRequired: false,
      allowSensitiveData: false,
      allowSensitiveFileDownload: false,
      startedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      status: 'ACTIVE',
      version: 0,
      createdAt: now,
      updatedAt: now,
    },
    policy: {
      _id: policyId,
      platformMembershipId,
      allowedTargetTypes: ['GYM'],
      allowedSessionTypes: ['READ_ONLY'],
      maxSessionDurationMinutes: 30,
      notificationRequired: false,
      allowSensitiveData: false,
      allowSensitiveFileDownload: false,
      enabled: true,
      revision: 0,
      createdBy: actor.userId,
      createdAt: now,
    },
  };
  const resolve = spyOn(h.container.supportAccess, 'resolveForRequest').mockImplementation(
    async (ctx) => {
      ctx.supportSessionId = resolved.session._id.toHexString();
      return resolved;
    },
  );
  const authorize = spyOn(h.container.accessControl, 'authorize');
  const lookup = spyOn(h.container.workspaceRepo, 'findById');
  try {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/v1/platform/workspaces/${workspaceId}/${suffix}`,
      headers: {
        authorization: `Bearer ${actor.token}`,
        'x-support-session-id': 'resolved-support',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('SUPPORT_ACCESS_FORBIDDEN');
    expect(authorize).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(await h.snapshot()).toEqual(before);
  } finally {
    resolve.mockRestore();
    authorize.mockRestore();
    lookup.mockRestore();
  }
}
export function summaryIntegrationConfig(dbName: string): AppConfig {
  return {
    env: 'test',
    app: {
      host: '127.0.0.1',
      port: 0,
      docsEnabled: false,
      trustProxy: false,
      allowedOrigins: [],
    },
    mongo: {
      uri:
        process.env.MONGODB_URI ??
        'mongodb://127.0.0.1:27017/gym_platform?replicaSet=rs0&directConnection=true',
      dbName,
      connectTimeoutMs: 500,
    },
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
