import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import { IdempotencyService } from '../src/core/idempotency/idempotency.service';
import { migration011Stage6Leads } from '../src/migrations/011-stage6-leads';
import { LeadRepository } from '../src/modules/leads/lead.repository';
import type { LeadDocument } from '../src/modules/leads/lead.types';
import {
  Permissions,
  systemPermissionProfiles,
} from '../src/modules/permissions/permission.registry';

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
    workspaces: {},
    permissions: {},
    subscriptions: {},
    database: { async ping() {} },
    credentialDigests: {
      hashHighEntropySecret: (value: string) => createHash('sha256').update(value).digest('hex'),
    },
  } as never;
}

function convertPayload() {
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
