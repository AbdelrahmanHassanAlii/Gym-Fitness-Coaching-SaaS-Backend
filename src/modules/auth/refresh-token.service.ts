import type { ObjectId } from 'mongodb';
import type { CredentialDigests } from '../../core/auth/credential-digests';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import { IdentityRepository } from '../identity/identity.repository';
import {
  AuthRefreshTokenRepository,
  AuthSecurityEventWriter,
  AuthSessionRepository,
} from './auth.repositories';
import type { AuthSessionDocument } from './auth.types';

export interface IssuedRefreshToken {
  tokenId: ObjectId;
  publicId: string;
  rawToken: string;
  session?: AuthSessionDocument;
}

export class RefreshTokenService {
  private readonly sessions: AuthSessionRepository;
  private readonly refreshTokens: AuthRefreshTokenRepository;
  private readonly securityEvents: AuthSecurityEventWriter;
  private readonly unitOfWork: UnitOfWork;
  private readonly identity: IdentityRepository;

  constructor(
    database: Database,
    private readonly credentialDigests: CredentialDigests,
  ) {
    this.sessions = new AuthSessionRepository(database);
    this.refreshTokens = new AuthRefreshTokenRepository(database);
    this.securityEvents = new AuthSecurityEventWriter(database);
    this.unitOfWork = new UnitOfWork(database);
    this.identity = new IdentityRepository(database);
  }

  parse(rawToken: string): { publicId: string; secret: string } {
    const [publicId, secret] = rawToken.split('.');
    if (!publicId || !secret) {
      throw new AppError({
        code: 'REFRESH_TOKEN_INVALID',
        httpStatus: 401,
        message: 'The refresh token is invalid.',
      });
    }
    return { publicId, secret };
  }

  async issue(input: {
    userId: ObjectId;
    sessionId: ObjectId;
    expiresAt: Date;
    tx?: TransactionContext;
  }): Promise<IssuedRefreshToken> {
    const publicId = this.credentialDigests.randomSecret(18);
    const secret = this.credentialDigests.randomSecret(32);
    const token = await this.refreshTokens.create(
      {
        userId: input.userId,
        sessionId: input.sessionId,
        publicId,
        secretHash: this.credentialDigests.hashHighEntropySecret(secret),
        expiresAt: input.expiresAt,
      },
      input.tx,
    );
    return { tokenId: token._id, publicId, rawToken: `${publicId}.${secret}` };
  }

  async rotate(rawToken: string, newExpiresAt: Date): Promise<IssuedRefreshToken> {
    const { publicId, secret } = this.parse(rawToken);
    const secretHash = this.credentialDigests.hashHighEntropySecret(secret);
    const now = new Date();

    const rotated = await this.unitOfWork.withTransaction(async (tx) => {
      const existing = await this.refreshTokens.findByPublicId(publicId, tx);
      if (!existing) {
        throw this.invalidRefreshToken();
      }

      if (!this.credentialDigests.matches(existing.secretHash, secretHash)) {
        throw this.invalidRefreshToken();
      }

      if (existing.status === 'CONSUMED') {
        await this.sessions.revokeSessionFamily(existing.sessionId, 'REFRESH_TOKEN_REUSE', now, tx);
        await this.securityEvents.write(
          {
            type: 'REFRESH_TOKEN_REUSE_DETECTED',
            userId: existing.userId,
            sessionId: existing.sessionId,
            result: 'DENIED',
            reasonCode: 'REFRESH_TOKEN_REUSE',
          },
          tx,
        );
        return 'REUSED' as const;
      }

      if (existing.status !== 'CURRENT' || existing.expiresAt <= now) {
        throw this.invalidRefreshToken();
      }

      const session = await this.sessions.findActive(existing.sessionId, tx);
      if (!session) {
        throw this.invalidRefreshToken();
      }

      if (session.restrictedUntilVerified) {
        const user = await this.identity.findById(existing.userId, tx);
        if (user?.emailVerifiedAt || user?.phoneVerifiedAt) {
          await this.sessions.markVerifiedRestrictionResolved(existing.sessionId, now, tx);
          session.restrictedUntilVerified = false;
        }
      }

      const replacementPublicId = this.credentialDigests.randomSecret(18);
      const replacementSecret = this.credentialDigests.randomSecret(32);
      const replacement = await this.refreshTokens.consumeCurrentAndReplace(
        existing._id,
        {
          userId: existing.userId,
          sessionId: existing.sessionId,
          publicId: replacementPublicId,
          secretHash: this.credentialDigests.hashHighEntropySecret(replacementSecret),
          expiresAt: newExpiresAt,
        },
        now,
        tx,
      );

      await this.sessions.markSeen(existing.sessionId, now, tx);
      await this.securityEvents.write(
        {
          type: 'REFRESH_ROTATED',
          userId: existing.userId,
          sessionId: existing.sessionId,
          result: 'SUCCESS',
        },
        tx,
      );

      return {
        tokenId: replacement._id,
        publicId: replacementPublicId,
        rawToken: `${replacementPublicId}.${replacementSecret}`,
        session,
      };
    });

    if (rotated === 'REUSED') {
      throw new AppError({
        code: 'REFRESH_TOKEN_REUSE_DETECTED',
        httpStatus: 401,
        message: 'Refresh-token reuse was detected.',
      });
    }

    return rotated;
  }

  private invalidRefreshToken(): AppError {
    return new AppError({
      code: 'REFRESH_TOKEN_INVALID',
      httpStatus: 401,
      message: 'The refresh token is invalid.',
    });
  }
}
