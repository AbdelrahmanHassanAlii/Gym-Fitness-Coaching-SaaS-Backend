import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { type Db, MongoClient, ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import type { AppConfig } from '../src/config/config.types';
import { AuditWriter } from '../src/core/audit/audit.writer';
import type { Database } from '../src/core/database/database';
import { UnitOfWork } from '../src/core/database/unit-of-work';
import { AppError } from '../src/core/errors/app-error';
import { OutboxWriter } from '../src/core/events/outbox.writer';
import { IdempotencyService } from '../src/core/idempotency/idempotency.service';
import { migrations } from '../src/migrations';
import { migration009Stage5ExistingWorkspaceBackfill } from '../src/migrations/009-stage5-existing-workspace-backfill';
import { migration010Stage5WorkspaceUsageRevision } from '../src/migrations/010-stage5-workspace-usage-revision';
import { MigrationRunner } from '../src/migrations/migration-runner';
import {
  Permissions,
  systemPermissionProfiles,
} from '../src/modules/permissions/permission.registry';
import {
  ManualPaymentRepository,
  SubscriptionPlanRepository,
  SubscriptionRepository,
  WorkspaceUsageRepository,
} from '../src/modules/subscriptions/subscription.repository';
import {
  EntitlementService,
  SubscriptionApplicationService,
} from '../src/modules/subscriptions/subscription.service';
import type {
  SubscriptionDocument,
  SubscriptionTermDocument,
  WorkspaceUsageDocument,
} from '../src/modules/subscriptions/subscription.types';
import {
  WorkspaceMembershipRepository,
  WorkspaceRepository,
} from '../src/modules/workspaces/workspace.repository';

describe('Stage 5 permission registry', () => {
  test('adds locked commercial permissions with intentional system-profile mapping', () => {
    const owner = systemPermissionProfiles.find((profile) => profile.roleKey === 'GYM_OWNER');
    const trainer = systemPermissionProfiles.find((profile) => profile.roleKey === 'TRAINER');
    const assistant = systemPermissionProfiles.find(
      (profile) => profile.roleKey === 'ASSISTANT_TRAINER',
    );
    const nutritionist = systemPermissionProfiles.find(
      (profile) => profile.roleKey === 'NUTRITIONIST',
    );
    const subscriptionAdmin = systemPermissionProfiles.find(
      (profile) => profile.roleKey === 'SUBSCRIPTION_ADMIN',
    );

    expect(owner?.permissions.map((entry) => entry.permission)).toContain(
      Permissions.BillingSubscriptionRead,
    );
    expect(owner?.permissions.map((entry) => entry.permission)).toContain(
      Permissions.BillingPaymentsCreate,
    );
    for (const profile of [trainer, assistant, nutritionist]) {
      expect(profile?.permissions.some((entry) => entry.permission.startsWith('billing.'))).toBe(
        false,
      );
    }
    expect(subscriptionAdmin?.permissions.map((entry) => entry.permission)).toEqual(
      expect.arrayContaining([
        Permissions.PlansRead,
        Permissions.PlansCreate,
        Permissions.SubscriptionsStartTrial,
        Permissions.SubscriptionsFreeze,
        Permissions.PaymentsApprove,
        Permissions.PaymentsReject,
      ]),
    );
  });
});

describe('Stage 5 entitlements', () => {
  test('keeps billing reads available while blocking product writes for inactive commercial states', async () => {
    for (const status of ['FROZEN', 'EXPIRED', 'CANCELLED', 'PENDING_ACTIVATION'] as const) {
      const workspaceId = new ObjectId();
      const service = entitlementFor(status, workspaceId);
      await expect(service.evaluate(workspaceId, 'READ')).resolves.toMatchObject({
        allowed: true,
      });
      await expect(service.assert(workspaceId, 'WRITE')).rejects.toMatchObject({
        code: 'SUBSCRIPTION_FROZEN',
      });
    }
  });

  test('allows active and trial product actions when features are enabled', async () => {
    for (const status of ['ACTIVE', 'TRIAL'] as const) {
      const workspaceId = new ObjectId();
      const service = entitlementFor(status, workspaceId, { enabledFeatures: ['training'] });
      await expect(service.assert(workspaceId, 'WRITE', 'training')).resolves.toMatchObject({
        allowed: true,
      });
      await expect(service.assert(workspaceId, 'WRITE', 'nutrition')).rejects.toMatchObject({
        code: 'FEATURE_NOT_AVAILABLE',
      });
    }
  });
});

describe('Stage 5 quota concurrency', () => {
  test('atomic staff reservation does not allow two callers to consume the last slot', async () => {
    const workspaceId = new ObjectId();
    const collection = new FakeUsageCollection({
      _id: new ObjectId(),
      workspaceId,
      activeTrainees: 0,
      activeStaff: 0,
      storageBytes: 0,
      reservedStorageBytes: 0,
      revision: 0,
      calculatedAt: new Date(),
      updatedAt: new Date(),
    });
    const repository = new WorkspaceUsageRepository(fakeDatabase(collection));

    const results = await Promise.allSettled([
      repository.reserveStaff(workspaceId, 1),
      repository.reserveStaff(workspaceId, 1),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(collection.document.activeStaff).toBe(1);
  });
});

describe('Stage 5 idempotency', () => {
  test('replays completed matching commands and rejects mismatches or in-progress duplicates', async () => {
    const collection = new FakeIdempotencyCollection();
    const service = new IdempotencyService(fakeDatabase(collection));
    const ctx = {
      userId: new ObjectId().toHexString(),
      authSessionId: new ObjectId().toHexString(),
      correlationId: 'stage5-idempotency',
      ipAddress: '127.0.0.1',
      locale: 'en',
      timezone: 'Africa/Cairo',
    };
    let executions = 0;

    const first = await service.run(ctx, {
      routeKey: 'POST /stage5',
      key: 'same-key',
      fingerprint: { body: { amount: 10 } },
      operation: async () => {
        executions += 1;
        return { body: { ok: true } };
      },
    });
    const replay = await service.run(ctx, {
      routeKey: 'POST /stage5',
      key: 'same-key',
      fingerprint: { body: { amount: 10 } },
      operation: async () => {
        executions += 1;
        return { body: { ok: false } };
      },
    });

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual({ ok: true });
    expect(executions).toBe(1);
    await expect(
      service.run(ctx, {
        routeKey: 'POST /stage5',
        key: 'same-key',
        fingerprint: { body: { amount: 20 } },
        operation: async () => ({ body: {} }),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    await collection.insertOne({
      actorId: ctx.userId,
      routeKey: 'POST /other',
      key: 'busy',
      requestHash: collection.hashFor({ ok: true }),
      state: 'PROCESSING',
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      service.run(ctx, {
        routeKey: 'POST /other',
        key: 'busy',
        fingerprint: { ok: true },
        operation: async () => ({ body: {} }),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' });

    const otherActor = { ...ctx, userId: new ObjectId().toHexString() };
    await expect(
      service.run(otherActor, {
        routeKey: 'POST /stage5',
        key: 'same-key',
        fingerprint: { body: { amount: 10 } },
        operation: async () => ({ body: { ok: 'other-actor' } }),
      }),
    ).resolves.toMatchObject({ replayed: false });
  });
});

describe('Stage 5 route authorization metadata', () => {
  test('workspace billing routes use dedicated billing permissions', async () => {
    const ids = idsFixture();
    const calls: Array<Record<string, unknown>> = [];
    const app = await buildApp(
      routeContainer(ids, {
        async authorize(_ctx: unknown, input: unknown) {
          calls.push(input as Record<string, unknown>);
          return { allowed: true };
        },
      }),
    );

    await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ids.workspaceId}/subscription`,
      headers: { authorization: 'Bearer valid' },
    });
    await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ids.workspaceId}/subscription/usage`,
      headers: { authorization: 'Bearer valid' },
    });

    expect(calls.map((call) => call.permission)).toEqual([
      Permissions.BillingSubscriptionRead,
      Permissions.BillingUsageRead,
    ]);
    await app.close();
  });

  test('trainer-style denied billing access stops before handler execution', async () => {
    const ids = idsFixture();
    let handlerCalled = false;
    const app = await buildApp(
      routeContainer(ids, {
        async authorize() {
          throw new AppError({
            code: 'PERMISSION_DENIED',
            httpStatus: 403,
            message: 'Permission denied.',
          });
        },
        subscriptions: {
          async getWorkspaceSubscription() {
            handlerCalled = true;
            return {};
          },
        },
      }),
    );
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ids.workspaceId}/subscription`,
      headers: { authorization: 'Bearer valid' },
    });

    expect(response.statusCode).toBe(403);
    expect(handlerCalled).toBe(false);
    await app.close();
  });
});

describe('Stage 5 existing workspace backfill', () => {
  test('creates pending subscriptions and usage without active terms', async () => {
    const workspaceId = new ObjectId();
    const userId = new ObjectId();
    const db = new FakeMigrationDb({
      workspaces: [{ _id: workspaceId }],
      workspace_memberships: [
        { _id: new ObjectId(), workspaceId, userId, status: 'ACTIVE', roles: ['TRAINER'] },
      ],
      workspace_usage: [],
      subscriptions: [],
    });

    await migration009Stage5ExistingWorkspaceBackfill.up(db as never);
    await migration009Stage5ExistingWorkspaceBackfill.up(db as never);

    const usageRows = db.collections.workspace_usage ?? [];
    const subscriptionRows = db.collections.subscriptions ?? [];
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({ workspaceId, activeStaff: 1 });
    expect(subscriptionRows).toHaveLength(1);
    expect(subscriptionRows[0]).toMatchObject({
      workspaceId,
      lifecycleStatus: 'PENDING_ACTIVATION',
    });
  });

  test('workspace usage revision migration initializes existing Stage 5 usage rows', async () => {
    const workspaceId = new ObjectId();
    const db = new FakeMigrationDb({
      workspace_usage: [
        {
          _id: new ObjectId(),
          workspaceId,
          activeTrainees: 0,
          activeStaff: 1,
          storageBytes: 0,
          reservedStorageBytes: 0,
        },
      ],
    });

    await migration010Stage5WorkspaceUsageRevision.up(db as never);
    await migration010Stage5WorkspaceUsageRevision.up(db as never);

    expect(db.collections.workspace_usage?.[0]).toMatchObject({ workspaceId, revision: 0 });
  });
});

describe('Stage 5 corrective integration coverage', () => {
  let mongo: MongoClient;
  let db: Db;
  let database: Database;

  beforeAll(async () => {
    mongo = new MongoClient(mongoUri());
    await mongo.connect();
    db = mongo.db(`stage5_corrective_${new ObjectId().toHexString()}`);
    database = {
      client: mongo,
      db,
      ping: async () => true,
      close: async () => undefined,
    };
    await new MigrationRunner(db, migrations).migrate();
  });

  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (mongo) await mongo.close();
  });

  test('real Mongo staff quota race allows only one final reservation', async () => {
    const workspaceId = new ObjectId();
    await db.collection('workspace_usage').insertOne({
      _id: new ObjectId(),
      workspaceId,
      activeTrainees: 0,
      activeStaff: 0,
      storageBytes: 0,
      reservedStorageBytes: 0,
      revision: 0,
      calculatedAt: new Date(),
      updatedAt: new Date(),
    });
    const usage = new WorkspaceUsageRepository(database);

    const results = await Promise.allSettled([
      usage.reserveStaff(workspaceId, 1),
      usage.reserveStaff(workspaceId, 1),
    ]);
    const saved = await db.collection('workspace_usage').findOne({ workspaceId });

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(saved?.activeStaff).toBe(1);
    expect(saved?.revision).toBe(1);
  });

  test('quota reservation rolls back with its surrounding transaction', async () => {
    const workspaceId = new ObjectId();
    await db.collection('workspace_usage').insertOne({
      _id: new ObjectId(),
      workspaceId,
      activeTrainees: 0,
      activeStaff: 0,
      storageBytes: 0,
      reservedStorageBytes: 0,
      revision: 0,
      calculatedAt: new Date(),
      updatedAt: new Date(),
    });
    const usage = new WorkspaceUsageRepository(database);
    const unitOfWork = new UnitOfWork(database as never);

    await expect(
      unitOfWork.withTransaction(async (tx) => {
        await usage.reserveStaff(workspaceId, 1, tx);
        throw new Error('later business failure');
      }),
    ).rejects.toThrow('later business failure');

    const saved = await db.collection('workspace_usage').findOne({ workspaceId });
    expect(saved?.activeStaff).toBe(0);
    expect(saved?.revision).toBe(0);
  });

  test('reconciliation stale repair cannot overwrite a live quota reservation', async () => {
    const workspaceId = new ObjectId();
    await db.collection('workspace_usage').insertOne({
      _id: new ObjectId(),
      workspaceId,
      activeTrainees: 0,
      activeStaff: 0,
      storageBytes: 0,
      reservedStorageBytes: 0,
      revision: 0,
      calculatedAt: new Date(),
      updatedAt: new Date(),
    });
    const usage = new WorkspaceUsageRepository(database);

    const snapshot = await usage.findByWorkspaceId(workspaceId);
    expect(snapshot?.revision).toBe(0);
    const staleCounters = { activeTrainees: 0, activeStaff: 0, storageBytes: 0 };

    await usage.reserveStaff(workspaceId, 1);
    const staleRepair = await usage.repairCalculatedIfRevision(
      workspaceId,
      snapshot?.revision ?? -1,
      staleCounters,
    );
    const saved = await db.collection('workspace_usage').findOne({ workspaceId });

    expect(staleRepair).toBeNull();
    expect(saved).toMatchObject({ activeStaff: 1, revision: 1 });
    await expect(usage.reserveStaff(workspaceId, 1)).rejects.toMatchObject({
      code: 'STAFF_LIMIT_EXCEEDED',
    });
    expect((await db.collection('workspace_usage').findOne({ workspaceId }))?.activeStaff).toBe(1);
  });

  test('successful reconciliation repair advances revision without touching reservations', async () => {
    const workspaceId = new ObjectId();
    await db.collection('workspace_usage').insertOne({
      _id: new ObjectId(),
      workspaceId,
      activeTrainees: 0,
      activeStaff: 2,
      storageBytes: 0,
      reservedStorageBytes: 12,
      revision: 0,
      calculatedAt: new Date(),
      updatedAt: new Date(),
    });
    const usage = new WorkspaceUsageRepository(database);
    const snapshot = await usage.findByWorkspaceId(workspaceId);

    const repaired = await usage.repairCalculatedIfRevision(workspaceId, snapshot?.revision ?? -1, {
      activeTrainees: 0,
      activeStaff: 0,
      storageBytes: 0,
    });

    expect(repaired).toMatchObject({
      activeStaff: 0,
      reservedStorageBytes: 12,
      revision: 1,
    });
  });

  test('idempotent transaction commits commercial state and replay result together', async () => {
    const service = new IdempotencyService(database as never);
    const unitOfWork = new UnitOfWork(database as never);
    const ctx = ctxFixture();
    const result = await service.runInTransaction(ctx, {
      routeKey: 'POST /stage5/atomic',
      key: 'atomic-key',
      fingerprint: { body: { amount: 10 } },
      unitOfWork,
      operation: async (tx) => {
        const recordId = new ObjectId('000000000000000000000001');
        await db
          .collection('commercial_test')
          .insertOne({ _id: recordId, ok: true }, { session: tx.session });
        await db
          .collection('audit_events')
          .insertOne({ eventType: 'AtomicAudit', occurredAt: new Date() }, { session: tx.session });
        await db
          .collection('outbox_events')
          .insertOne(
            { eventType: 'AtomicOutbox', status: 'PENDING', attempts: 0, occurredAt: new Date() },
            { session: tx.session },
          );
        return { statusCode: 201, body: { ok: true } };
      },
    });
    const replay = await service.runInTransaction(ctx, {
      routeKey: 'POST /stage5/atomic',
      key: 'atomic-key',
      fingerprint: { body: { amount: 10 } },
      unitOfWork,
      operation: async () => ({ body: { ok: false } }),
    });

    expect(result.statusCode).toBe(201);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual({ ok: true });
    expect(
      await db
        .collection('commercial_test')
        .countDocuments({ _id: new ObjectId('000000000000000000000001') }),
    ).toBe(1);
    expect(
      await db.collection('idempotency_records').findOne({
        actorId: ctx.userId,
        routeKey: 'POST /stage5/atomic',
        key: 'atomic-key',
      }),
    ).toMatchObject({ state: 'COMPLETED', responseStatus: 201, responseBody: { ok: true } });
  });

  test('transaction failure does not leave domain, audit, outbox, or completed idempotency state', async () => {
    const service = new IdempotencyService(database as never);
    const unitOfWork = new UnitOfWork(database as never);
    const ctx = ctxFixture();

    await expect(
      service.runInTransaction(ctx, {
        routeKey: 'POST /stage5/fail',
        key: 'fail-key',
        fingerprint: { body: { amount: 20 } },
        unitOfWork,
        operation: async (tx) => {
          await db
            .collection('commercial_test')
            .insertOne({ _id: new ObjectId('000000000000000000000002') }, { session: tx.session });
          await db
            .collection('audit_events')
            .insertOne(
              { eventType: 'RollbackAudit', occurredAt: new Date() },
              { session: tx.session },
            );
          await db.collection('outbox_events').insertOne(
            {
              eventType: 'RollbackOutbox',
              status: 'PENDING',
              attempts: 0,
              occurredAt: new Date(),
            },
            { session: tx.session },
          );
          throw new Error('forced transaction failure');
        },
      }),
    ).rejects.toThrow('forced transaction failure');

    expect(
      await db
        .collection('commercial_test')
        .countDocuments({ _id: new ObjectId('000000000000000000000002') }),
    ).toBe(0);
    expect(await db.collection('audit_events').countDocuments({ eventType: 'RollbackAudit' })).toBe(
      0,
    );
    expect(
      await db.collection('outbox_events').countDocuments({ eventType: 'RollbackOutbox' }),
    ).toBe(0);
    expect(
      await db.collection('idempotency_records').findOne({
        actorId: ctx.userId,
        routeKey: 'POST /stage5/fail',
        key: 'fail-key',
      }),
    ).toMatchObject({ state: 'FAILED' });
  });

  test('failed idempotent attempts with rolled-back transactions can retry the same fingerprint', async () => {
    const service = new IdempotencyService(database as never);
    const unitOfWork = new UnitOfWork(database as never);
    const ctx = ctxFixture();

    await expect(
      service.runInTransaction(ctx, {
        routeKey: 'POST /stage5/retry-failed',
        key: 'retry-failed-key',
        fingerprint: { body: { amount: 21 } },
        unitOfWork,
        operation: async () => {
          throw new Error('first attempt failed');
        },
      }),
    ).rejects.toThrow('first attempt failed');

    await expect(
      service.runInTransaction(ctx, {
        routeKey: 'POST /stage5/retry-failed',
        key: 'retry-failed-key',
        fingerprint: { body: { amount: 21 } },
        unitOfWork,
        operation: async () => ({ body: { retried: true } }),
      }),
    ).resolves.toMatchObject({ replayed: false, body: { retried: true } });
  });

  test('audit failure rolls back manual payment and idempotency success', async () => {
    const seeded = await seedWorkspacePlanSubscription(database, 'PENDING_ACTIVATION');
    const idempotency = new IdempotencyService(database as never);
    const unitOfWork = new UnitOfWork(database as never);
    const service = subscriptionService(database, {
      audit: {
        async write() {
          throw new Error('audit unavailable');
        },
      },
    });
    const ctx = ctxFixture();

    await expect(
      idempotency.runInTransaction(ctx, {
        routeKey: 'POST /workspaces/:workspaceId/payments',
        key: 'audit-fail-key',
        fingerprint: { workspaceId: seeded.workspaceId.toHexString(), amount: 100 },
        unitOfWork,
        operation: async (tx) => ({
          statusCode: 201,
          body: await service.createManualPayment(
            ctx,
            seeded.workspaceId.toHexString(),
            {
              amount: 100,
              currency: 'EGP',
              paymentMethod: 'bank',
            },
            tx,
          ),
        }),
      }),
    ).rejects.toThrow('audit unavailable');

    expect(
      await db.collection('manual_payments').countDocuments({ workspaceId: seeded.workspaceId }),
    ).toBe(0);
    expect(
      await db.collection('idempotency_records').findOne({
        actorId: ctx.userId,
        routeKey: 'POST /workspaces/:workspaceId/payments',
        key: 'audit-fail-key',
      }),
    ).toMatchObject({ state: 'FAILED' });
  });

  test('outbox failure rolls back manual payment and idempotency success', async () => {
    const seeded = await seedWorkspacePlanSubscription(database, 'PENDING_ACTIVATION');
    const idempotency = new IdempotencyService(database as never);
    const unitOfWork = new UnitOfWork(database as never);
    const service = subscriptionService(database, {
      outbox: {
        async write() {
          throw new Error('outbox unavailable');
        },
      },
    });
    const ctx = ctxFixture();

    await expect(
      idempotency.runInTransaction(ctx, {
        routeKey: 'POST /workspaces/:workspaceId/payments',
        key: 'outbox-fail-key',
        fingerprint: { workspaceId: seeded.workspaceId.toHexString(), amount: 100 },
        unitOfWork,
        operation: async (tx) => ({
          statusCode: 201,
          body: await service.createManualPayment(
            ctx,
            seeded.workspaceId.toHexString(),
            {
              amount: 100,
              currency: 'EGP',
              paymentMethod: 'bank',
            },
            tx,
          ),
        }),
      }),
    ).rejects.toThrow('outbox unavailable');

    expect(
      await db.collection('manual_payments').countDocuments({ workspaceId: seeded.workspaceId }),
    ).toBe(0);
    expect(
      await db.collection('outbox_events').countDocuments({ workspaceId: seeded.workspaceId }),
    ).toBe(0);
    expect(
      await db.collection('idempotency_records').findOne({
        actorId: ctx.userId,
        routeKey: 'POST /workspaces/:workspaceId/payments',
        key: 'outbox-fail-key',
      }),
    ).toMatchObject({ state: 'FAILED' });
  });

  test('idempotency completion failure rolls back commercial mutation', async () => {
    await db.command({
      collMod: 'idempotency_records',
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          properties: { state: { enum: ['PROCESSING', 'FAILED'] } },
        },
      },
      validationAction: 'error',
    });
    const service = new IdempotencyService(database as never);
    const unitOfWork = new UnitOfWork(database as never);
    const ctx = ctxFixture();

    try {
      await expect(
        service.runInTransaction(ctx, {
          routeKey: 'POST /stage5/completion-fail',
          key: 'completion-fail-key',
          fingerprint: { body: { amount: 30 } },
          unitOfWork,
          operation: async (tx) => {
            await db
              .collection('commercial_test')
              .insertOne(
                { _id: new ObjectId('000000000000000000000003') },
                { session: tx.session },
              );
            return { body: { ok: true } };
          },
        }),
      ).rejects.toThrow();
    } finally {
      await db.command({ collMod: 'idempotency_records', validator: {} });
    }

    expect(
      await db
        .collection('commercial_test')
        .countDocuments({ _id: new ObjectId('000000000000000000000003') }),
    ).toBe(0);
    expect(
      await db.collection('idempotency_records').findOne({
        actorId: ctx.userId,
        routeKey: 'POST /stage5/completion-fail',
        key: 'completion-fail-key',
      }),
    ).toMatchObject({ state: 'FAILED' });
  });

  test('concurrent identical idempotency requests execute at most once', async () => {
    const service = new IdempotencyService(database as never);
    const unitOfWork = new UnitOfWork(database as never);
    const ctx = ctxFixture();
    let executions = 0;

    const requests = await Promise.allSettled([
      service.runInTransaction(ctx, {
        routeKey: 'POST /stage5/concurrent',
        key: 'concurrent-key',
        fingerprint: { body: { same: true } },
        unitOfWork,
        operation: async () => {
          executions += 1;
          await delay(100);
          return { body: { ok: true } };
        },
      }),
      service.runInTransaction(ctx, {
        routeKey: 'POST /stage5/concurrent',
        key: 'concurrent-key',
        fingerprint: { body: { same: true } },
        unitOfWork,
        operation: async () => {
          executions += 1;
          return { body: { ok: false } };
        },
      }),
    ]);

    expect(executions).toBe(1);
    expect(
      requests.every((result) => result.status === 'fulfilled' || result.status === 'rejected'),
    ).toBe(true);
    if (requests.every((result) => result.status === 'fulfilled')) {
      expect(
        requests.some((result) => result.status === 'fulfilled' && result.value.replayed),
      ).toBe(true);
    } else {
      expect(requests.filter((result) => result.status === 'rejected')).toHaveLength(1);
    }
  });

  test('stale PROCESSING idempotency records can be recovered atomically', async () => {
    const service = new IdempotencyService(database as never);
    const unitOfWork = new UnitOfWork(database as never);
    const ctx = ctxFixture();
    await db.collection('idempotency_records').insertOne({
      actorId: ctx.userId,
      routeKey: 'POST /stage5/stale',
      key: 'stale-key',
      requestHash: createHash('sha256').update('{"body":{"same":true}}').digest('hex'),
      state: 'PROCESSING',
      createdAt: new Date(Date.now() - 600_000),
      updatedAt: new Date(Date.now() - 600_000),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await service.runInTransaction(ctx, {
      routeKey: 'POST /stage5/stale',
      key: 'stale-key',
      fingerprint: { body: { same: true } },
      unitOfWork,
      operation: async () => ({ body: { recovered: true } }),
    });

    expect(result.replayed).toBe(false);
    expect(
      await db.collection('idempotency_records').findOne({
        actorId: ctx.userId,
        routeKey: 'POST /stage5/stale',
        key: 'stale-key',
      }),
    ).toMatchObject({ state: 'COMPLETED', responseBody: { recovered: true } });
  });

  test('nonexistent platform workspace commands cannot create commercial records', async () => {
    const service = subscriptionService(database);
    const ids = await seedPlan(database, { billingOptions: ['MONTHLY'] });
    const workspaceId = new ObjectId();

    await expect(
      service.startTrial(ctxFixture(), workspaceId.toHexString(), {
        expectedVersion: 0,
        planVersionId: ids.versionId.toHexString(),
        billingPeriod: 'MONTHLY',
        effectiveFrom: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });

    expect(await db.collection('subscriptions').countDocuments({ workspaceId })).toBe(0);
    expect(await db.collection('subscription_terms').countDocuments({ workspaceId })).toBe(0);
    expect(await db.collection('audit_events').countDocuments({ workspaceId })).toBe(0);
    expect(await db.collection('outbox_events').countDocuments({ workspaceId })).toBe(0);
  });

  test('payment approval commits payment, subscription, term, audit, outbox, and idempotency together', async () => {
    const service = subscriptionService(database);
    const idempotency = new IdempotencyService(database as never);
    const unitOfWork = new UnitOfWork(database as never);
    const seeded = await seedWorkspacePlanSubscription(database, 'PENDING_ACTIVATION');
    const paymentId = new ObjectId();
    const ctx = ctxFixture();
    await db.collection('manual_payments').insertOne({
      _id: paymentId,
      workspaceId: seeded.workspaceId,
      subscriptionId: seeded.subscriptionId,
      amount: 100,
      currency: 'EGP',
      paymentMethod: 'bank',
      status: 'PENDING',
      version: 0,
      createdBy: new ObjectId(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      idempotency.runInTransaction(ctx, {
        routeKey: 'POST /platform/payments/:paymentId/approve',
        key: 'approve-key',
        fingerprint: { paymentId: paymentId.toHexString() },
        unitOfWork,
        operation: async (tx) => ({
          body: await service.approvePayment(
            ctx,
            paymentId.toHexString(),
            { ...changeTermsBody(seeded.versionId, 0), paymentExpectedVersion: 0 },
            tx,
          ),
        }),
      }),
    ).resolves.toMatchObject({
      replayed: false,
      body: {
        payment: { status: 'APPROVED', version: 1 },
        subscription: { lifecycleStatus: 'ACTIVE', version: 1 },
      },
    });

    expect(
      await db.collection('manual_payments').countDocuments({ _id: paymentId, status: 'APPROVED' }),
    ).toBe(1);
    expect(
      await db.collection('subscription_terms').countDocuments({ workspaceId: seeded.workspaceId }),
    ).toBe(1);
    expect(
      await db.collection('audit_events').countDocuments({ workspaceId: seeded.workspaceId }),
    ).toBe(2);
    expect(
      await db.collection('outbox_events').countDocuments({ workspaceId: seeded.workspaceId }),
    ).toBe(3);
    expect(
      await db.collection('idempotency_records').findOne({
        actorId: ctx.userId,
        routeKey: 'POST /platform/payments/:paymentId/approve',
        key: 'approve-key',
      }),
    ).toMatchObject({ state: 'COMPLETED' });
  });

  test('cancelled subscriptions cannot reactivate, upgrade, downgrade, or activate by payment', async () => {
    const service = subscriptionService(database);
    const seeded = await seedWorkspacePlanSubscription(database, 'CANCELLED');
    const body = changeTermsBody(seeded.versionId, 0);

    await expect(
      service.reactivate(ctxFixture(), seeded.workspaceId.toHexString(), body),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_VERSION_CONFLICT' });
    await expect(
      service.changePlan(ctxFixture(), seeded.workspaceId.toHexString(), body, 'UPGRADE'),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_VERSION_CONFLICT' });
    await expect(
      service.changePlan(ctxFixture(), seeded.workspaceId.toHexString(), body, 'DOWNGRADE'),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_VERSION_CONFLICT' });

    const paymentId = new ObjectId();
    await db.collection('manual_payments').insertOne({
      _id: paymentId,
      workspaceId: seeded.workspaceId,
      subscriptionId: seeded.subscriptionId,
      amount: 100,
      currency: 'EGP',
      paymentMethod: 'bank',
      status: 'PENDING',
      version: 0,
      createdBy: new ObjectId(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      service.approvePayment(ctxFixture(), paymentId.toHexString(), {
        ...body,
        paymentExpectedVersion: 0,
      }),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_VERSION_CONFLICT' });

    expect(
      await db.collection('subscription_terms').countDocuments({ workspaceId: seeded.workspaceId }),
    ).toBe(0);
    expect(
      await db.collection('audit_events').countDocuments({ workspaceId: seeded.workspaceId }),
    ).toBe(0);
    expect(
      await db.collection('outbox_events').countDocuments({ workspaceId: seeded.workspaceId }),
    ).toBe(0);
  });

  test('reactivation clears stale current lifecycle markers and returns public DTOs', async () => {
    const service = subscriptionService(database);
    const seeded = await seedWorkspacePlanSubscription(database, 'FROZEN', {
      frozenAt: new Date('2026-01-01T00:00:00.000Z'),
      graceEndsAt: new Date('2026-01-02T00:00:00.000Z'),
      expiredAt: new Date('2026-01-03T00:00:00.000Z'),
    });

    const result = await service.reactivate(
      ctxFixture(),
      seeded.workspaceId.toHexString(),
      changeTermsBody(seeded.versionId, 0),
    );
    const saved = await db.collection('subscriptions').findOne({ _id: seeded.subscriptionId });

    expect(result).toMatchObject({
      subscription: { lifecycleStatus: 'ACTIVE', version: 1 },
      currentTerms: { billingPeriod: 'MONTHLY' },
    });
    expect(result).not.toHaveProperty('response');
    expect(typeof result.subscription.id).toBe('string');
    expect(saved).not.toHaveProperty('frozenAt');
    expect(saved).not.toHaveProperty('graceEndsAt');
    expect(saved).not.toHaveProperty('expiredAt');
    expect(
      await db.collection('subscription_terms').countDocuments({ workspaceId: seeded.workspaceId }),
    ).toBe(1);
    expect(
      await db.collection('audit_events').countDocuments({ workspaceId: seeded.workspaceId }),
    ).toBe(1);
  });

  test('plan eligibility rejects archived plans and unsupported billing periods', async () => {
    const service = subscriptionService(database);
    const archived = await seedWorkspacePlanSubscription(database, 'PENDING_ACTIVATION', {
      planActive: false,
    });
    await expect(
      service.startTrial(ctxFixture(), archived.workspaceId.toHexString(), {
        expectedVersion: 0,
        planVersionId: archived.versionId.toHexString(),
        billingPeriod: 'MONTHLY',
        effectiveFrom: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_PLAN_NOT_ELIGIBLE' });

    const monthlyOnly = await seedWorkspacePlanSubscription(database, 'PENDING_ACTIVATION', {
      billingOptions: ['MONTHLY'],
    });
    await expect(
      service.startTrial(ctxFixture(), monthlyOnly.workspaceId.toHexString(), {
        expectedVersion: 0,
        planVersionId: monthlyOnly.versionId.toHexString(),
        billingPeriod: 'YEARLY',
        effectiveFrom: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_BILLING_PERIOD_NOT_AVAILABLE' });

    await expect(
      service.startTrial(ctxFixture(), monthlyOnly.workspaceId.toHexString(), {
        expectedVersion: 0,
        planVersionId: monthlyOnly.versionId.toHexString(),
        billingPeriod: 'MONTHLY',
        effectiveFrom: new Date().toISOString(),
      }),
    ).resolves.toMatchObject({ subscription: { lifecycleStatus: 'TRIAL' } });
  });

  test('start trial uses only plan-version trial duration and snapshots commercial terms', async () => {
    const service = subscriptionService(database);
    const seeded = await seedWorkspacePlanSubscription(database, 'PENDING_ACTIVATION', {
      trialDays: 7,
    });
    const effectiveFrom = new Date('2026-09-08T00:00:00.000Z');

    await expect(
      service.startTrial(ctxFixture(), seeded.workspaceId.toHexString(), {
        expectedVersion: 0,
        planVersionId: seeded.versionId.toHexString(),
        billingPeriod: 'MONTHLY',
        effectiveFrom: effectiveFrom.toISOString(),
      }),
    ).resolves.toMatchObject({
      subscription: {
        lifecycleStatus: 'TRIAL',
        expiresAt: '2026-09-15T00:00:00.000Z',
      },
      currentTerms: {
        planVersionId: seeded.versionId.toHexString(),
        billingPeriod: 'MONTHLY',
        effectiveFrom: '2026-09-08T00:00:00.000Z',
        effectiveTo: '2026-09-15T00:00:00.000Z',
        source: 'TRIAL',
        enabledFeatures: ['training'],
        limits: { activeTrainees: 10, activeStaff: 5, storageBytes: 1000 },
      },
    });
  });

  test('public start-trial route rejects arbitrary trialDays override before service execution', async () => {
    const ids = idsFixture();
    let called = false;
    const app = await buildApp(
      routeContainer(ids, {
        async authorize() {
          return { allowed: true };
        },
        subscriptions: {
          async startTrial() {
            called = true;
            return {};
          },
        },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/platform/workspaces/${ids.workspaceId}/subscription/start-trial`,
      headers: {
        authorization: 'Bearer valid',
        'idempotency-key': 'trial-days-override',
      },
      payload: {
        expectedVersion: 0,
        planVersionId: new ObjectId().toHexString(),
        billingPeriod: 'MONTHLY',
        effectiveFrom: new Date().toISOString(),
        trialDays: 365,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(called).toBe(false);
    await app.close();
  });

  test('plan version without trial defaults rejects startTrial', async () => {
    const service = subscriptionService(database);
    const seeded = await seedWorkspacePlanSubscription(database, 'PENDING_ACTIVATION', {
      trialDays: null,
    });

    await expect(
      service.startTrial(ctxFixture(), seeded.workspaceId.toHexString(), {
        expectedVersion: 0,
        planVersionId: seeded.versionId.toHexString(),
        billingPeriod: 'MONTHLY',
        effectiveFrom: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_TRIAL_DAYS_REQUIRED' });
    expect(
      await db.collection('subscription_terms').countDocuments({ workspaceId: seeded.workspaceId }),
    ).toBe(0);
  });
});

function entitlementFor(
  status: SubscriptionDocument['lifecycleStatus'],
  workspaceId: ObjectId,
  options: { enabledFeatures?: string[] } = {},
) {
  const subscription: SubscriptionDocument = {
    _id: new ObjectId(),
    workspaceId,
    lifecycleStatus: status,
    currentTermsId: new ObjectId(),
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const currentTermsId = subscription.currentTermsId ?? new ObjectId();
  const terms: SubscriptionTermDocument = {
    _id: currentTermsId,
    subscriptionId: subscription._id,
    workspaceId,
    planVersionId: new ObjectId(),
    billingPeriod: 'MONTHLY',
    limits: { activeTrainees: 10, activeStaff: 5, storageBytes: 1000 },
    enabledFeatures: options.enabledFeatures ?? ['training', 'nutrition'],
    effectiveFrom: new Date(),
    source: 'PURCHASE',
    createdBy: new ObjectId(),
    createdAt: new Date(),
  };
  const usage: WorkspaceUsageDocument = {
    _id: new ObjectId(),
    workspaceId,
    activeTrainees: 0,
    activeStaff: 0,
    storageBytes: 0,
    reservedStorageBytes: 0,
    revision: 0,
    calculatedAt: new Date(),
    updatedAt: new Date(),
  };
  return new EntitlementService(
    {
      async findByWorkspaceId() {
        return subscription;
      },
      async findCurrentTerms() {
        return terms;
      },
    } as never,
    {
      async ensure() {
        return usage;
      },
    } as never,
  );
}

function idsFixture() {
  return {
    userId: new ObjectId().toHexString(),
    sessionId: new ObjectId().toHexString(),
    workspaceId: new ObjectId().toHexString(),
  };
}

function mongoUri(): string {
  return (
    process.env.MONGODB_URI ??
    'mongodb://localhost:27017/gym_platform?replicaSet=rs0&directConnection=true'
  );
}

function testConfig(): AppConfig {
  return {
    env: 'test',
    app: {
      host: '0.0.0.0',
      port: 0,
      docsEnabled: false,
      trustProxy: false,
      allowedOrigins: [],
    },
    mongo: { uri: mongoUri(), dbName: 'stage5-test', connectTimeoutMs: 5000 },
    logging: { level: 'silent' },
    auth: {
      jwtActiveKeyId: 'local',
      jwtPrivateKey:
        '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIP27WzZ2lrwob/CusOSRmtVPlS0TPTrBOFjTuBztUPm8\n-----END PRIVATE KEY-----',
      jwtPublicKeys: {
        local:
          '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAVk4E+7jo4OHXHcYC1lvT+vqaViaFNdUPnMcuSDPpp60=\n-----END PUBLIC KEY-----',
      },
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2592000,
      webRefreshCookieSameSite: 'LAX',
      otpHmacSecret: 'local-dev-change-me',
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
      id: 'stage5-test-worker',
      outboxPollIntervalMs: 1000,
      outboxLockMs: 30000,
      outboxMaxAttempts: 8,
      jobLeaseMs: 30000,
    },
    subscriptions: {
      trialExpiryAction: 'FROZEN',
      paidGraceDays: 0,
      frozenToExpiredDays: 30,
    },
    support: { defaultSessionMinutes: 30, maxSessionMinutes: 60 },
  };
}

function ctxFixture() {
  return {
    userId: new ObjectId().toHexString(),
    authSessionId: new ObjectId().toHexString(),
    platformMembershipId: new ObjectId().toHexString(),
    correlationId: `stage5-${new ObjectId().toHexString()}`,
    ipAddress: '127.0.0.1',
    locale: 'en',
    timezone: 'Africa/Cairo',
  };
}

function subscriptionService(
  database: Database,
  overrides: {
    audit?: Pick<AuditWriter, 'write'>;
    outbox?: Pick<OutboxWriter, 'write'>;
  } = {},
) {
  return new SubscriptionApplicationService(
    testConfig(),
    new UnitOfWork(database as never),
    new SubscriptionPlanRepository(database as never),
    new SubscriptionRepository(database as never),
    new WorkspaceUsageRepository(database as never),
    new ManualPaymentRepository(database as never),
    new WorkspaceRepository(database as never),
    new WorkspaceMembershipRepository(database as never),
    (overrides.audit ?? new AuditWriter(database as never)) as AuditWriter,
    (overrides.outbox ?? new OutboxWriter(database as never)) as OutboxWriter,
  );
}

async function seedPlan(
  database: Pick<Database, 'db'>,
  options: {
    billingOptions?: Array<'MONTHLY' | 'YEARLY'>;
    active?: boolean;
    trialDays?: number | null;
  } = {},
) {
  const planId = new ObjectId();
  const versionId = new ObjectId();
  const now = new Date();
  await database.db.collection('subscription_plans').insertOne({
    _id: planId,
    key: `PLAN_${planId.toHexString()}`,
    customerType: 'GYM',
    name: 'Plan',
    active: options.active ?? true,
    currentVersionId: versionId,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await database.db.collection('subscription_plan_versions').insertOne({
    _id: versionId,
    planId,
    version: 1,
    billingOptions: options.billingOptions ?? ['MONTHLY', 'YEARLY'],
    defaultLimits: { activeTrainees: 10, activeStaff: 5, storageBytes: 1000 },
    features: { training: true },
    ...(options.trialDays !== null ? { trialDefaults: { days: options.trialDays ?? 7 } } : {}),
    effectiveFrom: now,
    createdBy: new ObjectId(),
    createdAt: now,
  });
  return { planId, versionId };
}

async function seedWorkspacePlanSubscription(
  database: Pick<Database, 'db'>,
  lifecycleStatus: SubscriptionDocument['lifecycleStatus'],
  options: {
    frozenAt?: Date;
    graceEndsAt?: Date;
    expiredAt?: Date;
    planActive?: boolean;
    billingOptions?: Array<'MONTHLY' | 'YEARLY'>;
    trialDays?: number | null;
  } = {},
) {
  const workspaceId = new ObjectId();
  const ownerUserId = new ObjectId();
  const subscriptionId = new ObjectId();
  const now = new Date();
  const planInput: {
    active?: boolean;
    billingOptions?: Array<'MONTHLY' | 'YEARLY'>;
    trialDays?: number | null;
  } = {};
  if (options.planActive !== undefined) planInput.active = options.planActive;
  if (options.billingOptions !== undefined) planInput.billingOptions = options.billingOptions;
  if (options.trialDays !== undefined) planInput.trialDays = options.trialDays;
  const plan = await seedPlan(database, planInput);
  await database.db.collection('workspaces').insertOne({
    _id: workspaceId,
    type: 'GYM',
    name: 'Workspace',
    ownerUserId,
    status: 'ACTIVE',
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
    createdAt: now,
    updatedAt: now,
  });
  await database.db.collection('subscriptions').insertOne({
    _id: subscriptionId,
    workspaceId,
    lifecycleStatus,
    version: 0,
    ...(options.frozenAt ? { frozenAt: options.frozenAt } : {}),
    ...(options.graceEndsAt ? { graceEndsAt: options.graceEndsAt } : {}),
    ...(options.expiredAt ? { expiredAt: options.expiredAt } : {}),
    createdAt: now,
    updatedAt: now,
  });
  await database.db.collection('workspace_usage').insertOne({
    _id: new ObjectId(),
    workspaceId,
    activeTrainees: 0,
    activeStaff: 0,
    storageBytes: 0,
    reservedStorageBytes: 0,
    revision: 0,
    calculatedAt: now,
    updatedAt: now,
  });
  return { ...plan, workspaceId, subscriptionId };
}

function changeTermsBody(versionId: ObjectId, expectedVersion: number) {
  return {
    expectedVersion,
    planVersionId: versionId.toHexString(),
    billingPeriod: 'MONTHLY' as const,
    effectiveFrom: new Date().toISOString(),
    effectiveTo: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function routeContainer(ids: ReturnType<typeof idsFixture>, input: Record<string, unknown>) {
  return {
    config: {
      env: 'test',
      app: { trustProxy: false, allowedOrigins: [], docsEnabled: false },
      logging: { level: 'silent' },
    },
    jwt: {
      verifyAccessToken() {
        return { sub: ids.userId, sid: ids.sessionId };
      },
    },
    authSessions: {
      async findActive() {
        return {
          _id: new ObjectId(ids.sessionId),
          userId: new ObjectId(ids.userId),
          authenticationMethods: ['pwd'],
          mfaSatisfiedAt: new Date(),
          restrictedUntilVerified: false,
        };
      },
    },
    auth: {},
    workspaces: {},
    permissions: {},
    accessControl: input,
    idempotency: {
      async run(
        _ctx: unknown,
        runInput: { operation: () => Promise<{ body: unknown; statusCode?: number }> },
      ) {
        return { ...(await runInput.operation()), replayed: false, statusCode: 201 };
      },
      async runInTransaction(
        _ctx: unknown,
        runInput: { operation: (tx: unknown) => Promise<{ body: unknown; statusCode?: number }> },
      ) {
        return {
          ...(await runInput.operation({ session: undefined })),
          replayed: false,
          statusCode: 201,
        };
      },
    },
    subscriptions: {
      async getWorkspaceSubscription() {
        return {};
      },
      async getWorkspaceUsage() {
        return {};
      },
      async listWorkspacePayments() {
        return { data: [], meta: { nextCursor: null, hasMore: false } };
      },
      ...(input.subscriptions as Record<string, unknown> | undefined),
    },
  } as never;
}

class FakeUsageCollection {
  constructor(public document: WorkspaceUsageDocument) {}

  async updateOne(filter: Record<string, unknown>, update: { $inc?: Record<string, number> }) {
    if (filter.activeStaff && typeof filter.activeStaff === 'object') {
      const lt = (filter.activeStaff as Record<string, number>).$lt;
      if (lt === undefined) return { modifiedCount: 0 };
      if (!(this.document.activeStaff < lt)) return { modifiedCount: 0 };
    }
    if (update.$inc?.activeStaff) this.document.activeStaff += update.$inc.activeStaff;
    if (update.$inc?.revision) this.document.revision += update.$inc.revision;
    return { modifiedCount: 1 };
  }

  async findOne() {
    return this.document;
  }
}

class FakeIdempotencyCollection {
  documents: Array<Record<string, unknown>> = [];

  async insertOne(document: Record<string, unknown>) {
    if (
      this.documents.some(
        (item) =>
          item.actorId === document.actorId &&
          item.routeKey === document.routeKey &&
          item.key === document.key,
      )
    ) {
      throw Object.assign(new Error('duplicate'), { code: 11000 });
    }
    this.documents.push({ ...document });
  }

  async findOne(filter: Record<string, unknown>) {
    return (
      this.documents.find((item) =>
        Object.entries(filter).every(([key, value]) => item[key] === value),
      ) ?? null
    );
  }

  async updateOne(filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) {
    const document = await this.findOne(filter);
    if (document) Object.assign(document, update.$set);
    return { modifiedCount: document ? 1 : 0 };
  }

  hashFor(value: unknown) {
    const stable = JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
    return createHash('sha256').update(stable).digest('hex');
  }
}

function fakeDatabase(collection: unknown) {
  return { db: { collection: () => collection } } as never;
}

class FakeMigrationDb {
  constructor(public collections: Record<string, Array<Record<string, unknown>>>) {}

  collection(name: string) {
    const rows = this.collections[name] ?? [];
    this.collections[name] = rows;
    return {
      find: (filter: Record<string, unknown> = {}) => ({
        toArray: async () =>
          rows.filter((row) =>
            Object.entries(filter).every(
              ([key, value]) => row[key]?.toString() === value?.toString(),
            ),
          ),
      }),
      updateOne: async (
        filter: Record<string, unknown>,
        update: { $setOnInsert?: Record<string, unknown> },
        options?: { upsert?: boolean },
      ) => {
        const existing = rows.find((row) =>
          Object.entries(filter).every(
            ([key, value]) => row[key]?.toString() === value?.toString(),
          ),
        );
        if (!existing && options?.upsert && update.$setOnInsert) rows.push(update.$setOnInsert);
      },
      updateMany: async (
        filter: Record<string, unknown>,
        update: { $set?: Record<string, unknown> },
      ) => {
        for (const row of rows) {
          if (
            Object.entries(filter).every(([key, value]) => {
              if (typeof value === 'object' && value !== null && '$exists' in value) {
                return (row[key] !== undefined) === Boolean(value.$exists);
              }
              return row[key]?.toString() === value?.toString();
            })
          ) {
            Object.assign(row, update.$set);
          }
        }
      },
    };
  }
}
