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
  }, 15_000);

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
  }, 120_000);
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
  }, 15_000);

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

  test('start races with program replacement and manual completion without crossing lifecycle states', async () => {
    const replacementSeed = await seedGym(container);
    const programA = await activeProgram(container, replacementSeed, 'Replace Race A');
    const programB = await draftProgram(container, replacementSeed, 'Replace Race B');
    const replacementRace = await Promise.allSettled([
      runStart(container, replacementSeed, `replace-race-start-${new ObjectId().toHexString()}`),
      container.training.activateProgram(
        replacementSeed.trainerCtx,
        replacementSeed.workspaceId,
        replacementSeed.relationshipId,
        programB.program.id,
        { expectedVersion: programB.program.version },
      ),
    ]);
    const replacementWorkout = await db.collection('workout_sessions').findOne({
      relationshipId: replacementSeed.relationshipObjectId,
      status: 'IN_PROGRESS',
    });
    const replacementA = await db
      .collection('programs')
      .findOne({ _id: new ObjectId(programA.program.id) });
    const replacementB = await db
      .collection('programs')
      .findOne({ _id: new ObjectId(programB.program.id) });
    if (replacementWorkout) {
      if (replacementWorkout.programId.equals(new ObjectId(programA.program.id))) {
        expect(replacementA?.status).toBe('ACTIVE');
        expect(replacementB?.status).toBe('DRAFT');
        expect(rejectedCodes(replacementRace)).toContain(
          'WORKOUT_IN_PROGRESS_BLOCKS_PROGRAM_TRANSITION',
        );
      } else {
        expect(replacementWorkout.programId.equals(new ObjectId(programB.program.id))).toBe(true);
        expect(replacementA?.status).toBe('REPLACED');
        expect(replacementB?.status).toBe('ACTIVE');
      }
    } else {
      expect(replacementA?.status).toBe('REPLACED');
      expect(replacementB?.status).toBe('ACTIVE');
      expect(rejectedCodes(replacementRace)).toContain('ACTIVE_PROGRAM_NOT_FOUND');
    }

    const completionSeed = await seedGym(container);
    const program = await activeProgram(container, completionSeed, 'Complete Race');
    const completeRace = await Promise.allSettled([
      runStart(
        container,
        completionSeed,
        `program-complete-race-start-${new ObjectId().toHexString()}`,
      ),
      container.training.completeProgram(
        completionSeed.trainerCtx,
        completionSeed.workspaceId,
        completionSeed.relationshipId,
        program.program.id,
        { expectedVersion: program.program.version },
      ),
    ]);
    const raceWorkout = await db.collection('workout_sessions').findOne({
      relationshipId: completionSeed.relationshipObjectId,
      status: 'IN_PROGRESS',
    });
    const raceProgram = await db
      .collection('programs')
      .findOne({ _id: new ObjectId(program.program.id) });
    if (raceWorkout) {
      expect(raceProgram?.status).toBe('ACTIVE');
      expect(rejectedCodes(completeRace)).toContain(
        'WORKOUT_IN_PROGRESS_BLOCKS_PROGRAM_TRANSITION',
      );
    } else {
      expect(raceProgram?.status).toBe('COMPLETED');
      expect(rejectedCodes(completeRace)).toContain('ACTIVE_PROGRAM_NOT_FOUND');
    }
  });

  test('start, patch, and complete race relationship END without leaving live workouts behind', async () => {
    const startSeed = await seedGym(container);
    const startProgram = await activeProgram(container, startSeed, 'End Race Start');
    const startRelationship = await db
      .collection('coaching_relationships')
      .findOne({ _id: startSeed.relationshipObjectId });
    await Promise.allSettled([
      runStart(container, startSeed, `end-race-start-${new ObjectId().toHexString()}`),
      container.trainees.endRelationship(
        startSeed.ownerCtx,
        startSeed.workspaceId,
        startSeed.relationshipId,
        {
          expectedVersion: startRelationship?.version ?? startSeed.relationshipVersion,
          reason: 'race',
        },
      ),
    ]);
    expect(
      (
        await db
          .collection('coaching_relationships')
          .findOne({ _id: startSeed.relationshipObjectId })
      )?.status,
    ).toBe('ENDED');
    expect(
      await db
        .collection('workout_sessions')
        .countDocuments({ relationshipId: startSeed.relationshipObjectId, status: 'IN_PROGRESS' }),
    ).toBe(0);
    expect(
      (await db.collection('programs').findOne({ _id: new ObjectId(startProgram.program.id) }))
        ?.status,
    ).toBe('COMPLETED');

    const patchSeed = await seedGym(container);
    await activeProgram(container, patchSeed, 'End Race Patch');
    const live = (
      await runStart(container, patchSeed, `patch-end-start-${new ObjectId().toHexString()}`)
    ).result.body.workout;
    const setKey = firstSet(live).setKey;
    const workoutExerciseKey = firstExercise(live).workoutExerciseKey;
    const patchRelationship = await db
      .collection('coaching_relationships')
      .findOne({ _id: patchSeed.relationshipObjectId });
    await Promise.allSettled([
      container.workouts.patch(
        patchSeed.traineeCtx,
        patchSeed.workspaceId,
        patchSeed.relationshipId,
        live.id,
        {
          expectedVersion: live.version,
          exercises: [
            { workoutExerciseKey, sets: [{ setKey, weight: 20, reps: 5, completed: true }] },
          ],
        },
      ),
      container.trainees.endRelationship(
        patchSeed.ownerCtx,
        patchSeed.workspaceId,
        patchSeed.relationshipId,
        {
          expectedVersion: patchRelationship?.version ?? patchSeed.relationshipVersion,
          reason: 'race',
        },
      ),
    ]);
    expect(
      (await db.collection('workout_sessions').findOne({ _id: new ObjectId(live.id) }))?.status,
    ).toBe('ABANDONED');
    let stalePatchCode: string | undefined;
    try {
      await container.workouts.patch(
        patchSeed.traineeCtx,
        patchSeed.workspaceId,
        patchSeed.relationshipId,
        live.id,
        {
          expectedVersion: live.version,
          exercises: [
            { workoutExerciseKey, sets: [{ setKey, weight: 25, reps: 5, completed: true }] },
          ],
        },
      );
    } catch (error) {
      stalePatchCode = (error as { code?: string }).code;
    }
    expect(['WORKOUT_ABANDONED', 'PERMISSION_DENIED', 'WORKSPACE_MEMBERSHIP_REQUIRED']).toContain(
      stalePatchCode ?? '',
    );

    const completeSeed = await seedGym(container);
    const completeProgram = await activeProgram(container, completeSeed, 'End Race Complete');
    const completeStarted = (
      await runStart(container, completeSeed, `complete-end-start-${new ObjectId().toHexString()}`)
    ).result.body.workout;
    const completePatched = await patchFirstSet(container, completeSeed, completeStarted, 70, 4);
    const completeRelationship = await db
      .collection('coaching_relationships')
      .findOne({ _id: completeSeed.relationshipObjectId });
    await Promise.allSettled([
      runComplete(
        container,
        completeSeed,
        completeStarted.id,
        completePatched.workout.version,
        `complete-end-race-${new ObjectId().toHexString()}`,
      ),
      container.trainees.endRelationship(
        completeSeed.ownerCtx,
        completeSeed.workspaceId,
        completeSeed.relationshipId,
        {
          expectedVersion: completeRelationship?.version ?? completeSeed.relationshipVersion,
          reason: 'race',
        },
      ),
    ]);
    expect(
      (
        await db
          .collection('coaching_relationships')
          .findOne({ _id: completeSeed.relationshipObjectId })
      )?.status,
    ).toBe('ENDED');
    const finalWorkout = await db
      .collection('workout_sessions')
      .findOne({ _id: new ObjectId(completeStarted.id) });
    expect(['COMPLETED', 'ABANDONED']).toContain(finalWorkout?.status);
    expect(
      await db.collection('workout_sessions').countDocuments({
        relationshipId: completeSeed.relationshipObjectId,
        status: 'IN_PROGRESS',
      }),
    ).toBe(0);
    expect(
      (await db.collection('programs').findOne({ _id: new ObjectId(completeProgram.program.id) }))
        ?.status,
    ).toBe('COMPLETED');
    const progressAfter = await db
      .collection('program_progress')
      .findOne({ programId: new ObjectId(completeProgram.program.id) });
    expect(progressAfter?.completedDayCount).toBe(finalWorkout?.status === 'COMPLETED' ? 1 : 0);
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

  test('workout, lifecycle, and progress commands use CAS under concurrent stale mutations', async () => {
    const patchSeed = await seedGym(container);
    await activeProgram(container, patchSeed, 'Patch Race');
    const live = (
      await runStart(container, patchSeed, `patch-race-start-${new ObjectId().toHexString()}`)
    ).result.body.workout;
    const patchA = patchFirstSet(container, patchSeed, live, 40, 5);
    const patchB = patchFirstSet(container, patchSeed, live, 45, 5);
    const patchRace = await Promise.allSettled([patchA, patchB]);
    expect(patchRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejectedCodes(patchRace)).toContain('WORKOUT_VERSION_CONFLICT');

    const patchCompleteSeed = await seedGym(container);
    await activeProgram(container, patchCompleteSeed, 'Patch Complete Race');
    const started = (
      await runStart(
        container,
        patchCompleteSeed,
        `patch-complete-start-${new ObjectId().toHexString()}`,
      )
    ).result.body.workout;
    const completeRace = await Promise.allSettled([
      patchFirstSet(container, patchCompleteSeed, started, 55, 5),
      runComplete(
        container,
        patchCompleteSeed,
        started.id,
        started.version,
        `patch-complete-${new ObjectId().toHexString()}`,
      ),
    ]);
    expect(completeRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const afterPatchComplete = await db
      .collection('workout_sessions')
      .findOne({ _id: new ObjectId(started.id) });
    if (afterPatchComplete?.status === 'COMPLETED') {
      await expect(
        patchFirstSet(container, patchCompleteSeed, started, 60, 6),
      ).rejects.toMatchObject({ code: 'WORKOUT_VERSION_CONFLICT' });
    } else {
      expect(afterPatchComplete?.status).toBe('IN_PROGRESS');
      expect(rejectedCodes(completeRace)).toContain('WORKOUT_NOT_IN_PROGRESS');
    }

    const completeAbandonSeed = await seedGym(container);
    const completeAbandonProgram = await activeProgram(
      container,
      completeAbandonSeed,
      'Complete Abandon Race',
    );
    const completeAbandonStarted = (
      await runStart(
        container,
        completeAbandonSeed,
        `complete-abandon-start-${new ObjectId().toHexString()}`,
      )
    ).result.body.workout;
    const completeAbandonPatched = await patchFirstSet(
      container,
      completeAbandonSeed,
      completeAbandonStarted,
      75,
      3,
    );
    const completeAbandonRace = await Promise.allSettled([
      runComplete(
        container,
        completeAbandonSeed,
        completeAbandonStarted.id,
        completeAbandonPatched.workout.version,
        `complete-abandon-complete-${new ObjectId().toHexString()}`,
      ),
      runAbandon(
        container,
        completeAbandonSeed,
        completeAbandonStarted.id,
        completeAbandonPatched.workout.version,
        `complete-abandon-abandon-${new ObjectId().toHexString()}`,
      ),
    ]);
    expect(completeAbandonRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const finalLifecycle = await db
      .collection('workout_sessions')
      .findOne({ _id: new ObjectId(completeAbandonStarted.id) });
    expect(['COMPLETED', 'ABANDONED']).toContain(finalLifecycle?.status);
    const lifecycleProgress = await db
      .collection('program_progress')
      .findOne({ programId: new ObjectId(completeAbandonProgram.program.id) });
    expect(lifecycleProgress?.completedDayCount).toBe(
      finalLifecycle?.status === 'COMPLETED' ? 1 : 0,
    );
    expect(
      await db
        .collection('personal_records')
        .countDocuments({ relationshipId: completeAbandonSeed.relationshipObjectId }),
    ).toBe(finalLifecycle?.status === 'COMPLETED' ? 3 : 0);

    const concurrentCompleteSeed = await seedGym(container);
    const concurrentCompleteProgram = await activeProgram(
      container,
      concurrentCompleteSeed,
      'Concurrent Complete Race',
    );
    const concurrentCompleteStarted = (
      await runStart(
        container,
        concurrentCompleteSeed,
        `concurrent-complete-start-${new ObjectId().toHexString()}`,
      )
    ).result.body.workout;
    const concurrentCompletePatched = await patchFirstSet(
      container,
      concurrentCompleteSeed,
      concurrentCompleteStarted,
      82,
      3,
    );
    const concurrentCompleteRace = await Promise.allSettled([
      runComplete(
        container,
        concurrentCompleteSeed,
        concurrentCompleteStarted.id,
        concurrentCompletePatched.workout.version,
        `concurrent-complete-a-${new ObjectId().toHexString()}`,
      ),
      runComplete(
        container,
        concurrentCompleteSeed,
        concurrentCompleteStarted.id,
        concurrentCompletePatched.workout.version,
        `concurrent-complete-b-${new ObjectId().toHexString()}`,
      ),
    ]);
    expect(concurrentCompleteRace.filter((result) => result.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(rejectedCodes(concurrentCompleteRace)).toContain('WORKOUT_ALREADY_COMPLETED');
    expect(
      (
        await db
          .collection('program_progress')
          .findOne({ programId: new ObjectId(concurrentCompleteProgram.program.id) })
      )?.completedDayCount,
    ).toBe(1);
    expect(
      await db.collection('program_progress_events').countDocuments({
        workoutSessionId: new ObjectId(concurrentCompleteStarted.id),
        type: 'COMPLETED',
      }),
    ).toBe(1);

    const twoCompleteSeed = await seedGym(container);
    const twoCompleteProgram = await activeProgram(container, twoCompleteSeed, 'Two Complete Race');
    const twoCompleteStarted = (
      await runStart(
        container,
        twoCompleteSeed,
        `two-complete-start-${new ObjectId().toHexString()}`,
      )
    ).result.body.workout;
    const twoCompletePatched = await patchFirstSet(
      container,
      twoCompleteSeed,
      twoCompleteStarted,
      88,
      2,
    );
    const completeKey = `same-complete-${new ObjectId().toHexString()}`;
    const sameKeyReplay = await runComplete(
      container,
      twoCompleteSeed,
      twoCompleteStarted.id,
      twoCompletePatched.workout.version,
      completeKey,
    );
    expect(
      (
        await runComplete(
          container,
          twoCompleteSeed,
          twoCompleteStarted.id,
          twoCompletePatched.workout.version,
          completeKey,
        )
      ).result.replayed,
    ).toBe(true);
    await expect(
      runComplete(
        container,
        twoCompleteSeed,
        twoCompleteStarted.id,
        twoCompletePatched.workout.version,
        `different-complete-${new ObjectId().toHexString()}`,
      ),
    ).rejects.toMatchObject({ code: 'WORKOUT_ALREADY_COMPLETED' });
    expect(sameKeyReplay.result.body.workout.status).toBe('COMPLETED');
    expect(
      (
        await db
          .collection('program_progress')
          .findOne({ programId: new ObjectId(twoCompleteProgram.program.id) })
      )?.completedDayCount,
    ).toBe(1);
    expect(
      await db.collection('program_progress_events').countDocuments({
        workoutSessionId: new ObjectId(twoCompleteStarted.id),
        type: 'COMPLETED',
      }),
    ).toBe(1);
    expect(
      await db.collection('outbox_events').countDocuments({
        aggregateId: new ObjectId(twoCompleteStarted.id),
        eventType: 'WorkoutCompleted',
      }),
    ).toBe(1);

    const progressSeed = await seedGym(container);
    const progressProgram = await activeProgram(container, progressSeed, 'Progress Race', [1, 3]);
    const progress = await container.training.getProgress(
      progressSeed.traineeCtx,
      progressSeed.workspaceId,
      progressSeed.relationshipId,
      progressProgram.program.id,
    );
    const skipDeferRace = await Promise.allSettled([
      runProgress(
        container,
        progressSeed,
        progressProgram.program.id,
        progress.progress.version,
        'SKIPPED',
        `skip-defer-skip-${new ObjectId().toHexString()}`,
      ),
      runProgress(
        container,
        progressSeed,
        progressProgram.program.id,
        progress.progress.version,
        'DEFERRED',
        `skip-defer-defer-${new ObjectId().toHexString()}`,
      ),
    ]);
    expect(skipDeferRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejectedCodes(skipDeferRace)).toContain('PROGRAM_PROGRESS_CONFLICT');
    expect(
      await db
        .collection('program_progress_events')
        .countDocuments({ programId: new ObjectId(progressProgram.program.id) }),
    ).toBe(2);

    const twoSkipSeed = await seedGym(container);
    const twoSkipProgram = await activeProgram(container, twoSkipSeed, 'Two Skip Race', [1, 3]);
    const twoSkipProgress = await container.training.getProgress(
      twoSkipSeed.traineeCtx,
      twoSkipSeed.workspaceId,
      twoSkipSeed.relationshipId,
      twoSkipProgram.program.id,
    );
    const twoSkipRace = await Promise.allSettled([
      runProgress(
        container,
        twoSkipSeed,
        twoSkipProgram.program.id,
        twoSkipProgress.progress.version,
        'SKIPPED',
        `two-skip-a-${new ObjectId().toHexString()}`,
      ),
      runProgress(
        container,
        twoSkipSeed,
        twoSkipProgram.program.id,
        twoSkipProgress.progress.version,
        'SKIPPED',
        `two-skip-b-${new ObjectId().toHexString()}`,
      ),
    ]);
    expect(twoSkipRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (
        await db
          .collection('program_progress')
          .findOne({ programId: new ObjectId(twoSkipProgram.program.id) })
      )?.skippedDayCount,
    ).toBe(1);

    const twoDeferSeed = await seedGym(container);
    const twoDeferProgram = await activeProgram(container, twoDeferSeed, 'Two Defer Race');
    const twoDeferProgress = await container.training.getProgress(
      twoDeferSeed.traineeCtx,
      twoDeferSeed.workspaceId,
      twoDeferSeed.relationshipId,
      twoDeferProgram.program.id,
    );
    const deferKey = `same-defer-${new ObjectId().toHexString()}`;
    expect(
      (
        await runProgress(
          container,
          twoDeferSeed,
          twoDeferProgram.program.id,
          twoDeferProgress.progress.version,
          'DEFERRED',
          deferKey,
        )
      ).result.replayed,
    ).toBe(false);
    expect(
      (
        await runProgress(
          container,
          twoDeferSeed,
          twoDeferProgram.program.id,
          twoDeferProgress.progress.version,
          'DEFERRED',
          deferKey,
        )
      ).result.replayed,
    ).toBe(true);
    await expect(
      runProgress(
        container,
        twoDeferSeed,
        twoDeferProgram.program.id,
        twoDeferProgress.progress.version,
        'DEFERRED',
        `stale-defer-${new ObjectId().toHexString()}`,
      ),
    ).rejects.toMatchObject({ code: 'PROGRAM_PROGRESS_CONFLICT' });
    expect(
      await db
        .collection('program_progress_events')
        .countDocuments({ programId: new ObjectId(twoDeferProgram.program.id), type: 'DEFERRED' }),
    ).toBe(1);

    const concurrentDeferSeed = await seedGym(container);
    const concurrentDeferProgram = await activeProgram(
      container,
      concurrentDeferSeed,
      'Concurrent Defer Race',
    );
    const concurrentDeferProgress = await container.training.getProgress(
      concurrentDeferSeed.traineeCtx,
      concurrentDeferSeed.workspaceId,
      concurrentDeferSeed.relationshipId,
      concurrentDeferProgram.program.id,
    );
    const concurrentDeferRace = await Promise.allSettled([
      runProgress(
        container,
        concurrentDeferSeed,
        concurrentDeferProgram.program.id,
        concurrentDeferProgress.progress.version,
        'DEFERRED',
        `concurrent-defer-a-${new ObjectId().toHexString()}`,
      ),
      runProgress(
        container,
        concurrentDeferSeed,
        concurrentDeferProgram.program.id,
        concurrentDeferProgress.progress.version,
        'DEFERRED',
        `concurrent-defer-b-${new ObjectId().toHexString()}`,
      ),
    ]);
    expect(concurrentDeferRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejectedCodes(concurrentDeferRace)).toContain('PROGRAM_PROGRESS_CONFLICT');
    expect(
      await db.collection('program_progress_events').countDocuments({
        programId: new ObjectId(concurrentDeferProgram.program.id),
        type: 'DEFERRED',
      }),
    ).toBe(1);

    for (const kind of ['SKIPPED', 'DEFERRED'] as const) {
      const raceSeed = await seedGym(container);
      const raceProgram = await activeProgram(container, raceSeed, `Start ${kind} Race`, [1, 3]);
      const raceProgress = await container.training.getProgress(
        raceSeed.traineeCtx,
        raceSeed.workspaceId,
        raceSeed.relationshipId,
        raceProgram.program.id,
      );
      await Promise.allSettled([
        runStart(container, raceSeed, `start-${kind}-${new ObjectId().toHexString()}`),
        runProgress(
          container,
          raceSeed,
          raceProgram.program.id,
          raceProgress.progress.version,
          kind,
          `${kind}-start-${new ObjectId().toHexString()}`,
        ),
      ]);
      const finalProgress = await db
        .collection('program_progress')
        .findOne({ programId: new ObjectId(raceProgram.program.id) });
      const liveCount = await db.collection('workout_sessions').countDocuments({
        relationshipId: raceSeed.relationshipObjectId,
        status: 'IN_PROGRESS',
      });
      if (liveCount === 1) {
        const liveWorkout = await db.collection('workout_sessions').findOne({
          relationshipId: raceSeed.relationshipObjectId,
          status: 'IN_PROGRESS',
        });
        expect(liveWorkout?.daySequence).toBe(finalProgress?.currentDaySequence);
      } else if (kind === 'SKIPPED') {
        expect(finalProgress?.skippedDayCount).toBe(1);
        expect(finalProgress?.currentDaySequence).toBe(3);
      } else {
        expect(finalProgress?.skippedDayCount).toBe(0);
        expect(finalProgress?.currentDaySequence).toBe(1);
        expect(finalProgress?.version).toBe(1);
      }
    }

    const completeSkipSeed = await seedGym(container);
    const completeSkipProgram = await activeProgram(
      container,
      completeSkipSeed,
      'Complete Skip Race',
      [1, 3],
    );
    const completeSkipStarted = (
      await runStart(
        container,
        completeSkipSeed,
        `complete-skip-start-${new ObjectId().toHexString()}`,
      )
    ).result.body.workout;
    const completeSkipPatched = await patchFirstSet(
      container,
      completeSkipSeed,
      completeSkipStarted,
      91,
      4,
    );
    const completeSkipRace = await Promise.allSettled([
      runComplete(
        container,
        completeSkipSeed,
        completeSkipStarted.id,
        completeSkipPatched.workout.version,
        `complete-skip-complete-${new ObjectId().toHexString()}`,
      ),
      runProgress(
        container,
        completeSkipSeed,
        completeSkipProgram.program.id,
        0,
        'SKIPPED',
        `complete-skip-skip-${new ObjectId().toHexString()}`,
      ),
    ]);
    expect(completeSkipRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const completeSkipProgress = await db
      .collection('program_progress')
      .findOne({ programId: new ObjectId(completeSkipProgram.program.id) });
    expect(completeSkipProgress?.completedDayCount + completeSkipProgress?.skippedDayCount).toBe(1);
    expect(
      await db.collection('program_progress_events').countDocuments({
        programId: new ObjectId(completeSkipProgram.program.id),
        type: { $in: ['COMPLETED', 'SKIPPED'] },
      }),
    ).toBe(1);

    const abandonReplaySeed = await seedGym(container);
    await activeProgram(container, abandonReplaySeed, 'Abandon Replay');
    const abandonStarted = (
      await runStart(
        container,
        abandonReplaySeed,
        `abandon-replay-start-${new ObjectId().toHexString()}`,
      )
    ).result.body.workout;
    const abandonKey = `abandon-replay-${new ObjectId().toHexString()}`;
    const abandoned = await runAbandon(
      container,
      abandonReplaySeed,
      abandonStarted.id,
      abandonStarted.version,
      abandonKey,
    );
    expect(abandoned.result.body.workout.status).toBe('ABANDONED');
    expect(
      (
        await runAbandon(
          container,
          abandonReplaySeed,
          abandonStarted.id,
          abandonStarted.version,
          abandonKey,
        )
      ).result.replayed,
    ).toBe(true);
    await expect(
      container.idempotency.runInTransaction(abandonReplaySeed.traineeCtx, {
        routeKey:
          'POST /workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/abandon',
        key: abandonKey,
        fingerprint: {
          workspaceId: abandonReplaySeed.workspaceId,
          relationshipId: abandonReplaySeed.relationshipId,
          workoutId: abandonStarted.id,
          expectedVersion: abandonStarted.version + 1,
        },
        unitOfWork: container.unitOfWork,
        operation: async (tx) => ({
          body: await container.workouts.abandon(
            abandonReplaySeed.traineeCtx,
            abandonReplaySeed.workspaceId,
            abandonReplaySeed.relationshipId,
            abandonStarted.id,
            { expectedVersion: abandonStarted.version + 1 },
            tx,
          ),
        }),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  }, 60_000);

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

  test('NEEDS_REASSIGNMENT blocks new starts but does not strand an already live trainee workout', async () => {
    const completeSeed = await seedGym(container);
    const program = await activeProgram(container, completeSeed, 'Needs Complete');
    const live = (
      await runStart(container, completeSeed, `needs-live-${new ObjectId().toHexString()}`)
    ).result.body.workout;
    await container.trainees.removePrimary(
      completeSeed.ownerCtx,
      completeSeed.workspaceId,
      completeSeed.relationshipId,
      { expectedVersion: completeSeed.relationshipVersion, reason: 'trainer unavailable' },
    );
    expect(
      (
        await db
          .collection('coaching_relationships')
          .findOne({ _id: completeSeed.relationshipObjectId })
      )?.status,
    ).toBe('NEEDS_REASSIGNMENT');
    expect(
      (
        await container.workouts.current(
          completeSeed.traineeCtx,
          completeSeed.workspaceId,
          completeSeed.relationshipId,
        )
      ).workout?.id,
    ).toBe(live.id);
    await expect(
      runStart(container, completeSeed, `needs-new-start-${new ObjectId().toHexString()}`),
    ).rejects.toMatchObject({ code: 'RELATIONSHIP_NOT_ACTIVE' });
    const patched = await patchFirstSet(container, completeSeed, live, 66, 6);
    const completed = await runComplete(
      container,
      completeSeed,
      live.id,
      patched.workout.version,
      `needs-complete-${new ObjectId().toHexString()}`,
    );
    expect(completed.result.body.workout.status).toBe('COMPLETED');
    expect(
      (
        await db
          .collection('program_progress')
          .findOne({ programId: new ObjectId(program.program.id) })
      )?.completedDayCount,
    ).toBe(1);

    const abandonSeed = await seedGym(container);
    await activeProgram(container, abandonSeed, 'Needs Abandon');
    const abandonLive = (
      await runStart(container, abandonSeed, `needs-abandon-live-${new ObjectId().toHexString()}`)
    ).result.body.workout;
    await container.trainees.removePrimary(
      abandonSeed.ownerCtx,
      abandonSeed.workspaceId,
      abandonSeed.relationshipId,
      { expectedVersion: abandonSeed.relationshipVersion, reason: 'trainer unavailable' },
    );
    const abandoned = await runAbandon(
      container,
      abandonSeed,
      abandonLive.id,
      abandonLive.version,
      `needs-abandon-${new ObjectId().toHexString()}`,
    );
    expect(abandoned.result.body.workout.status).toBe('ABANDONED');
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

  test('personal records use canonical kg values and corrections achieve adjust or retract projections', async () => {
    const seed = await seedGym(container);
    await activeProgram(container, seed, 'PR Matrix');
    const first = await completeWithSet(
      container,
      seed,
      100,
      1,
      `pr-a-${new ObjectId().toHexString()}`,
    );
    await completeWithSet(container, seed, 90, 10, `pr-b-${new ObjectId().toHexString()}`);
    await completeWithSet(container, seed, 0, 10, `pr-invalid-${new ObjectId().toHexString()}`);
    const exerciseId = new ObjectId(firstExercise(first.workout).exerciseId);
    expect(await recordValue(db, seed, exerciseId, 'MAX_WEIGHT', '')).toBe(100);
    expect(await recordValue(db, seed, exerciseId, 'REP_AT_WEIGHT', '100.00')).toBe(1);
    expect(await recordValue(db, seed, exerciseId, 'REP_AT_WEIGHT', '90.00')).toBe(10);
    expect(await recordValue(db, seed, exerciseId, 'ESTIMATED_1RM', '')).toBe(120);
    expect(
      await db.collection('personal_record_events').countDocuments({
        relationshipId: seed.relationshipObjectId,
        eventType: 'ACHIEVED',
        recordType: 'MAX_WEIGHT',
      }),
    ).toBe(1);

    const firstExerciseKey = firstExercise(first.workout).workoutExerciseKey;
    const firstSetKey = firstSet(first.workout).setKey;
    const adjusted = await container.workouts.patch(
      seed.traineeCtx,
      seed.workspaceId,
      seed.relationshipId,
      first.workout.id,
      {
        expectedVersion: first.completed.workout.version,
        exercises: [
          {
            workoutExerciseKey: firstExerciseKey,
            sets: [{ setKey: firstSetKey, weight: 80, reps: 1, completed: true }],
          },
        ],
      },
    );
    expect(await recordValue(db, seed, exerciseId, 'MAX_WEIGHT', '')).toBe(90);
    expect(
      await db.collection('personal_record_events').countDocuments({
        relationshipId: seed.relationshipObjectId,
        eventType: 'ADJUSTED',
        recordType: 'MAX_WEIGHT',
      }),
    ).toBeGreaterThanOrEqual(1);

    await runStaffCorrection(
      container,
      seed,
      first.workout.id,
      adjusted.workout.version,
      firstExerciseKey,
      firstSetKey,
      130,
      2,
      `pr-achieved-correction-${new ObjectId().toHexString()}`,
    );
    expect(await recordValue(db, seed, exerciseId, 'MAX_WEIGHT', '')).toBe(130);
    expect(await recordValue(db, seed, exerciseId, 'ESTIMATED_1RM', '')).toBe(138.67);

    const onlySeed = await seedGym(container);
    await activeProgram(container, onlySeed, 'PR Retract Only');
    const only = await completeWithSet(
      container,
      onlySeed,
      50,
      5,
      `pr-only-${new ObjectId().toHexString()}`,
    );
    const onlyExerciseId = new ObjectId(firstExercise(only.workout).exerciseId);
    await runStaffCorrection(
      container,
      onlySeed,
      only.workout.id,
      only.completed.workout.version,
      firstExercise(only.workout).workoutExerciseKey,
      firstSet(only.workout).setKey,
      0,
      0,
      `pr-retract-${new ObjectId().toHexString()}`,
    );
    expect(await recordValue(db, onlySeed, onlyExerciseId, 'MAX_WEIGHT', '')).toBeUndefined();
    expect(
      await db.collection('personal_record_events').countDocuments({
        relationshipId: onlySeed.relationshipObjectId,
        eventType: 'RETRACTED',
      }),
    ).toBe(3);
    expect(
      await db.collection('outbox_events').countDocuments({
        workspaceId: onlySeed.workspaceObjectId,
        eventType: 'PersonalRecordRetracted',
      }),
    ).toBe(3);
  });

  test('staff and trainee corrections race through workout version and leave PR projection consistent', async () => {
    const staffSeed = await seedGym(container);
    await activeProgram(container, staffSeed, 'Staff Race');
    const staffWorkout = await completeWithSet(
      container,
      staffSeed,
      80,
      5,
      `staff-race-${new ObjectId().toHexString()}`,
    );
    const staffRace = await Promise.allSettled([
      runStaffCorrection(
        container,
        staffSeed,
        staffWorkout.workout.id,
        staffWorkout.completed.workout.version,
        firstExercise(staffWorkout.workout).workoutExerciseKey,
        firstSet(staffWorkout.workout).setKey,
        90,
        5,
        `staff-race-a-${new ObjectId().toHexString()}`,
      ),
      runStaffCorrection(
        container,
        staffSeed,
        staffWorkout.workout.id,
        staffWorkout.completed.workout.version,
        firstExercise(staffWorkout.workout).workoutExerciseKey,
        firstSet(staffWorkout.workout).setKey,
        95,
        5,
        `staff-race-b-${new ObjectId().toHexString()}`,
      ),
    ]);
    expect(staffRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejectedCodes(staffRace)).toContain('WORKOUT_VERSION_CONFLICT');

    const staffReplaySeed = await seedGym(container);
    await activeProgram(container, staffReplaySeed, 'Staff Replay');
    const staffReplayWorkout = await completeWithSet(
      container,
      staffReplaySeed,
      72,
      4,
      `staff-replay-complete-${new ObjectId().toHexString()}`,
    );
    const staffReplayKey = `staff-replay-${new ObjectId().toHexString()}`;
    const staffReplayExerciseKey = firstExercise(staffReplayWorkout.workout).workoutExerciseKey;
    const staffReplaySetKey = firstSet(staffReplayWorkout.workout).setKey;
    await runStaffCorrection(
      container,
      staffReplaySeed,
      staffReplayWorkout.workout.id,
      staffReplayWorkout.completed.workout.version,
      staffReplayExerciseKey,
      staffReplaySetKey,
      78,
      4,
      staffReplayKey,
    );
    expect(
      (
        await runStaffCorrection(
          container,
          staffReplaySeed,
          staffReplayWorkout.workout.id,
          staffReplayWorkout.completed.workout.version,
          staffReplayExerciseKey,
          staffReplaySetKey,
          78,
          4,
          staffReplayKey,
        )
      ).result.replayed,
    ).toBe(true);
    await expect(
      container.idempotency.runInTransaction(staffReplaySeed.trainerCtx, {
        routeKey:
          'POST /workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/corrections',
        key: staffReplayKey,
        fingerprint: {
          workspaceId: staffReplaySeed.workspaceId,
          relationshipId: staffReplaySeed.relationshipId,
          workoutId: staffReplayWorkout.workout.id,
          expectedVersion: staffReplayWorkout.completed.workout.version,
          exercises: [
            {
              workoutExerciseKey: staffReplayExerciseKey,
              sets: [{ setKey: staffReplaySetKey, weight: 79, reps: 4, completed: true }],
            },
          ],
          reason: 'conflicting correction',
        },
        unitOfWork: container.unitOfWork,
        operation: async (tx) => ({
          body: await container.workouts.staffCorrection(
            staffReplaySeed.trainerCtx,
            staffReplaySeed.workspaceId,
            staffReplaySeed.relationshipId,
            staffReplayWorkout.workout.id,
            {
              expectedVersion: staffReplayWorkout.completed.workout.version,
              exercises: [
                {
                  workoutExerciseKey: staffReplayExerciseKey,
                  sets: [{ setKey: staffReplaySetKey, weight: 79, reps: 4, completed: true }],
                },
              ],
              reason: 'conflicting correction',
            },
            tx,
          ),
        }),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const mixedSeed = await seedGym(container);
    await activeProgram(container, mixedSeed, 'Mixed Correction Race');
    const mixed = await completeWithSet(
      container,
      mixedSeed,
      70,
      5,
      `mixed-race-${new ObjectId().toHexString()}`,
    );
    const exerciseKey = firstExercise(mixed.workout).workoutExerciseKey;
    const setKey = firstSet(mixed.workout).setKey;
    const mixedRace = await Promise.allSettled([
      container.workouts.patch(
        mixedSeed.traineeCtx,
        mixedSeed.workspaceId,
        mixedSeed.relationshipId,
        mixed.workout.id,
        {
          expectedVersion: mixed.completed.workout.version,
          exercises: [
            {
              workoutExerciseKey: exerciseKey,
              sets: [{ setKey, weight: 75, reps: 5, completed: true }],
            },
          ],
        },
      ),
      runStaffCorrection(
        container,
        mixedSeed,
        mixed.workout.id,
        mixed.completed.workout.version,
        exerciseKey,
        setKey,
        76,
        5,
        `mixed-staff-${new ObjectId().toHexString()}`,
      ),
    ]);
    expect(mixedRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejectedCodes(mixedRace)).toContain('WORKOUT_VERSION_CONFLICT');
    const exerciseId = new ObjectId(firstExercise(mixed.workout).exerciseId);
    const finalWorkout = await db
      .collection('workout_sessions')
      .findOne({ _id: new ObjectId(mixed.workout.id) });
    const finalWeight = firstExercise(finalWorkout as unknown as { exercises: unknown[] })
      .sets[0] as {
      weight?: number;
    };
    expect(await recordValue(db, mixedSeed, exerciseId, 'MAX_WEIGHT', '')).toBe(finalWeight.weight);
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
    await writeGrant(db, {
      workspaceId: seed.workspaceObjectId,
      subjectId: new ObjectId(seed.assistantMembershipId),
      permission: 'workouts.complete',
      effect: 'ALLOW',
    });
    const assistantCompleted = await container.workouts.complete(
      seed.assistantCtx,
      seed.workspaceId,
      seed.relationshipId,
      assistantStart.workout.id,
      { expectedVersion: assistantStart.workout.version },
    );
    expect(assistantCompleted.workout.status).toBe('COMPLETED');
    expect(
      (await container.workouts.list(seed.traineeCtx, seed.workspaceId, seed.relationshipId, {}))
        .data[0]?.id,
    ).toBe(assistantStart.workout.id);
    await writeGrant(db, {
      workspaceId: seed.workspaceObjectId,
      subjectId: new ObjectId(seed.traineeMembershipId),
      permission: 'workouts.read',
      effect: 'DENY',
    });
    await expect(
      container.workouts.current(seed.traineeCtx, seed.workspaceId, seed.relationshipId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(
      (await container.workouts.current(seed.managerCtx, seed.workspaceId, seed.relationshipId))
        .workout,
    ).toBeNull();
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
    await db
      .collection('subscription_terms')
      .updateOne(
        { workspaceId: seed.workspaceObjectId },
        { $set: { enabledFeatures: ['training'] } },
      );
    const patched = await patchFirstSet(container, seed, live.workout, 44, 6);
    const completed = await runComplete(
      container,
      seed,
      live.workout.id,
      patched.workout.version,
      `commercial-restore-complete-${new ObjectId().toHexString()}`,
    );
    expect(completed.result.body.workout.status).toBe('COMPLETED');
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

  test('start, skip, defer, and relationship END rollback injected transactional failures', async () => {
    for (const failure of ['audit_events', 'idempotency_records']) {
      const seed = await seedGym(container);
      await activeProgram(container, seed, `Start Rollback ${failure}`);
      await installFailureValidator(db, failure);
      try {
        await expect(
          runStart(container, seed, `start-rollback-${failure}-${new ObjectId().toHexString()}`),
        ).rejects.toThrow();
      } finally {
        await clearFailureValidator(db, failure);
      }
      expect(
        await db.collection('workout_sessions').countDocuments({
          relationshipId: seed.relationshipObjectId,
          status: 'IN_PROGRESS',
        }),
      ).toBe(0);
      const retry = await runStart(
        container,
        seed,
        `start-rollback-retry-${failure}-${new ObjectId().toHexString()}`,
      );
      expect(retry.result.body.workout.status).toBe('IN_PROGRESS');
    }

    for (const [kind, failure] of [
      ['SKIPPED', 'program_progress_events'],
      ['SKIPPED', 'audit_events'],
      ['SKIPPED', 'idempotency_records'],
      ['DEFERRED', 'program_progress_events'],
      ['DEFERRED', 'audit_events'],
      ['DEFERRED', 'idempotency_records'],
    ] as const) {
      const seed = await seedGym(container);
      const program = await activeProgram(container, seed, `${kind} Rollback ${failure}`, [1, 3]);
      const progress = await container.training.getProgress(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        program.program.id,
      );
      await installFailureValidator(db, failure);
      try {
        await expect(
          runProgress(
            container,
            seed,
            program.program.id,
            progress.progress.version,
            kind,
            `${kind}-rollback-${failure}-${new ObjectId().toHexString()}`,
          ),
        ).rejects.toThrow();
      } finally {
        await clearFailureValidator(db, failure);
      }
      const after = await db
        .collection('program_progress')
        .findOne({ programId: new ObjectId(program.program.id) });
      expect(after?.currentDaySequence).toBe(progress.progress.currentDaySequence);
      expect(after?.version).toBe(progress.progress.version);
      expect(after?.skippedDayCount).toBe(0);
      expect(
        await db.collection('program_progress_events').countDocuments({
          programId: new ObjectId(program.program.id),
          type: kind,
        }),
      ).toBe(0);
    }

    const endSeed = await seedGym(container);
    const program = await activeProgram(container, endSeed, 'Relationship End Rollback');
    const live = (
      await runStart(container, endSeed, `end-rollback-live-${new ObjectId().toHexString()}`)
    ).result.body.workout;
    await installFailureValidator(db, 'outbox_events');
    try {
      await expect(
        container.trainees.endRelationship(
          endSeed.ownerCtx,
          endSeed.workspaceId,
          endSeed.relationshipId,
          {
            expectedVersion: endSeed.relationshipVersion,
            reason: 'rollback',
          },
        ),
      ).rejects.toThrow();
    } finally {
      await clearFailureValidator(db, 'outbox_events');
    }
    expect(
      (await db.collection('coaching_relationships').findOne({ _id: endSeed.relationshipObjectId }))
        ?.status,
    ).toBe('ACTIVE');
    expect(
      (await db.collection('workout_sessions').findOne({ _id: new ObjectId(live.id) }))?.status,
    ).toBe('IN_PROGRESS');
    expect(
      (await db.collection('programs').findOne({ _id: new ObjectId(program.program.id) }))?.status,
    ).toBe('ACTIVE');
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

async function patchFirstSet(
  container: AppContainer,
  seed: Seed,
  workout: { id: string; version: number; exercises: unknown[] },
  weight: number,
  reps: number,
) {
  return await container.workouts.patch(
    seed.traineeCtx,
    seed.workspaceId,
    seed.relationshipId,
    workout.id,
    {
      expectedVersion: workout.version,
      exercises: [
        {
          workoutExerciseKey: firstExercise(workout).workoutExerciseKey,
          sets: [
            {
              setKey: firstSet(workout).setKey,
              weight,
              reps,
              completed: weight > 0 && reps > 0,
            },
          ],
        },
      ],
    },
  );
}

async function recordValue(
  db: Db,
  seed: Seed,
  exerciseId: ObjectId,
  recordType: string,
  qualifierKey: string,
) {
  return (
    await db.collection('personal_records').findOne({
      workspaceId: seed.workspaceObjectId,
      relationshipId: seed.relationshipObjectId,
      exerciseId,
      recordType,
      qualifierKey,
    })
  )?.value;
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

function rejectedCodes(results: Array<PromiseSettledResult<unknown>>) {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => (result.reason as { code?: string }).code);
}

async function runStart(
  container: AppContainer,
  seed: Seed,
  key: string,
  actorCtx: ReturnType<typeof ctx> = seed.traineeCtx,
) {
  return {
    key,
    result: await container.idempotency.runInTransaction(actorCtx, {
      routeKey: 'POST /workspaces/:workspaceId/relationships/:relationshipId/workouts/start',
      key,
      fingerprint: {
        params: { workspaceId: seed.workspaceId, relationshipId: seed.relationshipId },
        body: {},
      },
      unitOfWork: container.unitOfWork,
      operation: async (tx) => ({
        body: await container.workouts.start(actorCtx, seed.workspaceId, seed.relationshipId, tx),
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
  actorCtx: ReturnType<typeof ctx> = seed.traineeCtx,
) {
  return {
    key,
    result: await container.idempotency.runInTransaction(actorCtx, {
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
          actorCtx,
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
  actorCtx: ReturnType<typeof ctx> = seed.traineeCtx,
) {
  return {
    key,
    result: await container.idempotency.runInTransaction(actorCtx, {
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
          actorCtx,
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
  actorCtx: ReturnType<typeof ctx> = seed.traineeCtx,
) {
  return {
    key,
    result: await container.idempotency.runInTransaction(actorCtx, {
      routeKey: `POST /workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/progress/${kind === 'SKIPPED' ? 'skip' : 'defer'}`,
      key,
      fingerprint: {
        params: { workspaceId: seed.workspaceId, relationshipId: seed.relationshipId, programId },
        body: { expectedVersion },
      },
      unitOfWork: container.unitOfWork,
      operation: async (tx) => ({
        body: await container.workouts.skipOrDefer(
          actorCtx,
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
    trainerMembershipId: trainerMembership._id.toHexString(),
    traineeMembershipId: traineeMembership._id.toHexString(),
    assistantMembershipId: assistantMembership._id.toHexString(),
    managerMembershipId: managerMembership._id.toHexString(),
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
