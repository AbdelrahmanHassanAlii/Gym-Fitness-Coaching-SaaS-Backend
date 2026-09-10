import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Db, ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import type { AppContainer } from '../src/bootstrap/app-container';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { migrations } from '../src/migrations';
import { migration013Stage8TrainingFoundation } from '../src/migrations/013-stage8-training-foundation';
import { MigrationRunner } from '../src/migrations/migration-runner';
import {
  Permissions,
  systemPermissionProfiles,
} from '../src/modules/permissions/permission.registry';

describe('Stage 8 migration 013', () => {
  test('creates training indexes and Stage 8 permission seeds without Stage 9 collections', async () => {
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

    await migration013Stage8TrainingFoundation.up(db as never);

    expect(indexes(calls, 'exercises')).toContainEqual(
      expect.objectContaining({
        name: 'exercises_active_normalized_name_unique',
        unique: true,
        partialFilterExpression: { status: 'ACTIVE' },
      }),
    );
    expect(indexes(calls, 'programs')).toContainEqual(
      expect.objectContaining({
        name: 'programs_one_active_per_relationship',
        unique: true,
        partialFilterExpression: { status: 'ACTIVE' },
      }),
    );
    expect(indexes(calls, 'workout_sessions')).toBeUndefined();
    expect(JSON.stringify(updates)).toContain('programs.activate');
    expect(JSON.stringify(updates)).toContain('system_exercises.archive');
  });

  test('runs clean 001-013 and locked 012-to-013 upgrades without Stage 9 collections', async () => {
    const cleanContainer = await createAppContainer(
      integrationConfig(`stage8_clean_migration_${new ObjectId().toHexString()}`),
    );
    const upgradeContainer = await createAppContainer(
      integrationConfig(`stage8_upgrade_migration_${new ObjectId().toHexString()}`),
    );
    try {
      const lockedThroughStage8 = migrations.filter(
        (migration) => migration.id !== '014-stage9-workout-execution',
      );
      await new MigrationRunner(cleanContainer.database.db, lockedThroughStage8).migrate();
      expect(
        await cleanContainer.database.db
          .collection('db_migrations')
          .countDocuments({ migrationId: '013-stage8-training-foundation' }),
      ).toBe(1);
      expect(
        await cleanContainer.database.db.listCollections({ name: 'workout_sessions' }).hasNext(),
      ).toBe(false);

      const lockedStage7 = migrations.filter(
        (migration) =>
          migration.id !== '013-stage8-training-foundation' &&
          migration.id !== '014-stage9-workout-execution',
      );
      await new MigrationRunner(upgradeContainer.database.db, lockedStage7).migrate();
      expect(
        await upgradeContainer.database.db
          .collection('db_migrations')
          .countDocuments({ migrationId: '012-stage7-trainee-relationships' }),
      ).toBe(1);
      expect(
        await upgradeContainer.database.db
          .collection('db_migrations')
          .countDocuments({ migrationId: '013-stage8-training-foundation' }),
      ).toBe(0);
      await new MigrationRunner(upgradeContainer.database.db, lockedThroughStage8).migrate();
      await new MigrationRunner(upgradeContainer.database.db, lockedThroughStage8).migrate();
      expect(
        await upgradeContainer.database.db
          .collection('db_migrations')
          .countDocuments({ migrationId: '013-stage8-training-foundation' }),
      ).toBe(1);
      expect(
        await upgradeContainer.database.db
          .collection('permission_definitions')
          .countDocuments({ key: 'programs.activate', state: 'ACTIVE' }),
      ).toBe(1);
      expect(
        await upgradeContainer.database.db.listCollections({ name: 'workout_sessions' }).hasNext(),
      ).toBe(false);
    } finally {
      await cleanContainer.database.db.dropDatabase();
      await cleanContainer.database.close();
      await upgradeContainer.database.db.dropDatabase();
      await upgradeContainer.database.close();
    }
  }, 30_000);
});

