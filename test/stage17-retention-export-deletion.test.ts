import { describe, expect, test } from 'bun:test';
import { type Db, ObjectId } from 'mongodb';
import type { AppContainer } from '../src/bootstrap/app-container';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { FakeStorageProvider } from '../src/core/storage/fake-storage.provider';
import type { ObjectMetadata } from '../src/core/storage/storage.provider';
import { migrations } from '../src/migrations';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { WorkspaceExportApplicationService } from '../src/modules/exports/export.service';
import type { WorkspaceExportRequestDocument } from '../src/modules/exports/export.types';
import { FileApplicationService } from '../src/modules/files/file.service';
import type { FileDocument } from '../src/modules/files/file.types';
import {
  Permissions,
  systemPermissionProfiles,
} from '../src/modules/permissions/permission.registry';
import { deletionTargets } from '../src/modules/retention/retention.repository';
import type { WorkspaceDeletionRequestDocument } from '../src/modules/retention/retention.types';
import type { SubscriptionDocument } from '../src/modules/subscriptions/subscription.types';
import { INTEGRATION_TEST_TIMEOUT_MS } from './integration-timeouts';

describe('Stage 17 migration and indexes', () => {
  test(
    'creates exact Stage 17 collections, indexes, and permission grants',
    async () => {
      const container = await stage17Container('stage17_migration');
      try {
        const exportIndexes = await container.database.db
          .collection('workspace_export_requests')
          .indexes();
        expect(exportIndexes).toContainEqual(
          expect.objectContaining({
            name: 'workspace_exports_one_active_per_requester',
            unique: true,
          }),
        );
        expect(
          exportIndexes.find((index) => index.name === 'workspace_exports_one_active_per_requester')
            ?.partialFilterExpression,
        ).toEqual({ status: { $in: ['PENDING', 'PROCESSING', 'READY'] } });
        const deletionIndexes = await container.database.db
          .collection('workspace_deletion_requests')
          .indexes();
        expect(
          deletionIndexes.find(
            (index) => index.name === 'workspace_deletions_one_active_per_workspace',
          )?.partialFilterExpression,
        ).toEqual({
          status: { $in: ['PENDING_APPROVAL', 'POSTPONED', 'APPROVED', 'PROCESSING', 'FAILED'] },
        });
        const warningIndexes = await container.database.db
          .collection('retention_warning_markers')
          .indexes();
        expect(warningIndexes).toContainEqual(
          expect.objectContaining({
            name: 'retention_warning_one_per_expiry_cycle_offset',
            unique: true,
          }),
        );
        const seeded = await container.database.db
          .collection('permission_definitions')
          .countDocuments({
            key: {
              $in: [
                Permissions.ExportsWorkspaceCreate,
                Permissions.ExportsWorkspaceRead,
                Permissions.ExportsWorkspaceDownload,
                Permissions.DeletionRead,
                Permissions.DeletionApprove,
                Permissions.DeletionPostpone,
                Permissions.DeletionCancel,
              ],
            },
          });
        expect(seeded).toBe(7);
        const subscriptionAdmin = systemPermissionProfiles.find(
          (profile) => profile.roleKey === 'SUBSCRIPTION_ADMIN',
        );
        expect(subscriptionAdmin?.permissions.map((entry) => entry.permission)).not.toContain(
          Permissions.DeletionApprove,
        );
      } finally {
        await dispose(container);
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    'Mongo indexes enforce active export and active deletion invariants',
    async () => {
      const container = await stage17Container('stage17_indexes');
      try {
        const workspaceId = new ObjectId();
        const requesterId = new ObjectId();
        await insertExport(container.database.db, {
          workspaceId,
          requestedByUserId: requesterId,
          status: 'PENDING',
        });
        await expect(
          insertExport(container.database.db, {
            workspaceId,
            requestedByUserId: requesterId,
            status: 'PROCESSING',
          }),
        ).rejects.toMatchObject({ code: 11000 });
        await container.database.db
          .collection('workspace_export_requests')
          .updateOne(
            { workspaceId, requestedByUserId: requesterId },
            { $set: { status: 'FAILED', failedAt: new Date() } },
          );
        await insertExport(container.database.db, {
          workspaceId,
          requestedByUserId: requesterId,
          status: 'READY',
        });
        await expect(
          insertExport(container.database.db, {
            workspaceId,
            requestedByUserId: requesterId,
            status: 'PENDING',
          }),
        ).rejects.toMatchObject({ code: 11000 });
        await container.database.db
          .collection('workspace_export_requests')
          .updateOne(
            { workspaceId, requestedByUserId: requesterId, status: 'READY' },
            { $set: { status: 'EXPIRED', expiredAt: new Date(), expiresAt: new Date() } },
          );
        await insertExport(container.database.db, {
          workspaceId,
          requestedByUserId: requesterId,
          status: 'PENDING',
        });

        await insertDeletion(container.database.db, { workspaceId, status: 'PENDING_APPROVAL' });
        await expect(
          insertDeletion(container.database.db, { workspaceId, status: 'APPROVED' }),
        ).rejects.toMatchObject({
          code: 11000,
        });
        await container.database.db
          .collection('workspace_deletion_requests')
          .updateOne(
            { workspaceId, status: 'PENDING_APPROVAL' },
            { $set: { status: 'CANCELLED' } },
          );
        await insertDeletion(container.database.db, { workspaceId, status: 'FAILED' });
        await expect(
          insertDeletion(container.database.db, { workspaceId, status: 'PROCESSING' }),
        ).rejects.toMatchObject({
          code: 11000,
        });
      } finally {
        await dispose(container);
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe('Stage 17 exports', () => {
  test(
    'processing claims are reclaimable and stale workers cannot publish READY or FAILED',
    async () => {
      const container = await stage17Container('stage17_claims');
      try {
        const seed = await seedWorkspace(container);
        const exportDoc = await container.unitOfWork.withTransaction((tx) =>
          container.exportsRepo.create(
            exportDocument(seed.workspaceId, seed.ownerId, seed.ownerMembershipId),
            tx,
          ),
        );
        const first = await container.exportsRepo.claimNext({
          now: new Date('2026-01-01T00:00:00.000Z'),
          workerId: 'worker-a',
          leaseMs: 1000,
        });
        expect(first?.exportRequest.status).toBe('PROCESSING');
        expect(first?.claimId).toBeTruthy();
        await container.database.db
          .collection('workspace_export_requests')
          .updateOne(
            { _id: exportDoc._id },
            { $set: { processingLeaseExpiresAt: new Date('2025-12-31T23:59:59.000Z') } },
          );
        const second = await container.exportsRepo.claimNext({
          now: new Date('2026-01-01T00:01:00.000Z'),
          workerId: 'worker-b',
          leaseMs: 60_000,
        });
        expect(second?.claimId).not.toBe(first?.claimId);
        await expect(
          container.unitOfWork.withTransaction((tx) =>
            container.exportsRepo.markReady(
              {
                exportId: exportDoc._id,
                workspaceId: seed.workspaceId,
                claimId: first?.claimId ?? 'missing',
                now: new Date('2026-01-01T00:01:01.000Z'),
                expiresAt: new Date('2026-01-08T00:01:01.000Z'),
                artifactFileId: new ObjectId(),
                artifactSizeBytes: 1,
                artifactSha256: 'abc',
              },
              tx,
            ),
          ),
        ).rejects.toMatchObject({ code: 'EXPORT_CLAIM_STALE' });
        const staleFailure = await container.exportsRepo.markFailed({
          exportId: exportDoc._id,
          workspaceId: seed.workspaceId,
          claimId: first?.claimId ?? 'missing',
          now: new Date(),
          code: 'STALE',
        });
        expect(staleFailure).toBeNull();
        await container.unitOfWork.withTransaction((tx) =>
          container.exportsRepo.markReady(
            {
              exportId: exportDoc._id,
              workspaceId: seed.workspaceId,
              claimId: second?.claimId ?? 'missing',
              now: new Date('2026-01-01T00:01:02.000Z'),
              expiresAt: new Date('2026-01-08T00:01:02.000Z'),
              artifactFileId: new ObjectId(),
              artifactSizeBytes: 1,
              artifactSha256: 'abc',
            },
            tx,
          ),
        );
        const ready = await container.exportsRepo.findById(seed.workspaceId, exportDoc._id);
        expect(ready?.status).toBe('READY');
      } finally {
        await dispose(container);
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    'generated export artifacts are hidden from generic Stage 13 routes and orphan intents are cleaned',
    async () => {
      const container = await stage17Container('stage17_generated_files');
      const storage = installFakeStage17Storage(container);
      try {
        const seed = await seedWorkspace(container);
        const relationshipId = await seedRelationship(
          container.database.db,
          seed.workspaceId,
          seed.ownerId,
        );
        const exportId = new ObjectId();
        const file = generatedFile(seed.workspaceId, exportId);
        await container.database.db.collection('files').insertOne(file);
        await expectErrorCode(
          container.files.createDownloadUrl(
            seed.ownerCtx,
            seed.workspaceId.toHexString(),
            file._id.toHexString(),
          ),
          'FILE_NOT_FOUND',
        );
        await expectErrorCode(
          container.unitOfWork.withTransaction((tx) =>
            container.files.createDocument(
              seed.ownerCtx,
              seed.workspaceId.toHexString(),
              relationshipId.toHexString(),
              { fileId: file._id.toHexString(), category: 'OTHER' },
              tx,
            ),
          ),
          'FILE_NOT_FOUND',
        );

        const intentId = new ObjectId();
        const key = 'workspaces/generated/orphan.zip';
        storage.putObject({ key, sizeBytes: 10, contentType: 'application/zip' });
        await container.database.db.collection('generated_file_intents').insertOne({
          _id: intentId,
          workspaceId: seed.workspaceId,
          purpose: 'WORKSPACE_EXPORT',
          exportId: new ObjectId(),
          storageProvider: storage.provider,
          storageKey: key,
          status: 'OBJECT_WRITTEN',
          sizeBytes: 10,
          checksumSha256: 'abc',
          createdAt: new Date(),
          objectWrittenAt: new Date(),
          updatedAt: new Date(),
        });
        expect(await container.files.cleanupGeneratedFileIntents()).toBe(1);
        expect(await storage.statObject(key)).toBeNull();
        expect(
          await container.database.db
            .collection('generated_file_intents')
            .findOne({ _id: intentId }),
        ).toMatchObject({ status: 'CLEANED' });
      } finally {
        await dispose(container);
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    'ready export TTL, metadata-only archive policy, and deletion approval termination are enforced',
    async () => {
      const container = await stage17Container('stage17_export_generate');
      const storage = installFakeStage17Storage(container);
      try {
        const seed = await seedWorkspace(container);
        await container.database.db.collection('files').insertOne(userUploadFile(seed.workspaceId));
        const created = await container.unitOfWork.withTransaction((tx) =>
          container.exports.create(seed.ownerCtx, seed.workspaceId.toHexString(), tx),
        );
        expect(created.export.status).toBe('PENDING');
        expect(await container.exports.generateDue()).toBe(1);
        const ready = await container.database.db.collection('workspace_export_requests').findOne({
          _id: new ObjectId(created.export.id),
        });
        expect(ready?.status).toBe('READY');
        expect(ready?.expiresAt.getTime() - ready?.completedAt.getTime()).toBe(
          7 * 24 * 60 * 60 * 1000,
        );
        const artifact = await container.database.db
          .collection('files')
          .findOne({ _id: ready?.artifactFileId });
        expect(artifact).toMatchObject({
          origin: 'SYSTEM_GENERATED',
          generatedPurpose: 'WORKSPACE_EXPORT',
          classification: 'SENSITIVE',
          status: 'ACTIVE',
        });
        const zipBody = storage.bodyFor(String(artifact?.storageKey));
        expect(Buffer.from(zipBody).toString('utf8')).toContain(
          'Uploaded Stage 13 binary objects are excluded',
        );
        expect(Buffer.from(zipBody).toString('utf8')).not.toContain(
          String(
            (await container.database.db.collection('files').findOne({ origin: 'USER_UPLOAD' }))
              ?.storageKey,
          ),
        );

        await seedExpiredDeletion(container, seed);
        const deletion = await container.database.db
          .collection('workspace_deletion_requests')
          .findOne({
            workspaceId: seed.workspaceId,
          });
        await container.retention.approve(seed.platformCtx, deletion?._id.toHexString() ?? '', {
          expectedVersion: 0,
          reason: 'External approval',
        });
        const expired = await container.database.db
          .collection('workspace_export_requests')
          .findOne({
            _id: new ObjectId(created.export.id),
          });
        expect(expired).toMatchObject({
          status: 'EXPIRED',
          expirationReason: 'WORKSPACE_DELETION_APPROVED',
        });
        const purged = await container.database.db
          .collection('files')
          .findOne({ _id: ready?.artifactFileId });
        expect(purged?.status).toBe('PURGE_PENDING');
      } finally {
        await dispose(container);
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe('Stage 17 retention and deletion', () => {
  test(
    'warning markers dedupe per expiry cycle and allow a later cycle',
    async () => {
      const container = await stage17Container('stage17_warnings');
      try {
        const seed = await seedWorkspace(container, {
          subscriptionStatus: 'EXPIRED',
          expiredAt: new Date('2026-01-01T00:00:00.000Z'),
        });
        expect(await container.retention.sendWarnings()).toBe(3);
        expect(await container.retention.sendWarnings()).toBe(0);
        await container.database.db.collection('subscriptions').updateOne(
          { _id: seed.subscriptionId },
          {
            $set: {
              expiredAt: new Date('2026-02-01T00:00:00.000Z'),
              updatedAt: new Date(),
            },
            $inc: { version: 1 },
          },
        );
        expect(await container.retention.sendWarnings()).toBe(3);
        expect(
          await container.database.db.collection('retention_warning_markers').countDocuments(),
        ).toBe(6);
      } finally {
        await dispose(container);
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  test('deletion processor removes explicit live-data manifest, preserves retained evidence, and finalizes tombstone', async () => {
    const container = await stage17Container('stage17_delete_manifest');
    try {
      const target = await seedWorkspace(container);
      const other = await seedWorkspace(container);
      const proofFile = generatedFile(target.workspaceId, new ObjectId(), 'USER_UPLOAD');
      const normalFile = generatedFile(target.workspaceId, new ObjectId(), 'USER_UPLOAD');
      await container.database.db.collection('files').insertMany([proofFile, normalFile]);
      await container.database.db.collection('manual_payments').insertOne({
        _id: new ObjectId(),
        workspaceId: target.workspaceId,
        subscriptionId: target.subscriptionId,
        amount: 100,
        currency: 'USD',
        paymentMethod: 'BANK',
        proofFileId: proofFile._id,
        status: 'APPROVED',
        createdBy: target.ownerId,
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 0,
      });
      await seedManifestRecords(container.database.db, target.workspaceId);
      await seedManifestRecords(container.database.db, other.workspaceId);
      await container.database.db.collection('documents').insertOne({
        _id: new ObjectId(),
        workspaceId: target.workspaceId,
        relationshipId: new ObjectId(),
        fileId: normalFile._id,
        category: 'OTHER',
        uploadedByUserId: target.ownerId,
        classification: 'STANDARD',
        status: 'ACTIVE',
        version: 0,
        createdAt: new Date(),
      });
      await insertDeletion(container.database.db, {
        workspaceId: target.workspaceId,
        status: 'APPROVED',
        subscriptionId: target.subscriptionId,
      });
      await container.database.db.collection('workspaces').updateOne(
        { _id: target.workspaceId },
        {
          $set: {
            status: 'RESTRICTED',
            deletionLockRequestId: await deletionId(container.database.db, target.workspaceId),
          },
        },
      );
      await container.database.db.collection('subscriptions').updateOne(
        { _id: target.subscriptionId },
        {
          $set: {
            deletionLockRequestId: await deletionId(container.database.db, target.workspaceId),
          },
        },
      );

      expect(await container.retention.processDeletions('worker-a')).toBe(1);

      for (const targetDef of deletionTargets) {
        expect(
          await container.database.db
            .collection(targetDef.collection)
            .countDocuments(targetDef.predicate(target.workspaceId)),
        ).toBe(0);
        expect(
          await container.database.db
            .collection(targetDef.collection)
            .countDocuments(targetDef.predicate(other.workspaceId)),
        ).toBeGreaterThan(0);
      }
      expect(
        (await container.database.db.collection('files').findOne({ _id: proofFile._id }))?.status,
      ).toBe('ACTIVE');
      expect(
        (await container.database.db.collection('files').findOne({ _id: normalFile._id }))?.status,
      ).toBe('PURGE_PENDING');
      expect(
        await container.database.db
          .collection('manual_payments')
          .countDocuments({ workspaceId: target.workspaceId }),
      ).toBe(1);
      expect(
        (await container.database.db.collection('workspaces').findOne({ _id: target.workspaceId }))
          ?.status,
      ).toBe('ARCHIVED');
      expect(
        (
          await container.database.db
            .collection('workspace_deletion_requests')
            .findOne({ workspaceId: target.workspaceId })
        )?.status,
      ).toBe('COMPLETED');
    } finally {
      await dispose(container);
    }
  }, 120_000);

  test(
    'deletion approval and subscription reactivation serialize on the same subscription version',
    async () => {
      const container = await stage17Container('stage17_approval_renewal');
      try {
        const seed = await seedWorkspace(container, {
          subscriptionStatus: 'EXPIRED',
          expiredAt: new Date('2025-01-01T00:00:00.000Z'),
        });
        const planVersionId = await seedPlanVersion(container.database.db, seed.ownerId);
        await seedExpiredDeletion(container, seed);
        const deletion = await container.database.db
          .collection('workspace_deletion_requests')
          .findOne({
            workspaceId: seed.workspaceId,
          });
        if (!deletion?._id) throw new Error('missing deletion request');
        const deletionObjectId = deletion._id as ObjectId;
        const results = await Promise.allSettled([
          container.subscriptions.reactivate(seed.ownerCtx, seed.workspaceId.toHexString(), {
            expectedVersion: 0,
            planVersionId: planVersionId.toHexString(),
            billingPeriod: 'MONTHLY',
            effectiveFrom: '2026-01-01T00:00:00.000Z',
          }),
          container.retention.approve(seed.platformCtx, deletionObjectId.toHexString(), {
            expectedVersion: 0,
            reason: 'Concurrent deletion approval',
          }),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const subscription = await container.database.db.collection('subscriptions').findOne({
          _id: seed.subscriptionId,
        });
        const updatedDeletion = await container.database.db
          .collection('workspace_deletion_requests')
          .findOne({ _id: deletionObjectId });
        const workspace = await container.database.db.collection('workspaces').findOne({
          _id: seed.workspaceId,
        });
        expect(
          subscription?.lifecycleStatus === 'ACTIVE' && updatedDeletion?.status === 'APPROVED',
        ).toBe(false);
        if (subscription?.lifecycleStatus === 'ACTIVE') {
          expect(updatedDeletion?.status).toBe('CANCELLED');
          expect(updatedDeletion?.cancelledBy).toMatchObject({
            type: 'SYSTEM',
            reason: 'SUBSCRIPTION_REACTIVATED_BEFORE_APPROVAL',
          });
          expect(workspace?.status).toBe('ACTIVE');
        } else {
          expect(updatedDeletion?.status).toBe('APPROVED');
          expect(workspace?.status).toBe('RESTRICTED');
          expect(subscription?.deletionLockRequestId?.equals(deletionObjectId)).toBe(true);
        }
      } finally {
        await dispose(container);
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    'final verification blocks completion while live data remains',
    async () => {
      const container = await stage17Container('stage17_verify_blocker');
      try {
        const seed = await seedWorkspace(container);
        const requestId = new ObjectId();
        await container.database.db
          .collection('workspace_deletion_requests')
          .insertOne(
            deletionDocument(seed.workspaceId, seed.subscriptionId, 'PROCESSING', requestId),
          );
        await container.database.db
          .collection('workspaces')
          .updateOne(
            { _id: seed.workspaceId },
            { $set: { status: 'RESTRICTED', deletionLockRequestId: requestId } },
          );
        await container.database.db.collection('manual_payments').insertOne({
          _id: new ObjectId(),
          workspaceId: seed.workspaceId,
          subscriptionId: seed.subscriptionId,
          amount: 100,
          currency: 'USD',
          paymentMethod: 'BANK',
          proofFileId: new ObjectId(),
          status: 'APPROVED',
          createdBy: seed.ownerId,
          createdAt: new Date(),
          updatedAt: new Date(),
          version: 0,
        });
        await expect(
          container.database.db
            .collection('workspace_deletion_requests')
            .updateOne({ _id: requestId }, { $set: { status: 'APPROVED' } }),
        ).resolves.toBeTruthy();
        expect(await container.retention.processDeletions('worker-a')).toBe(0);
        expect(
          (
            await container.database.db
              .collection('workspace_deletion_requests')
              .findOne({ _id: requestId })
          )?.status,
        ).toBe('FAILED');
        expect(
          (await container.database.db.collection('workspaces').findOne({ _id: seed.workspaceId }))
            ?.status,
        ).toBe('RESTRICTED');
      } finally {
        await dispose(container);
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});

class CapturingStorageProvider extends FakeStorageProvider {
  readonly bodies = new Map<string, Uint8Array>();

  override putObject(input: ObjectMetadata, options?: { overwrite?: boolean }): void;
  override putObject(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    checksumSha256?: string;
  }): Promise<ObjectMetadata>;
  override putObject(
    input:
      | ObjectMetadata
      | { key: string; body: Uint8Array; contentType: string; checksumSha256?: string },
    options: { overwrite?: boolean } = {},
  ): undefined | Promise<ObjectMetadata> {
    if ('body' in input) {
      this.bodies.set(input.key, input.body);
    }
    return super.putObject(input as never, options) as undefined | Promise<ObjectMetadata>;
  }

  bodyFor(key: string): Uint8Array {
    const body = this.bodies.get(key);
    if (!body) throw new Error(`missing body for ${key}`);
    return body;
  }
}

async function stage17Container(label: string): Promise<AppContainer> {
  const container = await createAppContainer(integrationConfig(`${label}_${new ObjectId()}`));
  await new MigrationRunner(container.database.db, migrations).migrate();
  return container;
}

async function dispose(container: AppContainer): Promise<void> {
  await container.database.db.dropDatabase();
  await container.database.close();
}

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
}

function installFakeStage17Storage(container: AppContainer): CapturingStorageProvider {
  const storage = new CapturingStorageProvider();
  container.files = new FileApplicationService(
    container.unitOfWork,
    container.filesRepo,
    container.coachingRelationships,
    container.workspaceMemberships,
    container.accessControl,
    container.entitlements,
    container.workspaceUsage,
    storage,
    container.audit,
    container.outbox,
  );
  container.exports = new WorkspaceExportApplicationService(
    container.config,
    container.database,
    container.unitOfWork,
    container.exportsRepo,
    container.filesRepo,
    container.workspaceRepo,
    container.workspaceMemberships,
    container.subscriptionsRepo,
    container.accessControl,
    storage,
    container.audit,
    container.outbox,
  );
  return storage;
}

async function seedWorkspace(
  container: AppContainer,
  input: { subscriptionStatus?: string; expiredAt?: Date } = {},
) {
  const owner = await seedUser(container.database.db);
  const platform = await seedUser(container.database.db);
  const workspace = await container.workspaceRepo.create({
    type: 'GYM',
    name: 'Stage 17 Gym',
    ownerUserId: owner._id,
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
  });
  const ownerMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: owner._id,
    roles: ['GYM_OWNER'],
  });
  await assignWorkspaceProfile(container, workspace._id, ownerMembership._id, 'GYM_OWNER');
  const platformMembership = await container.platformMemberships.createActive(platform._id);
  await assignPlatformProfile(container, platformMembership._id, 'PLATFORM_SUPER_ADMIN');
  const subscriptionId = new ObjectId();
  const termsId = new ObjectId();
  const status = input.subscriptionStatus ?? 'ACTIVE';
  const subscription: SubscriptionDocument = {
    _id: subscriptionId,
    workspaceId: workspace._id,
    lifecycleStatus: status as SubscriptionDocument['lifecycleStatus'],
    currentTermsId: termsId,
    ...(input.expiredAt ? { expiredAt: input.expiredAt } : {}),
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await container.database.db.collection('subscriptions').insertOne(subscription);
  await container.database.db.collection('subscription_terms').insertOne({
    _id: termsId,
    subscriptionId,
    workspaceId: workspace._id,
    billingPeriod: 'MONTHLY',
    limits: { activeTrainees: 50, activeStaff: 50, storageBytes: 1_000_000 },
    enabledFeatures: ['documents', 'checkins', 'training', 'nutrition'],
    effectiveFrom: new Date(),
    source: 'PURCHASE',
    createdBy: owner._id,
    createdAt: new Date(),
  });
  await container.database.db.collection('workspace_usage').insertOne({
    _id: new ObjectId(),
    workspaceId: workspace._id,
    activeTrainees: 0,
    activeStaff: 1,
    storageBytes: 0,
    reservedStorageBytes: 0,
    revision: 0,
    calculatedAt: new Date(),
    updatedAt: new Date(),
  });
  return {
    workspaceId: workspace._id,
    subscriptionId,
    ownerId: owner._id,
    ownerMembershipId: ownerMembership._id,
    ownerCtx: ctx(owner._id, ownerMembership._id),
    platformCtx: platformCtx(platform._id, platformMembership._id),
  };
}

async function seedExpiredDeletion(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedWorkspace>>,
) {
  const expiredAt = new Date('2025-01-01T00:00:00.000Z');
  await container.database.db
    .collection('subscriptions')
    .updateOne(
      { _id: seed.subscriptionId },
      { $set: { lifecycleStatus: 'EXPIRED', expiredAt, version: 0 } },
    );
  await container.database.db
    .collection('workspace_deletion_requests')
    .insertOne(deletionDocument(seed.workspaceId, seed.subscriptionId, 'PENDING_APPROVAL'));
}

async function seedManifestRecords(db: Db, workspaceId: ObjectId) {
  for (const target of deletionTargets) {
    await seedDeleteRecord(db, target.collection, workspaceId);
  }
}

async function seedDeleteRecord(db: Db, collection: string, workspaceId: ObjectId) {
  const now = new Date();
  const base = { _id: new ObjectId(), workspaceId, createdAt: now, updatedAt: now };
  if (collection === 'permission_profiles') {
    await db.collection(collection).insertOne({
      ...base,
      context: 'WORKSPACE',
      roleKey: `DELETE_TEST_${new ObjectId().toHexString()}`,
      name: 'Delete Test',
      permissions: [],
      status: 'ACTIVE',
      isSystemDefault: false,
    });
    return;
  }
  if (collection === 'access_grants') {
    await db.collection(collection).insertOne({
      ...base,
      context: 'WORKSPACE',
      subjectType: 'WORKSPACE_MEMBERSHIP',
      subjectId: new ObjectId(),
      permissions: [],
      status: 'ACTIVE',
      grantedBy: new ObjectId(),
    });
    return;
  }
  if (collection === 'referral_codes') {
    await db
      .collection(collection)
      .insertOne({ ...base, ownerWorkspaceId: workspaceId, code: new ObjectId().toHexString() });
    return;
  }
  if (collection === 'invitations') {
    await db.collection(collection).insertOne({
      ...base,
      type: 'STAFF_INVITATION',
      email: `${new ObjectId().toHexString()}@example.com`,
      normalizedEmail: `${new ObjectId().toHexString()}@example.com`,
      intendedRoles: ['TRAINER'],
      branchIds: [],
      invitedBy: new ObjectId(),
      tokenDigest: new ObjectId().toHexString(),
      expiresAt: new Date(Date.now() + 60_000),
      status: 'PENDING',
    });
    return;
  }
  if (['exercises', 'foods', 'metric_definitions'].includes(collection)) {
    await db.collection(collection).insertOne({ ...base, scope: 'GYM', name: 'Delete Test' });
    return;
  }
  if (
    [
      'program_template_revisions',
      'program_revisions',
      'nutrition_plan_revisions',
      'checkin_template_revisions',
    ].includes(collection)
  ) {
    await db.collection(collection).insertOne({
      ...base,
      templateId: new ObjectId(),
      programId: new ObjectId(),
      nutritionPlanId: new ObjectId(),
      revision: 1,
    });
    return;
  }
  if (collection === 'checkin_instances') {
    await db.collection(collection).insertOne({
      ...base,
      relationshipId: new ObjectId(),
      assignmentId: new ObjectId(),
      templateId: new ObjectId(),
      templateRevisionId: new ObjectId(),
      periodKey: new ObjectId().toHexString(),
      periodStartAt: new Date(),
      periodEndAt: new Date(Date.now() + 60_000),
      opensAt: new Date(),
      dueAt: new Date(Date.now() + 60_000),
      status: 'DUE',
      responses: [],
      version: 0,
    });
    return;
  }
  await db.collection(collection).insertOne(base);
}

async function assignWorkspaceProfile(
  container: AppContainer,
  workspaceId: ObjectId,
  membershipId: ObjectId,
  roleKey: string,
) {
  const seed = systemPermissionProfiles.find(
    (profile) => profile.context === 'WORKSPACE' && profile.roleKey === roleKey,
  );
  if (!seed) throw new Error(`missing profile ${roleKey}`);
  const profile =
    (await container.permissionProfiles.findSystemDefault({
      context: 'WORKSPACE',
      workspaceId,
      roleKey,
    })) ??
    (await container.permissionProfiles.create({
      context: 'WORKSPACE',
      workspaceId,
      roleKey,
      name: seed.name,
      permissions: seed.permissions,
      isSystemDefault: true,
    }));
  const membership = await container.workspaceMemberships.findByIdInWorkspace(
    workspaceId,
    membershipId,
  );
  if (!membership) throw new Error('missing membership');
  await container.workspaceMemberships.updateRoleAndProfileContributions(
    workspaceId,
    membershipId,
    membership.accessVersion ?? 0,
    { roles: membership.roles, permissionProfileIds: [profile._id] },
  );
}

async function assignPlatformProfile(
  container: AppContainer,
  membershipId: ObjectId,
  roleKey: string,
) {
  const seed = systemPermissionProfiles.find(
    (profile) => profile.context === 'PLATFORM' && profile.roleKey === roleKey,
  );
  if (!seed) throw new Error(`missing platform profile ${roleKey}`);
  const profile =
    (await container.permissionProfiles.findSystemDefault({ context: 'PLATFORM', roleKey })) ??
    (await container.permissionProfiles.create({
      context: 'PLATFORM',
      roleKey,
      name: seed.name,
      permissions: seed.permissions,
      isSystemDefault: true,
    }));
  const membership = await container.platformMemberships.findById(membershipId);
  if (!membership) throw new Error('missing platform membership');
  await container.platformMemberships.replacePermissionProfiles(
    membershipId,
    membership.accessVersion ?? 0,
    [profile._id],
  );
}

async function seedUser(db: Db) {
  const now = new Date();
  const user = {
    _id: new ObjectId(),
    email: `${new ObjectId().toHexString()}@example.com`,
    normalizedEmail: `${new ObjectId().toHexString()}@example.com`,
    passwordHash: 'hash',
    emailVerifiedAt: now,
    firstName: 'Stage',
    lastName: 'Seventeen',
    preferredLanguage: 'en',
    timezone: 'Africa/Cairo',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };
  await db.collection('users').insertOne(user);
  return user;
}

async function seedRelationship(
  db: Db,
  workspaceId: ObjectId,
  userId: ObjectId,
): Promise<ObjectId> {
  const relationshipId = new ObjectId();
  const now = new Date();
  await db.collection('coaching_relationships').insertOne({
    _id: relationshipId,
    workspaceId,
    traineeUserId: userId,
    status: 'ACTIVE',
    version: 0,
    createdAt: now,
    updatedAt: now,
  });
  return relationshipId;
}

async function seedPlanVersion(db: Db, createdBy: ObjectId): Promise<ObjectId> {
  const planId = new ObjectId();
  const versionId = new ObjectId();
  const now = new Date();
  await db.collection('subscription_plans').insertOne({
    _id: planId,
    key: `stage17-${planId.toHexString()}`,
    customerType: 'GYM',
    name: 'Stage 17 Plan',
    active: true,
    currentVersionId: versionId,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('subscription_plan_versions').insertOne({
    _id: versionId,
    planId,
    version: 1,
    billingOptions: ['MONTHLY'],
    defaultLimits: { activeTrainees: 50, activeStaff: 50, storageBytes: 1_000_000 },
    features: { documents: true, checkins: true, training: true, nutrition: true },
    effectiveFrom: now,
    createdBy,
    createdAt: now,
  });
  return versionId;
}

function exportDocument(
  workspaceId: ObjectId,
  requestedByUserId: ObjectId,
  requestedByMembershipId = new ObjectId(),
): WorkspaceExportRequestDocument {
  const now = new Date();
  return {
    _id: new ObjectId(),
    workspaceId,
    requestedByUserId,
    requestedByMembershipId,
    status: 'PENDING',
    requestedAt: now,
    attemptCount: 0,
    format: 'ZIP_JSON_V1',
    manifestVersion: 1,
    scopeSnapshot: { includesUploadedBinaries: false, requestedByUserId, requestedByMembershipId },
    version: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function insertExport(
  db: Db,
  input: {
    workspaceId: ObjectId;
    requestedByUserId: ObjectId;
    status: WorkspaceExportRequestDocument['status'];
  },
) {
  await db.collection('workspace_export_requests').insertOne({
    ...exportDocument(input.workspaceId, input.requestedByUserId),
    status: input.status,
    ...(input.status === 'READY'
      ? { expiresAt: new Date(Date.now() + 60_000), completedAt: new Date() }
      : {}),
  });
}

function deletionDocument(
  workspaceId: ObjectId,
  subscriptionId: ObjectId,
  status: WorkspaceDeletionRequestDocument['status'],
  id = new ObjectId(),
): WorkspaceDeletionRequestDocument {
  const now = new Date();
  return {
    _id: id,
    workspaceId,
    subscriptionId,
    subscriptionVersionAtEligibility: 0,
    eligibilityBasis: {
      expiredAt: new Date('2025-01-01T00:00:00.000Z'),
      eligibilityAt: new Date('2025-06-30T00:00:00.000Z'),
    },
    status,
    createdActor: { type: 'SYSTEM', reason: 'TEST' },
    createdAt: now,
    processingAttemptCount: 0,
    checkpoints: [],
    retainedPaymentProofFileIds: [],
    workspaceSnapshot: { name: 'Stage 17 Gym', type: 'GYM' },
    version: 0,
    updatedAt: now,
  };
}

async function insertDeletion(
  db: Db,
  input: {
    workspaceId: ObjectId;
    status: WorkspaceDeletionRequestDocument['status'];
    subscriptionId?: ObjectId;
  },
) {
  await db
    .collection('workspace_deletion_requests')
    .insertOne(
      deletionDocument(input.workspaceId, input.subscriptionId ?? new ObjectId(), input.status),
    );
}

async function deletionId(db: Db, workspaceId: ObjectId): Promise<ObjectId> {
  const deletion = await db.collection('workspace_deletion_requests').findOne({ workspaceId });
  if (!deletion?._id) throw new Error('missing deletion');
  return deletion._id as ObjectId;
}

function generatedFile(
  workspaceId: ObjectId,
  exportId: ObjectId,
  origin: 'USER_UPLOAD' | 'SYSTEM_GENERATED' = 'SYSTEM_GENERATED',
): FileDocument {
  const now = new Date();
  return {
    _id: new ObjectId(),
    workspaceId,
    origin,
    ...(origin === 'SYSTEM_GENERATED'
      ? { generatedPurpose: 'WORKSPACE_EXPORT' as const, generatedForExportId: exportId }
      : { uploadIntentId: new ObjectId(), uploaderUserId: new ObjectId() }),
    subjectType: 'WORKSPACE',
    subjectId: workspaceId,
    storageProvider: 'fake',
    storageKey: `workspaces/${workspaceId.toHexString()}/files/${new ObjectId().toHexString()}`,
    originalName: 'file.zip',
    mimeType: origin === 'SYSTEM_GENERATED' ? 'application/zip' : 'application/pdf',
    sizeBytes: 10,
    verifiedChecksumSha256: 'abc',
    classification: origin === 'SYSTEM_GENERATED' ? 'SENSITIVE' : 'STANDARD',
    status: 'ACTIVE',
    version: 0,
    createdAt: now,
    confirmedAt: now,
  };
}

function userUploadFile(workspaceId: ObjectId): FileDocument {
  return generatedFile(workspaceId, new ObjectId(), 'USER_UPLOAD');
}

function ctx(userId: ObjectId, membershipId: ObjectId) {
  return {
    correlationId: new ObjectId().toHexString(),
    userId: userId.toHexString(),
    authSessionId: new ObjectId().toHexString(),
    workspaceMembershipId: membershipId.toHexString(),
    ipAddress: '127.0.0.1',
    locale: 'en',
    timezone: 'Africa/Cairo',
  };
}

function platformCtx(userId: ObjectId, platformMembershipId: ObjectId) {
  return {
    correlationId: new ObjectId().toHexString(),
    userId: userId.toHexString(),
    authSessionId: new ObjectId().toHexString(),
    platformMembershipId: platformMembershipId.toHexString(),
    mfaSatisfied: true,
    ipAddress: '127.0.0.1',
    locale: 'en',
    timezone: 'Africa/Cairo',
  };
}

function integrationConfig(dbName: string): AppConfig {
  return {
    env: 'test',
    app: { host: '0.0.0.0', port: 3000, docsEnabled: false, trustProxy: false, allowedOrigins: [] },
    mongo: {
      uri:
        process.env.MONGODB_URI ??
        'mongodb://localhost:27017/gym_platform?replicaSet=rs0&directConnection=true',
      dbName,
      connectTimeoutMs: 500,
    },
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
      loginIdentifierIpWindowMs: 900_000,
      loginIdentifierIpMaxAttempts: 5,
      loginIdentifierIpBlockMs: 900_000,
      loginIpWindowMs: 900_000,
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
      id: 'test-worker',
      outboxPollIntervalMs: 1000,
      outboxLockMs: 30_000,
      outboxMaxAttempts: 8,
      jobLeaseMs: 30_000,
    },
    subscriptions: { trialExpiryAction: 'FROZEN', paidGraceDays: 0, frozenToExpiredDays: 30 },
    support: { defaultSessionMinutes: 30, maxSessionMinutes: 60 },
    exports: { readyTtlMs: 7 * 24 * 60 * 60 * 1000, processingClaimTtlMs: 60_000, batchSize: 2 },
    retention: { warningOffsetsDays: [30, 7, 1], deletionEligibilityDays: 180, batchSize: 3 },
  };
}
