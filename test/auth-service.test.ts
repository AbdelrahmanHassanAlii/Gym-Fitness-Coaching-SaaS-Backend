import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { AppError } from '../src/core/errors/app-error';
import { AuthApplicationService } from '../src/modules/auth/auth.service';

describe('AuthApplicationService', () => {
  test('registration requires at least one login identifier', async () => {
    const service = serviceWithFakes();

    await expect(
      service.register({
        password: 'password123',
        firstName: 'A',
        lastName: 'User',
        preferredLanguage: 'en',
        clientType: 'API',
        metadata: { ipAddress: '127.0.0.1' },
      }),
    ).rejects.toMatchObject({ code: 'AUTH_IDENTIFIER_REQUIRED' });
  });

  test('unknown login identifier has generic invalid credentials behavior', async () => {
    const events: Array<Record<string, unknown>> = [];
    const service = serviceWithFakes({
      events,
      identity: {
        async findByLoginIdentifier() {
          return null;
        },
      },
    });

    await expect(
      service.login({
        identifier: 'missing@example.com',
        password: 'password123',
        clientType: 'API',
        metadata: { ipAddress: '127.0.0.1' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'LOGIN_FAILED',
        result: 'FAILURE',
        reasonCode: 'INVALID_CREDENTIALS',
      }),
    );
  });

  test('forgot password keeps public response generic for unknown identifiers', async () => {
    const events: Array<Record<string, unknown>> = [];
    const service = serviceWithFakes({
      events,
      identity: {
        async findByLoginIdentifier() {
          return null;
        },
      },
    });

    await expect(
      service.forgotPassword({
        identifier: 'missing@example.com',
        metadata: { ipAddress: '127.0.0.1' },
      }),
    ).resolves.toEqual({ success: true });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'PASSWORD_RESET_REQUESTED',
        result: 'INFO',
        reasonCode: 'IDENTIFIER_NOT_ELIGIBLE',
      }),
    );
  });

  test('password login with active MFA returns challenge without creating a session', async () => {
    const events: Array<Record<string, unknown>> = [];
    let sessionCreated = false;
    let refreshIssued = false;
    const userId = new ObjectId();
    const service = serviceWithFakes({
      events,
      identity: {
        async findByLoginIdentifier() {
          return activeUser(userId);
        },
      },
      passwordHasher: {
        async verify() {
          return true;
        },
      },
      sessions: {
        async create() {
          sessionCreated = true;
        },
      },
      refreshTokens: {
        async issue() {
          refreshIssued = true;
        },
      },
      mfaMethods: {
        async findActiveTotp() {
          return {
            _id: new ObjectId(),
            userId,
            type: 'TOTP',
            status: 'ACTIVE',
            encryptedSecret: 'encrypted',
            recoveryCodes: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
      challenges: {
        async create(input: Record<string, unknown>) {
          return {
            _id: new ObjectId(),
            ...input,
            attemptCount: 0,
            resendCount: 0,
            createdAt: new Date(),
          };
        },
      },
      credentialDigests: {
        randomSecret() {
          return 'opaque-mfa-token';
        },
        hashHighEntropySecret(value: string) {
          return `hash:${value}`;
        },
      },
    });

    await expect(
      service.login({
        identifier: 'a@example.com',
        password: 'password123',
        clientType: 'WEB',
        metadata: { ipAddress: '127.0.0.1' },
      }),
    ).resolves.toEqual({
      status: 'MFA_REQUIRED',
      mfaChallengeToken: 'opaque-mfa-token',
      availableMethods: ['TOTP', 'RECOVERY_CODE'],
    });
    expect(sessionCreated).toBe(false);
    expect(refreshIssued).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'MFA_LOGIN_CHALLENGE_CREATED',
        userId,
        clientType: 'WEB',
      }),
    );
  });

  test('valid totp mfa login consumes challenge and creates mfa-satisfied session', async () => {
    const events: Array<Record<string, unknown>> = [];
    const userId = new ObjectId();
    const sessionId = new ObjectId();
    const challengeId = new ObjectId();
    let createdSessionInput: Record<string, unknown> | undefined;
    const challenge = {
      _id: challengeId,
      purpose: 'MFA_LOGIN',
      userId,
      clientType: 'MOBILE',
      authenticationMethods: ['pwd'],
      challengeDigest: 'hash:mfa-token',
      digestContext: 'ctx',
      expiresAt: new Date(Date.now() + 60_000),
      attemptCount: 1,
      maxAttempts: 5,
      resendCount: 0,
      createdAt: new Date(),
    };
    const service = serviceWithFakes({
      events,
      identity: {
        async findById() {
          return activeUser(userId);
        },
      },
      sessions: {
        async create(input: Record<string, unknown>) {
          createdSessionInput = input;
          return { _id: sessionId, userId, ...input };
        },
      },
      challenges: {
        async incrementAttemptByDigest() {
          return challenge;
        },
        async consumeVerifiedChallenge() {
          return challenge;
        },
      },
      mfaMethods: {
        async findActiveTotp() {
          return {
            _id: new ObjectId(),
            userId,
            type: 'TOTP',
            status: 'ACTIVE',
            encryptedSecret: 'encrypted-secret',
            recoveryCodes: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
      jwt: {
        createAccessToken(input: Record<string, unknown>) {
          return `jwt:${(input.authenticationMethods as string[]).join(',')}`;
        },
      },
      totp: {
        decryptSecret() {
          return 'totp-secret';
        },
        verifyCode() {
          return true;
        },
      },
      refreshTokens: {
        async issue() {
          return { rawToken: 'refresh-token' };
        },
      },
    });

    await expect(
      service.completeMfaLogin({
        mfaChallengeToken: 'mfa-token',
        factorType: 'TOTP',
        credential: '123456',
        metadata: { ipAddress: '127.0.0.1' },
      }),
    ).resolves.toMatchObject({
      accessToken: 'jwt:pwd,totp',
      refreshToken: 'refresh-token',
      clientType: 'MOBILE',
      restrictedUntilVerified: false,
    });
    expect(createdSessionInput).toMatchObject({
      authenticationMethods: ['pwd', 'totp'],
      mfaSatisfiedAt: expect.any(Date),
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'MFA_VERIFICATION_SUCCEEDED', result: 'SUCCESS' }),
    );
  });

  test('totp confirmation stores recovery code digests and returns raw codes once', async () => {
    const userId = new ObjectId();
    const sessionId = new ObjectId();
    const methodId = new ObjectId();
    let storedRecoveryCodes: Array<Record<string, unknown>> = [];
    const service = serviceWithFakes({
      identity: {
        async findById() {
          return activeUser(userId);
        },
      },
      sessions: {
        async findActive() {
          return activeSession(userId, sessionId);
        },
        async markMfaSatisfied() {},
      },
      mfaMethods: {
        async findPendingTotp() {
          return {
            _id: methodId,
            userId,
            type: 'TOTP',
            status: 'PENDING',
            encryptedSecret: 'encrypted-secret',
            recoveryCodes: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
        async activateTotpWithRecoveryCodes(
          _methodId: ObjectId,
          recoveryCodes: Array<Record<string, unknown>>,
        ) {
          storedRecoveryCodes = recoveryCodes;
          return true;
        },
      },
      jwt: {
        createAccessToken() {
          return 'fresh-access-token';
        },
      },
      totp: {
        decryptSecret() {
          return 'totp-secret';
        },
        verifyCode() {
          return true;
        },
      },
      credentialDigests: {
        hashHighEntropySecret(value: string) {
          return `digest:${value}`;
        },
      },
    });

    const result = await service.confirmTotpSetup({
      code: '123456',
      ctx: { userId: userId.toHexString(), authSessionId: sessionId.toHexString() } as never,
      metadata: { ipAddress: '127.0.0.1' },
    });

    expect(result.recoveryCodes).toHaveLength(10);
    expect(storedRecoveryCodes).toHaveLength(10);
    expect(storedRecoveryCodes[0]?.codeHash).toStartWith('digest:');
    expect(storedRecoveryCodes.map((code) => code.codeHash)).not.toContain(result.recoveryCodes[0]);
  });
});

function serviceWithFakes(
  overrides: {
    events?: Array<Record<string, unknown>>;
    identity?: Record<string, unknown>;
    sessions?: Record<string, unknown>;
    challenges?: Record<string, unknown>;
    mfaMethods?: Record<string, unknown>;
    passwordHasher?: Record<string, unknown>;
    credentialDigests?: Record<string, unknown>;
    jwt?: Record<string, unknown>;
    totp?: Record<string, unknown>;
    refreshTokens?: Record<string, unknown>;
  } = {},
) {
  const events = overrides.events ?? [];
  return new AuthApplicationService(
    {
      env: 'test',
      auth: {
        challengeMaxAttempts: 5,
        challengeMaxSendsPerHour: 5,
        challengeResendCooldownSeconds: 60,
        challengeTtlSeconds: 600,
        mfaChallengeTtlSeconds: 300,
        mfaChallengeMaxAttempts: 5,
        recoveryCodeCount: 10,
        loginIdentifierIpBlockMs: 15 * 60 * 1000,
        loginIdentifierIpMaxAttempts: 5,
        loginIdentifierIpWindowMs: 15 * 60 * 1000,
        loginIpMaxAttempts: 30,
        loginIpWindowMs: 15 * 60 * 1000,
        passwordResetIdentifierMaxPerHour: 3,
        passwordResetIpMaxPerHour: 10,
        refreshTokenTtlSeconds: 2_592_000,
        accessTokenTtlSeconds: 900,
        webRefreshCookieSameSite: 'LAX',
        jwtActiveKeyId: 'test',
        jwtPrivateKey: 'unused',
        jwtPublicKeys: {},
        otpHmacSecret: 'secret',
        totpEncryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
    } as never,
    {
      async withTransaction(operation: (tx: unknown) => Promise<unknown>) {
        return await operation({});
      },
    } as never,
    {
      async create() {
        throw new AppError({
          code: 'UNEXPECTED_CREATE',
          httpStatus: 500,
          message: 'Unexpected create',
        });
      },
      async findByLoginIdentifier() {
        return null;
      },
      ...overrides.identity,
    } as never,
    {
      ...overrides.sessions,
    } as never,
    {
      ...overrides.challenges,
    } as never,
    {
      async findActiveTotp() {
        return null;
      },
      ...overrides.mfaMethods,
    } as never,
    {
      async incrementBucket() {
        return { count: 1 };
      },
    } as never,
    {
      async write(event: Record<string, unknown>) {
        events.push(event);
      },
    } as never,
    {
      async hash() {
        return 'hash';
      },
      async verify() {
        return false;
      },
      ...overrides.passwordHasher,
    } as never,
    {
      randomSecret() {
        return 'secret';
      },
      hashHighEntropySecret(value: string) {
        return `hash:${value}`;
      },
      ...overrides.credentialDigests,
    } as never,
    {
      createAccessToken() {
        return 'access-token';
      },
      ...overrides.jwt,
    } as never,
    {
      ...overrides.totp,
    } as never,
    {
      ...overrides.refreshTokens,
    } as never,
  );
}

function activeUser(userId: ObjectId) {
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

function activeSession(userId: ObjectId, sessionId: ObjectId) {
  return {
    _id: sessionId,
    userId,
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
