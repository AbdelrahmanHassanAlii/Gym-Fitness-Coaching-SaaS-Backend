import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Db, ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import type { AppContainer } from '../src/bootstrap/app-container';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { migrations } from '../src/migrations';
import { migration014Stage9WorkoutExecution } from '../src/migrations/014-stage9-workout-execution';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { systemPermissionProfiles } from '../src/modules/permissions/permission.registry';

describe('Stage 9 migration 014', () => {
  test('creates workout and personal-record indexes and permission seeds only', async () => {
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

    await migration014Stage9WorkoutExecution.up(db as never);

    expect(indexes(calls, 'workout_sessions')).toContainEqual(
      expect.objectContaining({
        name: 'workout_sessions_one_in_progress_per_relationship',
        unique: true,
        partialFilterExpression: { status: 'IN_PROGRESS' },
      }),
    );
    expect(indexes(calls, 'personal_records')).toContainEqual(
      expect.objectContaining({
        name: 'personal_records_projection_unique',
        unique: true,
      }),
    );
    expect(indexes(calls, 'workout_corrections')).toBeUndefined();
    expect(JSON.stringify(updates)).toContain('workouts.complete');
    expect(JSON.stringify(updates)).toContain('personal_records.read');
  });

  test('runs clean 001-014 and locked 013-to-014 upgrades without correction/sync collections', async () => {
    const clean = await createAppContainer(
      integrationConfig(`stage9_clean_${new ObjectId().toHexString()}`),
    );
    const upgrade = await createAppContainer(
      integrationConfig(`stage9_upgrade_${new ObjectId().toHexString()}`),
    );
    try {
      await new MigrationRunner(clean.database.db, migrations).migrate();
      expect(
        await clean.database.db
          .collection('db_migrations')
          .countDocuments({ migrationId: '014-stage9-workout-execution' }),
      ).toBe(1);
      expect(
        await clean.database.db.listCollections({ name: 'workout_corrections' }).hasNext(),
      ).toBe(false);

      const through13 = migrations.filter(
        (migration) => migration.id !== '014-stage9-workout-execution',
      );
      await new MigrationRunner(upgrade.database.db, through13).migrate();
      expect(
        await upgrade.database.db
          .collection('db_migrations')
          .countDocuments({ migrationId: '013-stage8-training-foundation' }),
      ).toBe(1);
      await new MigrationRunner(upgrade.database.db, migrations).migrate();
      await new MigrationRunner(upgrade.database.db, migrations).migrate();
      expect(
        await upgrade.database.db
          .collection('db_migrations')
          .countDocuments({ migrationId: '014-stage9-workout-execution' }),
      ).toBe(1);
      expect(
        await upgrade.database.db
          .collection('permission_definitions')
          .countDocuments({ key: 'workouts.read', state: 'ACTIVE' }),
      ).toBe(1);
      expect(
        await upgrade.database.db.listCollections({ name: 'workout_corrections' }).hasNext(),
      ).toBe(false);
    } finally {
      await clean.database.db.dropDatabase();
      await clean.database.close();
      await upgrade.database.db.dropDatabase();
      await upgrade.database.close();
    }
  }, 30_000);
});

