import type { Collection, ObjectId, Sort } from 'mongodb';
import type { WorkspaceQueryAccess } from '../../core/access-control/access-control.types';
import type { Database } from '../../core/database/database';
import type { CheckInInstanceDocument } from '../checkins/checkin.types';
import type {
  NutritionPlanDocument,
  NutritionPlanRevisionDocument,
} from '../nutrition/nutrition.types';
import type {
  DailyTrackingEntryDocument,
  MeasurementEntryDocument,
  MetricDefinitionDocument,
  ProgressPhotoEntryDocument,
} from '../progress/progress.types';
import type {
  CoachingRelationshipDocument,
  CoachingRelationshipStatus,
} from '../trainees/trainee.types';
import type { ProgramDocument, ProgramProgressEventDocument } from '../training/training.types';
import type { WorkoutSessionDocument } from '../workouts/workout.types';
import type { BranchDocument, WorkspaceMembershipDocument } from '../workspaces/workspace.types';

export class AnalyticsRepository {
  readonly relationships: Collection<CoachingRelationshipDocument>;
  readonly assignments: Collection<Record<string, unknown>>;
  readonly branches: Collection<BranchDocument>;
  readonly memberships: Collection<WorkspaceMembershipDocument>;
  readonly workouts: Collection<WorkoutSessionDocument>;
  readonly programs: Collection<ProgramDocument>;
  readonly progressEvents: Collection<ProgramProgressEventDocument>;
  readonly personalRecordEvents: Collection<Record<string, unknown>>;
  readonly nutritionPlans: Collection<NutritionPlanDocument>;
  readonly nutritionRevisions: Collection<NutritionPlanRevisionDocument>;
  readonly measurements: Collection<MeasurementEntryDocument>;
  readonly metrics: Collection<MetricDefinitionDocument>;
  readonly photos: Collection<ProgressPhotoEntryDocument>;
  readonly dailyTracking: Collection<DailyTrackingEntryDocument>;
  readonly checkins: Collection<CheckInInstanceDocument>;
  readonly documents: Collection<Record<string, unknown>>;

  constructor(database: Database) {
    this.relationships = database.db.collection('coaching_relationships');
    this.assignments = database.db.collection('trainee_staff_assignments');
    this.branches = database.db.collection('branches');
    this.memberships = database.db.collection('workspace_memberships');
    this.workouts = database.db.collection('workout_sessions');
    this.programs = database.db.collection('programs');
    this.progressEvents = database.db.collection('program_progress_events');
    this.personalRecordEvents = database.db.collection('personal_record_events');
    this.nutritionPlans = database.db.collection('nutrition_plans');
    this.nutritionRevisions = database.db.collection('nutrition_plan_revisions');
    this.measurements = database.db.collection('measurement_entries');
    this.metrics = database.db.collection('metric_definitions');
    this.photos = database.db.collection('progress_photo_entries');
    this.dailyTracking = database.db.collection('daily_tracking_entries');
    this.checkins = database.db.collection('checkin_instances');
    this.documents = database.db.collection('documents');
  }

  async findRelationship(workspaceId: ObjectId, relationshipId: ObjectId) {
    return await this.relationships.findOne({ _id: relationshipId, workspaceId });
  }

  async listRelationshipAssignments(workspaceId: ObjectId, relationshipId: ObjectId) {
    return await this.assignments
      .find({ workspaceId, relationshipId, active: true })
      .sort({ assignmentType: 1 })
      .toArray();
  }

  async relationshipAllowedByAssignment(access: WorkspaceQueryAccess, relationshipId: ObjectId) {
    if (!access.assignedTrainees) return false;
    return Boolean(
      await this.assignments.findOne({
        workspaceId: access.workspaceId,
        relationshipId,
        staffMembershipId: access.membershipId,
        active: true,
      }),
    );
  }

  async countRelationships(
    access: WorkspaceQueryAccess,
    statuses: CoachingRelationshipStatus[] = ['ACTIVE', 'NEEDS_REASSIGNMENT'],
  ) {
    if (
      access.assignedTrainees &&
      !access.workspaceAllowed &&
      access.includeBranchIds.length === 0
    ) {
      const rows = await this.assignments
        .aggregate<{ count: number }>([
          {
            $match: {
              workspaceId: access.workspaceId,
              staffMembershipId: access.membershipId,
              active: true,
            },
          },
          { $group: { _id: '$relationshipId' } },
          {
            $lookup: {
              from: 'coaching_relationships',
              localField: '_id',
              foreignField: '_id',
              as: 'relationship',
            },
          },
          { $unwind: '$relationship' },
          {
            $match: {
              'relationship.status': { $in: statuses },
              ...this.relationshipAccessMatch(access, 'relationship.'),
            },
          },
          { $count: 'count' },
        ])
        .toArray();
      return rows[0]?.count ?? 0;
    }
    return await this.relationships.countDocuments({
      workspaceId: access.workspaceId,
      status: { $in: statuses },
      ...this.relationshipAccessMatch(access),
    });
  }

