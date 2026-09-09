import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import { IdempotencyService } from '../src/core/idempotency/idempotency.service';
import { migration011Stage6Leads } from '../src/migrations/011-stage6-leads';
import { AuthApplicationService } from '../src/modules/auth/auth.service';
import { LeadRepository } from '../src/modules/leads/lead.repository';
import { LeadApplicationService } from '../src/modules/leads/lead.service';
import type { ConvertLeadInput, LeadDocument } from '../src/modules/leads/lead.types';
import {
  Permissions,
  systemPermissionProfiles,
} from '../src/modules/permissions/permission.registry';
import { SubscriptionApplicationService } from '../src/modules/subscriptions/subscription.service';
import { WorkspaceApplicationService } from '../src/modules/workspaces/workspace.service';
import type { InvitationDocument } from '../src/modules/workspaces/workspace.types';

describe('Stage 6 permission registry', () => {
  test('adds duplicate, merge, and Sales/Lead Admin platform defaults', () => {
    expect(Permissions.LeadsMarkDuplicate).toBe('leads.mark_duplicate');
    expect(Permissions.LeadsMerge).toBe('leads.merge');
    const sales = systemPermissionProfiles.find(
      (profile) => profile.roleKey === 'SALES_LEAD_ADMIN',
    );
    expect(sales).toMatchObject({ context: 'PLATFORM', name: 'Sales/Lead Admin' });
    expect(sales?.permissions.map((entry) => entry.permission)).toEqual([
      Permissions.LeadsRead,
      Permissions.LeadsUpdate,
      Permissions.LeadsConvert,
      Permissions.LeadsMarkDuplicate,
      Permissions.LeadsMerge,
    ]);
  });
});

describe('Stage 6 migration 011', () => {
  test('creates non-unique lead indexes and additive lead permission/profile seeds', async () => {
    const db = new FakeMigrationDb();
    await migration011Stage6Leads.up(db as never);

    const leadIndexes = db.indexes.leads ?? [];
    expect(leadIndexes.map((index) => index.name)).toEqual([
      'leads_status_created',
      'leads_normalized_phone',
      'leads_normalized_email',
    ]);
    expect(leadIndexes.some((index) => index.unique)).toBe(false);
    expect(db.permissionDefinitions.map((item) => item.key)).toEqual([
      'leads.mark_duplicate',
      'leads.merge',
    ]);
    expect(db.permissionProfiles.map((item) => item.roleKey)).toContain('SALES_LEAD_ADMIN');
  });
});

