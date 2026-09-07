import { type Collection, ObjectId } from 'mongodb';
import type { AuthenticationMethod, AuthSecurityMetadata } from '../../core/auth/auth.types';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type {
  AuthChallengeDocument,
  AuthChallengePurpose,
  AuthMfaMethodDocument,
  AuthRateLimitDocument,
  AuthRateLimitScope,
  AuthRefreshTokenDocument,
  AuthSecurityEventDocument,
  AuthSessionDocument,
  RecoveryCodeDigest,
} from './auth.types';

export interface CreateAuthSessionInput extends AuthSecurityMetadata {
  userId: ObjectId;
  authenticationMethods: AuthenticationMethod[];
  restrictedUntilVerified: boolean;
  expiresAt: Date;
  deviceId?: string;
  deviceName?: string;
  platform?: string;
  mfaSatisfiedAt?: Date;
  now?: Date;
}

export interface CreateRefreshTokenInput {
  tokenId?: ObjectId;
  userId: ObjectId;
  sessionId: ObjectId;
  publicId: string;
  secretHash: string;
  expiresAt: Date;
  now?: Date;
}

export interface CreateChallengeInput extends AuthSecurityMetadata {
  purpose: AuthChallengePurpose;
  userId?: ObjectId;
  normalizedEmail?: string;
  normalizedPhone?: string;
  challengeDigest: string;
  digestContext: string;
  expiresAt: Date;
  maxAttempts: number;
  now?: Date;
}

export class AuthSessionRepository {
  private readonly sessions: Collection<AuthSessionDocument>;
  private readonly refreshTokens: Collection<AuthRefreshTokenDocument>;

  constructor(database: Database) {
    this.sessions = database.db.collection<AuthSessionDocument>('auth_sessions');
    this.refreshTokens = database.db.collection<AuthRefreshTokenDocument>('auth_refresh_tokens');
  }

