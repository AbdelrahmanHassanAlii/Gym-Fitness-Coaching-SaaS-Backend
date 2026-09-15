import { afterEach, describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { type AppContainer, createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { OutboxProcessor } from '../src/core/events/outbox.processor';
import { createLoggerOptions } from '../src/core/logging/logger';
import { migrations } from '../src/migrations';
import { migration019Stage14Notifications } from '../src/migrations/019-stage14-notifications';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { registerNotificationOutboxHandlers } from '../src/modules/notifications/notification.outbox-handlers';

const containers: AppContainer[] = [];
const INTEGRATION_TIMEOUT_MS = 30_000;

afterEach(async () => {
  while (containers.length > 0) {
    const container = containers.pop();
    if (!container) continue;
    await container.database.db.dropDatabase();
    await container.database.close();
  }
});

describe('Stage 14 migration 019', () => {
  test('creates only notification indexes and no receipt collection', async () => {
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

    await migration019Stage14Notifications.up(db as never);

    expect(indexes(calls, 'notifications')).toContainEqual(
      expect.objectContaining({ name: 'notifications_dedupe_unique', unique: true }),
    );
    expect(indexes(calls, 'notification_preferences')).toContainEqual(
      expect.objectContaining({ name: 'notification_preferences_user_unique', unique: true }),
    );
    expect(indexes(calls, 'notification_deliveries')).toContainEqual(
      expect.objectContaining({ name: 'notification_deliveries_logical_key_unique', unique: true }),
    );
    expect(indexes(calls, 'push_devices')).toContainEqual(
      expect.objectContaining({ name: 'push_devices_user_token_unique', unique: true }),
    );
    expect(indexes(calls, 'notification_event_receipts')).toBeUndefined();
  });

  test(
    'runs clean, reruns, and enforces uniqueness',
    async () => {
      const container = await stage14Container(`stage14_migration_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      await new MigrationRunner(container.database.db, migrations).migrate();

      const names = (await container.database.db.collection('notifications').indexes()).map(
        (index) => index.name,
      );
      expect(names).toContain('notifications_source_recipient_type_unique');

      const userId = new ObjectId();
      const sourceEventId = new ObjectId();
      const base = notificationRecord(userId, sourceEventId);
      await container.database.db.collection('notifications').insertOne(base);
      await expect(
        container.database.db
          .collection('notifications')
          .insertOne({ ...base, _id: new ObjectId() }),
      ).rejects.toMatchObject({ code: 11000 });
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

describe('Stage 14 notification behavior', () => {
  test(
    'outbox supports existing and notification handlers for the same event type',
    async () => {
      const container = await stage14Container(`stage14_outbox_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const sourceEventId = await seedCheckInDueEvent(container);
      let existingHandlerCalls = 0;
      const processor = new OutboxProcessor(container.database, container.config, console as never);
      processor.register('CheckInDue', async () => {
        existingHandlerCalls += 1;
      });
      registerNotificationOutboxHandlers(processor, container.notifications);

      expect(await processor.processOne()).toBe(true);
      expect(existingHandlerCalls).toBe(1);
      expect(
        await container.database.db.collection('notifications').countDocuments({ sourceEventId }),
      ).toBe(1);
      expect(
        await container.database.db.collection('outbox_events').findOne({ _id: sourceEventId }),
      ).toMatchObject({ status: 'PROCESSED' });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'duplicate and racing source-event consumption creates one in-app notification and one email delivery',
    async () => {
      const container = await stage14Container(`stage14_replay_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const sourceEventId = await seedCheckInDueEvent(container);
      const event = await container.database.db
        .collection('outbox_events')
        .findOne({ _id: sourceEventId });
      expect(event).toBeTruthy();

      await Promise.all([
        container.notifications.handleOutboxEvent(event as never),
        container.notifications.handleOutboxEvent(event as never),
        container.notifications.handleOutboxEvent(event as never),
      ]);

      expect(
        await container.database.db.collection('notifications').countDocuments({ sourceEventId }),
      ).toBe(1);
      expect(
        await container.database.db.collection('notification_deliveries').countDocuments({
          sourceEventId,
          channel: 'EMAIL',
        }),
      ).toBe(1);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'aggregate-only workout and program events resolve recipients from authoritative aggregate state',
    async () => {
      const container = await stage14Container(`stage14_aggregate_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const seed = await seedRelationshipWithStaff(container);
      const workoutId = new ObjectId();
      const programId = new ObjectId();
      const workoutEventId = new ObjectId();
      const programEventId = new ObjectId();
      await container.database.db.collection('workout_sessions').insertOne({
        _id: workoutId,
        workspaceId: seed.workspaceId,
        relationshipId: seed.relationshipId,
        traineeUserId: seed.traineeUserId,
        status: 'COMPLETED',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await container.database.db.collection('programs').insertOne({
        _id: programId,
        workspaceId: seed.workspaceId,
        relationshipId: seed.relationshipId,
        name: 'Program',
        status: 'ACTIVE',
        currentRevisionId: new ObjectId(),
        assignedBy: seed.staffMembershipId,
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 0,
      });
      const workoutEvent = outboxEvent({
        _id: workoutEventId,
        eventType: 'WorkoutCompleted',
        aggregateType: 'workout_session',
        aggregateId: workoutId,
        workspaceId: seed.workspaceId,
      });
      const programEvent = outboxEvent({
        _id: programEventId,
        eventType: 'ProgramActivated',
        aggregateType: 'program',
        aggregateId: programId,
        workspaceId: seed.workspaceId,
      });

      await container.notifications.handleOutboxEvent(workoutEvent as never);
      await container.notifications.handleOutboxEvent(programEvent as never);

      expect(
        await container.database.db.collection('notifications').countDocuments({
          sourceEventId: workoutEventId,
          recipientUserId: seed.staffUserId,
        }),
      ).toBe(1);
      expect(
        await container.database.db.collection('notifications').countDocuments({
          sourceEventId: programEventId,
          recipientUserId: seed.traineeUserId,
        }),
      ).toBe(1);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'preference expectedVersion race allows exactly one update and cancels pending optional send',
    async () => {
      const container = await stage14Container(`stage14_prefs_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const sourceEventId = await seedCheckInDueEvent(container);
      const event = await container.database.db
        .collection('outbox_events')
        .findOne({ _id: sourceEventId });
      await container.notifications.handleOutboxEvent(event as never);
      const userId = (
        await container.database.db.collection('users').findOne({ email: 'trainee@example.test' })
      )?._id;
      expect(userId).toBeInstanceOf(ObjectId);
      if (!(userId instanceof ObjectId)) throw new Error('Expected trainee user.');

      const request = {
        expectedVersion: 0,
        channels: { email: false },
      };
      const results = await Promise.allSettled([
        container.notifications.putPreferences(ctx(userId), request),
        container.notifications.putPreferences(ctx(userId), request),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

      await container.notifications.processDueDeliveries(container.jobLeases);
      expect(
        await container.database.db
          .collection('notification_deliveries')
          .findOne({ sourceEventId }),
      ).toMatchObject({ status: 'CANCELLED', cancelledReason: 'PREFERENCES_DISABLED' });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'stale CheckInDue is suppressed after submission and mark-all uses cutoff semantics',
    async () => {
      const container = await stage14Container(`stage14_stale_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const sourceEventId = await seedCheckInDueEvent(container, 'SUBMITTED');
      const event = await container.database.db
        .collection('outbox_events')
        .findOne({ _id: sourceEventId });
      await container.notifications.handleOutboxEvent(event as never);
      expect(await container.database.db.collection('notifications').countDocuments()).toBe(0);

      const userId = (
        await container.database.db.collection('users').findOne({ email: 'trainee@example.test' })
      )?._id;
      expect(userId).toBeInstanceOf(ObjectId);
      if (!(userId instanceof ObjectId)) throw new Error('Expected trainee user.');
      await container.database.db
        .collection('notifications')
        .insertOne(
          notificationRecord(userId, new ObjectId(), { createdAt: new Date(Date.now() - 1000) }),
        );
      const readAll = await container.notifications.markAllRead(ctx(userId));
      await container.database.db
        .collection('notifications')
        .insertOne(
          notificationRecord(userId, new ObjectId(), { createdAt: new Date(Date.now() + 1000) }),
        );
      expect(readAll.data.affectedCount).toBe(1);
      expect(
        await container.database.db.collection('notifications').countDocuments({
          recipientUserId: userId,
          readAt: { $exists: false },
        }),
      ).toBe(1);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'push-device registration dedupes, claim CAS is single-winner, and revoke cancels queued push',
    async () => {
      const container = await stage14Container(`stage14_push_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const userId = new ObjectId();
      await container.database.db
        .collection('users')
        .insertOne(userRecord(userId, 'push@example.test'));
      const context = ctx(userId);
      const a = await container.notifications.registerPushDevice(context, {
        platform: 'WEB',
        provider: 'test',
        token: 'raw-push-token-secret',
      });
      const b = await container.notifications.registerPushDevice(context, {
        platform: 'WEB',
        provider: 'test',
        token: 'raw-push-token-secret',
      });
      expect(a.data.id).toBe(b.data.id);
      expect(JSON.stringify(a)).not.toContain('raw-push-token-secret');

      await container.database.db.collection('notification_deliveries').insertOne({
        _id: new ObjectId(),
        sourceEventId: new ObjectId(),
        recipientUserId: userId,
        channel: 'PUSH',
        status: 'PENDING',
        attemptCount: 0,
        destinationSnapshot: {
          kind: 'PUSH_DEVICE',
          fingerprint: a.data.tokenFingerprint,
          pushDeviceId: new ObjectId(a.data.id),
        },
        logicalDeliveryKey: 'push-race',
        providerSupportsIdempotency: false,
        version: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const [claimA, claimB] = await Promise.all([
        container.notificationsRepo.claimNextDelivery({
          workerId: 'a',
          now: new Date(),
          claimMs: 60_000,
        }),
        container.notificationsRepo.claimNextDelivery({
          workerId: 'b',
          now: new Date(),
          claimMs: 60_000,
        }),
      ]);
      expect([claimA, claimB].filter(Boolean)).toHaveLength(1);
      await container.notificationsRepo.cancelDelivery(
        (claimA ?? claimB) as never,
        'TEST_RELEASE',
        new Date(),
      );
      await container.notifications.revokePushDevice(context, a.data.id);
      expect(
        await container.database.db.collection('notification_deliveries').findOne({
          logicalDeliveryKey: 'push-race',
        }),
      ).toMatchObject({ status: 'CANCELLED' });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test('logger redacts push tokens, provider keys, authorization, and secret URLs', () => {
    const options = createLoggerOptions({
      ...integrationConfig('stage14_logger'),
      logging: { level: 'info' },
    });
    const paths = JSON.stringify(options.redact);
    expect(paths).toContain('pushToken');
    expect(paths).toContain('providerApiKey');
    expect(paths).toContain('authorization');
    expect(paths).toContain('activationUrl');
    expect(paths).toContain('signedUrl');
  });
});

async function stage14Container(dbName: string) {
  const container = await createAppContainer(integrationConfig(dbName));
  containers.push(container);
  return container;
}

async function seedCheckInDueEvent(container: AppContainer, status = 'DUE') {
  const workspaceId = new ObjectId();
  const traineeUserId = new ObjectId();
  const traineeMembershipId = new ObjectId();
  const relationshipId = new ObjectId();
  const checkinId = new ObjectId();
  const sourceEventId = new ObjectId();
  await container.database.db
    .collection('users')
    .insertOne(userRecord(traineeUserId, 'trainee@example.test'));
  await container.database.db.collection('workspaces').insertOne({
    _id: workspaceId,
    type: 'GYM',
    name: 'Gym',
    ownerUserId: new ObjectId(),
    status: 'ACTIVE',
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await container.database.db.collection('workspace_memberships').insertOne({
    _id: traineeMembershipId,
    workspaceId,
    userId: traineeUserId,
    roles: ['TRAINEE'],
    status: 'ACTIVE',
    joinedAt: new Date(),
    engagementPeriods: [{ startedAt: new Date() }],
    permissionProfileIds: [],
    accessVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await container.database.db.collection('coaching_relationships').insertOne({
    _id: relationshipId,
    workspaceId,
    traineeUserId,
    traineeMembershipId,
    status: 'ACTIVE',
    engagementPeriods: [{ startedAt: new Date() }],
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await container.database.db.collection('checkin_instances').insertOne({
    _id: checkinId,
    workspaceId,
    relationshipId,
    assignmentId: new ObjectId(),
    templateId: new ObjectId(),
    templateRevisionId: new ObjectId(),
    status,
    periodKey: '2026-W38',
    periodStartAt: new Date(),
    periodEndAt: new Date(),
    opensAt: new Date(),
    dueAt: new Date(),
    timezone: 'Africa/Cairo',
    dayOfWeek: 2,
    responses: [],
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await container.database.db.collection('outbox_events').insertOne({
    _id: sourceEventId,
    eventType: 'CheckInDue',
    aggregateType: 'checkin_instance',
    aggregateId: checkinId,
    workspaceId,
    payload: {
      relationshipId: relationshipId.toHexString(),
      checkinId: checkinId.toHexString(),
    },
    correlationId: new ObjectId().toHexString(),
    status: 'PENDING',
    attempts: 0,
    occurredAt: new Date(),
  });
  return sourceEventId;
}

async function seedRelationshipWithStaff(container: AppContainer) {
  const workspaceId = new ObjectId();
  const traineeUserId = new ObjectId();
  const staffUserId = new ObjectId();
  const traineeMembershipId = new ObjectId();
  const staffMembershipId = new ObjectId();
  const relationshipId = new ObjectId();
  await container.database.db
    .collection('users')
    .insertMany([
      userRecord(traineeUserId, 'trainee-aggregate@example.test'),
      userRecord(staffUserId, 'staff-aggregate@example.test'),
    ]);
  await container.database.db.collection('workspaces').insertOne({
    _id: workspaceId,
    type: 'GYM',
    name: 'Gym',
    ownerUserId: staffUserId,
    status: 'ACTIVE',
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await container.database.db
    .collection('workspace_memberships')
    .insertMany([
      membershipRecord(traineeMembershipId, workspaceId, traineeUserId, ['TRAINEE']),
      membershipRecord(staffMembershipId, workspaceId, staffUserId, ['TRAINER']),
    ]);
  await container.database.db.collection('coaching_relationships').insertOne({
    _id: relationshipId,
    workspaceId,
    traineeUserId,
    traineeMembershipId,
    status: 'ACTIVE',
    engagementPeriods: [{ startedAt: new Date() }],
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await container.database.db.collection('trainee_staff_assignments').insertOne({
    _id: new ObjectId(),
    workspaceId,
    relationshipId,
    staffMembershipId,
    assignmentType: 'PRIMARY_TRAINER',
    active: true,
    startedAt: new Date(),
    assignedBy: staffUserId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return {
    workspaceId,
    traineeUserId,
    staffUserId,
    traineeMembershipId,
    staffMembershipId,
    relationshipId,
  };
}

function notificationRecord(
  userId: ObjectId,
  sourceEventId: ObjectId,
  overrides: Record<string, unknown> = {},
) {
  const now = new Date();
  return {
    _id: new ObjectId(),
    recipientUserId: userId,
    eventType: 'TestEvent',
    notificationType: 'TEST',
    category: 'CHECK_IN',
    title: 'Safe title',
    body: 'Safe body',
    sourceEventId,
    sourceType: 'test',
    sourceId: 'test',
    dedupeKey: `${sourceEventId.toHexString()}:${userId.toHexString()}:TEST`,
    templateKey: 'test',
    templateVersion: 1,
    locale: 'en',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function userRecord(userId: ObjectId, email: string) {
  return {
    _id: userId,
    email,
    normalizedEmail: email,
    passwordHash: 'hash',
    firstName: 'Test',
    lastName: 'User',
    preferredLanguage: 'en',
    timezone: 'Africa/Cairo',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function membershipRecord(
  membershipId: ObjectId,
  workspaceId: ObjectId,
  userId: ObjectId,
  roles: string[],
) {
  return {
    _id: membershipId,
    workspaceId,
    userId,
    roles,
    status: 'ACTIVE',
    joinedAt: new Date(),
    engagementPeriods: [{ startedAt: new Date() }],
    permissionProfileIds: [],
    accessVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function outboxEvent(input: {
  _id: ObjectId;
  eventType: string;
  aggregateType: string;
  aggregateId: ObjectId;
  workspaceId: ObjectId;
}) {
  return {
    ...input,
    payload: { aggregateId: input.aggregateId.toHexString() },
    correlationId: new ObjectId().toHexString(),
    status: 'PENDING',
    attempts: 0,
    occurredAt: new Date(),
  };
}

function indexes(calls: Array<{ collection: string; indexes: unknown[] }>, collection: string) {
  return calls.find((call) => call.collection === collection)?.indexes;
}

function ctx(userId: ObjectId) {
  return {
    correlationId: new ObjectId().toHexString(),
    userId: userId.toHexString(),
    authSessionId: new ObjectId().toHexString(),
    ipAddress: '127.0.0.1',
    locale: 'en',
    timezone: 'Africa/Cairo',
  };
}

function integrationConfig(dbName: string): AppConfig {
  return {
    env: 'test',
    app: {
      host: '0.0.0.0',
      port: 3000,
      docsEnabled: false,
      trustProxy: false,
      allowedOrigins: [],
    },
    mongo: { uri: mongoUri(), dbName, connectTimeoutMs: 500 },
    logging: { level: 'silent' },
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
    notifications: {
      deliveryBatchSize: 25,
      deliveryClaimMs: 60_000,
      deliveryMaxAttempts: 5,
    },
    subscriptions: { trialExpiryAction: 'FROZEN', paidGraceDays: 0, frozenToExpiredDays: 30 },
    support: { defaultSessionMinutes: 30, maxSessionMinutes: 60 },
  };
}

function mongoUri() {
  return (
    process.env.MONGODB_URI ??
    'mongodb://localhost:27017/gym_platform?replicaSet=rs0&directConnection=true'
  );
}
