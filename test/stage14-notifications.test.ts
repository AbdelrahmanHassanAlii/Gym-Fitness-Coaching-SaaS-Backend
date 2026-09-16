import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import pino from 'pino';
import { type AppContainer, createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { OutboxProcessor } from '../src/core/events/outbox.processor';
import { createLoggerOptions } from '../src/core/logging/logger';
import type {
  EmailProvider,
  EmailSendInput,
  EmailSendResult,
} from '../src/core/messaging/email.provider';
import { MessagingProviderError } from '../src/core/messaging/email.provider';
import { migrations } from '../src/migrations';
import { migration019Stage14Notifications } from '../src/migrations/019-stage14-notifications';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { registerNotificationOutboxHandlers } from '../src/modules/notifications/notification.outbox-handlers';
import { notificationRegistry } from '../src/modules/notifications/notification.registry';

const transientContainers: AppContainer[] = [];
const INTEGRATION_TIMEOUT_MS = 30_000;
const silentTestLogger = pino({ level: 'silent' });
let behaviorContainer: AppContainer | undefined;
let originalEmailProvider: EmailProvider | undefined;
let originalNotificationConfig:
  | { deliveryBatchSize: number; deliveryClaimMs: number; deliveryMaxAttempts: number }
  | undefined;

beforeAll(async () => {
  behaviorContainer = await createAppContainer(
    integrationConfig(`stage14_behavior_${new ObjectId()}`),
  );
  originalEmailProvider = (
    behaviorContainer.notifications as unknown as { emailProvider: EmailProvider }
  ).emailProvider;
  const notificationsConfig = behaviorContainer.config.notifications;
  if (!notificationsConfig) throw new Error('Expected Stage 14 notification test config.');
  originalNotificationConfig = {
    deliveryBatchSize: notificationsConfig.deliveryBatchSize,
    deliveryClaimMs: notificationsConfig.deliveryClaimMs,
    deliveryMaxAttempts: notificationsConfig.deliveryMaxAttempts,
  };
  await new MigrationRunner(behaviorContainer.database.db, migrations).migrate();
}, INTEGRATION_TIMEOUT_MS);

afterEach(async () => {
  while (transientContainers.length > 0) {
    const container = transientContainers.pop();
    if (!container) continue;
    await container.database.db.dropDatabase();
    await container.database.close();
  }
  if (behaviorContainer) {
    await resetBehaviorContainer(behaviorContainer);
  }
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (behaviorContainer) {
    await behaviorContainer.database.db.dropDatabase();
    await behaviorContainer.database.close();
    behaviorContainer = undefined;
  }
}, INTEGRATION_TIMEOUT_MS);

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
      const container = await stage14TransientContainer(`stage14_migration_${new ObjectId()}`);
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
      const processor = new OutboxProcessor(container.database, container.config, silentTestLogger);
      processor.register(
        'CheckInDue',
        async () => {
          existingHandlerCalls += 1;
        },
        { handlerKey: 'test.existing-handler' },
      );
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
    'multi-handler retry skips completed existing handler and dedupes notification fan-out',
    async () => {
      const container = await stage14Container(`stage14_outbox_retry_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const sourceEventId = await seedCheckInDueEvent(container);
      let sideEffectCalls = 0;
      let failNotificationOnce = true;
      const original = container.notifications.handleOutboxEvent.bind(container.notifications);
      const processor = new OutboxProcessor(container.database, container.config, silentTestLogger);
      processor.register(
        'CheckInDue',
        async (event) => {
          sideEffectCalls += 1;
          await container.database.db.collection('outbox_side_effects').updateOne(
            { eventId: event._id, kind: 'existing-handler' },
            {
              $setOnInsert: { eventId: event._id, kind: 'existing-handler', createdAt: new Date() },
            },
            { upsert: true },
          );
        },
        { handlerKey: 'test.existing-handler' },
      );
      processor.register(
        'CheckInDue',
        async (event) => {
          if (failNotificationOnce) {
            failNotificationOnce = false;
            throw new Error('Injected notification handler failure');
          }
          await original(event);
        },
        { handlerKey: 'test.notification-handler' },
      );

      expect(await processor.processOne()).toBe(true);
      expect(
        await container.database.db.collection('outbox_events').findOne({ _id: sourceEventId }),
      ).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        completedHandlers: ['test.existing-handler'],
      });
      await container.database.db
        .collection('outbox_events')
        .updateOne({ _id: sourceEventId }, { $set: { nextAttemptAt: new Date(0) } });

      expect(await processor.processOne()).toBe(true);

      expect(sideEffectCalls).toBe(1);
      expect(
        await container.database.db.collection('outbox_side_effects').countDocuments({
          eventId: sourceEventId,
        }),
      ).toBe(1);
      expect(
        await container.database.db.collection('notifications').countDocuments({ sourceEventId }),
      ).toBe(1);
      expect(
        await container.database.db
          .collection('notification_deliveries')
          .countDocuments({ sourceEventId }),
      ).toBe(1);
      expect(
        await container.database.db.collection('outbox_events').findOne({ _id: sourceEventId }),
      ).toMatchObject({ status: 'PROCESSED', attempts: 1 });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'stable handler keys survive restart and registration order changes',
    async () => {
      const container = await stage14Container(`stage14_outbox_order_change_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const sourceEventId = await seedCheckInDueEvent(container);
      let sideEffectCalls = 0;
      let failNotificationOnce = true;
      const original = container.notifications.handleOutboxEvent.bind(container.notifications);
      const firstProcessor = new OutboxProcessor(
        container.database,
        container.config,
        silentTestLogger,
      );
      firstProcessor.register(
        'CheckInDue',
        async (event) => {
          sideEffectCalls += 1;
          await container.database.db.collection('outbox_side_effects').updateOne(
            { eventId: event._id, kind: 'existing-handler' },
            {
              $setOnInsert: { eventId: event._id, kind: 'existing-handler', createdAt: new Date() },
            },
            { upsert: true },
          );
        },
        { handlerKey: 'test.existing-handler' },
      );
      firstProcessor.register(
        'CheckInDue',
        async (event) => {
          if (failNotificationOnce) {
            failNotificationOnce = false;
            throw new Error('Injected notification handler failure');
          }
          await original(event);
        },
        { handlerKey: 'test.notification-handler' },
      );

      expect(await firstProcessor.processOne()).toBe(true);
      expect(
        await container.database.db.collection('outbox_events').findOne({ _id: sourceEventId }),
      ).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        completedHandlers: ['test.existing-handler'],
      });
      await container.database.db
        .collection('outbox_events')
        .updateOne({ _id: sourceEventId }, { $set: { nextAttemptAt: new Date(0) } });

      const restartedProcessor = new OutboxProcessor(
        container.database,
        container.config,
        silentTestLogger,
      );
      restartedProcessor.register(
        'CheckInDue',
        async (event) => {
          await original(event);
        },
        { handlerKey: 'test.notification-handler' },
      );
      restartedProcessor.register(
        'CheckInDue',
        async () => {
          sideEffectCalls += 1;
        },
        { handlerKey: 'test.existing-handler' },
      );

      expect(await restartedProcessor.processOne()).toBe(true);

      expect(sideEffectCalls).toBe(1);
      expect(
        await container.database.db.collection('outbox_side_effects').countDocuments({
          eventId: sourceEventId,
        }),
      ).toBe(1);
      expect(
        await container.database.db.collection('notifications').countDocuments({ sourceEventId }),
      ).toBe(1);
      expect(
        await container.database.db
          .collection('notification_deliveries')
          .countDocuments({ sourceEventId }),
      ).toBe(1);
      const processed = await container.database.db
        .collection('outbox_events')
        .findOne({ _id: sourceEventId });
      expect(processed).toMatchObject({ status: 'PROCESSED', attempts: 1 });
      expect(processed?.completedHandlers).toBeUndefined();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'stable handler keys survive restart with the same registration order',
    async () => {
      const container = await stage14Container(`stage14_outbox_same_order_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const sourceEventId = await seedCheckInDueEvent(container);
      let sideEffectCalls = 0;
      let failNotificationOnce = true;
      const original = container.notifications.handleOutboxEvent.bind(container.notifications);
      const firstProcessor = new OutboxProcessor(
        container.database,
        container.config,
        silentTestLogger,
      );
      firstProcessor.register(
        'CheckInDue',
        async () => {
          sideEffectCalls += 1;
        },
        { handlerKey: 'test.existing-handler' },
      );
      firstProcessor.register(
        'CheckInDue',
        async (event) => {
          if (failNotificationOnce) {
            failNotificationOnce = false;
            throw new Error('Injected notification handler failure');
          }
          await original(event);
        },
        { handlerKey: 'test.notification-handler' },
      );

      expect(await firstProcessor.processOne()).toBe(true);
      await container.database.db
        .collection('outbox_events')
        .updateOne({ _id: sourceEventId }, { $set: { nextAttemptAt: new Date(0) } });

      const restartedProcessor = new OutboxProcessor(
        container.database,
        container.config,
        silentTestLogger,
      );
      restartedProcessor.register(
        'CheckInDue',
        async () => {
          sideEffectCalls += 1;
        },
        { handlerKey: 'test.existing-handler' },
      );
      restartedProcessor.register(
        'CheckInDue',
        async (event) => {
          await original(event);
        },
        { handlerKey: 'test.notification-handler' },
      );

      expect(await restartedProcessor.processOne()).toBe(true);

      expect(sideEffectCalls).toBe(1);
      expect(
        await container.database.db.collection('notifications').countDocuments({ sourceEventId }),
      ).toBe(1);
      const processed = await container.database.db
        .collection('outbox_events')
        .findOne({ _id: sourceEventId });
      expect(processed).toMatchObject({ status: 'PROCESSED', attempts: 1 });
      expect(processed?.completedHandlers).toBeUndefined();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test('duplicate handler keys for one event fail deterministically at registration', async () => {
    const container = await stage14Container(`stage14_duplicate_handler_key_${new ObjectId()}`);
    const processor = new OutboxProcessor(container.database, container.config, silentTestLogger);
    processor.register('CheckInDue', async () => undefined, { handlerKey: 'test.duplicate' });

    expect(() =>
      processor.register('CheckInDue', async () => undefined, { handlerKey: 'test.duplicate' }),
    ).toThrow('Duplicate outbox handler key "test.duplicate" for event "CheckInDue"');
  });

  test(
    'unknown completed handler keys do not skip registered logical handlers',
    async () => {
      const container = await stage14Container(`stage14_unknown_completed_key_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const sourceEventId = await seedCheckInDueEvent(container);
      await container.database.db.collection('outbox_events').updateOne(
        { _id: sourceEventId },
        {
          $set: {
            completedHandlers: ['CheckInDue#0', 'unknown.legacy-handler'],
          },
        },
      );
      let existingHandlerCalls = 0;
      const processor = new OutboxProcessor(container.database, container.config, silentTestLogger);
      processor.register(
        'CheckInDue',
        async () => {
          existingHandlerCalls += 1;
        },
        { handlerKey: 'test.existing-handler' },
      );
      registerNotificationOutboxHandlers(processor, container.notifications);

      expect(await processor.processOne()).toBe(true);

      expect(existingHandlerCalls).toBe(1);
      expect(
        await container.database.db.collection('notifications').countDocuments({ sourceEventId }),
      ).toBe(1);
      const processed = await container.database.db
        .collection('outbox_events')
        .findOne({ _id: sourceEventId });
      expect(processed).toMatchObject({ status: 'PROCESSED' });
      expect(processed?.completedHandlers).toBeUndefined();
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
    'generation insert failure and resolver failure surface without partial silent success',
    async () => {
      const container = await stage14Container(`stage14_generation_failure_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const sourceEventId = await seedCheckInDueEvent(container);
      const event = await container.database.db
        .collection('outbox_events')
        .findOne({ _id: sourceEventId });
      const originalInsertNotification = container.notificationsRepo.insertNotification.bind(
        container.notificationsRepo,
      );
      container.notificationsRepo.insertNotification = async () => {
        throw new Error('Injected notification insert failure');
      };
      await expect(container.notifications.handleOutboxEvent(event as never)).rejects.toThrow();
      expect(
        await container.database.db.collection('notifications').countDocuments({ sourceEventId }),
      ).toBe(0);
      expect(
        await container.database.db
          .collection('notification_deliveries')
          .countDocuments({ sourceEventId }),
      ).toBe(0);
      container.notificationsRepo.insertNotification = originalInsertNotification;
      const originalFindRelationship = container.coachingRelationships.findByIdInWorkspace.bind(
        container.coachingRelationships,
      );
      container.coachingRelationships.findByIdInWorkspace = async () => {
        throw new Error('Injected resolver failure');
      };
      await expect(container.notifications.handleOutboxEvent(event as never)).rejects.toThrow();
      container.coachingRelationships.findByIdInWorkspace = originalFindRelationship;
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'partial fan-out failure retries with notification and delivery dedupe',
    async () => {
      const container = await stage14Container(`stage14_partial_fanout_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const seed = await seedRelationshipWithStaff(container);
      const secondStaffUserId = new ObjectId();
      const secondStaffMembershipId = new ObjectId();
      await container.database.db
        .collection('users')
        .insertOne(userRecord(secondStaffUserId, 'second-staff@example.test'));
      await container.database.db
        .collection('workspace_memberships')
        .insertOne(
          membershipRecord(secondStaffMembershipId, seed.workspaceId, secondStaffUserId, [
            'TRAINER',
          ]),
        );
      await container.database.db.collection('trainee_staff_assignments').insertOne({
        _id: new ObjectId(),
        workspaceId: seed.workspaceId,
        relationshipId: seed.relationshipId,
        staffMembershipId: secondStaffMembershipId,
        assignmentType: 'ASSISTANT_TRAINER',
        active: true,
        startedAt: new Date(),
        assignedBy: seed.staffUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const eventId = new ObjectId();
      const event = outboxEvent({
        _id: eventId,
        eventType: 'DocumentUploaded',
        aggregateType: 'document',
        aggregateId: new ObjectId(),
        workspaceId: seed.workspaceId,
        payload: {
          relationshipId: seed.relationshipId.toHexString(),
          documentId: new ObjectId().toHexString(),
        },
      });
      const originalInsertDelivery = container.notificationsRepo.insertDelivery.bind(
        container.notificationsRepo,
      );
      let insertDeliveryCalls = 0;
      container.notificationsRepo.insertDelivery = async (delivery, tx) => {
        insertDeliveryCalls += 1;
        if (insertDeliveryCalls === 2) throw new Error('Injected partial fan-out failure');
        return await originalInsertDelivery(delivery, tx);
      };

      await expect(container.notifications.handleOutboxEvent(event as never)).rejects.toThrow();
      container.notificationsRepo.insertDelivery = originalInsertDelivery;
      await container.notifications.handleOutboxEvent(event as never);

      expect(
        await container.database.db
          .collection('notifications')
          .countDocuments({ sourceEventId: eventId }),
      ).toBe(2);
      expect(
        await container.database.db
          .collection('notification_deliveries')
          .countDocuments({ sourceEventId: eventId }),
      ).toBe(2);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'zero-recipient source event succeeds as no-op',
    async () => {
      const container = await stage14Container(`stage14_zero_recipient_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const workspaceId = new ObjectId();
      const event = outboxEvent({
        _id: new ObjectId(),
        eventType: 'TraineeNeedsReassignment',
        aggregateType: 'coaching_relationship',
        aggregateId: new ObjectId(),
        workspaceId,
      });
      await container.database.db.collection('workspaces').insertOne({
        _id: workspaceId,
        type: 'GYM',
        name: 'No recipients',
        ownerUserId: new ObjectId(),
        status: 'ACTIVE',
        timezone: 'Africa/Cairo',
        defaultLanguage: 'en',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await container.notifications.handleOutboxEvent(event as never);

      expect(await container.database.db.collection('notifications').countDocuments()).toBe(0);
      expect(
        await container.database.db.collection('notification_deliveries').countDocuments(),
      ).toBe(0);
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
    'every exact registry event fires its registered notification type',
    async () => {
      const container = await stage14Container(`stage14_registry_exact_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const seed = await seedRelationshipWithStaff(container);
      await container.database.db
        .collection('workspace_memberships')
        .updateOne({ _id: seed.staffMembershipId }, { $set: { roles: ['TRAINER', 'GYM_OWNER'] } });
      const checkinDueId = new ObjectId();
      const checkinOverdueId = new ObjectId();
      const checkinFactId = new ObjectId();
      const workoutId = new ObjectId();
      const programId = new ObjectId();
      const nutritionPlanId = new ObjectId();
      await container.database.db
        .collection('checkin_instances')
        .insertMany([
          checkinRecord(checkinDueId, seed.workspaceId, seed.relationshipId, 'DUE'),
          checkinRecord(checkinOverdueId, seed.workspaceId, seed.relationshipId, 'OVERDUE'),
          checkinRecord(checkinFactId, seed.workspaceId, seed.relationshipId, 'SUBMITTED'),
        ]);
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
      await container.database.db.collection('nutrition_plans').insertOne({
        _id: nutritionPlanId,
        workspaceId: seed.workspaceId,
        relationshipId: seed.relationshipId,
        status: 'ACTIVE',
        currentRevisionId: new ObjectId(),
        assignedBy: seed.staffMembershipId,
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 0,
      });

      const cases = [
        {
          eventType: 'CheckInDue',
          aggregateType: 'checkin_instance',
          aggregateId: checkinDueId,
          payload: {
            relationshipId: seed.relationshipId.toHexString(),
            checkinId: checkinDueId.toHexString(),
          },
        },
        {
          eventType: 'CheckInOverdue',
          aggregateType: 'checkin_instance',
          aggregateId: checkinOverdueId,
          payload: {
            relationshipId: seed.relationshipId.toHexString(),
            checkinId: checkinOverdueId.toHexString(),
          },
        },
        {
          eventType: 'CheckInSubmitted',
          aggregateType: 'checkin_instance',
          aggregateId: checkinFactId,
          payload: {
            relationshipId: seed.relationshipId.toHexString(),
            checkinId: checkinFactId.toHexString(),
          },
        },
        {
          eventType: 'CheckInReviewed',
          aggregateType: 'checkin_instance',
          aggregateId: checkinFactId,
          payload: {
            relationshipId: seed.relationshipId.toHexString(),
            checkinId: checkinFactId.toHexString(),
          },
        },
        {
          eventType: 'DocumentUploaded',
          aggregateType: 'document',
          aggregateId: new ObjectId(),
          payload: {
            relationshipId: seed.relationshipId.toHexString(),
            documentId: new ObjectId().toHexString(),
          },
        },
        {
          eventType: 'WorkoutCompleted',
          aggregateType: 'workout_session',
          aggregateId: workoutId,
        },
        {
          eventType: 'WorkoutCorrected',
          aggregateType: 'workout_session',
          aggregateId: workoutId,
        },
        {
          eventType: 'ProgramActivated',
          aggregateType: 'program',
          aggregateId: programId,
        },
        {
          eventType: 'ProgramUpdated',
          aggregateType: 'program',
          aggregateId: programId,
        },
        {
          eventType: 'NutritionPlanActivated',
          aggregateType: 'nutrition_plan',
          aggregateId: nutritionPlanId,
        },
        {
          eventType: 'NutritionPlanUpdated',
          aggregateType: 'nutrition_plan',
          aggregateId: nutritionPlanId,
        },
        {
          eventType: 'TraineeNeedsReassignment',
          aggregateType: 'coaching_relationship',
          aggregateId: seed.relationshipId,
        },
        {
          eventType: 'MembershipPermissionProfilesReplaced',
          aggregateType: 'workspace_membership',
          aggregateId: seed.staffMembershipId,
        },
        {
          eventType: 'SubscriptionFrozen',
          aggregateType: 'subscription',
          aggregateId: new ObjectId(),
        },
      ];
      expect(cases.map((item) => item.eventType).sort()).toEqual(
        notificationRegistry.map((entry) => entry.eventType).sort(),
      );

      for (const item of cases) {
        const eventId = new ObjectId();
        await container.notifications.handleOutboxEvent(
          outboxEvent({
            _id: eventId,
            eventType: item.eventType,
            aggregateType: item.aggregateType,
            aggregateId: item.aggregateId,
            workspaceId: seed.workspaceId,
            ...(item.payload ? { payload: item.payload } : {}),
          }) as never,
        );
        const entry = notificationRegistry.find(
          (candidate) => candidate.eventType === item.eventType,
        );
        expect(entry).toBeTruthy();
        expect(
          await container.database.db.collection('notifications').countDocuments({
            sourceEventId: eventId,
            notificationType: entry?.notificationType,
          }),
        ).toBeGreaterThan(0);
      }
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
    'mandatory permission notification ignores ordinary email preference opt-out',
    async () => {
      const container = await stage14Container(`stage14_mandatory_pref_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const seed = await seedRelationshipWithStaff(container);
      await container.notifications.putPreferences(ctx(seed.staffUserId), {
        expectedVersion: 0,
        channels: { email: false },
      });
      const eventId = new ObjectId();
      await container.database.db.collection('outbox_events').insertOne(
        outboxEvent({
          _id: eventId,
          eventType: 'MembershipPermissionProfilesReplaced',
          aggregateType: 'workspace_membership',
          aggregateId: seed.staffMembershipId,
          workspaceId: seed.workspaceId,
        }),
      );
      const event = await container.database.db
        .collection('outbox_events')
        .findOne({ _id: eventId });
      await container.notifications.handleOutboxEvent(event as never);
      const fake = new RecordingEmailProvider();
      replaceEmailProvider(container, fake);

      await container.notifications.processDueDeliveries(container.jobLeases);

      expect(fake.calls).toHaveLength(1);
      expect(
        await container.database.db
          .collection('notification_deliveries')
          .findOne({ sourceEventId: eventId }),
      ).toMatchObject({ status: 'SENT' });
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

  test(
    'delivery claim expiry is recoverable and active claims cannot be stolen',
    async () => {
      const container = await stage14Container(`stage14_claim_recovery_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const deliveryId = await insertBareDelivery(container, {
        logicalDeliveryKey: 'claim-recovery',
      });
      const now = new Date();
      const claimA = await container.notificationsRepo.claimNextDelivery({
        workerId: 'worker-a',
        now,
        claimMs: 60_000,
      });
      expect(claimA?._id).toEqual(deliveryId);
      const claimB = await container.notificationsRepo.claimNextDelivery({
        workerId: 'worker-b',
        now: new Date(now.getTime() + 1_000),
        claimMs: 60_000,
      });
      expect(claimB).toBeNull();
      const recovered = await container.notificationsRepo.claimNextDelivery({
        workerId: 'worker-b',
        now: new Date(now.getTime() + 61_000),
        claimMs: 60_000,
      });
      expect(recovered?._id).toEqual(deliveryId);
      expect(recovered).toMatchObject({ claimedBy: 'worker-b', version: 2 });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'provider retryable failure persists retry state and releases claim without duplicate delivery',
    async () => {
      const container = await stage14Container(`stage14_retryable_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const { sourceEventId } = await seedPendingEmailDelivery(container);
      replaceEmailProvider(
        container,
        new ThrowingEmailProvider(
          new MessagingProviderError('temporary unavailable', 'EMAIL_503', true),
        ),
      );

      await container.notifications.processDueDeliveries(container.jobLeases);

      const delivery = await container.database.db
        .collection('notification_deliveries')
        .findOne({ sourceEventId });
      expect(delivery).toMatchObject({
        status: 'RETRYING',
        attemptCount: 1,
        lastError: { code: 'EMAIL_503', retryable: true },
      });
      expect(delivery?.claimedBy).toBeUndefined();
      expect(delivery?.claimedUntil).toBeUndefined();
      expect(delivery?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      expect(
        await container.database.db
          .collection('notification_deliveries')
          .countDocuments({ sourceEventId }),
      ).toBe(1);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'preference read failure aborts send without provider call',
    async () => {
      const container = await stage14Container(`stage14_pref_read_failure_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      await seedPendingEmailDelivery(container);
      const fake = new RecordingEmailProvider();
      replaceEmailProvider(container, fake);
      container.notificationsRepo.getPreferences = async () => {
        throw new Error('Injected preference read failure');
      };

      await expect(
        container.notifications.processDueDeliveries(container.jobLeases),
      ).rejects.toThrow();

      expect(fake.calls).toHaveLength(0);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'provider permanent failure reaches terminal failed with sanitized metadata',
    async () => {
      const container = await stage14Container(`stage14_permanent_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const { sourceEventId } = await seedPendingEmailDelivery(container);
      replaceEmailProvider(
        container,
        new ThrowingEmailProvider(
          new MessagingProviderError(
            'hard reject secret-token-value',
            'EMAIL_HARD_REJECT',
            false,
            true,
          ),
        ),
      );

      await container.notifications.processDueDeliveries(container.jobLeases);

      const delivery = await container.database.db
        .collection('notification_deliveries')
        .findOne({ sourceEventId });
      expect(delivery).toMatchObject({
        status: 'FAILED',
        attemptCount: 1,
        failedReason: 'EMAIL_HARD_REJECT',
        lastError: { code: 'EMAIL_HARD_REJECT', retryable: false },
      });
      expect(JSON.stringify(delivery)).not.toContain('provider-api-key-value');
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'ambiguous provider timeout with idempotency dedupes logical resend',
    async () => {
      const container = await stage14Container(`stage14_timeout_accept_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const { sourceEventId } = await seedPendingEmailDelivery(container);
      const fake = new AcceptThenTimeoutEmailProvider();
      replaceEmailProvider(container, fake);

      await container.notifications.processDueDeliveries(container.jobLeases);
      await container.database.db
        .collection('notification_deliveries')
        .updateOne({ sourceEventId }, { $set: { nextAttemptAt: new Date(0) } });
      await container.notifications.processDueDeliveries(container.jobLeases);

      expect(fake.acceptedLogicalKeys.size).toBe(1);
      expect(fake.calls).toHaveLength(2);
      expect(
        await container.database.db
          .collection('notification_deliveries')
          .findOne({ sourceEventId }),
      ).toMatchObject({ status: 'SENT', attemptCount: 2 });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'provider success followed by sent-state failure retries safely with idempotent provider',
    async () => {
      const container = await stage14Container(`stage14_sent_failure_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const { sourceEventId } = await seedPendingEmailDelivery(container);
      const fake = new RecordingEmailProvider();
      replaceEmailProvider(container, fake);
      const originalMarkSent = container.notificationsRepo.markDeliverySent.bind(
        container.notificationsRepo,
      );
      let failSentOnce = true;
      container.notificationsRepo.markDeliverySent = async (input) => {
        if (failSentOnce) {
          failSentOnce = false;
          throw new Error('Injected Mongo SENT update failure');
        }
        await originalMarkSent(input);
      };

      await container.notifications.processDueDeliveries(container.jobLeases);
      await container.database.db
        .collection('notification_deliveries')
        .updateOne({ sourceEventId }, { $set: { nextAttemptAt: new Date(0) } });
      await container.notifications.processDueDeliveries(container.jobLeases);

      expect(fake.acceptedLogicalKeys.size).toBe(1);
      expect(fake.calls).toHaveLength(2);
      expect(
        await container.database.db
          .collection('notification_deliveries')
          .findOne({ sourceEventId }),
      ).toMatchObject({ status: 'SENT', attemptCount: 2 });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'retry-state persistence failure leaves claim recoverable and terminal failure occurs at max attempts',
    async () => {
      const container = await stage14Container(`stage14_retry_persist_${new ObjectId()}`);
      container.config.notifications = {
        deliveryBatchSize: 25,
        deliveryClaimMs: 60_000,
        deliveryMaxAttempts: 2,
      };
      await new MigrationRunner(container.database.db, migrations).migrate();
      const { sourceEventId } = await seedPendingEmailDelivery(container);
      replaceEmailProvider(
        container,
        new ThrowingEmailProvider(
          new MessagingProviderError('temporary unavailable', 'EMAIL_503', true),
        ),
      );
      const originalRetry = container.notificationsRepo.markDeliveryRetry.bind(
        container.notificationsRepo,
      );
      let failRetryOnce = true;
      container.notificationsRepo.markDeliveryRetry = async (input) => {
        if (failRetryOnce) {
          failRetryOnce = false;
          throw new Error('Injected retry persistence failure');
        }
        await originalRetry(input);
      };

      await expect(
        container.notifications.processDueDeliveries(container.jobLeases),
      ).rejects.toThrow();
      await container.database.db
        .collection('notification_deliveries')
        .updateOne({ sourceEventId }, { $set: { claimedUntil: new Date(0) } });
      await container.notifications.processDueDeliveries(container.jobLeases);
      await container.database.db
        .collection('notification_deliveries')
        .updateOne({ sourceEventId }, { $set: { nextAttemptAt: new Date(0) } });
      await container.notifications.processDueDeliveries(container.jobLeases);

      expect(
        await container.database.db
          .collection('notification_deliveries')
          .findOne({ sourceEventId }),
      ).toMatchObject({ status: 'FAILED', attemptCount: 2, failedReason: 'EMAIL_503' });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'membership revocation and trainer reassignment cancel queued optional external delivery',
    async () => {
      const container = await stage14Container(`stage14_reassign_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const seed = await seedRelationshipWithStaff(container);
      const eventId = new ObjectId();
      const event = outboxEvent({
        _id: eventId,
        eventType: 'DocumentUploaded',
        aggregateType: 'document',
        aggregateId: new ObjectId(),
        workspaceId: seed.workspaceId,
        payload: {
          relationshipId: seed.relationshipId.toHexString(),
          documentId: new ObjectId().toHexString(),
        },
      });
      await container.database.db.collection('outbox_events').insertOne(event);
      await container.notifications.handleOutboxEvent(event as never);
      const fake = new RecordingEmailProvider();
      replaceEmailProvider(container, fake);
      await container.database.db
        .collection('workspace_memberships')
        .updateOne(
          { _id: seed.staffMembershipId },
          { $set: { status: 'ENDED', endedAt: new Date(), updatedAt: new Date() } },
        );
      await container.database.db
        .collection('trainee_staff_assignments')
        .updateOne(
          { relationshipId: seed.relationshipId, staffMembershipId: seed.staffMembershipId },
          { $set: { active: false, endedAt: new Date(), updatedAt: new Date() } },
        );

      await container.notifications.processDueDeliveries(container.jobLeases);

      expect(fake.calls).toHaveLength(0);
      expect(
        await container.database.db
          .collection('notification_deliveries')
          .findOne({ sourceEventId: eventId }),
      ).toMatchObject({ status: 'CANCELLED', cancelledReason: 'RECIPIENT_NOT_ELIGIBLE' });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'trainer reassignment cancels old trainer queued delivery even when workspace membership stays active',
    async () => {
      const container = await stage14Container(`stage14_assignment_reassign_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const seed = await seedRelationshipWithStaff(container);
      const eventId = new ObjectId();
      const event = outboxEvent({
        _id: eventId,
        eventType: 'DocumentUploaded',
        aggregateType: 'document',
        aggregateId: new ObjectId(),
        workspaceId: seed.workspaceId,
        payload: {
          relationshipId: seed.relationshipId.toHexString(),
          documentId: new ObjectId().toHexString(),
        },
      });
      await container.database.db.collection('outbox_events').insertOne(event);
      await container.notifications.handleOutboxEvent(event as never);
      const fake = new RecordingEmailProvider();
      replaceEmailProvider(container, fake);
      await container.database.db
        .collection('trainee_staff_assignments')
        .updateOne(
          { relationshipId: seed.relationshipId, staffMembershipId: seed.staffMembershipId },
          { $set: { active: false, endedAt: new Date(), updatedAt: new Date() } },
        );
      const newStaffUserId = new ObjectId();
      const newStaffMembershipId = new ObjectId();
      await container.database.db
        .collection('users')
        .insertOne(userRecord(newStaffUserId, 'new-staff@example.test'));
      await container.database.db
        .collection('workspace_memberships')
        .insertOne(
          membershipRecord(newStaffMembershipId, seed.workspaceId, newStaffUserId, ['TRAINER']),
        );
      await container.database.db.collection('trainee_staff_assignments').insertOne({
        _id: new ObjectId(),
        workspaceId: seed.workspaceId,
        relationshipId: seed.relationshipId,
        staffMembershipId: newStaffMembershipId,
        assignmentType: 'PRIMARY_TRAINER',
        active: true,
        startedAt: new Date(),
        assignedBy: newStaffUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await container.notifications.processDueDeliveries(container.jobLeases);

      expect(fake.calls).toHaveLength(0);
      expect(
        await container.database.db
          .collection('notification_deliveries')
          .findOne({ sourceEventId: eventId }),
      ).toMatchObject({ status: 'CANCELLED', cancelledReason: 'RECIPIENT_NOT_ELIGIBLE' });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'mark-read replay is idempotent and preserves first readAt while denying cross-user update',
    async () => {
      const container = await stage14Container(`stage14_mark_read_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const userId = new ObjectId();
      const otherUserId = new ObjectId();
      const notification = notificationRecord(userId, new ObjectId());
      await container.database.db.collection('notifications').insertOne(notification);

      const [first, second] = await Promise.all([
        container.notifications.markRead(ctx(userId), notification._id.toHexString()),
        container.notifications.markRead(ctx(userId), notification._id.toHexString()),
      ]);

      expect(first.data.readAt).toBeTruthy();
      expect(second.data.readAt).toBeTruthy();
      expect(
        await container.database.db.collection('notifications').countDocuments({
          _id: notification._id,
          recipientUserId: userId,
          readAt: { $exists: true },
        }),
      ).toBe(1);
      await expect(
        container.notifications.markRead(ctx(otherUserId), notification._id.toHexString()),
      ).rejects.toMatchObject({ code: 'NOTIFICATION_NOT_FOUND' });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'push token reassignment revokes previous active owner and cancels stale queued delivery',
    async () => {
      const container = await stage14Container(`stage14_push_reassign_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const userA = new ObjectId();
      const userB = new ObjectId();
      await container.database.db
        .collection('users')
        .insertMany([
          userRecord(userA, 'push-a@example.test'),
          userRecord(userB, 'push-b@example.test'),
        ]);
      const first = await container.notifications.registerPushDevice(ctx(userA), {
        platform: 'WEB',
        provider: 'test',
        token: 'shared-raw-push-token',
      });
      await container.database.db.collection('notification_deliveries').insertOne({
        _id: new ObjectId(),
        sourceEventId: new ObjectId(),
        recipientUserId: userA,
        channel: 'PUSH',
        status: 'PENDING',
        attemptCount: 0,
        destinationSnapshot: {
          kind: 'PUSH_DEVICE',
          fingerprint: first.data.tokenFingerprint,
          pushDeviceId: new ObjectId(first.data.id),
        },
        logicalDeliveryKey: 'stale-push-owner',
        providerSupportsIdempotency: false,
        version: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const second = await container.notifications.registerPushDevice(ctx(userB), {
        platform: 'WEB',
        provider: 'test',
        token: 'shared-raw-push-token',
      });

      expect(second.data.id).not.toBe(first.data.id);
      expect(
        await container.database.db.collection('push_devices').countDocuments({
          tokenFingerprint: first.data.tokenFingerprint,
          status: 'ACTIVE',
        }),
      ).toBe(1);
      expect(
        await container.database.db
          .collection('push_devices')
          .findOne({ _id: new ObjectId(first.data.id) }),
      ).toMatchObject({ status: 'REVOKED' });
      expect(
        await container.database.db.collection('notification_deliveries').findOne({
          logicalDeliveryKey: 'stale-push-owner',
        }),
      ).toMatchObject({ status: 'CANCELLED', cancelledReason: 'PUSH_DEVICE_TOKEN_REASSIGNED' });
      expect(JSON.stringify(second)).not.toContain('shared-raw-push-token');
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'preference update rollback leaves no partial preference or audit state and retry succeeds',
    async () => {
      const container = await stage14Container(`stage14_pref_rollback_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const userId = new ObjectId();
      const originalAudit = container.audit.write.bind(container.audit);
      container.audit.write = async () => {
        throw new Error('Injected audit failure');
      };

      await expect(
        container.notifications.putPreferences(ctx(userId), {
          expectedVersion: 0,
          channels: { email: false },
        }),
      ).rejects.toThrow();
      expect(
        await container.database.db
          .collection('notification_preferences')
          .countDocuments({ userId }),
      ).toBe(0);
      expect(
        await container.database.db.collection('audit_events').countDocuments({
          eventType: 'NotificationPreferencesUpdated',
        }),
      ).toBe(0);
      container.audit.write = originalAudit;
      await container.notifications.putPreferences(ctx(userId), {
        expectedVersion: 0,
        channels: { email: false },
      });
      expect(
        await container.database.db
          .collection('notification_preferences')
          .countDocuments({ userId }),
      ).toBe(1);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'DocumentUploaded notification stores only generic text and opaque safe identifiers',
    async () => {
      const container = await stage14Container(`stage14_document_privacy_${new ObjectId()}`);
      await new MigrationRunner(container.database.db, migrations).migrate();
      const seed = await seedRelationshipWithStaff(container);
      const eventId = new ObjectId();
      const documentId = new ObjectId().toHexString();
      const event = outboxEvent({
        _id: eventId,
        eventType: 'DocumentUploaded',
        aggregateType: 'document',
        aggregateId: new ObjectId(),
        workspaceId: seed.workspaceId,
        payload: {
          relationshipId: seed.relationshipId.toHexString(),
          documentId,
          storageKey: 'private/medical/secret-object-key.pdf',
          downloadUrl: 'https://files.example.test/report?X-Amz-Signature=secret',
          title: 'Sensitive oncology report',
          classification: 'MEDICAL',
        },
      });

      await container.notifications.handleOutboxEvent(event as never);

      const notification = await container.database.db.collection('notifications').findOne({
        sourceEventId: eventId,
      });
      const delivery = await container.database.db.collection('notification_deliveries').findOne({
        sourceEventId: eventId,
      });
      const persisted = JSON.stringify({ notification, delivery });
      expect(notification).toMatchObject({
        title: 'Document uploaded',
        body: 'A document was added to the coaching file.',
      });
      expect(notification?.payload).toEqual({
        relationshipId: seed.relationshipId.toHexString(),
        documentId,
      });
      expect(persisted).not.toContain('secret-object-key');
      expect(persisted).not.toContain('X-Amz-Signature');
      expect(persisted).not.toContain('oncology');
      expect(persisted).not.toContain('MEDICAL');
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test('logger redacts realistic push, auth, provider, invitation, activation, reset, and signed URL secrets', () => {
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
    let output = '';
    const logger = pino(options, {
      write(chunk) {
        output += chunk;
      },
    });
    logger.info({
      req: { headers: { authorization: 'Bearer secret-auth-value' } },
      pushToken: 'secret-push-token-value',
      providerApiKey: 'secret-provider-api-key',
      invitationUrl: 'https://app.example.test/invitations/accept?token=secret-invite-token',
      activationUrl: 'https://app.example.test/activate?token=secret-activation-token',
      resetUrl: 'https://app.example.test/reset?token=secret-reset-token',
      signedUrl: 'https://s3.example.test/file?X-Amz-Signature=secret-signature',
    });
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('secret-auth-value');
    expect(output).not.toContain('secret-push-token-value');
    expect(output).not.toContain('secret-provider-api-key');
    expect(output).not.toContain('secret-invite-token');
    expect(output).not.toContain('secret-activation-token');
    expect(output).not.toContain('secret-reset-token');
    expect(output).not.toContain('secret-signature');
  });
});

async function stage14Container(dbName: string) {
  void dbName;
  if (!behaviorContainer) throw new Error('Stage 14 behavior container was not initialized.');
  return behaviorContainer;
}

async function stage14TransientContainer(dbName: string) {
  const container = await createAppContainer(integrationConfig(dbName));
  transientContainers.push(container);
  return container;
}

async function resetBehaviorContainer(container: AppContainer) {
  delete (container.notificationsRepo as unknown as Record<string, unknown>).insertNotification;
  delete (container.notificationsRepo as unknown as Record<string, unknown>).insertDelivery;
  delete (container.notificationsRepo as unknown as Record<string, unknown>).getPreferences;
  delete (container.notificationsRepo as unknown as Record<string, unknown>).markDeliverySent;
  delete (container.notificationsRepo as unknown as Record<string, unknown>).markDeliveryRetry;
  delete (container.coachingRelationships as unknown as Record<string, unknown>)
    .findByIdInWorkspace;
  delete (container.audit as unknown as Record<string, unknown>).write;
  if (originalEmailProvider) {
    (container.notifications as unknown as { emailProvider: EmailProvider }).emailProvider =
      originalEmailProvider;
  }
  if (originalNotificationConfig) {
    container.config.notifications = { ...originalNotificationConfig };
  }
  const collections = await container.database.db.listCollections().toArray();
  for (const collection of collections) {
    if (collection.name === 'db_migrations') continue;
    await container.database.db.collection(collection.name).deleteMany({});
  }
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

function checkinRecord(
  checkinId: ObjectId,
  workspaceId: ObjectId,
  relationshipId: ObjectId,
  status: string,
) {
  return {
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
  };
}

function outboxEvent(input: {
  _id: ObjectId;
  eventType: string;
  aggregateType: string;
  aggregateId: ObjectId;
  workspaceId: ObjectId;
  payload?: Record<string, string>;
}) {
  return {
    ...input,
    payload: { aggregateId: input.aggregateId.toHexString(), ...(input.payload ?? {}) },
    correlationId: new ObjectId().toHexString(),
    status: 'PENDING',
    attempts: 0,
    occurredAt: new Date(),
  };
}

async function seedPendingEmailDelivery(container: AppContainer) {
  const sourceEventId = await seedCheckInDueEvent(container);
  const event = await container.database.db
    .collection('outbox_events')
    .findOne({ _id: sourceEventId });
  await container.notifications.handleOutboxEvent(event as never);
  return { sourceEventId };
}

async function insertBareDelivery(
  container: AppContainer,
  input: { logicalDeliveryKey: string },
): Promise<ObjectId> {
  const deliveryId = new ObjectId();
  await container.database.db.collection('notification_deliveries').insertOne({
    _id: deliveryId,
    sourceEventId: new ObjectId(),
    channel: 'EMAIL',
    status: 'PENDING',
    attemptCount: 0,
    destinationSnapshot: {
      kind: 'USER_EMAIL',
      fingerprint: 'email-fingerprint',
      email: 'claim@example.test',
    },
    logicalDeliveryKey: input.logicalDeliveryKey,
    providerSupportsIdempotency: true,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return deliveryId;
}

function replaceEmailProvider(container: AppContainer, provider: EmailProvider): void {
  (container.notifications as unknown as { emailProvider: EmailProvider }).emailProvider = provider;
}

class RecordingEmailProvider implements EmailProvider {
  readonly supportsIdempotency = true;
  readonly calls: EmailSendInput[] = [];
  readonly acceptedLogicalKeys = new Set<string>();

  async sendEmail(input: EmailSendInput): Promise<EmailSendResult> {
    this.calls.push(input);
    if (input.idempotencyKey) this.acceptedLogicalKeys.add(input.idempotencyKey);
    return {
      providerMessageId: `fake:${input.idempotencyKey ?? this.calls.length}`,
      supportsIdempotency: this.supportsIdempotency,
    };
  }
}

class ThrowingEmailProvider implements EmailProvider {
  readonly supportsIdempotency = true;

  constructor(private readonly error: MessagingProviderError) {}

  async sendEmail(_input: EmailSendInput): Promise<EmailSendResult> {
    throw this.error;
  }
}

class AcceptThenTimeoutEmailProvider extends RecordingEmailProvider {
  private first = true;

  override async sendEmail(input: EmailSendInput): Promise<EmailSendResult> {
    this.calls.push(input);
    if (input.idempotencyKey) this.acceptedLogicalKeys.add(input.idempotencyKey);
    if (this.first) {
      this.first = false;
      throw new MessagingProviderError(
        'timeout after acceptance',
        'PROVIDER_TIMEOUT',
        true,
        false,
        true,
      );
    }
    return {
      providerMessageId: `fake:${input.idempotencyKey ?? this.calls.length}`,
      supportsIdempotency: this.supportsIdempotency,
    };
  }
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
