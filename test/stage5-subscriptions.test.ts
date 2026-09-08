import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import { AppError } from '../src/core/errors/app-error';
import { IdempotencyService } from '../src/core/idempotency/idempotency.service';
import { migration009Stage5ExistingWorkspaceBackfill } from '../src/migrations/009-stage5-existing-workspace-backfill';
import {
  Permissions,
  systemPermissionProfiles,
} from '../src/modules/permissions/permission.registry';
import { WorkspaceUsageRepository } from '../src/modules/subscriptions/subscription.repository';
import { EntitlementService } from '../src/modules/subscriptions/subscription.service';
import type {
  SubscriptionDocument,
  SubscriptionTermDocument,
  WorkspaceUsageDocument,
} from '../src/modules/subscriptions/subscription.types';

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
    };
  }
}