describe('Stage 6 lead repository lifecycle', () => {
  test('converts only from approved source states and never from ON_HOLD or LOST', async () => {
    for (const status of ['NEW', 'CONTACTED', 'QUALIFIED'] as const) {
      const repository = repositoryWithLead(leadFixture({ status }));
      await expect(
        repository.convert(repository.collection.document._id, 0, new ObjectId(), new ObjectId()),
      ).resolves.toMatchObject({ status: 'CONVERTED', version: 1 });
    }

    for (const status of ['ON_HOLD', 'LOST', 'DUPLICATE', 'CONVERTED'] as const) {
      const repository = repositoryWithLead(leadFixture({ status }));
      await expect(
        repository.convert(repository.collection.document._id, 0, new ObjectId(), new ObjectId()),
      ).rejects.toMatchObject({ code: 'LEAD_CONVERSION_INVALID' });
    }
  });

  test('metadata updates reject converted and duplicate leads', async () => {
    for (const status of ['CONVERTED', 'DUPLICATE'] as const) {
      const repository = repositoryWithLead(leadFixture({ status }));
      await expect(
        repository.updateMetadata(repository.collection.document._id, 0, { notes: 'new' }),
      ).rejects.toMatchObject({ code: 'LEAD_VERSION_CONFLICT' });
    }
  });

  test('mark duplicate preserves previous status and merge writes only the source linkage', async () => {
    const source = leadFixture({ status: 'QUALIFIED' });
    const repository = repositoryWithLead(source);
    const targetId = new ObjectId();
    const updated = await repository.markDuplicate(source._id, 0, new ObjectId(), {
      mergedIntoLeadId: targetId,
    });

    expect(updated).toMatchObject({
      status: 'DUPLICATE',
      duplicatePreviousStatus: 'QUALIFIED',
      mergedIntoLeadId: targetId,
      version: 1,
    });
    expect(updated.email).toBe(source.email);
  });

  test('merge target guard enforces targetExpectedVersion and rejects duplicate targets', async () => {
    const target = leadFixture({ status: 'QUALIFIED', version: 5 });
    const repository = repositoryWithLead(target);

    await expect(repository.guardMergeTarget(target._id, 4)).rejects.toMatchObject({
      code: 'LEAD_MERGE_TARGET_VERSION_CONFLICT',
    });

    const guarded = await repository.guardMergeTarget(target._id, 5);
    expect(guarded).toMatchObject({ status: 'QUALIFIED', version: 6 });

    const duplicateTarget = repositoryWithLead(leadFixture({ status: 'DUPLICATE', version: 2 }));
    await expect(
      duplicateTarget.guardMergeTarget(duplicateTarget.collection.document._id, 2),
    ).rejects.toMatchObject({ code: 'LEAD_MERGE_TARGET_VERSION_CONFLICT' });
  });

  test('duplicate correction restores only the recorded previous status', async () => {
    const repository = repositoryWithLead(
      leadFixture({ status: 'DUPLICATE', duplicatePreviousStatus: 'CONTACTED' }),
    );

    await expect(
      repository.correctDuplicate(repository.collection.document._id, 0, 'QUALIFIED'),
    ).rejects.toMatchObject({ code: 'LEAD_DUPLICATE_CORRECTION_INVALID' });

    const corrected = await repository.correctDuplicate(
      repository.collection.document._id,
      0,
      'CONTACTED',
    );
    expect(corrected.status).toBe('CONTACTED');
    expect(corrected.mergedIntoLeadId).toBeUndefined();
  });
});

