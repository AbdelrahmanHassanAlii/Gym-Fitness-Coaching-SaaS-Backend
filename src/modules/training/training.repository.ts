import { type Collection, type MongoServerError, ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type {
  ExerciseDocument,
  ProgramDocument,
  ProgramProgressDocument,
  ProgramProgressEventDocument,
  ProgramRevisionDocument,
  ProgramStatus,
  ProgramTemplateDocument,
  ProgramTemplateRevisionDocument,
  TrainingScope,
} from './training.types';

export class TrainingRepository {
  private readonly exercises: Collection<ExerciseDocument>;
  private readonly templates: Collection<ProgramTemplateDocument>;
  private readonly templateRevisions: Collection<ProgramTemplateRevisionDocument>;
  private readonly programs: Collection<ProgramDocument>;
  private readonly programRevisions: Collection<ProgramRevisionDocument>;
  private readonly progress: Collection<ProgramProgressDocument>;
  private readonly progressEvents: Collection<ProgramProgressEventDocument>;

  constructor(database: Database) {
    this.exercises = database.db.collection<ExerciseDocument>('exercises');
    this.templates = database.db.collection<ProgramTemplateDocument>('program_templates');
    this.templateRevisions = database.db.collection<ProgramTemplateRevisionDocument>(
      'program_template_revisions',
    );
    this.programs = database.db.collection<ProgramDocument>('programs');
    this.programRevisions = database.db.collection<ProgramRevisionDocument>('program_revisions');
    this.progress = database.db.collection<ProgramProgressDocument>('program_progress');
    this.progressEvents =
      database.db.collection<ProgramProgressEventDocument>('program_progress_events');
  }

  async listExercises(input: {
    workspaceId?: ObjectId;
    ownerMembershipId?: ObjectId;
    includeArchived?: boolean;
    limit?: number;
    afterId?: ObjectId;
  }): Promise<ExerciseDocument[]> {
    const status = input.includeArchived ? {} : { status: 'ACTIVE' as const };
    return await this.exercises
      .find({
        ...status,
        ...(input.afterId ? { _id: { $gt: input.afterId } } : {}),
        $or: [
          { scope: 'SYSTEM', workspaceId: null },
          ...(input.workspaceId
            ? [
                { scope: 'GYM' as const, workspaceId: input.workspaceId },
                ...(input.ownerMembershipId
                  ? [
                      {
                        scope: 'PRIVATE' as const,
                        workspaceId: input.workspaceId,
                        ownerMembershipId: input.ownerMembershipId,
                      },
                    ]
                  : []),
              ]
            : []),
        ],
      })
      .sort({ _id: 1 })
      .limit(input.limit ?? 50)
      .toArray();
  }

  async createExercise(exercise: ExerciseDocument, tx?: TransactionContext) {
    try {
      await this.exercises.insertOne(exercise, options(tx));
      return exercise;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('EXERCISE_NAME_CONFLICT');
      throw error;
    }
  }

  async updateExercise(
    exerciseId: ObjectId,
    scope: TrainingScope,
    workspaceId: ObjectId | null,
    expectedVersion: number,
    patch: Partial<ExerciseDocument>,
    tx?: TransactionContext,
  ) {
    try {
      const result = await this.exercises.findOneAndUpdate(
        {
          _id: exerciseId,
          scope,
          workspaceId,
          status: 'ACTIVE',
          version: expectedVersion,
        },
        { $set: patch, $inc: { version: 1 } },
        { returnDocument: 'after', ...options(tx) },
      );
      if (!result) throw conflict('EXERCISE_VERSION_CONFLICT');
      return result;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('EXERCISE_NAME_CONFLICT');
      throw error;
    }
  }

  async updateWorkspaceExercise(
    exerciseId: ObjectId,
    workspaceId: ObjectId,
    ownerMembershipId: ObjectId,
    expectedVersion: number,
    patch: Partial<ExerciseDocument>,
    tx?: TransactionContext,
  ) {
    try {
      const result = await this.exercises.findOneAndUpdate(
        {
          _id: exerciseId,
          workspaceId,
          status: 'ACTIVE',
          version: expectedVersion,
          $or: [{ scope: 'GYM' }, { scope: 'PRIVATE', ownerMembershipId }],
        },
        { $set: patch, $inc: { version: 1 } },
        { returnDocument: 'after', ...options(tx) },
      );
      if (!result) throw conflict('EXERCISE_VERSION_CONFLICT');
      return result;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('EXERCISE_NAME_CONFLICT');
      throw error;
    }
  }

  async findExerciseForUse(
    exerciseId: ObjectId,
    workspaceId: ObjectId,
    ownerMembershipId: ObjectId,
    tx?: TransactionContext,
  ): Promise<ExerciseDocument | null> {
    return await this.exercises.findOne(
      {
        _id: exerciseId,
        status: 'ACTIVE',
        $or: [
          { scope: 'SYSTEM', workspaceId: null },
          { scope: 'GYM', workspaceId },
          { scope: 'PRIVATE', workspaceId, ownerMembershipId },
        ],
      },
      options(tx),
    );
  }

  async findExercisesForUse(
    exerciseIds: ObjectId[],
    workspaceId: ObjectId,
    ownerMembershipId: ObjectId,
    tx?: TransactionContext,
  ) {
    if (exerciseIds.length === 0) return [];
    return await this.exercises
      .find(
        {
          _id: { $in: exerciseIds },
          status: 'ACTIVE',
          $or: [
            { scope: 'SYSTEM', workspaceId: null },
            { scope: 'GYM', workspaceId },
            { scope: 'PRIVATE', workspaceId, ownerMembershipId },
          ],
        },
        options(tx),
      )
      .toArray();
  }

  async guardExercisesForUse(
    exerciseIds: ObjectId[],
    workspaceId: ObjectId,
    ownerMembershipId: ObjectId,
    tx: TransactionContext,
  ) {
    const uniqueIds = [...new Map(exerciseIds.map((id) => [id.toHexString(), id])).values()];
    const exercises: ExerciseDocument[] = [];
    for (const exerciseId of uniqueIds) {
      const exercise = await this.exercises.findOneAndUpdate(
        {
          _id: exerciseId,
          status: 'ACTIVE',
          $or: [
            { scope: 'SYSTEM', workspaceId: null },
            { scope: 'GYM', workspaceId },
            { scope: 'PRIVATE', workspaceId, ownerMembershipId },
          ],
        },
        { $inc: { newUseGuardRevision: 1 } },
        { returnDocument: 'after', ...options(tx) },
      );
      if (!exercise) throw conflict('EXERCISE_NOT_FOUND');
      exercises.push(exercise);
    }
    return exercises;
  }

  async createTemplate(
    template: ProgramTemplateDocument,
    revision: ProgramTemplateRevisionDocument,
    tx: TransactionContext,
  ) {
    await this.templates.insertOne(template, options(tx));
    await this.templateRevisions.insertOne(revision, options(tx));
    return { template, revision };
  }

  async listTemplates(input: {
    workspaceId: ObjectId;
    ownerMembershipId?: ObjectId;
    includeArchived?: boolean;
    limit?: number;
    afterId?: ObjectId;
  }): Promise<ProgramTemplateDocument[]> {
    return await this.templates
      .find({
        ...(input.includeArchived ? {} : { status: 'ACTIVE' }),
        ...(input.afterId ? { _id: { $gt: input.afterId } } : {}),
        $or: [
          { scope: 'SYSTEM', workspaceId: null },
          { scope: 'GYM', workspaceId: input.workspaceId },
          ...(input.ownerMembershipId
            ? [
                {
                  scope: 'PRIVATE' as const,
                  workspaceId: input.workspaceId,
                  ownerMembershipId: input.ownerMembershipId,
                },
              ]
            : []),
        ],
      })
      .sort({ _id: 1 })
      .limit(input.limit ?? 50)
      .toArray();
  }

  async findTemplateAccessible(
    templateId: ObjectId,
    workspaceId: ObjectId,
    ownerMembershipId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.templates.findOne(
      {
        _id: templateId,
        $or: [
          { scope: 'SYSTEM', workspaceId: null },
          { scope: 'GYM', workspaceId },
          { scope: 'PRIVATE', workspaceId, ownerMembershipId },
        ],
      },
      options(tx),
    );
  }

  async findTemplateRevision(
    templateId: ObjectId,
    revisionId: ObjectId,
    workspaceId: ObjectId | null,
    tx?: TransactionContext,
  ) {
    return await this.templateRevisions.findOne(
      { _id: revisionId, templateId, workspaceId },
      options(tx),
    );
  }

  async createTemplateRevision(
    template: ProgramTemplateDocument,
    expectedVersion: number,
    revision: ProgramTemplateRevisionDocument,
    now: Date,
    tx: TransactionContext,
  ) {
    try {
      await this.templateRevisions.insertOne(revision, options(tx));
      const updated = await this.templates.findOneAndUpdate(
        {
          _id: template._id,
          workspaceId: template.workspaceId ?? null,
          status: 'ACTIVE',
          version: expectedVersion,
        },
        { $set: { currentRevisionId: revision._id, updatedAt: now }, $inc: { version: 1 } },
        { returnDocument: 'after', ...options(tx) },
      );
      if (!updated) throw conflict('PROGRAM_TEMPLATE_VERSION_CONFLICT');
      return { template: updated, revision };
    } catch (error) {
      if (isDuplicate(error)) throw conflict('PROGRAM_TEMPLATE_REVISION_CONFLICT');
      throw error;
    }
  }

  async archiveTemplate(
    templateId: ObjectId,
    workspaceId: ObjectId,
    expectedVersion: number,
    now: Date,
    tx: TransactionContext,
  ) {
    const result = await this.templates.findOneAndUpdate(
      {
        _id: templateId,
        workspaceId,
        status: 'ACTIVE',
        version: expectedVersion,
      },
      {
        $set: { status: 'ARCHIVED', archivedAt: now, updatedAt: now },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result) throw conflict('PROGRAM_TEMPLATE_VERSION_CONFLICT');
    return result;
  }

  async createProgram(
    program: ProgramDocument,
    revision: ProgramRevisionDocument,
    tx: TransactionContext,
  ) {
    await this.programs.insertOne(program, options(tx));
    await this.programRevisions.insertOne(revision, options(tx));
    return { program, revision };
  }

  async listPrograms(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    limit = 50,
    afterId?: ObjectId,
  ) {
    return await this.programs
      .find({
        workspaceId,
        relationshipId,
        ...(afterId ? { _id: { $gt: afterId } } : {}),
      })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
  }

  async findProgram(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    programId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.programs.findOne(
      { _id: programId, workspaceId, relationshipId },
      options(tx),
    );
  }

  async findProgramInWorkspace(
    workspaceId: ObjectId,
    programId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.programs.findOne({ _id: programId, workspaceId }, options(tx));
  }

  async findProgramRevision(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    programId: ObjectId,
    revisionId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.programRevisions.findOne(
      { _id: revisionId, workspaceId, relationshipId, programId },
      options(tx),
    );
  }

  async findProgramRevisionByNumber(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    programId: ObjectId,
    revision: number,
    tx?: TransactionContext,
  ) {
    return await this.programRevisions.findOne(
      { workspaceId, relationshipId, programId, revision },
      options(tx),
    );
  }

  async findProgramRevisionById(workspaceId: ObjectId, programId: ObjectId, revisionId: ObjectId) {
    return await this.programRevisions.findOne({ _id: revisionId, workspaceId, programId });
  }

  async createProgramRevision(
    program: ProgramDocument,
    expectedVersion: number,
    allowedStatuses: ProgramStatus[],
    revision: ProgramRevisionDocument,
    now: Date,
    tx: TransactionContext,
  ) {
    try {
      await this.programRevisions.insertOne(revision, options(tx));
      const updated = await this.programs.findOneAndUpdate(
        {
          _id: program._id,
          workspaceId: program.workspaceId,
          relationshipId: program.relationshipId,
          status: { $in: allowedStatuses },
          version: expectedVersion,
        },
        { $set: { currentRevisionId: revision._id, updatedAt: now }, $inc: { version: 1 } },
        { returnDocument: 'after', ...options(tx) },
      );
      if (!updated) throw conflict('PROGRAM_VERSION_CONFLICT');
      return { program: updated, revision };
    } catch (error) {
      if (isDuplicate(error)) throw conflict('PROGRAM_REVISION_CONFLICT');
      throw error;
    }
  }

  async findActiveProgram(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.programs.findOne(
      { workspaceId, relationshipId, status: 'ACTIVE' },
      options(tx),
    );
  }

  async activateProgram(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    programId: ObjectId;
    expectedVersion: number;
    replacedByProgramId?: ObjectId;
    now: Date;
    tx: TransactionContext;
  }) {
    try {
      const result = await this.programs.findOneAndUpdate(
        {
          _id: input.programId,
          workspaceId: input.workspaceId,
          relationshipId: input.relationshipId,
          status: 'DRAFT',
          version: input.expectedVersion,
        },
        {
          $set: {
            status: 'ACTIVE',
            startedAt: input.now,
            updatedAt: input.now,
          },
          $inc: { version: 1 },
        },
        { returnDocument: 'after', ...options(input.tx) },
      );
      if (!result) throw conflict('PROGRAM_VERSION_CONFLICT');
      return result;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('ACTIVE_PROGRAM_CONFLICT');
      throw error;
    }
  }

  async guardActiveProgramForWorkout(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    programId: ObjectId,
    tx: TransactionContext,
  ) {
    const result = await this.programs.findOneAndUpdate(
      { _id: programId, workspaceId, relationshipId, status: 'ACTIVE' },
      { $inc: { workoutLifecycleRevision: 1 } },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result) throw conflict('PROGRAM_NOT_ACTIVE');
    return result;
  }

  async replaceActiveProgram(
    program: ProgramDocument,
    replacementProgramId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ) {
    const result = await this.programs.findOneAndUpdate(
      {
        _id: program._id,
        workspaceId: program.workspaceId,
        relationshipId: program.relationshipId,
        status: 'ACTIVE',
      },
      {
        $set: {
          status: 'REPLACED',
          endedAt: now,
          replacedByProgramId: replacementProgramId,
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result) throw conflict('PROGRAM_REPLACEMENT_CONFLICT');
    return result;
  }

  async completeProgram(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    programId: ObjectId,
    expectedVersion: number,
    now: Date,
    tx: TransactionContext,
  ) {
    const result = await this.programs.findOneAndUpdate(
      { _id: programId, workspaceId, relationshipId, status: 'ACTIVE', version: expectedVersion },
      {
        $set: { status: 'COMPLETED', endedAt: now, completedAt: now, updatedAt: now },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result) throw conflict('PROGRAM_COMPLETE_INVALID');
    return result;
  }

  async closeActiveProgramForRelationshipEnd(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ) {
    const result = await this.programs.findOneAndUpdate(
      { workspaceId, relationshipId, status: 'ACTIVE' },
      {
        $set: { status: 'COMPLETED', endedAt: now, completedAt: now, updatedAt: now },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...options(tx) },
    );
    return result;
  }

  async archiveProgram(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    programId: ObjectId,
    expectedVersion: number,
    now: Date,
    tx: TransactionContext,
  ) {
    const result = await this.programs.findOneAndUpdate(
      {
        _id: programId,
        workspaceId,
        relationshipId,
        status: { $in: ['DRAFT', 'REPLACED', 'COMPLETED'] },
        version: expectedVersion,
      },
      { $set: { status: 'ARCHIVED', archivedAt: now, updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result) throw conflict('PROGRAM_ARCHIVE_INVALID');
    return result;
  }

  async createProgress(
    progress: ProgramProgressDocument,
    event: ProgramProgressEventDocument,
    tx: TransactionContext,
  ) {
    try {
      await this.progress.insertOne(progress, options(tx));
      await this.progressEvents.insertOne(event, options(tx));
      return progress;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('PROGRAM_PROGRESS_CONFLICT');
      throw error;
    }
  }

  async findProgress(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    programId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.progress.findOne({ workspaceId, relationshipId, programId }, options(tx));
  }

  async guardProgressForWorkoutStart(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    programId: ObjectId,
    currentDaySequence: number,
    tx: TransactionContext,
  ) {
    const result = await this.progress.findOneAndUpdate(
      { workspaceId, relationshipId, programId, currentDaySequence },
      { $inc: { workoutLifecycleRevision: 1 } },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result) throw conflict('PROGRAM_DAY_NOT_CURRENT');
    return result;
  }

  async advanceProgress(
    input: {
      workspaceId: ObjectId;
      relationshipId: ObjectId;
      programId: ObjectId;
      expectedVersion: number;
      currentDaySequence: number;
      nextDaySequence: number;
      kind: 'COMPLETED' | 'SKIPPED';
      programRevisionId: ObjectId;
      workoutSessionId?: ObjectId;
      reason?: string;
      performedBy: ObjectId;
      now: Date;
    },
    tx: TransactionContext,
  ) {
    const update =
      input.kind === 'COMPLETED'
        ? { completedDayCount: 1, version: 1 }
        : { skippedDayCount: 1, version: 1 };
    const result = await this.progress.findOneAndUpdate(
      {
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        programId: input.programId,
        version: input.expectedVersion,
        currentDaySequence: input.currentDaySequence,
      },
      {
        $set: { currentDaySequence: input.nextDaySequence, updatedAt: input.now },
        $inc: update,
      },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result) throw conflict('PROGRAM_PROGRESS_CONFLICT');
    await this.progressEvents.insertOne(
      {
        _id: new ObjectId(),
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        programId: input.programId,
        programRevisionId: input.programRevisionId,
        daySequence: input.currentDaySequence,
        type: input.kind,
        ...(input.workoutSessionId ? { workoutSessionId: input.workoutSessionId } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        performedBy: input.performedBy,
        occurredAt: input.now,
      },
      options(tx),
    );
    return result;
  }

  async deferProgress(
    input: {
      workspaceId: ObjectId;
      relationshipId: ObjectId;
      programId: ObjectId;
      expectedVersion: number;
      programRevisionId: ObjectId;
      currentDaySequence: number;
      reason?: string;
      performedBy: ObjectId;
      now: Date;
    },
    tx: TransactionContext,
  ) {
    const result = await this.progress.findOneAndUpdate(
      {
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        programId: input.programId,
        version: input.expectedVersion,
        currentDaySequence: input.currentDaySequence,
      },
      { $set: { updatedAt: input.now }, $inc: { version: 1 } },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result) throw conflict('PROGRAM_PROGRESS_CONFLICT');
    await this.progressEvents.insertOne(
      {
        _id: new ObjectId(),
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        programId: input.programId,
        programRevisionId: input.programRevisionId,
        daySequence: input.currentDaySequence,
        type: 'DEFERRED',
        ...(input.reason ? { reason: input.reason } : {}),
        performedBy: input.performedBy,
        occurredAt: input.now,
      },
      options(tx),
    );
    return result;
  }

  async countActivePrograms(workspaceId: ObjectId, relationshipId: ObjectId) {
    return await this.programs.countDocuments({ workspaceId, relationshipId, status: 'ACTIVE' });
  }

  async countProgress(workspaceId: ObjectId, relationshipId: ObjectId, programId?: ObjectId) {
    return await this.progress.countDocuments({
      workspaceId,
      relationshipId,
      ...(programId ? { programId } : {}),
    });
  }
}

function options(tx?: TransactionContext) {
  return tx ? { session: tx.session } : undefined;
}

function isDuplicate(error: unknown): error is MongoServerError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The training state has changed.' });
}
