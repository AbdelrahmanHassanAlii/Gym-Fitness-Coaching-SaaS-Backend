import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { OutboxProcessor } from '../src/core/events/outbox.processor';
import { createLogger } from '../src/core/logging/logger';
import { registerPlatformLifecycleOutboxHandlers } from '../src/modules/platform/platform-lifecycle.outbox-handlers';
import { type SummaryHarness, summaryHarness } from './platform-workspace-summary.helpers';

let h: SummaryHarness;
beforeAll(async () => {
  h = await summaryHarness('platform_lifecycle_outbox_validation');
}, 30_000);
afterEach(async () => {
  await h.clear();
}, 30_000);
afterAll(async () => {
  if (h) await h.close();
}, 30_000);

function processor() {
  const result = new OutboxProcessor(
    h.container.database,
    h.container.config,
    createLogger(h.container.config),
  );
  registerPlatformLifecycleOutboxHandlers(result);
  return result;
}

function fact(eventType = 'PlatformMembershipSuspended') {
  return {
    _id: new ObjectId(),
    eventType,
    aggregateType: 'platform_membership',
    aggregateId: new ObjectId(),
    payload: { userId: new ObjectId().toHexString() },
    correlationId: 'lifecycle-validation',
    occurredAt: new Date(),
    status: 'PENDING',
    attempts: 0,
  };
}

test('wrong lifecycle aggregate type follows processor retry and terminal failure, never PROCESSED', async () => {
  const event = { ...fact(), aggregateType: 'wrong' };
  await h.db.collection('outbox_events').insertOne(event);
  const worker = processor();
  expect(await worker.processOne()).toBe(true);
  const retriable = await h.db.collection('outbox_events').findOne({ _id: event._id });
  expect(retriable).toMatchObject({ status: 'PENDING', attempts: 1 });
  expect(retriable?.nextAttemptAt).toBeInstanceOf(Date);
  expect(retriable?.processedAt).toBeUndefined();
  expect(retriable?.completedHandlers).toBeUndefined();
  await h.db.collection('outbox_events').updateOne(
    { _id: event._id },
    {
      $set: { attempts: h.container.config.worker.outboxMaxAttempts - 1 },
      $unset: { nextAttemptAt: '' },
    },
  );
  expect(await worker.processOne()).toBe(true);
  const failed = await h.db.collection('outbox_events').findOne({ _id: event._id });
  expect(failed?.status).toBe('FAILED');
  expect(failed?.processedAt).toBeUndefined();
});

for (const eventType of [
  'PlatformMembershipSuspended',
  'PlatformMembershipReactivated',
  'PlatformMembershipEnded',
]) {
  for (const representation of ['ObjectId', 'string']) {
    test(`${eventType} accepts minimal legacy facts with ${representation} aggregate IDs and safe retries`, async () => {
      const event = fact(eventType);
      const aggregateId =
        representation === 'ObjectId' ? event.aggregateId : event.aggregateId.toHexString();
      await h.db.collection('outbox_events').insertOne({ ...event, aggregateId });
      const actorId = new ObjectId();
      await h.db.collection('users').insertOne({ _id: actorId, status: 'ACTIVE' });
      await h.db.collection('auth_sessions').insertOne({ userId: actorId, status: 'ACTIVE' });
      const collections = [
        'users',
        'auth_sessions',
        'platform_memberships',
        'permission_profiles',
        'audit_events',
        'notifications',
      ];
      const before = await Promise.all(
        collections.map((collection) => h.db.collection(collection).find({}).toArray()),
      );
      const worker = processor();
      expect(await worker.processOne()).toBe(true);
      expect(await h.db.collection('outbox_events').findOne({ _id: event._id })).toMatchObject({
        status: 'PROCESSED',
        attempts: 0,
      });
      // Replay the same informational fact through the real processor.
      await h.db
        .collection('outbox_events')
        .updateOne(
          { _id: event._id },
          { $set: { status: 'PENDING' }, $unset: { processedAt: '' } },
        );
      expect(await worker.processOne()).toBe(true);
      expect(await h.db.collection('outbox_events').countDocuments()).toBe(1);
      expect(await h.db.collection('outbox_events').countDocuments({ status: 'PROCESSED' })).toBe(
        1,
      );
      expect(
        await Promise.all(
          collections.map((collection) => h.db.collection(collection).find({}).toArray()),
        ),
      ).toEqual(before);
    });
  }
}

for (const [name, override] of [
  ['null payload', { payload: null }],
  ['empty payload', { payload: {} }],
  ['missing userId', { payload: { other: 'value' } }],
  ['malformed userId', { payload: { userId: 'invalid' } }],
  ['non-string userId', { payload: { userId: new ObjectId() } }],
  ['array payload', { payload: [] }],
  ['invalid aggregate ID', { aggregateId: 'invalid' }],
  ['noncanonical aggregate ID', { aggregateId: 'ABCDEFABCDEFABCDEFABCDEF' }],
] as const) {
  test(`processor rejects ${name} without acknowledging the lifecycle fact`, async () => {
    const event = { ...fact(), ...override };
    await h.db.collection('outbox_events').insertOne(event);
    expect(await processor().processOne()).toBe(true);
    const current = await h.db.collection('outbox_events').findOne({ _id: event._id });
    expect(current).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(current?.processedAt).toBeUndefined();
    expect(current?.completedHandlers).toBeUndefined();
  });
}

test('processor rejects a missing aggregate ID', async () => {
  const { aggregateId: _aggregateId, ...event } = fact();
  await h.db.collection('outbox_events').insertOne(event);
  expect(await processor().processOne()).toBe(true);
  expect(await h.db.collection('outbox_events').findOne({ _id: event._id })).toMatchObject({
    status: 'PENDING',
    attempts: 1,
  });
  expect(await h.db.collection('outbox_events').countDocuments({ status: 'PROCESSED' })).toBe(0);
});
