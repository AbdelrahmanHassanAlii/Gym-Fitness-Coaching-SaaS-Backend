import type { Migration } from './migration.types';

export const migration002Stage2AuthIndexes: Migration = {
  id: '002-stage2-auth-indexes',
  description: 'Create Stage 2 identity and authentication collections and indexes',
  async up(db) {
    await db.collection('users').createIndexes([
      {
        key: { normalizedEmail: 1 },
        unique: true,
        partialFilterExpression: { normalizedEmail: { $type: 'string' } },
        name: 'users_normalized_email_unique',
      },
      {
        key: { normalizedPhone: 1 },
        unique: true,
        partialFilterExpression: { normalizedPhone: { $type: 'string' } },
        name: 'users_normalized_phone_unique',
      },
      { key: { status: 1 }, name: 'users_status' },
    ]);

    await db.collection('auth_sessions').createIndexes([
      { key: { userId: 1, status: 1 }, name: 'auth_sessions_user_status' },
      { key: { userId: 1, revokedAt: 1 }, name: 'auth_sessions_user_revoked' },
      { key: { expiresAt: 1 }, name: 'auth_sessions_expires_at' },
    ]);

    await db.collection('auth_refresh_tokens').createIndexes([
      {
        key: { publicId: 1 },
        unique: true,
        name: 'auth_refresh_tokens_public_id_unique',
      },
      { key: { sessionId: 1, status: 1 }, name: 'auth_refresh_tokens_session_status' },
      { key: { userId: 1, sessionId: 1 }, name: 'auth_refresh_tokens_user_session' },
      { key: { expiresAt: 1 }, name: 'auth_refresh_tokens_expires_at' },
    ]);

    await db.collection('auth_challenges').createIndexes([
      { key: { userId: 1, purpose: 1, expiresAt: 1 }, name: 'auth_challenges_user_purpose' },
      {
        key: { normalizedEmail: 1, purpose: 1, expiresAt: 1 },
        sparse: true,
        name: 'auth_challenges_email_purpose',
      },
      {
        key: { normalizedPhone: 1, purpose: 1, expiresAt: 1 },
        sparse: true,
        name: 'auth_challenges_phone_purpose',
      },
      {
        key: { expiresAt: 1 },
        expireAfterSeconds: 0,
        name: 'auth_challenges_expiry_ttl',
      },
    ]);

    await db.collection('auth_mfa_methods').createIndexes([
      {
        key: { userId: 1, type: 1, status: 1 },
        name: 'auth_mfa_methods_user_type_status',
      },
      {
        key: { userId: 1, type: 1 },
        unique: true,
        partialFilterExpression: { status: { $in: ['PENDING', 'ACTIVE'] } },
        name: 'auth_mfa_methods_one_enabled_type_per_user',
      },
    ]);

    await db.collection('auth_rate_limits').createIndexes([
      {
        key: { scope: 1, key: 1 },
        unique: true,
        name: 'auth_rate_limits_scope_key_unique',
      },
      {
        key: { expiresAt: 1 },
        expireAfterSeconds: 0,
        name: 'auth_rate_limits_expiry_ttl',
      },
    ]);

    await db.collection('auth_security_events').createIndexes([
      { key: { occurredAt: -1 }, name: 'auth_security_events_time' },
      { key: { userId: 1, occurredAt: -1 }, name: 'auth_security_events_user_time' },
      { key: { sessionId: 1, occurredAt: -1 }, name: 'auth_security_events_session_time' },
      { key: { type: 1, occurredAt: -1 }, name: 'auth_security_events_type_time' },
      { key: { ipAddress: 1, occurredAt: -1 }, name: 'auth_security_events_ip_time' },
    ]);
  },
};
