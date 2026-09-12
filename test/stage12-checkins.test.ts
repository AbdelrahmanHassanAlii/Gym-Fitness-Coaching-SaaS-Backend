import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Db, ObjectId } from 'mongodb';
import type { AppContainer } from '../src/bootstrap/app-container';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { migrations } from '../src/migrations';
import { migration017Stage12CheckIns } from '../src/migrations/017-stage12-checkins';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { systemPermissionProfiles } from '../src/modules/permissions/permission.registry';

describe('Stage 12 migration 017', () => {
  test('creates exact check-in collections, correctness indexes, and permission seeds', async () => {
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

    await migration017Stage12CheckIns.up(db as never);

    expect(indexes(calls, 'checkin_instances')).toContainEqual(
      expect.objectContaining({ name: 'checkin_instances_assignment_period_unique', unique: true }),
    );
    expect(indexes(calls, 'checkin_template_revisions')).toContainEqual(
      expect.objectContaining({
        name: 'checkin_template_revisions_template_revision_unique',
        unique: true,
      }),
    );
    expect(indexes(calls, 'checkin_assignments')).toContainEqual(
      expect.objectContaining({ name: 'checkin_assignments_active_template_unique', unique: true }),
    );
    expect(indexes(calls, 'files')).toBeUndefined();
    expect(indexes(calls, 'notifications')).toBeUndefined();
    expect(JSON.stringify(updates)).toContain('checkins.templates.read');
    expect(JSON.stringify(updates)).toContain('checkins.review');
  });

  test('runs clean 001-017, upgrade 001-016 to 017, reruns, and enforces unique indexes', async () => {
    const clean = await createAppContainer(integrationConfig(`stage12_clean_${new ObjectId()}`));
    const upgrade = await createAppContainer(
      integrationConfig(`stage12_upgrade_${new ObjectId()}`),
    );
    try {
      await new MigrationRunner(clean.database.db, migrations).migrate();
      await new MigrationRunner(clean.database.db, migrations).migrate();
      await new MigrationRunner(upgrade.database.db, migrations.slice(0, -1)).migrate();
      await new MigrationRunner(upgrade.database.db, [migration017Stage12CheckIns]).migrate();
      await new MigrationRunner(upgrade.database.db, [migration017Stage12CheckIns]).migrate();
      const names = (await clean.database.db.collection('checkin_instances').indexes()).map(
        (index) => index.name,
      );
      expect(names).toContain('checkin_instances_assignment_period_unique');
      const seed = await seedGym(clean);
      const template = await createTemplate(clean, seed);
      const assignment = await createAssignment(clean, seed, template.template.id);
      const period = {
        periodKey: '2026-W01',
        periodStartAt: new Date('2025-12-29T00:00:00.000Z'),
        periodEndAt: new Date('2026-01-05T00:00:00.000Z'),
        opensAt: new Date('2025-12-29T00:00:00.000Z'),
        dueAt: new Date('2026-01-03T00:00:00.000Z'),
        timezone: 'UTC',
        dayOfWeek: 5,
      };
      await clean.database.db.collection('checkin_instances').insertOne({
        _id: new ObjectId(),
        workspaceId: seed.workspaceObjectId,
        relationshipId: seed.relationshipObjectId,
        assignmentId: new ObjectId(assignment.assignment.id),
        templateId: new ObjectId(template.template.id),
        templateRevisionId: new ObjectId(template.template.currentRevisionId),
        ...period,
        status: 'DUE',
        responses: [],
        version: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await expect(
        clean.database.db.collection('checkin_instances').insertOne({
          _id: new ObjectId(),
          workspaceId: seed.workspaceObjectId,
          relationshipId: seed.relationshipObjectId,
          assignmentId: new ObjectId(assignment.assignment.id),
          templateId: new ObjectId(template.template.id),
          templateRevisionId: new ObjectId(template.template.currentRevisionId),
          ...period,
          status: 'DUE',
          responses: [],
          version: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ).rejects.toMatchObject({ code: 11000 });
    } finally {
      await clean.database.db.dropDatabase();
      await upgrade.database.db.dropDatabase();
      await clean.database.close();
      await upgrade.database.close();
    }
  }, 30_000);
});

describe('Stage 12 check-ins integration', () => {
  let container: AppContainer;
  let db: Db;

  beforeAll(async () => {
    container = await createAppContainer(integrationConfig(`stage12_${new ObjectId()}`));
    await new MigrationRunner(container.database.db, migrations).migrate();
    db = container.database.db;
  }, 30_000);

  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (container) await container.database.close();
  });

  test('template creation, immutable revisions, field validation, and archive protection', async () => {
    const seed = await seedGym(container);
    const created = await createTemplate(container, seed);
    expect(created.template.status).toBe('ACTIVE');
    expect(created.revision.revision).toBe(1);
    await expect(
      container.checkins.createTemplate(seed.ownerCtx, seed.workspaceId, {
        name: 'Photo',
        fields: [{ fieldKey: 'photo', type: 'PHOTO', label: 'Photo', required: false }],
      }),
    ).rejects.toMatchObject({ code: 'CHECKIN_FIELD_TYPE_NOT_SUPPORTED' });
    await expect(
      container.checkins.createTemplate(seed.ownerCtx, seed.workspaceId, {
        name: 'Measure',
        fields: [{ fieldKey: 'weight', type: 'MEASUREMENT', label: 'Weight', required: true }],
      }),
    ).rejects.toMatchObject({ code: 'CHECKIN_FIELD_TYPE_NOT_SUPPORTED' });
    await expect(
      container.checkins.createTemplate(seed.ownerCtx, seed.workspaceId, {
        name: 'Dup',
        fields: [
          { fieldKey: 'energy', type: 'RATING', label: 'Energy', required: true },
          { fieldKey: 'energy', type: 'TEXT', label: 'Again', required: false },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CHECKIN_FIELD_KEY_DUPLICATE' });

    const updated = await container.checkins.createRevision(
      seed.ownerCtx,
      seed.workspaceId,
      created.template.id,
      {
        expectedVersion: created.template.version,
        fields: [
          { fieldKey: 'energy', type: 'RATING', label: 'Energy', required: true },
          { fieldKey: 'week', type: 'LONG_TEXT', label: 'Week', required: false },
        ],
      },
    );
    expect(updated.template.version).toBe(1);
    expect(await db.collection('checkin_template_revisions').countDocuments()).toBe(2);
    await expect(
      container.checkins.createRevision(seed.ownerCtx, seed.workspaceId, created.template.id, {
        expectedVersion: created.template.version,
        fields: [{ fieldKey: 'energy', type: 'RATING', label: 'Energy', required: true }],
      }),
    ).rejects.toMatchObject({ code: 'CHECKIN_TEMPLATE_VERSION_CONFLICT' });

    const assignment = await createAssignment(container, seed, created.template.id);
    await expect(
      container.checkins.archiveTemplate(seed.ownerCtx, seed.workspaceId, created.template.id, {
        expectedVersion: updated.template.version,
      }),
    ).rejects.toMatchObject({ code: 'CHECKIN_TEMPLATE_IN_USE' });
    await container.checkins.endAssignment(
      seed.ownerCtx,
      seed.workspaceId,
      seed.relationshipId,
      assignment.assignment.id,
      { expectedVersion: assignment.assignment.version },
    );
    const archived = await container.checkins.archiveTemplate(
      seed.ownerCtx,
      seed.workspaceId,
      created.template.id,
      {
        expectedVersion: updated.template.version,
      },
    );
    expect(archived.template.status).toBe('ARCHIVED');
  });

  test('weekly timezone generation, year/DST-safe period keys, due/overdue events, and revision pinning', async () => {
    const seed = await seedGym(container);
    const template = await createTemplate(container, seed);
    const assignment = await createAssignment(container, seed, template.template.id, {
      startedAt: '2025-12-31T10:00:00.000Z',
      recurrence: { frequency: 'WEEKLY', dayOfWeek: 5, timezone: 'America/New_York' },
    });
    await container.checkins.generateDueInstances(new Date('2026-01-01T12:00:00.000Z'));
    let instances = await db
      .collection('checkin_instances')
      .find({ assignmentId: new ObjectId(assignment.assignment.id) })
      .sort({ periodKey: 1 })
      .toArray();
    expect(instances.map((item) => item.periodKey)).toContain('2026-W01');
    expect(instances[0]?.timezone).toBe('America/New_York');
    expect(instances[0]?.status).toBe('DUE');

    await container.checkins.createRevision(seed.ownerCtx, seed.workspaceId, template.template.id, {
      expectedVersion: template.template.version,
      fields: [{ fieldKey: 'sleep', type: 'NUMBER', label: 'Sleep', required: true }],
    });
    await Promise.all([
      container.checkins.generateDueInstances(new Date('2026-01-06T12:00:00.000Z')),
      container.checkins.generateDueInstances(new Date('2026-01-06T12:00:00.000Z')),
    ]);
    instances = await db
      .collection('checkin_instances')
      .find({ assignmentId: new ObjectId(assignment.assignment.id) })
      .sort({ periodKey: 1 })
      .toArray();
    expect(new Set(instances.map((item) => item.periodKey)).size).toBe(instances.length);
    expect(instances[0]?.templateRevisionId.toHexString()).toBe(
      template.template.currentRevisionId,
    );
    expect(instances.at(-1)?.templateRevisionId.equals(instances[0]?.templateRevisionId)).toBe(
      false,
    );
    await container.checkins.markOverdue(new Date('2026-01-10T12:00:00.000Z'));
    const overdue = await db.collection('checkin_instances').findOne({ periodKey: '2026-W01' });
    expect(overdue?.status).toBe('OVERDUE');
    const eventTypes = await db.collection('outbox_events').distinct('eventType', {
      aggregateType: 'checkin_instance',
    });
    expect(eventTypes).toContain('CheckInDue');
    expect(eventTypes).toContain('CheckInOverdue');
    const payloads = await db.collection('outbox_events').find({}).toArray();
    expect(JSON.stringify(payloads)).not.toContain('How was');
  });

  test('assignment eligibility, recurrence normalization, invalid timezone, and schedule updates preserve generated instances', async () => {
    const seed = await seedGym(container);
    const template = await createTemplate(container, seed);
    await expect(
      createAssignment(container, seed, template.template.id, {
        recurrence: { frequency: 'WEEKLY', dayOfWeek: 3, timezone: 'No/Such_Zone' },
      }),
    ).rejects.toMatchObject({ code: 'CHECKIN_TIMEZONE_INVALID' });
    const assignment = await createAssignment(container, seed, template.template.id, {
      startedAt: '2026-03-08T05:00:00.000Z',
      recurrence: { frequency: 'WEEKLY', timezone: 'America/New_York' },
    });
    expect(assignment.assignment.recurrence.dayOfWeek).toBe(7);
    await container.checkins.generateDueInstances(new Date('2026-03-08T06:00:00.000Z'));
    const first = await db.collection('checkin_instances').findOne({
      assignmentId: new ObjectId(assignment.assignment.id),
    });
    if (!first) throw new Error('expected generated instance');
    const updated = await container.checkins.updateAssignment(
      seed.ownerCtx,
      seed.workspaceId,
      seed.relationshipId,
      assignment.assignment.id,
      {
        expectedVersion: assignment.assignment.version,
        recurrence: { frequency: 'WEEKLY', dayOfWeek: 1, timezone: 'Europe/Berlin' },
      },
    );
    expect(updated.assignment.recurrence.timezone).toBe('Europe/Berlin');
    const after = await db.collection('checkin_instances').findOne({ _id: first._id });
    expect(after?.timezone).toBe('America/New_York');
    expect(after?.dayOfWeek).toBe(7);
  });

  test('concurrency matrix preserves serial Stage 12 outcomes', async () => {
    const seed = await seedGym(container);
    const template = await createTemplate(container, seed);

    const revisions = await Promise.allSettled([
      container.checkins.createRevision(seed.ownerCtx, seed.workspaceId, template.template.id, {
        expectedVersion: template.template.version,
        fields: [{ fieldKey: 'sleep', type: 'NUMBER', label: 'Sleep', required: true }],
      }),
      container.checkins.createRevision(seed.ownerCtx, seed.workspaceId, template.template.id, {
        expectedVersion: template.template.version,
        fields: [{ fieldKey: 'stress', type: 'RATING', label: 'Stress', required: true }],
      }),
    ]);
    expect(revisions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await db.collection('checkin_template_revisions').countDocuments({
        templateId: new ObjectId(template.template.id),
      }),
    ).toBe(2);

    const archiveRaceTemplate = await createTemplate(container, seed);
    const archiveRace = await Promise.allSettled([
      container.checkins.archiveTemplate(
        seed.ownerCtx,
        seed.workspaceId,
        archiveRaceTemplate.template.id,
        { expectedVersion: archiveRaceTemplate.template.version },
      ),
      createAssignment(container, seed, archiveRaceTemplate.template.id),
    ]);
    expect(archiveRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const archiveRaceAssignments = await db.collection('checkin_assignments').countDocuments({
      templateId: new ObjectId(archiveRaceTemplate.template.id),
      active: true,
    });
    const archiveRaceFinal = await db.collection('checkin_templates').findOne({
      _id: new ObjectId(archiveRaceTemplate.template.id),
    });
    expect(archiveRaceFinal?.status === 'ACTIVE' || archiveRaceAssignments === 0).toBe(true);

    const assignment = await createAssignment(container, seed, template.template.id);
    await Promise.all([
      container.checkins.generateDueInstances(new Date('2026-01-06T12:00:00.000Z')),
      container.checkins.generateDueInstances(new Date('2026-01-06T12:00:00.000Z')),
    ]);
    let instances = await db
      .collection('checkin_instances')
      .find({ assignmentId: new ObjectId(assignment.assignment.id) })
      .toArray();
    expect(new Set(instances.map((item) => item.periodKey)).size).toBe(instances.length);

    await Promise.all([
      container.checkins.generateDueInstances(new Date('2026-01-07T00:00:00.000Z')),
      container.checkins.generateDueInstances(new Date('2026-01-07T00:00:00.000Z')),
    ]);
    await Promise.all([
      container.checkins.markOverdue(new Date('2026-01-08T00:00:00.000Z')),
      container.checkins.markOverdue(new Date('2026-01-08T00:00:00.000Z')),
    ]);
    instances = await db
      .collection('checkin_instances')
      .find({ assignmentId: new ObjectId(assignment.assignment.id) })
      .toArray();
    expect(new Set(instances.map((item) => item.periodKey)).size).toBe(instances.length);

    const relationship = await db.collection('coaching_relationships').findOne({
      _id: seed.relationshipObjectId,
    });
    await Promise.allSettled([
      container.checkins.endAssignment(
        seed.ownerCtx,
        seed.workspaceId,
        seed.relationshipId,
        assignment.assignment.id,
        { expectedVersion: assignment.assignment.version },
      ),
      container.checkins.generateDueInstances(new Date('2026-01-14T12:00:00.000Z')),
    ]);
    const endedAssignment = await db.collection('checkin_assignments').findOne({
      _id: new ObjectId(assignment.assignment.id),
    });
    expect(endedAssignment?.active).toBe(false);
    await container.trainees.endRelationship(seed.ownerCtx, seed.workspaceId, seed.relationshipId, {
      expectedVersion: relationship?.version ?? -1,
    });
    await container.checkins.generateDueInstances(new Date('2026-01-21T12:00:00.000Z'));
    expect(
      await db.collection('checkin_assignments').countDocuments({
        relationshipId: seed.relationshipObjectId,
        active: true,
      }),
    ).toBe(archiveRaceAssignments);
  });

  test('sensitive instance access, self-only submission, response validation, review authorization, and idempotency', async () => {
    const seed = await seedGym(container);
    const template = await createTemplate(container, seed);
    const assignment = await createAssignment(container, seed, template.template.id);
    await container.checkins.generateDueInstances(new Date('2026-01-07T12:00:00.000Z'));
    const instance = await db.collection('checkin_instances').findOne({
      assignmentId: new ObjectId(assignment.assignment.id),
    });
    expect(instance).toBeTruthy();
    await expect(
      container.checkins.submit(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        instance?._id.toHexString() ?? '',
        {
          expectedVersion: 0,
          responses: [{ fieldKey: 'energy', value: 5 }],
        },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      submitIdempotently(container, seed, instance?._id.toHexString() ?? '', 'bad', 0, [
        { fieldKey: 'unknown', value: 'no' },
      ]),
    ).rejects.toMatchObject({ code: 'CHECKIN_INVALID_RESPONSES' });
    const submitted = await submitIdempotently(
      container,
      seed,
      instance?._id.toHexString() ?? '',
      'submit-1',
      0,
      [
        { fieldKey: 'energy', value: 4 },
        { fieldKey: 'notes', value: 'Hard week' },
        { fieldKey: 'ready', value: true },
      ],
    );
    const replay = await submitIdempotently(
      container,
      seed,
      instance?._id.toHexString() ?? '',
      'submit-1',
      0,
      [
        { fieldKey: 'energy', value: 4 },
        { fieldKey: 'notes', value: 'Hard week' },
        { fieldKey: 'ready', value: true },
      ],
    );
    expect(replay.checkin.id).toBe(submitted.checkin.id);
    await expect(
      submitIdempotently(container, seed, instance?._id.toHexString() ?? '', 'submit-2', 1, [
        { fieldKey: 'energy', value: 4 },
      ]),
    ).rejects.toMatchObject({ code: 'CHECKIN_ALREADY_SUBMITTED' });

    await expect(
      reviewIdempotently(
        container,
        seed,
        seed.assistantCtx,
        instance?._id.toHexString() ?? '',
        'review-a',
        1,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const reviewed = await reviewIdempotently(
      container,
      seed,
      seed.trainerCtx,
      instance?._id.toHexString() ?? '',
      'review-1',
      1,
    );
    expect(reviewed.checkin.status).toBe('REVIEWED');
    await expect(
      reviewIdempotently(
        container,
        seed,
        seed.trainerCtx,
        instance?._id.toHexString() ?? '',
        'review-2',
        2,
      ),
    ).rejects.toMatchObject({ code: 'CHECKIN_ALREADY_REVIEWED' });
    const events = await db
      .collection('outbox_events')
      .find({ eventType: 'CheckInReviewed' })
      .toArray();
    expect(JSON.stringify(events)).not.toContain('Looks good');
  });

  test('NEEDS_REASSIGNMENT continues generation/submission, ENDED stops generation and skips open instances', async () => {
    const seed = await seedGym(container);
    const template = await createTemplate(container, seed);
    const assignment = await createAssignment(container, seed, template.template.id);
    const rel = await db
      .collection('coaching_relationships')
      .findOne({ _id: seed.relationshipObjectId });
    await container.coachingRelationships.transition(
      seed.relationshipObjectId,
      seed.workspaceObjectId,
      rel?.version ?? -1,
      ['ACTIVE'],
      'NEEDS_REASSIGNMENT',
      {},
    );
    await container.checkins.generateDueInstances(new Date('2026-01-07T12:00:00.000Z'));
    const instance = await db.collection('checkin_instances').findOne({
      assignmentId: new ObjectId(assignment.assignment.id),
    });
    const submitted = await submitIdempotently(
      container,
      seed,
      instance?._id.toHexString() ?? '',
      'needs-submit',
      0,
      [
        { fieldKey: 'energy', value: 5 },
        { fieldKey: 'notes', value: 'Still checking in' },
        { fieldKey: 'ready', value: false },
      ],
    );
    expect(submitted.checkin.status).toBe('SUBMITTED');

    await container.checkins.generateDueInstances(new Date('2026-01-14T12:00:00.000Z'));
    const open = await db.collection('checkin_instances').findOne({
      assignmentId: new ObjectId(assignment.assignment.id),
      status: { $in: ['DUE', 'UPCOMING', 'OVERDUE'] },
    });
    if (!open) throw new Error('expected open instance');
    const beforeEnd = await db
      .collection('coaching_relationships')
      .findOne({ _id: seed.relationshipObjectId });
    await container.trainees.endRelationship(seed.ownerCtx, seed.workspaceId, seed.relationshipId, {
      expectedVersion: beforeEnd?.version ?? -1,
      reason: 'done',
    });
    const endedAssignment = await db.collection('checkin_assignments').findOne({
      _id: new ObjectId(assignment.assignment.id),
    });
    expect(endedAssignment?.active).toBe(false);
    const skipped = await db.collection('checkin_instances').findOne({ _id: open._id });
    expect(skipped?.status).toBe('SKIPPED');
    const preserved = await db.collection('checkin_instances').findOne({
      _id: new ObjectId(submitted.checkin.id),
    });
    expect(preserved?.status).toBe('SUBMITTED');
    const countAtEnd = await db.collection('checkin_instances').countDocuments({
      assignmentId: new ObjectId(assignment.assignment.id),
    });
    await container.checkins.generateDueInstances(new Date('2026-01-21T12:00:00.000Z'));
    expect(
      await db.collection('checkin_instances').countDocuments({
        assignmentId: new ObjectId(assignment.assignment.id),
      }),
    ).toBe(countAtEnd);
    await expect(
      container.checkins.submit(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        open._id.toHexString(),
        {
          expectedVersion: skipped?.version ?? -1,
          responses: [{ fieldKey: 'energy', value: 3 }],
        },
      ),
    ).rejects.toThrow('Permission denied.');
  });

  test('commercial write restrictions and transaction rollback preserve Stage 12 consistency', async () => {
    const seed = await seedGym(container);
    await db
      .collection('subscription_terms')
      .updateOne(
        { workspaceId: seed.workspaceObjectId },
        { $set: { enabledFeatures: ['training', 'nutrition', 'progress'] } },
      );
    await expect(createTemplate(container, seed)).rejects.toMatchObject({
      code: 'FEATURE_NOT_AVAILABLE',
    });
    await db
      .collection('subscription_terms')
      .updateOne(
        { workspaceId: seed.workspaceObjectId },
        { $set: { enabledFeatures: ['training', 'nutrition', 'progress', 'checkins'] } },
      );
    await db
      .collection('subscriptions')
      .updateOne({ workspaceId: seed.workspaceObjectId }, { $set: { lifecycleStatus: 'FROZEN' } });
    await expect(createTemplate(container, seed)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_FROZEN',
    });
    await db
      .collection('subscriptions')
      .updateOne({ workspaceId: seed.workspaceObjectId }, { $set: { lifecycleStatus: 'ACTIVE' } });
    const originalAudit = container.audit.write.bind(container.audit);
    container.audit.write = (async () => {
      throw new Error('audit failed');
    }) as typeof container.audit.write;
    await expect(createTemplate(container, seed, 'Rollback')).rejects.toThrow('audit failed');
    container.audit.write = originalAudit;
    expect(await db.collection('checkin_templates').countDocuments({ name: 'Rollback' })).toBe(0);
  });
});

function indexes(calls: Array<{ collection: string; indexes: unknown[] }>, collection: string) {
  return calls.find((call) => call.collection === collection)?.indexes;
}

async function createTemplate(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  name = `Weekly ${new ObjectId()}`,
) {
  return await container.checkins.createTemplate(seed.ownerCtx, seed.workspaceId, {
    name,
    fields: [
      {
        fieldKey: 'energy',
        type: 'RATING',
        label: 'Energy',
        required: true,
        validation: { min: 1, max: 5 },
      },
      { fieldKey: 'notes', type: 'LONG_TEXT', label: 'How was your week?', required: false },
      { fieldKey: 'ready', type: 'BOOLEAN', label: 'Ready?', required: true },
    ],
  });
}

async function createAssignment(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  templateId: string,
  override: Partial<{
    startedAt: string;
    recurrence: { frequency: 'WEEKLY'; dayOfWeek?: number; timezone: string };
  }> = {},
) {
  return await container.checkins.createAssignment(
    seed.ownerCtx,
    seed.workspaceId,
    seed.relationshipId,
    {
      templateId,
      recurrence: override.recurrence ?? { frequency: 'WEEKLY', dayOfWeek: 3, timezone: 'UTC' },
      startedAt: override.startedAt ?? '2026-01-05T00:00:00.000Z',
    },
  );
}

async function submitIdempotently(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  checkinId: string,
  key: string,
  expectedVersion: number,
  responses: Array<{ fieldKey: string; value: string | number | boolean | null }>,
) {
  const result = await container.idempotency.runInTransaction(seed.traineeCtx, {
    routeKey:
      'POST /workspaces/:workspaceId/relationships/:relationshipId/checkins/:checkinId/submit',
    key,
    fingerprint: { checkinId, expectedVersion, responses },
    unitOfWork: container.unitOfWork,
    operation: async (tx) => ({
      body: await container.checkins.submit(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        checkinId,
        { expectedVersion, responses },
        tx,
      ),
      statusCode: 201,
    }),
  });
  return result.body as Awaited<ReturnType<AppContainer['checkins']['submit']>>;
}

async function reviewIdempotently(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  actorCtx: ReturnType<typeof ctx>,
  checkinId: string,
  key: string,
  expectedVersion: number,
) {
  const result = await container.idempotency.runInTransaction(actorCtx, {
    routeKey:
      'POST /workspaces/:workspaceId/relationships/:relationshipId/checkins/:checkinId/review',
    key,
    fingerprint: { checkinId, expectedVersion, comment: 'Looks good' },
    unitOfWork: container.unitOfWork,
    operation: async (tx) => ({
      body: await container.checkins.review(
        actorCtx,
        seed.workspaceId,
        seed.relationshipId,
        checkinId,
        { expectedVersion, trainerFeedback: { comment: 'Looks good' } },
        tx,
      ),
      statusCode: 201,
    }),
  });
  return result.body as Awaited<ReturnType<AppContainer['checkins']['review']>>;
}

async function seedGym(container: AppContainer) {
  const db = container.database.db;
  const owner = await seedUser(db, `owner-${new ObjectId()}@example.com`);
  const trainer = await seedUser(db, `trainer-${new ObjectId()}@example.com`);
  const trainee = await seedUser(db, `trainee-${new ObjectId()}@example.com`);
  const assistant = await seedUser(db, `assistant-${new ObjectId()}@example.com`);
  const workspace = await container.workspaceRepo.create({
    type: 'GYM',
    name: `Stage 12 Gym ${new ObjectId()}`,
    ownerUserId: owner._id,
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
  });
  await seedCommercial(db, workspace._id);
  const branch = await container.branches.create({
    workspaceId: workspace._id,
    name: 'Main',
    timezone: 'Africa/Cairo',
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
  const traineeMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: trainee._id,
    roles: ['TRAINEE'],
  });
  const assistantMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: assistant._id,
    roles: ['ASSISTANT_TRAINER'],
  });
  await assignSystemProfile(container, workspace._id, ownerMembership._id, 'GYM_OWNER');
  await assignSystemProfile(container, workspace._id, trainerMembership._id, 'TRAINER');
  await assignSystemProfile(container, workspace._id, traineeMembership._id, 'TRAINEE');
  await assignSystemProfile(container, workspace._id, assistantMembership._id, 'ASSISTANT_TRAINER');
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
    relationshipId: active._id.toHexString(),
    relationshipObjectId: active._id,
    ownerCtx: ctx(owner._id, ownerMembership._id),
    trainerCtx: ctx(trainer._id, trainerMembership._id),
    traineeCtx: ctx(trainee._id, traineeMembership._id),
    assistantCtx: ctx(assistant._id, assistantMembership._id),
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
    lastName: 'Twelve',
    preferredLanguage: 'en',
    timezone: 'Africa/Cairo',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };
  await db.collection('users').insertOne(user);
  return user;
}

async function seedCommercial(db: Db, workspaceId: ObjectId) {
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
    enabledFeatures: ['training', 'nutrition', 'progress', 'checkins'],
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

function ctx(userId: ObjectId, workspaceMembershipId?: ObjectId) {
  return {
    correlationId: new ObjectId().toHexString(),
    userId: userId.toHexString(),
    authSessionId: new ObjectId().toHexString(),
    ...(workspaceMembershipId
      ? { workspaceMembershipId: workspaceMembershipId.toHexString() }
      : {}),
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
      id: 'stage12-test',
      outboxPollIntervalMs: 50,
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
