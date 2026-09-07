import type { ObjectId } from 'mongodb';
import type { PasswordHasher } from '../../core/auth/password-hasher';
import type { UnitOfWork } from '../../core/database/unit-of-work';
import type { IdentityRepository } from '../identity/identity.repository';
import type {
  AuthChallengeRepository,
  AuthSecurityEventWriter,
  AuthSessionRepository,
} from './auth.repositories';

export class PasswordResetService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly identity: IdentityRepository,
    private readonly challenges: AuthChallengeRepository,
    private readonly sessions: AuthSessionRepository,
    private readonly securityEvents: AuthSecurityEventWriter,
    private readonly passwordHasher: PasswordHasher,
  ) {}

  async completeReset(input: {
    userId: ObjectId;
    challengeId: ObjectId;
    newPassword: string;
  }): Promise<void> {
    const now = new Date();
    const passwordHash = await this.passwordHasher.hash(input.newPassword);

    await this.unitOfWork.withTransaction(async (tx) => {
      const consumed = await this.challenges.consume(input.challengeId, now, tx);
      if (!consumed) {
        throw new Error('Password reset challenge was not consumable');
      }

      await this.challenges.invalidateActivePasswordResetChallenges(input.userId, now, tx);
      await this.identity.updatePasswordHash(input.userId, passwordHash, now, tx);
      await this.sessions.revokeAllUserSessions(input.userId, 'PASSWORD_RESET', now, tx);
      await this.securityEvents.write(
        {
          type: 'PASSWORD_RESET_COMPLETED',
          userId: input.userId,
          result: 'SUCCESS',
        },
        tx,
      );
    });
  }
}
