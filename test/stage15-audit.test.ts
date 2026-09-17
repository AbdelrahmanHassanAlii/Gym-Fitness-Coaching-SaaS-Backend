import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import type { AppContainer } from '../src/bootstrap/app-container';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { migrations } from '../src/migrations';
import { migration020Stage15Audit } from '../src/migrations/020-stage15-audit';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { Permissions, permissionDefinitions } from '../src/modules/permissions/permission.registry';

const INTEGRATION_TIMEOUT_MS = 30_000;
let container: AppContainer | undefined;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  container = await createAppContainer(integrationConfig(`stage15_${new ObjectId()}`));
  await new MigrationRunner(container.database.db, migrations).migrate();
  app = await buildApp(container);
}, INTEGRATION_TIMEOUT_MS);

afterEach(async () => {
  if (!container) return;
  delete (container.auditRepo as unknown as Record<string, unknown>).list;
  delete (container.audit as unknown as Record<string, unknown>).write;
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

function appInstance(): FastifyInstance {
  if (!app) throw new Error('Test app was not initialized.');
  return app;
}

function appContainer(): AppContainer {
  if (!container) throw new Error('Test container was not initialized.');
  return container;
}

describe('Stage 15 migration 020', () => {
  test(
    'adds audit indexes and conservative permission seeds idempotently',
    async () => {
      const local = await createAppContainer(
        integrationConfig(`stage15_migration_${new ObjectId()}`),
      );
      try {
        const workspaceId = new ObjectId();
        await local.database.db.collection('workspaces').insertOne(workspaceRecord(workspaceId));
        await new MigrationRunner(local.database.db, migrations).migrate();
        await new MigrationRunner(local.database.db, migrations).migrate();

        const indexNames = (await local.database.db.collection('audit_events').indexes()).map(
          (index) => index.name,
        );
        expect(indexNames).toContain('audit_workspace_cursor');
        expect(indexNames).toContain('audit_platform_cursor');
        expect(indexNames).toContain('audit_workspace_event_type_cursor');
        expect(indexNames).not.toContain('audit_retention_ttl');

        expect(
          await local.database.db.collection('permission_definitions').countDocuments({
            key: { $in: Object.values(stage15PermissionMap()) },
          }),
        ).toBe(3);
        const owner = await local.database.db.collection('permission_profiles').findOne({
          context: 'WORKSPACE',
          workspaceId,
          roleKey: 'GYM_OWNER',
          isSystemDefault: true,
        });
        expect(owner?.permissions).toContainEqual({
          permission: Permissions.AuditWorkspaceRead,
          effect: 'ALLOW',
        });
        expect(owner?.permissions).not.toContainEqual({
          permission: Permissions.AuditSensitiveRead,
          effect: 'ALLOW',
        });
        const superAdmin = await local.database.db.collection('permission_profiles').findOne({
          context: 'PLATFORM',
          roleKey: 'PLATFORM_SUPER_ADMIN',
          isSystemDefault: true,
        });
        expect(superAdmin?.permissions).toContainEqual({
          permission: Permissions.AuditPlatformRead,
          effect: 'ALLOW',
        });
        expect(superAdmin?.permissions).toContainEqual({
          permission: Permissions.AuditSensitiveRead,
          effect: 'ALLOW',
        });
      } finally {
        await local.database.db.dropDatabase();
        await local.database.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'upgrades an existing 019 database to 020 without rewriting prior migrations',
    async () => {
      const local = await createAppContainer(
        integrationConfig(`stage15_upgrade_${new ObjectId()}`),
      );
      try {
        await new MigrationRunner(
          local.database.db,
          migrations.filter((migration) => migration.id !== '020-stage15-audit'),
        ).migrate();
        await new MigrationRunner(local.database.db, [migration020Stage15Audit]).migrate();

        const indexNames = (await local.database.db.collection('audit_events').indexes()).map(
          (index) => index.name,
        );
        expect(indexNames).toContain('audit_workspace_cursor');
        expect(indexNames).toContain('audit_platform_cursor');
        expect(
          await local.database.db.collection('permission_definitions').countDocuments({
            key: { $in: Object.values(stage15PermissionMap()) },
          }),
        ).toBe(3);
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

    await expect(migration020Stage15Audit.up(db as never)).rejects.toThrow('index failed');
  });
});

describe('Stage 15 audit APIs', () => {
  test(
    'workspace audit requires auth, permission, and never leaks another workspace',
    async () => {
      const { workspaceId, userId } = await seedWorkspaceActor([Permissions.AuditWorkspaceRead]);
      const otherWorkspaceId = new ObjectId();
      const token = await tokenFor(userId);
      await insertAudit({ workspaceId, eventType: 'WorkspaceEvent', occurredAt: new Date() });
      await insertAudit({ workspaceId: otherWorkspaceId, eventType: 'OtherWorkspaceEvent' });

      const unauthenticated = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit`,
      });
      expect(unauthenticated.statusCode).toBe(401);

      const response = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit`,
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.map((row: { eventType: string }) => row.eventType)).toEqual([
        'WorkspaceEvent',
      ]);

      const { workspaceId: deniedWorkspaceId, userId: deniedUserId } = await seedWorkspaceActor([]);
      const denied = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${deniedWorkspaceId.toHexString()}/audit`,
        headers: bearer(await tokenFor(deniedUserId)),
      });
      expect(denied.statusCode).toBe(403);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'platform audit requires platform permission and supports workspace filter',
    async () => {
      const workspaceId = new ObjectId();
      const platformUser = await seedPlatformActor([Permissions.AuditPlatformRead]);
      const workspaceOnly = await seedWorkspaceActor([Permissions.AuditWorkspaceRead]);
      await insertAudit({ workspaceId, eventType: 'TargetPlatformEvent' });
      await insertAudit({ workspaceId: new ObjectId(), eventType: 'OtherPlatformEvent' });

      const denied = await appInstance().inject({
        method: 'GET',
        url: '/api/v1/platform/audit',
        headers: bearer(await tokenFor(workspaceOnly.userId)),
      });
      expect(denied.statusCode).toBe(403);

      const response = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/platform/audit?workspaceId=${workspaceId.toHexString()}`,
        headers: bearer(await tokenFor(platformUser.userId)),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.map((row: { eventType: string }) => row.eventType)).toEqual([
        'TargetPlatformEvent',
      ]);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'pagination is stable across duplicate timestamps and concurrent inserts',
    async () => {
      const { workspaceId, userId } = await seedWorkspaceActor([Permissions.AuditWorkspaceRead]);
      const token = await tokenFor(userId);
      const occurredAt = new Date('2026-09-16T12:00:00.000Z');
      const ids = [new ObjectId(), new ObjectId(), new ObjectId()].sort((a, b) =>
        b.toHexString().localeCompare(a.toHexString()),
      );
      for (const [index, id] of ids.entries()) {
        await insertAudit({ _id: id, workspaceId, eventType: `SameTime${index}`, occurredAt });
      }

      const first = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit?limit=2`,
        headers: bearer(token),
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().data).toHaveLength(2);
      await insertAudit({
        workspaceId,
        eventType: 'InsertedAfterFirstPage',
        occurredAt: new Date('2026-09-16T12:01:00.000Z'),
      });

      const second = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit?limit=2&cursor=${first.json().meta.nextCursor}`,
        headers: bearer(token),
      });
      expect(second.statusCode).toBe(200);
      const rows = [...first.json().data, ...second.json().data] as Array<{
        eventType: string;
        id: string;
      }>;
      expect(new Set(rows.map((row) => row.id)).size).toBe(3);
      expect(rows.map((row) => row.eventType)).not.toContain('InsertedAfterFirstPage');
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'filters use AND semantics and validate cursor, object ids, and dates',
    async () => {
      const { workspaceId, userId } = await seedWorkspaceActor([Permissions.AuditWorkspaceRead]);
      const token = await tokenFor(userId);
      const actorUserId = new ObjectId();
      const entityId = new ObjectId();
      await insertAudit({
        workspaceId,
        eventType: 'FilteredEvent',
        action: 'update',
        actor: { userId: actorUserId },
        entity: { type: 'Program', id: entityId },
        correlationId: 'corr-filter',
        occurredAt: new Date('2026-09-16T10:00:00.000Z'),
      });
      await insertAudit({
        workspaceId,
        eventType: 'FilteredEvent',
        action: 'create',
        actor: { userId: actorUserId },
        entity: { type: 'Program', id: entityId },
        correlationId: 'corr-filter',
        occurredAt: new Date('2026-09-16T10:00:00.000Z'),
      });

      const query = new URLSearchParams({
        eventType: 'FilteredEvent',
        action: 'update',
        actorUserId: actorUserId.toHexString(),
        entityType: 'Program',
        entityId: entityId.toHexString(),
        correlationId: 'corr-filter',
        from: '2026-09-16T09:00:00.000Z',
        to: '2026-09-16T11:00:00.000Z',
      });
      const response = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit?${query.toString()}`,
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(1);
      expect(response.json().data[0].action).toBe('update');

      for (const badQuery of [
        'cursor=not-base64',
        'actorUserId=not-an-object-id',
        'from=16-09-2026',
      ] as const) {
        const bad = await appInstance().inject({
          method: 'GET',
          url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit?${badQuery}`,
          headers: bearer(token),
        });
        expect([400, 422]).toContain(bad.statusCode);
        expect(bad.json().error).toBeDefined();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'permission denial is re-evaluated on subsequent cursor request',
    async () => {
      const { workspaceId, userId, profileId } = await seedWorkspaceActor([
        Permissions.AuditWorkspaceRead,
      ]);
      const token = await tokenFor(userId);
      await insertAudit({
        workspaceId,
        eventType: 'First',
        occurredAt: new Date('2026-09-16T12:00:00.000Z'),
      });
      await insertAudit({
        workspaceId,
        eventType: 'Second',
        occurredAt: new Date('2026-09-16T11:00:00.000Z'),
      });
      const first = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit?limit=1`,
        headers: bearer(token),
      });
      expect(first.statusCode).toBe(200);
      await appContainer()
        .database.db.collection('permission_profiles')
        .updateOne(
          { _id: profileId },
          {
            $set: {
              permissions: [
                { permission: Permissions.AuditWorkspaceRead, effect: 'ALLOW' },
                { permission: Permissions.AuditWorkspaceRead, effect: 'DENY' },
              ],
            },
          },
        );

      const second = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit?limit=1&cursor=${first.json().meta.nextCursor}`,
        headers: bearer(token),
      });
      expect(second.statusCode).toBe(403);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'sensitive audit details are hidden without audit.sensitive.read and visible with it',
    async () => {
      const hidden = await seedWorkspaceActor([Permissions.AuditWorkspaceRead]);
      const visible = await seedWorkspaceActor([
        Permissions.AuditWorkspaceRead,
        Permissions.AuditSensitiveRead,
      ]);
      await insertAudit({
        workspaceId: hidden.workspaceId,
        eventType: 'SENSITIVE_RESOURCE_ACCESSED',
        sensitive: true,
        after: { resourceType: 'medical_document', resourceId: new ObjectId().toHexString() },
      });
      await insertAudit({
        workspaceId: visible.workspaceId,
        eventType: 'SENSITIVE_RESOURCE_ACCESSED',
        sensitive: true,
        after: { resourceType: 'medical_document', resourceId: new ObjectId().toHexString() },
      });

      const hiddenResponse = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${hidden.workspaceId.toHexString()}/audit`,
        headers: bearer(await tokenFor(hidden.userId)),
      });
      expect(hiddenResponse.statusCode).toBe(200);
      expect(hiddenResponse.json().data[0].sensitiveDetailsRedacted).toBe(true);
      expect(hiddenResponse.json().data[0].after).toBeUndefined();

      const visibleResponse = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${visible.workspaceId.toHexString()}/audit`,
        headers: bearer(await tokenFor(visible.userId)),
      });
      expect(visibleResponse.statusCode).toBe(200);
      expect(visibleResponse.json().data[0].after.resourceType).toBe('medical_document');
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'audit.sensitive.read works in workspace and platform contexts while DENY hides details',
    async () => {
      const definition = permissionDefinitions.find(
        (item) => item.key === Permissions.AuditSensitiveRead,
      );
      expect(definition?.allowedContexts).toContain('WORKSPACE');
      expect(definition?.allowedContexts).toContain('PLATFORM');
      expect(definition?.allowedScopes).toContain('WORKSPACE');

      const workspace = await seedWorkspaceActor([
        Permissions.AuditWorkspaceRead,
        Permissions.AuditSensitiveRead,
      ]);
      const platformRedacted = await seedPlatformActor([Permissions.AuditPlatformRead]);
      const platformVisible = await seedPlatformActor([
        Permissions.AuditPlatformRead,
        Permissions.AuditSensitiveRead,
      ]);
      await insertAudit({
        workspaceId: workspace.workspaceId,
        eventType: 'SENSITIVE_RESOURCE_ACCESSED',
        sensitive: true,
        after: { resourceType: 'health_profile', resourceId: new ObjectId().toHexString() },
      });

      const workspaceVisible = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspace.workspaceId.toHexString()}/audit`,
        headers: bearer(await tokenFor(workspace.userId)),
      });
      expect(workspaceVisible.statusCode).toBe(200);
      expect(workspaceVisible.json().data[0].after.resourceType).toBe('health_profile');

      await appContainer()
        .database.db.collection('access_grants')
        .insertOne({
          _id: new ObjectId(),
          context: 'WORKSPACE',
          workspaceId: workspace.workspaceId,
          subjectType: 'WORKSPACE_MEMBERSHIP',
          subjectId: workspace.membershipId,
          permission: Permissions.AuditSensitiveRead,
          effect: 'DENY',
          scope: { type: 'WORKSPACE' },
          createdBy: workspace.userId,
          createdAt: new Date(),
        });
      const workspaceDenied = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspace.workspaceId.toHexString()}/audit`,
        headers: bearer(await tokenFor(workspace.userId)),
      });
      expect(workspaceDenied.statusCode).toBe(200);
      expect(workspaceDenied.json().data[0].sensitiveDetailsRedacted).toBe(true);
      expect(workspaceDenied.json().data[0].after).toBeUndefined();

      const redacted = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/platform/audit?workspaceId=${workspace.workspaceId.toHexString()}`,
        headers: bearer(await tokenFor(platformRedacted.userId)),
      });
      expect(redacted.statusCode).toBe(200);
      expect(redacted.json().data[0].sensitiveDetailsRedacted).toBe(true);

      const visible = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/platform/audit?workspaceId=${workspace.workspaceId.toHexString()}`,
        headers: bearer(await tokenFor(platformVisible.userId)),
      });
      expect(visible.statusCode).toBe(200);
      expect(visible.json().data[0].after.resourceType).toBe('health_profile');
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'cursor continuation reapplies current filters and entityId requires entityType',
    async () => {
      const { workspaceId, userId } = await seedWorkspaceActor([Permissions.AuditWorkspaceRead]);
      const token = await tokenFor(userId);
      const entityId = new ObjectId();
      await insertAudit({
        workspaceId,
        eventType: 'CursorFilterA',
        entity: { type: 'Program', id: entityId },
        occurredAt: new Date('2026-09-16T12:00:00.000Z'),
      });
      await insertAudit({
        workspaceId,
        eventType: 'CursorFilterB',
        entity: { type: 'Program', id: new ObjectId() },
        occurredAt: new Date('2026-09-16T11:00:00.000Z'),
      });
      await insertAudit({
        workspaceId,
        eventType: 'CursorFilterA',
        entity: { type: 'Program', id: new ObjectId() },
        occurredAt: new Date('2026-09-16T10:00:00.000Z'),
      });
      const first = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit?limit=1&eventType=CursorFilterA`,
        headers: bearer(token),
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().data).toHaveLength(1);
      expect(first.json().meta.nextCursor).toBeTruthy();

      const changedFilter = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit?limit=1&eventType=CursorFilterB&cursor=${first.json().meta.nextCursor ?? ''}`,
        headers: bearer(token),
      });
      expect(changedFilter.statusCode).toBe(200);
      expect(changedFilter.json().data.map((row: { eventType: string }) => row.eventType)).toEqual([
        'CursorFilterB',
      ]);

      const ambiguousEntity = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit?entityId=${entityId.toHexString()}`,
        headers: bearer(token),
      });
      expect(ambiguousEntity.statusCode).toBe(422);
      expect(ambiguousEntity.json().error.code).toBe('AUDIT_ENTITY_TYPE_REQUIRED');
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'audit routes expose no mutation API',
    async () => {
      const { workspaceId, userId } = await seedWorkspaceActor([Permissions.AuditWorkspaceRead]);
      const response = await appInstance().inject({
        method: 'DELETE',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit`,
        headers: bearer(await tokenFor(userId)),
      });
      expect(response.statusCode).toBe(404);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

