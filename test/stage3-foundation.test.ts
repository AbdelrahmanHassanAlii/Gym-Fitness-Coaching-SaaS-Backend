import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import type { AppConfig } from '../src/config/config.types';
import { AppError } from '../src/core/errors/app-error';
import { migration004Stage3WorkspacesIndexes } from '../src/migrations/004-stage3-workspaces-indexes';
import type { AuthSessionDocument } from '../src/modules/auth/auth.types';
import type { UserDocument } from '../src/modules/identity/identity.types';

describe('Stage 3 foundation', () => {
  test('Platform route requires server-side MFA satisfaction, not JWT amr alone', async () => {
    const userId = new ObjectId();
    const sessionId = new ObjectId();
    const app = await buildApp(
      fakeContainer({
        user: activeUser(userId),
        session: activeSession({ userId, sessionId, authenticationMethods: ['pwd', 'totp'] }),
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/workspaces',
      headers: { authorization: 'Bearer jwt-with-totp-amr' },
      payload: {
        type: 'GYM',
        name: 'Titan Gym',
        ownerUserId: userId.toHexString(),
        timezone: 'Africa/Cairo',
        defaultLanguage: 'en',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('TWO_FACTOR_REQUIRED');
    await app.close();
  });

  test('/me returns safe identity and session fields only', async () => {
    const userId = new ObjectId();
    const sessionId = new ObjectId();
    const app = await buildApp(
      fakeContainer({
        user: activeUser(userId),
        session: activeSession({ userId, sessionId, mfaSatisfiedAt: new Date() }),
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: 'Bearer valid' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      user: {
        id: userId.toHexString(),
        firstName: 'A',
        lastName: 'User',
        email: 'a@example.com',
        emailVerified: true,
        phoneVerified: false,
        status: 'ACTIVE',
      },
      session: {
        id: sessionId.toHexString(),
        restrictedUntilVerified: false,
        mfaSatisfied: true,
      },
    });
    expect(JSON.stringify(response.json())).not.toContain('refreshToken');
    expect(JSON.stringify(response.json())).not.toContain('encryptedSecret');
    expect(JSON.stringify(response.json())).not.toContain('recoveryCodes');
    await app.close();
  });

  test('Stage 3 migration encodes locked uniqueness and cleanup indexes', async () => {
    const calls: Array<{ collection: string; indexes: unknown[] }> = [];
    const db = {
      collection(name: string) {
        return {
          async createIndexes(indexes: unknown[]) {
            calls.push({ collection: name, indexes });
          },
        };
      },
    };

    await migration004Stage3WorkspacesIndexes.up(db as never);

    expect(indexes(calls, 'platform_memberships')).toContainEqual(
      expect.objectContaining({
        name: 'platform_memberships_user_unique',
        unique: true,
        key: { userId: 1 },
      }),
    );
    expect(indexes(calls, 'branches')).toContainEqual(
      expect.objectContaining({
        name: 'branches_workspace_code_unique',
        unique: true,
        partialFilterExpression: { code: { $type: 'string' } },
      }),
    );
    expect(indexes(calls, 'membership_branch_assignments')).toContainEqual(
      expect.objectContaining({
        name: 'membership_branch_assignments_active_unique',
        unique: true,
        partialFilterExpression: { active: true },
      }),
    );
    expect(indexes(calls, 'invitations')).toContainEqual(
      expect.objectContaining({
        name: 'invitations_token_digest_unique',
        unique: true,
      }),
    );
    expect(indexes(calls, 'invitations')).toContainEqual(
      expect.objectContaining({
        name: 'invitations_pending_workspace_email_unique',
        unique: true,
        partialFilterExpression: {
          status: 'PENDING',
          normalizedEmail: { $type: 'string' },
        },
      }),
    );
    expect(indexes(calls, 'invitations')).toContainEqual(
      expect.objectContaining({
        name: 'invitations_expiry_ttl',
        expireAfterSeconds: 0,
      }),
    );
  });
});

function indexes(calls: Array<{ collection: string; indexes: unknown[] }>, collection: string) {
  return calls.find((call) => call.collection === collection)?.indexes;
}

function fakeContainer(input: {
  user: UserDocument;
  session: AuthSessionDocument;
  workspaceOverrides?: Record<string, unknown>;
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
      async authorize(ctx: { mfaSatisfied?: boolean }) {
        if (!ctx.mfaSatisfied) {
          throw new AppError({
            code: 'TWO_FACTOR_REQUIRED',
            httpStatus: 403,
            message: 'MFA is required for Platform access.',
          });
        }
        return { allowed: true };
      },
    },
    auth: emptyAuthService(),
    workspaces: {
      async me(ctx: { mfaSatisfied?: boolean }) {
        return {
          user: {
            id: input.user._id.toHexString(),
            firstName: input.user.firstName,
            lastName: input.user.lastName,
            email: input.user.email,
            emailVerified: Boolean(input.user.emailVerifiedAt),
            phoneVerified: Boolean(input.user.phoneVerifiedAt),
            status: input.user.status,
          },
          session: {
            id: input.session._id.toHexString(),
            restrictedUntilVerified: input.session.restrictedUntilVerified,
            mfaSatisfied: Boolean(ctx.mfaSatisfied),
          },
        };
      },
      async createWorkspace(ctx: { mfaSatisfied?: boolean }) {
        if (!ctx.mfaSatisfied) {
          const { AppError } = await import('../src/core/errors/app-error');
          throw new AppError({
            code: 'TWO_FACTOR_REQUIRED',
            httpStatus: 403,
            message: 'MFA is required for Platform access.',
          });
        }
        return {};
      },
      ...input.workspaceOverrides,
    },
  } as never;
}

function activeUser(userId: ObjectId): UserDocument {
  return {
    _id: userId,
    email: 'a@example.com',
    normalizedEmail: 'a@example.com',
    passwordHash: 'hash',
    emailVerifiedAt: new Date(),
    firstName: 'A',
    lastName: 'User',
    preferredLanguage: 'en',
    timezone: 'Africa/Cairo',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function activeSession(input: {
  userId: ObjectId;
  sessionId: ObjectId;
  authenticationMethods?: Array<'pwd' | 'totp' | 'recovery_code'>;
  mfaSatisfiedAt?: Date;
}): AuthSessionDocument {
  return {
    _id: input.sessionId,
    userId: input.userId,
    status: 'ACTIVE',
    clientType: 'API',
    refreshTokenTransport: 'JSON',
    ipAddress: '127.0.0.1',
    authenticationMethods: input.authenticationMethods ?? ['pwd'],
    restrictedUntilVerified: false,
    createdAt: new Date(),
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    ...(input.mfaSatisfiedAt ? { mfaSatisfiedAt: input.mfaSatisfiedAt } : {}),
  };
}

function emptyAuthService() {
  return {
    async login() {
      return {};
    },
    async register() {
      return {};
    },
    async refresh() {
      return {};
    },
    async logout() {
      return { success: true as const };
    },
    async verify() {
      return { success: true as const };
    },
    async resendVerification() {
      return { success: true as const };
    },
    async forgotPassword() {
      return { success: true as const };
    },
    async resetPassword() {
      return { success: true as const };
    },
    async completeMfaLogin() {
      return {};
    },
    async mfaStatus() {
      return {};
    },
    async startTotpSetup() {
      return {};
    },
    async confirmTotpSetup() {
      return {};
    },
    async startStepUp() {
      return {};
    },
    async verifyStepUp() {
      return {};
    },
    async regenerateRecoveryCodes() {
      return {};
    },
    async disableMfa() {
      return {};
    },
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
