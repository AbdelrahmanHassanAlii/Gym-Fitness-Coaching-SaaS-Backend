import type { ObjectId } from 'mongodb';
import type { CredentialDigests } from '../../core/auth/credential-digests';
import type { UnitOfWork } from '../../core/database/unit-of-work';
import type { AuthMfaMethodRepository, AuthSecurityEventWriter } from './auth.repositories';
import type { RecoveryCodeDigest } from './auth.types';

export class MfaService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly mfaMethods: AuthMfaMethodRepository,
    private readonly securityEvents: AuthSecurityEventWriter,
    private readonly credentialDigests: CredentialDigests,
  ) {}

  createRecoveryCodeDigests(rawCodes: string[], now = new Date()): RecoveryCodeDigest[] {
    return rawCodes.map((code) => ({
      codeHash: this.credentialDigests.hashHighEntropySecret(code),
      createdAt: now,
    }));
  }

  async consumeRecoveryCode(input: {
    userId: ObjectId;
    methodId: ObjectId;
    rawCode: string;
    sessionId?: ObjectId;
  }): Promise<boolean> {
    const now = new Date();
    const codeHash = this.credentialDigests.hashHighEntropySecret(input.rawCode);

    return await this.unitOfWork.withTransaction(async (tx) => {
      const consumed = await this.mfaMethods.consumeRecoveryCode(input.methodId, codeHash, now, tx);

      if (consumed) {
        await this.securityEvents.write(
          {
            type: 'MFA_RECOVERY_CODE_USED',
            userId: input.userId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            result: 'SUCCESS',
          },
          tx,
        );
      }

      return consumed;
    });
  }

  async regenerateRecoveryCodes(input: {
    userId: ObjectId;
    methodId: ObjectId;
    rawCodes: string[];
  }): Promise<boolean> {
    const now = new Date();
    const recoveryCodes = this.createRecoveryCodeDigests(input.rawCodes, now);

    return await this.unitOfWork.withTransaction(async (tx) => {
      const replaced = await this.mfaMethods.replaceRecoveryCodes(
        input.methodId,
        recoveryCodes,
        now,
        tx,
      );

      if (replaced) {
        await this.securityEvents.write(
          {
            type: 'MFA_RECOVERY_CODES_REGENERATED',
            userId: input.userId,
            result: 'SUCCESS',
          },
          tx,
        );
      }

      return replaced;
    });
  }
}
