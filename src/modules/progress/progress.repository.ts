import type { Collection, MongoServerError, ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type {
  AdherenceConfigDocument,
  CoachingNoteDocument,
  DailyTrackingEntryDocument,
  MeasurementEntryDocument,
  MetricDefinitionDocument,
  MetricDefinitionScope,
  ProgressPhotoEntryDocument,
  TraineeHealthProfileDocument,
} from './progress.types';

export class ProgressRepository {
  private readonly metrics: Collection<MetricDefinitionDocument>;
  private readonly measurements: Collection<MeasurementEntryDocument>;
  private readonly photos: Collection<ProgressPhotoEntryDocument>;
  private readonly healthProfiles: Collection<TraineeHealthProfileDocument>;
  private readonly notes: Collection<CoachingNoteDocument>;
  private readonly adherenceConfigs: Collection<AdherenceConfigDocument>;
  private readonly dailyTracking: Collection<DailyTrackingEntryDocument>;

  constructor(database: Database) {
    this.metrics = database.db.collection<MetricDefinitionDocument>('metric_definitions');
    this.measurements = database.db.collection<MeasurementEntryDocument>('measurement_entries');
    this.photos = database.db.collection<ProgressPhotoEntryDocument>('progress_photo_entries');
    this.healthProfiles =
      database.db.collection<TraineeHealthProfileDocument>('trainee_health_profiles');
    this.notes = database.db.collection<CoachingNoteDocument>('coaching_notes');
    this.adherenceConfigs = database.db.collection<AdherenceConfigDocument>('adherence_configs');
    this.dailyTracking =
      database.db.collection<DailyTrackingEntryDocument>('daily_tracking_entries');
  }

  async listMetricDefinitions(input: {
    workspaceId: ObjectId;
    ownerMembershipId?: ObjectId;
    includeArchived?: boolean;
    limit?: number;
    afterId?: ObjectId;
  }) {
    return await this.metrics
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

  async createMetricDefinition(metric: MetricDefinitionDocument, tx?: TransactionContext) {
    try {
      await this.metrics.insertOne(metric, opts(tx));
      return metric;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('METRIC_DEFINITION_CONFLICT');
      throw error;
    }
  }

  async findMetricDefinition(metricDefinitionId: ObjectId, tx?: TransactionContext) {
    return await this.metrics.findOne({ _id: metricDefinitionId }, opts(tx));
  }

  async guardMetricForMeasurementUse(input: {
    metricDefinitionId: ObjectId;
    workspaceId: ObjectId;
    ownerMembershipId: ObjectId;
    tx: TransactionContext;
  }) {
    return await this.metrics.findOneAndUpdate(
      {
        _id: input.metricDefinitionId,
        status: 'ACTIVE',
        $or: [
          { scope: 'SYSTEM', workspaceId: null },
          { scope: 'GYM', workspaceId: input.workspaceId },
          {
            scope: 'PRIVATE',
            workspaceId: input.workspaceId,
            ownerMembershipId: input.ownerMembershipId,
          },
        ],
      },
      { $inc: { measurementUseRevision: 1 } },
      { returnDocument: 'after', session: input.tx.session },
    );
  }

  async updateMetricDefinition(input: {
    metricDefinitionId: ObjectId;
    scope: MetricDefinitionScope;
    workspaceId: ObjectId | null;
    ownerMembershipId?: ObjectId;
    expectedVersion: number;
    patch: Partial<MetricDefinitionDocument>;
    tx: TransactionContext;
  }) {
    try {
      const result = await this.metrics.findOneAndUpdate(
        {
          _id: input.metricDefinitionId,
          scope: input.scope,
          workspaceId: input.workspaceId,
          status: 'ACTIVE',
          version: input.expectedVersion,
          ...(input.scope === 'PRIVATE' && input.ownerMembershipId
            ? { ownerMembershipId: input.ownerMembershipId }
            : {}),
        },
        { $set: input.patch, $inc: { version: 1 } },
        { returnDocument: 'after', session: input.tx.session },
      );
      if (!result) throw conflict('METRIC_DEFINITION_VERSION_CONFLICT');
      return result;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('METRIC_DEFINITION_CONFLICT');
      throw error;
    }
  }

  async archiveMetricDefinition(input: {
    metricDefinitionId: ObjectId;
    scope: MetricDefinitionScope;
    workspaceId: ObjectId | null;
    ownerMembershipId?: ObjectId;
    expectedVersion: number;
    actor: ObjectId;
    now: Date;
    tx: TransactionContext;
  }) {
    const result = await this.metrics.findOneAndUpdate(
      {
        _id: input.metricDefinitionId,
        scope: input.scope,
        workspaceId: input.workspaceId,
        status: 'ACTIVE',
        version: input.expectedVersion,
        ...(input.scope === 'PRIVATE' && input.ownerMembershipId
          ? { ownerMembershipId: input.ownerMembershipId }
          : {}),
      },
      {
        $set: {
          status: 'ARCHIVED',
          archivedAt: input.now,
          updatedAt: input.now,
          updatedBy: input.actor,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!result) throw conflict('METRIC_DEFINITION_VERSION_CONFLICT');
    return result;
  }

  async createMeasurement(measurement: MeasurementEntryDocument, tx: TransactionContext) {
    await this.measurements.insertOne(measurement, { session: tx.session });
    return measurement;
  }

  async listMeasurements(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    metricDefinitionId?: ObjectId;
    limit?: number;
    cursor?: { measuredAt: Date; id: ObjectId };
  }) {
    return await this.measurements
      .find({
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        ...(input.metricDefinitionId ? { metricDefinitionId: input.metricDefinitionId } : {}),
        ...(input.cursor
          ? {
              $or: [
                { measuredAt: { $lt: input.cursor.measuredAt } },
                { measuredAt: input.cursor.measuredAt, _id: { $lt: input.cursor.id } },
              ],
            }
          : {}),
      })
      .sort({ measuredAt: -1, _id: -1 })
      .limit(input.limit ?? 50)
      .toArray();
  }

  async findMeasurement(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    measurementId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.measurements.findOne(
      { _id: measurementId, workspaceId, relationshipId },
      opts(tx),
    );
  }

  async updateMeasurement(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    measurementId: ObjectId;
    expectedVersion: number;
    patch: Partial<MeasurementEntryDocument>;
    tx: TransactionContext;
  }) {
    const result = await this.measurements.findOneAndUpdate(
      {
        _id: input.measurementId,
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        version: input.expectedVersion,
      },
      { $set: input.patch, $inc: { version: 1 } },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!result) throw conflict('MEASUREMENT_VERSION_CONFLICT');
    return result;
  }

  async listProgressPhotos(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    traineeSelf: boolean;
    staffVisible: boolean;
    limit?: number;
    cursor?: { capturedAt: Date; id: ObjectId };
  }) {
    const visibilities = [
      ...(input.traineeSelf ? ['PRIVATE' as const, 'TRAINER_VISIBLE' as const] : []),
      ...(input.staffVisible ? ['TRAINER_VISIBLE' as const] : []),
    ];
    if (visibilities.length === 0) return [];
    return await this.photos
      .find({
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        visibility: { $in: [...new Set(visibilities)] },
        ...(input.cursor
          ? {
              $or: [
                { capturedAt: { $lt: input.cursor.capturedAt } },
                { capturedAt: input.cursor.capturedAt, _id: { $lt: input.cursor.id } },
              ],
            }
          : {}),
      })
      .sort({ capturedAt: -1, _id: -1 })
      .limit(input.limit ?? 50)
      .toArray();
  }

  async findHealthProfile(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.healthProfiles.findOne({ workspaceId, relationshipId }, opts(tx));
  }

  async createHealthProfile(profile: TraineeHealthProfileDocument, tx: TransactionContext) {
    try {
      await this.healthProfiles.insertOne(profile, { session: tx.session });
      return profile;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('HEALTH_PROFILE_VERSION_CONFLICT');
      throw error;
    }
  }

  async updateHealthProfile(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    expectedVersion: number;
    patch: Partial<TraineeHealthProfileDocument>;
    tx: TransactionContext;
  }) {
    const result = await this.healthProfiles.findOneAndUpdate(
      {
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        version: input.expectedVersion,
      },
      { $set: input.patch, $inc: { version: 1 } },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!result) throw conflict('HEALTH_PROFILE_VERSION_CONFLICT');
    return result;
  }

  async createNote(note: CoachingNoteDocument, tx: TransactionContext) {
    await this.notes.insertOne(note, { session: tx.session });
    return note;
  }

  async listNotes(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    authorMembershipId?: ObjectId;
    traineeSelf: boolean;
    staffShared: boolean;
    includeArchived?: boolean;
    limit?: number;
    afterId?: ObjectId;
  }) {
    const clauses = [
      ...(input.authorMembershipId ? [{ authorMembershipId: input.authorMembershipId }] : []),
      ...(input.traineeSelf ? [{ visibility: 'SHARED_WITH_TRAINEE' as const }] : []),
      ...(input.staffShared ? [{ visibility: 'SHARED_WITH_TRAINEE' as const }] : []),
    ];
    if (clauses.length === 0) return [];
    return await this.notes
      .find({
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        ...(input.includeArchived ? {} : { status: 'ACTIVE' }),
        ...(input.afterId ? { _id: { $lt: input.afterId } } : {}),
        $or: clauses,
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(input.limit ?? 50)
      .toArray();
  }

  async findNote(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    noteId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.notes.findOne({ _id: noteId, workspaceId, relationshipId }, opts(tx));
  }

  async updateNote(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    noteId: ObjectId;
    authorMembershipId: ObjectId;
    expectedVersion: number;
    patch: Partial<CoachingNoteDocument>;
    tx: TransactionContext;
  }) {
    const result = await this.notes.findOneAndUpdate(
      {
        _id: input.noteId,
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        authorMembershipId: input.authorMembershipId,
        status: 'ACTIVE',
        version: input.expectedVersion,
      },
      { $set: input.patch, $inc: { version: 1 } },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!result) throw conflict('NOTE_VERSION_CONFLICT');
    return result;
  }

  async archiveNote(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    noteId: ObjectId;
    authorMembershipId: ObjectId;
    expectedVersion: number;
    now: Date;
    tx: TransactionContext;
  }) {
    const result = await this.notes.findOneAndUpdate(
      {
        _id: input.noteId,
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        authorMembershipId: input.authorMembershipId,
        status: 'ACTIVE',
        version: input.expectedVersion,
      },
      {
        $set: {
          status: 'ARCHIVED',
          archivedAt: input.now,
          updatedAt: input.now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!result) throw conflict('NOTE_VERSION_CONFLICT');
    return result;
  }

  async findAdherenceConfig(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.adherenceConfigs.findOne({ workspaceId, relationshipId }, opts(tx));
  }

  async createAdherenceConfig(config: AdherenceConfigDocument, tx: TransactionContext) {
    try {
      await this.adherenceConfigs.insertOne(config, { session: tx.session });
      return config;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('ADHERENCE_CONFIG_VERSION_CONFLICT');
      throw error;
    }
  }

  async updateAdherenceConfig(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    expectedVersion: number;
    patch: Partial<AdherenceConfigDocument>;
    tx: TransactionContext;
  }) {
    const result = await this.adherenceConfigs.findOneAndUpdate(
      {
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        version: input.expectedVersion,
      },
      { $set: input.patch, $inc: { version: 1 } },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!result) throw conflict('ADHERENCE_CONFIG_VERSION_CONFLICT');
    return result;
  }

  async findDailyTracking(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    localDate: string,
    tx?: TransactionContext,
  ) {
    return await this.dailyTracking.findOne({ workspaceId, relationshipId, localDate }, opts(tx));
  }

  async createDailyTracking(entry: DailyTrackingEntryDocument, tx: TransactionContext) {
    try {
      await this.dailyTracking.insertOne(entry, { session: tx.session });
      return entry;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('DAILY_TRACKING_VERSION_CONFLICT');
      throw error;
    }
  }

  async updateDailyTracking(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    localDate: string;
    expectedVersion: number;
    patch: Partial<DailyTrackingEntryDocument>;
    tx: TransactionContext;
  }) {
    const result = await this.dailyTracking.findOneAndUpdate(
      {
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        localDate: input.localDate,
        version: input.expectedVersion,
      },
      { $set: input.patch, $inc: { version: 1 } },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!result) throw conflict('DAILY_TRACKING_VERSION_CONFLICT');
    return result;
  }
}

function opts(tx?: TransactionContext) {
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
  return new AppError({ code, httpStatus: 409, message: 'The progress state has changed.' });
}
