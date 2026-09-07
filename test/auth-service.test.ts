import { describe, expect, test } from 'bun:test';
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
});

function serviceWithFakes(
  overrides: { events?: Array<Record<string, unknown>>; identity?: Record<string, unknown> } = {},
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
    {} as never,
    {} as never,
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
    } as never,
    {} as never,
    {} as never,
    {} as never,
  );
}