  async create(
    input: CreateAuthSessionInput,
    tx?: TransactionContext,
  ): Promise<AuthSessionDocument> {
    const now = input.now ?? new Date();
    const session: AuthSessionDocument = {
      _id: new ObjectId(),
      userId: input.userId,
      status: 'ACTIVE',
      clientType: input.clientType ?? 'API',
      refreshTokenTransport: input.transport ?? 'JSON',
      ipAddress: input.ipAddress,
      authenticationMethods: input.authenticationMethods,
      restrictedUntilVerified: input.restrictedUntilVerified,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: input.expiresAt,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      ...(input.deviceName ? { deviceName: input.deviceName } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      ...(input.mfaSatisfiedAt ? { mfaSatisfiedAt: input.mfaSatisfiedAt } : {}),
    };

    await this.sessions.insertOne(session, tx ? { session: tx.session } : undefined);
    return session;
  }

  async findActive(
    sessionId: ObjectId,
    tx?: TransactionContext,
  ): Promise<AuthSessionDocument | null> {
    return await this.sessions.findOne(
      {
        _id: sessionId,
        status: 'ACTIVE',
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      },
      tx ? { session: tx.session } : undefined,
    );
  }

  async markSeen(sessionId: ObjectId, now = new Date(), tx?: TransactionContext): Promise<void> {
    await this.sessions.updateOne(
      { _id: sessionId, status: 'ACTIVE' },
      { $set: { lastSeenAt: now } },
      tx ? { session: tx.session } : undefined,
    );
  }

  async markMfaSatisfied(
    sessionId: ObjectId,
    method: AuthenticationMethod,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<void> {
    await this.sessions.updateOne(
      { _id: sessionId, status: 'ACTIVE' },
      {
        $set: { mfaSatisfiedAt: now, lastSeenAt: now },
        $addToSet: { authenticationMethods: method },
      },
      tx ? { session: tx.session } : undefined,
    );
  }

  async markVerifiedRestrictionResolved(
    sessionId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<void> {
    await this.sessions.updateOne(
      { _id: sessionId, status: 'ACTIVE', restrictedUntilVerified: true },
      { $set: { restrictedUntilVerified: false, lastSeenAt: now } },
      tx ? { session: tx.session } : undefined,
    );
  }

  async revokeSessionFamily(
    sessionId: ObjectId,
    reason: string,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<void> {
    const options = tx ? { session: tx.session } : undefined;
    await this.sessions.updateOne(
      { _id: sessionId, status: 'ACTIVE' },
      { $set: { status: 'REVOKED', revokedAt: now, revokeReason: reason } },
      options,
    );
    await this.refreshTokens.updateMany(
      { sessionId, status: { $ne: 'REVOKED' } },
      { $set: { status: 'REVOKED', revokedAt: now } },
      options,
    );
  }

  async revokeAllUserSessions(
    userId: ObjectId,
    reason: string,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<void> {
    const options = tx ? { session: tx.session } : undefined;
    const sessionIds = await this.sessions
      .find({ userId, status: 'ACTIVE' }, { projection: { _id: 1 }, ...options })
      .map((session) => session._id)
      .toArray();

    await this.sessions.updateMany(
      { userId, status: 'ACTIVE' },
      { $set: { status: 'REVOKED', revokedAt: now, revokeReason: reason } },
      options,
    );

    if (sessionIds.length > 0) {
      await this.refreshTokens.updateMany(
        { sessionId: { $in: sessionIds }, status: { $ne: 'REVOKED' } },
        { $set: { status: 'REVOKED', revokedAt: now } },
        options,
      );
    }
  }
}

export class AuthRefreshTokenRepository {
  private readonly refreshTokens: Collection<AuthRefreshTokenDocument>;

  constructor(database: Database) {
    this.refreshTokens = database.db.collection<AuthRefreshTokenDocument>('auth_refresh_tokens');
  }

  async create(
    input: CreateRefreshTokenInput,
    tx?: TransactionContext,
  ): Promise<AuthRefreshTokenDocument> {
    const now = input.now ?? new Date();
    const token: AuthRefreshTokenDocument = {
      _id: input.tokenId ?? new ObjectId(),
      publicId: input.publicId,
      sessionId: input.sessionId,
      userId: input.userId,
      secretHash: input.secretHash,
      status: 'CURRENT',
      createdAt: now,
      expiresAt: input.expiresAt,
    };

    await this.refreshTokens.insertOne(token, tx ? { session: tx.session } : undefined);
    return token;
  }

  async findByPublicId(
    publicId: string,
    tx?: TransactionContext,
  ): Promise<AuthRefreshTokenDocument | null> {
    return await this.refreshTokens.findOne({ publicId }, tx ? { session: tx.session } : undefined);
  }

  async consumeCurrentAndReplace(
    currentTokenId: ObjectId,
    replacement: CreateRefreshTokenInput,
    now = new Date(),
    tx: TransactionContext,
  ): Promise<AuthRefreshTokenDocument> {
    const replacementTokenId = replacement.tokenId ?? new ObjectId();
    const result = await this.refreshTokens.updateOne(
      {
        _id: currentTokenId,
        status: 'CURRENT',
        consumedAt: { $exists: false },
        expiresAt: { $gt: now },
      },
      {
        $set: {
          status: 'CONSUMED',
          consumedAt: now,
          replacedByTokenId: replacementTokenId,
        },
      },
      { session: tx.session },
    );

    if (result.modifiedCount !== 1) {
      throw new AppError({
        code: 'REFRESH_TOKEN_ROTATION_CONFLICT',
        httpStatus: 409,
        message: 'The refresh token could not be rotated.',
      });
    }

    const newToken = await this.create({ ...replacement, tokenId: replacementTokenId, now }, tx);
    return newToken;
  }

  async revokeBySession(
    sessionId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<void> {
    await this.refreshTokens.updateMany(
      { sessionId, status: { $ne: 'REVOKED' } },
      { $set: { status: 'REVOKED', revokedAt: now } },
      tx ? { session: tx.session } : undefined,
    );
  }
}

export class AuthChallengeRepository {
  private readonly challenges: Collection<AuthChallengeDocument>;

  constructor(database: Database) {
    this.challenges = database.db.collection<AuthChallengeDocument>('auth_challenges');
  }

  async create(
    input: CreateChallengeInput,
    tx?: TransactionContext,
  ): Promise<AuthChallengeDocument> {
    const now = input.now ?? new Date();
    const challenge: AuthChallengeDocument = {
      _id: new ObjectId(),
      purpose: input.purpose,
      challengeDigest: input.challengeDigest,
      digestContext: input.digestContext,
      expiresAt: input.expiresAt,
      attemptCount: 0,
      maxAttempts: input.maxAttempts,
      resendCount: 0,
      createdAt: now,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.normalizedEmail ? { normalizedEmail: input.normalizedEmail } : {}),
      ...(input.normalizedPhone ? { normalizedPhone: input.normalizedPhone } : {}),
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    };

    await this.challenges.insertOne(challenge, tx ? { session: tx.session } : undefined);
    return challenge;
  }

  async incrementAttempt(challengeId: ObjectId, now = new Date()): Promise<AuthChallengeDocument> {
    const challenge = await this.challenges.findOneAndUpdate(
      {
        _id: challengeId,
        consumedAt: { $exists: false },
        expiresAt: { $gt: now },
        $expr: { $lt: ['$attemptCount', '$maxAttempts'] },
      },
      { $inc: { attemptCount: 1 } },
      { returnDocument: 'after' },
    );

    if (!challenge) {
      throw new AppError({
        code: 'AUTH_CHALLENGE_NOT_VERIFIABLE',
        httpStatus: 409,
        message: 'The authentication challenge cannot be verified.',
      });
    }

    return challenge;
  }

  async consume(
    challengeId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<boolean> {
    const result = await this.challenges.updateOne(
      {
        _id: challengeId,
        consumedAt: { $exists: false },
        expiresAt: { $gt: now },
      },
      { $set: { consumedAt: now } },
      tx ? { session: tx.session } : undefined,
    );
    return result.modifiedCount === 1;
  }

  async invalidateActivePasswordResetChallenges(
    userId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<void> {
    await this.challenges.updateMany(
      {
        userId,
        purpose: 'PASSWORD_RESET',
        consumedAt: { $exists: false },
        expiresAt: { $gt: now },
      },
      { $set: { consumedAt: now } },
      tx ? { session: tx.session } : undefined,
    );
  }
}

export class AuthMfaMethodRepository {
  private readonly mfaMethods: Collection<AuthMfaMethodDocument>;

  constructor(database: Database) {
    this.mfaMethods = database.db.collection<AuthMfaMethodDocument>('auth_mfa_methods');
  }

  async upsertPendingTotp(
    userId: ObjectId,
    encryptedSecret: string,
    recoveryCodes: RecoveryCodeDigest[],
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<void> {
    await this.mfaMethods.updateOne(
      { userId, type: 'TOTP', status: 'PENDING' },
      {
        $set: { encryptedSecret, recoveryCodes, updatedAt: now },
        $setOnInsert: {
          _id: new ObjectId(),
          userId,
          type: 'TOTP',
          status: 'PENDING',
          createdAt: now,
        },
      },
      { upsert: true, ...(tx ? { session: tx.session } : {}) },
    );
  }

  async activate(methodId: ObjectId, now = new Date(), tx?: TransactionContext): Promise<void> {
    await this.mfaMethods.updateOne(
      { _id: methodId, status: 'PENDING' },
      { $set: { status: 'ACTIVE', activatedAt: now, updatedAt: now } },
      tx ? { session: tx.session } : undefined,
    );
  }

  async disable(userId: ObjectId, now = new Date(), tx?: TransactionContext): Promise<void> {
    await this.mfaMethods.updateMany(
      { userId, status: { $ne: 'DISABLED' } },
      { $set: { status: 'DISABLED', disabledAt: now, updatedAt: now } },
      tx ? { session: tx.session } : undefined,
    );
  }

  async consumeRecoveryCode(
    methodId: ObjectId,
    codeHash: string,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<boolean> {
    const result = await this.mfaMethods.updateOne(
      {
        _id: methodId,
        status: 'ACTIVE',
        recoveryCodes: { $elemMatch: { codeHash, consumedAt: { $exists: false } } },
      },
      { $set: { 'recoveryCodes.$.consumedAt': now, updatedAt: now } },
      tx ? { session: tx.session } : undefined,
    );
    return result.modifiedCount === 1;
  }

  async replaceRecoveryCodes(
    methodId: ObjectId,
    recoveryCodes: RecoveryCodeDigest[],
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<boolean> {
    const result = await this.mfaMethods.updateOne(
      {
        _id: methodId,
        status: { $in: ['PENDING', 'ACTIVE'] },
      },
      { $set: { recoveryCodes, updatedAt: now } },
      tx ? { session: tx.session } : undefined,
    );
    return result.modifiedCount === 1;
  }
}

export class AuthRateLimitRepository {
  private readonly rateLimits: Collection<AuthRateLimitDocument>;

  constructor(database: Database) {
    this.rateLimits = database.db.collection<AuthRateLimitDocument>('auth_rate_limits');
  }

  async incrementBucket(input: {
    scope: AuthRateLimitScope;
    key: string;
    windowMs: number;
    blockMs?: number;
    maxAttempts: number;
    now?: Date;
  }): Promise<AuthRateLimitDocument> {
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + input.windowMs);
    const expiredOrMissingExpression = {
      $or: [{ $eq: [{ $type: '$expiresAt' }, 'missing'] }, { $lte: ['$expiresAt', now] }],
    };
    const result = await this.rateLimits.findOneAndUpdate(
      {
        scope: input.scope,
        key: input.key,
      },
      [
        {
          $set: {
            scope: input.scope,
            key: input.key,
            count: {
              $cond: [expiredOrMissingExpression, 1, { $add: ['$count', 1] }],
            },
            windowStartedAt: {
              $cond: [expiredOrMissingExpression, now, '$windowStartedAt'],
            },
            expiresAt: {
              $cond: [expiredOrMissingExpression, expiresAt, '$expiresAt'],
            },
            updatedAt: now,
          },
        },
      ],
      { upsert: true, returnDocument: 'after' },
    );

    if (!result) {
      throw new Error('Rate-limit bucket upsert failed');
    }

    if (result.count >= input.maxAttempts && input.blockMs) {
      const blockedUntil = new Date(now.getTime() + input.blockMs);
      await this.rateLimits.updateOne(
        { _id: result._id },
        { $set: { blockedUntil, updatedAt: now } },
      );
      return { ...result, blockedUntil };
    }

    return result;
  }
}

const credentialMetadataKeys = new Set([
  'password',
  'passwordHash',
  'refreshToken',
  'refreshTokenSecret',
  'rawRefreshToken',
  'otp',
  'otpCode',
  'totpSecret',
  'encryptedSecret',
  'resetToken',
  'resetTokenSecret',
  'token',
  'recoveryCode',
  'recoveryCodes',
  'jwtPrivateKey',
  'jwtSigningKey',
  'privateKey',
  'encryptionKey',
  'otpHmacSecret',
  'totpEncryptionKey',
]);

export class AuthSecurityEventWriter {
  private readonly events: Collection<AuthSecurityEventDocument>;

  constructor(database: Database) {
    this.events = database.db.collection<AuthSecurityEventDocument>('auth_security_events');
  }

  async write(
    event: Omit<AuthSecurityEventDocument, '_id' | 'occurredAt'> & { occurredAt?: Date },
    tx?: TransactionContext,
  ): Promise<void> {
    const metadata = event.metadata ? this.scrubMetadata(event.metadata) : undefined;
    await this.events.insertOne(
      {
        ...event,
        ...(metadata ? { metadata } : {}),
        occurredAt: event.occurredAt ?? new Date(),
      },
      tx ? { session: tx.session } : undefined,
    );
  }

  private scrubMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    return scrubCredentialMetadata(metadata) as Record<string, unknown>;
  }
}

function scrubCredentialMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubCredentialMetadata(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !credentialMetadataKeys.has(key))
      .map(([key, nestedValue]) => [key, scrubCredentialMetadata(nestedValue)]),
  );
}