  async trainerAssignmentRelationshipIds(access: WorkspaceQueryAccess, from: Date) {
    const rows = await this.assignments
      .aggregate<{ _id: ObjectId; firstStartedAt: Date }>([
        {
          $match: {
            workspaceId: access.workspaceId,
            staffMembershipId: access.membershipId,
            assignmentType: { $in: ['PRIMARY_TRAINER', 'ASSISTANT_TRAINER'] },
            active: true,
          },
        },
        { $group: { _id: '$relationshipId', firstStartedAt: { $min: '$startedAt' } } },
        {
          $lookup: {
            from: 'coaching_relationships',
            localField: '_id',
            foreignField: '_id',
            as: 'relationship',
          },
        },
        { $unwind: '$relationship' },
        {
          $match: {
            'relationship.status': 'ACTIVE',
            ...this.relationshipAccessMatch(access, 'relationship.'),
          },
        },
        { $match: { firstStartedAt: { $gte: from } } },
      ])
      .toArray();
    return rows.map((row) => row._id);
  }

  async countCompletedWorkouts(
    access: WorkspaceQueryAccess,
    from: Date,
    to: Date,
    relationshipIds?: ObjectId[],
  ) {
    const scopedIds = relationshipIds ?? (await this.scopedRelationshipIds(access, 10_000));
    if (scopedIds.length === 0) return 0;
    return await this.workouts.countDocuments({
      workspaceId: access.workspaceId,
      relationshipId: { $in: scopedIds },
      status: 'COMPLETED',
      completedAt: { $gte: from, $lt: to },
    });
  }

  async activeStaff(workspaceId: ObjectId) {
    return await this.memberships.countDocuments({
      workspaceId,
      status: 'ACTIVE',
      roles: { $in: ['GYM_OWNER', 'GYM_MANAGER', 'TRAINER', 'ASSISTANT_TRAINER', 'NUTRITIONIST'] },
    });
  }

  async branchPage(
    access: WorkspaceQueryAccess,
    input: { limit: number; cursor?: { name: string; id: ObjectId }; branchId?: ObjectId },
  ) {
    const match: Record<string, unknown> = { workspaceId: access.workspaceId, status: 'ACTIVE' };
    if (input.branchId) match._id = input.branchId;
    if (access.includeBranchIds.length > 0) match._id = { $in: access.includeBranchIds };
    if (access.excludeBranchIds.length > 0) {
      match._id = {
        ...(typeof match._id === 'object' ? (match._id as object) : {}),
        $nin: access.excludeBranchIds,
      };
    }
    if (input.cursor) {
      match.$or = [
        { name: { $gt: input.cursor.name } },
        { name: input.cursor.name, _id: { $gt: input.cursor.id } },
      ];
    }
    return await this.branches
      .find(match)
      .sort({ name: 1, _id: 1 })
      .limit(input.limit + 1)
      .toArray();
  }

  async countCheckins(
    access: WorkspaceQueryAccess,
    statuses: string[],
    relationshipIds?: ObjectId[],
  ) {
    const scopedIds = relationshipIds ?? (await this.scopedRelationshipIds(access, 10_000));
    if (scopedIds.length === 0) return 0;
    return await this.checkins.countDocuments({
      workspaceId: access.workspaceId,
      relationshipId: { $in: scopedIds },
      status: { $in: statuses as never[] },
    });
  }

  async listAttentionCheckins(
    access: WorkspaceQueryAccess,
    status: string,
    limit: number,
    cursor?: { dueAt: Date; id: ObjectId },
  ) {
    const scopedIds = await this.scopedRelationshipIds(access, 10_000);
    if (scopedIds.length === 0) return [];
    return await this.checkins
      .find({
        workspaceId: access.workspaceId,
        relationshipId: { $in: scopedIds },
        status: status as never,
        ...(cursor
          ? {
              $or: [
                { dueAt: { $gt: cursor.dueAt } },
                { dueAt: cursor.dueAt, _id: { $gt: cursor.id } },
              ],
            }
          : {}),
      })
      .sort({ dueAt: 1, _id: 1 })
      .limit(limit + 1)
      .toArray();
  }