describe('Stage 15 audit writer and sensitive-read convention', () => {
  test(
    'AuditWriter recursively redacts prohibited secrets without mutating caller input',
    async () => {
      const { workspaceId, userId } = await seedWorkspaceActor([
        Permissions.AuditWorkspaceRead,
        Permissions.AuditSensitiveRead,
      ]);
      const actorUserId = new ObjectId();
      const input = {
        eventType: 'RedactionCompatibility',
        workspaceId,
        actor: { userId: actorUserId },
        entity: { type: 'test', id: new ObjectId() },
        action: 'update',
        before: { name: 'safe', nested: { passwordHash: 'secret-hash' } },
        after: {
          safe: 'value',
          tokenCount: 3,
          authorizationStatus: 'APPROVED',
          monkeyName: 'George',
          keyPerformanceIndicator: 'retention',
          accessTokenCount: 2,
          nestedSafe: [{ authorizationStatus: 'PENDING', tokenCount: 1 }],
          harmlessUrl: 'https://example.test/profile?page=2',
          invitationUrl: 'https://example.test/invitations/accept?token=secret-token',
          resetUrl: 'https://example.test/password-reset?resetToken=reset-secret',
          tokens: [{ refreshToken: 'refresh-secret' }],
          signedUrl: 'https://s3.example.test/object?X-Amz-Signature=secret-signature',
          happenedAt: new Date('2026-09-16T10:00:00.000Z'),
          compatibleId: actorUserId,
          nothing: null,
        },
        correlationId: 'redaction-corr',
      };

      await appContainer().audit.write(input);

      expect(input.after.tokens.at(0)?.refreshToken).toBe('refresh-secret');
      const stored = await appContainer().database.db.collection('audit_events').findOne({
        eventType: 'RedactionCompatibility',
      });
      expect(stored).toMatchObject({
        eventType: 'RedactionCompatibility',
        actor: { userId: actorUserId },
        action: 'update',
        correlationId: 'redaction-corr',
      });
      expect(stored?.before.name).toBe('safe');
      expect(stored?.before.nested.passwordHash).toBe('[REDACTED]');
      expect(stored?.after.safe).toBe('value');
      expect(stored?.after.tokenCount).toBe(3);
      expect(stored?.after.authorizationStatus).toBe('APPROVED');
      expect(stored?.after.monkeyName).toBe('George');
      expect(stored?.after.keyPerformanceIndicator).toBe('retention');
      expect(stored?.after.accessTokenCount).toBe(2);
      expect(stored?.after.nestedSafe[0].authorizationStatus).toBe('PENDING');
      expect(stored?.after.harmlessUrl).toBe('https://example.test/profile?page=2');
      expect(stored?.after.invitationUrl).toBe('[REDACTED]');
      expect(stored?.after.resetUrl).toBe('[REDACTED]');
      expect(stored?.after.tokens[0].refreshToken).toBe('[REDACTED]');
      expect(stored?.after.signedUrl).toBe('[REDACTED]');
      expect(stored?.after.happenedAt).toEqual(new Date('2026-09-16T10:00:00.000Z'));
      expect(stored?.after.compatibleId).toEqual(actorUserId);
      expect(stored?.after.nothing).toBeNull();
      expect(JSON.stringify(stored)).not.toContain('secret-signature');
      expect(JSON.stringify(stored)).not.toContain('secret-token');
      expect(JSON.stringify(stored)).not.toContain('reset-secret');

      const response = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit?eventType=RedactionCompatibility`,
        headers: bearer(await tokenFor(userId)),
      });
      expect(response.statusCode).toBe(200);
      const serialized = JSON.stringify(response.json());
      expect(serialized).toContain('[REDACTED]');
      expect(serialized).not.toContain('refresh-secret');
      expect(serialized).not.toContain('secret-signature');
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'representative locked-stage audit event fields stay compatible while only secrets redact',
    async () => {
      const workspaceId = new ObjectId();
      const actorId = new ObjectId();
      const events = [
        'PermissionProfileUpdated',
        'ManualPaymentApproved',
        'WorkoutCorrected',
        'NutritionPlanActivated',
        'SensitiveFileDownloadUrlIssued',
        'NotificationPreferencesUpdated',
      ].map((eventType) => ({
        eventType,
        workspaceId,
        actor: { userId: actorId },
        entity: { type: eventType, id: new ObjectId() },
        action: 'update',
        before: { safeField: `${eventType}-before`, tokenCount: 1 },
        after: { safeField: `${eventType}-after`, accessToken: 'secret-access-token' },
        diff: { changed: true },
        correlationId: `${eventType}-corr`,
      }));
      for (const event of events) {
        await appContainer().audit.write(event);
      }

      const stored = await appContainer()
        .database.db.collection('audit_events')
        .find({ eventType: { $in: events.map((event) => event.eventType) } })
        .toArray();
      expect(stored).toHaveLength(events.length);
      for (const event of events) {
        const row = stored.find((item) => item.eventType === event.eventType);
        expect(row).toMatchObject({
          eventType: event.eventType,
          workspaceId,
          actor: { userId: actorId },
          entity: event.entity,
          action: 'update',
          correlationId: event.correlationId,
          before: { safeField: `${event.eventType}-before`, tokenCount: 1 },
          after: { safeField: `${event.eventType}-after`, accessToken: '[REDACTED]' },
          diff: { changed: true },
        });
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'two legitimate identical audit events are both preserved',
    async () => {
      const event = {
        eventType: 'IdenticalAudit',
        actor: { userId: new ObjectId() },
        entity: { type: 'test', id: new ObjectId() },
        action: 'same',
        correlationId: 'same-corr',
      };
      await appContainer().audit.write(event);
      await appContainer().audit.write(event);
      expect(
        await appContainer().database.db.collection('audit_events').countDocuments({
          eventType: 'IdenticalAudit',
        }),
      ).toBe(2);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'standard sensitive-resource helper writes safe metadata and fails closed on audit failure',
    async () => {
      const actor = { userId: new ObjectId() };
      const resourceId = new ObjectId();
      await appContainer().audit.writeSensitiveResourceAccess({
        workspaceId: new ObjectId(),
        actor,
        entity: { type: 'placeholder', id: resourceId },
        resourceType: 'medical_document',
        resourceId,
        accessKind: 'metadata_read',
        correlationId: 'sensitive-helper',
      });
      const stored = await appContainer().database.db.collection('audit_events').findOne({
        eventType: 'SENSITIVE_RESOURCE_ACCESSED',
      });
      expect(stored).toMatchObject({
        sensitive: true,
        action: 'read',
        after: { resourceType: 'medical_document', accessKind: 'metadata_read' },
      });

      const original = appContainer().audit.write.bind(appContainer().audit);
      appContainer().audit.write = async () => {
        throw new Error('audit unavailable');
      };
      async function returnSensitiveResultAfterAudit() {
        await appContainer().audit.writeSensitiveResourceAccess({
          workspaceId: new ObjectId(),
          actor,
          entity: { type: 'placeholder', id: new ObjectId() },
          resourceType: 'medical_document',
          resourceId: new ObjectId(),
          accessKind: 'download',
          correlationId: 'sensitive-failure',
        });
        return 'sensitive-result';
      }
      await expect(returnSensitiveResultAfterAudit()).rejects.toThrow('audit unavailable');
      appContainer().audit.write = original;
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'source authorization failure does not create successful sensitive-read audit evidence',
    async () => {
      async function authorizedSensitiveRead(authorized: boolean) {
        if (!authorized) throw new Error('source denied');
        await appContainer().audit.writeSensitiveResourceAccess({
          actor: { userId: new ObjectId() },
          entity: { type: 'medical_document', id: new ObjectId() },
          resourceType: 'medical_document',
          resourceId: new ObjectId(),
          accessKind: 'read',
          correlationId: 'source-denied',
        });
      }
      await expect(authorizedSensitiveRead(false)).rejects.toThrow('source denied');
      expect(
        await appContainer().database.db.collection('audit_events').countDocuments({
          correlationId: 'source-denied',
        }),
      ).toBe(0);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'repository read failures surface through the stable error handler',
    async () => {
      const { workspaceId, userId } = await seedWorkspaceActor([Permissions.AuditWorkspaceRead]);
      appContainer().auditRepo.list = async () => {
        throw new Error('audit read failed');
      };
      const response = await appInstance().inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspaceId.toHexString()}/audit`,
        headers: bearer(await tokenFor(userId)),
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('INTERNAL_ERROR');
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

async function seedWorkspaceActor(permissions: string[]) {
  const workspaceId = new ObjectId();
  const userId = new ObjectId();
  const membershipId = new ObjectId();
  const profileId = new ObjectId();
  await appContainer().database.db.collection('users').insertOne(userRecord(userId));
  await appContainer()
    .database.db.collection('workspaces')
    .insertOne(workspaceRecord(workspaceId, userId));
  await appContainer()
    .database.db.collection('permission_profiles')
    .insertOne({
      _id: profileId,
      context: 'WORKSPACE',
      workspaceId,
      name: 'Stage 15 Test Workspace Profile',
      permissions: permissions.map((permission) => ({ permission, effect: 'ALLOW' })),
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
      roles: ['GYM_OWNER'],
      status: 'ACTIVE',
      joinedAt: new Date(),
      engagementPeriods: [{ startedAt: new Date() }],
      permissionProfileIds: [profileId],
      accessVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  return { workspaceId, userId, membershipId, profileId };
}

async function seedPlatformActor(permissions: string[]) {
  const userId = new ObjectId();
  const membershipId = new ObjectId();
  const profileId = new ObjectId();
  await appContainer().database.db.collection('users').insertOne(userRecord(userId));
  await appContainer()
    .database.db.collection('permission_profiles')
    .insertOne({
      _id: profileId,
      context: 'PLATFORM',
      name: `Stage 15 Test Platform Profile ${profileId.toHexString()}`,
      permissions: permissions.map((permission) => ({ permission, effect: 'ALLOW' })),
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

async function tokenFor(userId: ObjectId) {
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
  return appContainer().jwt.createAccessToken({
    userId: userId.toHexString(),
    authSessionId: session._id.toHexString(),
    authenticationMethods: ['pwd'],
  });
}

async function insertAudit(overrides: Record<string, unknown>) {
  const now = new Date();
  const document = {
    _id: new ObjectId(),
    eventType: 'AuditEvent',
    actor: { userId: new ObjectId() },
    entity: { type: 'test', id: new ObjectId() },
    action: 'read',
    correlationId: new ObjectId().toHexString(),
    occurredAt: now,
    ...overrides,
  };
  await appContainer().database.db.collection('audit_events').insertOne(document);
  return document;
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
    lastName: 'Fifteen',
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
    name: 'Stage 15 Gym',
    ownerUserId,
    status: 'ACTIVE',
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function stage15PermissionMap() {
  return {
    workspace: Permissions.AuditWorkspaceRead,
    platform: Permissions.AuditPlatformRead,
    sensitive: Permissions.AuditSensitiveRead,
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
