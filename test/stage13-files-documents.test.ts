import { describe, expect, test } from 'bun:test';
import { type Db, ObjectId } from 'mongodb';
import type { AppContainer } from '../src/bootstrap/app-container';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { FakeStorageProvider } from '../src/core/storage/fake-storage.provider';
import { migrations } from '../src/migrations';
import { migration018Stage13FilesDocuments } from '../src/migrations/018-stage13-files-documents';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { FileApplicationService } from '../src/modules/files/file.service';
import { systemPermissionProfiles } from '../src/modules/permissions/permission.registry';

const INTEGRATION_TEST_TIMEOUT_MS = 30_000;
const MIGRATION_TEST_TIMEOUT_MS = 30_000;

describe('Stage 13 migration 018', () => {
  test('creates file/document indexes and Stage 13 permission seeds', async () => {
    const calls: Array<{ collection: string; indexes: unknown[] }> = [];
    const updates: Array<{ collection: string; filter: unknown; update: unknown }> = [];
    const db = {
      collection(name: string) {
        return {
          async createIndexes(indexes: unknown[]) {
            calls.push({ collection: name, indexes });
          },
          async updateOne(filter: unknown, update: unknown) {
            updates.push({ collection: name, filter, update });
          },
          find() {
            return {
              async toArray() {
                return [{ _id: new ObjectId() }];
              },
            };
          },
        };
      },
    };

    await migration018Stage13FilesDocuments.up(db as never);

    expect(indexes(calls, 'upload_intents')).toContainEqual(
      expect.objectContaining({ name: 'upload_intents_storage_key_unique', unique: true }),
    );
    expect(indexes(calls, 'files')).toContainEqual(
      expect.objectContaining({ name: 'files_upload_intent_unique', unique: true }),
    );
    expect(indexes(calls, 'documents')).toContainEqual(
      expect.objectContaining({ name: 'documents_file_unique', unique: true }),
    );
    expect(JSON.stringify(updates)).toContain('documents.upload');
    expect(JSON.stringify(updates)).toContain('medical_documents.download');
  });

  test(
    'runs clean 001-018, reruns, and enforces one document per file',
    async () => {
      const container = await createStage13Container(`stage13_migration_${new ObjectId()}`);
      try {
        await new MigrationRunner(container.database.db, migrations).migrate();
        await new MigrationRunner(container.database.db, migrations).migrate();
        const names = (await container.database.db.collection('files').indexes()).map(
          (index) => index.name,
        );
        expect(names).toContain('files_storage_key_unique');
        const fileId = new ObjectId();
        await container.database.db.collection('documents').insertOne(documentRecord(fileId));
        await expect(
          container.database.db.collection('documents').insertOne(documentRecord(fileId)),
        ).rejects.toMatchObject({ code: 11000 });
      } finally {
        await container.database.db.dropDatabase();
        await container.database.close();
      }
    },
    MIGRATION_TEST_TIMEOUT_MS,
  );
});