  async listAttentionRelationships(
    access: WorkspaceQueryAccess,
    kind:
      | 'NEEDS_REASSIGNMENT'
      | 'NO_ACTIVE_PROGRAM'
      | 'NO_ACTIVE_NUTRITION_PLAN'
      | 'NO_WORKOUT_ACTIVITY_7_DAYS',
    limit: number,
    cutoff?: Date,
    cursor?: ObjectId,
  ) {
    const match = {
      workspaceId: access.workspaceId,
      status: kind === 'NEEDS_REASSIGNMENT' ? 'NEEDS_REASSIGNMENT' : 'ACTIVE',
      ...this.relationshipAccessMatch(access),
      ...(cursor ? { _id: { $gt: cursor } } : {}),
    };
    const pipeline: object[] = [{ $match: match }, { $sort: { _id: 1 } }];
    if (kind === 'NO_ACTIVE_PROGRAM') {
      pipeline.push(
        {
          $lookup: {
            from: 'programs',
            let: { rid: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$relationshipId', '$$rid'] },
                      { $eq: ['$workspaceId', access.workspaceId] },
                      { $eq: ['$status', 'ACTIVE'] },
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: 'activeProgram',
          },
        },
        { $match: { activeProgram: { $size: 0 } } },
      );
    }
    if (kind === 'NO_ACTIVE_NUTRITION_PLAN') {
      pipeline.push(
        {
          $lookup: {
            from: 'nutrition_plans',
            let: { rid: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$relationshipId', '$$rid'] },
                      { $eq: ['$workspaceId', access.workspaceId] },
                      { $eq: ['$status', 'ACTIVE'] },
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: 'activePlan',
          },
        },
        { $match: { activePlan: { $size: 0 } } },
      );
    }
    if (kind === 'NO_WORKOUT_ACTIVITY_7_DAYS') {
      pipeline.push(
        {
          $lookup: {
            from: 'workout_sessions',
            let: { rid: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$relationshipId', '$$rid'] },
                      { $eq: ['$workspaceId', access.workspaceId] },
                      { $eq: ['$status', 'COMPLETED'] },
                      { $gte: ['$completedAt', cutoff] },
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: 'recentWorkout',
          },
        },
        { $match: { recentWorkout: { $size: 0 } } },
      );
    }
    pipeline.push({ $limit: limit + 1 });
    return await this.relationships.aggregate<CoachingRelationshipDocument>(pipeline).toArray();
  }

  async workoutSummary(workspaceId: ObjectId, relationshipId: ObjectId, from: Date, to: Date) {
    return await this.workouts
      .aggregate<{ _id: string; count: number }>([
        {
          $match: {
            workspaceId,
            relationshipId,
            startedAt: { $lt: to },
            $or: [
              { completedAt: { $gte: from, $lt: to } },
              { abandonedAt: { $gte: from, $lt: to } },
              { startedAt: { $gte: from, $lt: to } },
            ],
          },
        },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .toArray();
  }

  async progressEventsSummary(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    from: Date,
    to: Date,
  ) {
    return await this.progressEvents
      .aggregate<{ _id: string; count: number }>([
        {
          $match: {
            workspaceId,
            relationshipId,
            occurredAt: { $gte: from, $lt: to },
            type: { $in: ['COMPLETED', 'SKIPPED', 'DEFERRED'] },
          },
        },
        { $group: { _id: '$type', count: { $sum: 1 } } },
      ])
      .toArray();
  }

  async latestPr(workspaceId: ObjectId, relationshipId: ObjectId) {
    return await this.personalRecordEvents.findOne(
      { workspaceId, relationshipId, eventType: 'ACHIEVED' },
      { sort: { occurredAt: -1, _id: -1 } },
    );
  }

  async countPrs(workspaceId: ObjectId, relationshipId: ObjectId, from: Date, to: Date) {
    return await this.personalRecordEvents.countDocuments({
      workspaceId,
      relationshipId,
      eventType: 'ACHIEVED',
      occurredAt: { $gte: from, $lt: to },
    });
  }

  async measurementPoints(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    metricDefinitionId: ObjectId,
    from: Date,
    to: Date,
  ) {
    return await this.measurements
      .find({
        workspaceId,
        relationshipId,
        metricDefinitionId,
        measuredAt: { $gte: from, $lt: to },
      })
      .sort({ measuredAt: 1, _id: 1 })
      .limit(500)
      .toArray();
  }

  async latestMeasurement(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    metricDefinitionId: ObjectId,
  ) {
    return await this.measurements.findOne(
      { workspaceId, relationshipId, metricDefinitionId },
      { sort: { measuredAt: -1, _id: -1 } },
    );
  }

  async activeMetric(workspaceId: ObjectId, metricDefinitionId?: ObjectId) {
    return await this.metrics.findOne({
      ...(metricDefinitionId ? { _id: metricDefinitionId } : { normalizedKey: 'body_weight' }),
      status: 'ACTIVE',
      $or: [{ workspaceId }, { workspaceId: null }, { workspaceId: { $exists: false } }],
    });
  }

  async activeNutritionPlan(workspaceId: ObjectId, relationshipId: ObjectId) {
    const plan = await this.nutritionPlans.findOne({
      workspaceId,
      relationshipId,
      status: 'ACTIVE',
    });
    const revision = plan
      ? await this.nutritionRevisions.findOne({
          _id: plan.currentRevisionId,
          workspaceId,
          relationshipId,
        })
      : null;
    return { plan, revision };
  }

  async trackingEntries(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    fromDate: string,
    toDate: string,
  ) {
    return await this.dailyTracking
      .find({ workspaceId, relationshipId, localDate: { $gte: fromDate, $lt: toDate } })
      .sort({ localDate: 1 })
      .limit(366)
      .toArray();
  }

  async recentActivity(
    collection: ActivityCollection,
    workspaceId: ObjectId,
    match: Record<string, unknown>,
    sort: Sort,
    limit: number,
  ) {
    return await collection
      .find({ workspaceId, ...match })
      .sort(sort)
      .limit(limit + 1)
      .toArray();
  }

  async scopedRelationshipIds(access: WorkspaceQueryAccess, limit: number) {
    const filter = {
      workspaceId: access.workspaceId,
      status: { $in: ['ACTIVE', 'NEEDS_REASSIGNMENT'] as CoachingRelationshipStatus[] },
      ...this.relationshipAccessMatch(access),
    };
    if (
      access.assignedTrainees &&
      !access.workspaceAllowed &&
      access.includeBranchIds.length === 0
    ) {
      const rows = await this.assignments
        .aggregate<{ _id: ObjectId }>([
          {
            $match: {
              workspaceId: access.workspaceId,
              staffMembershipId: access.membershipId,
              active: true,
            },
          },
          { $group: { _id: '$relationshipId' } },
          {
            $lookup: {
              from: 'coaching_relationships',
              localField: '_id',
              foreignField: '_id',
              as: 'relationship',
            },
          },
          { $unwind: '$relationship' },
          {
            $match: {
              'relationship.status': { $in: ['ACTIVE', 'NEEDS_REASSIGNMENT'] },
              ...this.relationshipAccessMatch(access, 'relationship.'),
            },
          },
          { $limit: limit },
        ])
        .toArray();
      return rows.map((row) => row._id);
    }
    const rows = await this.relationships
      .find(filter, { projection: { _id: 1 } })
      .limit(limit)
      .toArray();
    return rows.map((row) => row._id);
  }

  relationshipAccessMatch(access: WorkspaceQueryAccess, prefix = '') {
    const match: Record<string, unknown> = {};
    const idKey = `${prefix}_id`;
    const branchKey = `${prefix}homeBranchId`;
    if (access.requestedRelationshipId) match[idKey] = access.requestedRelationshipId;
    if (access.requestedBranchId) match[branchKey] = access.requestedBranchId;
    if (access.includeRelationshipIds.length > 0)
      match[idKey] = { $in: access.includeRelationshipIds };
    if (access.excludeRelationshipIds.length > 0) {
      match[idKey] = {
        ...(typeof match[idKey] === 'object' ? (match[idKey] as object) : {}),
        $nin: access.excludeRelationshipIds,
      };
    }
    if (access.includeBranchIds.length > 0) match[branchKey] = { $in: access.includeBranchIds };
    if (access.excludeBranchIds.length > 0) {
      match[branchKey] = {
        ...(typeof match[branchKey] === 'object' ? (match[branchKey] as object) : {}),
        $nin: access.excludeBranchIds,
      };
    }
    return match;
  }
}

type ActivityCollection = Collection<Record<string, unknown>>;
