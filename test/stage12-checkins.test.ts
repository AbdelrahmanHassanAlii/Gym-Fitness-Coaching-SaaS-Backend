import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Db, ObjectId } from 'mongodb';
import type { AppContainer } from '../src/bootstrap/app-container';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { migrations } from '../src/migrations';
import { migration017Stage12CheckIns } from '../src/migrations/017-stage12-checkins';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { CheckInJobRunner } from '../src/modules/checkins/checkin.jobs';
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

  test('job runner uses configured worker lease identity and ttl for Stage 12 jobs', async () => {
    const calls: Array<{ key: string; ownerId: string; ttlMs: number }> = [];
    const originalAcquire = container.jobLeases.tryAcquire.bind(container.jobLeases);
    const originalRelease = container.jobLeases.release.bind(container.jobLeases);
    const originalGenerate = container.checkins.generateDueInstances.bind(container.checkins);
    const originalOverdue = container.checkins.markOverdue.bind(container.checkins);
    const originalWorker = container.config.worker;
    container.config.worker = { ...originalWorker, id: 'stage12-lease-test', jobLeaseMs: 12_345 };
    container.jobLeases.tryAcquire = (async (key: string, ownerId: string, ttlMs: number) => {
      calls.push({ key, ownerId, ttlMs });
      return true;
    }) as typeof container.jobLeases.tryAcquire;
    container.jobLeases.release = (async () => undefined) as typeof container.jobLeases.release;
    container.checkins.generateDueInstances = (async () => ({
      generated: 0,
    })) as typeof container.checkins.generateDueInstances;
    container.checkins.markOverdue = (async () => ({
      marked: 0,
    })) as typeof container.checkins.markOverdue;
    try {
      await new CheckInJobRunner(container).runDueJobs();
    } finally {
      container.config.worker = originalWorker;
      container.jobLeases.tryAcquire = originalAcquire;
      container.jobLeases.release = originalRelease;
      container.checkins.generateDueInstances = originalGenerate;
      container.checkins.markOverdue = originalOverdue;
    }
    expect(calls).toEqual([
      { key: 'generate-checkins', ownerId: 'stage12-lease-test', ttlMs: 12_345 },
      { key: 'mark-checkins-overdue', ownerId: 'stage12-lease-test', ttlMs: 12_345 },
    ]);
  });

  test('weekly timezone boundaries use exact IANA UTC instants across DST and ISO weeks', async () => {
    const seed = await seedGym(container);
    await expectGeneratedPeriod(container, seed, {
      localName: 'Spring forward',
      startedAt: '2026-03-02T05:00:00.000Z',
      now: '2026-03-03T12:00:00.000Z',
      timezone: 'America/New_York',
      dayOfWeek: 7,
      periodKey: '2026-W10',
      periodStartAt: '2026-03-02T05:00:00.000Z',
      periodEndAt: '2026-03-09T04:00:00.000Z',
      dueAt: '2026-03-09T04:00:00.000Z',
    });
    await expectGeneratedPeriod(container, seed, {
      localName: 'Fall back',
      startedAt: '2026-10-26T04:00:00.000Z',
      now: '2026-10-27T12:00:00.000Z',
      timezone: 'America/New_York',
      dayOfWeek: 7,
      periodKey: '2026-W44',
      periodStartAt: '2026-10-26T04:00:00.000Z',
      periodEndAt: '2026-11-02T05:00:00.000Z',
      dueAt: '2026-11-02T05:00:00.000Z',
    });
    await expectGeneratedPeriod(container, seed, {
      localName: 'ISO year boundary',
      startedAt: '2025-12-29T05:00:00.000Z',
      now: '2025-12-30T12:00:00.000Z',
      timezone: 'America/New_York',
      dayOfWeek: 7,
      periodKey: '2026-W01',
      periodStartAt: '2025-12-29T05:00:00.000Z',
      periodEndAt: '2026-01-05T05:00:00.000Z',
      dueAt: '2026-01-05T05:00:00.000Z',
    });
    await expectGeneratedPeriod(container, seed, {
      localName: 'ISO week 53',
      startedAt: '2026-12-28T05:00:00.000Z',
      now: '2026-12-29T12:00:00.000Z',
      timezone: 'America/New_York',
      dayOfWeek: 7,
      periodKey: '2026-W53',
      periodStartAt: '2026-12-28T05:00:00.000Z',
      periodEndAt: '2027-01-04T05:00:00.000Z',
      dueAt: '2027-01-04T05:00:00.000Z',
    });
    await expectGeneratedPeriod(container, seed, {
      localName: 'Wednesday due',
      startedAt: '2026-01-05T05:00:00.000Z',
      now: '2026-01-06T12:00:00.000Z',
      timezone: 'America/New_York',
      dayOfWeek: 3,
      periodKey: '2026-W02',
      periodStartAt: '2026-01-05T05:00:00.000Z',
      periodEndAt: '2026-01-12T05:00:00.000Z',
      dueAt: '2026-01-08T05:00:00.000Z',
    });
  });

  test('first eligible assignment period never creates a retroactive already-expired instance', async () => {
    const seed = await seedGym(container);
    await expectGeneratedPeriod(container, seed, {
      localName: 'before cutoff',
      startedAt: '2026-01-06T12:00:00.000Z',
      now: '2026-01-06T12:00:00.000Z',
      timezone: 'UTC',
      dayOfWeek: 3,
      periodKey: '2026-W02',
      periodStartAt: '2026-01-05T00:00:00.000Z',
      periodEndAt: '2026-01-12T00:00:00.000Z',
      dueAt: '2026-01-08T00:00:00.000Z',
    });
    await expectGeneratedPeriod(container, seed, {
      localName: 'at cutoff',
      startedAt: '2026-01-08T00:00:00.000Z',
      now: '2026-01-08T00:00:00.000Z',
      timezone: 'UTC',
      dayOfWeek: 3,
      periodKey: '2026-W02',
      periodStartAt: '2026-01-05T00:00:00.000Z',
      periodEndAt: '2026-01-12T00:00:00.000Z',
      dueAt: '2026-01-08T00:00:00.000Z',
    });
    await expectGeneratedPeriod(container, seed, {
      localName: 'after cutoff',
      startedAt: '2026-01-08T00:00:01.000Z',
      now: '2026-01-09T12:00:00.000Z',
      timezone: 'UTC',
      dayOfWeek: 3,
      periodKey: '2026-W03',
      periodStartAt: '2026-01-12T00:00:00.000Z',
      periodEndAt: '2026-01-19T00:00:00.000Z',
      dueAt: '2026-01-15T00:00:00.000Z',
    });
    await expectGeneratedPeriod(container, seed, {
      localName: 'non UTC after cutoff',
      startedAt: '2026-01-08T05:00:01.000Z',
      now: '2026-01-09T12:00:00.000Z',
      timezone: 'America/New_York',
      dayOfWeek: 3,
      periodKey: '2026-W03',
      periodStartAt: '2026-01-12T05:00:00.000Z',
      periodEndAt: '2026-01-19T05:00:00.000Z',
      dueAt: '2026-01-15T05:00:00.000Z',
    });
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

  test('failure injection rolls back every Stage 12 multi-document transaction boundary', async () => {
    await verifyTemplateCreateRollback(container);
    await verifyRevisionCreateRollback(container);
    await verifyAssignmentCreateRollback(container);
    await verifyAssignmentEndRollback(container);
    await verifyGenerationRollback(container);
    await verifyDueTransitionRollback(container);
    await verifyOverdueTransitionRollback(container);
    await verifySubmissionRollback(container);
    await verifyReviewRollback(container);
    await verifyRelationshipEndRollback(container);
  }, 60_000);

  test('deterministic interleaving covers Stage 12 serialization race matrix', async () => {
    const seed = await seedGym(container);
    const template = await createTemplate(container, seed);

    await withBarrierOn(container.checkInRepo, 'guardTemplateForUse', 2, async (stats) => {
      const results = await Promise.allSettled([
        container.checkins.createRevision(seed.ownerCtx, seed.workspaceId, template.template.id, {
          expectedVersion: template.template.version,
          fields: [{ fieldKey: 'sleep', type: 'NUMBER', label: 'Sleep', required: true }],
        }),
        container.checkins.createRevision(seed.ownerCtx, seed.workspaceId, template.template.id, {
          expectedVersion: template.template.version,
          fields: [{ fieldKey: 'stress', type: 'RATING', label: 'Stress', required: true }],
        }),
      ]);
      expect(stats.calls).toBeGreaterThanOrEqual(2);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    });

    const revisionGenerationTemplate = await createTemplate(container, seed);
    await createAssignment(container, seed, revisionGenerationTemplate.template.id, {
      startedAt: '2026-01-05T00:00:00.000Z',
    });
    await withBarrierOn(container.checkInRepo, 'guardTemplateForUse', 2, async (stats) => {
      await Promise.allSettled([
        container.checkins.createRevision(
          seed.ownerCtx,
          seed.workspaceId,
          revisionGenerationTemplate.template.id,
          {
            expectedVersion: revisionGenerationTemplate.template.version,
            fields: [{ fieldKey: 'sleep', type: 'NUMBER', label: 'Sleep', required: true }],
          },
        ),
        container.checkins.generateDueInstances(new Date('2026-01-07T12:00:00.000Z')),
      ]);
      expect(stats.calls).toBeGreaterThanOrEqual(2);
    });
    const generated = await db
      .collection('checkin_instances')
      .find({ templateId: new ObjectId(revisionGenerationTemplate.template.id) })
      .toArray();
    expect(generated.length).toBeGreaterThan(0);
    expect(new Set(generated.map((item) => item.periodKey)).size).toBe(generated.length);
    for (const instance of generated) {
      expect(
        await db.collection('checkin_template_revisions').countDocuments({
          _id: instance.templateRevisionId,
        }),
      ).toBe(1);
    }

    const archiveGenerationTemplate = await createTemplate(container, seed);
    await createAssignment(container, seed, archiveGenerationTemplate.template.id, {
      startedAt: '2026-01-05T00:00:00.000Z',
    });
    await withBarrierOn(container.checkInRepo, 'guardTemplateForUse', 2, async (stats) => {
      const results = await Promise.allSettled([
        container.checkins.archiveTemplate(
          seed.ownerCtx,
          seed.workspaceId,
          archiveGenerationTemplate.template.id,
          { expectedVersion: archiveGenerationTemplate.template.version },
        ),
        container.checkins.generateDueInstances(new Date('2026-01-07T12:00:00.000Z')),
      ]);
      expect(stats.calls).toBeGreaterThanOrEqual(1);
      expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    });
    const archiveGeneratedCount = await db.collection('checkin_instances').countDocuments({
      templateId: new ObjectId(archiveGenerationTemplate.template.id),
    });
    const archivedTemplate = await db.collection('checkin_templates').findOne({
      _id: new ObjectId(archiveGenerationTemplate.template.id),
    });
    expect(archivedTemplate?.status === 'ACTIVE' || archiveGeneratedCount === 0).toBe(true);

    const scheduleTemplate = await createTemplate(container, seed);
    const scheduleAssignment = await createAssignment(
      container,
      seed,
      scheduleTemplate.template.id,
      {
        startedAt: '2026-01-05T00:00:00.000Z',
      },
    );
    await withBarrierOnMethods(
      container.checkInRepo,
      ['updateAssignment', 'guardAssignmentForGeneration'],
      2,
      async (stats) => {
        await Promise.allSettled([
          container.checkins.updateAssignment(
            seed.ownerCtx,
            seed.workspaceId,
            seed.relationshipId,
            scheduleAssignment.assignment.id,
            {
              expectedVersion: scheduleAssignment.assignment.version,
              recurrence: { frequency: 'WEEKLY', dayOfWeek: 5, timezone: 'UTC' },
            },
          ),
          container.checkins.generateDueInstances(new Date('2026-01-07T12:00:00.000Z')),
        ]);
        expect(stats.calls).toBeGreaterThanOrEqual(1);
      },
    );
    const scheduleInstances = await db
      .collection('checkin_instances')
      .find({ assignmentId: new ObjectId(scheduleAssignment.assignment.id) })
      .toArray();
    expect(new Set(scheduleInstances.map((item) => item.periodKey)).size).toBe(
      scheduleInstances.length,
    );

    const submitEnd = await preparedDueInstance(container, 'submit-end');
    await withBarrierOn(
      container.coachingRelationships,
      'guardCheckInLifecycleOpen',
      2,
      async (stats) => {
        const rel = await db
          .collection('coaching_relationships')
          .findOne({ _id: submitEnd.seed.relationshipObjectId });
        const results = await Promise.allSettled([
          submitIdempotently(
            container,
            submitEnd.seed,
            submitEnd.instance._id.toHexString(),
            'submit-end-race',
            submitEnd.instance.version,
            [
              { fieldKey: 'energy', value: 5 },
              { fieldKey: 'ready', value: true },
            ],
          ),
          container.trainees.endRelationship(
            submitEnd.seed.ownerCtx,
            submitEnd.seed.workspaceId,
            submitEnd.seed.relationshipId,
            { expectedVersion: rel?.version ?? -1 },
          ),
        ]);
        expect(stats.calls).toBeGreaterThanOrEqual(2);
        expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
      },
    );
    const submitEndInstance = await db
      .collection('checkin_instances')
      .findOne({ _id: submitEnd.instance._id });
    expect(['SUBMITTED', 'SKIPPED']).toContain(submitEndInstance?.status);

    const submitOverdue = await preparedDueInstance(container, 'submit-overdue');
    await withBarrierOn(
      container.coachingRelationships,
      'guardCheckInLifecycleOpen',
      2,
      async () => {
        await Promise.allSettled([
          submitIdempotently(
            container,
            submitOverdue.seed,
            submitOverdue.instance._id.toHexString(),
            'submit-overdue-race',
            submitOverdue.instance.version,
            [
              { fieldKey: 'energy', value: 4 },
              { fieldKey: 'ready', value: true },
            ],
          ),
          container.checkins.markOverdue(new Date('2026-01-08T00:00:00.000Z')),
        ]);
      },
    );
    const submitOverdueFinal = await db
      .collection('checkin_instances')
      .findOne({ _id: submitOverdue.instance._id });
    expect(['SUBMITTED', 'OVERDUE']).toContain(submitOverdueFinal?.status);
    if (submitOverdueFinal?.status === 'OVERDUE') {
      const submitted = await submitIdempotently(
        container,
        submitOverdue.seed,
        submitOverdue.instance._id.toHexString(),
        'submit-after-overdue',
        submitOverdueFinal.version,
        [
          { fieldKey: 'energy', value: 4 },
          { fieldKey: 'ready', value: true },
        ],
      );
      expect(submitted.checkin.status).toBe('SUBMITTED');
    }

    const submitReview = await preparedDueInstance(container, 'submit-review');
    await withBarrierOn(
      container.coachingRelationships,
      'guardCheckInLifecycleOpen',
      2,
      async () => {
        const submitReviewResults = await Promise.allSettled([
          submitIdempotently(
            container,
            submitReview.seed,
            submitReview.instance._id.toHexString(),
            'submit-review-race',
            submitReview.instance.version,
            [
              { fieldKey: 'energy', value: 3 },
              { fieldKey: 'ready', value: false },
            ],
          ),
          reviewIdempotently(
            container,
            submitReview.seed,
            submitReview.seed.trainerCtx,
            submitReview.instance._id.toHexString(),
            'review-before-submit',
            submitReview.instance.version,
          ),
        ]);
        expect(submitReviewResults[0]?.status).toBe('fulfilled');
      },
    );
    const submitReviewFinal = await db
      .collection('checkin_instances')
      .findOne({ _id: submitReview.instance._id });
    expect(['SUBMITTED', 'REVIEWED']).toContain(submitReviewFinal?.status);

    const reviewEnd = await preparedSubmittedInstance(container, 'review-end');
    await withBarrierOn(
      container.coachingRelationships,
      'guardCheckInLifecycleOpen',
      2,
      async () => {
        const rel = await db
          .collection('coaching_relationships')
          .findOne({ _id: reviewEnd.seed.relationshipObjectId });
        await Promise.allSettled([
          reviewIdempotently(
            container,
            reviewEnd.seed,
            reviewEnd.seed.trainerCtx,
            reviewEnd.instance._id.toHexString(),
            'review-end-race',
            reviewEnd.instance.version,
          ),
          container.trainees.endRelationship(
            reviewEnd.seed.ownerCtx,
            reviewEnd.seed.workspaceId,
            reviewEnd.seed.relationshipId,
            { expectedVersion: rel?.version ?? -1 },
          ),
        ]);
      },
    );
    const reviewEndFinal = await db
      .collection('checkin_instances')
      .findOne({ _id: reviewEnd.instance._id });
    expect(['SUBMITTED', 'REVIEWED']).toContain(reviewEndFinal?.status);

    const endTransition = await preparedDueInstance(container, 'end-transition');
    await withBarrierOn(
      container.coachingRelationships,
      'guardCheckInLifecycleOpen',
      2,
      async () => {
        const rel = await db
          .collection('coaching_relationships')
          .findOne({ _id: endTransition.seed.relationshipObjectId });
        await Promise.allSettled([
          container.checkins.markOverdue(new Date('2026-01-08T00:00:00.000Z')),
          container.trainees.endRelationship(
            endTransition.seed.ownerCtx,
            endTransition.seed.workspaceId,
            endTransition.seed.relationshipId,
            { expectedVersion: rel?.version ?? -1 },
          ),
        ]);
      },
    );
    const endTransitionFinal = await db
      .collection('checkin_instances')
      .findOne({ _id: endTransition.instance._id });
    expect(['OVERDUE', 'SKIPPED']).toContain(endTransitionFinal?.status);
  }, 90_000);

  test('duplicate transition, submit, and review races are serialized without duplicate events', async () => {
    const dueSetup = await preparedAssignmentOnly(container, 'C9 due duplicate');
    await container.checkins.generateDueInstances(new Date('2026-01-07T12:00:00.000Z'));
    const upcoming = await firstInstance(container, dueSetup.assignment.assignment.id, {
      status: 'UPCOMING',
    });
    await withBarrierOn(container.checkInRepo, 'dueUpcoming', 2, async () => {
      await Promise.allSettled([
        container.checkins.generateDueInstances(upcoming.opensAt),
        container.checkins.generateDueInstances(upcoming.opensAt),
      ]);
    });
    const dueFinal = await container.database.db
      .collection('checkin_instances')
      .findOne({ _id: upcoming._id });
    expect(dueFinal?.status).toBe('DUE');
    expect(await outboxCount(container, 'CheckInDue', upcoming._id)).toBe(1);

    const overdueSetup = await preparedDueInstance(container, 'C10 overdue duplicate');
    await withBarrierOn(container.checkInRepo, 'overdueDue', 2, async () => {
      await Promise.allSettled([
        container.checkins.markOverdue(new Date('2026-01-08T00:00:00.000Z')),
        container.checkins.markOverdue(new Date('2026-01-08T00:00:00.000Z')),
      ]);
    });
    const overdueFinal = await container.database.db
      .collection('checkin_instances')
      .findOne({ _id: overdueSetup.instance._id });
    expect(overdueFinal?.status).toBe('OVERDUE');
    expect(await outboxCount(container, 'CheckInOverdue', overdueSetup.instance._id)).toBe(1);

    const submitSetup = await preparedDueInstance(container, 'C11 submit duplicate');
    const submitResults = await Promise.allSettled([
      submitIdempotently(
        container,
        submitSetup.seed,
        submitSetup.instance._id.toHexString(),
        'duplicate-submit-a',
        submitSetup.instance.version,
        [
          { fieldKey: 'energy', value: 4 },
          { fieldKey: 'ready', value: true },
        ],
      ),
      submitIdempotently(
        container,
        submitSetup.seed,
        submitSetup.instance._id.toHexString(),
        'duplicate-submit-b',
        submitSetup.instance.version,
        [
          { fieldKey: 'energy', value: 4 },
          { fieldKey: 'ready', value: true },
        ],
      ),
    ]);
    expect(submitResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const submitFinal = await container.database.db
      .collection('checkin_instances')
      .findOne({ _id: submitSetup.instance._id });
    expect(submitFinal?.status).toBe('SUBMITTED');
    expect(submitFinal?.responses).toHaveLength(2);
    expect(await outboxCount(container, 'CheckInSubmitted', submitSetup.instance._id)).toBe(1);

    const replayKey =
      submitResults[0]?.status === 'fulfilled' ? 'duplicate-submit-a' : 'duplicate-submit-b';
    const replay = await submitIdempotently(
      container,
      submitSetup.seed,
      submitSetup.instance._id.toHexString(),
      replayKey,
      submitSetup.instance.version,
      [
        { fieldKey: 'energy', value: 4 },
        { fieldKey: 'ready', value: true },
      ],
    );
    expect(replay.checkin.status).toBe('SUBMITTED');

    const reviewSetup = await preparedSubmittedInstance(container, 'C15 review duplicate');
    const reviewResults = await Promise.allSettled([
      reviewIdempotently(
        container,
        reviewSetup.seed,
        reviewSetup.seed.trainerCtx,
        reviewSetup.instance._id.toHexString(),
        'duplicate-review-a',
        reviewSetup.instance.version,
      ),
      reviewIdempotently(
        container,
        reviewSetup.seed,
        reviewSetup.seed.trainerCtx,
        reviewSetup.instance._id.toHexString(),
        'duplicate-review-b',
        reviewSetup.instance.version,
      ),
    ]);
    expect(reviewResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const reviewFinal = await container.database.db
      .collection('checkin_instances')
      .findOne({ _id: reviewSetup.instance._id });
    expect(reviewFinal?.status).toBe('REVIEWED');
    expect(reviewFinal?.trainerFeedback?.comment).toBe('Looks good');
    expect(await outboxCount(container, 'CheckInReviewed', reviewSetup.instance._id)).toBe(1);
  }, 60_000);

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

  test('relationship reactivation does not revive ended check-in assignments', async () => {
    const seed = await seedGym(container);
    const template = await createTemplate(container, seed);
    const assignment = await createAssignment(container, seed, template.template.id);
    await container.checkins.generateDueInstances(new Date('2026-01-07T12:00:00.000Z'));
    const beforeEnd = await db
      .collection('coaching_relationships')
      .findOne({ _id: seed.relationshipObjectId });
    await container.trainees.endRelationship(seed.ownerCtx, seed.workspaceId, seed.relationshipId, {
      expectedVersion: beforeEnd?.version ?? -1,
    });
    const endedAssignment = await db.collection('checkin_assignments').findOne({
      _id: new ObjectId(assignment.assignment.id),
    });
    expect(endedAssignment?.active).toBe(false);
    const endedRelationship = await db
      .collection('coaching_relationships')
      .findOne({ _id: seed.relationshipObjectId });
    await container.trainees.reactivateRelationship(
      seed.ownerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        expectedVersion: endedRelationship?.version ?? -1,
        homeBranchId: seed.branchId,
        primaryTrainerMembershipId: seed.trainerMembershipId,
      },
    );
    const afterReactivationAssignment = await db.collection('checkin_assignments').findOne({
      _id: new ObjectId(assignment.assignment.id),
    });
    expect(afterReactivationAssignment?.active).toBe(false);
    const beforeGenerationCount = await db.collection('checkin_instances').countDocuments({
      assignmentId: new ObjectId(assignment.assignment.id),
    });
    await container.checkins.generateDueInstances(new Date('2026-01-21T12:00:00.000Z'));
    expect(
      await db.collection('checkin_instances').countDocuments({
        assignmentId: new ObjectId(assignment.assignment.id),
      }),
    ).toBe(beforeGenerationCount);
    const newAssignment = await createAssignment(container, seed, template.template.id, {
      startedAt: '2026-01-19T00:00:00.000Z',
    });
    await container.checkins.generateDueInstances(new Date('2026-01-21T12:00:00.000Z'));
    expect(
      await db.collection('checkin_instances').countDocuments({
        assignmentId: new ObjectId(newAssignment.assignment.id),
      }),
    ).toBeGreaterThan(0);
  });

  test('sensitive list and detail access require checkins.read plus relationship scope', async () => {
    const seed = await seedGym(container);
    const template = await createTemplate(container, seed);
    const assignment = await createAssignment(container, seed, template.template.id);
    await container.checkins.generateDueInstances(new Date('2026-01-07T12:00:00.000Z'));
    const instance = await db.collection('checkin_instances').findOne({
      assignmentId: new ObjectId(assignment.assignment.id),
    });
    if (!instance) throw new Error('expected instance');
    await submitIdempotently(container, seed, instance._id.toHexString(), 'sensitive-submit', 0, [
      { fieldKey: 'energy', value: 5 },
      { fieldKey: 'notes', value: 'sensitive trainee text' },
      { fieldKey: 'ready', value: true },
    ]);

    const templateOnly = await seedLimitedStaff(container, seed, [
      { permission: 'checkins.templates.read', effect: 'ALLOW' },
    ]);
    const assignmentOnly = await seedLimitedStaff(container, seed, [
      { permission: 'checkins.assignments.read', effect: 'ALLOW' },
    ]);
    const noReadStaff = await seedLimitedStaff(container, seed, [
      { permission: 'checkins.templates.read', effect: 'ALLOW' },
      { permission: 'checkins.assignments.read', effect: 'ALLOW' },
    ]);
    await expect(
      container.checkins.getInstance(
        templateOnly.ctx,
        seed.workspaceId,
        seed.relationshipId,
        instance._id.toHexString(),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      container.checkins.listInstances(
        assignmentOnly.ctx,
        seed.workspaceId,
        seed.relationshipId,
        {},
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      container.checkins.getInstance(
        noReadStaff.ctx,
        seed.workspaceId,
        seed.relationshipId,
        instance._id.toHexString(),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const deniedOwnerProfile = await container.permissionProfiles.create({
      context: 'WORKSPACE',
      workspaceId: seed.workspaceObjectId,
      name: `No checkins read ${new ObjectId().toHexString()}`,
      permissions: [{ permission: 'checkins.read', effect: 'DENY' }],
    });
    const currentOwnerMembership = await container.workspaceMemberships.findByIdInWorkspace(
      seed.workspaceObjectId,
      seed.ownerMembershipId,
    );
    if (!currentOwnerMembership) throw new Error('expected owner membership');
    await container.workspaceMemberships.updateRoleAndProfileContributions(
      seed.workspaceObjectId,
      seed.ownerMembershipId,
      currentOwnerMembership.accessVersion ?? 0,
      { roles: ['GYM_OWNER'], permissionProfileIds: [deniedOwnerProfile._id] },
    );
    await expect(
      container.checkins.getInstance(
        seed.ownerCtx,
        seed.workspaceId,
        seed.relationshipId,
        instance._id.toHexString(),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const otherTrainee = await seedOtherTraineeInWorkspace(container, seed);
    await expect(
      container.checkins.getInstance(
        otherTrainee.ctx,
        seed.workspaceId,
        seed.relationshipId,
        instance._id.toHexString(),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const selfList = await container.checkins.listInstances(
      seed.traineeCtx,
      seed.workspaceId,
      seed.relationshipId,
      {},
    );
    expect(JSON.stringify(selfList)).toContain('sensitive trainee text');
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

async function expectGeneratedPeriod(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  input: {
    localName: string;
    startedAt: string;
    now: string;
    timezone: string;
    dayOfWeek: number;
    periodKey: string;
    periodStartAt: string;
    periodEndAt: string;
    dueAt: string;
  },
) {
  const template = await createTemplate(container, seed, `${input.localName} ${new ObjectId()}`);
  const assignment = await createAssignment(container, seed, template.template.id, {
    startedAt: input.startedAt,
    recurrence: {
      frequency: 'WEEKLY',
      dayOfWeek: input.dayOfWeek,
      timezone: input.timezone,
    },
  });
  await container.checkins.generateDueInstances(new Date(input.now));
  const instance = await container.database.db.collection('checkin_instances').findOne({
    assignmentId: new ObjectId(assignment.assignment.id),
  });
  if (!instance) throw new Error(`expected generated period for ${input.localName}`);
  expect(instance.periodKey).toBe(input.periodKey);
  expect(instance.periodStartAt.toISOString()).toBe(input.periodStartAt);
  expect(instance.periodEndAt.toISOString()).toBe(input.periodEndAt);
  expect(instance.dueAt.toISOString()).toBe(input.dueAt);
}

async function preparedDueInstance(container: AppContainer, label: string) {
  const seed = await seedGym(container);
  const template = await createTemplate(container, seed, `${label} template ${new ObjectId()}`);
  const assignment = await createAssignment(container, seed, template.template.id);
  await container.checkins.generateDueInstances(new Date('2026-01-07T12:00:00.000Z'));
  const instance = await container.database.db.collection('checkin_instances').findOne({
    assignmentId: new ObjectId(assignment.assignment.id),
  });
  if (!instance) throw new Error(`expected due instance for ${label}`);
  return { seed, template, assignment, instance };
}

async function preparedSubmittedInstance(container: AppContainer, label: string) {
  const setup = await preparedDueInstance(container, label);
  const submitted = await submitIdempotently(
    container,
    setup.seed,
    setup.instance._id.toHexString(),
    `${label}-submit`,
    setup.instance.version,
    [
      { fieldKey: 'energy', value: 4 },
      { fieldKey: 'ready', value: true },
    ],
  );
  const instance = await container.database.db.collection('checkin_instances').findOne({
    _id: new ObjectId(submitted.checkin.id),
  });
  if (!instance) throw new Error(`expected submitted instance for ${label}`);
  return { ...setup, instance };
}

async function verifyTemplateCreateRollback(container: AppContainer) {
  const seed = await seedGym(container);
  const beforeAudit = await auditCount(container, 'CheckInTemplateCreated');
  await failAuditFor(container, 'CheckInTemplateCreated', async () => {
    await expect(createTemplate(container, seed, 'FI template create')).rejects.toThrow(
      'forced audit failure',
    );
  });
  expect(
    await container.database.db
      .collection('checkin_templates')
      .countDocuments({ name: 'FI template create' }),
  ).toBe(0);
  expect(
    await container.database.db
      .collection('checkin_template_revisions')
      .countDocuments({ workspaceId: seed.workspaceObjectId }),
  ).toBe(0);
  expect(await auditCount(container, 'CheckInTemplateCreated')).toBe(beforeAudit);
}

async function verifyRevisionCreateRollback(container: AppContainer) {
  const seed = await seedGym(container);
  const template = await createTemplate(container, seed);
  const beforeAudit = await auditCount(container, 'CheckInTemplateRevisionCreated');
  const before = await container.database.db.collection('checkin_templates').findOne({
    _id: new ObjectId(template.template.id),
  });
  await failAuditFor(container, 'CheckInTemplateRevisionCreated', async () => {
    await expect(
      container.checkins.createRevision(seed.ownerCtx, seed.workspaceId, template.template.id, {
        expectedVersion: template.template.version,
        fields: [{ fieldKey: 'sleep', type: 'NUMBER', label: 'Sleep', required: true }],
      }),
    ).rejects.toThrow('forced audit failure');
  });
  const after = await container.database.db.collection('checkin_templates').findOne({
    _id: new ObjectId(template.template.id),
  });
  expect(await revisionCount(container, template.template.id)).toBe(1);
  expect(after?.currentRevisionId).toEqual(before?.currentRevisionId);
  expect(after?.version).toBe(before?.version);
  expect(after?.templateUseRevision).toBe(before?.templateUseRevision);
  expect(await auditCount(container, 'CheckInTemplateRevisionCreated')).toBe(beforeAudit);
}

async function verifyAssignmentCreateRollback(container: AppContainer) {
  const seed = await seedGym(container);
  const template = await createTemplate(container, seed);
  const beforeAudit = await auditCount(container, 'CheckInAssignmentCreated');
  await failAuditFor(container, 'CheckInAssignmentCreated', async () => {
    await expect(createAssignment(container, seed, template.template.id)).rejects.toThrow(
      'forced audit failure',
    );
  });
  expect(await assignmentCount(container, seed.relationshipObjectId)).toBe(0);
  expect(await auditCount(container, 'CheckInAssignmentCreated')).toBe(beforeAudit);
}

async function verifyAssignmentEndRollback(container: AppContainer) {
  const seed = await seedGym(container);
  const template = await createTemplate(container, seed);
  const assignment = await createAssignment(container, seed, template.template.id);
  const beforeAudit = await auditCount(container, 'CheckInAssignmentEnded');
  await failAuditFor(container, 'CheckInAssignmentEnded', async () => {
    await expect(
      container.checkins.endAssignment(
        seed.ownerCtx,
        seed.workspaceId,
        seed.relationshipId,
        assignment.assignment.id,
        { expectedVersion: assignment.assignment.version },
      ),
    ).rejects.toThrow('forced audit failure');
  });
  const after = await container.database.db.collection('checkin_assignments').findOne({
    _id: new ObjectId(assignment.assignment.id),
  });
  expect(after?.active).toBe(true);
  expect(after?.endedAt).toBeUndefined();
  expect(after?.version).toBe(assignment.assignment.version);
  expect(await auditCount(container, 'CheckInAssignmentEnded')).toBe(beforeAudit);
}

async function verifyGenerationRollback(container: AppContainer) {
  const setup = await preparedAssignmentOnly(container, 'FI generation');
  const beforeAudit = await auditCount(container, 'CheckInGenerated');
  const beforeDueOutbox = await outboxCount(container, 'CheckInDue');
  await failAuditFor(container, 'CheckInGenerated', async () => {
    await expect(
      container.checkins.generateDueInstances(new Date('2026-01-07T12:00:00.000Z')),
    ).rejects.toThrow('forced audit failure');
  });
  expect(
    await container.database.db.collection('checkin_instances').countDocuments({
      assignmentId: new ObjectId(setup.assignment.assignment.id),
    }),
  ).toBe(0);
  expect(await auditCount(container, 'CheckInGenerated')).toBe(beforeAudit);
  expect(await outboxCount(container, 'CheckInDue')).toBe(beforeDueOutbox);
  await container.checkins.generateDueInstances(new Date('2026-01-07T12:00:00.000Z'));
  expect(
    await container.database.db.collection('checkin_instances').countDocuments({
      assignmentId: new ObjectId(setup.assignment.assignment.id),
    }),
  ).toBeGreaterThan(0);
  expect(
    await container.database.db.collection('checkin_instances').countDocuments({
      assignmentId: new ObjectId(setup.assignment.assignment.id),
      periodKey: '2026-W02',
    }),
  ).toBe(1);
}

async function verifyDueTransitionRollback(container: AppContainer) {
  const setup = await preparedAssignmentOnly(container, 'FI due');
  await container.checkins.generateDueInstances(new Date('2026-01-07T12:00:00.000Z'));
  const instance = await firstInstance(container, setup.assignment.assignment.id, {
    status: 'UPCOMING',
  });
  expect(instance.status).toBe('UPCOMING');
  const beforeAudit = await auditCount(container, 'CheckInDue');
  const beforeOutbox = await outboxCount(container, 'CheckInDue', instance._id);
  await failAuditFor(container, 'CheckInDue', async () => {
    await expect(container.checkins.generateDueInstances(instance.opensAt)).rejects.toThrow(
      'forced audit failure',
    );
  });
  expect(
    (await firstInstance(container, setup.assignment.assignment.id, { _id: instance._id })).status,
  ).toBe('UPCOMING');
  expect(await auditCount(container, 'CheckInDue')).toBe(beforeAudit);
  expect(await outboxCount(container, 'CheckInDue', instance._id)).toBe(beforeOutbox);
  await container.checkins.generateDueInstances(instance.opensAt);
  expect(
    (await firstInstance(container, setup.assignment.assignment.id, { _id: instance._id })).status,
  ).toBe('DUE');
  expect(await outboxCount(container, 'CheckInDue', instance._id)).toBe(beforeOutbox + 1);
}

async function verifyOverdueTransitionRollback(container: AppContainer) {
  const setup = await preparedDueInstance(container, 'FI overdue');
  const beforeAudit = await auditCount(container, 'CheckInOverdue');
  const beforeOutbox = await outboxCount(container, 'CheckInOverdue', setup.instance._id);
  await failAuditFor(container, 'CheckInOverdue', async () => {
    await expect(
      container.checkins.markOverdue(new Date('2026-01-08T00:00:00.000Z')),
    ).rejects.toThrow('forced audit failure');
  });
  const after = await container.database.db
    .collection('checkin_instances')
    .findOne({ _id: setup.instance._id });
  expect(after?.status).toBe('DUE');
  expect(await auditCount(container, 'CheckInOverdue')).toBe(beforeAudit);
  expect(await outboxCount(container, 'CheckInOverdue', setup.instance._id)).toBe(beforeOutbox);
  await container.checkins.markOverdue(new Date('2026-01-08T00:00:00.000Z'));
  const retried = await container.database.db
    .collection('checkin_instances')
    .findOne({ _id: setup.instance._id });
  expect(retried?.status).toBe('OVERDUE');
  expect(await outboxCount(container, 'CheckInOverdue', setup.instance._id)).toBe(beforeOutbox + 1);
}

async function verifySubmissionRollback(container: AppContainer) {
  const setup = await preparedDueInstance(container, 'FI submit');
  const beforeAudit = await auditCount(container, 'CheckInSubmitted');
  const beforeOutbox = await outboxCount(container, 'CheckInSubmitted', setup.instance._id);
  await failOutboxFor(container, 'CheckInSubmitted', async () => {
    await expect(
      submitIdempotently(
        container,
        setup.seed,
        setup.instance._id.toHexString(),
        'fi-submit',
        setup.instance.version,
        [
          { fieldKey: 'energy', value: 4 },
          { fieldKey: 'ready', value: true },
        ],
      ),
    ).rejects.toThrow('forced outbox failure');
  });
  const after = await container.database.db
    .collection('checkin_instances')
    .findOne({ _id: setup.instance._id });
  expect(after?.status).toBe('DUE');
  expect(after?.responses).toEqual([]);
  expect(after?.submittedAt).toBeUndefined();
  expect(await auditCount(container, 'CheckInSubmitted')).toBe(beforeAudit);
  expect(await outboxCount(container, 'CheckInSubmitted', setup.instance._id)).toBe(beforeOutbox);
  const idem = await container.database.db.collection('idempotency_records').findOne({
    key: 'fi-submit',
  });
  expect(idem?.state).toBe('FAILED');
  const submitted = await submitIdempotently(
    container,
    setup.seed,
    setup.instance._id.toHexString(),
    'fi-submit-retry',
    setup.instance.version,
    [
      { fieldKey: 'energy', value: 4 },
      { fieldKey: 'ready', value: true },
    ],
  );
  expect(submitted.checkin.status).toBe('SUBMITTED');
  expect(await outboxCount(container, 'CheckInSubmitted', setup.instance._id)).toBe(
    beforeOutbox + 1,
  );
}

async function verifyReviewRollback(container: AppContainer) {
  const setup = await preparedSubmittedInstance(container, 'FI review');
  const beforeAudit = await auditCount(container, 'CheckInReviewed');
  const beforeOutbox = await outboxCount(container, 'CheckInReviewed', setup.instance._id);
  await failOutboxFor(container, 'CheckInReviewed', async () => {
    await expect(
      reviewIdempotently(
        container,
        setup.seed,
        setup.seed.trainerCtx,
        setup.instance._id.toHexString(),
        'fi-review',
        setup.instance.version,
      ),
    ).rejects.toThrow('forced outbox failure');
  });
  const after = await container.database.db
    .collection('checkin_instances')
    .findOne({ _id: setup.instance._id });
  expect(after?.status).toBe('SUBMITTED');
  expect(after?.trainerFeedback).toBeUndefined();
  expect(after?.reviewedAt).toBeUndefined();
  expect(await auditCount(container, 'CheckInReviewed')).toBe(beforeAudit);
  expect(await outboxCount(container, 'CheckInReviewed', setup.instance._id)).toBe(beforeOutbox);
  const reviewed = await reviewIdempotently(
    container,
    setup.seed,
    setup.seed.trainerCtx,
    setup.instance._id.toHexString(),
    'fi-review-retry',
    setup.instance.version,
  );
  expect(reviewed.checkin.status).toBe('REVIEWED');
  expect(await outboxCount(container, 'CheckInReviewed', setup.instance._id)).toBe(
    beforeOutbox + 1,
  );
}

async function verifyRelationshipEndRollback(container: AppContainer) {
  const setup = await preparedDueInstance(container, 'FI relationship end');
  const submitted = await preparedSubmittedInstance(container, 'FI relationship end submitted');
  const beforeRel = await container.database.db.collection('coaching_relationships').findOne({
    _id: setup.seed.relationshipObjectId,
  });
  const beforeAudit = await auditCount(container, 'CheckInsSkippedForRelationshipEnd');
  await failAuditFor(container, 'CheckInsSkippedForRelationshipEnd', async () => {
    await expect(
      container.trainees.endRelationship(
        setup.seed.ownerCtx,
        setup.seed.workspaceId,
        setup.seed.relationshipId,
        { expectedVersion: beforeRel?.version ?? -1 },
      ),
    ).rejects.toThrow('forced audit failure');
  });
  const rel = await container.database.db.collection('coaching_relationships').findOne({
    _id: setup.seed.relationshipObjectId,
  });
  const assignment = await container.database.db.collection('checkin_assignments').findOne({
    _id: new ObjectId(setup.assignment.assignment.id),
  });
  const open = await container.database.db
    .collection('checkin_instances')
    .findOne({ _id: setup.instance._id });
  const submittedAfter = await container.database.db
    .collection('checkin_instances')
    .findOne({ _id: submitted.instance._id });
  expect(rel?.status).toBe('ACTIVE');
  expect(rel?.checkinLifecycleRevision).toBe(beforeRel?.checkinLifecycleRevision);
  expect(assignment?.active).toBe(true);
  expect(open?.status).toBe('DUE');
  expect(submittedAfter?.status).toBe('SUBMITTED');
  expect(await auditCount(container, 'CheckInsSkippedForRelationshipEnd')).toBe(beforeAudit);
  await container.trainees.endRelationship(
    setup.seed.ownerCtx,
    setup.seed.workspaceId,
    setup.seed.relationshipId,
    { expectedVersion: beforeRel?.version ?? -1 },
  );
  const endedOpen = await container.database.db
    .collection('checkin_instances')
    .findOne({ _id: setup.instance._id });
  expect(endedOpen?.status).toBe('SKIPPED');
}

async function preparedAssignmentOnly(
  container: AppContainer,
  label: string,
  override: Partial<{
    startedAt: string;
    recurrence: { frequency: 'WEEKLY'; dayOfWeek?: number; timezone: string };
  }> = {},
) {
  const seed = await seedGym(container);
  const template = await createTemplate(container, seed, `${label} template ${new ObjectId()}`);
  const assignment = await createAssignment(container, seed, template.template.id, override);
  return { seed, template, assignment };
}

async function firstInstance(
  container: AppContainer,
  assignmentId: string,
  extraFilter: Record<string, unknown> = {},
) {
  const instance = await container.database.db.collection('checkin_instances').findOne({
    assignmentId: new ObjectId(assignmentId),
    ...extraFilter,
  });
  if (!instance) throw new Error('expected check-in instance');
  return instance;
}

async function auditCount(container: AppContainer, eventType: string) {
  return await container.database.db.collection('audit_events').countDocuments({ eventType });
}

async function outboxCount(container: AppContainer, eventType: string, aggregateId?: ObjectId) {
  return await container.database.db.collection('outbox_events').countDocuments({
    eventType,
    ...(aggregateId ? { aggregateId } : {}),
  });
}

async function revisionCount(container: AppContainer, templateId: string) {
  return await container.database.db.collection('checkin_template_revisions').countDocuments({
    templateId: new ObjectId(templateId),
  });
}

async function assignmentCount(container: AppContainer, relationshipId: ObjectId) {
  return await container.database.db.collection('checkin_assignments').countDocuments({
    relationshipId,
  });
}

async function failAuditFor(
  container: AppContainer,
  eventType: string,
  operation: () => Promise<void>,
) {
  const original = container.audit.write.bind(container.audit);
  container.audit.write = (async (input, tx) => {
    if (input.eventType === eventType) throw new Error('forced audit failure');
    return await original(input, tx);
  }) as typeof container.audit.write;
  try {
    await operation();
  } finally {
    container.audit.write = original;
  }
}

async function failOutboxFor(
  container: AppContainer,
  eventType: string,
  operation: () => Promise<void>,
) {
  const original = container.outbox.write.bind(container.outbox);
  container.outbox.write = (async (input, tx) => {
    if (input.eventType === eventType) throw new Error('forced outbox failure');
    return await original(input, tx);
  }) as typeof container.outbox.write;
  try {
    await operation();
  } finally {
    container.outbox.write = original;
  }
}

async function withBarrierOn<T extends object>(
  target: T,
  method: keyof T,
  participants: number,
  operation: (stats: { calls: number }) => Promise<void>,
) {
  await withBarrierOnMethods(target, [method], participants, operation);
}

async function withBarrierOnMethods<T extends object>(
  target: T,
  methods: Array<keyof T>,
  participants: number,
  operation: (stats: { calls: number }) => Promise<void>,
) {
  let calls = 0;
  let waiting = 0;
  let readyResolve!: () => void;
  let releaseResolve!: () => void;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const originals = new Map<keyof T, unknown>();
  for (const method of methods) {
    originals.set(method, target[method]);
    const original = target[method] as unknown as (...args: unknown[]) => Promise<unknown>;
    target[method] = (async (...args: unknown[]) => {
      calls++;
      waiting++;
      if (waiting >= participants) readyResolve();
      if (waiting <= participants) await release;
      return await original.apply(target, args);
    }) as T[keyof T];
  }
  const op = operation({
    get calls() {
      return calls;
    },
  });
  await ready;
  releaseResolve();
  try {
    await op;
  } finally {
    for (const [method, original] of originals) {
      target[method] = original as T[keyof T];
    }
  }
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

async function seedLimitedStaff(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  permissions: Array<{
    permission: string;
    effect: 'ALLOW' | 'DENY';
  }>,
) {
  const user = await seedUser(
    container.database.db,
    `limited-${new ObjectId().toHexString()}@example.com`,
  );
  const membership = await container.workspaceMemberships.createActive({
    workspaceId: seed.workspaceObjectId,
    userId: user._id,
    roles: ['TRAINER'],
  });
  const profile = await container.permissionProfiles.create({
    context: 'WORKSPACE',
    workspaceId: seed.workspaceObjectId,
    name: `Limited ${new ObjectId().toHexString()}`,
    permissions,
  });
  await container.workspaceMemberships.updateRoleAndProfileContributions(
    seed.workspaceObjectId,
    membership._id,
    membership.accessVersion ?? 0,
    { roles: ['TRAINER'], permissionProfileIds: [profile._id] },
  );
  await container.membershipBranchAssignments.createActive(
    seed.workspaceObjectId,
    membership._id,
    seed.branchObjectId,
  );
  await container.coachingRelationships.createAssignment({
    workspaceId: seed.workspaceObjectId,
    relationshipId: seed.relationshipObjectId,
    staffMembershipId: membership._id,
    assignmentType: 'ASSISTANT_TRAINER',
    assignedBy: seed.ownerUserId,
  });
  return { ctx: ctx(user._id, membership._id), membershipId: membership._id };
}

async function seedOtherTraineeInWorkspace(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
) {
  const user = await seedUser(
    container.database.db,
    `other-trainee-${new ObjectId().toHexString()}@example.com`,
  );
  const membership = await container.workspaceMemberships.createActive({
    workspaceId: seed.workspaceObjectId,
    userId: user._id,
    roles: ['TRAINEE'],
  });
  await assignSystemProfile(container, seed.workspaceObjectId, membership._id, 'TRAINEE');
  await container.coachingRelationships.createActive({
    workspaceId: seed.workspaceObjectId,
    traineeUserId: user._id,
    traineeMembershipId: membership._id,
    homeBranchId: seed.branchObjectId,
    activatedBy: seed.ownerUserId,
  });
  return { ctx: ctx(user._id, membership._id), membershipId: membership._id };
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
    branchId: branch._id.toHexString(),
    branchObjectId: branch._id,
    relationshipId: active._id.toHexString(),
    relationshipObjectId: active._id,
    ownerUserId: owner._id,
    ownerMembershipId: ownerMembership._id,
    ownerAccessVersion: ownerMembership.accessVersion ?? 0,
    trainerMembershipId: trainerMembership._id.toHexString(),
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
