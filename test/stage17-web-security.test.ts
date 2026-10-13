import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import { type AppContainer, createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { FakeStorageProvider } from '../src/core/storage/fake-storage.provider';
import { migrations } from '../src/migrations';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { Permissions } from '../src/modules/permissions/permission.registry';

let container: AppContainer;
let app: FastifyInstance;
beforeAll(async () => {
  container = await createAppContainer(integrationConfig(`web023_${new ObjectId()}`));
  await new MigrationRunner(container.database.db, migrations).migrate();
  app = await buildApp(container);
}, 30_000);
afterEach(async () => {
  for (const collection of await container.database.db.listCollections().toArray()) {
    if (collection.name !== 'db_migrations')
      await container.database.db.collection(collection.name).deleteMany({});
  }
});
afterAll(async () => {
  await app?.close();
  if (container) {
    await container.database.db.dropDatabase();
    await container.database.close();
  }
});

async function fixture() {
  const userId = new ObjectId(),
    workspaceId = new ObjectId(),
    workspaceMembershipId = new ObjectId(),
    platformMembershipId = new ObjectId();
  const workspaceProfileId = new ObjectId(),
    platformProfileId = new ObjectId(),
    subscriptionId = new ObjectId(),
    deletionId = new ObjectId();
  const now = new Date();
  const db = container.database.db;
  await db.collection('users').insertOne({
    _id: userId,
    status: 'ACTIVE',
    firstName: 'Test',
    lastName: 'Operator',
    preferredLanguage: 'en',
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('workspaces').insertOne({
    _id: workspaceId,
    name: 'Export target',
    type: 'GYM',
    status: 'ACTIVE',
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
    ownerUserId: userId,
    version: 0,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('workspace_memberships').insertOne({
    _id: workspaceMembershipId,
    workspaceId,
    userId,
    roles: ['GYM_OWNER'],
    status: 'ACTIVE',
    permissionProfileIds: [workspaceProfileId],
    accessVersion: 0,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('platform_memberships').insertOne({
    _id: platformMembershipId,
    userId,
    status: 'ACTIVE',
    permissionProfileIds: [platformProfileId],
    accessVersion: 0,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('permission_profiles').insertMany([
    {
      _id: workspaceProfileId,
      context: 'WORKSPACE',
      workspaceId,
      name: `exports-${workspaceProfileId}`,
      status: 'ACTIVE',
      permissions: [
        Permissions.ExportsWorkspaceCreate,
        Permissions.ExportsWorkspaceRead,
        Permissions.ExportsWorkspaceDownload,
      ].map((permission) => ({ permission, effect: 'ALLOW' })),
      version: 0,
      createdAt: now,
    },
    {
      _id: platformProfileId,
      context: 'PLATFORM',
      name: `deletion-${platformProfileId}`,
      status: 'ACTIVE',
      permissions: [
        Permissions.DeletionRead,
        Permissions.DeletionApprove,
        Permissions.DeletionPostpone,
        Permissions.DeletionCancel,
      ].map((permission) => ({ permission, effect: 'ALLOW' })),
      version: 0,
      createdAt: now,
    },
  ]);
  const expiredAt = new Date('2025-01-01T00:00:00Z');
  await db.collection('subscriptions').insertOne({
    _id: subscriptionId,
    workspaceId,
    lifecycleStatus: 'EXPIRED',
    expiredAt,
    version: 0,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('workspace_deletion_requests').insertOne({
    _id: deletionId,
    workspaceId,
    subscriptionId,
    subscriptionVersionAtEligibility: 0,
    eligibilityBasis: { expiredAt, eligibilityAt: new Date('2025-06-30T00:00:00Z') },
    status: 'PENDING_APPROVAL',
    createdActor: { type: 'SYSTEM' },
    createdAt: now,
    updatedAt: now,
    version: 0,
    processingAttemptCount: 0,
    checkpoints: [],
    retainedPaymentProofFileIds: [],
    workspaceSnapshot: { name: 'Export target', type: 'GYM' },
  });
  const session = await container.authSessions.create({
    userId,
    authenticationMethods: ['pwd'],
    restrictedUntilVerified: false,
    mfaSatisfiedAt: now,
    ipAddress: '127.0.0.1',
    clientType: 'API',
    transport: 'JSON',
    expiresAt: new Date(now.getTime() + 3_600_000),
  });
  const token = container.jwt.createAccessToken({
    userId: userId.toHexString(),
    authSessionId: session._id.toHexString(),
    authenticationMethods: ['pwd'],
  });
  const headers = {
    authorization: `Bearer ${token}`,
    'idempotency-key': new ObjectId().toHexString(),
  };
  return {
    userId,
    workspaceId,
    workspaceMembershipId,
    platformMembershipId,
    workspaceProfileId,
    platformProfileId,
    subscriptionId,
    deletionId,
    authId: session._id,
    headers,
    exportsUrl: `/api/v1/workspaces/${workspaceId}/exports`,
    deletionUrl: `/api/v1/platform/workspace-deletions/${deletionId}`,
    approvalBody: { expectedVersion: 0, reason: 'Retention review approved' },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function supportSelector(f: Fixture) {
  const db = container.database.db,
    now = new Date(),
    policyId = new ObjectId(),
    sessionId = new ObjectId();
  const profile = await db.collection('permission_profiles').findOne({ _id: f.platformProfileId });
  if (!profile) throw new Error('Platform profile is missing');
  await db.collection('permission_profiles').updateOne(
    { _id: f.platformProfileId },
    {
      $set: {
        permissions: [
          ...profile.permissions,
          { permission: Permissions.SupportSessionsStart, effect: 'ALLOW' },
        ],
      },
    },
  );
  await db.collection('portal_access_policies').insertOne({
    _id: policyId,
    platformMembershipId: f.platformMembershipId,
    allowedTargetTypes: ['GYM'],
    allowedWorkspaceIds: [f.workspaceId],
    allowedIpRanges: ['127.0.0.1'],
    allowedSessionTypes: ['READ_ONLY'],
    maxSessionDurationMinutes: 60,
    notificationRequired: false,
    allowSensitiveData: false,
    allowSensitiveFileDownload: false,
    enabled: true,
    revision: 0,
    createdBy: f.userId,
    createdAt: now,
  });
  await db.collection('support_sessions').insertOne({
    _id: sessionId,
    requestId: new ObjectId(),
    policyId,
    policyRevision: 0,
    realActorUserId: f.userId,
    realActorPlatformMembershipId: f.platformMembershipId,
    parentAuthSessionId: f.authId,
    targetType: 'GYM',
    targetWorkspaceId: f.workspaceId,
    contextType: 'WORKSPACE_SUPPORT',
    sessionType: 'READ_ONLY',
    sourceIp: '127.0.0.1',
    reason: 'Investigate reported problem',
    notificationRequired: false,
    allowSensitiveData: false,
    allowSensitiveFileDownload: false,
    startedAt: now,
    expiresAt: new Date(now.getTime() + 1_800_000),
    status: 'ACTIVE',
    version: 0,
    createdAt: now,
    updatedAt: now,
  });
  return sessionId.toHexString();
}
const cache = (response: { headers: Record<string, unknown> }) =>
  expect(response.headers['cache-control']).toBe('private, no-store');
async function counts() {
  return await Promise.all(
    ['workspace_export_requests', 'audit_events', 'outbox_events', 'idempotency_records'].map(
      (name) => container.database.db.collection(name).countDocuments(),
    ),
  );
}
async function create(f: Fixture) {
  return await app.inject({ method: 'POST', url: f.exportsUrl, headers: f.headers });
}
async function approve(f: Fixture) {
  return await app.inject({
    method: 'POST',
    url: `${f.deletionUrl}/approve`,
    headers: f.headers,
    payload: f.approvalBody,
  });
}

describe('Stage 17 response boundary', () => {
  test('all nine success routes and implicit HEAD responses are no-store', async () => {
    const f = await fixture();
    const created = await create(f);
    expect(created.statusCode).toBe(200);
    cache(created);
    const exportId = created.json().data.export.id;
    for (const url of [
      f.exportsUrl,
      `${f.exportsUrl}/${exportId}`,
      '/api/v1/platform/workspace-deletions',
      f.deletionUrl,
    ]) {
      for (const method of ['GET', 'HEAD'] as const) {
        const response = await app.inject({ method, url, headers: f.headers });
        expect(response.statusCode).toBe(200);
        cache(response);
        if (method === 'HEAD') expect(response.body).toBe('');
      }
    }
    const fileId = new ObjectId();
    await container.database.db.collection('workspace_export_requests').updateOne(
      { _id: new ObjectId(exportId) },
      {
        $set: {
          status: 'READY',
          artifactFileId: fileId,
          expiresAt: new Date(Date.now() + 300_000),
        },
      },
    );
    await container.database.db.collection('files').insertOne({
      _id: fileId,
      workspaceId: f.workspaceId,
      origin: 'SYSTEM_GENERATED',
      generatedPurpose: 'WORKSPACE_EXPORT',
      generatedForExportId: new ObjectId(exportId),
      status: 'ACTIVE',
      storageKey: 'private/export.zip',
      originalName: 'export.zip',
      mimeType: 'application/zip',
    });
    const signed = spyOn(container.storage, 'createDownloadUrl').mockImplementation(
      async (request) => ({ url: 'https://storage.test/signed', expiresAt: request.expiresAt }),
    );
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${f.exportsUrl}/${exportId}/download-url`,
        headers: f.headers,
      });
      expect(response.statusCode).toBe(200);
      cache(response);
      expect(signed.mock.calls[0]?.[0]).toMatchObject({
        cacheControl: 'private, no-store',
        expiresAtIsHardDeadline: true,
      });
    } finally {
      signed.mockRestore();
    }
    const postponed = await app.inject({
      method: 'POST',
      url: `${f.deletionUrl}/postpone`,
      headers: f.headers,
      payload: {
        expectedVersion: 0,
        reason: 'Review later',
        reviewAfter: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(postponed.statusCode).toBe(200);
    cache(postponed);
    const cancelled = await app.inject({
      method: 'POST',
      url: `${f.deletionUrl}/cancel`,
      headers: f.headers,
      payload: { expectedVersion: 1, reason: 'No longer requested' },
    });
    expect(cancelled.statusCode).toBe(200);
    cache(cancelled);
    await container.database.db
      .collection('workspace_deletion_requests')
      .updateOne({ _id: f.deletionId }, { $set: { status: 'PENDING_APPROVAL', version: 0 } });
    const approved = await approve(f);
    expect(approved.statusCode).toBe(200);
    cache(approved);
  });

  test('early authentication, validation, restriction, key, CAS, lifecycle and internal errors retain header', async () => {
    const f = await fixture();
    const unauth = await app.inject({ method: 'GET', url: `${f.exportsUrl}?limit=2` });
    expect(unauth.json().error.code).toBe('AUTH_REQUIRED');
    cache(unauth);
    const deletionAuth = await app.inject({ method: 'GET', url: f.deletionUrl });
    expect(deletionAuth.json().error.code).toBe('AUTH_REQUIRED');
    cache(deletionAuth);
    const validation = await app.inject({
      method: 'GET',
      url: `${f.exportsUrl}?limit=0`,
      headers: f.headers,
    });
    expect(validation.json().error.code).toBe('VALIDATION_FAILED');
    cache(validation);
    const missingKey = await app.inject({
      method: 'POST',
      url: f.exportsUrl,
      headers: { authorization: f.headers.authorization },
    });
    expect(missingKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    cache(missingKey);
    const cas = await app.inject({
      method: 'POST',
      url: `${f.deletionUrl}/cancel`,
      headers: f.headers,
      payload: { expectedVersion: 99, reason: 'Cancel' },
    });
    expect(cas.json().error.code).toBe('WORKSPACE_DELETION_VERSION_CONFLICT');
    cache(cas);
    const failure = spyOn(container.exports, 'list').mockRejectedValue(
      new Error('Injected internal failure'),
    );
    try {
      const response = await app.inject({ method: 'GET', url: f.exportsUrl, headers: f.headers });
      expect(response.json().error.code).toBe('INTERNAL_ERROR');
      cache(response);
    } finally {
      failure.mockRestore();
    }
    await container.database.db
      .collection('auth_sessions')
      .updateOne({ _id: f.authId }, { $set: { restrictedUntilVerified: true } });
    const restricted = await create(f);
    expect(restricted.json().error.code).toBe('AUTH_SESSION_RESTRICTED');
    cache(restricted);
  });

  test('canonical encoded routes retain boundary; unrelated paths stay isolated', async () => {
    const f = await fixture();
    const encoded = await app.inject({
      method: 'GET',
      url: f.exportsUrl.replace('/exports', '/%65xports'),
      headers: f.headers,
    });
    expect(encoded.statusCode).toBe(200);
    cache(encoded);
    for (const url of [
      '/health/live',
      '/api/v1/platform/workspace-deletions-extra',
      `${f.exportsUrl}/id/not-download-url`,
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.headers['cache-control']).toBeUndefined();
    }
  });
});

describe('export completed replay authorization', () => {
  test('returns exact historical ack without duplicate export/audit/outbox', async () => {
    const f = await fixture();
    const original = await create(f);
    expect(original.statusCode).toBe(200);
    const exportId = new ObjectId(original.json().data.export.id);
    await container.database.db
      .collection('workspace_export_requests')
      .updateOne({ _id: exportId }, { $set: { status: 'FAILED', version: 8 } });
    const before = await counts();
    const replay = await create(f);
    expect(replay.json()).toEqual(original.json());
    expect(await counts()).toEqual(before);
    cache(replay);
  });
  test.each(['permission', 'membership', 'removed', 'workspace', 'lock', 'subscription'] as const)(
    'denies after current %s changes without rewriting historical record',
    async (change) => {
      const f = await fixture();
      const original = await create(f);
      expect(original.statusCode).toBe(200);
      const db = container.database.db;
      const record = await db
        .collection('idempotency_records')
        .findOne({ key: f.headers['idempotency-key'] });
      if (!record) throw new Error('Original command did not store an acknowledgement');
      if (change === 'permission')
        await db
          .collection('permission_profiles')
          .updateOne({ _id: f.workspaceProfileId }, { $set: { permissions: [] } });
      if (change === 'membership')
        await db
          .collection('workspace_memberships')
          .updateOne({ _id: f.workspaceMembershipId }, { $set: { status: 'SUSPENDED' } });
      if (change === 'removed')
        await db.collection('workspace_memberships').deleteOne({ _id: f.workspaceMembershipId });
      if (change === 'workspace')
        await db
          .collection('workspaces')
          .updateOne({ _id: f.workspaceId }, { $set: { status: 'RESTRICTED' } });
      if (change === 'lock')
        await db
          .collection('workspaces')
          .updateOne({ _id: f.workspaceId }, { $set: { deletionLockRequestId: new ObjectId() } });
      if (change === 'subscription')
        await db
          .collection('subscriptions')
          .updateOne({ _id: f.subscriptionId }, { $set: { lifecycleStatus: 'CANCELLED' } });
      const expected = {
        permission: 'PERMISSION_DENIED',
        membership: 'WORKSPACE_MEMBERSHIP_REQUIRED',
        removed: 'WORKSPACE_NOT_FOUND',
        workspace: 'WORKSPACE_INACTIVE',
        lock: 'WORKSPACE_DELETION_LOCKED',
        subscription: 'EXPORT_NOT_ALLOWED_FOR_SUBSCRIPTION',
      }[change];
      const before = await counts();
      const denied = await create(f);
      expect(denied.json().error.code).toBe(expected);
      cache(denied);
      expect(denied.body).not.toContain(original.json().data.export.id);
      expect(await counts()).toEqual(before);
      expect(await db.collection('idempotency_records').findOne({ _id: record._id })).toEqual(
        record,
      );
    },
  );
  test.each(['', 'not-a-session', new ObjectId().toHexString()])(
    'support selector %s cannot disclose completed replay',
    async (selector) => {
      const f = await fixture();
      const original = await create(f);
      expect(original.statusCode).toBe(200);
      const before = await counts();
      const response = await app.inject({
        method: 'POST',
        url: f.exportsUrl,
        headers: { ...f.headers, 'x-support-session-id': selector },
      });
      expect([403, 422]).toContain(response.statusCode);
      expect(response.body).not.toContain(original.json().data.export.id);
      cache(response);
      expect(await counts()).toEqual(before);
    },
  );
});

describe('approval completed replay authorization', () => {
  test('resolved support cannot disclose either completed acknowledgement', async () => {
    const f = await fixture();
    const exported = await create(f);
    expect(exported.statusCode).toBe(200);
    const approved = await approve(f);
    expect(approved.statusCode).toBe(200);
    const selector = await supportSelector(f),
      before = await counts();
    for (const [url, payload] of [
      [f.exportsUrl, undefined],
      [`${f.deletionUrl}/approve`, f.approvalBody],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { ...f.headers, 'x-support-session-id': selector },
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('SUPPORT_READ_ONLY');
      cache(response);
      expect(response.json().data).toBeUndefined();
    }
    expect(await counts()).toEqual(before);
  });
  test('key reuse and lifecycle errors are no-store without changing acknowledgement', async () => {
    const f = await fixture();
    const original = await approve(f);
    expect(original.statusCode).toBe(200);
    const reuse = await app.inject({
      method: 'POST',
      url: `${f.deletionUrl}/approve`,
      headers: f.headers,
      payload: { ...f.approvalBody, reason: 'Different intent' },
    });
    expect(reuse.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    cache(reuse);
    const lifecycle = await app.inject({
      method: 'POST',
      url: `${f.deletionUrl}/approve`,
      headers: { ...f.headers, 'idempotency-key': 'new-approval' },
      payload: f.approvalBody,
    });
    expect(lifecycle.json().error.code).toBe('WORKSPACE_DELETION_INVALID_TRANSITION');
    cache(lifecycle);
  });
  test.each(['APPROVED', 'PROCESSING', 'FAILED', 'COMPLETED'])(
    'historical ack survives current %s without repeating any mutation',
    async (status) => {
      const f = await fixture();
      const original = await approve(f);
      expect(original.statusCode).toBe(200);
      await container.database.db
        .collection('workspace_deletion_requests')
        .updateOne({ _id: f.deletionId }, { $set: { status, version: 9 } });
      const before = await counts();
      const subscription = await container.database.db
        .collection('subscriptions')
        .findOne({ _id: f.subscriptionId });
      const workspace = await container.database.db
        .collection('workspaces')
        .findOne({ _id: f.workspaceId });
      const mutation = spyOn(container.retention, 'approve');
      try {
        const replay = await approve(f);
        expect(replay.json()).toEqual(original.json());
        cache(replay);
        expect(mutation).not.toHaveBeenCalled();
      } finally {
        mutation.mockRestore();
      }
      expect(await counts()).toEqual(before);
      expect(
        await container.database.db.collection('subscriptions').findOne({ _id: f.subscriptionId }),
      ).toEqual(subscription);
      expect(
        await container.database.db.collection('workspaces').findOne({ _id: f.workspaceId }),
      ).toEqual(workspace);
      expect(
        (
          await container.database.db
            .collection('workspace_deletion_requests')
            .findOne({ _id: f.deletionId })
        )?.version,
      ).toBe(9);
    },
  );
  test.each(['permission', 'membership', 'mfa', 'restricted'] as const)(
    'denies current %s loss',
    async (change) => {
      const f = await fixture();
      const original = await approve(f);
      expect(original.statusCode).toBe(200);
      const db = container.database.db;
      if (change === 'permission')
        await db
          .collection('permission_profiles')
          .updateOne({ _id: f.platformProfileId }, { $set: { permissions: [] } });
      if (change === 'membership')
        await db
          .collection('platform_memberships')
          .updateOne({ _id: f.platformMembershipId }, { $set: { status: 'SUSPENDED' } });
      if (change === 'mfa')
        await db
          .collection('auth_sessions')
          .updateOne({ _id: f.authId }, { $unset: { mfaSatisfiedAt: '' } });
      if (change === 'restricted')
        await db
          .collection('auth_sessions')
          .updateOne({ _id: f.authId }, { $set: { restrictedUntilVerified: true } });
      const before = await counts();
      const denied = await approve(f);
      expect(denied.json().error.code).toBe(
        {
          permission: 'PERMISSION_DENIED',
          membership: 'PLATFORM_MEMBERSHIP_REQUIRED',
          mfa: 'TWO_FACTOR_REQUIRED',
          restricted: 'AUTH_SESSION_RESTRICTED',
        }[change],
      );
      cache(denied);
      expect(denied.body).not.toContain(f.deletionId.toHexString());
      expect(await counts()).toEqual(before);
    },
  );
  test.each(['', 'not-a-session', new ObjectId().toHexString()])(
    'support selector %s cannot disclose approval replay',
    async (selector) => {
      const f = await fixture();
      const original = await approve(f);
      expect(original.statusCode).toBe(200);
      const before = await counts();
      const response = await app.inject({
        method: 'POST',
        url: `${f.deletionUrl}/approve`,
        headers: { ...f.headers, 'x-support-session-id': selector },
        payload: f.approvalBody,
      });
      expect([403, 422]).toContain(response.statusCode);
      cache(response);
      expect(response.body).not.toContain(f.deletionId.toHexString());
      expect(await counts()).toEqual(before);
    },
  );
});

describe('export failure privacy and URL service', () => {
  test('public mapping strips raw diagnostic while preserving stored failure', async () => {
    const f = await fixture();
    const original = await create(f);
    expect(original.statusCode).toBe(200);
    const exportId = new ObjectId(original.json().data.export.id);
    const failure = {
      code: 'EXPORT_GENERATION_FAILED',
      message:
        'Provider https://secret.internal/bucket/private/key.zip failed at C:/worker/export.ts stack details',
      retryable: false as const,
    };
    await container.database.db
      .collection('workspace_export_requests')
      .updateOne({ _id: exportId }, { $set: { status: 'FAILED', failure } });
    for (const url of [f.exportsUrl, `${f.exportsUrl}/${exportId}`]) {
      const response = await app.inject({ method: 'GET', url, headers: f.headers });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(failure.message);
      const dto = url === f.exportsUrl ? response.json().data[0] : response.json().export;
      expect(dto.failure).toEqual({ code: failure.code, retryable: false });
    }
    const repository = spyOn(container.exportsRepo, 'create').mockImplementation(
      async (document) => ({ ...document, status: 'FAILED', failure }),
    );
    try {
      const created = await app.inject({
        method: 'POST',
        url: f.exportsUrl,
        headers: { ...f.headers, 'idempotency-key': 'second-intent' },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().data.export.failure).toEqual({ code: failure.code, retryable: false });
      expect(created.body).not.toContain(failure.message);
    } finally {
      repository.mockRestore();
    }
    expect(
      (
        await container.database.db
          .collection('workspace_export_requests')
          .findOne({ _id: exportId })
      )?.failure,
    ).toEqual(failure);
  });
  test.each([300_000, 30_000, -1, 0, 500])(
    'download with %i milliseconds remaining respects deadline',
    async (remaining) => {
      const f = await fixture();
      const original = await create(f);
      const exportId = new ObjectId(original.json().data.export.id),
        fileId = new ObjectId();
      const deadline = new Date(Date.now() + remaining);
      await container.database.db
        .collection('workspace_export_requests')
        .updateOne(
          { _id: exportId },
          { $set: { status: 'READY', artifactFileId: fileId, expiresAt: deadline } },
        );
      await container.database.db.collection('files').insertOne({
        _id: fileId,
        workspaceId: f.workspaceId,
        origin: 'SYSTEM_GENERATED',
        generatedPurpose: 'WORKSPACE_EXPORT',
        generatedForExportId: exportId,
        status: 'ACTIVE',
        storageKey: 'private/export.zip',
        originalName: 'export.zip',
        mimeType: 'application/zip',
      });
      const fake = new FakeStorageProvider();
      const signing = spyOn(container.storage, 'createDownloadUrl').mockImplementation((request) =>
        fake.createDownloadUrl(request),
      );
      const before = Date.now();
      try {
        const response = await app.inject({
          method: 'POST',
          url: `${f.exportsUrl}/${exportId}/download-url`,
          headers: f.headers,
        });
        cache(response);
        if (remaining < 1000) {
          expect(response.json().error.code).toBe('EXPORT_NOT_READY');
          expect(fake.downloadRequests).toHaveLength(0);
        } else {
          expect(response.statusCode).toBe(200);
          const expiry = Date.parse(response.json().data.expiresAt);
          expect(expiry).toBeLessThanOrEqual(deadline.getTime());
          expect(expiry).toBeLessThanOrEqual(Date.now() + 120_000);
          expect(expiry).toBeGreaterThan(before + Math.min(remaining, 120_000) - 2500);
          expect(fake.downloadRequests[0]?.cacheControl).toBe('private, no-store');
        }
      } finally {
        signing.mockRestore();
      }
    },
  );
});

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
    audit: { retentionPolicy: 'INDEFINITE' },
    auth: {
      jwtActiveKeyId: 'local',
      jwtPrivateKey: [
        '-----BEGIN PRIVATE KEY-----',
        'MC4CAQAwBQYDK2VwBCIEIP27WzZ2lrwob/CusOSRmtVPlS0TPTrBOFjTuBztUPm8',
        '-----END PRIVATE KEY-----',
      ].join('\n'),
      jwtPublicKeys: {
        local: [
          '-----BEGIN PUBLIC KEY-----',
          'MCowBQYDK2VwAyEAVk4E+7jo4OHXHcYC1lvT+vqaViaFNdUPnMcuSDPpp60=',
          '-----END PUBLIC KEY-----',
        ].join('\n'),
      },
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
