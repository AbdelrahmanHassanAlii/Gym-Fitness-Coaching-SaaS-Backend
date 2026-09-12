import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Db, ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import type { AppContainer } from '../src/bootstrap/app-container';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { migrations } from '../src/migrations';
import { migration016Stage11Progress } from '../src/migrations/016-stage11-progress';
import { MigrationRunner } from '../src/migrations/migration-runner';
import {
  Permissions,
  systemPermissionProfiles,
} from '../src/modules/permissions/permission.registry';

describe('Stage 11 migration 016', () => {
  test('creates exact progress collections, indexes, BODY_WEIGHT KG metric, and permission seeds', async () => {
    const calls: Array<{ collection: string; indexes: unknown[] }> = [];
    const updates: Array<{ collection: string; filter: unknown; update: unknown }> = [];
    const db = {
      collection(name: string) {
        return {
          async createIndexes(indexes: unknown[]) {
            calls.push({ collection: name, indexes });
          },
          async findOne() {
            return { _id: new ObjectId() };
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

    await migration016Stage11Progress.up(db as never);

    expect(indexes(calls, 'metric_definitions')).toContainEqual(
      expect.objectContaining({ name: 'metric_definitions_active_name_unique', unique: true }),
    );
    expect(indexes(calls, 'measurement_entries')).toContainEqual(
      expect.objectContaining({ name: 'measurement_entries_metric_history' }),
    );
    expect(indexes(calls, 'progress_photo_entries')).toContainEqual(
      expect.objectContaining({ name: 'progress_photo_entries_visibility_history' }),
    );
    expect(indexes(calls, 'trainee_health_profiles')).toContainEqual(
      expect.objectContaining({
        name: 'trainee_health_profiles_relationship_unique',
        unique: true,
      }),
    );
    expect(indexes(calls, 'daily_tracking_entries')).toContainEqual(
      expect.objectContaining({
        name: 'daily_tracking_entries_relationship_date_unique',
        unique: true,
      }),
    );
    expect(indexes(calls, 'check_ins')).toBeUndefined();
    expect(indexes(calls, 'files')).toBeUndefined();
    expect(indexes(calls, 'notifications')).toBeUndefined();
    expect(JSON.stringify(updates)).toContain('BODY_WEIGHT');
    expect(JSON.stringify(updates)).toContain('health.food_allergies.read');
    expect(JSON.stringify(updates)).toContain('adherence.correct');
  });

  test('runs clean 001-016, upgrade 001-015 to 016, and reruns idempotently', async () => {
    const clean = await createAppContainer(
      integrationConfig(`stage11_clean_${new ObjectId().toHexString()}`),
    );
    const upgrade = await createAppContainer(
      integrationConfig(`stage11_upgrade_${new ObjectId().toHexString()}`),
    );
    try {
      await new MigrationRunner(clean.database.db, migrations).migrate();
      await assertStage11DbShape(clean.database.db);

      const through15 = migrations.filter((migration) => migration.id !== '016-stage11-progress');
      await new MigrationRunner(upgrade.database.db, through15).migrate();
      expect(
        await upgrade.database.db.listCollections({ name: 'metric_definitions' }).hasNext(),
      ).toBe(false);
      await new MigrationRunner(upgrade.database.db, migrations).migrate();
      await new MigrationRunner(upgrade.database.db, migrations).migrate();
      await assertStage11DbShape(upgrade.database.db);
    } finally {
      await clean.database.db.dropDatabase();
      await clean.database.close();
      await upgrade.database.db.dropDatabase();
      await upgrade.database.close();
    }
  }, 30_000);
});

describe('Stage 11 progress integration', () => {
  let container: AppContainer;
  let db: Db;

  beforeAll(async () => {
    container = await createAppContainer(
      integrationConfig(`stage11_${new ObjectId().toHexString()}`),
    );
    db = container.database.db;
    await new MigrationRunner(db, migrations).migrate();
  }, 30_000);

  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (container) await container.database.close();
  }, 30_000);

  test('MetricDefinitions enforce scope uniqueness, immutable unit/valueType, archive, and no Stage 12 routes', async () => {
    const seed = await seedGym(container);
    const app = await buildApp(container);
    const metric = await createMetric(container, seed, 'Waist', { key: 'WAIST' });
    await expect(
      createMetric(container, seed, 'System Attempt', { scope: 'SYSTEM' as never }),
    ).rejects.toMatchObject({ code: 'METRIC_DEFINITION_SCOPE_INVALID' });
    const systemMetric = await db.collection('metric_definitions').findOne({ scope: 'SYSTEM' });
    await expect(
      container.progress.updateMetricDefinition(
        seed.ownerCtx,
        seed.workspaceId,
        systemMetric?._id.toHexString() ?? new ObjectId().toHexString(),
        { expectedVersion: 0, name: 'Unsafe System Patch' },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      createMetric(container, seed, ' waist ', { key: 'WAIST_2' }),
    ).rejects.toMatchObject({
      code: 'METRIC_DEFINITION_CONFLICT',
    });
    const unsafePatch = {
      expectedVersion: metric.metricDefinition.version,
      name: 'Waist Circumference',
      unit: 'IN',
      valueType: 'INTEGER',
    } as never;
    await expect(
      container.progress.updateMetricDefinition(
        seed.ownerCtx,
        seed.workspaceId,
        metric.metricDefinition.id,
        unsafePatch,
      ),
    ).resolves.toMatchObject({ metricDefinition: { unit: 'CM', valueType: 'NUMBER' } });
    await container.progress.archiveMetricDefinition(
      seed.ownerCtx,
      seed.workspaceId,
      metric.metricDefinition.id,
      { expectedVersion: 1 },
    );
    await expect(createMetric(container, seed, 'Waist')).resolves.toMatchObject({
      metricDefinition: { status: 'ACTIVE' },
    });
    const ownerPrivateMetric = await createMetric(container, seed, 'Owner Private Metric', {
      scope: 'PRIVATE',
    });
    await expect(
      createMeasurementIdempotently(
        container,
        seed,
        ownerPrivateMetric.metricDefinition.id,
        10,
        'private-metric-raw-id',
      ),
    ).rejects.toMatchObject({ code: 'METRIC_DEFINITION_NOT_FOUND' });

    expect(
      await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${seed.workspaceId}/relationships/${seed.relationshipId}/progress-photos`,
      }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await app.inject({
        method: 'PUT',
        url: `/api/v1/workspaces/${seed.workspaceId}/relationships/${seed.relationshipId}/progress-photos/${new ObjectId().toHexString()}/visibility`,
      }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/workspaces/${seed.workspaceId}/relationships/${seed.relationshipId}/progress-photos/${new ObjectId().toHexString()}`,
      }),
    ).toMatchObject({ statusCode: 404 });
    await app.close();
  });

  test('Measurements support idempotent create, multiple same-day entries, archive boundary, correction, events, and rollback', async () => {
    const seed = await seedGym(container);
    const metric = await createMetric(container, seed, 'Body Weight', {
      key: `WEIGHT_${new ObjectId().toHexString()}`,
      unit: 'KG',
    });

    const first = await createMeasurementIdempotently(
      container,
      seed,
      metric.metricDefinition.id,
      82.4,
      'm1',
    );
    const metricAfterUse = await db.collection('metric_definitions').findOne({
      _id: new ObjectId(metric.metricDefinition.id),
    });
    expect(metricAfterUse?.version).toBe(0);
    expect(metricAfterUse?.measurementUseRevision).toBeGreaterThan(0);
    const replay = await createMeasurementIdempotently(
      container,
      seed,
      metric.metricDefinition.id,
      82.4,
      'm1',
    );
    expect(replay.replayed).toBe(true);
    await expect(
      createMeasurementIdempotently(container, seed, metric.metricDefinition.id, 83, 'm1'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(
      createMeasurementIdempotently(
        container,
        seed,
        metric.metricDefinition.id,
        83,
        'source-spoof',
        seed.traineeCtx,
        'TRAINER',
      ),
    ).rejects.toMatchObject({ code: 'MEASUREMENT_SOURCE_INVALID' });
    await createMeasurementIdempotently(container, seed, metric.metricDefinition.id, 82.5, 'm2');
    expect(
      await db.collection('measurement_entries').countDocuments({
        workspaceId: seed.workspaceObjectId,
        relationshipId: seed.relationshipObjectId,
      }),
    ).toBe(2);

    await container.progress.updateMeasurement(
      seed.traineeCtx,
      seed.workspaceId,
      seed.relationshipId,
      first.body.measurement.id,
      { expectedVersion: 0, value: 82.1, source: 'TRAINEE' },
    );
    await expect(
      container.progress.updateMeasurement(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        first.body.measurement.id,
        { expectedVersion: 0, value: 82.0 },
      ),
    ).rejects.toMatchObject({ code: 'MEASUREMENT_VERSION_CONFLICT' });

    await container.progress.archiveMetricDefinition(
      seed.ownerCtx,
      seed.workspaceId,
      metric.metricDefinition.id,
      { expectedVersion: 0 },
    );
    await expect(
      createMeasurementIdempotently(container, seed, metric.metricDefinition.id, 81.9, 'm3'),
    ).rejects.toMatchObject({ code: 'METRIC_DEFINITION_ARCHIVED' });
    await expect(
      container.progress.updateMeasurement(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        first.body.measurement.id,
        { expectedVersion: 1, value: 82.2 },
      ),
    ).resolves.toMatchObject({ measurement: { value: 82.2 } });
    await expect(
      container.progress.updateMeasurement(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        first.body.measurement.id,
        { expectedVersion: 2, source: 'TRAINER' },
      ),
    ).rejects.toMatchObject({ code: 'MEASUREMENT_SOURCE_INVALID' });

    expect(
      await db.collection('outbox_events').countDocuments({ eventType: 'MeasurementRecorded' }),
    ).toBeGreaterThanOrEqual(2);

    const rollbackMetric = await createMetric(container, seed, 'Rollback');
    const originalAudit = container.audit.write.bind(container.audit);
    container.audit.write = (async () => {
      throw new Error('audit failed');
    }) as typeof container.audit.write;
    try {
      await expect(
        createMeasurementIdempotently(
          container,
          seed,
          rollbackMetric.metricDefinition.id,
          10,
          'rollback',
        ),
      ).rejects.toThrow('audit failed');
    } finally {
      container.audit.write = originalAudit;
    }
    expect(
      await db.collection('measurement_entries').countDocuments({
        relationshipId: seed.relationshipObjectId,
        value: 10,
      }),
    ).toBe(0);
  });

  test('HealthProfile enforces singleton, full vs allergy-only DTO, self update, DENY precedence, and sensitive defaults', async () => {
    const seed = await seedGym(container);
    const manager = await seedManager(container, seed);
    const nutritionist = await seedNutritionist(container, seed);
    const created = await container.progress.putHealthProfile(
      seed.traineeCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        injuries: ['knee'],
        physicalLimitations: ['squat depth'],
        foodAllergies: ['peanuts'],
        medications: ['private med'],
        medicalNotes: 'sensitive',
        emergencyNotes: 'call family',
      },
    );
    await expect(
      container.progress.putHealthProfile(seed.traineeCtx, seed.workspaceId, seed.relationshipId, {
        expectedVersion: 0,
        foodAllergies: ['peanuts', 'shellfish'],
      }),
    ).resolves.toMatchObject({ healthProfile: { version: 1 } });
    await expect(
      container.progress.putHealthProfile(seed.traineeCtx, seed.workspaceId, seed.relationshipId, {
        expectedVersion: 0,
        foodAllergies: ['stale'],
      }),
    ).rejects.toMatchObject({ code: 'HEALTH_PROFILE_VERSION_CONFLICT' });
    await expect(
      Promise.all([
        container.progress.putHealthProfile(
          seed.traineeCtx,
          seed.workspaceId,
          seed.relationshipId,
          {
            expectedVersion: created.healthProfile.version,
            foodAllergies: ['a'],
          },
        ),
        container.progress.putHealthProfile(
          seed.traineeCtx,
          seed.workspaceId,
          seed.relationshipId,
          {
            expectedVersion: created.healthProfile.version,
            foodAllergies: ['b'],
          },
        ),
      ]),
    ).rejects.toMatchObject({ code: 'HEALTH_PROFILE_VERSION_CONFLICT' });

    expect(
      await container.progress.getHealthProfile(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
      ),
    ).toMatchObject({
      healthProfile: { medications: expect.any(Array), medicalNotes: expect.any(String) },
    });
    expect(
      await container.progress.getHealthProfile(
        nutritionist.ctx,
        seed.workspaceId,
        seed.relationshipId,
      ),
    ).toMatchObject({ healthProfile: { foodAllergies: expect.any(Array) } });
    expect(
      await container.progress.getHealthProfile(
        nutritionist.ctx,
        seed.workspaceId,
        seed.relationshipId,
      ),
    ).not.toHaveProperty('healthProfile.medications');
    await expect(
      container.progress.getHealthProfile(seed.ownerCtx, seed.workspaceId, seed.relationshipId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      container.progress.getHealthProfile(manager.ctx, seed.workspaceId, seed.relationshipId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      container.progress.getHealthProfile(seed.assistantCtx, seed.workspaceId, seed.relationshipId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await writeGrant(db, {
      workspaceId: seed.workspaceObjectId,
      subjectId: new ObjectId(seed.traineeMembershipId),
      permission: Permissions.HealthRead,
      effect: 'DENY',
    });
    await expect(
      container.progress.getHealthProfile(seed.traineeCtx, seed.workspaceId, seed.relationshipId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await writeGrant(db, {
      workspaceId: seed.workspaceObjectId,
      subjectId: new ObjectId(seed.traineeMembershipId),
      permission: Permissions.MeasurementsRead,
      effect: 'DENY',
    });
    await expect(
      container.progress.listMeasurements(seed.traineeCtx, seed.workspaceId, seed.relationshipId, {
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  test('CoachingNotes preserve PRIVATE author isolation, shared visibility, one-way sharing, archive, and audit rollback', async () => {
    const seed = await seedGym(container);
    const manager = await seedManager(container, seed);
    const privateNote = await container.progress.createNote(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        category: 'form',
        visibility: 'PRIVATE',
        content: 'private',
        sensitive: true,
      },
    );
    const shared = await container.progress.createNote(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        category: 'visible',
        visibility: 'SHARED_WITH_TRAINEE',
        content: 'shared',
      },
    );
    expect(
      await container.progress.listNotes(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        {},
      ),
    ).toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ content: 'private' })]),
    });
    await writeGrant(db, {
      workspaceId: seed.workspaceObjectId,
      subjectId: new ObjectId(seed.assistantMembershipId),
      permission: Permissions.NotesRead,
      effect: 'ALLOW',
    });
    await expect(
      container.progress.listNotes(seed.assistantCtx, seed.workspaceId, seed.relationshipId, {}),
    ).resolves.toMatchObject({ data: [expect.objectContaining({ content: 'shared' })] });
    await expect(
      container.progress.listNotes(manager.ctx, seed.workspaceId, seed.relationshipId, {}),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(
      await container.progress.listNotes(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        {},
      ),
    ).toMatchObject({ data: [expect.objectContaining({ content: 'shared' })] });
    await expect(
      container.progress.updateNote(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        shared.note.id,
        {
          expectedVersion: shared.note.version,
          visibility: 'PRIVATE',
        },
      ),
    ).rejects.toMatchObject({ code: 'NOTE_VISIBILITY_FORBIDDEN' });
    const promoted = await container.progress.updateNote(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      privateNote.note.id,
      { expectedVersion: privateNote.note.version, visibility: 'SHARED_WITH_TRAINEE' },
    );
    await container.progress.archiveNote(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      promoted.note.id,
      {
        expectedVersion: promoted.note.version,
      },
    );
    expect(
      await container.progress.listNotes(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        {},
      ),
    ).toMatchObject({ data: [expect.objectContaining({ content: 'shared' })] });

    const originalAudit = container.audit.write.bind(container.audit);
    container.audit.write = (async () => {
      throw new Error('note audit failed');
    }) as typeof container.audit.write;
    await expect(
      container.progress.createNote(seed.trainerCtx, seed.workspaceId, seed.relationshipId, {
        category: 'rollback',
        content: 'rollback',
      }),
    ).rejects.toThrow('note audit failed');
    container.audit.write = originalAudit;
    expect(await db.collection('coaching_notes').countDocuments({ content: 'rollback' })).toBe(0);
  });

  test('ProgressPhoto metadata read filters PRIVATE and TRAINER_VISIBLE server-side while file mutations stay deferred', async () => {
    const seed = await seedGym(container);
    const manager = await seedManager(container, seed);
    const nutritionist = await seedNutritionist(container, seed);
    await db
      .collection('progress_photo_entries')
      .insertMany([progressPhoto(seed, 'PRIVATE'), progressPhoto(seed, 'TRAINER_VISIBLE')]);
    expect(
      await container.progress.listProgressPhotos(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        {},
      ),
    ).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ visibility: 'PRIVATE' }),
        expect.objectContaining({ visibility: 'TRAINER_VISIBLE' }),
      ]),
    });
    expect(
      await container.progress.listProgressPhotos(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        {},
      ),
    ).toMatchObject({ data: [expect.objectContaining({ visibility: 'TRAINER_VISIBLE' })] });
    expect(
      await container.progress.listProgressPhotos(
        seed.assistantCtx,
        seed.workspaceId,
        seed.relationshipId,
        {},
      ),
    ).toMatchObject({ data: [expect.objectContaining({ visibility: 'TRAINER_VISIBLE' })] });
    await expect(
      container.progress.listProgressPhotos(
        seed.ownerCtx,
        seed.workspaceId,
        seed.relationshipId,
        {},
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      container.progress.listProgressPhotos(manager.ctx, seed.workspaceId, seed.relationshipId, {}),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      container.progress.listProgressPhotos(
        nutritionist.ctx,
        seed.workspaceId,
        seed.relationshipId,
        {},
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await writeGrant(db, {
      workspaceId: seed.workspaceObjectId,
      subjectId: new ObjectId(seed.traineeMembershipId),
      permission: Permissions.ProgressPhotosRead,
      effect: 'DENY',
    });
    await expect(
      container.progress.listProgressPhotos(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        {},
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  test('AdherenceConfig and DailyTracking enforce enabled metrics, workspace timezone, edit window, singleton/date uniqueness, and no auto-coupling', async () => {
    const seed = await seedGym(container, { timezone: 'Pacific/Kiritimati' });
    const config = await container.progress.putAdherenceConfig(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        enabledMetrics: [
          'WORKOUT',
          'NUTRITION',
          'WATER',
          'STEPS',
          'SLEEP',
          'BODY_WEIGHT',
          'MOOD',
          'ENERGY',
        ],
      },
    );
    const today = localDateInTimezone(new Date(), 'Pacific/Kiritimati');
    const yesterday = previousLocalDate(today);
    const twoDaysAgo = previousLocalDate(yesterday);
    const entry = await container.progress.putDailyTracking(
      seed.traineeCtx,
      seed.workspaceId,
      seed.relationshipId,
      today,
      {
        values: {
          WORKOUT: { completed: true },
          NUTRITION: { adherencePercent: 90 },
          WATER: { ml: 0 },
          STEPS: { count: 10_000 },
          SLEEP: { minutes: 420 },
          BODY_WEIGHT: { kg: 81.5 },
          MOOD: { score: 4 },
          ENERGY: { score: 5 },
        },
      },
    );
    expect(entry.dailyTrackingEntry).toMatchObject({
      localDate: today,
      timezoneAtEntry: 'Pacific/Kiritimati',
      values: { BODY_WEIGHT: { kg: 81.5 } },
    });
    await expect(
      container.progress.putDailyTracking(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        today,
        {
          expectedVersion: entry.dailyTrackingEntry.version,
          values: { WATER: { ml: 500 } },
        },
      ),
    ).resolves.toMatchObject({ dailyTrackingEntry: { version: 1 } });
    await expect(
      container.progress.putDailyTracking(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        twoDaysAgo,
        {
          values: { WATER: { ml: 500 } },
        },
      ),
    ).rejects.toMatchObject({ code: 'DAILY_TRACKING_EDIT_WINDOW_EXPIRED' });
    await expect(
      container.progress.putDailyTracking(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        nextLocalDate(today),
        {
          values: { WATER: { ml: 500 } },
        },
      ),
    ).rejects.toMatchObject({ code: 'DAILY_TRACKING_EDIT_WINDOW_EXPIRED' });
    await expect(
      container.progress.putDailyTracking(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        twoDaysAgo,
        {
          values: { WATER: { ml: 500 } },
        },
      ),
    ).rejects.toMatchObject({ code: 'DAILY_TRACKING_CORRECTION_REASON_REQUIRED' });
    await expect(
      container.progress.putDailyTracking(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        twoDaysAgo,
        {
          values: { WATER: { ml: 500 } },
          reason: 'late correction',
        },
      ),
    ).resolves.toMatchObject({ dailyTrackingEntry: { localDate: twoDaysAgo } });

    await db
      .collection('workspaces')
      .updateOne({ _id: seed.workspaceObjectId }, { $set: { timezone: 'Africa/Cairo' } });
    expect(
      await container.progress.getDailyTracking(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        today,
      ),
    ).toMatchObject({ dailyTrackingEntry: { timezoneAtEntry: 'Pacific/Kiritimati' } });

    await container.progress.putAdherenceConfig(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        expectedVersion: config.adherenceConfig.version,
        enabledMetrics: ['WATER'],
      },
    );
    await expect(
      container.progress.putDailyTracking(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        yesterday,
        {
          values: { STEPS: { count: 1 } },
        },
      ),
    ).rejects.toMatchObject({ code: 'DAILY_TRACKING_METRIC_DISABLED' });
    expect(
      await db
        .collection('workout_sessions')
        .countDocuments({ relationshipId: seed.relationshipObjectId }),
    ).toBe(0);
    expect(
      await db
        .collection('nutrition_plans')
        .countDocuments({ relationshipId: seed.relationshipObjectId }),
    ).toBe(0);
  });

  test('DailyTracking validates every metric payload boundary and central DENY blocks self read', async () => {
    const seed = await seedGym(container);
    await container.progress.putAdherenceConfig(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        enabledMetrics: [
          'WORKOUT',
          'NUTRITION',
          'WATER',
          'STEPS',
          'SLEEP',
          'BODY_WEIGHT',
          'MOOD',
          'ENERGY',
        ],
      },
    );
    const today = localDateInTimezone(new Date(), 'Africa/Cairo');
    await container.progress.putDailyTracking(
      seed.traineeCtx,
      seed.workspaceId,
      seed.relationshipId,
      today,
      {
        values: {
          WORKOUT: { completed: false },
          NUTRITION: { adherencePercent: 100 },
          WATER: { ml: 0 },
          STEPS: { count: 0 },
          SLEEP: { minutes: 0 },
          BODY_WEIGHT: { kg: 70 },
          MOOD: { score: 1 },
          ENERGY: { score: 5 },
        },
      },
    );
    await writeGrant(db, {
      workspaceId: seed.workspaceObjectId,
      subjectId: new ObjectId(seed.traineeMembershipId),
      permission: Permissions.AdherenceRead,
      effect: 'DENY',
    });
    await expect(
      container.progress.getDailyTracking(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        today,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const invalidValues = [
      { NUTRITION: { adherencePercent: -1 } },
      { NUTRITION: { adherencePercent: 101 } },
      { WATER: { ml: -1 } },
      { STEPS: { count: -1 } },
      { STEPS: { count: 1.5 } },
      { SLEEP: { minutes: -1 } },
      { SLEEP: { minutes: 1.5 } },
      { BODY_WEIGHT: { kg: 0 } },
      { BODY_WEIGHT: { kg: -1 } },
      { MOOD: { score: 0 } },
      { MOOD: { score: 6 } },
      { MOOD: { score: 1.5 } },
      { ENERGY: { score: 0 } },
      { ENERGY: { score: 6 } },
      { ENERGY: { score: 1.5 } },
      { UNKNOWN: { value: true } },
    ] as const;

    for (const values of invalidValues) {
      await expect(
        container.progress.putDailyTracking(
          seed.traineeCtx,
          seed.workspaceId,
          seed.relationshipId,
          today,
          {
            expectedVersion: 0,
            values: values as never,
          },
        ),
      ).rejects.toMatchObject({
        code: 'UNKNOWN' in values ? 'DAILY_TRACKING_METRIC_DISABLED' : 'MEASUREMENT_VALUE_INVALID',
      });
    }
  });

  test('DailyTracking uses workspace IANA timezone across DST calendar boundaries', async () => {
    await withFrozenNow('2026-11-01T04:30:00.000Z', async () => {
      const seed = await seedGym(container, { timezone: 'America/New_York' });
      await container.progress.putAdherenceConfig(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        { enabledMetrics: ['WATER'] },
      );
      await expect(
        container.progress.putDailyTracking(
          seed.traineeCtx,
          seed.workspaceId,
          seed.relationshipId,
          '2026-11-01',
          { values: { WATER: { ml: 250 } } },
        ),
      ).resolves.toMatchObject({
        dailyTrackingEntry: { localDate: '2026-11-01', timezoneAtEntry: 'America/New_York' },
      });
      await expect(
        container.progress.putDailyTracking(
          seed.traineeCtx,
          seed.workspaceId,
          seed.relationshipId,
          '2026-10-31',
          { values: { WATER: { ml: 200 } } },
        ),
      ).resolves.toMatchObject({ dailyTrackingEntry: { localDate: '2026-10-31' } });
      await expect(
        container.progress.putDailyTracking(
          seed.traineeCtx,
          seed.workspaceId,
          seed.relationshipId,
          '2026-10-30',
          { values: { WATER: { ml: 100 } } },
        ),
      ).rejects.toMatchObject({ code: 'DAILY_TRACKING_EDIT_WINDOW_EXPIRED' });
    });
  });

  test('Relationship states allow NEEDS_REASSIGNMENT progress but block ENDED post-writes without public version churn', async () => {
    const seed = await seedGym(container);
    const before = await db
      .collection('coaching_relationships')
      .findOne({ _id: seed.relationshipObjectId });
    const metric = await createMetric(container, seed, 'Needs Reassignment Weight');
    await createMeasurementIdempotently(
      container,
      seed,
      metric.metricDefinition.id,
      80,
      'nr-before',
    );
    const afterMeasurement = await db
      .collection('coaching_relationships')
      .findOne({ _id: seed.relationshipObjectId });
    expect(afterMeasurement?.version).toBe(before?.version);
    expect(afterMeasurement?.progressLifecycleRevision).toBeGreaterThan(0);

    await container.coachingRelationships.markNeedsReassignment(
      seed.relationshipObjectId,
      seed.workspaceObjectId,
      seed.relationshipVersion,
    );
    await expect(
      createMeasurementIdempotently(
        container,
        seed,
        metric.metricDefinition.id,
        79.5,
        'nr-trainee',
      ),
    ).resolves.toMatchObject({ body: { measurement: { value: 79.5 } } });
    await expect(
      container.progress.putHealthProfile(seed.traineeCtx, seed.workspaceId, seed.relationshipId, {
        foodAllergies: ['milk'],
      }),
    ).resolves.toMatchObject({ healthProfile: { foodAllergies: ['milk'] } });
    await expect(
      container.progress.createNote(seed.trainerCtx, seed.workspaceId, seed.relationshipId, {
        category: 'former',
        content: 'former primary',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const current = await db
      .collection('coaching_relationships')
      .findOne({ _id: seed.relationshipObjectId });
    await container.coachingRelationships.transition(
      seed.relationshipObjectId,
      seed.workspaceObjectId,
      current?.version ?? 0,
      ['NEEDS_REASSIGNMENT'],
      'ENDED',
      { endedBy: new ObjectId(seed.ownerCtx.userId), endedAt: new Date(), endReason: 'done' },
      { closeEngagement: true },
    );
    await expect(
      createMeasurementIdempotently(container, seed, metric.metricDefinition.id, 79, 'ended'),
    ).rejects.toMatchObject({ code: 'RELATIONSHIP_NOT_PROGRESS_OPEN' });
    await expect(
      container.progress.listMeasurements(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        {},
      ),
    ).resolves.toMatchObject({ data: expect.any(Array) });
  });

  test('Authorization defaults and entitlements preserve sensitive boundaries and progress feature gating', async () => {
    const seed = await seedGym(container);
    const independent = await seedIndependent(container);
    const manager = await seedManager(container, seed);
    const nutritionist = await seedNutritionist(container, seed);
    await expect(
      createMetric(container, seed, 'Manager blocked gym metric', {}, manager.ctx),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      container.progress.putAdherenceConfig(manager.ctx, seed.workspaceId, seed.relationshipId, {
        enabledMetrics: ['WATER'],
      }),
    ).resolves.toMatchObject({ adherenceConfig: { enabledMetrics: ['WATER'] } });
    await expect(
      container.progress.createNote(seed.assistantCtx, seed.workspaceId, seed.relationshipId, {
        category: 'blocked',
        content: 'blocked',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      createMeasurementIdempotently(
        container,
        seed,
        (await createMetric(container, seed, 'Nutri')).metricDefinition.id,
        1,
        'nutri',
        nutritionist.ctx,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      createMeasurementIdempotently(
        container,
        independent,
        (await createMetric(container, independent, 'Independent Metric')).metricDefinition.id,
        1,
        'independent',
        independent.trainerCtx,
        'TRAINER',
      ),
    ).resolves.toMatchObject({ body: { measurement: { value: 1 } } });

    await db
      .collection('subscription_terms')
      .updateOne(
        { workspaceId: seed.workspaceObjectId },
        { $set: { enabledFeatures: ['training', 'nutrition'] } },
      );
    await expect(
      container.progress.listMeasurements(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        {},
      ),
    ).resolves.toMatchObject({ data: expect.any(Array) });
    await expect(createMetric(container, seed, 'Feature Disabled')).rejects.toMatchObject({
      code: 'FEATURE_NOT_AVAILABLE',
    });
    await db
      .collection('subscription_terms')
      .updateOne(
        { workspaceId: seed.workspaceObjectId },
        { $set: { enabledFeatures: ['training', 'nutrition', 'progress'] } },
      );
    await db
      .collection('subscriptions')
      .updateOne({ workspaceId: seed.workspaceObjectId }, { $set: { lifecycleStatus: 'FROZEN' } });
    await expect(
      container.progress.listMeasurements(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        {},
      ),
    ).resolves.toMatchObject({ data: expect.any(Array) });
    await expect(createMetric(container, seed, 'Frozen')).rejects.toMatchObject({
      code: 'SUBSCRIPTION_FROZEN',
    });
  });

  test('Concurrency matrix and failure injection preserve Stage 11 invariants transactionally', async () => {
    const seed = await seedGym(container);
    const duplicateCreates = await Promise.allSettled([
      createMetric(container, seed, 'Concurrent Metric'),
      createMetric(container, seed, 'concurrent metric'),
    ]);
    expect(duplicateCreates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejectedCodes(duplicateCreates)).toContain('METRIC_DEFINITION_CONFLICT');

    const metric = (
      duplicateCreates.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<typeof createMetric>>
      >
    ).value;
    const idempotentCreates = await Promise.allSettled([
      createMeasurementIdempotently(container, seed, metric.metricDefinition.id, 10, 'same-key'),
      createMeasurementIdempotently(container, seed, metric.metricDefinition.id, 10, 'same-key'),
    ]);
    expect(idempotentCreates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejectedCodes(idempotentCreates)).toContain('IDEMPOTENCY_REQUEST_IN_PROGRESS');

    const measurement = await createMeasurementIdempotently(
      container,
      seed,
      metric.metricDefinition.id,
      11,
      'race-measurement',
    );
    const correctionRace = await Promise.allSettled([
      container.progress.updateMeasurement(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        measurement.body.measurement.id,
        { expectedVersion: 0, value: 12 },
      ),
      container.progress.updateMeasurement(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        measurement.body.measurement.id,
        { expectedVersion: 0, value: 13 },
      ),
    ]);
    expect(correctionRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejectedCodes(correctionRace)).toContain('MEASUREMENT_VERSION_CONFLICT');

    const archiveRaceMetric = await createMetric(container, seed, 'Archive Race Metric');
    const archiveRace = await Promise.allSettled([
      createMeasurementIdempotently(
        container,
        seed,
        archiveRaceMetric.metricDefinition.id,
        14.5,
        'archive-race',
      ),
      container.progress.archiveMetricDefinition(
        seed.ownerCtx,
        seed.workspaceId,
        archiveRaceMetric.metricDefinition.id,
        { expectedVersion: 0 },
      ),
    ]);
    expect(archiveRace.filter((result) => result.status === 'fulfilled').length).toBeGreaterThan(0);
    expect(
      await db.collection('measurement_entries').countDocuments({
        relationshipId: seed.relationshipObjectId,
        metricDefinitionId: new ObjectId(archiveRaceMetric.metricDefinition.id),
      }),
    ).toBeLessThanOrEqual(1);

    const healthRace = await Promise.allSettled([
      container.progress.putHealthProfile(seed.traineeCtx, seed.workspaceId, seed.relationshipId, {
        foodAllergies: ['a'],
      }),
      container.progress.putHealthProfile(seed.traineeCtx, seed.workspaceId, seed.relationshipId, {
        foodAllergies: ['b'],
      }),
    ]);
    expect(
      await db.collection('trainee_health_profiles').countDocuments({
        workspaceId: seed.workspaceObjectId,
        relationshipId: seed.relationshipObjectId,
      }),
    ).toBe(1);
    expect(healthRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    await container.progress.putAdherenceConfig(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        enabledMetrics: ['WATER', 'STEPS'],
      },
    );
    const today = localDateInTimezone(new Date(), 'Africa/Cairo');
    const dailyRace = await Promise.allSettled([
      container.progress.putDailyTracking(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        today,
        {
          values: { WATER: { ml: 200 } },
        },
      ),
      container.progress.putDailyTracking(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        today,
        {
          values: { STEPS: { count: 300 } },
        },
      ),
    ]);
    expect(
      await db.collection('daily_tracking_entries').countDocuments({
        workspaceId: seed.workspaceObjectId,
        relationshipId: seed.relationshipObjectId,
        localDate: today,
      }),
    ).toBe(1);
    expect(dailyRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    const current = await db.collection('coaching_relationships').findOne({
      _id: seed.relationshipObjectId,
    });
    const endRace = await Promise.allSettled([
      createMeasurementIdempotently(container, seed, metric.metricDefinition.id, 14, 'end-race'),
      container.coachingRelationships.transition(
        seed.relationshipObjectId,
        seed.workspaceObjectId,
        current?.version ?? 0,
        ['ACTIVE'],
        'ENDED',
        { endedBy: new ObjectId(seed.ownerCtx.userId), endedAt: new Date(), endReason: 'race' },
        { closeEngagement: true },
      ),
    ]);
    expect(endRace.filter((result) => result.status === 'fulfilled').length).toBeGreaterThanOrEqual(
      1,
    );
    const ended = await db.collection('coaching_relationships').findOne({
      _id: seed.relationshipObjectId,
    });
    if (ended?.status === 'ENDED') {
      await expect(
        createMeasurementIdempotently(container, seed, metric.metricDefinition.id, 15, 'post-end'),
      ).rejects.toMatchObject({ code: 'RELATIONSHIP_NOT_PROGRESS_OPEN' });
      await expect(
        container.progress.putHealthProfile(
          seed.traineeCtx,
          seed.workspaceId,
          seed.relationshipId,
          {
            foodAllergies: ['ended'],
          },
        ),
      ).rejects.toMatchObject({ code: 'RELATIONSHIP_NOT_PROGRESS_OPEN' });
      await expect(
        container.progress.createNote(seed.trainerCtx, seed.workspaceId, seed.relationshipId, {
          category: 'ended',
          content: 'ended',
        }),
      ).rejects.toMatchObject({ code: 'RELATIONSHIP_NOT_PROGRESS_OPEN' });
      await expect(
        container.progress.putDailyTracking(
          seed.traineeCtx,
          seed.workspaceId,
          seed.relationshipId,
          today,
          {
            expectedVersion: 0,
            values: { WATER: { ml: 100 } },
          },
        ),
      ).rejects.toMatchObject({ code: 'RELATIONSHIP_NOT_PROGRESS_OPEN' });
    }

    const healthEndSeed = await seedGym(container);
    const healthCurrent = await db.collection('coaching_relationships').findOne({
      _id: healthEndSeed.relationshipObjectId,
    });
    const healthEndRace = await Promise.allSettled([
      container.progress.putHealthProfile(
        healthEndSeed.traineeCtx,
        healthEndSeed.workspaceId,
        healthEndSeed.relationshipId,
        { foodAllergies: ['race'] },
      ),
      container.coachingRelationships.transition(
        healthEndSeed.relationshipObjectId,
        healthEndSeed.workspaceObjectId,
        healthCurrent?.version ?? 0,
        ['ACTIVE'],
        'ENDED',
        { endedBy: new ObjectId(healthEndSeed.ownerCtx.userId), endedAt: new Date() },
        { closeEngagement: true },
      ),
    ]);
    expect(
      healthEndRace.filter((result) => result.status === 'fulfilled').length,
    ).toBeGreaterThanOrEqual(1);
    await expect(
      container.progress.putHealthProfile(
        healthEndSeed.traineeCtx,
        healthEndSeed.workspaceId,
        healthEndSeed.relationshipId,
        { foodAllergies: ['post-end'] },
      ),
    ).rejects.toMatchObject({ code: 'RELATIONSHIP_NOT_PROGRESS_OPEN' });

    const noteEndSeed = await seedGym(container);
    const noteCurrent = await db.collection('coaching_relationships').findOne({
      _id: noteEndSeed.relationshipObjectId,
    });
    const noteEndRace = await Promise.allSettled([
      container.progress.createNote(
        noteEndSeed.trainerCtx,
        noteEndSeed.workspaceId,
        noteEndSeed.relationshipId,
        { category: 'race', content: 'race' },
      ),
      container.coachingRelationships.transition(
        noteEndSeed.relationshipObjectId,
        noteEndSeed.workspaceObjectId,
        noteCurrent?.version ?? 0,
        ['ACTIVE'],
        'ENDED',
        { endedBy: new ObjectId(noteEndSeed.ownerCtx.userId), endedAt: new Date() },
        { closeEngagement: true },
      ),
    ]);
    expect(
      noteEndRace.filter((result) => result.status === 'fulfilled').length,
    ).toBeGreaterThanOrEqual(1);
    await expect(
      container.progress.createNote(
        noteEndSeed.trainerCtx,
        noteEndSeed.workspaceId,
        noteEndSeed.relationshipId,
        { category: 'post-end', content: 'post-end' },
      ),
    ).rejects.toMatchObject({ code: 'RELATIONSHIP_NOT_PROGRESS_OPEN' });

    const dailyEndSeed = await seedGym(container);
    await container.progress.putAdherenceConfig(
      dailyEndSeed.trainerCtx,
      dailyEndSeed.workspaceId,
      dailyEndSeed.relationshipId,
      { enabledMetrics: ['WATER'] },
    );
    const dailyEndDate = localDateInTimezone(new Date(), 'Africa/Cairo');
    const dailyCurrent = await db.collection('coaching_relationships').findOne({
      _id: dailyEndSeed.relationshipObjectId,
    });
    const dailyEndRace = await Promise.allSettled([
      container.progress.putDailyTracking(
        dailyEndSeed.traineeCtx,
        dailyEndSeed.workspaceId,
        dailyEndSeed.relationshipId,
        dailyEndDate,
        { values: { WATER: { ml: 100 } } },
      ),
      container.coachingRelationships.transition(
        dailyEndSeed.relationshipObjectId,
        dailyEndSeed.workspaceObjectId,
        dailyCurrent?.version ?? 0,
        ['ACTIVE'],
        'ENDED',
        { endedBy: new ObjectId(dailyEndSeed.ownerCtx.userId), endedAt: new Date() },
        { closeEngagement: true },
      ),
    ]);
    expect(
      dailyEndRace.filter((result) => result.status === 'fulfilled').length,
    ).toBeGreaterThanOrEqual(1);
    await expect(
      container.progress.putDailyTracking(
        dailyEndSeed.traineeCtx,
        dailyEndSeed.workspaceId,
        dailyEndSeed.relationshipId,
        dailyEndDate,
        { expectedVersion: 0, values: { WATER: { ml: 200 } } },
      ),
    ).rejects.toMatchObject({ code: 'RELATIONSHIP_NOT_PROGRESS_OPEN' });

    const outboxMetricSeed = await seedGym(container);
    const outboxMetric = await createMetric(container, outboxMetricSeed, 'Outbox Rollback');
    const originalOutbox = container.outbox.write.bind(container.outbox);
    container.outbox.write = (async () => {
      throw new Error('outbox failed');
    }) as typeof container.outbox.write;
    try {
      await expect(
        createMeasurementIdempotently(
          container,
          outboxMetricSeed,
          outboxMetric.metricDefinition.id,
          20,
          'outbox-rollback',
        ),
      ).rejects.toThrow('outbox failed');
    } finally {
      container.outbox.write = originalOutbox;
    }
    expect(
      await db.collection('measurement_entries').countDocuments({
        relationshipId: outboxMetricSeed.relationshipObjectId,
        value: 20,
      }),
    ).toBe(0);

    const auditSeed = await seedGym(container);
    const originalAudit = container.audit.write.bind(container.audit);
    container.audit.write = (async () => {
      throw new Error('daily audit failed');
    }) as typeof container.audit.write;
    try {
      await expect(
        container.progress.putAdherenceConfig(
          auditSeed.trainerCtx,
          auditSeed.workspaceId,
          auditSeed.relationshipId,
          {
            enabledMetrics: ['WATER'],
          },
        ),
      ).rejects.toThrow('daily audit failed');
    } finally {
      container.audit.write = originalAudit;
    }
    expect(
      await db.collection('adherence_configs').countDocuments({
        relationshipId: auditSeed.relationshipObjectId,
      }),
    ).toBe(0);
  });
});

async function assertStage11DbShape(db: Db) {
  for (const name of [
    'metric_definitions',
    'measurement_entries',
    'progress_photo_entries',
    'trainee_health_profiles',
    'coaching_notes',
    'adherence_configs',
    'daily_tracking_entries',
  ]) {
    expect(await db.listCollections({ name }).hasNext()).toBe(true);
  }
  for (const forbidden of ['check_ins', 'files', 'notifications', 'daily_food_logs']) {
    expect(await db.listCollections({ name: forbidden }).hasNext()).toBe(false);
  }
  expect(
    await db.collection('metric_definitions').findOne({ key: 'BODY_WEIGHT', unit: 'KG' }),
  ).toBeTruthy();
  expect(
    await db.collection('permission_definitions').countDocuments({ key: 'progress_photos.delete' }),
  ).toBe(1);
  expect(
    await db
      .collection('permission_definitions')
      .countDocuments({ key: 'health.food_allergies.read' }),
  ).toBe(1);
}

async function seedGym(container: AppContainer, options: { timezone?: string } = {}) {
  const db = container.database.db;
  const owner = await seedUser(db, `owner-${new ObjectId().toHexString()}@example.com`);
  const trainer = await seedUser(db, `trainer-${new ObjectId().toHexString()}@example.com`);
  const trainee = await seedUser(db, `trainee-${new ObjectId().toHexString()}@example.com`);
  const assistant = await seedUser(db, `assistant-${new ObjectId().toHexString()}@example.com`);
  const workspace = await container.workspaceRepo.create({
    type: 'GYM',
    name: 'Stage 11 Gym',
    ownerUserId: owner._id,
    timezone: options.timezone ?? 'Africa/Cairo',
    defaultLanguage: 'en',
  });
  await seedCommercial(db, workspace._id, ['training', 'nutrition', 'progress']);
  const branch = await container.branches.create({
    workspaceId: workspace._id,
    name: 'Main',
    timezone: options.timezone ?? 'Africa/Cairo',
  });
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
  const assistantMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: assistant._id,
    roles: ['ASSISTANT_TRAINER'],
  });
  const traineeMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: trainee._id,
    roles: ['TRAINEE'],
  });
  await assignSystemProfile(container, workspace._id, ownerMembership._id, 'GYM_OWNER');
  await assignSystemProfile(container, workspace._id, trainerMembership._id, 'TRAINER');
  await assignSystemProfile(container, workspace._id, assistantMembership._id, 'ASSISTANT_TRAINER');
  await assignSystemProfile(container, workspace._id, traineeMembership._id, 'TRAINEE');
  await container.membershipBranchAssignments.createActive(
    workspace._id,
    trainerMembership._id,
    branch._id,
  );
  await container.membershipBranchAssignments.createActive(
    workspace._id,
    assistantMembership._id,
    branch._id,
  );
  const relationship = await container.coachingRelationships.createActive({
    workspaceId: workspace._id,
    traineeUserId: trainee._id,
    traineeMembershipId: traineeMembership._id,
    homeBranchId: branch._id,
    activatedBy: owner._id,
  });
  const primary = await container.coachingRelationships.createAssignment({
    workspaceId: workspace._id,
    relationshipId: relationship._id,
    staffMembershipId: trainerMembership._id,
    assignmentType: 'PRIMARY_TRAINER',
    assignedBy: owner._id,
  });
  await container.coachingRelationships.createAssignment({
    workspaceId: workspace._id,
    relationshipId: relationship._id,
    staffMembershipId: assistantMembership._id,
    assignmentType: 'ASSISTANT_TRAINER',
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
    branchObjectId: branch._id,
    relationshipId: active._id.toHexString(),
    relationshipObjectId: active._id,
    relationshipVersion: active.version,
    ownerMembershipId: ownerMembership._id.toHexString(),
    trainerMembershipId: trainerMembership._id.toHexString(),
    assistantMembershipId: assistantMembership._id.toHexString(),
    traineeMembershipId: traineeMembership._id.toHexString(),
    ownerCtx: ctx(owner._id, ownerMembership._id),
    trainerCtx: ctx(trainer._id, trainerMembership._id),
    traineeCtx: ctx(trainee._id, traineeMembership._id),
    assistantCtx: ctx(assistant._id, assistantMembership._id),
  };
}

async function seedManager(container: AppContainer, seed: Awaited<ReturnType<typeof seedGym>>) {
  const user = await seedUser(
    container.database.db,
    `manager-${new ObjectId().toHexString()}@example.com`,
  );
  const membership = await container.workspaceMemberships.createActive({
    workspaceId: seed.workspaceObjectId,
    userId: user._id,
    roles: ['GYM_MANAGER'],
  });
  await assignSystemProfile(container, seed.workspaceObjectId, membership._id, 'GYM_MANAGER');
  return { ctx: ctx(user._id, membership._id), membership };
}

async function seedNutritionist(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
) {
  const user = await seedUser(
    container.database.db,
    `nutritionist-${new ObjectId().toHexString()}@example.com`,
  );
  const membership = await container.workspaceMemberships.createActive({
    workspaceId: seed.workspaceObjectId,
    userId: user._id,
    roles: ['NUTRITIONIST'],
  });
  await assignSystemProfile(container, seed.workspaceObjectId, membership._id, 'NUTRITIONIST');
  await container.coachingRelationships.createAssignment({
    workspaceId: seed.workspaceObjectId,
    relationshipId: seed.relationshipObjectId,
    staffMembershipId: membership._id,
    assignmentType: 'NUTRITIONIST',
    assignedBy: new ObjectId(seed.ownerCtx.userId),
  });
  return { ctx: ctx(user._id, membership._id), membership };
}

async function seedIndependent(container: AppContainer) {
  const seed = await seedGym(container);
  await dbSetWorkspaceType(container.database.db, seed.workspaceObjectId, 'INDEPENDENT_TRAINER');
  return { ...seed, trainerCtx: seed.trainerCtx };
}

async function createMetric(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  name: string,
  options: {
    key?: string;
    unit?: string;
    valueType?: 'NUMBER' | 'INTEGER';
    scope?: 'GYM' | 'PRIVATE';
  } = {},
  actorCtx: ReturnType<typeof ctx> = seed.ownerCtx,
) {
  return await container.progress.createMetricDefinition(actorCtx, seed.workspaceId, {
    scope: options.scope ?? 'GYM',
    ...(options.key ? { key: options.key } : {}),
    name,
    valueType: options.valueType ?? 'NUMBER',
    unit: options.unit ?? 'CM',
    category: 'BODY',
  });
}

async function createMeasurementIdempotently(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  metricDefinitionId: string,
  value: number,
  key: string,
  actorCtx: ReturnType<typeof ctx> = seed.traineeCtx,
  source: 'TRAINEE' | 'TRAINER' | 'INBODY' | 'OTHER' = 'TRAINEE',
) {
  return await container.idempotency.runInTransaction(actorCtx, {
    routeKey: 'POST /workspaces/:workspaceId/relationships/:relationshipId/measurements',
    key,
    fingerprint: {
      params: { workspaceId: seed.workspaceId, relationshipId: seed.relationshipId },
      body: {
        metricDefinitionId,
        value,
        measuredAt: '2026-01-01T08:00:00.000Z',
        source,
      },
    },
    unitOfWork: container.unitOfWork,
    operation: async (tx) => ({
      body: await container.progress.createMeasurement(
        actorCtx,
        seed.workspaceId,
        seed.relationshipId,
        { metricDefinitionId, value, measuredAt: '2026-01-01T08:00:00.000Z', source },
        tx,
      ),
    }),
  });
}

function progressPhoto(
  seed: Awaited<ReturnType<typeof seedGym>>,
  visibility: 'PRIVATE' | 'TRAINER_VISIBLE',
) {
  const now = new Date();
  return {
    _id: new ObjectId(),
    workspaceId: seed.workspaceObjectId,
    relationshipId: seed.relationshipObjectId,
    capturedAt: now,
    visibility,
    photos: [{ type: 'FRONT', fileId: new ObjectId() }],
    createdBy: new ObjectId(seed.traineeCtx.userId),
    version: 0,
    createdAt: now,
    updatedAt: now,
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
    lastName: 'Eleven',
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

async function writeGrant(
  db: Db,
  input: {
    workspaceId: ObjectId;
    subjectId: ObjectId;
    permission: string;
    effect: 'ALLOW' | 'DENY';
  },
) {
  await db.collection('access_grants').insertOne({
    _id: new ObjectId(),
    context: 'WORKSPACE',
    workspaceId: input.workspaceId,
    subjectType: 'WORKSPACE_MEMBERSHIP',
    subjectId: input.subjectId,
    permission: input.permission,
    effect: input.effect,
    scope: { type: 'WORKSPACE' },
    createdBy: input.subjectId,
    createdAt: new Date(),
  });
}

function rejectedCodes(results: PromiseSettledResult<unknown>[]) {
  return results.flatMap((result) =>
    result.status === 'rejected' &&
    result.reason &&
    typeof result.reason === 'object' &&
    'code' in result.reason
      ? [String(result.reason.code)]
      : [],
  );
}

async function dbSetWorkspaceType(db: Db, workspaceId: ObjectId, type: string) {
  await db.collection('workspaces').updateOne({ _id: workspaceId }, { $set: { type } });
}

function indexes(calls: Array<{ collection: string; indexes: unknown[] }>, collection: string) {
  return calls.find((call) => call.collection === collection)?.indexes;
}

function localDateInTimezone(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function previousLocalDate(localDate: string) {
  const [year = 0, month = 1, day = 1] = localDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function nextLocalDate(localDate: string) {
  const [year = 0, month = 1, day = 1] = localDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

async function withFrozenNow<T>(iso: string, run: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const fixed = new RealDate(iso);
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(fixed.getTime());
        return;
      }
      if (args.length === 1) {
        const value = args[0];
        super(value instanceof RealDate ? value.getTime() : (value as string | number));
        return;
      }
      const [year = 0, month = 0, day = 1, hours = 0, minutes = 0, seconds = 0, milliseconds = 0] =
        args as number[];
      super(year, month, day, hours, minutes, seconds, milliseconds);
    }

    static override now() {
      return fixed.getTime();
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;
  try {
    return await run();
  } finally {
    globalThis.Date = RealDate;
  }
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
