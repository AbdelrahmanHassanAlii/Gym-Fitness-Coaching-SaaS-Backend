import type { Migration } from './migration.types';

export const migration003Stage2MfaIndexes: Migration = {
  id: '003-stage2-mfa-indexes',
  description: 'Create Stage 2 MFA challenge lookup indexes',
  async up(db) {
    await db.collection('auth_challenges').createIndexes([
      {
        key: { purpose: 1, challengeDigest: 1 },
        name: 'auth_challenges_purpose_digest',
      },
    ]);
  },
};
