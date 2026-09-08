import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { AppConfig } from '../src/config/config.types';
import { base64UrlDecode } from '../src/core/auth/auth-codec';
import { CredentialDigests } from '../src/core/auth/credential-digests';
import { JwtService } from '../src/core/auth/jwt.service';
import { normalizePhoneToE164 } from '../src/core/auth/phone-normalizer';
import { TotpService } from '../src/core/auth/totp.service';
import { AppError } from '../src/core/errors/app-error';
import { migration002Stage2AuthIndexes } from '../src/migrations/002-stage2-auth-indexes';
import {
  AuthChallengeRepository,
  AuthMfaMethodRepository,
  AuthRefreshTokenRepository,
} from '../src/modules/auth/auth.repositories';
import type {
  AuthChallengeDocument,
  AuthMfaMethodDocument,
  AuthRefreshTokenDocument,
  AuthSecurityEventDocument,
  AuthSessionDocument,
} from '../src/modules/auth/auth.types';
import { RefreshTokenService } from '../src/modules/auth/refresh-token.service';
import { IdentityRepository } from '../src/modules/identity/identity.repository';

function authConfig(): AppConfig {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
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
    logging: {
      level: 'silent',
    },
    auth: {
      jwtActiveKeyId: 'test',
      jwtPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      jwtPublicKeys: {
        test: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      webRefreshCookieSameSite: 'LAX',
      otpHmacSecret: 'test-otp-secret',
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

describe('auth foundation', () => {
  test('normalizes Egyptian local phone numbers to E.164', () => {
    expect(normalizePhoneToE164('010 1234 5678')).toBe('+201012345678');
    expect(normalizePhoneToE164('+201012345678')).toBe('+201012345678');
  });

  test('rejects ambiguous phone numbers', () => {
    expect(() => normalizePhoneToE164('12345')).toThrow('phone number');
  });

  test('uses keyed challenge digests for low-entropy values', () => {
    const digests = new CredentialDigests(authConfig());
    const first = digests.hmacLowEntropySecret('123456', 'challenge-a');
    const second = digests.hmacLowEntropySecret('123456', 'challenge-b');

    expect(first).not.toBe(second);
  });

  test('round-trips Ed25519 JWT access tokens with auth methods', () => {
    const jwt = new JwtService(authConfig());
    const token = jwt.createAccessToken({
      userId: 'user-1',
      authSessionId: 'session-1',
      authenticationMethods: ['pwd', 'totp'],
      now: new Date(),
    });

    const [header] = token.split('.');
    expect(JSON.parse(base64UrlDecode(header ?? '').toString('utf8'))).toMatchObject({
      alg: 'EdDSA',
      kid: 'test',
    });
    expect(jwt.verifyAccessToken(token)).toMatchObject({
      sub: 'user-1',
      sid: 'session-1',
      amr: ['pwd', 'totp'],
    });
  });

  test('encrypts recoverable TOTP secrets without storing them in plain text', () => {
    const totp = new TotpService(authConfig());
    const secret = totp.generateSecret();
    const encryptedSecret = totp.encryptSecret(secret);

    expect(encryptedSecret).not.toContain(secret);
    expect(totp.decryptSecret(encryptedSecret)).toBe(secret);
  });

  test('creates standard TOTP provisioning data and verifies codes with skew', () => {
    const totp = new TotpService(authConfig());
    const secret = totp.generateSecret();
    const now = new Date('2026-09-08T12:00:00Z');
    const code = totp.generateCode(secret, now);

    expect(totp.provisioningUri({ secret, accountName: 'a@example.com' })).toContain(
      'otpauth://totp/',
    );
    expect(totp.verifyCode(secret, code, now)).toBe(true);
    expect(totp.verifyCode(secret, code, new Date(now.getTime() + 30_000))).toBe(true);
    expect(totp.verifyCode(secret, '000000', now)).toBe(false);
  });

  test('rejects invalid TOTP encryption key configuration', async () => {
    const originalEnv = { ...process.env };
    const { loadConfig } = await import('../src/config/config');
    try {
      process.env.NODE_ENV = 'test';
      process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
      process.env.TOTP_ENCRYPTION_KEY = 'bad-key';
      expect(() => loadConfig()).toThrow('TOTP_ENCRYPTION_KEY');
    } finally {
      process.env = originalEnv;
    }
  });

  test('uses partial string unique indexes for optional login identifiers', async () => {
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

    await migration002Stage2AuthIndexes.up(db as never);

    const userIndexes = calls.find((call) => call.collection === 'users')?.indexes as Array<{
      name: string;
      unique?: boolean;
      partialFilterExpression?: Record<string, unknown>;
    }>;

    expect(userIndexes).toContainEqual(
      expect.objectContaining({
        name: 'users_normalized_email_unique',
        unique: true,
        partialFilterExpression: { normalizedEmail: { $type: 'string' } },
      }),
    );
    expect(userIndexes).toContainEqual(
      expect.objectContaining({
        name: 'users_normalized_phone_unique',
        unique: true,
        partialFilterExpression: { normalizedPhone: { $type: 'string' } },
      }),
    );
  });

  test('supports users without optional email or phone and rejects empty normalized identifiers', async () => {
    const collections = new InMemoryCollections();
    const identity = new IdentityRepository(fakeDatabase(collections));

    const userA = await identity.create({
      passwordHash: 'hash-a',
      firstName: 'A',
      lastName: 'User',
      preferredLanguage: 'en',
      timezone: 'Africa/Cairo',
    });
    const userB = await identity.create({
      passwordHash: 'hash-b',
      firstName: 'B',
      lastName: 'User',
      preferredLanguage: 'en',
      timezone: 'Africa/Cairo',
    });

    expect(userA.normalizedEmail).toBeUndefined();
    expect(userB.normalizedPhone).toBeUndefined();
    await expect(
      identity.create({
        normalizedEmail: '',
        passwordHash: 'hash-c',
        firstName: 'C',
        lastName: 'User',
        preferredLanguage: 'en',
        timezone: 'Africa/Cairo',
      }),
    ).rejects.toThrow(AppError);
  });

  test('does not revoke a session family for a known refresh token with a bad secret', async () => {
    const collections = new InMemoryCollections();
    const database = fakeDatabase(collections);
    const digests = new CredentialDigests(authConfig());
    const service = new RefreshTokenService(database, digests);
    const userId = new ObjectId();
    const sessionId = new ObjectId();
    const publicId = 'refresh-public';

    collections.auth_sessions.push(activeSession({ userId, sessionId }));
    collections.auth_refresh_tokens.push({
      _id: new ObjectId(),
      publicId,
      sessionId,
      userId,
      secretHash: digests.hashHighEntropySecret('correct-secret'),
      status: 'CURRENT',
      createdAt: new Date(),
      expiresAt: futureDate(),
    });

    await expect(service.rotate(`${publicId}.wrong-secret`, futureDate())).rejects.toThrow(
      'refresh token is invalid',
    );

    expect(collections.auth_sessions[0]?.status).toBe('ACTIVE');
    expect(collections.auth_refresh_tokens[0]?.status).toBe('CURRENT');
    expect(collections.auth_security_events).toHaveLength(0);
  });

  test('replaying a consumed refresh token with the historical secret revokes the family', async () => {
    const collections = new InMemoryCollections();
    const database = fakeDatabase(collections);
    const digests = new CredentialDigests(authConfig());
    const service = new RefreshTokenService(database, digests);
    const userId = new ObjectId();
    const sessionId = new ObjectId();
    const publicId = 'refresh-public';

    collections.auth_sessions.push(activeSession({ userId, sessionId }));
    collections.auth_refresh_tokens.push({
      _id: new ObjectId(),
      publicId,
      sessionId,
      userId,
      secretHash: digests.hashHighEntropySecret('old-secret'),
      status: 'CONSUMED',
      createdAt: new Date(),
      expiresAt: futureDate(),
      consumedAt: new Date(),
      replacedByTokenId: new ObjectId(),
    });

    await expect(service.rotate(`${publicId}.old-secret`, futureDate())).rejects.toThrow(
      'Refresh-token reuse was detected',
    );

    expect(collections.auth_sessions[0]?.status).toBe('REVOKED');
    expect(collections.auth_refresh_tokens[0]?.status).toBe('REVOKED');
    expect(collections.auth_security_events[0]).toMatchObject({
      type: 'REFRESH_TOKEN_REUSE_DETECTED',
      result: 'DENIED',
    });
  });

  test('refresh re-evaluates verified user state and clears restricted session flag', async () => {
    const collections = new InMemoryCollections();
    const database = fakeDatabase(collections);
    const digests = new CredentialDigests(authConfig());
    const service = new RefreshTokenService(database, digests);
    const userId = new ObjectId();
    const sessionId = new ObjectId();
    const tokenId = new ObjectId();
    const publicId = 'refresh-public';

    collections.users.push({
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
    });
    collections.auth_sessions.push(
      activeSession({ userId, sessionId, restrictedUntilVerified: true }),
    );
    collections.auth_refresh_tokens.push({
      _id: tokenId,
      publicId,
      sessionId,
      userId,
      secretHash: digests.hashHighEntropySecret('secret'),
      status: 'CURRENT',
      createdAt: new Date(),
      expiresAt: futureDate(),
    });

    await service.rotate(`${publicId}.secret`, futureDate());

    expect(collections.auth_sessions[0]?.restrictedUntilVerified).toBe(false);
  });

  test('current refresh token can only be consumed once', async () => {
    const collections = new InMemoryCollections();
    const repository = new AuthRefreshTokenRepository(fakeDatabase(collections));
    const userId = new ObjectId();
    const sessionId = new ObjectId();
    const currentTokenId = new ObjectId();

    collections.auth_refresh_tokens.push({
      _id: currentTokenId,
      publicId: 'current-token',
      sessionId,
      userId,
      secretHash: 'secret-hash',
      status: 'CURRENT',
      createdAt: new Date(),
      expiresAt: futureDate(),
    });

    const tx = fakeTransaction();
    await repository.consumeCurrentAndReplace(
      currentTokenId,
      {
        userId,
        sessionId,
        publicId: 'replacement-token',
        secretHash: 'replacement-secret-hash',
        expiresAt: futureDate(),
      },
      new Date(),
      tx,
    );

    await expect(
      repository.consumeCurrentAndReplace(
        currentTokenId,
        {
          userId,
          sessionId,
          publicId: 'second-replacement-token',
          secretHash: 'second-replacement-secret-hash',
          expiresAt: futureDate(),
        },
        new Date(),
        tx,
      ),
    ).rejects.toThrow('could not be rotated');

    expect(
      collections.auth_refresh_tokens.filter((token) => token.status === 'CURRENT'),
    ).toHaveLength(1);
  });

  test('challenge can only be consumed once', async () => {
    const collections = new InMemoryCollections();
    const repository = new AuthChallengeRepository(fakeDatabase(collections));
    const challenge = await repository.create({
      purpose: 'EMAIL_VERIFICATION',
      challengeDigest: 'digest',
      digestContext: 'ctx',
      expiresAt: futureDate(),
      maxAttempts: 5,
      ipAddress: '127.0.0.1',
    });

    expect(await repository.consume(challenge._id)).toBe(true);
    expect(await repository.consume(challenge._id)).toBe(false);
  });

  test('challenge can be consumed on the final allowed attempt', async () => {
    const collections = new InMemoryCollections();
    const repository = new AuthChallengeRepository(fakeDatabase(collections));
    const challenge = await repository.create({
      purpose: 'EMAIL_VERIFICATION',
      challengeDigest: 'digest',
      digestContext: 'ctx',
      expiresAt: futureDate(),
      maxAttempts: 5,
      ipAddress: '127.0.0.1',
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await repository.incrementAttempt(challenge._id);
    }

    expect(
      await repository.consumeVerifiedChallenge(challenge._id, 'EMAIL_VERIFICATION'),
    ).toMatchObject({
      _id: challenge._id,
      consumedAt: expect.any(Date),
    });
  });

  test('recovery code can only be consumed once and regeneration replaces old digests', async () => {
    const collections = new InMemoryCollections();
    const repository = new AuthMfaMethodRepository(fakeDatabase(collections));
    const userId = new ObjectId();
    const methodId = new ObjectId();

    collections.auth_mfa_methods.push({
      _id: methodId,
      userId,
      type: 'TOTP',
      status: 'ACTIVE',
      encryptedSecret: 'encrypted',
      recoveryCodes: [{ codeHash: 'old-code', createdAt: new Date() }],
      activatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(await repository.consumeRecoveryCode(methodId, 'old-code')).toBe(true);
    expect(await repository.consumeRecoveryCode(methodId, 'old-code')).toBe(false);
    expect(
      await repository.replaceRecoveryCodes(methodId, [
        { codeHash: 'new-code', createdAt: new Date() },
      ]),
    ).toBe(true);
    expect(collections.auth_mfa_methods[0]?.recoveryCodes).toEqual([
      expect.objectContaining({ codeHash: 'new-code' }),
    ]);
  });
});

function futureDate(): Date {
  return new Date(Date.now() + 60_000);
}

function activeSession(input: {
  userId: ObjectId;
  sessionId: ObjectId;
  restrictedUntilVerified?: boolean;
}): AuthSessionDocument {
  return {
    _id: input.sessionId,
    userId: input.userId,
    status: 'ACTIVE',
    clientType: 'API',
    refreshTokenTransport: 'JSON',
    ipAddress: '127.0.0.1',
    authenticationMethods: ['pwd'],
    restrictedUntilVerified: input.restrictedUntilVerified ?? false,
    createdAt: new Date(),
    lastSeenAt: new Date(),
    expiresAt: futureDate(),
  };
}

class InMemoryCollections {
  users: Array<Record<string, unknown>> = [];
  auth_sessions: AuthSessionDocument[] = [];
  auth_refresh_tokens: AuthRefreshTokenDocument[] = [];
  auth_challenges: AuthChallengeDocument[] = [];
  auth_mfa_methods: AuthMfaMethodDocument[] = [];
  auth_security_events: AuthSecurityEventDocument[] = [];
  auth_rate_limits: Array<Record<string, unknown>> = [];
}

function fakeDatabase(collections: InMemoryCollections) {
  return {
    client: {
      startSession() {
        return {
          async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
            return await operation();
          },
          async endSession(): Promise<void> {},
        };
      },
    },
    db: {
      collection(name: keyof InMemoryCollections) {
        return new FakeCollection(collections[name] as Array<Record<string, unknown>>);
      },
    },
  } as never;
}

function fakeTransaction() {
  return { session: {} } as never;
}

class FakeCollection<TDocument extends Record<string, unknown>> {
  constructor(private readonly documents: TDocument[]) {}

  async insertOne(document: TDocument): Promise<void> {
    this.documents.push(document);
  }

  async findOne(filter: Record<string, unknown>): Promise<TDocument | null> {
    return this.documents.find((document) => matches(document, filter)) ?? null;
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ modifiedCount: number }> {
    const document = await this.findOne(filter);
    if (!document) return { modifiedCount: 0 };
    applyUpdate(document, update);
    return { modifiedCount: 1 };
  }

  async updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ modifiedCount: number }> {
    let modifiedCount = 0;
    for (const document of this.documents) {
      if (matches(document, filter)) {
        applyUpdate(document, update);
        modifiedCount += 1;
      }
    }
    return { modifiedCount };
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<TDocument | null> {
    const document = await this.findOne(filter);
    if (!document) return null;
    applyUpdate(document, update);
    return document;
  }

  find(filter: Record<string, unknown>) {
    const results = this.documents.filter((document) => matches(document, filter));
    return {
      map<TResult>(mapper: (document: TDocument) => TResult) {
        return {
          async toArray(): Promise<TResult[]> {
            return results.map(mapper);
          },
        };
      },
    };
  }
}

function matches(document: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    const actual = document[key];
    if (key === '$expr') {
      if (!matchesExpression(document, expected as Record<string, unknown>)) return false;
      continue;
    }
    if (isObjectId(actual) && isObjectId(expected)) {
      if (!actual.equals(expected)) return false;
      continue;
    }
    if (expected && typeof expected === 'object' && !isObjectId(expected)) {
      if ('$exists' in expected) {
        const exists = actual !== undefined;
        if (exists !== expected.$exists) return false;
        continue;
      }
      if ('$gt' in expected) {
        if (
          !(actual instanceof Date) ||
          !(expected.$gt instanceof Date) ||
          actual <= expected.$gt
        ) {
          return false;
        }
        continue;
      }
      if ('$ne' in expected) {
        if (actual === expected.$ne) return false;
        continue;
      }
      if ('$in' in expected) {
        if (!Array.isArray(expected.$in) || !expected.$in.includes(actual)) return false;
        continue;
      }
      if ('$elemMatch' in expected) {
        if (!Array.isArray(actual)) return false;
        const elementFilter = expected.$elemMatch as Record<string, unknown>;
        if (!actual.some((item) => matches(item as Record<string, unknown>, elementFilter))) {
          return false;
        }
        continue;
      }
    }
    if (actual !== expected) return false;
  }
  return true;
}

function matchesExpression(document: Record<string, unknown>, expression: Record<string, unknown>) {
  if ('$lt' in expression) {
    const [left, right] = expression.$lt as [string, string];
    return valueAt(document, left) < valueAt(document, right);
  }
  if ('$lte' in expression) {
    const [left, right] = expression.$lte as [string, string];
    return valueAt(document, left) <= valueAt(document, right);
  }
  return false;
}

function valueAt(document: Record<string, unknown>, path: string): number {
  return Number(document[path.replace('$', '')]);
}

function applyUpdate(document: Record<string, unknown>, update: Record<string, unknown>): void {
  if ('$set' in update) {
    for (const [key, value] of Object.entries(update.$set as Record<string, unknown>)) {
      if (key.includes('$.')) {
        applyPositionalSet(document, key, value);
      } else {
        document[key] = value;
      }
    }
  }
  if ('$inc' in update) {
    for (const [key, value] of Object.entries(update.$inc as Record<string, number>)) {
      document[key] = Number(document[key]) + value;
    }
  }
  if ('$addToSet' in update) {
    for (const [key, value] of Object.entries(update.$addToSet as Record<string, unknown>)) {
      const current = document[key];
      if (Array.isArray(current) && !current.includes(value)) {
        current.push(value);
      }
    }
  }
}

function applyPositionalSet(document: Record<string, unknown>, key: string, value: unknown): void {
  const [arrayKey, field] = key.split('.$.');
  const array = arrayKey ? document[arrayKey] : undefined;
  if (!Array.isArray(array) || !field) return;
  const target = array.find(
    (item) => typeof item === 'object' && item && !('consumedAt' in item),
  ) as Record<string, unknown> | undefined;
  if (target) target[field] = value;
}

function isObjectId(value: unknown): value is ObjectId {
  return value instanceof ObjectId;
}
