import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import type { AppContainer } from '../src/bootstrap/app-container';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import type { OutboxEventDocument } from '../src/core/events/outbox.types';
import { migrations } from '../src/migrations';
import { migration021Stage16SupportAccess } from '../src/migrations/021-stage16-support-access';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { Permissions } from '../src/modules/permissions/permission.registry';

const INTEGRATION_TIMEOUT_MS = 30_000;
let container: AppContainer | undefined;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  container = await createAppContainer(integrationConfig(`stage16_${new ObjectId()}`));
  await new MigrationRunner(container.database.db, migrations).migrate();
  app = await buildApp(container);
}, INTEGRATION_TIMEOUT_MS);

afterEach(async () => {
  if (!container) return;
  const collections = await container.database.db.listCollections().toArray();
  for (const collection of collections) {
    if (collection.name === 'db_migrations') continue;
    await container.database.db.collection(collection.name).deleteMany({});
  }
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (app) await app.close();
  if (container) {
    await container.database.db.dropDatabase();
    await container.database.close();
  }
}, INTEGRATION_TIMEOUT_MS);

describe('Stage 16 migration 021', () => {
  test(
    'creates support access collections, indexes, and platform permission seeds without Stage 17 collections',
    async () => {
      const local = await createAppContainer(
        integrationConfig(`stage16_migration_${new ObjectId()}`),
      );
      try {
        await new MigrationRunner(local.database.db, migrations).migrate();
        await new MigrationRunner(local.database.db, migrations).migrate();

        const policyIndexes = (
          await local.database.db.collection('portal_access_policies').indexes()
        ).map((index) => index.name);
        const sessionIndexes = (
          await local.database.db.collection('support_sessions').indexes()
        ).map((index) => index.name);
        expect(policyIndexes).toContain('portal_access_policies_owner_enabled_archive');
        expect(sessionIndexes).toContain('support_sessions_status_expiry');
        expect(sessionIndexes).not.toContain('support_sessions_workspace_unique_active');
        expect(
          await local.database.db.listCollections({ name: 'workspace_deletions' }).hasNext(),
        ).toBe(false);
        expect(
          await local.database.db.collection('permission_definitions').countDocuments({
            key: { $in: stage16Permissions },
          }),
        ).toBe(stage16Permissions.length);
      } finally {
        await local.database.db.dropDatabase();
        await local.database.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test('migration propagates index creation failures', async () => {
    const db = {
      collection() {
        return {
          async createIndexes() {
            throw new Error('index failed');
          },
        };
      },
    };

    await expect(migration021Stage16SupportAccess.up(db as never)).rejects.toThrow('index failed');
  });
});

describe('Stage 16 notification contract', () => {
  test(
    'SupportSessionStarted notifies active workspace owners only when notificationRequired is true',
    async () => {
      const workspaceId = new ObjectId();
      const activeOwner = await seedWorkspaceUser(workspaceId, 'GYM_OWNER', 'ACTIVE');
      const inactiveOwner = await seedWorkspaceUser(workspaceId, 'GYM_OWNER', 'SUSPENDED');
      const manager = await seedWorkspaceUser(workspaceId, 'GYM_MANAGER', 'ACTIVE');
      const trainer = await seedWorkspaceUser(workspaceId, 'TRAINER', 'ACTIVE');
      const otherOwner = await seedWorkspaceUser(new ObjectId(), 'GYM_OWNER', 'ACTIVE');
      const event = await insertSupportEvent('SupportSessionStarted', workspaceId, {
        notificationRequired: true,
        supportSessionId: new ObjectId().toHexString(),
      });

      await appContainer().notifications.handleOutboxEvent(event);
      await appContainer().notifications.handleOutboxEvent(event);

      const recipients = await notificationRecipientIds();
      expect(recipients).toEqual([activeOwner.userId.toHexString()]);
      expect(recipients).not.toContain(inactiveOwner.userId.toHexString());
      expect(recipients).not.toContain(manager.userId.toHexString());
      expect(recipients).not.toContain(trainer.userId.toHexString());
      expect(recipients).not.toContain(otherOwner.userId.toHexString());
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'notificationRequired false suppresses start, end, revoke, and expiry customer notifications',
    async () => {
      const workspaceId = new ObjectId();
      await seedWorkspaceUser(workspaceId, 'GYM_OWNER', 'ACTIVE');

      for (const eventType of [
        'SupportSessionStarted',
        'SupportSessionEnded',
        'SupportSessionRevoked',
        'SupportSessionExpired',
      ]) {
        const event = await insertSupportEvent(eventType, workspaceId, {
          notificationRequired: false,
          supportSessionId: new ObjectId().toHexString(),
        });
        await appContainer().notifications.handleOutboxEvent(event);
      }

      expect(await appContainer().database.db.collection('notifications').countDocuments()).toBe(0);
      expect(
        await appContainer().database.db.collection('notification_deliveries').countDocuments(),
      ).toBe(0);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'support notification payloads exclude reason, ticket, IP, policy rules, and signed URLs',
    async () => {
      const workspaceId = new ObjectId();
      await seedWorkspaceUser(workspaceId, 'GYM_OWNER', 'ACTIVE');
      const event = await insertSupportEvent('SupportSessionStarted', workspaceId, {
        notificationRequired: true,
        supportSessionId: new ObjectId().toHexString(),
        reason: 'Do not copy this reason',
        reference: 'TICKET-SECRET',
        ipAddress: '203.0.113.9',
        signedUrl: 'https://files.example.test/signed',
        allowedIpRanges: ['127.0.0.1/32'],
      });

      await appContainer().notifications.handleOutboxEvent(event);

      const notification = await appContainer().database.db.collection('notifications').findOne({});
      expect(JSON.stringify(notification?.payload ?? {})).not.toContain('Do not copy this reason');
      expect(JSON.stringify(notification?.payload ?? {})).not.toContain('TICKET-SECRET');
      expect(JSON.stringify(notification?.payload ?? {})).not.toContain('203.0.113.9');
      expect(JSON.stringify(notification?.payload ?? {})).not.toContain('signed');
      expect(JSON.stringify(notification?.payload ?? {})).not.toContain('127.0.0.1/32');
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

describe('Stage 16 policy lifecycle and IP/CIDR validation', () => {
  test(
    'policy administration enforces sensitive allowance ceilings and revision lifecycle',
    async () => {
      const admin = await seedPlatformActor([
        Permissions.SupportPoliciesRead,
        Permissions.SupportPoliciesCreate,
        Permissions.SupportPoliciesUpdate,
        Permissions.SupportPoliciesDisable,
        Permissions.SupportPoliciesArchive,
      ]);
      const supportActor = await seedPlatformActor([Permissions.SupportSessionsStart]);
      const token = await tokenFor(admin.userId);
      const body = policyBody(supportActor.membershipId, {
        allowSensitiveData: true,
      });

      const denied = await appInstance().inject({
        method: 'POST',
        url: '/api/v1/platform/support/policies',
        headers: bearer(token),
        payload: body,
      });
      expect(denied.statusCode).toBe(403);

      await setPlatformPermissions(admin.profileId, [
        Permissions.SupportPoliciesRead,
        Permissions.SupportPoliciesCreate,
        Permissions.SupportPoliciesUpdate,
        Permissions.SupportPoliciesDisable,
        Permissions.SupportPoliciesArchive,
        Permissions.SupportSensitiveRead,
      ]);
      const created = await appInstance().inject({
        method: 'POST',
        url: '/api/v1/platform/support/policies',
        headers: bearer(token),
        payload: body,
      });
      expect(created.statusCode).toBe(200);
      const policyId = created.json().data.id;

      const stale = await appInstance().inject({
        method: 'PATCH',
        url: `/api/v1/platform/support/policies/${policyId}`,
        headers: bearer(token),
        payload: { ...body, expectedVersion: 99 },
      });
      expect(stale.statusCode).toBe(409);

      const disabled = await appInstance().inject({
        method: 'POST',
        url: `/api/v1/platform/support/policies/${policyId}/disable`,
        headers: bearer(token),
        payload: { expectedVersion: 0 },
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json().data.enabled).toBe(false);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'IP contract supports IPv4 exact, IPv4 CIDR, IPv6 exact, rejects IPv6 CIDR, and ignores spoofed forwarded headers',
    async () => {
      const admin = await seedPlatformActor([
        Permissions.SupportPoliciesCreate,
        Permissions.SupportSensitiveRead,
        Permissions.SupportSensitiveFilesRead,
      ]);
      const supportActor = await seedPlatformActor([Permissions.SupportSessionsStart]);
      const token = await tokenFor(admin.userId);

      for (const range of ['127.0.0.1', '127.0.0.0/24', '127.0.0.1/32', '::1']) {
        const response = await appInstance().inject({
          method: 'POST',
          url: '/api/v1/platform/support/policies',
          headers: bearer(token),
          payload: policyBody(supportActor.membershipId, { allowedIpRanges: [range] }),
        });
        expect(response.statusCode).toBe(200);
      }

      for (const range of ['127.0.0.1/33', 'bad-cidr', '2001:db8::/32']) {
        const response = await appInstance().inject({
          method: 'POST',
          url: '/api/v1/platform/support/policies',
          headers: bearer(token),
          payload: policyBody(supportActor.membershipId, { allowedIpRanges: [range] }),
        });
        expect(response.statusCode).toBe(422);
      }

      await seedWorkspace(new ObjectId());
      await seedPolicy(supportActor.membershipId, { allowedIpRanges: ['203.0.113.9'] });
      const start = await appInstance().inject({
        method: 'POST',
        url: '/api/v1/platform/support/access-requests',
        headers: {
          ...bearer(await tokenFor(supportActor.userId)),
          'Idempotency-Key': new ObjectId().toHexString(),
          'x-forwarded-for': '203.0.113.9',
        },
        payload: startBody(new ObjectId()),
      });
      expect(start.statusCode).toBe(403);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

describe('Stage 16 access requests, runtime guard, and lifecycle', () => {
  test(
    'approved start persists request, active session, audit, outbox, and idempotent replay returns one session',
    async () => {
      const workspaceId = new ObjectId();
      await seedWorkspace(workspaceId);
      const actor = await seedPlatformActor([
        Permissions.SupportSessionsStart,
        Permissions.SupportSessionsRead,
        Permissions.SupportSessionsEndOwn,
      ]);
      await seedPolicy(actor.membershipId, { allowedWorkspaceIds: [workspaceId] });
      const token = await tokenFor(actor.userId);
      const key = new ObjectId().toHexString();
      const payload = startBody(workspaceId);

      const [first, replay] = await Promise.all([
        startSupport(token, key, payload),
        startSupport(token, key, payload),
      ]);
      const successful = [first, replay].filter((response) => response.statusCode === 201);
      expect(successful.length).toBeGreaterThanOrEqual(1);
      expect(await collectionCount('support_access_requests')).toBe(1);
      expect(await collectionCount('support_sessions')).toBe(1);
      expect(await collectionCount('audit_events', { eventType: 'SupportSessionStarted' })).toBe(1);
      expect(await collectionCount('outbox_events', { eventType: 'SupportSessionStarted' })).toBe(
        1,
      );

      const conflict = await startSupport(token, key, {
        ...payload,
        requestedDurationMinutes: 2,
      });
      expect(conflict.statusCode).toBe(409);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'denied start stores safe decision evidence, audit, and no support session',
    async () => {
      const workspaceId = new ObjectId();
      await seedWorkspace(workspaceId);
      const actor = await seedPlatformActor([Permissions.SupportSessionsStart]);
      const token = await tokenFor(actor.userId);

      const denied = await startSupport(
        token,
        new ObjectId().toHexString(),
        startBody(workspaceId),
      );

      expect(denied.statusCode).toBe(403);
      expect(await collectionCount('support_access_requests', { decision: 'DENIED' })).toBe(1);
      expect(await collectionCount('support_sessions')).toBe(0);
      expect(
        await collectionCount('audit_events', { eventType: 'SupportAccessRequestDenied' }),
      ).toBe(1);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'runtime support guard revalidates platform permission, DENY, parent auth, policy state, IP, and expiry',
    async () => {
      const workspaceId = new ObjectId();
      await seedWorkspace(workspaceId);
      const actor = await seedPlatformActor([Permissions.SupportSessionsStart]);
      await seedPolicy(actor.membershipId, { allowedWorkspaceIds: [workspaceId] });
      const { token, sessionId: parentAuthSessionId } = await tokenAndSessionFor(actor.userId);
      const sessionId = await startAndSessionId(token, workspaceId);

      expect(await supportRead(token, sessionId, workspaceId)).toBe(200);

      await setPlatformPermissions(actor.profileId, []);
      expect(await supportRead(token, sessionId, workspaceId)).toBe(403);

      await setPlatformPermissions(actor.profileId, [
        { permission: Permissions.SupportSessionsStart, effect: 'DENY' },
      ]);
      expect(await supportRead(token, sessionId, workspaceId)).toBe(403);

      await setPlatformPermissions(actor.profileId, [Permissions.SupportSessionsStart]);
      await appContainer()
        .database.db.collection('auth_sessions')
        .updateOne({ _id: parentAuthSessionId }, { $set: { status: 'REVOKED' } });
      expect(await supportRead(token, sessionId, workspaceId)).toBe(401);

      await appContainer()
        .database.db.collection('auth_sessions')
        .updateOne(
          { _id: parentAuthSessionId },
          { $set: { status: 'ACTIVE', restrictedUntilVerified: true } },
        );
      expect(await supportRead(token, sessionId, workspaceId)).toBe(403);

      await appContainer()
        .database.db.collection('auth_sessions')
        .updateOne(
          { _id: parentAuthSessionId },
          { $set: { restrictedUntilVerified: false, mfaSatisfiedAt: new Date() } },
        );
      await appContainer()
        .database.db.collection('portal_access_policies')
        .updateOne({}, { $set: { enabled: false } });
      expect(await supportRead(token, sessionId, workspaceId)).toBe(403);

      await appContainer()
        .database.db.collection('portal_access_policies')
        .updateOne({}, { $set: { enabled: true, archivedAt: new Date() } });
      expect(await supportRead(token, sessionId, workspaceId)).toBe(403);

      await appContainer()
        .database.db.collection('portal_access_policies')
        .updateOne(
          {},
          { $unset: { archivedAt: '' }, $set: { validUntil: new Date(Date.now() - 1000) } },
        );
      expect(await supportRead(token, sessionId, workspaceId)).toBe(403);

      await appContainer()
        .database.db.collection('support_sessions')
        .updateOne({ _id: new ObjectId(sessionId) }, { $set: { expiresAt: new Date() } });
      expect(await supportRead(token, sessionId, workspaceId)).toBe(403);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'session ID attacks and context swaps fail closed before source mutation',
    async () => {
      const workspaceId = new ObjectId();
      const otherWorkspaceId = new ObjectId();
      await seedWorkspace(workspaceId);
      await seedWorkspace(otherWorkspaceId);
      const actor = await seedPlatformActor([Permissions.SupportSessionsStart]);
      const thief = await seedPlatformActor([Permissions.SupportSessionsStart]);
      await seedPolicy(actor.membershipId, { allowedWorkspaceIds: [workspaceId] });
      const token = await tokenFor(actor.userId);
      const sessionId = await startAndSessionId(token, workspaceId);

      expect(await supportRead(token, new ObjectId().toHexString(), workspaceId)).toBe(403);
      expect(await supportRead(token, 'not-an-object-id', workspaceId)).toBe(422);
      expect(await supportRead(await tokenFor(thief.userId), sessionId, workspaceId)).toBe(403);
      expect(await supportRead(token, sessionId, otherWorkspaceId)).toBe(403);

      await appContainer()
        .database.db.collection('support_sessions')
        .updateOne({ _id: new ObjectId(sessionId) }, { $set: { status: 'ENDED' } });
      expect(await supportRead(token, sessionId, workspaceId)).toBe(403);

      await appContainer()
        .database.db.collection('workspaces')
        .updateOne({ _id: workspaceId }, { $set: { name: 'Before Mutation' } });
      const mutation = await appInstance().inject({
        method: 'PATCH',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}`,
        headers: { ...bearer(token), 'X-Support-Session-Id': sessionId },
        payload: { name: 'After Mutation' },
      });
      expect(mutation.statusCode).toBe(403);
      expect(
        await appContainer().database.db.collection('workspaces').findOne({ _id: workspaceId }),
      ).toMatchObject({ name: 'Before Mutation' });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'READ_ONLY permits safe reads and denies mutations; WRITE_SUPPORT still denies non-whitelisted business writes',
    async () => {
      const workspaceId = new ObjectId();
      await seedWorkspace(workspaceId);
      const actor = await seedPlatformActor([Permissions.SupportSessionsStart]);
      await seedPolicy(actor.membershipId, {
        allowedWorkspaceIds: [workspaceId],
        allowedSessionTypes: ['READ_ONLY', 'WRITE_SUPPORT'],
      });
      const token = await tokenFor(actor.userId);
      const readOnlySessionId = await startAndSessionId(token, workspaceId, 'READ_ONLY');
      const writeSupportSessionId = await startAndSessionId(token, workspaceId, 'WRITE_SUPPORT');

      expect(await supportRead(token, readOnlySessionId, workspaceId)).toBe(200);
      const readOnlyWrite = await appInstance().inject({
        method: 'PATCH',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}`,
        headers: { ...bearer(token), 'X-Support-Session-Id': readOnlySessionId },
        payload: { name: 'Blocked Read Only' },
      });
      expect(readOnlyWrite.statusCode).toBe(403);
      expect(readOnlyWrite.json().error.code).toBe('SUPPORT_READ_ONLY');

      const writeSupportWrite = await appInstance().inject({
        method: 'PATCH',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}`,
        headers: { ...bearer(token), 'X-Support-Session-Id': writeSupportSessionId },
        payload: { name: 'Blocked Write Support' },
      });
      expect(writeSupportWrite.statusCode).toBe(403);
      expect(writeSupportWrite.json().error.code).toBe('SUPPORT_WRITE_NOT_WHITELISTED');
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'real actor and effective actor context are preserved in USER_CONTEXT and WORKSPACE_SUPPORT audit',
    async () => {
      const workspaceId = new ObjectId();
      await seedWorkspace(workspaceId);
      const actor = await seedPlatformActor([Permissions.SupportSessionsStart]);
      const target = await seedWorkspaceUser(workspaceId, 'TRAINEE', 'ACTIVE');
      await seedPolicy(actor.membershipId, { allowedWorkspaceIds: [workspaceId] });
      const token = await tokenFor(actor.userId);
      const userContextSessionId = await startAndSessionId(
        token,
        workspaceId,
        'READ_ONLY',
        'USER_CONTEXT',
        target.userId,
        target.membershipId,
      );
      const workspaceSessionId = await startAndSessionId(token, workspaceId);

      const startedEvents = await appContainer()
        .database.db.collection('audit_events')
        .find({ eventType: 'SupportSessionStarted' })
        .toArray();
      expect(startedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            supportSessionId: new ObjectId(userContextSessionId),
            actor: expect.objectContaining({
              userId: actor.userId,
              platformMembershipId: actor.membershipId,
            }),
            effectiveContext: expect.objectContaining({
              targetWorkspaceId: workspaceId.toHexString(),
              targetUserId: target.userId.toHexString(),
              effectiveMembershipId: target.membershipId.toHexString(),
            }),
          }),
          expect.objectContaining({
            supportSessionId: new ObjectId(workspaceSessionId),
            actor: expect.objectContaining({
              userId: actor.userId,
              platformMembershipId: actor.membershipId,
            }),
            effectiveContext: expect.objectContaining({
              targetWorkspaceId: workspaceId.toHexString(),
            }),
          }),
        ]),
      );
      expect(startedEvents.map((event) => event.actor.userId.toHexString())).not.toContain(
        target.userId.toHexString(),
      );
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'session end versus revoke race produces one terminal transition and stale expectedVersion conflicts',
    async () => {
      const workspaceId = new ObjectId();
      await seedWorkspace(workspaceId);
      const actor = await seedPlatformActor([
        Permissions.SupportSessionsStart,
        Permissions.SupportSessionsEndOwn,
        Permissions.SupportSessionsRevoke,
      ]);
      await seedPolicy(actor.membershipId, { allowedWorkspaceIds: [workspaceId] });
      const token = await tokenFor(actor.userId);
      const sessionId = await startAndSessionId(token, workspaceId);

      const [end, revoke] = await Promise.all([
        appInstance().inject({
          method: 'POST',
          url: `/api/v1/platform/support/sessions/${sessionId}/end`,
          headers: bearer(token),
          payload: { expectedVersion: 0 },
        }),
        appInstance().inject({
          method: 'POST',
          url: `/api/v1/platform/support/sessions/${sessionId}/revoke`,
          headers: bearer(token),
          payload: { expectedVersion: 0 },
        }),
      ]);

      expect([end.statusCode, revoke.statusCode].sort()).toEqual([200, 409]);
      expect(
        await collectionCount('support_sessions', { status: { $in: ['ENDED', 'REVOKED'] } }),
      ).toBe(1);
      const stale = await appInstance().inject({
        method: 'POST',
        url: `/api/v1/platform/support/sessions/${sessionId}/end`,
        headers: bearer(token),
        payload: { expectedVersion: 0 },
      });
      expect(stale.statusCode).toBe(409);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'expiry job expires due active sessions only once and leaves future or terminal sessions untouched',
    async () => {
      const workspaceId = new ObjectId();
      await seedWorkspace(workspaceId);
      const actor = await seedPlatformActor([Permissions.SupportSessionsStart]);
      await seedPolicy(actor.membershipId, { allowedWorkspaceIds: [workspaceId] });
      const token = await tokenFor(actor.userId);
      const due = await startAndSessionId(token, workspaceId);
      const future = await startAndSessionId(token, workspaceId);
      const ended = await startAndSessionId(token, workspaceId);
      await appContainer()
        .database.db.collection('support_sessions')
        .updateOne(
          { _id: new ObjectId(due) },
          { $set: { expiresAt: new Date(Date.now() - 1000) } },
        );
      await appContainer()
        .database.db.collection('support_sessions')
        .updateOne({ _id: new ObjectId(ended) }, { $set: { status: 'ENDED' } });

      expect(await appContainer().supportAccess.expireDue(appContainer().jobLeases, 1)).toBe(1);
      expect(await appContainer().supportAccess.expireDue(appContainer().jobLeases, 10)).toBe(0);

      const dueDoc = await supportSession(due);
      const futureDoc = await supportSession(future);
      const endedDoc = await supportSession(ended);
      expect(dueDoc?.status).toBe('EXPIRED');
      expect(futureDoc?.status).toBe('ACTIVE');
      expect(endedDoc?.status).toBe('ENDED');
      expect(await collectionCount('outbox_events', { eventType: 'SupportSessionExpired' })).toBe(
        1,
      );
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

describe('Stage 16 sensitive access and failure injection', () => {
  test(
    'sensitive support checks require platform permission, policy allowance, and active session',
    async () => {
      const workspaceId = new ObjectId();
      await seedWorkspace(workspaceId);
      const actor = await seedPlatformActor([
        Permissions.SupportSessionsStart,
        Permissions.SupportSensitiveRead,
        Permissions.SupportSensitiveFilesRead,
      ]);
      await seedPolicy(actor.membershipId, {
        allowedWorkspaceIds: [workspaceId],
        allowSensitiveData: true,
        allowSensitiveFileDownload: true,
      });
      const { token, sessionId: authSessionId } = await tokenAndSessionFor(actor.userId);
      const sessionId = await startAndSessionId(
        token,
        workspaceId,
        'READ_ONLY',
        'WORKSPACE_SUPPORT',
        undefined,
        undefined,
        true,
        true,
      );
      const ctx = {
        userId: actor.userId.toHexString(),
        authSessionId: authSessionId.toHexString(),
        authenticationMethods: ['pwd'],
        mfaSatisfied: true,
        restrictedUntilVerified: false,
        platformMembershipId: actor.membershipId.toHexString(),
        supportSessionId: sessionId,
        ipAddress: '127.0.0.1',
        correlationId: new ObjectId().toHexString(),
        locale: 'en',
        timezone: 'Africa/Cairo',
      };

      await expect(
        appContainer().supportAccess.requireSensitive(ctx, 'DATA'),
      ).resolves.toBeUndefined();
      await expect(
        appContainer().supportAccess.requireSensitive(ctx, 'FILE'),
      ).resolves.toBeUndefined();

      await setPlatformPermissions(actor.profileId, [
        Permissions.SupportSessionsStart,
        Permissions.SupportSensitiveFilesRead,
      ]);
      await expect(appContainer().supportAccess.requireSensitive(ctx, 'DATA')).rejects.toThrow();

      await setPlatformPermissions(actor.profileId, [
        Permissions.SupportSessionsStart,
        Permissions.SupportSensitiveRead,
      ]);
      await expect(appContainer().supportAccess.requireSensitive(ctx, 'FILE')).rejects.toThrow();

      await appContainer()
        .database.db.collection('support_sessions')
        .updateOne({ _id: new ObjectId(sessionId) }, { $set: { allowSensitiveData: false } });
      await setPlatformPermissions(actor.profileId, [
        Permissions.SupportSessionsStart,
        Permissions.SupportSensitiveRead,
        Permissions.SupportSensitiveFilesRead,
      ]);
      await expect(appContainer().supportAccess.requireSensitive(ctx, 'DATA')).rejects.toThrow();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'critical start audit or outbox failures roll back active session creation',
    async () => {
      const workspaceId = new ObjectId();
      await seedWorkspace(workspaceId);
      const actor = await seedPlatformActor([Permissions.SupportSessionsStart]);
      await seedPolicy(actor.membershipId, { allowedWorkspaceIds: [workspaceId] });
      const token = await tokenFor(actor.userId);
      const originalAudit = appContainer().audit.write.bind(appContainer().audit);
      (appContainer().audit as unknown as { write: unknown }).write = async () => {
        throw new Error('audit failed');
      };
      try {
        const failed = await startSupport(
          token,
          new ObjectId().toHexString(),
          startBody(workspaceId),
        );
        expect(failed.statusCode).toBe(500);
        expect(await collectionCount('support_sessions')).toBe(0);
        expect(await collectionCount('support_access_requests')).toBe(0);
      } finally {
        (appContainer().audit as unknown as { write: unknown }).write = originalAudit;
      }

      const originalOutbox = appContainer().outbox.write.bind(appContainer().outbox);
      (appContainer().outbox as unknown as { write: unknown }).write = async () => {
        throw new Error('outbox failed');
      };
      try {
        const failed = await startSupport(
          token,
          new ObjectId().toHexString(),
          startBody(workspaceId),
        );
        expect(failed.statusCode).toBe(500);
        expect(await collectionCount('support_sessions')).toBe(0);
        expect(await collectionCount('support_access_requests')).toBe(0);
      } finally {
        (appContainer().outbox as unknown as { write: unknown }).write = originalOutbox;
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

const stage16Permissions = [
  Permissions.SupportPoliciesRead,
  Permissions.SupportPoliciesCreate,
  Permissions.SupportPoliciesUpdate,
  Permissions.SupportPoliciesDisable,
  Permissions.SupportPoliciesArchive,
  Permissions.SupportSessionsRead,
  Permissions.SupportSessionsStart,
  Permissions.SupportSessionsEndOwn,
  Permissions.SupportSessionsRevoke,
  Permissions.SupportSensitiveRead,
  Permissions.SupportSensitiveFilesRead,
];

function appInstance(): FastifyInstance {
  if (!app) throw new Error('Test app was not initialized.');
  return app;
}

function appContainer(): AppContainer {
  if (!container) throw new Error('Test container was not initialized.');
  return container;
}

async function seedPlatformActor(
  permissions: Array<string | { permission: string; effect: 'ALLOW' | 'DENY' }>,
) {
  const userId = new ObjectId();
  const membershipId = new ObjectId();
  const profileId = new ObjectId();
  await appContainer().database.db.collection('users').insertOne(userRecord(userId));
  await appContainer()
    .database.db.collection('permission_profiles')
    .insertOne({
      _id: profileId,
      context: 'PLATFORM',
      name: `Stage 16 Platform Profile ${profileId.toHexString()}`,
      permissions: normalizePermissions(permissions),
      isSystemDefault: false,
      status: 'ACTIVE',
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  await appContainer()
    .database.db.collection('platform_memberships')
    .insertOne({
      _id: membershipId,
      userId,
      status: 'ACTIVE',
      permissionProfileIds: [profileId],
      accessVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  return { userId, membershipId, profileId };
}

async function setPlatformPermissions(
  profileId: ObjectId,
  permissions: Array<string | { permission: string; effect: 'ALLOW' | 'DENY' }>,
) {
  await appContainer()
    .database.db.collection('permission_profiles')
    .updateOne({ _id: profileId }, { $set: { permissions: normalizePermissions(permissions) } });
}

function normalizePermissions(
  permissions: Array<string | { permission: string; effect: 'ALLOW' | 'DENY' }>,
) {
  return permissions.map((permission) =>
    typeof permission === 'string' ? { permission, effect: 'ALLOW' } : permission,
  );
}

async function tokenFor(userId: ObjectId) {
  return (await tokenAndSessionFor(userId)).token;
}

async function tokenAndSessionFor(userId: ObjectId) {
  const session = await appContainer().authSessions.create({
    userId,
    authenticationMethods: ['pwd'],
    restrictedUntilVerified: false,
    ipAddress: '127.0.0.1',
    clientType: 'API',
    transport: 'JSON',
    mfaSatisfiedAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return {
    sessionId: session._id,
    token: appContainer().jwt.createAccessToken({
      userId: userId.toHexString(),
      authSessionId: session._id.toHexString(),
      authenticationMethods: ['pwd'],
    }),
  };
}

async function seedWorkspace(workspaceId: ObjectId, ownerUserId = new ObjectId()) {
  await appContainer()
    .database.db.collection('workspaces')
    .insertOne(workspaceRecord(workspaceId, ownerUserId));
}

async function seedWorkspaceUser(
  workspaceId: ObjectId,
  role: string,
  status: 'ACTIVE' | 'SUSPENDED',
) {
  const userId = new ObjectId();
  const membershipId = new ObjectId();
  const profileId = new ObjectId();
  await appContainer().database.db.collection('users').insertOne(userRecord(userId));
  await appContainer()
    .database.db.collection('workspaces')
    .updateOne(
      { _id: workspaceId },
      { $setOnInsert: workspaceRecord(workspaceId, userId) },
      { upsert: true },
    );
  await appContainer()
    .database.db.collection('permission_profiles')
    .insertOne({
      _id: profileId,
      context: 'WORKSPACE',
      workspaceId,
      name: `Stage 16 Workspace Profile ${profileId.toHexString()}`,
      permissions: [{ permission: Permissions.AuditWorkspaceRead, effect: 'ALLOW' }],
      isSystemDefault: false,
      status: 'ACTIVE',
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  await appContainer()
    .database.db.collection('workspace_memberships')
    .insertOne({
      _id: membershipId,
      workspaceId,
      userId,
      roles: [role],
      status,
      joinedAt: new Date(),
      engagementPeriods: [{ startedAt: new Date() }],
      permissionProfileIds: [profileId],
      accessVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  return { userId, membershipId, profileId };
}

async function seedPolicy(
  platformMembershipId: ObjectId,
  overrides: Partial<{
    allowedWorkspaceIds: ObjectId[];
    allowedIpRanges: string[];
    allowedSessionTypes: Array<'READ_ONLY' | 'WRITE_SUPPORT'>;
    allowSensitiveData: boolean;
    allowSensitiveFileDownload: boolean;
    notificationRequired: boolean;
  }> = {},
) {
  const now = new Date();
  const policy = {
    _id: new ObjectId(),
    platformMembershipId,
    allowedTargetTypes: ['GYM'],
    ...(overrides.allowedWorkspaceIds
      ? { allowedWorkspaceIds: overrides.allowedWorkspaceIds }
      : {}),
    allowedIpRanges: overrides.allowedIpRanges ?? ['127.0.0.1'],
    allowedSessionTypes: overrides.allowedSessionTypes ?? ['READ_ONLY'],
    maxSessionDurationMinutes: 30,
    notificationRequired: overrides.notificationRequired ?? true,
    allowSensitiveData: overrides.allowSensitiveData ?? false,
    allowSensitiveFileDownload: overrides.allowSensitiveFileDownload ?? false,
    enabled: true,
    revision: 0,
    createdBy: new ObjectId(),
    createdAt: now,
  };
  await appContainer().database.db.collection('portal_access_policies').insertOne(policy);
  return policy;
}

function policyBody(
  platformMembershipId: ObjectId,
  overrides: Partial<{
    allowedIpRanges: string[];
    allowSensitiveData: boolean;
    allowSensitiveFileDownload: boolean;
  }> = {},
) {
  return {
    platformMembershipId: platformMembershipId.toHexString(),
    allowedTargetTypes: ['GYM'],
    allowedIpRanges: overrides.allowedIpRanges ?? ['127.0.0.1'],
    allowedSessionTypes: ['READ_ONLY'],
    maxSessionDurationMinutes: 30,
    notificationRequired: true,
    allowSensitiveData: overrides.allowSensitiveData ?? false,
    allowSensitiveFileDownload: overrides.allowSensitiveFileDownload ?? false,
  };
}

function startBody(
  workspaceId: ObjectId,
  sessionType: 'READ_ONLY' | 'WRITE_SUPPORT' = 'READ_ONLY',
  contextType: 'USER_CONTEXT' | 'WORKSPACE_SUPPORT' = 'WORKSPACE_SUPPORT',
  targetUserId?: ObjectId,
  effectiveMembershipId?: ObjectId,
  sensitive = false,
  sensitiveFile = false,
) {
  return {
    targetType: 'GYM',
    targetWorkspaceId: workspaceId.toHexString(),
    ...(targetUserId ? { targetUserId: targetUserId.toHexString() } : {}),
    ...(effectiveMembershipId
      ? { effectiveMembershipId: effectiveMembershipId.toHexString() }
      : {}),
    contextType,
    sessionType,
    requestedDurationMinutes: 1,
    requestedSensitiveAccess: sensitive,
    requestedSensitiveFileDownload: sensitiveFile,
    reason: 'support test reason',
    reference: 'SUP-16',
  };
}

async function startSupport(token: string, key: string, payload: ReturnType<typeof startBody>) {
  return await appInstance().inject({
    method: 'POST',
    url: '/api/v1/platform/support/access-requests',
    headers: { ...bearer(token), 'Idempotency-Key': key },
    payload,
  });
}

async function startAndSessionId(
  token: string,
  workspaceId: ObjectId,
  sessionType: 'READ_ONLY' | 'WRITE_SUPPORT' = 'READ_ONLY',
  contextType: 'USER_CONTEXT' | 'WORKSPACE_SUPPORT' = 'WORKSPACE_SUPPORT',
  targetUserId?: ObjectId,
  effectiveMembershipId?: ObjectId,
  sensitive = false,
  sensitiveFile = false,
) {
  const response = await startSupport(
    token,
    new ObjectId().toHexString(),
    startBody(
      workspaceId,
      sessionType,
      contextType,
      targetUserId,
      effectiveMembershipId,
      sensitive,
      sensitiveFile,
    ),
  );
  expect(response.statusCode).toBe(201);
  return response.json().data.supportSession.id as string;
}

async function supportRead(token: string, supportSessionId: string, workspaceId: ObjectId) {
  const response = await appInstance().inject({
    method: 'GET',
    url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit`,
    headers: { ...bearer(token), 'X-Support-Session-Id': supportSessionId },
  });
  return response.statusCode;
}

async function insertSupportEvent(
  eventType: string,
  workspaceId: ObjectId,
  payload: Record<string, unknown>,
) {
  const event: OutboxEventDocument = {
    _id: new ObjectId(),
    eventType,
    aggregateType: 'support_session',
    aggregateId: new ObjectId(),
    workspaceId,
    payload,
    correlationId: new ObjectId().toHexString(),
    status: 'PENDING',
    attempts: 0,
    occurredAt: new Date(),
  };
  await appContainer().database.db.collection('outbox_events').insertOne(event);
  return event;
}

async function notificationRecipientIds() {
  return (await appContainer().database.db.collection('notifications').find({}).toArray()).map(
    (notification) => notification.recipientUserId.toHexString(),
  );
}

async function collectionCount(collection: string, filter: Record<string, unknown> = {}) {
  return await appContainer().database.db.collection(collection).countDocuments(filter);
}

async function supportSession(sessionId: string) {
  return await appContainer()
    .database.db.collection('support_sessions')
    .findOne({ _id: new ObjectId(sessionId) });
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function userRecord(userId: ObjectId) {
  return {
    _id: userId,
    email: `${userId.toHexString()}@example.test`,
    normalizedEmail: `${userId.toHexString()}@example.test`,
    passwordHash: 'hash',
    firstName: 'Stage',
    lastName: 'Sixteen',
    preferredLanguage: 'en',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function workspaceRecord(workspaceId: ObjectId, ownerUserId = new ObjectId()) {
  return {
    _id: workspaceId,
    type: 'GYM',
    name: 'Stage 16 Gym',
    ownerUserId,
    status: 'ACTIVE',
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
    createdAt: new Date(),
    updatedAt: new Date(),
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