describe('Stage 8 training foundation integration', () => {
  let container: AppContainer;
  let db: Db;

  beforeAll(async () => {
    container = await createAppContainer(
      integrationConfig(`stage8_${new ObjectId().toHexString()}`),
    );
    db = container.database.db;
    await new MigrationRunner(db, migrations).migrate();
  }, 30_000);

  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (container) await container.database.close();
  }, 30_000);

  test('SYSTEM, GYM and PRIVATE exercises obey scope, duplicates, archive, and reuse rules', async () => {
    const seed = await seedGym(container);
    const platform = await seedPlatformAdmin(container);
    const system = await container.training.createPlatformExercise(platform.ctx, {
      names: { en: 'Bench Press' },
      exerciseType: 'RESISTANCE',
    });
    const gym = await container.training.createExercise(seed.ownerCtx, seed.workspaceId, {
      scope: 'GYM',
      names: { en: 'Incline Press' },
      exerciseType: 'RESISTANCE',
    });
    const privateExercise = await container.training.createExercise(
      seed.trainerCtx,
      seed.workspaceId,
      {
        scope: 'PRIVATE',
        names: { en: 'Secret Press' },
        exerciseType: 'RESISTANCE',
      },
    );

    await expect(
      container.training.createExercise(seed.ownerCtx, seed.workspaceId, {
        scope: 'GYM',
        names: { en: '  incline   press ' },
        exerciseType: 'RESISTANCE',
      }),
    ).rejects.toMatchObject({ code: 'EXERCISE_NAME_CONFLICT' });

    await container.training.archiveExercise(seed.ownerCtx, seed.workspaceId, gym.exercise.id, {
      expectedVersion: gym.exercise.version,
    });
    await expect(
      container.training.createExercise(seed.ownerCtx, seed.workspaceId, {
        scope: 'GYM',
        names: { en: 'Incline Press' },
        exerciseType: 'RESISTANCE',
      }),
    ).resolves.toMatchObject({ exercise: { status: 'ACTIVE' } });

    const trainerList = await container.training.listExercises(
      seed.trainerCtx,
      seed.workspaceId,
      {},
    );
    expect(trainerList.data.map((exercise) => exercise.id)).toContain(system.exercise.id);
    expect(trainerList.data.map((exercise) => exercise.id)).toContain(privateExercise.exercise.id);

    const otherTrainer = await seedTrainer(container, seed, 'other-private@example.com');
    const otherList = await container.training.listExercises(
      otherTrainer.ctx,
      seed.workspaceId,
      {},
    );
    expect(otherList.data.map((exercise) => exercise.id)).not.toContain(
      privateExercise.exercise.id,
    );
  });

  test('active exercise name uniqueness is scoped, bilingual, race-safe, and archive-only', async () => {
    const seed = await seedGym(container);
    const otherWorkspace = await seedGym(container);
    const otherTrainer = await seedTrainer(container, seed, 'private-owner-2@example.com');
    const platform = await seedPlatformAdmin(container);

    await container.training.createPlatformExercise(platform.ctx, {
      names: { en: 'Global Curl' },
      exerciseType: 'RESISTANCE',
    });
    await expect(
      container.training.createPlatformExercise(platform.ctx, {
        names: { ar: 'Global Curl' },
        exerciseType: 'RESISTANCE',
      }),
    ).rejects.toMatchObject({ code: 'EXERCISE_NAME_CONFLICT' });

    await container.training.createExercise(seed.ownerCtx, seed.workspaceId, {
      scope: 'GYM',
      names: { en: 'Workspace Curl' },
      exerciseType: 'RESISTANCE',
    });
    await expect(
      container.training.createExercise(seed.ownerCtx, seed.workspaceId, {
        scope: 'GYM',
        names: { ar: 'workspace curl' },
        exerciseType: 'RESISTANCE',
      }),
    ).rejects.toMatchObject({ code: 'EXERCISE_NAME_CONFLICT' });
    await expect(
      container.training.createExercise(otherWorkspace.ownerCtx, otherWorkspace.workspaceId, {
        scope: 'GYM',
        names: { en: 'Workspace Curl' },
        exerciseType: 'RESISTANCE',
      }),
    ).resolves.toMatchObject({ exercise: { status: 'ACTIVE' } });

    await container.training.createExercise(seed.trainerCtx, seed.workspaceId, {
      scope: 'PRIVATE',
      names: { en: 'Private Curl' },
      exerciseType: 'RESISTANCE',
    });
    await expect(
      container.training.createExercise(seed.trainerCtx, seed.workspaceId, {
        scope: 'PRIVATE',
        names: { en: 'private curl' },
        exerciseType: 'RESISTANCE',
      }),
    ).rejects.toMatchObject({ code: 'EXERCISE_NAME_CONFLICT' });
    await expect(
      container.training.createExercise(otherTrainer.ctx, seed.workspaceId, {
        scope: 'PRIVATE',
        names: { en: 'Private Curl' },
        exerciseType: 'RESISTANCE',
      }),
    ).resolves.toMatchObject({ exercise: { status: 'ACTIVE' } });

    const archived = await container.training.createExercise(seed.ownerCtx, seed.workspaceId, {
      scope: 'GYM',
      names: { en: 'Reusable Curl' },
      exerciseType: 'RESISTANCE',
    });
    await container.training.archiveExercise(
      seed.ownerCtx,
      seed.workspaceId,
      archived.exercise.id,
      {
        expectedVersion: archived.exercise.version,
      },
    );
    await expect(
      container.training.createExercise(seed.ownerCtx, seed.workspaceId, {
        scope: 'GYM',
        names: { en: 'Reusable Curl' },
        exerciseType: 'RESISTANCE',
      }),
    ).resolves.toMatchObject({ exercise: { status: 'ACTIVE' } });

    const duplicateRace = await Promise.allSettled([
      container.training.createExercise(seed.ownerCtx, seed.workspaceId, {
        scope: 'GYM',
        names: { en: 'Simultaneous Curl' },
        exerciseType: 'RESISTANCE',
      }),
      container.training.createExercise(seed.ownerCtx, seed.workspaceId, {
        scope: 'GYM',
        names: { ar: 'simultaneous curl' },
        exerciseType: 'RESISTANCE',
      }),
    ]);
    expect(duplicateRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await db.collection('exercises').countDocuments({
        workspaceId: seed.workspaceObjectId,
        scope: 'GYM',
        status: 'ACTIVE',
        normalizedNames: 'simultaneous curl',
      }),
    ).toBe(1);
  });

  test('template and program revisions are immutable snapshots and block private leakage', async () => {
    const seed = await seedGym(container);
    const gymExercise = await activeGymExercise(container, seed, 'Squat');
    const privateExercise = await container.training.createExercise(
      seed.trainerCtx,
      seed.workspaceId,
      {
        scope: 'PRIVATE',
        names: { en: 'Private Squat' },
        exerciseType: 'RESISTANCE',
      },
    );

    await expect(
      container.training.createTemplate(seed.trainerCtx, seed.workspaceId, {
        scope: 'GYM',
        name: 'Leaky Gym Template',
        days: [day(privateExercise.exercise.id)],
      }),
    ).rejects.toMatchObject({ code: 'PRIVATE_EXERCISE_NOT_ALLOWED_IN_GYM_TEMPLATE' });

    const template = await container.training.createTemplate(seed.trainerCtx, seed.workspaceId, {
      scope: 'GYM',
      name: 'PPL',
      days: [day(gymExercise.exercise.id, 1, 'Push')],
    });
    const assigned = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'TEMPLATE', templateId: template.template.id },
        name: 'PPL - Trainee',
      },
    );
    await container.training.createTemplateRevision(
      seed.trainerCtx,
      seed.workspaceId,
      template.template.id,
      {
        expectedVersion: template.template.version,
        days: [day(gymExercise.exercise.id, 1, 'Changed')],
      },
    );

    const assignedSaved = await container.training.getProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      assigned.program.id,
    );
    expect(assignedSaved.revision.days[0]?.name).toBe('Push');
    expect(
      await db.collection('program_template_revisions').countDocuments({
        templateId: new ObjectId(template.template.id),
      }),
    ).toBe(2);
  });

  test('program copy creates an independent same-workspace snapshot and denies cross-workspace source IDs', async () => {
    const sourceSeed = await seedGym(container);
    const targetSeed = await seedGym(container);
    const exercise = await activeGymExercise(container, sourceSeed, 'Copy Lift');
    const source = await container.training.createProgram(
      sourceSeed.trainerCtx,
      sourceSeed.workspaceId,
      sourceSeed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Source Program',
        days: [day(exercise.exercise.id, 1, 'Source Day')],
      },
    );
    const copied = await container.training.createProgram(
      sourceSeed.trainerCtx,
      sourceSeed.workspaceId,
      sourceSeed.relationshipId,
      {
        source: { type: 'PROGRAM', programId: source.program.id },
        name: 'Copied Program',
      },
    );
    const copiedRead = await container.training.getProgram(
      sourceSeed.trainerCtx,
      sourceSeed.workspaceId,
      sourceSeed.relationshipId,
      copied.program.id,
    );
    expect(copiedRead.revision.days[0]?.name).toBe('Source Day');
    expect(copied.program.sourceProgramId).toBe(source.program.id);

    await expect(
      container.training.createProgram(
        targetSeed.ownerCtx,
        targetSeed.workspaceId,
        targetSeed.relationshipId,
        {
          source: { type: 'PROGRAM', programId: source.program.id },
          name: 'Cross Workspace Copy',
        },
      ),
    ).rejects.toMatchObject({ code: 'PROGRAM_NOT_FOUND' });
  });

  test('program copy revalidates private and archived exercise usability for new prescriptions', async () => {
    const seed = await seedGym(container);
    const privateExercise = await container.training.createExercise(
      seed.trainerCtx,
      seed.workspaceId,
      {
        scope: 'PRIVATE',
        names: { en: `Private Source ${new ObjectId().toHexString()}` },
        exerciseType: 'RESISTANCE',
      },
    );
    const source = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Private Source',
        days: [day(privateExercise.exercise.id)],
      },
    );
    await expect(
      container.training.createProgram(seed.ownerCtx, seed.workspaceId, seed.relationshipId, {
        source: { type: 'PROGRAM', programId: source.program.id },
        name: 'Owner Cannot Reuse Private Exercise',
      }),
    ).rejects.toMatchObject({ code: 'PROGRAM_SOURCE_EXERCISE_UNAVAILABLE' });

    const gymExercise = await activeGymExercise(container, seed, 'Archive Copy Source');
    const historical = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Historical Source',
        days: [day(gymExercise.exercise.id)],
      },
    );
    await container.training.archiveExercise(
      seed.ownerCtx,
      seed.workspaceId,
      gymExercise.exercise.id,
      { expectedVersion: gymExercise.exercise.version },
    );
    await expect(
      container.training.createProgram(seed.trainerCtx, seed.workspaceId, seed.relationshipId, {
        source: { type: 'PROGRAM', programId: historical.program.id },
        name: 'Archived Exercise Copy',
      }),
    ).rejects.toMatchObject({ code: 'PROGRAM_SOURCE_EXERCISE_UNAVAILABLE' });
  });

  test('activation replaces one active program, initializes progress, and preserves progress on active revisions', async () => {
    const seed = await seedGym(container);
    const exercise = await activeGymExercise(container, seed, 'Deadlift');
    const first = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'First',
        days: [day(exercise.exercise.id, 1, 'Day 1'), restDay(2)],
      },
    );
    const activatedFirst = await container.training.activateProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      first.program.id,
      { expectedVersion: first.program.version },
    );
    const progress = await container.training.getProgress(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      first.program.id,
    );
    expect(progress.progress.currentDaySequence).toBe(1);
    expect(progress.progress.completedDayCount).toBe(0);

    const activeEdit = await container.training.createProgramRevision(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      first.program.id,
      {
        expectedVersion: activatedFirst.program.version,
        days: [day(exercise.exercise.id, 1, 'Day 1', 'NORMAL', 4), restDay(2)],
      },
    );
    expect(activeEdit.revision.revision).toBe(2);
    expect(
      await db
        .collection('program_progress')
        .findOne({ programId: new ObjectId(first.program.id) }),
    ).toMatchObject({ currentDaySequence: 1, completedDayCount: 0, skippedDayCount: 0 });

    await expect(
      container.training.createProgramRevision(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        first.program.id,
        {
          expectedVersion: activeEdit.program.version,
          days: [day(exercise.exercise.id, 2, 'Moved')],
        },
      ),
    ).rejects.toMatchObject({ code: 'ACTIVE_PROGRAM_TOPOLOGY_CHANGE_UNSUPPORTED' });

    const second = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Second',
        days: [day(exercise.exercise.id)],
      },
    );
    await container.training.activateProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      second.program.id,
      {
        expectedVersion: second.program.version,
      },
    );
    expect(
      await container.trainingRepo.countActivePrograms(
        seed.workspaceObjectId,
        seed.relationshipObjectId,
      ),
    ).toBe(1);
    expect(
      (await db.collection('programs').findOne({ _id: new ObjectId(first.program.id) }))?.status,
    ).toBe('REPLACED');
    expect(
      await container.trainingRepo.countProgress(seed.workspaceObjectId, seed.relationshipObjectId),
    ).toBe(2);
  });

  test('active revisions preserve progress counters/events and enforce day topology while drafts may restructure', async () => {
    const seed = await seedGym(container);
    const exercise = await activeGymExercise(container, seed, 'Topology Lift');
    const program = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Topology Program',
        days: [day(exercise.exercise.id, 1, 'A'), restDay(2)],
      },
    );
    const draftEdit = await container.training.createProgramRevision(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      program.program.id,
      {
        expectedVersion: program.program.version,
        days: [day(exercise.exercise.id, 1, 'A'), restDay(2), day(exercise.exercise.id, 3, 'B')],
      },
    );
    expect(draftEdit.revision.days).toHaveLength(3);
    const activated = await container.training.activateProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      program.program.id,
      { expectedVersion: draftEdit.program.version },
    );
    await db
      .collection('program_progress')
      .updateOne(
        { programId: new ObjectId(program.program.id) },
        { $set: { currentDaySequence: 3, completedDayCount: 7, skippedDayCount: 2 } },
      );
    const eventCountBefore = await db
      .collection('program_progress_events')
      .countDocuments({ programId: new ObjectId(program.program.id) });
    const progressBefore = await db
      .collection('program_progress')
      .findOne({ programId: new ObjectId(program.program.id) });
    if (!progressBefore) throw new Error('expected progress row');

    const contentOnly = await container.training.createProgramRevision(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      program.program.id,
      {
        expectedVersion: activated.program.version,
        days: [
          day(exercise.exercise.id, 1, 'A', 'NORMAL', 5),
          restDay(2),
          day(exercise.exercise.id, 3, 'B', 'NORMAL', 4),
        ],
      },
    );
    expect(contentOnly.revision.revision).toBe(3);
    expect(
      await db.collection('program_progress').findOne({ _id: progressBefore._id }),
    ).toMatchObject({
      currentDaySequence: 3,
      completedDayCount: 7,
      skippedDayCount: 2,
    });
    expect(
      await db
        .collection('program_progress_events')
        .countDocuments({ programId: new ObjectId(program.program.id) }),
    ).toBe(eventCountBefore);

    for (const days of [
      [
        day(exercise.exercise.id, 1, 'A'),
        restDay(2),
        day(exercise.exercise.id, 3, 'B'),
        restDay(4),
      ],
      [day(exercise.exercise.id, 1, 'A'), restDay(2)],
      [
        { ...day(exercise.exercise.id, 1, 'Renamed Key'), dayKey: 'renamed-day-1' },
        restDay(2),
        day(exercise.exercise.id, 3, 'B'),
      ],
      [
        day(exercise.exercise.id, 1, 'A'),
        day(exercise.exercise.id, 2, 'Was Rest'),
        day(exercise.exercise.id, 3, 'B'),
      ],
    ]) {
      await expect(
        container.training.createProgramRevision(
          seed.trainerCtx,
          seed.workspaceId,
          seed.relationshipId,
          program.program.id,
          { expectedVersion: contentOnly.program.version, days },
        ),
      ).rejects.toMatchObject({ code: 'ACTIVE_PROGRAM_TOPOLOGY_CHANGE_UNSUPPORTED' });
    }
  });

  test('program activation uses an internal relationship guard without consuming public relationship version', async () => {
    const seed = await seedGym(container);
    const exercise = await activeGymExercise(container, seed, 'Version Guard Lift');
    const program = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Guard Program',
        days: [day(exercise.exercise.id)],
      },
    );
    const before = await container.coachingRelationships.findByIdInWorkspace(
      seed.workspaceObjectId,
      seed.relationshipObjectId,
    );
    await container.training.activateProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      program.program.id,
      { expectedVersion: program.program.version },
    );
    const afterActivation = await container.coachingRelationships.findByIdInWorkspace(
      seed.workspaceObjectId,
      seed.relationshipObjectId,
    );
    expect(afterActivation?.version).toBe(before?.version);
    expect(afterActivation?.trainingLifecycleRevision).toBe(
      (before?.trainingLifecycleRevision ?? 0) + 1,
    );

    await container.trainees.endRelationship(seed.ownerCtx, seed.workspaceId, seed.relationshipId, {
      expectedVersion: before?.version ?? -1,
    });
    expect(
      await container.trainingRepo.countActivePrograms(
        seed.workspaceObjectId,
        seed.relationshipObjectId,
      ),
    ).toBe(0);
    expect(
      (await db.collection('programs').findOne({ _id: new ObjectId(program.program.id) }))?.status,
    ).toBe('COMPLETED');
  });

  test('relationship end completes active program in the same business command and reactivation does not resume it', async () => {
    const seed = await seedGym(container);
    const exercise = await activeGymExercise(container, seed, 'Row');
    const program = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Active Program',
        days: [day(exercise.exercise.id)],
      },
    );
    await container.training.activateProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      program.program.id,
      {
        expectedVersion: program.program.version,
      },
    );
    const relationship = await container.coachingRelationships.findByIdInWorkspace(
      seed.workspaceObjectId,
      seed.relationshipObjectId,
    );
    await container.trainees.endRelationship(seed.ownerCtx, seed.workspaceId, seed.relationshipId, {
      expectedVersion: relationship?.version ?? -1,
      reason: 'done',
    });
    expect(
      (await db.collection('programs').findOne({ _id: new ObjectId(program.program.id) }))?.status,
    ).toBe('COMPLETED');
    expect(
      await container.trainingRepo.countActivePrograms(
        seed.workspaceObjectId,
        seed.relationshipObjectId,
      ),
    ).toBe(0);

    const ended = await container.coachingRelationships.findByIdInWorkspace(
      seed.workspaceObjectId,
      seed.relationshipObjectId,
    );
    await container.trainees.reactivateRelationship(
      seed.ownerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        expectedVersion: ended?.version ?? -1,
        homeBranchId: seed.branchId,
        primaryTrainerMembershipId: seed.trainerMembershipId,
      },
    );
    expect(
      (await db.collection('programs').findOne({ _id: new ObjectId(program.program.id) }))?.status,
    ).toBe('COMPLETED');
  });

  test('relationship state, self access, assistant denial, and entitlement read/write rules are enforced', async () => {
    const seed = await seedGym(container);
    const exercise = await activeGymExercise(container, seed, 'Pulldown');
    const program = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Stateful',
        days: [day(exercise.exercise.id)],
      },
    );
    await container.trainees.removePrimary(seed.ownerCtx, seed.workspaceId, seed.relationshipId, {
      expectedVersion: seed.relationshipVersion,
    });
    await expect(
      container.training.activateProgram(
        seed.ownerCtx,
        seed.workspaceId,
        seed.relationshipId,
        program.program.id,
        {
          expectedVersion: program.program.version,
        },
      ),
    ).rejects.toMatchObject({ code: 'COACHING_RELATIONSHIP_STATUS_INVALID' });

    await expect(
      container.training.getProgram(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        program.program.id,
      ),
    ).resolves.toMatchObject({ program: { id: program.program.id } });

    await expect(
      container.training.createProgram(seed.assistantCtx, seed.workspaceId, seed.relationshipId, {
        source: { type: 'SCRATCH' },
        name: 'Assistant Mutate',
        days: [day(exercise.exercise.id)],
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await db
      .collection('subscription_terms')
      .updateOne({ workspaceId: seed.workspaceObjectId }, { $set: { enabledFeatures: [] } });
    await expect(
      container.training.getProgram(
        seed.ownerCtx,
        seed.workspaceId,
        seed.relationshipId,
        program.program.id,
      ),
    ).resolves.toMatchObject({ program: { id: program.program.id } });
    await expect(
      container.training.createProgram(seed.ownerCtx, seed.workspaceId, seed.relationshipId, {
        source: { type: 'SCRATCH' },
        name: 'No Feature',
        days: [day(exercise.exercise.id)],
      }),
    ).rejects.toMatchObject({ code: 'FEATURE_NOT_AVAILABLE' });
  });

  test('trainer, assistant, trainee self, and nutritionist access stays relationship-scoped', async () => {
    const seed = await seedGym(container);
    const other = await seedRelationshipWithPrimary(container, seed, 'trainer-b@example.com');
    const exercise = await activeGymExercise(container, seed, 'Scoped Lift');
    const ownProgram = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Own Program',
        days: [day(exercise.exercise.id)],
      },
    );
    await expect(
      container.training.createProgram(seed.trainerCtx, seed.workspaceId, other.relationshipId, {
        source: { type: 'SCRATCH' },
        name: 'Other Program',
        days: [day(exercise.exercise.id)],
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      container.training.activateProgram(
        seed.trainerCtx,
        seed.workspaceId,
        other.relationshipId,
        ownProgram.program.id,
        { expectedVersion: ownProgram.program.version },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await expect(
      container.training.getProgram(
        seed.assistantCtx,
        seed.workspaceId,
        seed.relationshipId,
        ownProgram.program.id,
      ),
    ).resolves.toMatchObject({ program: { id: ownProgram.program.id } });
    for (const operation of [
      () =>
        container.training.createProgram(seed.assistantCtx, seed.workspaceId, seed.relationshipId, {
          source: { type: 'SCRATCH' },
          name: 'Assistant Create',
          days: [day(exercise.exercise.id)],
        }),
      () =>
        container.training.createProgramRevision(
          seed.assistantCtx,
          seed.workspaceId,
          seed.relationshipId,
          ownProgram.program.id,
          { expectedVersion: ownProgram.program.version, days: [day(exercise.exercise.id)] },
        ),
      () =>
        container.training.activateProgram(
          seed.assistantCtx,
          seed.workspaceId,
          seed.relationshipId,
          ownProgram.program.id,
          { expectedVersion: ownProgram.program.version },
        ),
      () =>
        container.training.archiveProgram(
          seed.assistantCtx,
          seed.workspaceId,
          seed.relationshipId,
          ownProgram.program.id,
          { expectedVersion: ownProgram.program.version },
        ),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }

    await writeGrant(db, {
      workspaceId: seed.workspaceObjectId,
      subjectId: new ObjectId(seed.assistantMembershipId),
      permission: Permissions.ProgramsCreate,
      effect: 'ALLOW',
    });
    await expect(
      container.training.createProgram(seed.assistantCtx, seed.workspaceId, seed.relationshipId, {
        source: { type: 'SCRATCH' },
        name: 'Assistant Explicit Create',
        days: [day(exercise.exercise.id)],
      }),
    ).resolves.toMatchObject({ program: { status: 'DRAFT' } });
    await db.collection('access_grants').deleteMany({
      workspaceId: seed.workspaceObjectId,
      subjectId: new ObjectId(seed.assistantMembershipId),
      permission: Permissions.ProgramsCreate,
    });
    await writeGrant(db, {
      workspaceId: seed.workspaceObjectId,
      subjectId: new ObjectId(seed.assistantMembershipId),
      permission: Permissions.ProgramsCreate,
      effect: 'DENY',
    });
    await expect(
      container.training.createProgram(seed.assistantCtx, seed.workspaceId, seed.relationshipId, {
        source: { type: 'SCRATCH' },
        name: 'Assistant Denied Create',
        days: [day(exercise.exercise.id)],
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await expect(
      container.training.getProgram(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        ownProgram.program.id,
      ),
    ).resolves.toMatchObject({ program: { id: ownProgram.program.id } });
    await expect(
      container.training.getProgram(
        seed.traineeCtx,
        seed.workspaceId,
        other.relationshipId,
        ownProgram.program.id,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      container.training.listTemplates(seed.traineeCtx, seed.workspaceId, {}),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(
      container.training.listExercises(seed.traineeCtx, seed.workspaceId, {}),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(
      container.training.createProgram(seed.traineeCtx, seed.workspaceId, seed.relationshipId, {
        source: { type: 'SCRATCH' },
        name: 'Trainee Mutate',
        days: [day(exercise.exercise.id)],
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const nutritionist = await seedNutritionist(container, seed);
    await expect(
      container.training.createProgram(nutritionist.ctx, seed.workspaceId, seed.relationshipId, {
        source: { type: 'SCRATCH' },
        name: 'Nutritionist Mutate',
        days: [day(exercise.exercise.id)],
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  test('activation revalidates archived exercise usability inside the transaction', async () => {
    const seed = await seedGym(container);
    const exercise = await activeGymExercise(container, seed, 'Archived Activation Lift');
    const program = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Will Not Activate',
        days: [day(exercise.exercise.id)],
      },
    );
    await container.training.archiveExercise(
      seed.ownerCtx,
      seed.workspaceId,
      exercise.exercise.id,
      { expectedVersion: exercise.exercise.version },
    );
    await expect(
      container.training.activateProgram(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        program.program.id,
        { expectedVersion: program.program.version },
      ),
    ).rejects.toMatchObject({ code: 'PROGRAM_SOURCE_EXERCISE_UNAVAILABLE' });
    expect(
      await container.trainingRepo.countActivePrograms(
        seed.workspaceObjectId,
        seed.relationshipObjectId,
      ),
    ).toBe(0);
  });

  test('concurrency protections cover activations, relationship END, revisions, duplicates, and archived exercise use', async () => {
    const seed = await seedGym(container);
    const exercise = await activeGymExercise(container, seed, 'Press');
    const a = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'A',
        days: [day(exercise.exercise.id)],
      },
    );
    const b = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'B',
        days: [day(exercise.exercise.id)],
      },
    );
    const activationResults = await Promise.allSettled([
      container.training.activateProgram(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        a.program.id,
        {
          expectedVersion: a.program.version,
        },
      ),
      container.training.activateProgram(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        b.program.id,
        {
          expectedVersion: b.program.version,
        },
      ),
    ]);
    expect(activationResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await container.trainingRepo.countActivePrograms(
        seed.workspaceObjectId,
        seed.relationshipObjectId,
      ),
    ).toBe(1);

    const race = await seedGym(container);
    const raceExercise = await activeGymExercise(container, race, 'Race Lift');
    const raceProgram = await container.training.createProgram(
      race.trainerCtx,
      race.workspaceId,
      race.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Race Program',
        days: [day(raceExercise.exercise.id)],
      },
    );
    const freshRelationship = await container.coachingRelationships.findByIdInWorkspace(
      race.workspaceObjectId,
      race.relationshipObjectId,
    );
    const endActivate = await Promise.allSettled([
      container.training.activateProgram(
        race.trainerCtx,
        race.workspaceId,
        race.relationshipId,
        raceProgram.program.id,
        {
          expectedVersion: raceProgram.program.version,
        },
      ),
      container.trainees.endRelationship(race.ownerCtx, race.workspaceId, race.relationshipId, {
        expectedVersion: freshRelationship?.version ?? -1,
      }),
    ]);
    expect(
      endActivate.filter((result) => result.status === 'fulfilled').length,
    ).toBeGreaterThanOrEqual(1);
    const raceSavedRelationship = await container.coachingRelationships.findByIdInWorkspace(
      race.workspaceObjectId,
      race.relationshipObjectId,
    );
    expect(
      raceSavedRelationship?.status === 'ENDED' &&
        (await container.trainingRepo.countActivePrograms(
          race.workspaceObjectId,
          race.relationshipObjectId,
        )) > 0,
    ).toBe(false);

    const template = await container.training.createTemplate(seed.trainerCtx, seed.workspaceId, {
      scope: 'GYM',
      name: 'Concurrent Template',
      days: [day(exercise.exercise.id)],
    });
    const revisionArchive = await Promise.allSettled([
      container.training.createTemplateRevision(
        seed.trainerCtx,
        seed.workspaceId,
        template.template.id,
        {
          expectedVersion: template.template.version,
          days: [day(exercise.exercise.id, 1, 'R2')],
        },
      ),
      container.training.archiveTemplate(seed.trainerCtx, seed.workspaceId, template.template.id, {
        expectedVersion: template.template.version,
      }),
    ]);
    expect(revisionArchive.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    await expect(
      Promise.all([
        container.training.createExercise(seed.ownerCtx, seed.workspaceId, {
          scope: 'GYM',
          names: { en: 'Race Duplicate' },
          exerciseType: 'RESISTANCE',
        }),
        container.training.createExercise(seed.ownerCtx, seed.workspaceId, {
          scope: 'GYM',
          names: { en: 'race duplicate' },
          exerciseType: 'RESISTANCE',
        }),
      ]),
    ).rejects.toMatchObject({ code: 'EXERCISE_NAME_CONFLICT' });

    await container.training.archiveExercise(
      seed.ownerCtx,
      seed.workspaceId,
      exercise.exercise.id,
      {
        expectedVersion: exercise.exercise.version,
      },
    );
    await expect(
      container.training.createProgramRevision(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        a.program.id,
        {
          expectedVersion: 0,
          days: [day(exercise.exercise.id)],
        },
      ),
    ).rejects.toMatchObject({ code: 'EXERCISE_NOT_FOUND' });
  });

  test('separate concurrency races preserve Stage 8 invariants', async () => {
    const activationSeed = await seedGym(container);
    const activationExercise = await activeGymExercise(container, activationSeed, 'Race A');
    const activationProgram = await container.training.createProgram(
      activationSeed.trainerCtx,
      activationSeed.workspaceId,
      activationSeed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Activation Wins',
        days: [day(activationExercise.exercise.id)],
      },
    );
    await container.training.activateProgram(
      activationSeed.trainerCtx,
      activationSeed.workspaceId,
      activationSeed.relationshipId,
      activationProgram.program.id,
      { expectedVersion: activationProgram.program.version },
    );
    const activationRelationship = await container.coachingRelationships.findByIdInWorkspace(
      activationSeed.workspaceObjectId,
      activationSeed.relationshipObjectId,
    );
    await container.trainees.endRelationship(
      activationSeed.ownerCtx,
      activationSeed.workspaceId,
      activationSeed.relationshipId,
      { expectedVersion: activationRelationship?.version ?? -1 },
    );
    expect(
      (await db.collection('programs').findOne({ _id: new ObjectId(activationProgram.program.id) }))
        ?.status,
    ).toBe('COMPLETED');

    const endSeed = await seedGym(container);
    const endExercise = await activeGymExercise(container, endSeed, 'Race B');
    const endProgram = await container.training.createProgram(
      endSeed.trainerCtx,
      endSeed.workspaceId,
      endSeed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'End Wins',
        days: [day(endExercise.exercise.id)],
      },
    );
    await container.trainees.endRelationship(
      endSeed.ownerCtx,
      endSeed.workspaceId,
      endSeed.relationshipId,
      {
        expectedVersion: endSeed.relationshipVersion,
      },
    );
    await expect(
      container.training.activateProgram(
        endSeed.trainerCtx,
        endSeed.workspaceId,
        endSeed.relationshipId,
        endProgram.program.id,
        { expectedVersion: endProgram.program.version },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(
      await container.trainingRepo.countActivePrograms(
        endSeed.workspaceObjectId,
        endSeed.relationshipObjectId,
      ),
    ).toBe(0);

    const revisionSeed = await seedGym(container);
    const exercise = await activeGymExercise(container, revisionSeed, 'Revision Race');
    const template = await container.training.createTemplate(
      revisionSeed.trainerCtx,
      revisionSeed.workspaceId,
      { scope: 'GYM', name: 'Two Template Revisions', days: [day(exercise.exercise.id)] },
    );
    const templateRace = await Promise.allSettled([
      container.training.createTemplateRevision(
        revisionSeed.trainerCtx,
        revisionSeed.workspaceId,
        template.template.id,
        { expectedVersion: template.template.version, days: [day(exercise.exercise.id, 1, 'T2a')] },
      ),
      container.training.createTemplateRevision(
        revisionSeed.trainerCtx,
        revisionSeed.workspaceId,
        template.template.id,
        { expectedVersion: template.template.version, days: [day(exercise.exercise.id, 1, 'T2b')] },
      ),
    ]);
    expect(templateRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await db.collection('program_template_revisions').countDocuments({
        templateId: new ObjectId(template.template.id),
      }),
    ).toBe(2);

    const program = await container.training.createProgram(
      revisionSeed.trainerCtx,
      revisionSeed.workspaceId,
      revisionSeed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Two Program Revisions',
        days: [day(exercise.exercise.id)],
      },
    );
    const programRace = await Promise.allSettled([
      container.training.createProgramRevision(
        revisionSeed.trainerCtx,
        revisionSeed.workspaceId,
        revisionSeed.relationshipId,
        program.program.id,
        { expectedVersion: program.program.version, days: [day(exercise.exercise.id, 1, 'P2a')] },
      ),
      container.training.createProgramRevision(
        revisionSeed.trainerCtx,
        revisionSeed.workspaceId,
        revisionSeed.relationshipId,
        program.program.id,
        { expectedVersion: program.program.version, days: [day(exercise.exercise.id, 1, 'P2b')] },
      ),
    ]);
    expect(programRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await db.collection('program_revisions').countDocuments({
        programId: new ObjectId(program.program.id),
      }),
    ).toBe(2);

    const active = await container.training.activateProgram(
      revisionSeed.trainerCtx,
      revisionSeed.workspaceId,
      revisionSeed.relationshipId,
      program.program.id,
      {
        expectedVersion:
          (await db.collection('programs').findOne({ _id: new ObjectId(program.program.id) }))
            ?.version ?? -1,
      },
    );
    const programStatusRace = await Promise.allSettled([
      container.training.createProgramRevision(
        revisionSeed.trainerCtx,
        revisionSeed.workspaceId,
        revisionSeed.relationshipId,
        program.program.id,
        { expectedVersion: active.program.version, days: [day(exercise.exercise.id, 1, 'P3')] },
      ),
      container.training.completeProgram(
        revisionSeed.trainerCtx,
        revisionSeed.workspaceId,
        revisionSeed.relationshipId,
        program.program.id,
        { expectedVersion: active.program.version },
      ),
    ]);
    expect(programStatusRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await container.trainingRepo.countActivePrograms(
        revisionSeed.workspaceObjectId,
        revisionSeed.relationshipObjectId,
      ),
    ).toBeLessThanOrEqual(1);

    const archiveExercise = await activeGymExercise(
      container,
      revisionSeed,
      'Archive Race Exercise',
    );
    const archiveTemplate = await container.training.createTemplate(
      revisionSeed.trainerCtx,
      revisionSeed.workspaceId,
      {
        scope: 'GYM',
        name: 'Archive Exercise Template Race',
        days: [day(exercise.exercise.id)],
      },
    );
    const exerciseTemplateRace = await Promise.allSettled([
      container.training.archiveExercise(
        revisionSeed.ownerCtx,
        revisionSeed.workspaceId,
        archiveExercise.exercise.id,
        { expectedVersion: archiveExercise.exercise.version },
      ),
      container.training.createTemplateRevision(
        revisionSeed.trainerCtx,
        revisionSeed.workspaceId,
        archiveTemplate.template.id,
        {
          expectedVersion: archiveTemplate.template.version,
          days: [day(archiveExercise.exercise.id)],
        },
      ),
    ]);
    expect(
      exerciseTemplateRace.filter((result) => result.status === 'fulfilled').length,
    ).toBeLessThanOrEqual(1);

    const archiveProgram = await container.training.createProgram(
      revisionSeed.trainerCtx,
      revisionSeed.workspaceId,
      revisionSeed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Archive Exercise Program Race',
        days: [day(exercise.exercise.id)],
      },
    );
    const archiveProgramExercise = await activeGymExercise(
      container,
      revisionSeed,
      'Archive Race Program Exercise',
    );
    const exerciseProgramRace = await Promise.allSettled([
      container.training.archiveExercise(
        revisionSeed.ownerCtx,
        revisionSeed.workspaceId,
        archiveProgramExercise.exercise.id,
        { expectedVersion: archiveProgramExercise.exercise.version },
      ),
      container.training.createProgramRevision(
        revisionSeed.trainerCtx,
        revisionSeed.workspaceId,
        revisionSeed.relationshipId,
        archiveProgram.program.id,
        {
          expectedVersion: archiveProgram.program.version,
          days: [day(archiveProgramExercise.exercise.id)],
        },
      ),
    ]);
    expect(
      exerciseProgramRace.filter((result) => result.status === 'fulfilled').length,
    ).toBeLessThanOrEqual(1);
  }, 30_000);

  test('activation rolls back replacement and progress when outbox persistence fails', async () => {
    const seed = await seedGym(container);
    const exercise = await activeGymExercise(container, seed, 'Rollback Lift');
    const program = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Rollback Program',
        days: [day(exercise.exercise.id)],
      },
    );
    const originalWrite = container.outbox.write.bind(container.outbox);
    let failed = false;
    (
      container.outbox as unknown as {
        write: typeof container.outbox.write;
      }
    ).write = async (event, tx) => {
      if (event.eventType === 'ProgramActivated') {
        failed = true;
        throw new Error('outbox down');
      }
      return await originalWrite(event, tx);
    };
    try {
      await expect(
        container.training.activateProgram(
          seed.trainerCtx,
          seed.workspaceId,
          seed.relationshipId,
          program.program.id,
          { expectedVersion: program.program.version },
        ),
      ).rejects.toThrow('outbox down');
    } finally {
      (
        container.outbox as unknown as {
          write: typeof container.outbox.write;
        }
      ).write = originalWrite;
    }
    expect(failed).toBe(true);
    expect(
      await container.trainingRepo.countActivePrograms(
        seed.workspaceObjectId,
        seed.relationshipObjectId,
      ),
    ).toBe(0);
    expect(
      await db
        .collection('program_progress')
        .countDocuments({ programId: new ObjectId(program.program.id) }),
    ).toBe(0);
  });

  test('activation rollback covers audit failure and idempotency completion failure', async () => {
    const auditSeed = await seedGym(container);
    const auditExercise = await activeGymExercise(container, auditSeed, 'Audit Rollback');
    const auditProgram = await container.training.createProgram(
      auditSeed.trainerCtx,
      auditSeed.workspaceId,
      auditSeed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Audit Failure',
        days: [day(auditExercise.exercise.id)],
      },
    );
    const originalAudit = container.audit.write.bind(container.audit);
    (container.audit as unknown as { write: typeof container.audit.write }).write = async (
      event,
      tx,
    ) => {
      if (event.eventType === 'ProgramActivated') throw new Error('audit down');
      return await originalAudit(event, tx);
    };
    try {
      await expect(
        container.training.activateProgram(
          auditSeed.trainerCtx,
          auditSeed.workspaceId,
          auditSeed.relationshipId,
          auditProgram.program.id,
          { expectedVersion: auditProgram.program.version },
        ),
      ).rejects.toThrow('audit down');
    } finally {
      (container.audit as unknown as { write: typeof container.audit.write }).write = originalAudit;
    }
    expect(
      await container.trainingRepo.countActivePrograms(
        auditSeed.workspaceObjectId,
        auditSeed.relationshipObjectId,
      ),
    ).toBe(0);
    expect(
      await db
        .collection('program_progress')
        .countDocuments({ programId: new ObjectId(auditProgram.program.id) }),
    ).toBe(0);

    const idemSeed = await seedGym(container);
    const firstExercise = await activeGymExercise(container, idemSeed, 'Completion Fail Existing');
    const first = await container.training.createProgram(
      idemSeed.trainerCtx,
      idemSeed.workspaceId,
      idemSeed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Existing',
        days: [day(firstExercise.exercise.id)],
      },
    );
    const active = await container.training.activateProgram(
      idemSeed.trainerCtx,
      idemSeed.workspaceId,
      idemSeed.relationshipId,
      first.program.id,
      { expectedVersion: first.program.version },
    );
    const nextExercise = await activeGymExercise(container, idemSeed, 'Completion Fail Next');
    const next = await container.training.createProgram(
      idemSeed.trainerCtx,
      idemSeed.workspaceId,
      idemSeed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Next',
        days: [day(nextExercise.exercise.id)],
      },
    );
    await db.command({
      collMod: 'idempotency_records',
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          properties: { state: { enum: ['PROCESSING', 'FAILED'] } },
        },
      },
      validationAction: 'error',
    });
    try {
      await expect(
        runActivationIdempotently(container, idemSeed, next.program.id, next.program.version, {
          key: `completion-failure-${new ObjectId().toHexString()}`,
        }),
      ).rejects.toThrow();
    } finally {
      await db.command({ collMod: 'idempotency_records', validator: {} });
    }
    expect(
      (await db.collection('programs').findOne({ _id: new ObjectId(first.program.id) }))?.status,
    ).toBe('ACTIVE');
    expect(
      (await db.collection('programs').findOne({ _id: new ObjectId(next.program.id) }))?.status,
    ).toBe('DRAFT');
    expect(
      await db
        .collection('program_progress')
        .countDocuments({ programId: new ObjectId(next.program.id) }),
    ).toBe(0);
    expect(
      await container.trainingRepo.countActivePrograms(
        idemSeed.workspaceObjectId,
        idemSeed.relationshipObjectId,
      ),
    ).toBe(1);
    expect(active.program.status).toBe('ACTIVE');
  });

  test('activation idempotency replays without duplicate events and rejects conflicting key reuse', async () => {
    const seed = await seedGym(container);
    const exercise = await activeGymExercise(container, seed, 'Idempotent Lift');
    const program = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Idempotent Program',
        days: [day(exercise.exercise.id)],
      },
    );
    const key = `activate-${new ObjectId().toHexString()}`;
    const first = await runActivationIdempotently(
      container,
      seed,
      program.program.id,
      program.program.version,
      {
        key,
      },
    );
    const replay = await runActivationIdempotently(
      container,
      seed,
      program.program.id,
      program.program.version,
      {
        key,
      },
    );
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toMatchObject({
      program: { id: first.body.program.id, status: 'ACTIVE', version: 1 },
    });
    expect(
      await db.collection('outbox_events').countDocuments({
        aggregateId: new ObjectId(program.program.id),
        eventType: 'ProgramActivated',
      }),
    ).toBe(1);
    expect(
      await db
        .collection('program_progress')
        .countDocuments({ programId: new ObjectId(program.program.id) }),
    ).toBe(1);
    expect(
      await db
        .collection('program_progress_events')
        .countDocuments({ programId: new ObjectId(program.program.id), type: 'INITIALIZED' }),
    ).toBe(1);
    expect(
      (await db.collection('programs').findOne({ _id: new ObjectId(program.program.id) }))?.version,
    ).toBe(1);
    await expect(
      runActivationIdempotently(container, seed, program.program.id, 999, { key }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  test('activation route requires Idempotency-Key and Stage 9 progress routes require it too', async () => {
    const seed = await seedGym(container);
    const exercise = await activeGymExercise(container, seed, 'Curl');
    const program = await container.training.createProgram(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      {
        source: { type: 'SCRATCH' },
        name: 'Route Program',
        days: [day(exercise.exercise.id)],
      },
    );
    const app = await buildApp(container);
    await expect(
      container.idempotency.runInTransaction(seed.trainerCtx, {
        routeKey:
          'POST /workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/activate',
        key: undefined,
        fingerprint: { programId: program.program.id },
        unitOfWork: container.unitOfWork,
        operation: async (tx) => ({
          body: await container.training.activateProgram(
            seed.trainerCtx,
            seed.workspaceId,
            seed.relationshipId,
            program.program.id,
            { expectedVersion: program.program.version },
            tx,
          ),
        }),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });

    const skipped = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${seed.workspaceId}/relationships/${seed.relationshipId}/programs/${program.program.id}/progress/skip`,
      payload: { reason: 'travel' },
    });
    expect(skipped.statusCode).toBe(400);
    await app.close();
  });
});

async function seedGym(container: AppContainer) {
  const db = container.database.db;
  const owner = await seedUser(db, `owner-${new ObjectId().toHexString()}@example.com`);
  const trainer = await seedUser(db, `trainer-${new ObjectId().toHexString()}@example.com`);
  const trainee = await seedUser(db, `trainee-${new ObjectId().toHexString()}@example.com`);
  const assistant = await seedUser(db, `assistant-${new ObjectId().toHexString()}@example.com`);
  const workspace = await container.workspaceRepo.create({
    type: 'GYM',
    name: 'Stage 8 Gym',
    ownerUserId: owner._id,
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
  });
  await seedCommercial(db, workspace._id, ['training']);
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
  const assistantAssignment = await container.coachingRelationships.createAssignment({
    workspaceId: workspace._id,
    relationshipId: relationship._id,
    staffMembershipId: assistantMembership._id,
    assignmentType: 'ASSISTANT_TRAINER',
    assignedBy: owner._id,
  });
  void assistantAssignment;
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
    relationshipId: active._id.toHexString(),
    relationshipObjectId: active._id,
    relationshipVersion: active.version,
    trainerMembershipId: trainerMembership._id.toHexString(),
    assistantMembershipId: assistantMembership._id.toHexString(),
    ownerCtx: ctx(owner._id, ownerMembership._id),
    trainerCtx: ctx(trainer._id, trainerMembership._id),
    traineeCtx: ctx(trainee._id, traineeMembership._id),
    assistantCtx: ctx(assistant._id, assistantMembership._id),
  };
}

async function seedTrainer(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  email: string,
) {
  const user = await seedUser(container.database.db, email);
  const membership = await container.workspaceMemberships.createActive({
    workspaceId: seed.workspaceObjectId,
    userId: user._id,
    roles: ['TRAINER'],
  });
  await assignSystemProfile(container, seed.workspaceObjectId, membership._id, 'TRAINER');
  await container.membershipBranchAssignments.createActive(
    seed.workspaceObjectId,
    membership._id,
    new ObjectId(seed.branchId),
  );
  return { ctx: ctx(user._id, membership._id), membership };
}

async function seedRelationshipWithPrimary(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  trainerEmail: string,
) {
  const trainer = await seedTrainer(container, seed, trainerEmail);
  const trainee = await seedUser(
    container.database.db,
    `trainee-${new ObjectId().toHexString()}@example.com`,
  );
  const traineeMembership = await container.workspaceMemberships.createActive({
    workspaceId: seed.workspaceObjectId,
    userId: trainee._id,
    roles: ['TRAINEE'],
  });
  await assignSystemProfile(container, seed.workspaceObjectId, traineeMembership._id, 'TRAINEE');
  const relationship = await container.coachingRelationships.createActive({
    workspaceId: seed.workspaceObjectId,
    traineeUserId: trainee._id,
    traineeMembershipId: traineeMembership._id,
    homeBranchId: new ObjectId(seed.branchId),
    activatedBy: new ObjectId(seed.trainerCtx.userId),
  });
  const primary = await container.coachingRelationships.createAssignment({
    workspaceId: seed.workspaceObjectId,
    relationshipId: relationship._id,
    staffMembershipId: trainer.membership._id,
    assignmentType: 'PRIMARY_TRAINER',
    assignedBy: new ObjectId(seed.trainerCtx.userId),
  });
  const active = await container.coachingRelationships.setPrimaryPointer(
    relationship._id,
    seed.workspaceObjectId,
    relationship.version,
    ['ACTIVE'],
    primary._id,
  );
  return {
    relationshipId: active._id.toHexString(),
    relationshipObjectId: active._id,
    trainer,
    traineeCtx: ctx(trainee._id, traineeMembership._id),
  };
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
  await container.membershipBranchAssignments.createActive(
    seed.workspaceObjectId,
    membership._id,
    new ObjectId(seed.branchId),
  );
  await container.coachingRelationships.createAssignment({
    workspaceId: seed.workspaceObjectId,
    relationshipId: seed.relationshipObjectId,
    staffMembershipId: membership._id,
    assignmentType: 'NUTRITIONIST',
    assignedBy: new ObjectId(seed.ownerCtx.userId),
  });
  return { ctx: ctx(user._id, membership._id), membership };
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

async function runActivationIdempotently(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  programId: string,
  expectedVersion: number,
  input: { key: string },
) {
  return await container.idempotency.runInTransaction(seed.trainerCtx, {
    routeKey:
      'POST /workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/activate',
    key: input.key,
    fingerprint: {
      params: { workspaceId: seed.workspaceId, relationshipId: seed.relationshipId, programId },
      body: { expectedVersion },
    },
    unitOfWork: container.unitOfWork,
    operation: async (tx) => ({
      body: await container.training.activateProgram(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        programId,
        { expectedVersion },
        tx,
      ),
    }),
  });
}

async function seedPlatformAdmin(container: AppContainer) {
  const user = await seedUser(
    container.database.db,
    `platform-${new ObjectId().toHexString()}@example.com`,
  );
  const membership = await container.platformMemberships.createActive(user._id);
  const seed = systemPermissionProfiles.find(
    (profile) => profile.context === 'PLATFORM' && profile.roleKey === 'PLATFORM_SUPER_ADMIN',
  );
  if (!seed) throw new Error('missing platform profile seed');
  const profile =
    (await container.permissionProfiles.findSystemDefault({
      context: 'PLATFORM',
      roleKey: 'PLATFORM_SUPER_ADMIN',
    })) ??
    (await container.permissionProfiles.create({
      context: 'PLATFORM',
      roleKey: 'PLATFORM_SUPER_ADMIN',
      name: seed.name,
      permissions: seed.permissions,
      isSystemDefault: true,
    }));
  await container.platformMemberships.replacePermissionProfiles(membership._id, 0, [profile._id]);
  return { ctx: { ...ctx(user._id), mfaSatisfied: true } };
}

async function activeGymExercise(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  name: string,
) {
  return await container.training.createExercise(seed.ownerCtx, seed.workspaceId, {
    scope: 'GYM',
    names: { en: `${name}-${new ObjectId().toHexString()}` },
    exerciseType: 'RESISTANCE',
  });
}

function day(
  exerciseId: string,
  sequence = 1,
  name = 'Day',
  setStructure = 'NORMAL',
  targetSets = 3,
) {
  return {
    sequence,
    name,
    type: 'RESISTANCE' as const,
    exercises: [
      {
        exerciseId,
        order: 1,
        setStructure,
        targetSets,
        repRange: { min: 8, max: 12 },
        restSeconds: 90,
      },
    ],
  };
}

function restDay(sequence: number) {
  return { sequence, name: 'Rest', type: 'REST' as const, exercises: [] };
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
    lastName: 'Eight',
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

function indexes(calls: Array<{ collection: string; indexes: unknown[] }>, collection: string) {
  return calls.find((call) => call.collection === collection)?.indexes;
}

function mongoUri(): string {
  return process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
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
    mongo: {
      uri: mongoUri(),
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
    subscriptions: {
      trialExpiryAction: 'FROZEN',
      paidGraceDays: 0,
      frozenToExpiredDays: 30,
    },
    support: {
      defaultSessionMinutes: 30,
      maxSessionMinutes: 60,
    },
  };
}
