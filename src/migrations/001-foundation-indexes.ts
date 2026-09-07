import type { Migration } from './migration.types';

export const migration001FoundationIndexes: Migration = {
  id: '001-foundation-indexes',
  description:
    'Create foundation indexes for migrations, audit, outbox, idempotency and job leases',
  async up(db) {
    await db.collection('db_migrations').createIndex({ migrationId: 1 }, { unique: true });

    await db.collection('audit_events').createIndexes([
      { key: { occurredAt: -1 }, name: 'audit_occurred_at' },
      { key: { workspaceId: 1, occurredAt: -1 }, name: 'audit_workspace_time' },
      { key: { 'actor.userId': 1, occurredAt: -1 }, name: 'audit_actor_time' },
      { key: { correlationId: 1 }, name: 'audit_correlation' },
    ]);

    await db.collection('outbox_events').createIndexes([
      {
        key: { status: 1, nextAttemptAt: 1, lockedUntil: 1, occurredAt: 1 },
        name: 'outbox_claim',
      },
      { key: { correlationId: 1 }, name: 'outbox_correlation' },
      { key: { processedAt: 1 }, name: 'outbox_processed_at' },
    ]);

    await db
      .collection('job_leases')
      .createIndex({ key: 1 }, { unique: true, name: 'job_lease_key' });

    await db.collection('idempotency_records').createIndexes([
      {
        key: { actorId: 1, routeKey: 1, key: 1 },
        unique: true,
        name: 'idempotency_command_key',
      },
      {
        key: { expiresAt: 1 },
        expireAfterSeconds: 0,
        name: 'idempotency_expiry_ttl',
      },
    ]);

    await db.collection('upload_intents').createIndexes([
      { key: { workspaceId: 1, status: 1, expiresAt: 1 }, name: 'upload_intent_workspace_status' },
      { key: { expiresAt: 1 }, name: 'upload_intent_expiry' },
    ]);
  },
};