describe('Stage 9 workout execution integration', () => {
  let container: AppContainer;
  let db: Db;

  beforeAll(async () => {
    container = await createAppContainer(
      integrationConfig(`stage9_${new ObjectId().toHexString()}`),
    );
    db = container.database.db;
    await new MigrationRunner(db, migrations).migrate();
  }, 30_000);

  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (container) await container.database.close();
  }, 30_000);

  test('start creates one IN_PROGRESS snapshot without touching public relationship/program/progress versions', async () => {
    const seed = await seedGym(container);
    const active = await activeProgram(container, seed, 'Snapshot Lift');
    const relationshipBefore = await db
      .collection('coaching_relationships')
      .findOne({ _id: seed.relationshipObjectId });
    const programBefore = await db
      .collection('programs')
      .findOne({ _id: new ObjectId(active.program.id) });
    const progressBefore = await db
      .collection('program_progress')
      .findOne({ programId: new ObjectId(active.program.id) });
    const first = await runStart(container, seed, `start-${new ObjectId().toHexString()}`);
    const replay = await runStart(container, seed, first.key);

    expect(first.result.replayed).toBe(false);
    expect(replay.result.replayed).toBe(true);
    expect(replay.result.body.workout.id).toBe(first.result.body.workout.id);
    expect(first.result.body.workout.status).toBe('IN_PROGRESS');
    expect(first.result.body.workout.programRevisionId).toBe(active.program.currentRevisionId);
    expect(firstExercise(first.result.body.workout).exerciseNameSnapshot).toContain(
      'Snapshot Lift',
    );
    expect(
      (await db.collection('coaching_relationships').findOne({ _id: seed.relationshipObjectId }))
        ?.version,
    ).toBe(relationshipBefore?.version);
    expect(
      (await db.collection('programs').findOne({ _id: new ObjectId(active.program.id) }))?.version,
    ).toBe(programBefore?.version);
    expect(
      (
        await db
          .collection('program_progress')
          .findOne({ programId: new ObjectId(active.program.id) })
      )?.version,
    ).toBe(progressBefore?.version);
    expect(
      await db.collection('workout_sessions').countDocuments({
        workspaceId: seed.workspaceObjectId,
        relationshipId: seed.relationshipObjectId,
        status: 'IN_PROGRESS',
      }),
    ).toBe(1);
  });

  test('duplicate starts race to a single IN_PROGRESS workout and stable conflict', async () => {
    const seed = await seedGym(container);
    await activeProgram(container, seed, 'Race Start');
    const results = await Promise.allSettled([
      runStart(container, seed, `start-a-${new ObjectId().toHexString()}`),
      runStart(container, seed, `start-b-${new ObjectId().toHexString()}`),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')[0]).toMatchObject({
      reason: expect.objectContaining({ code: 'WORKOUT_ALREADY_IN_PROGRESS' }),
    });
    expect(
      await db
        .collection('workout_sessions')
        .countDocuments({ relationshipId: seed.relationshipObjectId, status: 'IN_PROGRESS' }),
    ).toBe(1);
  });

  test('patch uses immutable set keys, completion advances progress circularly and creates PR projections once', async () => {
    const seed = await seedGym(container);
    const active = await activeProgram(container, seed, 'Bench PR', [1, 3]);
    const started = (
      await runStart(container, seed, `complete-start-${new ObjectId().toHexString()}`)
    ).result.body.workout;
    const setKey = firstSet(started).setKey;
    const workoutExerciseKey = firstExercise(started).workoutExerciseKey;
    const patched = await container.workouts.patch(
      seed.traineeCtx,
      seed.workspaceId,
      seed.relationshipId,
      started.id,
      {
        expectedVersion: started.version,
        exercises: [
          { workoutExerciseKey, sets: [{ setKey, weight: 100, reps: 5, rpe: 8, completed: true }] },
        ],
      },
    );
    expect(firstExercise(patched.workout).exerciseId).toBe(firstExercise(started).exerciseId);
    await expect(
      container.workouts.patch(seed.traineeCtx, seed.workspaceId, seed.relationshipId, started.id, {
        expectedVersion: started.version,
        exercises: [
          { workoutExerciseKey, sets: [{ setKey, weight: 101, reps: 5, completed: true }] },
        ],
      }),
    ).rejects.toMatchObject({ code: 'WORKOUT_VERSION_CONFLICT' });

    const completed = await runComplete(
      container,
      seed,
      started.id,
      patched.workout.version,
      `complete-${new ObjectId().toHexString()}`,
    );
    const replay = await runComplete(
      container,
      seed,
      started.id,
      patched.workout.version,
      completed.key,
    );
    expect(replay.result.replayed).toBe(true);
    expect(
      (
        await db
          .collection('program_progress')
          .findOne({ programId: new ObjectId(active.program.id) })
      )?.currentDaySequence,
    ).toBe(3);
    expect(
      (
        await db
          .collection('program_progress')
          .findOne({ programId: new ObjectId(active.program.id) })
      )?.completedDayCount,
    ).toBe(1);
    expect(
      await db
        .collection('program_progress_events')
        .countDocuments({ workoutSessionId: new ObjectId(started.id), type: 'COMPLETED' }),
    ).toBe(1);
    expect(
      await db
        .collection('outbox_events')
        .countDocuments({ aggregateId: new ObjectId(started.id), eventType: 'WorkoutCompleted' }),
    ).toBe(1);
    expect(
      await db
        .collection('personal_records')
        .countDocuments({ relationshipId: seed.relationshipObjectId }),
    ).toBe(3);
    expect(
      await db
        .collection('personal_record_events')
        .countDocuments({ relationshipId: seed.relationshipObjectId, eventType: 'ACHIEVED' }),
    ).toBe(3);
  });

  test('active program revision while workout is running leaves session on original revision and future start uses new revision', async () => {
    const seed = await seedGym(container);
    const active = await activeProgram(container, seed, 'Revision Lift');
    const started = (await runStart(container, seed, `rev-start-${new ObjectId().toHexString()}`))
      .result.body.workout;
    const exercise = await activeGymExercise(container, seed, 'Revision Lift');
    const edited = await container.training.createProgramRevision(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      active.program.id,
      {
        expectedVersion: active.program.version,
        days: [day(exercise.exercise.id, 1, 'Day 1', 4)],
      },
    );
    expect(started.programRevisionId).toBe(active.program.currentRevisionId);
    await runAbandon(
      container,
      seed,
      started.id,
      started.version,
      `abandon-${new ObjectId().toHexString()}`,
    );
    const future = (
      await runStart(container, seed, `rev-start-next-${new ObjectId().toHexString()}`)
    ).result.body.workout;
    expect(future.programRevisionId).toBe(edited.program.currentRevisionId);
  });

  test('skip/defer mutate progress history, skip rest entries, and reject while workout is live', async () => {
    const seed = await seedGym(container);
    const active = await activeProgram(container, seed, 'Progress Lift', [1, 3]);
    const progress = await container.training.getProgress(
      seed.trainerCtx,
      seed.workspaceId,
      seed.relationshipId,
      active.program.id,
    );
    const deferred = await runProgress(
      container,
      seed,
      active.program.id,
      progress.progress.version,
      'DEFERRED',
      `defer-${new ObjectId().toHexString()}`,
    );
    expect(deferred.result.body.progress.currentDaySequence).toBe(1);
    expect(deferred.result.body.progress.version).toBe(1);
    const skipped = await runProgress(
      container,
      seed,
      active.program.id,
      1,
      'SKIPPED',
      `skip-${new ObjectId().toHexString()}`,
    );
    expect(skipped.result.body.progress.currentDaySequence).toBe(3);
    expect(skipped.result.body.progress.skippedDayCount).toBe(1);
    expect(
      await db
        .collection('program_progress_events')
        .countDocuments({ programId: new ObjectId(active.program.id), type: 'DEFERRED' }),
    ).toBe(1);
    await runStart(container, seed, `skip-live-${new ObjectId().toHexString()}`);
    await expect(
      runProgress(
        container,
        seed,
        active.program.id,
        2,
        'SKIPPED',
        `skip-blocked-${new ObjectId().toHexString()}`,
      ),
    ).rejects.toMatchObject({ code: 'WORKOUT_ALREADY_IN_PROGRESS' });
  });

  test('abandon preserves partial sets, does not advance progress or PRs, and allows restarting same day', async () => {
    const seed = await seedGym(container);
    const active = await activeProgram(container, seed, 'Abandon Lift');
    const started = (
      await runStart(container, seed, `abandon-start-${new ObjectId().toHexString()}`)
    ).result.body.workout;
    const abandoned = await runAbandon(
      container,
      seed,
      started.id,
      started.version,
      `abandon-now-${new ObjectId().toHexString()}`,
    );
    expect(abandoned.result.body.workout.status).toBe('ABANDONED');
    expect(
      (
        await db
          .collection('program_progress')
          .findOne({ programId: new ObjectId(active.program.id) })
      )?.completedDayCount,
    ).toBe(0);
    expect(
      await db
        .collection('personal_records')
        .countDocuments({ relationshipId: seed.relationshipObjectId }),
    ).toBe(0);
    const restarted = await runStart(
      container,
      seed,
      `abandon-restart-${new ObjectId().toHexString()}`,
    );
    expect(restarted.result.body.workout.daySequence).toBe(1);
  });

  test('trainee and staff corrections recalculate PRs without retroactive progress changes', async () => {
    const seed = await seedGym(container);
    const active = await activeProgram(container, seed, 'Correct Lift');
    const workout = await completeWithSet(
      container,
      seed,
      100,
      5,
      `correct-a-${new ObjectId().toHexString()}`,
    );
    await completeWithSet(container, seed, 90, 8, `correct-b-${new ObjectId().toHexString()}`);
    const progressBefore = await db
      .collection('program_progress')
      .findOne({ programId: new ObjectId(active.program.id) });
    const key = firstSet(workout.workout).setKey;
    const exerciseKey = firstExercise(workout.workout).workoutExerciseKey;
    const traineeCorrected = await container.workouts.patch(
      seed.traineeCtx,
      seed.workspaceId,
      seed.relationshipId,
      workout.workout.id,
      {
        expectedVersion: workout.completed.workout.version,
        exercises: [
          {
            workoutExerciseKey: exerciseKey,
            sets: [{ setKey: key, weight: 80, reps: 5, completed: true }],
          },
        ],
      },
    );
    expect(traineeCorrected.workout.status).toBe('COMPLETED');
    const staffCorrected = await runStaffCorrection(
      container,
      seed,
      workout.workout.id,
      traineeCorrected.workout.version,
      exerciseKey,
      key,
      0,
      0,
      `staff-correct-${new ObjectId().toHexString()}`,
    );
    expect(staffCorrected.result.body.workout.status).toBe('COMPLETED');
    expect(
      (
        await db
          .collection('program_progress')
          .findOne({ programId: new ObjectId(active.program.id) })
      )?.completedDayCount,
    ).toBe(progressBefore?.completedDayCount);
    expect(
      await db
        .collection('personal_record_events')
        .countDocuments({ relationshipId: seed.relationshipObjectId, eventType: 'ADJUSTED' }),
    ).toBeGreaterThan(0);
    expect(
      await db
        .collection('personal_record_events')
        .countDocuments({ relationshipId: seed.relationshipObjectId, eventType: 'RETRACTED' }),
    ).toBeGreaterThan(0);
    await db
      .collection('workout_sessions')
      .updateOne(
        { _id: new ObjectId(workout.workout.id) },
        { $set: { traineeEditableUntil: new Date(Date.now() - 1000) } },
      );
    await expect(
      container.workouts.patch(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        workout.workout.id,
        {
          expectedVersion: staffCorrected.result.body.workout.version,
          exercises: [
            {
              workoutExerciseKey: exerciseKey,
              sets: [{ setKey: key, weight: 120, reps: 1, completed: true }],
            },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: 'WORKOUT_EDIT_WINDOW_EXPIRED' });
  });

  test('relationship/program lifecycle seams block transitions or abandon live workout atomically', async () => {
    const seed = await seedGym(container);
    const active = await activeProgram(container, seed, 'Seam Lift');
    const live = (await runStart(container, seed, `seam-start-${new ObjectId().toHexString()}`))
      .result.body.workout;
    await expect(
      container.training.completeProgram(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        active.program.id,
        { expectedVersion: active.program.version },
      ),
    ).rejects.toMatchObject({ code: 'WORKOUT_IN_PROGRESS_BLOCKS_PROGRAM_TRANSITION' });
    const next = await draftProgram(container, seed, 'Replacement Lift');
    await expect(
      container.training.activateProgram(
        seed.trainerCtx,
        seed.workspaceId,
        seed.relationshipId,
        next.program.id,
        { expectedVersion: next.program.version },
      ),
    ).rejects.toMatchObject({ code: 'WORKOUT_IN_PROGRESS_BLOCKS_PROGRAM_TRANSITION' });
    const relationship = await db
      .collection('coaching_relationships')
      .findOne({ _id: seed.relationshipObjectId });
    await container.trainees.endRelationship(seed.ownerCtx, seed.workspaceId, seed.relationshipId, {
      expectedVersion: relationship?.version ?? seed.relationshipVersion,
      reason: 'done',
    });
    expect(
      (await db.collection('workout_sessions').findOne({ _id: new ObjectId(live.id) }))?.status,
    ).toBe('ABANDONED');
    expect(
      (await db.collection('programs').findOne({ _id: new ObjectId(active.program.id) }))?.status,
    ).toBe('COMPLETED');
    expect(
      (await db.collection('coaching_relationships').findOne({ _id: seed.relationshipObjectId }))
        ?.status,
    ).toBe('ENDED');
  });

  test('authorization keeps trainer relationship scope, assistant create-only, manager read-only, nutritionist denied, and trainee self narrow', async () => {
    const seed = await seedGym(container);
    const other = await seedRelationshipWithPrimary(container, seed);
    await activeProgram(container, seed, 'Auth A');
    await activeProgramFor(container, seed, other.relationshipId, other.trainer.ctx, 'Auth B');
    await expect(
      container.workouts.start(seed.trainerCtx, seed.workspaceId, other.relationshipId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const assistantStart = await container.workouts.start(
      seed.assistantCtx,
      seed.workspaceId,
      seed.relationshipId,
    );
    await expect(
      container.workouts.patch(
        seed.assistantCtx,
        seed.workspaceId,
        seed.relationshipId,
        assistantStart.workout.id,
        { expectedVersion: assistantStart.workout.version, exercises: [] },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      container.workouts.complete(
        seed.assistantCtx,
        seed.workspaceId,
        seed.relationshipId,
        assistantStart.workout.id,
        { expectedVersion: assistantStart.workout.version },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(
      (await container.workouts.current(seed.managerCtx, seed.workspaceId, seed.relationshipId))
        .workout?.id,
    ).toBe(assistantStart.workout.id);
    await expect(
      container.workouts.start(seed.managerCtx, seed.workspaceId, seed.relationshipId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const nutritionist = await seedNutritionist(container, seed);
    await expect(
      container.workouts.current(nutritionist.ctx, seed.workspaceId, seed.relationshipId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      container.workouts.current(other.traineeCtx, seed.workspaceId, seed.relationshipId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(
      (await container.workouts.current(seed.traineeCtx, seed.workspaceId, seed.relationshipId))
        .workout?.id,
    ).toBe(assistantStart.workout.id);
  });

  test('commercial freeze and training downgrade block writes while preserving reads', async () => {
    const seed = await seedGym(container);
    await activeProgram(container, seed, 'Commercial Lift');
    const live = await container.workouts.start(
      seed.traineeCtx,
      seed.workspaceId,
      seed.relationshipId,
    );
    await db
      .collection('subscriptions')
      .updateOne({ workspaceId: seed.workspaceObjectId }, { $set: { lifecycleStatus: 'FROZEN' } });
    expect(
      (await container.workouts.current(seed.traineeCtx, seed.workspaceId, seed.relationshipId))
        .workout?.id,
    ).toBe(live.workout.id);
    await expect(
      container.workouts.abandon(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        live.workout.id,
        { expectedVersion: live.workout.version },
      ),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_FROZEN' });
    await db
      .collection('subscriptions')
      .updateOne({ workspaceId: seed.workspaceObjectId }, { $set: { lifecycleStatus: 'ACTIVE' } });
    await db
      .collection('subscription_terms')
      .updateOne({ workspaceId: seed.workspaceObjectId }, { $set: { enabledFeatures: [] } });
    expect(
      (await container.workouts.current(seed.traineeCtx, seed.workspaceId, seed.relationshipId))
        .workout?.id,
    ).toBe(live.workout.id);
    await expect(
      container.workouts.abandon(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        live.workout.id,
        { expectedVersion: live.workout.version },
      ),
    ).rejects.toMatchObject({ code: 'FEATURE_NOT_AVAILABLE' });
  });

  test('completion rolls back workout, progress, PRs, outbox, audit, and idempotency completion failures', async () => {
    for (const failure of [
      'program_progress_events',
      'personal_records',
      'audit_events',
      'outbox_events',
      'idempotency_records',
    ]) {
      const seed = await seedGym(container);
      const active = await activeProgram(container, seed, `Rollback ${failure}`);
      const started = (
        await runStart(container, seed, `rollback-start-${failure}-${new ObjectId().toHexString()}`)
      ).result.body.workout;
      const workoutExerciseKey = firstExercise(started).workoutExerciseKey;
      const setKey = firstSet(started).setKey;
      const patched = await container.workouts.patch(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        started.id,
        {
          expectedVersion: started.version,
          exercises: [
            { workoutExerciseKey, sets: [{ setKey, weight: 100, reps: 3, completed: true }] },
          ],
        },
      );
      await installFailureValidator(db, failure);
      try {
        await expect(
          runComplete(
            container,
            seed,
            started.id,
            patched.workout.version,
            `rollback-complete-${failure}-${new ObjectId().toHexString()}`,
          ),
        ).rejects.toThrow();
      } finally {
        await clearFailureValidator(db, failure);
      }
      expect(
        (await db.collection('workout_sessions').findOne({ _id: new ObjectId(started.id) }))
          ?.status,
      ).toBe('IN_PROGRESS');
      expect(
        (
          await db
            .collection('program_progress')
            .findOne({ programId: new ObjectId(active.program.id) })
        )?.completedDayCount,
      ).toBe(0);
      expect(
        await db
          .collection('personal_records')
          .countDocuments({ relationshipId: seed.relationshipObjectId }),
      ).toBe(0);
      expect(
        await db.collection('outbox_events').countDocuments({
          aggregateId: new ObjectId(started.id),
          eventType: 'WorkoutCompleted',
        }),
      ).toBe(0);
    }
  });

  test('routes expose Stage 9 endpoints and no sync endpoint', async () => {
    const seed = await seedGym(container);
    await activeProgram(container, seed, 'Route Lift');
    const app = await buildApp(container);
    const missingKey = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${seed.workspaceId}/relationships/${seed.relationshipId}/workouts/start`,
      headers: authHeaders(seed.traineeCtx),
    });
    expect(missingKey.statusCode).toBe(401);
    const sync = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${seed.workspaceId}/relationships/${seed.relationshipId}/workouts/sync`,
      headers: authHeaders(seed.traineeCtx),
    });
    expect(sync.statusCode).toBe(404);
    await app.close();
  });
});

async function activeProgram(container: AppContainer, seed: Seed, name: string, sequences = [1]) {
  return await activeProgramFor(
    container,
    seed,
    seed.relationshipId,
    seed.trainerCtx,
    name,
    sequences,
  );
}

async function activeProgramFor(
  container: AppContainer,
  seed: Seed,
  relationshipId: string,
  actorCtx: ReturnType<typeof ctx>,
  name: string,
  sequences = [1],
) {
  const draft = await draftProgram(
    container,
    { ...seed, relationshipId, trainerCtx: actorCtx },
    name,
    sequences,
  );
  return await container.training.activateProgram(
    actorCtx,
    seed.workspaceId,
    relationshipId,
    draft.program.id,
    { expectedVersion: draft.program.version },
  );
}

async function draftProgram(
  container: AppContainer,
  seed: Pick<Seed, 'workspaceId' | 'relationshipId' | 'trainerCtx'>,
  name: string,
  sequences = [1],
) {
  const exercise = await container.training.createExercise(seed.trainerCtx, seed.workspaceId, {
    scope: 'GYM',
    names: { en: `${name}-${new ObjectId().toHexString()}` },
    exerciseType: 'RESISTANCE',
  });
  const days: Array<ReturnType<typeof day> | ReturnType<typeof restDay>> = sequences.map(
    (sequence) => day(exercise.exercise.id, sequence, `Day ${sequence}`),
  );
  if (sequences.length > 1) days.push(restDay(2));
  return await container.training.createProgram(
    seed.trainerCtx,
    seed.workspaceId,
    seed.relationshipId,
    {
      source: { type: 'SCRATCH' },
      name,
      days,
    },
  );
}

async function completeWithSet(
  container: AppContainer,
  seed: Seed,
  weight: number,
  reps: number,
  key: string,
) {
  const started = (await runStart(container, seed, `${key}-start`)).result.body.workout;
  const workoutExerciseKey = firstExercise(started).workoutExerciseKey;
  const setKey = firstSet(started).setKey;
  const patched = await container.workouts.patch(
    seed.traineeCtx,
    seed.workspaceId,
    seed.relationshipId,
    started.id,
    {
      expectedVersion: started.version,
      exercises: [
        { workoutExerciseKey, sets: [{ setKey, weight, reps, completed: weight > 0 && reps > 0 }] },
      ],
    },
  );
  const completed = (
    await runComplete(container, seed, started.id, patched.workout.version, `${key}-complete`)
  ).result.body;
  return { workout: started, completed };
}

async function runStart(container: AppContainer, seed: Seed, key: string) {
  return {
    key,
    result: await container.idempotency.runInTransaction(seed.traineeCtx, {
      routeKey: 'POST /workspaces/:workspaceId/relationships/:relationshipId/workouts/start',
      key,
      fingerprint: {
        params: { workspaceId: seed.workspaceId, relationshipId: seed.relationshipId },
        body: {},
      },
      unitOfWork: container.unitOfWork,
      operation: async (tx) => ({
        body: await container.workouts.start(
          seed.traineeCtx,
          seed.workspaceId,
          seed.relationshipId,
          tx,
        ),
      }),
    }),
  };
}

async function runComplete(
  container: AppContainer,
  seed: Seed,
  workoutId: string,
  expectedVersion: number,
  key: string,
) {
  return {
    key,
    result: await container.idempotency.runInTransaction(seed.traineeCtx, {
      routeKey:
        'POST /workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/complete',
      key,
      fingerprint: {
        params: { workspaceId: seed.workspaceId, relationshipId: seed.relationshipId, workoutId },
        body: { expectedVersion },
      },
      unitOfWork: container.unitOfWork,
      operation: async (tx) => ({
        body: await container.workouts.complete(
          seed.traineeCtx,
          seed.workspaceId,
          seed.relationshipId,
          workoutId,
          { expectedVersion },
          tx,
        ),
      }),
    }),
  };
}

async function runAbandon(
  container: AppContainer,
  seed: Seed,
  workoutId: string,
  expectedVersion: number,
  key: string,
) {
  return {
    key,
    result: await container.idempotency.runInTransaction(seed.traineeCtx, {
      routeKey:
        'POST /workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/abandon',
      key,
      fingerprint: {
        params: { workspaceId: seed.workspaceId, relationshipId: seed.relationshipId, workoutId },
        body: { expectedVersion },
      },
      unitOfWork: container.unitOfWork,
      operation: async (tx) => ({
        body: await container.workouts.abandon(
          seed.traineeCtx,
          seed.workspaceId,
          seed.relationshipId,
          workoutId,
          { expectedVersion },
          tx,
        ),
      }),
    }),
  };
}

async function runProgress(
  container: AppContainer,
  seed: Seed,
  programId: string,
  expectedVersion: number,
  kind: 'SKIPPED' | 'DEFERRED',
  key: string,
) {
  return {
    key,
    result: await container.idempotency.runInTransaction(seed.traineeCtx, {
      routeKey: `POST /workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/progress/${kind === 'SKIPPED' ? 'skip' : 'defer'}`,
      key,
      fingerprint: {
        params: { workspaceId: seed.workspaceId, relationshipId: seed.relationshipId, programId },
        body: { expectedVersion },
      },
      unitOfWork: container.unitOfWork,
      operation: async (tx) => ({
        body: await container.workouts.skipOrDefer(
          seed.traineeCtx,
          seed.workspaceId,
          seed.relationshipId,
          programId,
          { expectedVersion },
          kind,
          tx,
        ),
      }),
    }),
  };
}

async function runStaffCorrection(
  container: AppContainer,
  seed: Seed,
  workoutId: string,
  expectedVersion: number,
  workoutExerciseKey: string,
  setKey: string,
  weight: number,
  reps: number,
  key: string,
) {
  return {
    result: await container.idempotency.runInTransaction(seed.trainerCtx, {
      routeKey:
        'POST /workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/corrections',
      key,
      fingerprint: {
        params: { workspaceId: seed.workspaceId, relationshipId: seed.relationshipId, workoutId },
        body: { expectedVersion, weight, reps },
      },
      unitOfWork: container.unitOfWork,
      operation: async (tx) => ({
        body: await container.workouts.staffCorrection(
          seed.trainerCtx,
          seed.workspaceId,
          seed.relationshipId,
          workoutId,
          {
            expectedVersion,
            reason: 'coach correction',
            exercises: [
              {
                workoutExerciseKey,
                sets: [{ setKey, weight, reps, completed: weight > 0 && reps > 0 }],
              },
            ],
          },
          tx,
        ),
      }),
    }),
  };
}

async function seedGym(container: AppContainer) {
  const db = container.database.db;
  const owner = await seedUser(db, `owner-${new ObjectId().toHexString()}@example.com`);
  const trainer = await seedUser(db, `trainer-${new ObjectId().toHexString()}@example.com`);
  const trainee = await seedUser(db, `trainee-${new ObjectId().toHexString()}@example.com`);
  const assistant = await seedUser(db, `assistant-${new ObjectId().toHexString()}@example.com`);
  const manager = await seedUser(db, `manager-${new ObjectId().toHexString()}@example.com`);
  const workspace = await container.workspaceRepo.create({
    type: 'GYM',
    name: 'Stage 9 Gym',
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
  const managerMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: manager._id,
    roles: ['GYM_MANAGER'],
  });
  for (const [membership, role] of [
    [ownerMembership, 'GYM_OWNER'],
    [trainerMembership, 'TRAINER'],
    [traineeMembership, 'TRAINEE'],
    [assistantMembership, 'ASSISTANT_TRAINER'],
    [managerMembership, 'GYM_MANAGER'],
  ] as const)
    await assignSystemProfile(container, workspace._id, membership._id, role);
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
    relationshipId: active._id.toHexString(),
    relationshipObjectId: active._id,
    relationshipVersion: active.version,
    trainerCtx: ctx(trainer._id, trainerMembership._id),
    traineeCtx: ctx(trainee._id, traineeMembership._id),
    assistantCtx: ctx(assistant._id, assistantMembership._id),
    managerCtx: ctx(manager._id, managerMembership._id),
    ownerCtx: ctx(owner._id, ownerMembership._id),
  };
}

type Seed = Awaited<ReturnType<typeof seedGym>>;

async function seedRelationshipWithPrimary(container: AppContainer, seed: Seed) {
  const trainer = await seedUser(
    container.database.db,
    `other-trainer-${new ObjectId().toHexString()}@example.com`,
  );
  const trainee = await seedUser(
    container.database.db,
    `other-trainee-${new ObjectId().toHexString()}@example.com`,
  );
  const trainerMembership = await container.workspaceMemberships.createActive({
    workspaceId: seed.workspaceObjectId,
    userId: trainer._id,
    roles: ['TRAINER'],
  });
  const traineeMembership = await container.workspaceMemberships.createActive({
    workspaceId: seed.workspaceObjectId,
    userId: trainee._id,
    roles: ['TRAINEE'],
  });
  await assignSystemProfile(container, seed.workspaceObjectId, trainerMembership._id, 'TRAINER');
  await assignSystemProfile(container, seed.workspaceObjectId, traineeMembership._id, 'TRAINEE');
  await container.membershipBranchAssignments.createActive(
    seed.workspaceObjectId,
    trainerMembership._id,
    new ObjectId(seed.branchId),
  );
  const relationship = await container.coachingRelationships.createActive({
    workspaceId: seed.workspaceObjectId,
    traineeUserId: trainee._id,
    traineeMembershipId: traineeMembership._id,
    homeBranchId: new ObjectId(seed.branchId),
    activatedBy: new ObjectId(seed.ownerCtx.userId),
  });
  const primary = await container.coachingRelationships.createAssignment({
    workspaceId: seed.workspaceObjectId,
    relationshipId: relationship._id,
    staffMembershipId: trainerMembership._id,
    assignmentType: 'PRIMARY_TRAINER',
    assignedBy: new ObjectId(seed.ownerCtx.userId),
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
    trainer: { ctx: ctx(trainer._id, trainerMembership._id) },
    traineeCtx: ctx(trainee._id, traineeMembership._id),
  };
}

async function seedNutritionist(container: AppContainer, seed: Seed) {
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
  return { ctx: ctx(user._id, membership._id) };
}

async function activeGymExercise(container: AppContainer, seed: Seed, name: string) {
  return await container.training.createExercise(seed.trainerCtx, seed.workspaceId, {
    scope: 'GYM',
    names: { en: `${name}-${new ObjectId().toHexString()}` },
    exerciseType: 'RESISTANCE',
  });
}

function day(exerciseId: string, sequence = 1, name = 'Day', targetSets = 1) {
  return {
    sequence,
    name,
    type: 'RESISTANCE' as const,
    exercises: [
      { exerciseId, order: 1, setStructure: 'NORMAL', targetSets, repRange: { min: 5, max: 8 } },
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
  if (!membership) throw new Error('membership missing');
  await container.workspaceMemberships.updateRoleAndProfileContributions(
    workspaceId,
    membershipId,
    membership.accessVersion ?? 0,
    {
      roles: membership.roles,
      permissionProfileIds: [profile._id],
    },
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
    lastName: 'Nine',
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

function authHeaders(context: ReturnType<typeof ctx>) {
  return {
    'x-test-user-id': context.userId,
    'x-test-workspace-membership-id': context.workspaceMembershipId ?? '',
  };
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

async function installFailureValidator(db: Db, collection: string) {
  const validator =
    collection === 'idempotency_records'
      ? {
          $jsonSchema: {
            bsonType: 'object',
            properties: { state: { enum: ['PROCESSING', 'FAILED'] } },
          },
        }
      : { $jsonSchema: { bsonType: 'object', required: ['__blocked_by_test__'] } };
  await db.command({ collMod: collection, validator, validationAction: 'error' });
}

async function clearFailureValidator(db: Db, collection: string) {
  await db.command({ collMod: collection, validator: {} });
}

function firstExercise<T extends { exercises: unknown[] }>(workout: T) {
  const exercise = workout.exercises[0];
  if (!exercise || typeof exercise !== 'object') throw new Error('expected workout exercise');
  return exercise as {
    workoutExerciseKey: string;
    exerciseId: string;
    exerciseNameSnapshot: string;
    sets: Array<{ setKey: string }>;
  };
}

function firstSet(workout: { exercises: unknown[] }) {
  const set = firstExercise(workout).sets[0];
  if (!set) throw new Error('expected workout set');
  return set;
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
