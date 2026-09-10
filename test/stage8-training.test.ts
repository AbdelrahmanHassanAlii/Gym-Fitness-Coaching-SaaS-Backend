import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Db, ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import type { AppContainer } from '../src/bootstrap/app-container';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { migrations } from '../src/migrations';
import { migration013Stage8TrainingFoundation } from '../src/migrations/013-stage8-training-foundation';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { systemPermissionProfiles } from '../src/modules/permissions/permission.registry';

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
    ).rejects.toMatchObject({ code: 'COACHING_RELATIONSHIP_VERSION_CONFLICT' });

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

  test('activation route requires Idempotency-Key and no Stage 9 endpoints exist', async () => {
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
    expect(skipped.statusCode).toBe(404);
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
  return { ctx: ctx(user._id, membership._id), membership };
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