describe('Stage 13 files and documents', () => {
  test(
    'reserves quota, confirms with provider HEAD, creates a standard document, and downloads by short-lived URL',
    async () => {
      const container = await createStage13Container(`stage13_flow_${new ObjectId()}`);
      const storage = installFakeStorage(container);
      try {
        await new MigrationRunner(container.database.db, migrations).migrate();
        const seed = await seedGym(container);
        const intent = await container.unitOfWork.withTransaction((tx) =>
          container.files.createUploadIntent(
            seed.trainerCtx,
            seed.workspaceId,
            {
              purpose: 'DOCUMENT',
              subjectType: 'COACHING_RELATIONSHIP',
              subjectId: seed.relationshipId,
              fileName: 'plan.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 500,
            },
            tx,
          ),
        );
        const usageAfterReserve = await container.database.db
          .collection('workspace_usage')
          .findOne({ workspaceId: seed.workspaceObjectId });
        expect(usageAfterReserve?.reservedStorageBytes).toBe(500);
        storage.putObject({
          key: await intentKey(container.database.db, intent.uploadIntentId),
          sizeBytes: 400,
          contentType: 'application/pdf',
        });
        const confirmed = await container.unitOfWork.withTransaction((tx) =>
          container.files.confirmUpload(
            seed.trainerCtx,
            seed.workspaceId,
            intent.uploadIntentId,
            { expectedVersion: intent.expectedVersion },
            tx,
          ),
        );
        expect(confirmed.file.sizeBytes).toBe(400);
        const usageAfterConfirm = await container.database.db
          .collection('workspace_usage')
          .findOne({ workspaceId: seed.workspaceObjectId });
        expect(usageAfterConfirm?.reservedStorageBytes).toBe(0);
        expect(usageAfterConfirm?.storageBytes).toBe(400);
        const created = await container.unitOfWork.withTransaction((tx) =>
          container.files.createDocument(
            seed.trainerCtx,
            seed.workspaceId,
            seed.relationshipId,
            { fileId: confirmed.file.id, category: 'OTHER', title: 'Plan' },
            tx,
          ),
        );
        expect(created.document.category).toBe('OTHER');
        const download = await container.files.createDownloadUrl(
          seed.trainerCtx,
          seed.workspaceId,
          confirmed.file.id,
        );
        expect(download.url).toContain('signature=test');
      } finally {
        await container.database.db.dropDatabase();
        await container.database.close();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    'rejects oversize confirmation and keeps reserved quota for expiry cleanup',
    async () => {
      const container = await createStage13Container(`stage13_mismatch_${new ObjectId()}`);
      const storage = installFakeStorage(container);
      try {
        await new MigrationRunner(container.database.db, migrations).migrate();
        const seed = await seedGym(container);
        const intent = await container.unitOfWork.withTransaction((tx) =>
          container.files.createUploadIntent(
            seed.trainerCtx,
            seed.workspaceId,
            {
              purpose: 'DOCUMENT',
              subjectType: 'COACHING_RELATIONSHIP',
              subjectId: seed.relationshipId,
              fileName: 'large.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 500,
            },
            tx,
          ),
        );
        storage.putObject({
          key: await intentKey(container.database.db, intent.uploadIntentId),
          sizeBytes: 501,
          contentType: 'application/pdf',
        });
        await expect(
          container.unitOfWork.withTransaction((tx) =>
            container.files.confirmUpload(
              seed.trainerCtx,
              seed.workspaceId,
              intent.uploadIntentId,
              { expectedVersion: intent.expectedVersion },
              tx,
            ),
          ),
        ).rejects.toMatchObject({ code: 'UPLOAD_OBJECT_MISMATCH' });
        await container.database.db
          .collection('upload_intents')
          .updateOne(
            { _id: new ObjectId(intent.uploadIntentId) },
            { $set: { expiresAt: new Date(0) } },
          );
        await container.files.expireUploadIntents();
        const usage = await container.database.db
          .collection('workspace_usage')
          .findOne({ workspaceId: seed.workspaceObjectId });
        expect(usage?.reservedStorageBytes).toBe(0);
        expect(storage.objects.size).toBe(0);
      } finally {
        await container.database.db.dropDatabase();
        await container.database.close();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    'keeps sensitive medical documents behind explicit medical permissions and leaves Check-In PHOTO disabled',
    async () => {
      const container = await createStage13Container(`stage13_sensitive_${new ObjectId()}`);
      const storage = installFakeStorage(container);
      try {
        await new MigrationRunner(container.database.db, migrations).migrate();
        const seed = await seedGym(container);
        const file = await confirmedFile(container, storage, seed);
        try {
          await container.unitOfWork.withTransaction((tx) =>
            container.files.createDocument(
              seed.trainerCtx,
              seed.workspaceId,
              seed.relationshipId,
              { fileId: file.file.id, category: 'MEDICAL_REPORT', title: 'Medical' },
              tx,
            ),
          );
          throw new Error('sensitive document creation should fail');
        } catch (error) {
          expect((error as { code?: string }).code).toBe('PERMISSION_DENIED');
        }
        await expect(
          container.checkins.createTemplate(seed.trainerCtx, seed.workspaceId, {
            name: 'Photo remains unsupported',
            fields: [{ fieldKey: 'photo', type: 'PHOTO', label: 'Photo', required: false }],
          }),
        ).rejects.toMatchObject({ code: 'CHECKIN_FIELD_TYPE_NOT_SUPPORTED' });
      } finally {
        await container.database.db.dropDatabase();
        await container.database.close();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    'serializes storage quota reservations without overbooking remaining quota',
    async () => {
      const container = await createStage13Container(`stage13_quota_${new ObjectId()}`);
      installFakeStorage(container);
      try {
        await new MigrationRunner(container.database.db, migrations).migrate();
        const seed = await seedGym(container);
        await container.database.db
          .collection('subscription_terms')
          .updateOne(
            { workspaceId: seed.workspaceObjectId },
            { $set: { 'limits.storageBytes': 600 } },
          );
        const create = () =>
          container.unitOfWork.withTransaction((tx) =>
            container.files.createUploadIntent(
              seed.trainerCtx,
              seed.workspaceId,
              {
                purpose: 'DOCUMENT',
                subjectType: 'COACHING_RELATIONSHIP',
                subjectId: seed.relationshipId,
                fileName: `${new ObjectId().toHexString()}.pdf`,
                mimeType: 'application/pdf',
                sizeBytes: 500,
              },
              tx,
            ),
          );
        const results = await Promise.allSettled([create(), create()]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        const usage = await container.database.db
          .collection('workspace_usage')
          .findOne({ workspaceId: seed.workspaceObjectId });
        expect(usage?.reservedStorageBytes).toBe(500);
      } finally {
        await container.database.db.dropDatabase();
        await container.database.close();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    'rolls back reservation when upload presign fails before transaction commit',
    async () => {
      const container = await createStage13Container(`stage13_presign_failure_${new ObjectId()}`);
      const storage = installFakeStorage(container);
      try {
        await new MigrationRunner(container.database.db, migrations).migrate();
        const seed = await seedGym(container);
        storage.failNextUploadUrl = true;
        await expect(
          container.unitOfWork.withTransaction((tx) =>
            container.files.createUploadIntent(
              seed.trainerCtx,
              seed.workspaceId,
              {
                purpose: 'DOCUMENT',
                subjectType: 'COACHING_RELATIONSHIP',
                subjectId: seed.relationshipId,
                fileName: 'presign.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 500,
              },
              tx,
            ),
          ),
        ).rejects.toThrow('Injected upload presign failure');
        const usage = await container.database.db
          .collection('workspace_usage')
          .findOne({ workspaceId: seed.workspaceObjectId });
        expect(usage?.reservedStorageBytes).toBe(0);
        expect(await container.database.db.collection('upload_intents').countDocuments()).toBe(0);
      } finally {
        await container.database.db.dropDatabase();
        await container.database.close();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    'soft delete, restore, purge, and quota release follow the file lifecycle',
    async () => {
      const container = await createStage13Container(`stage13_lifecycle_${new ObjectId()}`);
      const storage = installFakeStorage(container);
      try {
        await new MigrationRunner(container.database.db, migrations).migrate();
        const seed = await seedGym(container);
        const confirmed = await confirmedFile(container, storage, seed);
        await container.unitOfWork.withTransaction((tx) =>
          container.files.deleteFile(
            seed.trainerCtx,
            seed.workspaceId,
            confirmed.file.id,
            { expectedVersion: 0 },
            tx,
          ),
        );
        await expect(
          container.files.createDownloadUrl(seed.trainerCtx, seed.workspaceId, confirmed.file.id),
        ).rejects.toMatchObject({ code: 'FILE_NOT_AVAILABLE' });
        await container.unitOfWork.withTransaction((tx) =>
          container.files.restoreFile(
            seed.trainerCtx,
            seed.workspaceId,
            confirmed.file.id,
            { expectedVersion: 1 },
            tx,
          ),
        );
        await container.unitOfWork.withTransaction((tx) =>
          container.files.deleteFile(
            seed.trainerCtx,
            seed.workspaceId,
            confirmed.file.id,
            { expectedVersion: 2 },
            tx,
          ),
        );
        await container.database.db
          .collection('files')
          .updateOne(
            { _id: new ObjectId(confirmed.file.id) },
            { $set: { purgeEligibleAt: new Date(0) } },
          );
        await container.files.purgeFiles();
        const file = await container.database.db
          .collection('files')
          .findOne({ _id: new ObjectId(confirmed.file.id) });
        expect(file?.status).toBe('PURGED');
        const usage = await container.database.db
          .collection('workspace_usage')
          .findOne({ workspaceId: seed.workspaceObjectId });
        expect(usage?.storageBytes).toBe(0);
        expect(storage.objects.size).toBe(0);
      } finally {
        await container.database.db.dropDatabase();
        await container.database.close();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});

async function createStage13Container(dbName: string): Promise<AppContainer> {
  return await createAppContainer(integrationConfig(dbName));
}

function installFakeStorage(container: AppContainer): FakeStorageProvider {
  const storage = new FakeStorageProvider();
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
  return storage;
}

async function confirmedFile(
  container: AppContainer,
  storage: FakeStorageProvider,
  seed: Awaited<ReturnType<typeof seedGym>>,
) {
  const intent = await container.unitOfWork.withTransaction((tx) =>
    container.files.createUploadIntent(
      seed.trainerCtx,
      seed.workspaceId,
      {
        purpose: 'DOCUMENT',
        subjectType: 'COACHING_RELATIONSHIP',
        subjectId: seed.relationshipId,
        fileName: 'medical.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 500,
      },
      tx,
    ),
  );
  storage.putObject({
    key: await intentKey(container.database.db, intent.uploadIntentId),
    sizeBytes: 400,
    contentType: 'application/pdf',
  });
  return await container.unitOfWork.withTransaction((tx) =>
    container.files.confirmUpload(
      seed.trainerCtx,
      seed.workspaceId,
      intent.uploadIntentId,
      { expectedVersion: intent.expectedVersion },
      tx,
    ),
  );
}

async function intentKey(db: Db, id: string): Promise<string> {
  const intent = await db.collection('upload_intents').findOne({ _id: new ObjectId(id) });
  if (!intent?.storageKey) throw new Error('intent key missing');
  return String(intent.storageKey);
}

async function seedGym(container: AppContainer) {
  const db = container.database.db;
  const owner = await seedUser(db, `owner-${new ObjectId().toHexString()}@example.com`);
  const trainer = await seedUser(db, `trainer-${new ObjectId().toHexString()}@example.com`);
  const trainee = await seedUser(db, `trainee-${new ObjectId().toHexString()}@example.com`);
  const workspace = await container.workspaceRepo.create({
    type: 'GYM',
    name: 'Stage 13 Gym',
    ownerUserId: owner._id,
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
  });
  await seedCommercial(db, workspace._id, ['documents', 'checkins']);
  const ownerMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: owner._id,
    roles: ['GYM_OWNER'],
  });
  const trainerMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: trainer._id,
    roles: ['TRAINER'],
  });
  const traineeMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: trainee._id,
    roles: ['TRAINEE'],
  });
  await assignSystemProfile(container, workspace._id, ownerMembership._id, 'GYM_OWNER');
  await assignSystemProfile(container, workspace._id, trainerMembership._id, 'TRAINER');
  await assignSystemProfile(container, workspace._id, traineeMembership._id, 'TRAINEE');
  const relationship = await container.coachingRelationships.createActive({
    workspaceId: workspace._id,
    traineeUserId: trainee._id,
    traineeMembershipId: traineeMembership._id,
    activatedBy: owner._id,
  });
  const primary = await container.coachingRelationships.createAssignment({
    workspaceId: workspace._id,
    relationshipId: relationship._id,
    staffMembershipId: trainerMembership._id,
    assignmentType: 'PRIMARY_TRAINER',
    assignedBy: owner._id,
  });
  const active = await container.coachingRelationships.setPrimaryPointer(
    relationship._id,
    workspace._id,
    relationship.version,
    ['ACTIVE'],
    primary._id,
  );
  return {
    workspaceId: workspace._id.toHexString(),
    workspaceObjectId: workspace._id,
    relationshipId: active._id.toHexString(),
    trainerCtx: ctx(trainer._id, trainerMembership._id),
  };
}

async function assignSystemProfile(
  container: AppContainer,
  workspaceId: ObjectId,
  membershipId: ObjectId,
  roleKey: string,
) {
  const seed = systemPermissionProfiles.find(
    (profile) => profile.context === 'WORKSPACE' && profile.roleKey === roleKey,
  );
  if (!seed) throw new Error(`missing system profile seed: ${roleKey}`);
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
  if (!membership) throw new Error('membership missing');
  await container.workspaceMemberships.updateRoleAndProfileContributions(
    workspaceId,
    membershipId,
    membership.accessVersion ?? 0,
    { roles: membership.roles, permissionProfileIds: [profile._id] },
  );
}

async function seedUser(db: Db, email: string) {
  const now = new Date();
  const user = {
    _id: new ObjectId(),
    email,
    normalizedEmail: email,
    passwordHash: 'hash',
    emailVerifiedAt: now,
    firstName: 'Stage',
    lastName: 'Thirteen',
    preferredLanguage: 'en',
    timezone: 'Africa/Cairo',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };
  await db.collection('users').insertOne(user);
  return user;
}

async function seedCommercial(db: Db, workspaceId: ObjectId, enabledFeatures: string[]) {
  const now = new Date();
  const subscriptionId = new ObjectId();
  const termsId = new ObjectId();
  await db.collection('subscriptions').insertOne({
    _id: subscriptionId,
    workspaceId,
    lifecycleStatus: 'ACTIVE',
    currentTermsId: termsId,
    version: 0,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('subscription_terms').insertOne({
    _id: termsId,
    subscriptionId,
    workspaceId,
    billingPeriod: 'MONTHLY',
    limits: { activeTrainees: 50, activeStaff: 50, storageBytes: 1_000_000 },
    enabledFeatures,
    effectiveFrom: now,
    source: 'PURCHASE',
    createdBy: new ObjectId(),
    createdAt: now,
  });
  await db.collection('workspace_usage').insertOne({
    _id: new ObjectId(),
    workspaceId,
    activeTrainees: 1,
    activeStaff: 0,
    storageBytes: 0,
    reservedStorageBytes: 0,
    revision: 0,
    calculatedAt: now,
    updatedAt: now,
  });
}

function documentRecord(fileId: ObjectId) {
  return {
    _id: new ObjectId(),
    workspaceId: new ObjectId(),
    relationshipId: new ObjectId(),
    fileId,
    category: 'OTHER',
    uploadedByUserId: new ObjectId(),
    classification: 'STANDARD',
    status: 'ACTIVE',
    version: 0,
    createdAt: new Date(),
  };
}

function indexes(calls: Array<{ collection: string; indexes: unknown[] }>, collection: string) {
  return calls.find((call) => call.collection === collection)?.indexes;
}

function ctx(userId: ObjectId, membershipId?: ObjectId) {
  return {
    correlationId: new ObjectId().toHexString(),
    userId: userId.toHexString(),
    authSessionId: new ObjectId().toHexString(),
    ...(membershipId ? { workspaceMembershipId: membershipId.toHexString() } : {}),
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
