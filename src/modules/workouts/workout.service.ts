import { ObjectId } from 'mongodb';
import type { AccessControlService } from '../../core/access-control/access-control.service';
import type { AuthorizationDecision } from '../../core/access-control/access-control.types';
import type { AuditWriter } from '../../core/audit/audit.writer';
import type { TransactionContext, UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { OutboxWriter } from '../../core/events/outbox.writer';
import type { RequestContext } from '../../core/request-context/request-context';
import { Permissions } from '../permissions/permission.registry';
import type { EntitlementService } from '../subscriptions/subscription.service';
import type { CoachingRelationshipRepository } from '../trainees/trainee.repository';
import type { CoachingRelationshipDocument } from '../trainees/trainee.types';
import type { TrainingRepository } from '../training/training.repository';
import type { ProgramDay } from '../training/training.types';
import type { WorkspaceMembershipRepository } from '../workspaces/workspace.repository';
import type { WorkoutRepository } from './workout.repository';
import type {
  PersonalRecordDocument,
  PersonalRecordEventDocument,
  PersonalRecordEventType,
  PersonalRecordType,
  WorkoutExerciseSnapshot,
  WorkoutSessionDocument,
  WorkoutSetSnapshot,
} from './workout.types';

type ActualSetInput = {
  setKey: string;
  weight?: number;
  reps?: number;
  durationSeconds?: number;
  distance?: number;
  rpe?: number;
  rir?: number;
  completed: boolean;
  notes?: string;
};

type ActualExerciseInput = {
  workoutExerciseKey: string;
  sets: ActualSetInput[];
};

type ActualPatchInput = {
  expectedVersion: number;
  exercises: ActualExerciseInput[];
  notes?: string;
  clientMutationId?: string;
};

export interface WorkoutProgramLifecyclePort {
  assertNoInProgressForProgramTransition(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    programId: ObjectId,
    tx: TransactionContext,
  ): Promise<void>;
}

export interface WorkoutRelationshipLifecyclePort {
  abandonInProgressForRelationshipEnd(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ): Promise<void>;
}

export class WorkoutApplicationService
  implements WorkoutProgramLifecyclePort, WorkoutRelationshipLifecyclePort
{
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly workouts: WorkoutRepository,
    private readonly training: TrainingRepository,
    private readonly relationships: CoachingRelationshipRepository,
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly accessControl: AccessControlService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async start(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    tx?: TransactionContext,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.WorkoutsCreate,
      'create',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'training');
    const actorId = actorObjectId(ctx);
    const now = new Date();
    return await this.withTransaction(tx, async (tx) => {
      const relationship = await this.relationships.guardWorkoutLifecycleActive(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const activeProgram = await this.training.findActiveProgram(
        ids.workspaceId,
        relationship._id,
        tx,
      );
      if (!activeProgram) throw conflict('ACTIVE_PROGRAM_NOT_FOUND');
      const guardedProgram = await this.training.guardActiveProgramForWorkout(
        ids.workspaceId,
        relationship._id,
        activeProgram._id,
        tx,
      );
      const progress = await this.training.findProgress(
        ids.workspaceId,
        relationship._id,
        guardedProgram._id,
        tx,
      );
      if (!progress) throw conflict('PROGRAM_PROGRESS_NOT_FOUND');
      const guardedProgress = await this.training.guardProgressForWorkoutStart(
        ids.workspaceId,
        relationship._id,
        guardedProgram._id,
        progress.currentDaySequence,
        tx,
      );
      const revision = await this.training.findProgramRevision(
        ids.workspaceId,
        relationship._id,
        guardedProgram._id,
        guardedProgram.currentRevisionId,
        tx,
      );
      if (!revision) throw conflict('PROGRAM_REVISION_NOT_FOUND');
      const day = executableDay(revision.days, guardedProgress.currentDaySequence);
      const workout: WorkoutSessionDocument = {
        _id: new ObjectId(),
        workspaceId: ids.workspaceId,
        relationshipId: relationship._id,
        traineeUserId: relationship.traineeUserId,
        programId: guardedProgram._id,
        programRevisionId: revision._id,
        dayKey: day.dayKey,
        daySequence: day.sequence,
        performedByUserId: actorId,
        status: 'IN_PROGRESS',
        startedAt: now,
        exercises: snapshotExercises(day),
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
      const created = await this.workouts.create(workout, tx);
      await this.writeAudit(ctx, ids.workspaceId, 'WorkoutStarted', created._id, 'start', tx);
      return { workout: safeWorkout(created) };
    });
  }

  async current(ctx: RequestContext, workspaceId: string, relationshipId: string) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.WorkoutsRead,
      'read',
    );
    await this.entitlements.assert(ids.workspaceId, 'READ');
    const workout = await this.workouts.findCurrent(ids.workspaceId, ids.relationship._id);
    return { workout: workout ? safeWorkout(workout) : null };
  }

  async list(ctx: RequestContext, workspaceId: string, relationshipId: string, query: PageQuery) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.WorkoutsRead,
      'read',
    );
    await this.entitlements.assert(ids.workspaceId, 'READ');
    return page(
      await this.workouts.list(
        ids.workspaceId,
        ids.relationship._id,
        query.limit ?? 50,
        optionalObjectId(query.cursor, 'CURSOR_INVALID'),
      ),
      safeWorkout,
    );
  }

  async patch(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    workoutId: string,
    input: ActualPatchInput,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.WorkoutsUpdate,
      'update',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'training');
    const id = objectId(workoutId, 'WORKOUT_NOT_FOUND');
    return await this.unitOfWork.withTransaction(async (tx) => {
      const existing = await this.requireWorkout(ids.workspaceId, ids.relationship._id, id, tx);
      const traineeCorrection =
        existing.status === 'COMPLETED' && isTraineeSelf(ctx, ids.relationship);
      if (existing.status === 'ABANDONED') throw conflict('WORKOUT_ABANDONED');
      if (existing.status === 'COMPLETED' && !traineeCorrection)
        throw conflict('WORKOUT_ALREADY_COMPLETED');
      const nextExercises = mergeActuals(existing.exercises, input.exercises);
      const updated = await this.workouts.updateActuals(
        ids.workspaceId,
        ids.relationship._id,
        id,
        input.expectedVersion,
        nextExercises,
        optionalPatchMetadata(input),
        new Date(),
        traineeCorrection ? new Date() : undefined,
        false,
        tx,
      );
      await this.recalculatePersonalRecords(ctx, updated, tx);
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        traineeCorrection ? 'WorkoutCorrected' : 'WorkoutUpdated',
        id,
        'update',
        tx,
      );
      if (traineeCorrection)
        await this.writeOutbox(ctx, ids.workspaceId, 'WorkoutCorrected', 'workout_session', id, tx);
      return { workout: safeWorkout(updated) };
    });
  }

  async complete(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    workoutId: string,
    input: { expectedVersion: number },
    tx?: TransactionContext,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.WorkoutsComplete,
      'complete',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'training');
    const actorId = actorObjectId(ctx);
    const id = objectId(workoutId, 'WORKOUT_NOT_FOUND');
    const now = new Date();
    return await this.withTransaction(tx, async (tx) => {
      await this.relationships.guardWorkoutLifecycleActive(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const existing = await this.requireWorkout(ids.workspaceId, ids.relationship._id, id, tx);
      if (existing.status === 'COMPLETED') throw conflict('WORKOUT_ALREADY_COMPLETED');
      if (existing.status === 'ABANDONED') throw conflict('WORKOUT_ABANDONED');
      const completed = await this.workouts.complete(
        ids.workspaceId,
        ids.relationship._id,
        id,
        input.expectedVersion,
        actorId,
        now,
        tx,
      );
      const progress = await this.training.findProgress(
        ids.workspaceId,
        ids.relationship._id,
        completed.programId,
        tx,
      );
      if (!progress) throw conflict('PROGRAM_PROGRESS_NOT_FOUND');
      if (progress.currentDaySequence !== completed.daySequence)
        throw conflict('PROGRAM_DAY_NOT_CURRENT');
      const revision = await this.training.findProgramRevision(
        ids.workspaceId,
        ids.relationship._id,
        completed.programId,
        completed.programRevisionId,
        tx,
      );
      if (!revision) throw conflict('PROGRAM_REVISION_NOT_FOUND');
      const next = nextExecutableSequence(revision.days, completed.daySequence);
      await this.training.advanceProgress(
        {
          workspaceId: ids.workspaceId,
          relationshipId: ids.relationship._id,
          programId: completed.programId,
          expectedVersion: progress.version,
          currentDaySequence: completed.daySequence,
          nextDaySequence: next,
          kind: 'COMPLETED',
          programRevisionId: completed.programRevisionId,
          workoutSessionId: completed._id,
          performedBy: actorId,
          now,
        },
        tx,
      );
      await this.recalculatePersonalRecords(ctx, completed, tx);
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        'WorkoutCompleted',
        completed._id,
        'complete',
        tx,
      );
      await this.writeOutbox(
        ctx,
        ids.workspaceId,
        'WorkoutCompleted',
        'workout_session',
        completed._id,
        tx,
      );
      return { workout: safeWorkout(completed) };
    });
  }

  async abandon(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    workoutId: string,
    input: { expectedVersion: number; reason?: string },
    tx?: TransactionContext,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.WorkoutsAbandon,
      'abandon',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'training');
    const now = new Date();
    const actorId = actorObjectId(ctx);
    return await this.withTransaction(tx, async (tx) => {
      const abandoned = await this.workouts.abandon(
        ids.workspaceId,
        ids.relationship._id,
        objectId(workoutId, 'WORKOUT_NOT_FOUND'),
        input.expectedVersion,
        actorId,
        input.reason?.trim(),
        now,
        tx,
      );
      await this.writeAudit(ctx, ids.workspaceId, 'WorkoutAbandoned', abandoned._id, 'abandon', tx);
      return { workout: safeWorkout(abandoned) };
    });
  }

  async staffCorrection(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    workoutId: string,
    input: ActualPatchInput & { reason: string },
    tx?: TransactionContext,
  ) {
    if (!input.reason.trim()) throw invalid('WORKOUT_CORRECTION_REASON_REQUIRED');
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.WorkoutsCorrect,
      'correct',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'training');
    const id = objectId(workoutId, 'WORKOUT_NOT_FOUND');
    return await this.withTransaction(tx, async (tx) => {
      const existing = await this.requireWorkout(ids.workspaceId, ids.relationship._id, id, tx);
      if (existing.status !== 'COMPLETED') throw conflict('WORKOUT_ALREADY_COMPLETED');
      const updated = await this.workouts.updateActuals(
        ids.workspaceId,
        ids.relationship._id,
        id,
        input.expectedVersion,
        mergeActuals(existing.exercises, input.exercises),
        optionalPatchMetadata(input),
        new Date(),
        undefined,
        true,
        tx,
      );
      await this.recalculatePersonalRecords(ctx, updated, tx);
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        'WorkoutCorrected',
        id,
        `correct:${input.reason.trim()}`,
        tx,
      );
      await this.writeOutbox(ctx, ids.workspaceId, 'WorkoutCorrected', 'workout_session', id, tx);
      return { workout: safeWorkout(updated) };
    });
  }

  async skipOrDefer(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    programId: string,
    input: { expectedVersion: number; reason?: string },
    kind: 'SKIPPED' | 'DEFERRED',
    tx?: TransactionContext,
  ) {
    const permission =
      kind === 'SKIPPED' ? Permissions.WorkoutsDaySkip : Permissions.WorkoutsDayDefer;
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      permission,
      kind === 'SKIPPED' ? 'skip' : 'defer',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'training');
    const actorId = actorObjectId(ctx);
    const targetProgramId = objectId(programId, 'PROGRAM_NOT_FOUND');
    const now = new Date();
    return await this.withTransaction(tx, async (tx) => {
      await this.relationships.guardWorkoutLifecycleActive(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const active = await this.training.findActiveProgram(
        ids.workspaceId,
        ids.relationship._id,
        tx,
      );
      if (!active?._id.equals(targetProgramId)) throw conflict('PROGRAM_NOT_ACTIVE');
      if ((await this.workouts.findCurrent(ids.workspaceId, ids.relationship._id, tx)) !== null) {
        throw conflict('WORKOUT_ALREADY_IN_PROGRESS');
      }
      const progress = await this.training.findProgress(
        ids.workspaceId,
        ids.relationship._id,
        active._id,
        tx,
      );
      if (!progress) throw conflict('PROGRAM_PROGRESS_NOT_FOUND');
      const revision = await this.training.findProgramRevision(
        ids.workspaceId,
        ids.relationship._id,
        active._id,
        progress.programRevisionId,
        tx,
      );
      if (!revision) throw conflict('PROGRAM_REVISION_NOT_FOUND');
      const next =
        kind === 'SKIPPED'
          ? nextExecutableSequence(revision.days, progress.currentDaySequence)
          : progress.currentDaySequence;
      const reason = input.reason?.trim();
      const updated =
        kind === 'SKIPPED'
          ? await this.training.advanceProgress(
              {
                workspaceId: ids.workspaceId,
                relationshipId: ids.relationship._id,
                programId: active._id,
                expectedVersion: input.expectedVersion,
                currentDaySequence: progress.currentDaySequence,
                nextDaySequence: next,
                kind: 'SKIPPED',
                programRevisionId: progress.programRevisionId,
                ...(reason ? { reason } : {}),
                performedBy: actorId,
                now,
              },
              tx,
            )
          : await this.training.deferProgress(
              {
                workspaceId: ids.workspaceId,
                relationshipId: ids.relationship._id,
                programId: active._id,
                expectedVersion: input.expectedVersion,
                currentDaySequence: progress.currentDaySequence,
                programRevisionId: progress.programRevisionId,
                ...(reason ? { reason } : {}),
                performedBy: actorId,
                now,
              },
              tx,
            );
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        kind === 'SKIPPED' ? 'ProgramDaySkipped' : 'ProgramDayDeferred',
        active._id,
        kind.toLowerCase(),
        tx,
      );
      return { progress: safeProgress(updated) };
    });
  }

  async listPersonalRecords(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    query: PageQuery,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.PersonalRecordsRead,
      'read',
    );
    await this.entitlements.assert(ids.workspaceId, 'READ');
    return page(
      await this.workouts.listRecords(
        ids.workspaceId,
        ids.relationship._id,
        query.limit ?? 50,
        optionalObjectId(query.cursor, 'CURSOR_INVALID'),
      ),
      safeRecord,
    );
  }

  async listPersonalRecordEvents(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    query: PageQuery,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.PersonalRecordsRead,
      'read',
    );
    await this.entitlements.assert(ids.workspaceId, 'READ');
    return page(
      await this.workouts.listRecordEvents(
        ids.workspaceId,
        ids.relationship._id,
        query.limit ?? 50,
        optionalObjectId(query.cursor, 'CURSOR_INVALID'),
      ),
      safeRecordEvent,
    );
  }

  async assertNoInProgressForProgramTransition(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    programId: ObjectId,
    tx: TransactionContext,
  ) {
    if (
      (await this.workouts.countInProgressForProgram(workspaceId, relationshipId, programId, tx)) >
      0
    ) {
      throw conflict('WORKOUT_IN_PROGRESS_BLOCKS_PROGRAM_TRANSITION');
    }
  }

  async abandonInProgressForRelationshipEnd(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ) {
    const actorId = actorObjectId(ctx);
    const count = await this.workouts.abandonInProgressForRelationship(
      workspaceId,
      relationshipId,
      actorId,
      'RELATIONSHIP_ENDED',
      now,
      tx,
    );
    if (count > 0) {
      await this.writeAudit(
        ctx,
        workspaceId,
        'WorkoutAbandoned',
        relationshipId,
        'relationship_end',
        tx,
      );
    }
  }

  private async requireWorkout(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    workoutId: ObjectId,
    tx?: TransactionContext,
  ) {
    const workout = await this.workouts.findById(workspaceId, relationshipId, workoutId, tx);
    if (!workout) throw notFound('WORKOUT_NOT_FOUND');
    return workout;
  }

  private async withTransaction<T>(
    tx: TransactionContext | undefined,
    operation: (tx: TransactionContext) => Promise<T>,
  ) {
    if (tx) return await operation(tx);
    return await this.unitOfWork.withTransaction(operation);
  }

  private async authorizedRelationship(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    permission: string,
    action: AccessAction,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relationship = await this.relationships.findByIdInWorkspace(
      id,
      objectId(relationshipId, 'RELATIONSHIP_NOT_FOUND'),
    );
    if (!relationship) throw notFound('RELATIONSHIP_NOT_FOUND');
    await this.assertRelationshipAccess(ctx, id, relationship, permission, action);
    return { workspaceId: id, relationship };
  }

  private async assertRelationshipAccess(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationship: CoachingRelationshipDocument,
    permission: string,
    action: AccessAction,
  ) {
    let decision: AuthorizationDecision | undefined;
    try {
      decision = await this.accessControl.authorize(ctx, {
        context: 'WORKSPACE',
        workspaceId,
        permission,
        scope: { type: 'WORKSPACE' },
      });
    } catch (error) {
      if (isTraineeSelf(ctx, relationship) && traineeSelfActions.has(action)) return;
      throw error;
    }
    const membership = await this.actorMembership(ctx, workspaceId);
    if (membership.roles.includes('GYM_OWNER')) return;
    if (membership.roles.includes('GYM_MANAGER')) {
      if (action === 'read') return;
      throw forbidden();
    }
    if (isTraineeSelf(ctx, relationship) && traineeSelfActions.has(action)) return;
    const assignments = await this.relationships.listActiveAssignments(relationship._id);
    const isPrimary = assignments.some(
      (assignment) =>
        assignment.assignmentType === 'PRIMARY_TRAINER' &&
        assignment.staffMembershipId.equals(membership._id),
    );
    if (isPrimary) return;
    const isAssistant = assignments.some(
      (assignment) =>
        assignment.assignmentType === 'ASSISTANT_TRAINER' &&
        assignment.staffMembershipId.equals(membership._id),
    );
    if (isAssistant && (action === 'read' || action === 'create')) return;
    if (isAssistant && decision?.source === 'EXPLICIT_GRANT') return;
    throw forbidden();
  }

  private async actorMembership(ctx: RequestContext, workspaceId: ObjectId) {
    const membership = await this.memberships.findByUserInWorkspace(
      workspaceId,
      actorObjectId(ctx),
    );
    if (membership?.status !== 'ACTIVE') throw forbidden();
    ctx.workspaceMembershipId = membership._id.toHexString();
    return membership;
  }

  private async recalculatePersonalRecords(
    ctx: RequestContext,
    workout: WorkoutSessionDocument,
    tx: TransactionContext,
  ) {
    const exerciseIds = uniqueObjectIds(workout.exercises.map((exercise) => exercise.exerciseId));
    const completed = await this.workouts.completedWorkoutsForExercises(
      workout.workspaceId,
      workout.relationshipId,
      exerciseIds,
      tx,
    );
    const candidates = recordCandidates(completed);
    const candidateKeys = new Set(candidates.map(recordKey));
    const existingRecords = await this.workouts.listRecordsForExercises(
      workout.workspaceId,
      workout.relationshipId,
      exerciseIds,
      tx,
    );
    for (const record of existingRecords) candidateKeys.add(recordKey(record));
    for (const exerciseId of exerciseIds) {
      for (const type of ['MAX_WEIGHT', 'ESTIMATED_1RM'] as PersonalRecordType[]) {
        candidateKeys.add(`${exerciseId.toHexString()}:${type}:`);
      }
    }
    for (const key of candidateKeys) {
      const [exerciseIdValue, type, qualifierKey] = key.split(':') as [
        string,
        PersonalRecordType,
        string,
      ];
      const exerciseId = new ObjectId(exerciseIdValue);
      const next = bestCandidate(candidates, exerciseId, type, qualifierKey);
      const previous = await this.workouts.findRecord(
        workout.workspaceId,
        workout.relationshipId,
        exerciseId,
        type,
        qualifierKey,
        tx,
      );
      if (!next && !previous) continue;
      const eventType: PersonalRecordEventType | undefined =
        !previous && next
          ? 'ACHIEVED'
          : previous && next && previous.value !== next.value
            ? 'ADJUSTED'
            : previous && !next
              ? 'RETRACTED'
              : undefined;
      if (next) {
        await this.workouts.replaceRecord(
          {
            _id: previous?._id ?? new ObjectId(),
            workspaceId: workout.workspaceId,
            relationshipId: workout.relationshipId,
            exerciseId,
            recordType: type,
            qualifierKey,
            value: next.value,
            sourceWorkoutId: next.workout._id,
            sourceWorkoutVersion: next.workout.version,
            achievedAt: next.workout.completedAt ?? next.workout.updatedAt,
            updatedAt: new Date(),
          },
          tx,
        );
      } else {
        await this.workouts.deleteRecord(
          workout.workspaceId,
          workout.relationshipId,
          exerciseId,
          type,
          qualifierKey,
          tx,
        );
      }
      if (eventType) {
        await this.workouts.insertRecordEvent(
          {
            _id: new ObjectId(),
            workspaceId: workout.workspaceId,
            relationshipId: workout.relationshipId,
            exerciseId,
            recordType: type,
            qualifierKey,
            eventType,
            ...(previous ? { previousValue: previous.value } : {}),
            ...(next ? { newValue: next.value } : {}),
            sourceWorkoutId: next?.workout._id ?? previous?.sourceWorkoutId ?? workout._id,
            sourceWorkoutVersion:
              next?.workout.version ?? previous?.sourceWorkoutVersion ?? workout.version,
            occurredAt: new Date(),
          },
          tx,
        );
        await this.writeOutbox(
          ctx,
          workout.workspaceId,
          `PersonalRecord${eventType[0]}${eventType.slice(1).toLowerCase()}`,
          'personal_record',
          exerciseId,
          tx,
        );
      }
    }
  }

  private async writeAudit(
    ctx: RequestContext,
    workspaceId: ObjectId,
    eventType: string,
    entityId: ObjectId,
    action: string,
    tx: TransactionContext,
  ) {
    await this.audit.write(
      {
        eventType,
        workspaceId,
        actor: {
          userId: actorObjectId(ctx),
          ...(ctx.workspaceMembershipId && ObjectId.isValid(ctx.workspaceMembershipId)
            ? { workspaceMembershipId: new ObjectId(ctx.workspaceMembershipId) }
            : {}),
        },
        entity: { type: eventType, id: entityId },
        action,
        ipAddress: ctx.ipAddress,
        ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }

  private async writeOutbox(
    ctx: RequestContext,
    workspaceId: ObjectId,
    eventType: string,
    aggregateType: string,
    aggregateId: ObjectId,
    tx: TransactionContext,
  ) {
    await this.outbox.write(
      {
        eventType,
        aggregateType,
        aggregateId,
        workspaceId,
        payload: { aggregateId: aggregateId.toHexString() },
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }
}

type AccessAction =
  | 'read'
  | 'create'
  | 'update'
  | 'complete'
  | 'abandon'
  | 'correct'
  | 'skip'
  | 'defer';

const traineeSelfActions = new Set<AccessAction>([
  'read',
  'create',
  'update',
  'complete',
  'abandon',
  'skip',
  'defer',
]);

interface PageQuery {
  cursor?: string;
  limit?: number;
}

function snapshotExercises(day: ProgramDay): WorkoutExerciseSnapshot[] {
  return day.exercises
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((exercise) => ({
      ...exercise,
      workoutExerciseKey: new ObjectId().toHexString(),
      sets: Array.from({ length: exercise.targetSets }, (_, index) => ({
        setKey: new ObjectId().toHexString(),
        setIndex: index + 1,
        setType: exercise.setStructure,
        completed: false,
      })),
    }));
}

function mergeActuals(
  existing: WorkoutExerciseSnapshot[],
  patch: ActualExerciseInput[],
): WorkoutExerciseSnapshot[] {
  const exercisePatch = new Map(patch.map((exercise) => [exercise.workoutExerciseKey, exercise]));
  return existing.map((exercise) => {
    const nextExercise = exercisePatch.get(exercise.workoutExerciseKey);
    if (!nextExercise) return exercise;
    const setPatch = new Map(nextExercise.sets.map((set) => [set.setKey, set]));
    return {
      ...exercise,
      sets: exercise.sets.map((set) => {
        const next = setPatch.get(set.setKey);
        if (!next) return set;
        return compactSet(set, next);
      }),
    };
  });
}

function compactSet(set: WorkoutSetSnapshot, next: ActualSetInput): WorkoutSetSnapshot {
  return compact({
    setKey: set.setKey,
    setIndex: set.setIndex,
    setType: set.setType,
    ...(next.weight !== undefined ? { weight: next.weight } : {}),
    ...(next.reps !== undefined ? { reps: next.reps } : {}),
    ...(next.durationSeconds !== undefined ? { durationSeconds: next.durationSeconds } : {}),
    ...(next.distance !== undefined ? { distance: next.distance } : {}),
    ...(next.rpe !== undefined ? { rpe: next.rpe } : {}),
    ...(next.rir !== undefined ? { rir: next.rir } : {}),
    completed: next.completed,
    ...(next.notes?.trim() ? { notes: next.notes.trim() } : {}),
  });
}

function optionalPatchMetadata(input: { notes?: string; clientMutationId?: string }) {
  return {
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}),
  };
}

function executableDay(days: ProgramDay[], sequence: number) {
  const day = days.find((item) => item.sequence === sequence);
  if (!day) throw conflict('PROGRAM_DAY_NOT_CURRENT');
  if (!isExecutable(day)) throw conflict('PROGRAM_DAY_NOT_EXECUTABLE');
  return day;
}

function nextExecutableSequence(days: ProgramDay[], currentSequence: number) {
  const ordered = days.slice().sort((a, b) => a.sequence - b.sequence);
  const executable = ordered.filter(isExecutable);
  if (executable.length === 0) throw conflict('PROGRAM_DAY_NOT_EXECUTABLE');
  const currentIndex = executable.findIndex((day) => day.sequence === currentSequence);
  if (currentIndex < 0) throw conflict('PROGRAM_DAY_NOT_CURRENT');
  return (
    executable[(currentIndex + 1) % executable.length]?.sequence ??
    executable[0]?.sequence ??
    currentSequence
  );
}

function isExecutable(day: ProgramDay) {
  return day.type !== 'REST' && day.type !== 'RECOVERY' && day.exercises.length > 0;
}

function recordCandidates(workouts: WorkoutSessionDocument[]) {
  const candidates: Array<{
    exerciseId: ObjectId;
    recordType: PersonalRecordType;
    qualifierKey: string;
    value: number;
    workout: WorkoutSessionDocument;
  }> = [];
  for (const workout of workouts) {
    for (const exercise of workout.exercises) {
      for (const set of exercise.sets) {
        if (!eligibleStrengthSet(set)) continue;
        const weight = round2(set.weight ?? 0);
        const reps = set.reps ?? 0;
        candidates.push({
          exerciseId: exercise.exerciseId,
          recordType: 'MAX_WEIGHT',
          qualifierKey: '',
          value: weight,
          workout,
        });
        candidates.push({
          exerciseId: exercise.exerciseId,
          recordType: 'REP_AT_WEIGHT',
          qualifierKey: weight.toFixed(2),
          value: reps,
          workout,
        });
        candidates.push({
          exerciseId: exercise.exerciseId,
          recordType: 'ESTIMATED_1RM',
          qualifierKey: '',
          value: round2(reps === 1 ? weight : weight * (1 + reps / 30)),
          workout,
        });
      }
    }
  }
  return candidates;
}

function bestCandidate(
  candidates: ReturnType<typeof recordCandidates>,
  exerciseId: ObjectId,
  recordType: PersonalRecordType,
  qualifierKey: string,
) {
  return candidates
    .filter(
      (candidate) =>
        candidate.exerciseId.equals(exerciseId) &&
        candidate.recordType === recordType &&
        candidate.qualifierKey === qualifierKey,
    )
    .sort((a, b) => b.value - a.value)[0];
}

function recordKey(input: {
  exerciseId: ObjectId;
  recordType: PersonalRecordType;
  qualifierKey: string;
}) {
  return `${input.exerciseId.toHexString()}:${input.recordType}:${input.qualifierKey}`;
}

function eligibleStrengthSet(set: WorkoutSetSnapshot) {
  return set.completed && (set.weight ?? 0) > 0 && (set.reps ?? 0) >= 1;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function uniqueObjectIds(values: ObjectId[]) {
  return [...new Map(values.map((id) => [id.toHexString(), id])).values()];
}

function safeWorkout(workout: WorkoutSessionDocument) {
  return {
    id: workout._id.toHexString(),
    workspaceId: workout.workspaceId.toHexString(),
    relationshipId: workout.relationshipId.toHexString(),
    traineeUserId: workout.traineeUserId.toHexString(),
    programId: workout.programId.toHexString(),
    programRevisionId: workout.programRevisionId.toHexString(),
    dayKey: workout.dayKey,
    daySequence: workout.daySequence,
    performedByUserId: workout.performedByUserId.toHexString(),
    status: workout.status,
    startedAt: workout.startedAt.toISOString(),
    completedAt: workout.completedAt?.toISOString(),
    traineeEditableUntil: workout.traineeEditableUntil?.toISOString(),
    abandonedAt: workout.abandonedAt?.toISOString(),
    abandonmentReason: workout.abandonmentReason,
    exercises: workout.exercises.map((exercise) => ({
      ...exercise,
      exerciseId: exercise.exerciseId.toHexString(),
    })),
    notes: workout.notes,
    version: workout.version,
  };
}

function safeProgress(progress: {
  programId: ObjectId;
  programRevisionId: ObjectId;
  currentDaySequence: number;
  completedDayCount: number;
  skippedDayCount: number;
  version: number;
}) {
  return {
    programId: progress.programId.toHexString(),
    programRevisionId: progress.programRevisionId.toHexString(),
    currentDaySequence: progress.currentDaySequence,
    completedDayCount: progress.completedDayCount,
    skippedDayCount: progress.skippedDayCount,
    version: progress.version,
  };
}

function safeRecord(record: PersonalRecordDocument) {
  return {
    id: record._id.toHexString(),
    exerciseId: record.exerciseId.toHexString(),
    recordType: record.recordType,
    qualifierKey: record.qualifierKey,
    value: record.value,
    sourceWorkoutId: record.sourceWorkoutId.toHexString(),
    sourceWorkoutVersion: record.sourceWorkoutVersion,
  };
}

function safeRecordEvent(event: PersonalRecordEventDocument) {
  return {
    id: event._id.toHexString(),
    exerciseId: event.exerciseId.toHexString(),
    recordType: event.recordType,
    qualifierKey: event.qualifierKey,
    eventType: event.eventType,
    previousValue: event.previousValue,
    newValue: event.newValue,
    sourceWorkoutId: event.sourceWorkoutId.toHexString(),
    sourceWorkoutVersion: event.sourceWorkoutVersion,
    occurredAt: event.occurredAt.toISOString(),
  };
}

function page<T, R extends { id: string }>(data: T[], mapper: (value: T) => R) {
  const mapped = data.map(mapper);
  return {
    data: mapped,
    meta: {
      nextCursor: mapped.length > 0 ? mapped[mapped.length - 1]?.id : null,
      hasMore: false,
    },
  };
}

function optionalObjectId(value: string | undefined, code: string): ObjectId | undefined {
  if (!value) return undefined;
  return objectId(value, code);
}

function objectId(value: string, code: string): ObjectId {
  if (!value || !ObjectId.isValid(value)) throw notFound(code);
  return new ObjectId(value);
}

function actorObjectId(ctx: RequestContext): ObjectId {
  if (!ctx.userId || !ObjectId.isValid(ctx.userId)) {
    throw new AppError({
      code: 'AUTH_REQUIRED',
      httpStatus: 401,
      message: 'Authentication is required.',
    });
  }
  return new ObjectId(ctx.userId);
}

function isTraineeSelf(ctx: RequestContext, relationship: CoachingRelationshipDocument) {
  return Boolean(
    ctx.userId &&
      ObjectId.isValid(ctx.userId) &&
      relationship.traineeUserId.equals(new ObjectId(ctx.userId)),
  );
}

function compact<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The workout state has changed.' });
}

function invalid(code: string): AppError {
  return new AppError({ code, httpStatus: 422, message: 'The workout request is invalid.' });
}

function notFound(code: string): AppError {
  return new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
}

function forbidden(): AppError {
  return new AppError({
    code: 'PERMISSION_DENIED',
    httpStatus: 403,
    message: 'Permission denied.',
  });
}
