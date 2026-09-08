import { describe, expect, test } from 'bun:test';
import { buildApp } from '../src/api/build-app';
import type { AppConfig } from '../src/config/config.types';

describe('auth routes', () => {
  test('web login sets refresh cookie and omits refresh token JSON', async () => {
    const calls: string[] = [];
    const app = await buildApp(fakeContainer(calls));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'user-agent': 'ReactNativeButIgnored' },
      payload: {
        identifier: 'a@example.com',
        password: 'password',
        clientType: 'WEB',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('__Secure-gym_refresh=refresh-token');
    expect(response.json().data.refreshToken).toBeUndefined();
    expect(calls).toEqual(['login:WEB']);
    await app.close();
  });

  test('mobile login returns refresh token JSON and does not set cookie', async () => {
    const app = await buildApp(fakeContainer());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        identifier: 'a@example.com',
        password: 'password',
        clientType: 'MOBILE',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.json().data.refreshToken).toBe('refresh-token');
    await app.close();
  });

  test('mfa-required login does not issue tokens or set a refresh cookie', async () => {
    const app = await buildApp(
      fakeContainer([], {
        async login() {
          return {
            status: 'MFA_REQUIRED',
            mfaChallengeToken: 'mfa-challenge-token',
            availableMethods: ['TOTP', 'RECOVERY_CODE'],
          };
        },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        identifier: 'a@example.com',
        password: 'password',
        clientType: 'WEB',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.json().data).toEqual({
      status: 'MFA_REQUIRED',
      mfaChallengeToken: 'mfa-challenge-token',
      availableMethods: ['TOTP', 'RECOVERY_CODE'],
    });
    await app.close();
  });

  test('web mfa login completion sets refresh cookie and omits refresh token JSON', async () => {
    const app = await buildApp(
      fakeContainer([], {
        async completeMfaLogin() {
          return { ...tokenResult('mfa-refresh-token'), clientType: 'WEB' };
        },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/login/verify',
      payload: {
        mfaChallengeToken: 'mfa-challenge-token',
        factorType: 'TOTP',
        credential: '123456',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('__Secure-gym_refresh=mfa-refresh-token');
    expect(response.json().data.refreshToken).toBeUndefined();
    expect(response.json().data.clientType).toBeUndefined();
    await app.close();
  });

  test('mobile mfa login completion returns refresh token JSON', async () => {
    const app = await buildApp(
      fakeContainer([], {
        async completeMfaLogin() {
          return { ...tokenResult('mfa-refresh-token'), clientType: 'MOBILE' };
        },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/login/verify',
      payload: {
        mfaChallengeToken: 'mfa-challenge-token',
        factorType: 'RECOVERY_CODE',
        credential: 'RECOVERY-CODE',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.json().data.refreshToken).toBe('mfa-refresh-token');
    expect(response.json().data.clientType).toBeUndefined();
    await app.close();
  });

  test('web refresh reads cookie, rotates it, and omits refresh token JSON', async () => {
    const app = await buildApp(fakeContainer());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        cookie: '__Secure-gym_refresh=old-refresh-token',
        origin: 'http://localhost:5173',
      },
      payload: {
        clientType: 'WEB',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('__Secure-gym_refresh=new-refresh-token');
    expect(response.json().data.refreshToken).toBeUndefined();
    await app.close();
  });

  test('api refresh uses JSON token and does not inspect user-agent for transport', async () => {
    const calls: string[] = [];
    const app = await buildApp(fakeContainer(calls));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { 'user-agent': 'Mozilla/5.0' },
      payload: {
        clientType: 'API',
        refreshToken: 'old-refresh-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.json().data.refreshToken).toBe('new-refresh-token');
    expect(calls).toContain('refresh:API:old-refresh-token');
    await app.close();
  });

  test('logout clears web refresh cookie even without bearer auth', async () => {
    const app = await buildApp(fakeContainer());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: '__Secure-gym_refresh=old-refresh-token',
        origin: 'http://localhost:5173',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
    expect(response.json() as unknown).toEqual({ data: { success: true } });
    await app.close();
  });
});

function fakeContainer(calls: string[] = [], authOverrides: Record<string, unknown> = {}) {
  return {
    config: testConfig(),
    database: {
      async ping() {
        return true;
      },
    },
    jwt: {
      verifyAccessToken() {
        throw new Error('unexpected auth in route transport test');
      },
    },
    authSessions: {
      async findActive() {
        return null;
      },
    },
    auth: {
      async login(input: { clientType: string }) {
        calls.push(`login:${input.clientType}`);
        return tokenResult('refresh-token');
      },
      async register(input: { clientType: string }) {
        calls.push(`register:${input.clientType}`);
        return tokenResult('refresh-token');
      },
      async refresh(input: { clientType: string; refreshToken: string }) {
        calls.push(`refresh:${input.clientType}:${input.refreshToken}`);
        return {
          accessToken: 'new-access-token',
          refreshToken: 'new-refresh-token',
          restrictedUntilVerified: false,
        };
      },
      async logout() {
        calls.push('logout');
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
        return { ...tokenResult('refresh-token'), clientType: 'API' };
      },
      async mfaStatus() {
        return { totpEnabled: false, mfaSatisfied: false, recoveryCodesRemaining: 0 };
      },
      async startTotpSetup() {
        return { secret: 'SECRET', provisioningUri: 'otpauth://totp/test' };
      },
      async confirmTotpSetup() {
        return { success: true as const, accessToken: 'access-token', recoveryCodes: [] };
      },
      async startStepUp() {
        return { mfaChallengeToken: 'step-up-token', availableMethods: ['TOTP'] };
      },
      async verifyStepUp() {
        return { success: true as const, accessToken: 'access-token' };
      },
      async regenerateRecoveryCodes() {
        return { success: true as const, recoveryCodes: ['code'] };
      },
      async disableMfa() {
        return { success: true as const };
      },
      ...authOverrides,
    },
  } as never;
}

function tokenResult(refreshToken: string) {
  return {
    accessToken: 'access-token',
    refreshToken,
    user: {
      id: 'user-id',
      firstName: 'A',
      lastName: 'User',
      email: 'a@example.com',
      emailVerified: true,
      phoneVerified: false,
    },
    restrictedUntilVerified: false,
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
      allowedOrigins: ['http://localhost:5173'],
    },
    mongo: {
      uri: 'mongodb://localhost:27017/test',
      dbName: 'test',
      connectTimeoutMs: 500,
    },
    logging: {
      level: 'silent',
    },
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