describe('Stage 6 route metadata', () => {
  test('platform lead routes call central access control and idempotency only where locked', async () => {
    const ids = idsFixture();
    const calls: string[] = [];
    const idempotent: string[] = [];
    const app = await buildApp(
      routeContainer(ids, {
        async authorize(_ctx: unknown, input: { permission: string }) {
          calls.push(input.permission);
          return { allowed: true };
        },
        leads: {
          async listLeads() {
            return { data: [], meta: { nextCursor: null, hasMore: false } };
          },
          async convert() {
            return {};
          },
        },
        idempotency: {
          async runInTransaction(
            _ctx: unknown,
            input: { routeKey: string; operation: (tx: unknown) => Promise<unknown> },
          ) {
            idempotent.push(input.routeKey);
            return { statusCode: 200, body: await input.operation({}), replayed: false };
          },
        },
      }),
    );

    await app.inject({
      method: 'GET',
      url: '/api/v1/platform/leads',
      headers: { authorization: 'Bearer valid' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/platform/leads/${new ObjectId().toHexString()}/convert`,
      headers: { authorization: 'Bearer valid', 'idempotency-key': 'convert' },
      payload: convertPayload(),
    });

    expect(calls).toEqual([Permissions.LeadsRead, Permissions.LeadsConvert]);
    expect(idempotent).toEqual(['POST /platform/leads/:leadId/convert']);
    await app.close();
  });
});

describe('Stage 6 public owner activation idempotency', () => {
  test('supports server-derived public idempotency actors', async () => {
    const collection = new FakeIdempotencyCollection();
    const service = new IdempotencyService({ db: { collection: () => collection } } as never);
    let executions = 0;

    const first = await service.runInTransactionForActor('owner-activation:abc', {
      key: 'activation-key',
      routeKey: 'POST /public/owner-activations/complete',
      fingerprint: { body: { token: 'secret' } },
      unitOfWork: {
        withTransaction: async (operation: (tx: unknown) => Promise<unknown>) =>
          await operation({}),
      } as never,
      operation: async () => {
        executions += 1;
        return { body: { success: true } };
      },
    });
    const replay = await service.runInTransactionForActor('owner-activation:abc', {
      key: 'activation-key',
      routeKey: 'POST /public/owner-activations/complete',
      fingerprint: { body: { token: 'secret' } },
      unitOfWork: {
        withTransaction: async (operation: (tx: unknown) => Promise<unknown>) =>
          await operation({}),
      } as never,
      operation: async () => ({ body: { success: false } }),
    });

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual({ success: true });
    expect(executions).toBe(1);
    await expect(
      service.runInTransactionForActor('owner-activation:abc', {
        key: 'activation-key',
        routeKey: 'POST /public/owner-activations/complete',
        fingerprint: { body: { token: 'other' } },
        unitOfWork: { withTransaction: async () => ({}) } as never,
        operation: async () => ({ body: {} }),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  test('stores token-free replay bodies for conversion while returning first response secrets', async () => {
    const ids = idsFixture();
    const collection = new FakeIdempotencyCollection();
    const app = await buildApp(
      routeContainer(ids, {
        async authorize() {
          return { allowed: true };
        },
        leads: {
          async convert() {
            return {
              lead: { id: 'lead-id' },
              ownerInvitation: { id: 'invitation-id', token: 'raw-activation-token' },
            };
          },
        },
        idempotency: new IdempotencyService({ db: { collection: () => collection } } as never),
        unitOfWork: {
          withTransaction: async (operation: (tx: unknown) => Promise<unknown>) =>
            await operation({}),
        },
      }),
    );

    const leadId = new ObjectId().toHexString();
    const payload = convertPayload();
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/platform/leads/${leadId}/convert`,
      headers: { authorization: 'Bearer valid', 'idempotency-key': 'convert-secret' },
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/platform/leads/${leadId}/convert`,
      headers: { authorization: 'Bearer valid', 'idempotency-key': 'convert-secret' },
      payload,
    });

    expect(first.json().data.ownerInvitation.token).toBe('raw-activation-token');
    expect(replay.json().data.ownerInvitation.token).toBeUndefined();
    expect(JSON.stringify(collection.documents)).not.toContain('raw-activation-token');
    await app.close();
  });
});

describe('Stage 6 commercial and activation fixes', () => {
  test('startTrial validates a transactionally created workspace using the supplied transaction', async () => {
    const tx = { session: {} };
    const workspaceId = new ObjectId();
    const planVersionId = new ObjectId();
    const service = subscriptionServiceWith({
      workspaces: {
        async findById(id: ObjectId, seenTx?: unknown) {
          return id.equals(workspaceId) && seenTx === tx ? { _id: workspaceId } : null;
        },
      },
      plans: {
        async findVersionWithPlan(id: ObjectId, seenTx?: unknown) {
          expect(seenTx).toBe(tx);
          return {
            plan: { _id: new ObjectId(), active: true },
            version: {
              _id: id,
              billingOptions: ['MONTHLY'],
              defaultLimits: { activeStaff: 2, storageBytes: 100 },
              features: { leads: true },
              trialDefaults: { days: 7 },
            },
          };
        },
      },
      subscriptions: {
        async ensurePendingActivation(id: ObjectId, _now: Date, seenTx?: unknown) {
          expect(seenTx).toBe(tx);
          return {
            _id: new ObjectId(),
            workspaceId: id,
            lifecycleStatus: 'PENDING_ACTIVATION',
            version: 0,
          };
        },
        async attachTerms(
          _workspaceId: ObjectId,
          _expectedVersion: number,
          _allowed: string[],
          term: Record<string, unknown>,
          status: string,
          patch: Record<string, unknown>,
          _unset: string[],
          seenTx?: unknown,
        ) {
          expect(seenTx).toBe(tx);
          expect(status).toBe('TRIAL');
          expect(term.planVersionId).toEqual(planVersionId);
          expect(patch.expiresAt).toBeInstanceOf(Date);
          return {
            subscription: {
              _id: new ObjectId(),
              workspaceId,
              lifecycleStatus: 'TRIAL',
              currentTermsId: new ObjectId(),
              version: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            terms: { _id: new ObjectId(), workspaceId, ...term },
          };
        },
      },
    });

    await expect(
      service.startTrial(
        platformCtx(),
        workspaceId.toHexString(),
        {
          expectedVersion: 0,
          planVersionId: planVersionId.toHexString(),
          billingPeriod: 'MONTHLY',
          effectiveFrom: new Date().toISOString(),
        },
        tx as never,
      ),
    ).resolves.toBeTruthy();
  });

  test('pending owner activation starts a trial from persisted V1 intent, not a later plan version', async () => {
    const tx = { session: {} };
    const workspaceId = new ObjectId();
    const subscriptionId = new ObjectId();
    const v1 = new ObjectId();
    const v2 = new ObjectId();
    const service = subscriptionServiceWith({
      plans: {
        async findVersionWithPlan(id: ObjectId) {
          expect(id).toEqual(v1);
          expect(id).not.toEqual(v2);
          return {
            plan: { _id: new ObjectId(), active: true },
            version: {
              _id: v1,
              billingOptions: ['MONTHLY'],
              defaultLimits: { activeStaff: 3, storageBytes: 100 },
              features: { leads: true },
              trialDefaults: { days: 11 },
            },
          };
        },
      },
      subscriptions: {
        async ensurePendingActivation() {
          return {
            _id: subscriptionId,
            workspaceId,
            lifecycleStatus: 'PENDING_ACTIVATION',
            version: 4,
            pendingActivationIntent: {
              startMode: 'PENDING_ACTIVATION',
              activationStartMode: 'TRIAL',
              planVersionId: v1,
              billingPeriod: 'MONTHLY',
              limits: { activeStaff: 3, storageBytes: 100 },
              enabledFeatures: ['leads'],
              createdBy: new ObjectId(),
              createdAt: new Date(),
            },
          };
        },
        async attachTerms(
          _workspaceId: ObjectId,
          expectedVersion: number,
          _allowed: string[],
          term: Record<string, unknown>,
          status: string,
          patch: Record<string, unknown>,
        ) {
          expect(expectedVersion).toBe(4);
          expect(status).toBe('TRIAL');
          expect(term.planVersionId).toEqual(v1);
          expect(term.source).toBe('TRIAL');
          expect(term.effectiveTo).toBeInstanceOf(Date);
          expect(patch.startedAt).toBeInstanceOf(Date);
          expect(patch.expiresAt).toBeInstanceOf(Date);
          return {
            subscription: {
              _id: subscriptionId,
              workspaceId,
              lifecycleStatus: 'TRIAL',
              currentTermsId: new ObjectId(),
              version: 5,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            terms: { _id: new ObjectId(), workspaceId, ...term },
          };
        },
      },
    });

    await expect(
      service.activatePendingIntentOnOwnerActivation(platformCtx(), workspaceId, tx as never),
    ).resolves.toMatchObject({ subscription: { lifecycleStatus: 'TRIAL' } });
  });

  test('conversion effectiveFrom is a commercial override while standard conversion is lead-only', async () => {
    const ctx = platformCtx();
    const calls: string[] = [];
    const service = leadServiceWithAccess({
      async authorize(_ctx: unknown, input: { permission: string }) {
        calls.push(input.permission);
      },
    });

    await expect(
      service.convert(ctx, new ObjectId().toHexString(), convertPayload(), {} as never),
    ).rejects.toBeTruthy();
    expect(calls).not.toContain(Permissions.SubscriptionsChangeTerms);

    await expect(
      service.convert(
        ctx,
        new ObjectId().toHexString(),
        {
          ...convertPayload(),
          subscription: {
            ...convertPayload().subscription,
            startMode: 'TRIAL',
            effectiveFrom: '2026-01-01T00:00:00.000Z',
          },
        },
        {} as never,
      ),
    ).rejects.toBeTruthy();
    expect(calls).toContain(Permissions.SubscriptionsChangeTerms);

    await expect(
      service.convert(
        ctx,
        new ObjectId().toHexString(),
        {
          ...convertPayload(),
          subscription: {
            ...convertPayload().subscription,
            effectiveFrom: '2026-01-01T00:00:00.000Z',
          },
        },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_EFFECTIVE_FROM_UNSUPPORTED' });
  });
});

describe('Stage 6 pending owner identity safety', () => {
  test('pending activation users cannot login and missing hashes never reach the verifier', async () => {
    const service = authServiceWith({
      identity: {
        async findByLoginIdentifier() {
          return {
            _id: new ObjectId(),
            status: 'PENDING_ACTIVATION',
            firstName: 'Pending',
            lastName: 'Owner',
            preferredLanguage: 'en',
            timezone: 'Africa/Cairo',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
      passwordHasher: {
        async verify() {
          throw new Error('password verifier should not be called');
        },
      },
    });

    await expect(
      service.login({
        identifier: 'owner@example.com',
        password: 'password-123',
        clientType: 'API',
        metadata: { ipAddress: '127.0.0.1' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});

describe('Stage 6 owner activation shared primitive', () => {
  test('quota failure stops owner activation before membership, invitation, and workspace activation writes', async () => {
    const tx = { session: {} };
    const workspaceId = new ObjectId();
    const userId = new ObjectId();
    const invitation = ownerActivationInvitation(workspaceId, userId);
    const calls: string[] = [];
    const service = workspaceServiceWith({
      invitations: {
        async findPendingByDigest(digest: string, _now: Date, seenTx?: unknown) {
          expect(digest).toBe(invitation.tokenDigest);
          expect(seenTx).toBe(tx);
          return invitation;
        },
        async acceptPending() {
          calls.push('accept-invitation');
        },
      },
      workspaces: {
        async findById(id: ObjectId, seenTx?: unknown) {
          expect(id).toEqual(workspaceId);
          expect(seenTx).toBe(tx);
          return { _id: workspaceId, ownerUserId: userId, status: 'PENDING_ACTIVATION' };
        },
        async activatePending() {
          calls.push('activate-workspace');
        },
      },
      memberships: {
        async findByUserInWorkspace(id: ObjectId, seenUserId: ObjectId, seenTx?: unknown) {
          expect(id).toEqual(workspaceId);
          expect(seenUserId).toEqual(userId);
          expect(seenTx).toBe(tx);
          return {
            _id: new ObjectId(),
            workspaceId,
            userId,
            status: 'INVITED',
            roles: ['GYM_OWNER'],
          };
        },
        async activateInvitedOwner() {
          calls.push('activate-membership');
        },
      },
      subscriptions: {
        async activatePendingIntentOnOwnerActivation(
          _ctx: unknown,
          id: ObjectId,
          seenTx?: unknown,
        ) {
          expect(id).toEqual(workspaceId);
          expect(seenTx).toBe(tx);
          calls.push('stage-trial-transition');
          return { subscription: { lifecycleStatus: 'TRIAL' } };
        },
      },
      entitlements: {
        async assertAndReserveStaffSlot(id: ObjectId, seenTx?: unknown) {
          expect(id).toEqual(workspaceId);
          expect(seenTx).toBe(tx);
          calls.push('reserve-staff');
          throw new Error('quota exhausted');
        },
      },
    });

    await expect(
      service.completeOwnerActivation(platformCtx(), invitation, userId, tx as never),
    ).rejects.toThrow('quota exhausted');
    expect(calls).toEqual(['stage-trial-transition', 'reserve-staff']);
  });
});

function repositoryWithLead(lead: LeadDocument) {
  const collection = new FakeLeadCollection(lead);
  const repository = new LeadRepository({
    db: { collection: () => collection },
  } as never) as LeadRepository & {
    collection: FakeLeadCollection;
  };
  repository.collection = collection;
  return repository;
}

function leadFixture(input: Partial<LeadDocument> = {}): LeadDocument {
  const now = new Date();
  return {
    _id: new ObjectId(),
    customerInterest: 'GYM',
    gymName: 'Titan Gym',
    contactPerson: 'Ahmed',
    phone: '+201000000000',
    normalizedPhone: '+201000000000',
    email: 'owner@example.com',
    normalizedEmail: 'owner@example.com',
    status: 'NEW',
    createdAt: now,
    updatedAt: now,
    version: 0,
    ...input,
  };
}

class FakeLeadCollection {
  constructor(public document: LeadDocument) {}

  async insertOne(document: LeadDocument) {
    this.document = document;
  }

  find() {
    return {
      sort: () => ({ limit: () => ({ toArray: async () => [this.document] }) }),
      limit: () => ({ toArray: async () => [this.document] }),
    };
  }

  async findOne(filter: Record<string, unknown>) {
    return matches(this.document, filter) ? this.document : null;
  }

  async findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>) {
    if (!matches(this.document, filter)) return null;
    if (update.$set) Object.assign(this.document, update.$set);
    if (update.$unset) {
      for (const key of Object.keys(update.$unset as Record<string, unknown>)) {
        delete (this.document as unknown as Record<string, unknown>)[key];
      }
    }
    const versionIncrement = (update.$inc as Record<string, number> | undefined)?.version;
    if (versionIncrement) {
      this.document.version += versionIncrement;
    }
    return this.document;
  }
}

function matches(document: LeadDocument, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, value]) => {
    const actual = (document as unknown as Record<string, unknown>)[key];
    if (value && typeof value === 'object' && '$nin' in value) {
      return !(value.$nin as unknown[]).includes(actual);
    }
    if (value && typeof value === 'object' && '$in' in value) {
      return (value.$in as unknown[]).includes(actual);
    }
    if (value && typeof value === 'object' && '$ne' in value) {
      return actual !== value.$ne;
    }
    return actual?.toString() === value?.toString();
  });
}

class FakeMigrationDb {
  indexes: Record<string, Array<Record<string, unknown>>> = { leads: [] };
  permissionDefinitions: Array<Record<string, unknown>> = [];
  permissionProfiles: Array<Record<string, unknown>> = [];

  collection(name: string) {
    return {
      createIndexes: async (indexes: Array<Record<string, unknown>>) => {
        this.indexes[name] = indexes;
      },
      updateOne: async (
        filter: Record<string, unknown>,
        update: { $set: Record<string, unknown>; $setOnInsert?: Record<string, unknown> },
      ) => {
        const target =
          name === 'permission_definitions' ? this.permissionDefinitions : this.permissionProfiles;
        const existing = target.find((item) =>
          Object.entries(filter).every(([key, value]) => item[key] === value),
        );
        if (existing) Object.assign(existing, update.$set);
        else target.push({ ...filter, ...update.$setOnInsert, ...update.$set });
      },
    };
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
}

function idsFixture() {
  return { userId: new ObjectId(), sessionId: new ObjectId() };
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
        return {
          sub: ids.userId.toHexString(),
          sid: ids.sessionId.toHexString(),
          jti: 'jwt-id',
          iat: 1,
          exp: Date.now() + 60_000,
          amr: ['pwd'],
        };
      },
    },
    authSessions: {
      async findActive() {
        return {
          _id: ids.sessionId,
          userId: ids.userId,
          status: 'ACTIVE',
          authenticationMethods: ['pwd'],
          mfaSatisfiedAt: new Date(),
          restrictedUntilVerified: false,
        };
      },
    },
    auth: {},
    accessControl: input,
    leads: input.leads,
    idempotency: input.idempotency,
    unitOfWork: input.unitOfWork,
    workspaces: {},
    permissions: {},
    subscriptions: {},
    database: { async ping() {} },
    credentialDigests: {
      hashHighEntropySecret: (value: string) => createHash('sha256').update(value).digest('hex'),
    },
  } as never;
}

function convertPayload(): ConvertLeadInput {
  return {
    expectedVersion: 0,
    workspaceType: 'GYM',
    workspace: { name: 'Titan', timezone: 'Africa/Cairo' },
    subscription: {
      planVersionId: new ObjectId().toHexString(),
      billingPeriod: 'MONTHLY',
      startMode: 'PENDING_ACTIVATION',
    },
    owner: { email: 'owner@example.com', phone: '+201000000000' },
  };
}

function platformCtx() {
  return {
    userId: new ObjectId().toHexString(),
    authSessionId: new ObjectId().toHexString(),
    platformMembershipId: new ObjectId().toHexString(),
    mfaSatisfied: true,
    ipAddress: '127.0.0.1',
    correlationId: new ObjectId().toHexString(),
    locale: 'en',
    timezone: 'Africa/Cairo',
  };
}

function subscriptionServiceWith(overrides: {
  plans?: Record<string, unknown>;
  subscriptions?: Record<string, unknown>;
  workspaces?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}) {
  return new SubscriptionApplicationService(
    {
      subscriptions: { trialExpiryAction: 'FROZEN' },
    } as never,
    {
      withTransaction: async (operation: (tx: unknown) => Promise<unknown>) => await operation({}),
    } as never,
    (overrides.plans ?? {}) as never,
    (overrides.subscriptions ?? {}) as never,
    (overrides.usage ?? { async ensure() {} }) as never,
    {} as never,
    (overrides.workspaces ?? {
      async findById() {
        return { _id: new ObjectId() };
      },
    }) as never,
    {} as never,
    { async write() {} } as never,
    { async write() {} } as never,
  );
}

function leadServiceWithAccess(accessControl: Record<string, unknown>) {
  return new LeadApplicationService(
    {
      withTransaction: async (operation: (tx: unknown) => Promise<unknown>) => await operation({}),
    } as never,
    {
      async findById() {
        return null;
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    accessControl as never,
    {} as never,
    {} as never,
    {} as never,
    { async write() {} } as never,
    { async write() {} } as never,
  );
}

function authServiceWith(overrides: {
  identity?: Record<string, unknown>;
  passwordHasher?: Record<string, unknown>;
}) {
  return new AuthApplicationService(
    {
      auth: {
        loginIpWindowMs: 60_000,
        loginIpMaxAttempts: 10,
        loginIdentifierIpWindowMs: 60_000,
        loginIdentifierIpMaxAttempts: 10,
        loginIdentifierIpBlockMs: 60_000,
        passwordResetIdentifierMaxPerHour: 10,
        passwordResetIpMaxPerHour: 10,
        challengeMaxSendsPerHour: 10,
        mfaChallengeMaxAttempts: 5,
        challengeResendCooldownSeconds: 0,
        challengeTtlSeconds: 300,
        mfaChallengeTtlSeconds: 300,
        challengeMaxAttempts: 5,
        refreshTokenTtlSeconds: 3600,
        recoveryCodeCount: 10,
      },
      env: 'test',
    } as never,
    {
      withTransaction: async (operation: (tx: unknown) => Promise<unknown>) => await operation({}),
    } as never,
    (overrides.identity ?? {}) as never,
    { async create() {} } as never,
    {} as never,
    {
      async findActiveTotp() {
        return null;
      },
    } as never,
    {
      async incrementBucket() {
        return { count: 1, expiresAt: new Date(), windowStartedAt: new Date() };
      },
    } as never,
    { async write() {} } as never,
    {
      async hash() {
        return 'hash';
      },
      ...(overrides.passwordHasher ?? {}),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function ownerActivationInvitation(workspaceId: ObjectId, userId: ObjectId): InvitationDocument {
  const now = new Date();
  return {
    _id: new ObjectId(),
    workspaceId,
    type: 'OWNER_ACTIVATION',
    email: 'owner@example.com',
    normalizedEmail: 'owner@example.com',
    intendedRoles: ['GYM_OWNER'],
    branchIds: [],
    invitedBy: userId,
    tokenDigest: 'owner-token-digest',
    status: 'PENDING',
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    updatedAt: now,
  };
}

function workspaceServiceWith(overrides: {
  invitations?: Record<string, unknown>;
  workspaces?: Record<string, unknown>;
  memberships?: Record<string, unknown>;
  subscriptions?: Record<string, unknown>;
  entitlements?: Record<string, unknown>;
}) {
  return new WorkspaceApplicationService(
    {
      withTransaction: async (operation: (tx: unknown) => Promise<unknown>) => await operation({}),
    } as never,
    {
      async findById() {
        return {
          _id: new ObjectId(),
          status: 'ACTIVE',
          firstName: 'Owner',
          lastName: 'User',
          preferredLanguage: 'en',
          timezone: 'Africa/Cairo',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    } as never,
    {} as never,
    (overrides.workspaces ?? {}) as never,
    (overrides.memberships ?? {}) as never,
    {} as never,
    {} as never,
    (overrides.invitations ?? {}) as never,
    {} as never,
    { async write() {} } as never,
    { async write() {} } as never,
    (overrides.entitlements ?? {}) as never,
    (overrides.subscriptions ?? {}) as never,
  );
}
