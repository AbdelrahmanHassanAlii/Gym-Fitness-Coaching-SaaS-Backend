import type { Collection, Filter, MongoServerError, ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type {
  PersonalRecordDocument,
  PersonalRecordEventDocument,
  PersonalRecordType,
  WorkoutSessionDocument,
} from './workout.types';

export class WorkoutRepository {
  private readonly workouts: Collection<WorkoutSessionDocument>;
  private readonly records: Collection<PersonalRecordDocument>;
  private readonly recordEvents: Collection<PersonalRecordEventDocument>;

  constructor(database: Database) {
    this.workouts = database.db.collection<WorkoutSessionDocument>('workout_sessions');
    this.records = database.db.collection<PersonalRecordDocument>('personal_records');
    this.recordEvents =
      database.db.collection<PersonalRecordEventDocument>('personal_record_events');
  }

  async create(workout: WorkoutSessionDocument, tx: TransactionContext) {
    try {
      await this.workouts.insertOne(workout, options(tx));
      return workout;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('WORKOUT_ALREADY_IN_PROGRESS');
      throw error;
    }
  }

  async findById(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    workoutId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.workouts.findOne(
      { _id: workoutId, workspaceId, relationshipId },
      options(tx),
    );
  }

  async findCurrent(workspaceId: ObjectId, relationshipId: ObjectId, tx?: TransactionContext) {
    return await this.workouts.findOne(
      { workspaceId, relationshipId, status: 'IN_PROGRESS' },
      options(tx),
    );
  }

  async list(workspaceId: ObjectId, relationshipId: ObjectId, limit = 50, afterId?: ObjectId) {
    return await this.workouts
      .find({ workspaceId, relationshipId, ...(afterId ? { _id: { $gt: afterId } } : {}) })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
  }

  async countInProgressForProgram(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    programId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.workouts.countDocuments(
      { workspaceId, relationshipId, programId, status: 'IN_PROGRESS' },
      options(tx),
    );
  }

  async complete(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    workoutId: ObjectId,
    expectedVersion: number,
    actorId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ) {
    const result = await this.workouts.findOneAndUpdate(
      {
        _id: workoutId,
        workspaceId,
        relationshipId,
        status: 'IN_PROGRESS',
        version: expectedVersion,
      },
      {
        $set: {
          status: 'COMPLETED',
          completedAt: now,
          completedByUserId: actorId,
          traineeEditableUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result) throw conflict('WORKOUT_NOT_IN_PROGRESS');
    return result;
  }

  async abandon(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    workoutId: ObjectId,
    expectedVersion: number,
    actorId: ObjectId,
    reason: string | undefined,
    now: Date,
    tx: TransactionContext,
  ) {
    const result = await this.workouts.findOneAndUpdate(
      {
        _id: workoutId,
        workspaceId,
        relationshipId,
        status: 'IN_PROGRESS',
        version: expectedVersion,
      },
      {
        $set: {
          status: 'ABANDONED',
          abandonedAt: now,
          abandonedByUserId: actorId,
          ...(reason ? { abandonmentReason: reason } : {}),
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result) throw conflict('WORKOUT_NOT_IN_PROGRESS');
    return result;
  }

  async abandonInProgressForRelationship(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    actorId: ObjectId,
    reason: string,
    now: Date,
    tx: TransactionContext,
  ) {
    const result = await this.workouts.updateMany(
      { workspaceId, relationshipId, status: 'IN_PROGRESS' },
      {
        $set: {
          status: 'ABANDONED',
          abandonedAt: now,
          abandonedByUserId: actorId,
          abandonmentReason: reason,
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      options(tx),
    );
    return result.modifiedCount;
  }

  async updateActuals(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    workoutId: ObjectId,
    expectedVersion: number,
    exercises: WorkoutSessionDocument['exercises'],
    patch: { notes?: string; clientMutationId?: string },
    now: Date,
    allowedCompletedAt?: Date,
    allowCompleted = false,
    tx?: TransactionContext,
  ) {
    const statusPredicate: Filter<WorkoutSessionDocument> = allowCompleted
      ? { status: 'COMPLETED' }
      : allowedCompletedAt
        ? {
            $or: [
              { status: 'IN_PROGRESS' },
              { status: 'COMPLETED', traineeEditableUntil: { $gte: allowedCompletedAt } },
            ],
          }
        : { status: 'IN_PROGRESS' };
    const result = await this.workouts.findOneAndUpdate(
      { _id: workoutId, workspaceId, relationshipId, version: expectedVersion, ...statusPredicate },
      {
        $set: {
          exercises,
          ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
          ...(patch.clientMutationId ? { clientMutationId: patch.clientMutationId } : {}),
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result)
      throw conflict(
        allowedCompletedAt ? 'WORKOUT_EDIT_WINDOW_EXPIRED' : 'WORKOUT_VERSION_CONFLICT',
      );
    return result;
  }

  async replaceRecord(record: PersonalRecordDocument, tx: TransactionContext) {
    await this.records.updateOne(
      {
        workspaceId: record.workspaceId,
        relationshipId: record.relationshipId,
        exerciseId: record.exerciseId,
        recordType: record.recordType,
        qualifierKey: record.qualifierKey,
      },
      { $set: record },
      { upsert: true, ...options(tx) },
    );
  }

  async deleteRecord(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    exerciseId: ObjectId,
    recordType: PersonalRecordType,
    qualifierKey: string,
    tx: TransactionContext,
  ) {
    await this.records.deleteOne(
      { workspaceId, relationshipId, exerciseId, recordType, qualifierKey },
      options(tx),
    );
  }

  async findRecord(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    exerciseId: ObjectId,
    recordType: PersonalRecordType,
    qualifierKey: string,
    tx?: TransactionContext,
  ) {
    return await this.records.findOne(
      { workspaceId, relationshipId, exerciseId, recordType, qualifierKey },
      options(tx),
    );
  }

  async insertRecordEvent(event: PersonalRecordEventDocument, tx: TransactionContext) {
    await this.recordEvents.insertOne(event, options(tx));
  }

  async listRecords(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    limit = 50,
    afterId?: ObjectId,
  ) {
    return await this.records
      .find({ workspaceId, relationshipId, ...(afterId ? { _id: { $gt: afterId } } : {}) })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
  }

  async listRecordsForExercises(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    exerciseIds: ObjectId[],
    tx: TransactionContext,
  ) {
    return await this.records
      .find({ workspaceId, relationshipId, exerciseId: { $in: exerciseIds } }, options(tx))
      .toArray();
  }

  async listRecordEvents(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    limit = 50,
    afterId?: ObjectId,
  ) {
    return await this.recordEvents
      .find({ workspaceId, relationshipId, ...(afterId ? { _id: { $gt: afterId } } : {}) })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
  }

  async completedWorkoutsForExercises(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    exerciseIds: ObjectId[],
    tx: TransactionContext,
  ) {
    return await this.workouts
      .find(
        {
          workspaceId,
          relationshipId,
          status: 'COMPLETED',
          'exercises.exerciseId': { $in: exerciseIds },
        },
        options(tx),
      )
      .toArray();
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
  return new AppError({ code, httpStatus: 409, message: 'The workout state has changed.' });
}
