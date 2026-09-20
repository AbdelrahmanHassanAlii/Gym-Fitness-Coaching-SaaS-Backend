import { ObjectId } from 'mongodb';
import type { AccessControlService } from '../../core/access-control/access-control.service';
import type { WorkspaceQueryAccess } from '../../core/access-control/access-control.types';
import type { AuditWriter } from '../../core/audit/audit.writer';
import { AppError } from '../../core/errors/app-error';
import type { RequestContext } from '../../core/request-context/request-context';
import { Permissions } from '../permissions/permission.registry';
import type { AnalyticsRepository } from './analytics.repository';
import type {
  ActivityCategory,
  AnalyticsRange,
  AttentionCategory,
  CategoryDateIdCursor,
  DateIdCursor,
  Granularity,
  RelationshipAccessContext,
} from './analytics.types';

const attentionCategories: AttentionCategory[] = [
  'CHECKIN_OVERDUE',
  'CHECKIN_PENDING_REVIEW',
  'NO_WORKOUT_ACTIVITY_7_DAYS',
  'NO_ACTIVE_PROGRAM',
  'NO_ACTIVE_NUTRITION_PLAN',
  'NEEDS_REASSIGNMENT',
];

const activityCategories: ActivityCategory[] = [
  'WORKOUT_COMPLETED',
  'PR_ACHIEVED',
  'CHECKIN_SUBMITTED',
  'INBODY_UPLOADED',
];

const trainerDashboardAssignmentTypes = ['PRIMARY_TRAINER', 'ASSISTANT_TRAINER'];

export class AnalyticsApplicationService {
  constructor(
    private readonly repo: AnalyticsRepository,
    private readonly accessControl: AccessControlService,
    private readonly audit: AuditWriter,
  ) {}

  async trainerDashboard(
    ctx: RequestContext,
    workspaceIdParam: string,
    query: Record<string, unknown>,
  ) {
    rejectActivityParams(query);
    const workspaceId = oid(workspaceIdParam, 'WORKSPACE_NOT_FOUND');
    const access = await this.accessControl.resolveWorkspaceQueryAccess(ctx, {
      workspaceId,
      permission: Permissions.DashboardTrainerRead,
    });
    const timezone = await this.workspaceTimezone(workspaceId);
    const range = defaultDashboardRange(timezone);
    const [assignedActiveTrainees, completedWorkouts, overdueCheckIns, pendingReviewCheckIns] =
      await Promise.all([
        this.repo.countTrainerAssignedRelationships(access, ['ACTIVE']),
        this.repo.countTrainerCompletedWorkouts(access, range.from, range.to),
        this.repo.countTrainerCheckins(access, ['OVERDUE']),
        this.repo.countTrainerCheckins(access, ['SUBMITTED']),
      ]);
    const newlyAssignedTrainees = await this.repo.countTrainerNewlyAssignedRelationships(
      access,
      range.from,
    );
    await this.writeSensitive(ctx, workspaceId, 'trainer_dashboard', workspaceId);
    return {
      workspaceId: workspaceId.toHexString(),
      generatedAt: new Date().toISOString(),
      window: serializeRange(range),
      summary: {
        assignedActiveTrainees,
        newlyAssignedTrainees,
        completedWorkouts,
        overdueCheckIns,
        pendingReviewCheckIns,
      },
      needsAttention: await this.needsAttention(access, query, {
        inactivityCutoff: localDaysAgoStart(range.to, timezone, 7),
        assignmentTypes: trainerDashboardAssignmentTypes,
      }),
      recentActivity: null,
      scope: serializeAccess(access),
    };
  }

  async gymDashboard(
    ctx: RequestContext,
    workspaceIdParam: string,
    query: Record<string, unknown>,
  ) {
    const workspaceId = oid(workspaceIdParam, 'WORKSPACE_NOT_FOUND');
    const branchId = maybeOid(query.branchId, 'BRANCH_NOT_FOUND');
    if (branchId && query.branchCursor) throw badRequest('BRANCH_CURSOR_NOT_ALLOWED');
    const access = await this.accessControl.resolveWorkspaceQueryAccess(ctx, {
      workspaceId,
      permission: Permissions.DashboardGymRead,
      ...(branchId ? { branchId } : {}),
    });
    const hasActivityParams = hasAny(query, [
      'activityCategory',
      'activityCursor',
      'activityLimit',
    ]);
    const ownerPure = isOwner(access.roles) && access.pureWorkspaceWide && !branchId;
    if (hasActivityParams && !ownerPure) throw badRequest('RECENT_ACTIVITY_NOT_ALLOWED');
    const timezone = await this.workspaceTimezone(workspaceId);
    const range = defaultDashboardRange(timezone);
    const branchLimit = limit(query.branchLimit, 25, 100);
    const branchCursor = decodeCursor(query.branchCursor);
    const branches = await this.repo.branchPage(access, {
      limit: branchLimit,
      ...(branchCursor ? { cursor: branchCursor } : {}),
      ...(branchId ? { branchId } : {}),
    });
    const branchPage = branches.slice(0, branchLimit);
    const [
      activeTrainees,
      needsReassignment,
      activeStaff,
      completedWorkouts,
      overdueCheckIns,
      pendingReviewCheckIns,
    ] = await Promise.all([
      this.repo.countRelationships(access, ['ACTIVE']),
      this.repo.countRelationships(access, ['NEEDS_REASSIGNMENT']),
      this.repo.activeStaff(workspaceId),
      this.repo.countCompletedWorkouts(access, range.from, range.to),
      this.repo.countCheckins(access, ['OVERDUE']),
      this.repo.countCheckins(access, ['SUBMITTED']),
    ]);
    const branchCounts = await this.repo.branchBreakdown(
      access,
      branchPage.map((branch) => branch._id),
      range.from,
      range.to,
    );
    await this.writeSensitive(ctx, workspaceId, 'gym_dashboard', workspaceId);
    return {
      workspaceId: workspaceId.toHexString(),
      generatedAt: new Date().toISOString(),
      window: serializeRange(range),
      scope: serializeAccess(access),
      summary: {
        activeTrainees,
        needsReassignment,
        activeStaff,
        completedWorkouts,
        overdueCheckIns,
        pendingReviewCheckIns,
      },
      branchBreakdown: {
        items: branchPage.map((branch) => ({
          branchId: branch._id.toHexString(),
          name: branch.name,
          activeTrainees: branchCounts.get(branch._id.toHexString())?.activeTrainees ?? 0,
          needsReassignment: branchCounts.get(branch._id.toHexString())?.needsReassignment ?? 0,
          completedWorkouts: branchCounts.get(branch._id.toHexString())?.completedWorkouts ?? 0,
          overdueCheckIns: branchCounts.get(branch._id.toHexString())?.overdueCheckIns ?? 0,
          pendingReviewCheckIns:
            branchCounts.get(branch._id.toHexString())?.pendingReviewCheckIns ?? 0,
        })),
        hasMore: branches.length > branchLimit,
        nextCursor:
          branches.length > branchLimit
            ? encodeCursor({
                name: branchPage[branchPage.length - 1]?.name,
                id: branchPage[branchPage.length - 1]?._id.toHexString(),
              })
            : null,
      },
      needsAttention: await this.needsAttention(access, query, {
        inactivityCutoff: localDaysAgoStart(range.to, timezone, 7),
      }),
      recentActivity: ownerPure ? await this.recentActivity(workspaceId, range, query) : null,
    };
  }

  async relationshipDashboard(
    ctx: RequestContext,
    workspaceIdParam: string,
    relationshipIdParam: string,
  ) {
    const accessContext = await this.relationshipAccess(
      ctx,
      workspaceIdParam,
      relationshipIdParam,
      Permissions.DashboardRelationshipRead,
    );
    await this.writeSensitive(
      ctx,
      accessContext.access.workspaceId,
      'relationship_dashboard',
      accessContext.relationship._id,
    );
    const visibility = visibilityFor(accessContext.actorKind);
    const assignments = await this.repo.listRelationshipAssignments(
      accessContext.access.workspaceId,
      accessContext.relationship._id,
    );
    return {
      workspaceId: accessContext.access.workspaceId.toHexString(),
      relationshipId: accessContext.relationship._id.toHexString(),
      generatedAt: new Date().toISOString(),
      relationship: {
        status: accessContext.relationship.status,
        traineeUserId:
          accessContext.actorKind === 'TRAINEE'
            ? accessContext.relationship.traineeUserId.toHexString()
            : undefined,
        homeBranchId: accessContext.relationship.homeBranchId?.toHexString() ?? null,
      },
      assignedStaff: assignments.map((assignment) => ({
        assignmentType: assignment.assignmentType,
        startedAt: (assignment.startedAt as Date).toISOString(),
      })),
      training: visibility.training ? await this.trainingAnalyticsFor(accessContext) : null,
      nutrition: visibility.nutrition ? await this.nutritionAnalyticsFor(accessContext) : null,
      progress: visibility.progress ? await this.progressAnalyticsFor(accessContext, {}) : null,
      checkIns: visibility.checkIns
        ? await this.checkinSummary(accessContext, defaultAnalyticsRange(accessContext.timezone))
        : null,
      adherence: await this.adherenceAnalyticsFor(accessContext, {}),
      needsAttention: await this.needsAttention(
        {
          ...accessContext.access,
          requestedRelationshipId: accessContext.relationship._id,
        },
        {},
        {
          inactivityCutoff: localDaysAgoStart(new Date(), accessContext.timezone, 7),
        },
      ),
      access: { actorKind: accessContext.actorKind, sections: visibility },
    };
  }

  async trainingAnalytics(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    query: Record<string, unknown>,
  ) {
    const accessContext = await this.relationshipAccess(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.AnalyticsTrainingRead,
    );
    return await this.trainingAnalyticsFor(accessContext, query);
  }

  async progressAnalytics(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    query: Record<string, unknown>,
  ) {
    const accessContext = await this.relationshipAccess(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.AnalyticsProgressRead,
    );
    await this.writeSensitive(
      ctx,
      accessContext.access.workspaceId,
      'progress_analytics',
      accessContext.relationship._id,
    );
    return await this.progressAnalyticsFor(accessContext, query);
  }

  async nutritionAnalytics(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    query: Record<string, unknown>,
  ) {
    const accessContext = await this.relationshipAccess(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.AnalyticsNutritionRead,
    );
    await this.writeSensitive(
      ctx,
      accessContext.access.workspaceId,
      'nutrition_analytics',
      accessContext.relationship._id,
    );
    return await this.nutritionAnalyticsFor(accessContext, query);
  }

  async adherenceAnalytics(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    query: Record<string, unknown>,
  ) {
    const accessContext = await this.relationshipAccess(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.AnalyticsAdherenceRead,
    );
    await this.writeSensitive(
      ctx,
      accessContext.access.workspaceId,
      'adherence_analytics',
      accessContext.relationship._id,
    );
    return await this.adherenceAnalyticsFor(accessContext, query);
  }

  private async trainingAnalyticsFor(
    input: RelationshipAccessContext,
    query: Record<string, unknown> = {},
  ) {
    assertSection(input, 'training');
    const range = parseRange(query, input.timezone);
    const selectedGranularity = granularity(query.granularity, ['day', 'week'], 'day');
    const [workouts, progressEvents, prCount, latestPr] = await Promise.all([
      this.repo.workoutSummary(
        input.access.workspaceId,
        input.relationship._id,
        range.from,
        range.to,
      ),
      this.repo.progressEventsSummary(
        input.access.workspaceId,
        input.relationship._id,
        range.from,
        range.to,
      ),
      this.repo.countPrs(input.access.workspaceId, input.relationship._id, range.from, range.to),
      this.repo.latestPr(input.access.workspaceId, input.relationship._id),
    ]);
    const workoutCounts = mapCounts(workouts);
    const progressCounts = mapCounts(progressEvents);
    const completed = progressCounts.COMPLETED ?? 0;
    const skipped = progressCounts.SKIPPED ?? 0;
    const series = await this.trainingSeries(input, range, selectedGranularity);
    return {
      workspaceId: input.access.workspaceId.toHexString(),
      relationshipId: input.relationship._id.toHexString(),
      range: serializeRange(range),
      granularity: selectedGranularity,
      summary: {
        startedSessions: sumCounts(workoutCounts),
        completedSessions: workoutCounts.COMPLETED ?? 0,
        abandonedSessions: workoutCounts.ABANDONED ?? 0,
        programDaysCompleted: completed,
        programDaysSkipped: skipped,
        programDaysDeferred: progressCounts.DEFERRED ?? 0,
        workoutAdherenceRate: ratio(completed, completed + skipped),
        prCount,
      },
      series,
      latestPr: latestPr ? latestPrDto(latestPr) : null,
    };
  }

  private async trainingSeries(
    input: RelationshipAccessContext,
    range: AnalyticsRange,
    selectedGranularity: Granularity,
  ) {
    const [workouts, progressEvents] = await Promise.all([
      this.repo.workoutEventsInRange(
        input.access.workspaceId,
        input.relationship._id,
        range.from,
        range.to,
      ),
      this.repo.progressEventsInRange(
        input.access.workspaceId,
        input.relationship._id,
        range.from,
        range.to,
      ),
    ]);
    const buckets = new Map<
      string,
      ReturnType<typeof bucketWindow> & {
        startedSessions: number;
        completedSessions: number;
        abandonedSessions: number;
        programDaysCompleted: number;
        programDaysSkipped: number;
        programDaysDeferred: number;
      }
    >();
    const ensure = (date: Date) => {
      const bucket = bucketWindow(date, range.timezone, selectedGranularity);
      const current = buckets.get(bucket.key);
      if (current) return current;
      const created = {
        ...bucket,
        startedSessions: 0,
        completedSessions: 0,
        abandonedSessions: 0,
        programDaysCompleted: 0,
        programDaysSkipped: 0,
        programDaysDeferred: 0,
      };
      buckets.set(bucket.key, created);
      return created;
    };
    for (const workout of workouts) {
      const eventAt =
        workout.status === 'COMPLETED'
          ? workout.completedAt
          : workout.status === 'ABANDONED'
            ? workout.abandonedAt
            : workout.startedAt;
      if (!eventAt) continue;
      const bucket = ensure(eventAt);
      bucket.startedSessions += 1;
      if (workout.status === 'COMPLETED') bucket.completedSessions += 1;
      if (workout.status === 'ABANDONED') bucket.abandonedSessions += 1;
    }
    for (const event of progressEvents) {
      const bucket = ensure(event.occurredAt);
      if (event.type === 'COMPLETED') bucket.programDaysCompleted += 1;
      if (event.type === 'SKIPPED') bucket.programDaysSkipped += 1;
      if (event.type === 'DEFERRED') bucket.programDaysDeferred += 1;
    }
    return [...buckets.values()]
      .sort((left, right) => left.start.getTime() - right.start.getTime())
      .map((bucket) => ({
        key: bucket.key,
        from: bucket.start.toISOString(),
        to: bucket.end.toISOString(),
        startedSessions: bucket.startedSessions,
        completedSessions: bucket.completedSessions,
        abandonedSessions: bucket.abandonedSessions,
        programDaysCompleted: bucket.programDaysCompleted,
        programDaysSkipped: bucket.programDaysSkipped,
        programDaysDeferred: bucket.programDaysDeferred,
        workoutAdherenceRate: ratio(
          bucket.programDaysCompleted,
          bucket.programDaysCompleted + bucket.programDaysSkipped,
        ),
      }));
  }

  private async progressAnalyticsFor(
    input: RelationshipAccessContext,
    query: Record<string, unknown>,
  ) {
    assertSection(input, 'progress');
    const range = parseRange(query, input.timezone);
    const selectedGranularity = granularity(
      query.granularity,
      ['none', 'day', 'week', 'month'],
      'none',
    );
    const metric = await this.repo.activeMetric(
      input.access.workspaceId,
      maybeOid(query.metricDefinitionId, 'METRIC_DEFINITION_NOT_FOUND'),
    );
    if (!metric) throw notFound('METRIC_DEFINITION_NOT_FOUND');
    const pointLimit = limit(query.limit, 100, 500);
    const pointCursor = decodeDateIdCursor(query.cursor, 'PROGRESS_CURSOR_INVALID');
    const [points, edges, photoCount, bucketPoints] = await Promise.all([
      this.repo.measurementPoints(
        input.access.workspaceId,
        input.relationship._id,
        metric._id,
        range.from,
        range.to,
        pointLimit,
        pointCursor,
      ),
      this.repo.measurementWindowEdges(
        input.access.workspaceId,
        input.relationship._id,
        metric._id,
        range.from,
        range.to,
      ),
      this.repo.countVisibleProgressPhotos({
        workspaceId: input.access.workspaceId,
        relationshipId: input.relationship._id,
        traineeSelf: input.actorKind === 'TRAINEE',
        staffVisible: ['OWNER', 'MANAGER', 'TRAINER', 'ASSISTANT_TRAINER'].includes(
          input.actorKind,
        ),
      }),
      selectedGranularity === 'none'
        ? Promise.resolve([])
        : this.repo.measurementsInRange(
            input.access.workspaceId,
            input.relationship._id,
            metric._id,
            range.from,
            range.to,
          ),
    ]);
    const pagePoints = points.slice(0, pointLimit);
    const first = edges.firstInWindow;
    const last = edges.latestInWindow;
    const delta = first && last ? round2(last.value - first.value) : null;
    return {
      workspaceId: input.access.workspaceId.toHexString(),
      relationshipId: input.relationship._id.toHexString(),
      range: serializeRange(range),
      metricDefinitionId: metric._id.toHexString(),
      summary: {
        firstInWindow: first ? measurementDto(first, metric) : null,
        latestInWindow: last ? measurementDto(last, metric) : null,
        latest: edges.latest ? measurementDto(edges.latest, metric) : null,
        delta,
        percentChange:
          first && last && first.value !== 0
            ? round4((last.value - first.value) / first.value)
            : null,
      },
      points: pagePoints.map((point) => measurementDto(point, metric)),
      page: pageFromItems(points, pointLimit, (item) =>
        encodeDateIdCursor(item.measuredAt, item._id),
      ),
      buckets: progressBuckets(bucketPoints, metric, range, selectedGranularity),
      photoSummary: { count: photoCount },
    };
  }

  private async nutritionAnalyticsFor(
    input: RelationshipAccessContext,
    query: Record<string, unknown> = {},
  ) {
    assertSection(input, 'nutrition');
    const range = parseRange(query, input.timezone);
    const selectedGranularity = granularity(query.granularity, ['day', 'week'], 'day');
    const plan = await this.repo.activeNutritionPlan(
      input.access.workspaceId,
      input.relationship._id,
    );
    const dates = localDateBounds(range);
    const tracking = await this.repo.trackingEntries(
      input.access.workspaceId,
      input.relationship._id,
      dates.from,
      dates.to,
    );
    const nutritionDays = tracking.filter((entry) => entry.values.NUTRITION);
    const waterDays = tracking.filter((entry) => entry.values.WATER);
    return {
      workspaceId: input.access.workspaceId.toHexString(),
      relationshipId: input.relationship._id.toHexString(),
      range: serializeRange(range),
      activePlan: plan.plan ? { id: plan.plan._id.toHexString(), name: plan.plan.name } : null,
      targets: plan.revision
        ? {
            targetCalories: plan.revision.targetCalories ?? null,
            targetProteinG: plan.revision.targetProteinG ?? null,
            targetCarbsG: plan.revision.targetCarbsG ?? null,
            targetFatG: plan.revision.targetFatG ?? null,
            waterTargetMl: plan.revision.waterTargetMl ?? null,
          }
        : null,
      nutritionTracking: {
        daysTracked: nutritionDays.length,
        averageAdherenceRate: averageRatioFromPercent(
          nutritionDays.map((entry) => entry.values.NUTRITION?.adherencePercent),
        ),
      },
      waterTracking: {
        daysTracked: waterDays.length,
        averageMl: average(waterDays.map((entry) => entry.values.WATER?.ml)),
        targetMl: plan.revision?.waterTargetMl ?? null,
      },
      series: nutritionSeries(tracking, range, selectedGranularity, plan.revision?.waterTargetMl),
    };
  }

  private async adherenceAnalyticsFor(
    input: RelationshipAccessContext,
    query: Record<string, unknown>,
  ) {
    const visibility = visibilityFor(input.actorKind);
    const range = parseRange(query, input.timezone);
    const selectedGranularity = granularity(query.granularity, ['day', 'week'], 'day');
    const [training, checkIns, checkInSeriesValue, nutrition] = await Promise.all([
      visibility.training ? this.trainingAnalyticsFor(input, query) : Promise.resolve(null),
      visibility.checkIns ? this.checkinSummary(input, range) : Promise.resolve(null),
      visibility.checkIns
        ? this.checkinSeries(input, range, selectedGranularity)
        : Promise.resolve(null),
      visibility.nutrition ? this.nutritionAnalyticsFor(input, query) : Promise.resolve(null),
    ]);
    return {
      workspaceId: input.access.workspaceId.toHexString(),
      relationshipId: input.relationship._id.toHexString(),
      range: serializeRange(range),
      granularity: selectedGranularity,
      training: training?.summary ?? null,
      checkIns,
      nutrition: nutrition?.nutritionTracking ?? null,
      water: nutrition?.waterTracking ?? null,
      series: adherenceSeries(
        training?.series,
        checkInSeriesValue,
        nutrition?.series,
        selectedGranularity,
      ),
    };
  }

  private async checkinSummary(input: RelationshipAccessContext, range: AnalyticsRange) {
    const rows = await this.repo.checkins
      .aggregate<{ _id: string; count: number }>([
        {
          $match: {
            workspaceId: input.access.workspaceId,
            relationshipId: input.relationship._id,
            dueAt: { $gte: range.from, $lt: range.to },
            status: { $in: ['DUE', 'OVERDUE', 'SUBMITTED', 'REVIEWED'] },
          },
        },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .toArray();
    const counts = mapCounts(rows);
    const numerator = (counts.SUBMITTED ?? 0) + (counts.REVIEWED ?? 0);
    const denominator = sumCounts(counts);
    return {
      dueCount: denominator,
      submittedOrReviewedCount: numerator,
      complianceRate: ratio(numerator, denominator),
    };
  }

  private async checkinSeries(
    input: RelationshipAccessContext,
    range: AnalyticsRange,
    selectedGranularity: Granularity,
  ) {
    const checkins = await this.repo.checkinsInRange(
      input.access.workspaceId,
      input.relationship._id,
      range.from,
      range.to,
    );
    const buckets = new Map<
      string,
      ReturnType<typeof bucketWindow> & { numerator: number; denominator: number }
    >();
    const ensure = (date: Date) => {
      const bucket = bucketWindow(date, range.timezone, selectedGranularity);
      const current = buckets.get(bucket.key);
      if (current) return current;
      const created = { ...bucket, numerator: 0, denominator: 0 };
      buckets.set(bucket.key, created);
      return created;
    };
    for (const checkin of checkins) {
      const bucket = ensure(checkin.dueAt);
      bucket.denominator += 1;
      if (checkin.status === 'SUBMITTED' || checkin.status === 'REVIEWED') {
        bucket.numerator += 1;
      }
    }
    return [...buckets.values()]
      .sort((left, right) => left.start.getTime() - right.start.getTime())
      .map((bucket) => ({
        key: bucket.key,
        from: bucket.start.toISOString(),
        to: bucket.end.toISOString(),
        dueCount: bucket.denominator,
        submittedOrReviewedCount: bucket.numerator,
        complianceRate: ratio(bucket.numerator, bucket.denominator),
      }));
  }

  private async relationshipAccess(
    ctx: RequestContext,
    workspaceIdParam: string,
    relationshipIdParam: string,
    permission: string,
  ): Promise<RelationshipAccessContext> {
    const workspaceId = oid(workspaceIdParam, 'WORKSPACE_NOT_FOUND');
    const relationshipId = oid(relationshipIdParam, 'RELATIONSHIP_NOT_FOUND');
    const access = await this.accessControl.resolveWorkspaceQueryAccess(ctx, {
      workspaceId,
      relationshipId,
      permission,
    });
    const timezone = await this.workspaceTimezone(workspaceId);
    const relationship = await this.repo.findRelationship(workspaceId, relationshipId);
    if (!relationship) throw notFound('RELATIONSHIP_NOT_FOUND');
    if (!['ACTIVE', 'NEEDS_REASSIGNMENT'].includes(relationship.status)) {
      throw permissionDenied('RELATIONSHIP_NOT_ACCESSIBLE');
    }
    if (!stage4AllowsRelationship(access, relationship)) {
      throw permissionDenied('PERMISSION_DENIED');
    }
    const actor = await this.relationshipActorKind(access, relationship);
    if (actor === 'OTHER') throw permissionDenied('PERMISSION_DENIED');
    return { access, timezone, relationship, actorKind: actor };
  }

  private async workspaceTimezone(workspaceId: ObjectId) {
    const timezone = await this.repo.workspaceTimezone(workspaceId);
    if (!timezone || !isValidTimezone(timezone)) throw badRequest('WORKSPACE_TIMEZONE_INVALID');
    return timezone;
  }

  private async relationshipActorKind(
    access: WorkspaceQueryAccess,
    relationship: RelationshipAccessContext['relationship'],
  ): Promise<RelationshipAccessContext['actorKind']> {
    if (access.roles.includes('GYM_OWNER')) return 'OWNER';
    if (
      access.roles.includes('GYM_MANAGER') &&
      relationship.homeBranchId &&
      (await this.repo.membershipAssignedToBranch(access, relationship.homeBranchId))
    ) {
      return 'MANAGER';
    }
    if (
      access.roles.includes('TRAINER') &&
      (await this.repo.activeAssignmentForRelationship(access, relationship._id, [
        'PRIMARY_TRAINER',
      ]))
    ) {
      return 'TRAINER';
    }
    if (
      access.roles.includes('ASSISTANT_TRAINER') &&
      (await this.repo.activeAssignmentForRelationship(access, relationship._id, [
        'ASSISTANT_TRAINER',
      ]))
    ) {
      return 'ASSISTANT_TRAINER';
    }
    if (
      access.roles.includes('NUTRITIONIST') &&
      (await this.repo.activeAssignmentForRelationship(access, relationship._id, ['NUTRITIONIST']))
    ) {
      return 'NUTRITIONIST';
    }
    if (access.self && relationship.traineeUserId.equals(access.userId)) return 'TRAINEE';
    return 'OTHER';
  }

  private async needsAttention(
    access: WorkspaceQueryAccess,
    query: Record<string, unknown>,
    options: { inactivityCutoff: Date; assignmentTypes?: string[] },
  ) {
    const requestedCategory = query.attentionCategory as AttentionCategory | undefined;
    if (requestedCategory && !attentionCategories.includes(requestedCategory)) {
      throw badRequest('ATTENTION_CATEGORY_INVALID');
    }
    if (query.attentionCursor && !requestedCategory) {
      throw badRequest('ATTENTION_CURSOR_REQUIRES_CATEGORY');
    }
    const limitValue = limit(query.attentionLimit, 5, 20);
    const categories = requestedCategory ? [requestedCategory] : attentionCategories;
    const result: Record<string, unknown> = {};
    for (const category of categories) {
      result[category] = await this.attentionCategory(
        access,
        category,
        limitValue,
        query.attentionCursor,
        options,
      );
    }
    return result;
  }

  private async attentionCategory(
    access: WorkspaceQueryAccess,
    category: AttentionCategory,
    limitValue: number,
    cursorValue?: unknown,
    options?: { inactivityCutoff: Date; assignmentTypes?: string[] },
  ) {
    if (category === 'CHECKIN_OVERDUE' || category === 'CHECKIN_PENDING_REVIEW') {
      const status = category === 'CHECKIN_OVERDUE' ? 'OVERDUE' : 'SUBMITTED';
      const cursor = decodeDateIdCursor(cursorValue, 'ATTENTION_CURSOR_INVALID');
      const [items, count] = await Promise.all([
        this.repo.listAttentionCheckins(
          access,
          status,
          limitValue,
          cursor ? { dueAt: cursor.occurredAt, id: cursor.id } : undefined,
          options?.assignmentTypes,
        ),
        this.repo.countCheckins(access, [status], options?.assignmentTypes),
      ]);
      return page(
        items,
        limitValue,
        (item) => ({
          relationshipId: item.relationshipId.toHexString(),
          checkInId: item._id.toHexString(),
          dueAt: item.dueAt.toISOString(),
          severity: category === 'CHECKIN_OVERDUE' ? 'high' : 'medium',
        }),
        count,
      );
    }
    const cursor = decodeObjectIdCursor(cursorValue, 'ATTENTION_CURSOR_INVALID');
    const rows = await this.repo.listAttentionRelationships(
      access,
      category,
      limitValue,
      options?.inactivityCutoff,
      cursor,
      options?.assignmentTypes,
    );
    return relationshipAttentionPage(
      rows,
      limitValue,
      (item) => ({
        relationshipId: item._id.toHexString(),
        severity:
          category === 'NEEDS_REASSIGNMENT'
            ? 'high'
            : category === 'NO_ACTIVE_NUTRITION_PLAN'
              ? 'low'
              : 'medium',
      }),
      category === 'NEEDS_REASSIGNMENT'
        ? await this.repo.countRelationships(
            access,
            ['NEEDS_REASSIGNMENT'],
            options?.assignmentTypes,
          )
        : null,
    );
  }

  private async recentActivity(
    workspaceId: ObjectId,
    range: AnalyticsRange,
    query: Record<string, unknown>,
  ) {
    const requestedCategory = query.activityCategory as ActivityCategory | undefined;
    if (requestedCategory && !activityCategories.includes(requestedCategory)) {
      throw badRequest('ACTIVITY_CATEGORY_INVALID');
    }
    if (query.activityCursor && !requestedCategory) {
      throw badRequest('ACTIVITY_CURSOR_REQUIRES_CATEGORY');
    }
    const cursor = decodeActivityCursor(
      query.activityCursor,
      requestedCategory,
      'ACTIVITY_CURSOR_INVALID',
    );
    const limitValue = limit(query.activityLimit, 5, 20);
    const categories = requestedCategory ? [requestedCategory] : activityCategories;
    const result: Record<string, unknown> = {};
    for (const category of categories) {
      result[category] = await this.activityCategory(
        workspaceId,
        range,
        category,
        limitValue,
        cursor,
      );
    }
    return result;
  }

  private async activityCategory(
    workspaceId: ObjectId,
    range: AnalyticsRange,
    category: ActivityCategory,
    limitValue: number,
    cursor?: DateIdCursor,
  ) {
    const source =
      category === 'WORKOUT_COMPLETED'
        ? await this.repo.recentActivity(
            this.repo.workouts as never,
            workspaceId,
            { status: 'COMPLETED', completedAt: { $gte: range.from, $lt: range.to } },
            { completedAt: -1, _id: -1 },
            limitValue,
            'completedAt',
            cursor,
          )
        : category === 'PR_ACHIEVED'
          ? await this.repo.recentActivity(
              this.repo.personalRecordEvents,
              workspaceId,
              { eventType: 'ACHIEVED', occurredAt: { $gte: range.from, $lt: range.to } },
              { occurredAt: -1, _id: -1 },
              limitValue,
              'occurredAt',
              cursor,
            )
          : category === 'CHECKIN_SUBMITTED'
            ? await this.repo.recentActivity(
                this.repo.checkins as never,
                workspaceId,
                {
                  status: { $in: ['SUBMITTED', 'REVIEWED'] },
                  submittedAt: { $gte: range.from, $lt: range.to },
                },
                { submittedAt: -1, _id: -1 },
                limitValue,
                'submittedAt',
                cursor,
              )
            : await this.repo.recentActivity(
                this.repo.documents,
                workspaceId,
                {
                  category: 'INBODY',
                  status: 'ACTIVE',
                  createdAt: { $gte: range.from, $lt: range.to },
                },
                { createdAt: -1, _id: -1 },
                limitValue,
                'createdAt',
                cursor,
              );
    const timeField = activityTimeField(category);
    return {
      count: null,
      items: source.slice(0, limitValue).map((item) => activityItem(category, item, timeField)),
      ...pageFromItems(source, limitValue, (item) =>
        encodeActivityCursor(category, item[timeField] as Date, item._id as ObjectId),
      ),
    };
  }

  private async writeSensitive(
    ctx: RequestContext,
    workspaceId: ObjectId,
    kind: string,
    resourceId: ObjectId,
  ) {
    await this.audit.writeSensitiveResourceAccess({
      workspaceId,
      actor: {
        ...(ctx.userId ? { userId: new ObjectId(ctx.userId) } : {}),
        ...(ctx.workspaceMembershipId
          ? { workspaceMembershipId: new ObjectId(ctx.workspaceMembershipId) }
          : {}),
        ...(ctx.platformMembershipId
          ? { platformMembershipId: new ObjectId(ctx.platformMembershipId) }
          : {}),
      },
      ...(ctx.supportSessionId ? { supportSessionId: new ObjectId(ctx.supportSessionId) } : {}),
      resourceType: 'analytics',
      resourceId,
      entity: { type: 'analytics', id: resourceId },
      accessKind: kind,
      correlationId: ctx.correlationId,
      ipAddress: ctx.ipAddress,
    });
  }
}

function visibilityFor(actor: RelationshipAccessContext['actorKind']) {
  return {
    training: ['OWNER', 'MANAGER', 'TRAINER', 'ASSISTANT_TRAINER', 'TRAINEE'].includes(actor),
    nutrition: ['OWNER', 'MANAGER', 'TRAINER', 'NUTRITIONIST', 'TRAINEE'].includes(actor),
    progress: ['OWNER', 'MANAGER', 'TRAINER', 'ASSISTANT_TRAINER', 'TRAINEE'].includes(actor),
    checkIns: ['OWNER', 'MANAGER', 'TRAINER', 'ASSISTANT_TRAINER', 'TRAINEE'].includes(actor),
  };
}

function assertSection(
  input: RelationshipAccessContext,
  section: keyof ReturnType<typeof visibilityFor>,
) {
  if (!visibilityFor(input.actorKind)[section]) throw permissionDenied('PERMISSION_DENIED');
}

function isOwner(roles: string[]) {
  return roles.includes('GYM_OWNER');
}

function stage4AllowsRelationship(
  access: WorkspaceQueryAccess,
  relationship: RelationshipAccessContext['relationship'],
) {
  if (access.excludeRelationshipIds.some((id) => id.equals(relationship._id))) return false;
  if (
    relationship.homeBranchId &&
    access.excludeBranchIds.some((id) => id.equals(relationship.homeBranchId))
  ) {
    return false;
  }
  if (access.includeRelationshipIds.length > 0) {
    return access.includeRelationshipIds.some((id) => id.equals(relationship._id));
  }
  if (access.includeBranchIds.length > 0) {
    return Boolean(
      relationship.homeBranchId &&
        access.includeBranchIds.some((id) => id.equals(relationship.homeBranchId)),
    );
  }
  return access.workspaceAllowed || access.assignedTrainees || access.self;
}

function parseRange(query: Record<string, unknown>, timezone: string): AnalyticsRange {
  const now = new Date();
  const from = query.from
    ? parseDate(String(query.from), 'from', timezone)
    : localDaysAgoStart(now, timezone, 29);
  const to = query.to ? parseDate(String(query.to), 'to', timezone) : now;
  if (to.getTime() <= from.getTime()) throw badRequest('DATE_RANGE_INVALID');
  if (localDaySpan(from, to, timezone) > 366) {
    throw badRequest('DATE_RANGE_TOO_LARGE');
  }
  return { from, to, timezone };
}

function defaultAnalyticsRange(timezone: string): AnalyticsRange {
  return parseRange({}, timezone);
}

function defaultDashboardRange(timezone: string): AnalyticsRange {
  return defaultAnalyticsRange(timezone);
}

function parseDate(value: string, field: string, timezone: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year = 0, month = 1, day = 1] = value.split('-').map(Number);
    return utcFromLocal(timezone, year, month, day);
  }
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(value))
    throw badRequest(`${field.toUpperCase()}_TIMEZONE_REQUIRED`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${field.toUpperCase()}_INVALID`);
  return date;
}

function serializeRange(range: AnalyticsRange) {
  return { from: range.from.toISOString(), to: range.to.toISOString(), timezone: range.timezone };
}

function localDateBounds(range: AnalyticsRange) {
  return {
    from: localDateString(range.from, range.timezone),
    to: localDateString(range.to, range.timezone),
  };
}

function oid(value: string, code: string) {
  if (!ObjectId.isValid(value)) throw notFound(code);
  return new ObjectId(value);
}

function maybeOid(value: unknown, code: string) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !ObjectId.isValid(value)) throw notFound(code);
  return new ObjectId(value);
}

function limit(value: unknown, defaultValue: number, max: number) {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw badRequest('LIMIT_INVALID');
  return parsed;
}

function hasAny(query: Record<string, unknown>, keys: string[]) {
  return keys.some((key) => query[key] !== undefined);
}

function rejectActivityParams(query: Record<string, unknown>) {
  if (hasAny(query, ['activityCategory', 'activityCursor', 'activityLimit'])) {
    throw badRequest('RECENT_ACTIVITY_NOT_ALLOWED');
  }
}

function encodeCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(value: unknown) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')) as {
      name: string;
      id: string;
    };
    return { name: parsed.name, id: oid(parsed.id, 'CURSOR_INVALID') };
  } catch {
    throw badRequest('CURSOR_INVALID');
  }
}

function decodeDateIdCursor(value: unknown, code: string) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')) as {
      occurredAt?: string;
      id?: string;
    };
    const occurredAt = new Date(String(parsed.occurredAt));
    if (Number.isNaN(occurredAt.getTime()) || !parsed.id || !ObjectId.isValid(parsed.id)) {
      throw new Error('invalid cursor');
    }
    return { occurredAt, id: new ObjectId(parsed.id) };
  } catch {
    throw badRequest(code);
  }
}

function decodeObjectIdCursor(value: unknown, code: string) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')) as {
      id?: string;
    };
    if (!parsed.id || !ObjectId.isValid(parsed.id)) throw new Error('invalid cursor');
    return new ObjectId(parsed.id);
  } catch {
    throw badRequest(code);
  }
}

function decodeActivityCursor(
  value: unknown,
  category: ActivityCategory | undefined,
  code: string,
): CategoryDateIdCursor | undefined {
  if (!value) return undefined;
  if (!category) throw badRequest(code);
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')) as {
      category?: ActivityCategory;
      occurredAt?: string;
      id?: string;
    };
    const occurredAt = new Date(String(parsed.occurredAt));
    if (
      parsed.category !== category ||
      !activityCategories.includes(parsed.category as ActivityCategory) ||
      Number.isNaN(occurredAt.getTime()) ||
      !parsed.id ||
      !ObjectId.isValid(parsed.id)
    ) {
      throw new Error('invalid cursor');
    }
    return { category: parsed.category, occurredAt, id: new ObjectId(parsed.id) };
  } catch {
    throw badRequest(code);
  }
}

function page<T>(items: T[], limitValue: number, map: (item: T) => unknown, count: number | null) {
  const sliced = items.slice(0, limitValue);
  const last = sliced[sliced.length - 1] as Record<string, unknown> | undefined;
  return {
    ...(count === null ? { count: null } : { count }),
    items: sliced.map(map),
    hasMore: items.length > limitValue,
    nextCursor:
      items.length > limitValue && last
        ? encodeCursor({
            occurredAt: last.dueAt instanceof Date ? last.dueAt.toISOString() : undefined,
            id: (last._id as ObjectId | undefined)?.toHexString(),
          })
        : null,
  };
}

function relationshipAttentionPage<T extends { _id: ObjectId }>(
  items: T[],
  limitValue: number,
  map: (item: T) => unknown,
  count: number | null,
) {
  const sliced = items.slice(0, limitValue);
  const last = sliced[sliced.length - 1];
  return {
    ...(count === null ? { count: null } : { count }),
    items: sliced.map(map),
    hasMore: items.length > limitValue,
    nextCursor:
      items.length > limitValue && last ? encodeCursor({ id: last._id.toHexString() }) : null,
  };
}

function pageFromItems<T>(items: T[], limitValue: number, cursorFor: (item: T) => string) {
  const sliced = items.slice(0, limitValue);
  const last = sliced[sliced.length - 1];
  return {
    hasMore: items.length > limitValue,
    nextCursor: items.length > limitValue && last ? cursorFor(last) : null,
  };
}

function mapCounts(rows: Array<{ _id: string; count: number }>) {
  return Object.fromEntries(rows.map((row) => [row._id, row.count])) as Record<string, number>;
}

function sumCounts(counts: Record<string, number>) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? null : round4(numerator / denominator);
}

function average(values: Array<number | undefined>) {
  const present = values.filter((value): value is number => typeof value === 'number');
  if (present.length === 0) return null;
  return round2(present.reduce((sum, value) => sum + value, 0) / present.length);
}

function averageRatioFromPercent(values: Array<number | undefined>) {
  const present = values.filter((value): value is number => typeof value === 'number');
  if (present.length === 0) return null;
  return round4(present.reduce((sum, value) => sum + value / 100, 0) / present.length);
}

function progressBuckets(
  points: Array<{ value: number; measuredAt: Date; _id: ObjectId }>,
  metric: { _id: ObjectId; unit: string; key?: string; name: string },
  range: AnalyticsRange,
  selectedGranularity: Granularity,
) {
  if (selectedGranularity === 'none') return [];
  const latestByBucket = new Map<
    string,
    ReturnType<typeof bucketWindow> & { point: { value: number; measuredAt: Date; _id: ObjectId } }
  >();
  for (const point of points) {
    const bucket = bucketWindow(point.measuredAt, range.timezone, selectedGranularity);
    const current = latestByBucket.get(bucket.key);
    if (
      !current ||
      point.measuredAt > current.point.measuredAt ||
      (point.measuredAt.getTime() === current.point.measuredAt.getTime() &&
        point._id.toHexString() > current.point._id.toHexString())
    ) {
      latestByBucket.set(bucket.key, { ...bucket, point });
    }
  }
  return [...latestByBucket.values()]
    .sort((left, right) => left.start.getTime() - right.start.getTime())
    .map((bucket) => ({
      key: bucket.key,
      from: bucket.start.toISOString(),
      to: bucket.end.toISOString(),
      latest: measurementDto(bucket.point, metric),
    }));
}

function nutritionSeries(
  entries: Array<{
    localDate: string;
    values: { NUTRITION?: { adherencePercent?: number }; WATER?: { ml?: number } };
  }>,
  range: AnalyticsRange,
  selectedGranularity: Granularity,
  waterTargetMl?: number | null,
) {
  const buckets = new Map<
    string,
    ReturnType<typeof bucketWindow> & {
      nutritionRates: number[];
      waterMl: number[];
    }
  >();
  const ensure = (localDate: string) => {
    const bucket = bucketWindow(
      localDateInstant(localDate, range.timezone),
      range.timezone,
      selectedGranularity,
    );
    const current = buckets.get(bucket.key);
    if (current) return current;
    const created = { ...bucket, nutritionRates: [], waterMl: [] };
    buckets.set(bucket.key, created);
    return created;
  };
  for (const entry of entries) {
    const bucket = ensure(entry.localDate);
    if (typeof entry.values.NUTRITION?.adherencePercent === 'number') {
      bucket.nutritionRates.push(entry.values.NUTRITION.adherencePercent / 100);
    }
    if (typeof entry.values.WATER?.ml === 'number') bucket.waterMl.push(entry.values.WATER.ml);
  }
  return [...buckets.values()]
    .sort((left, right) => left.start.getTime() - right.start.getTime())
    .map((bucket) => {
      const averageWaterMl =
        bucket.waterMl.length > 0
          ? round2(bucket.waterMl.reduce((sum, value) => sum + value, 0) / bucket.waterMl.length)
          : null;
      const waterAdherenceRate =
        averageWaterMl !== null && waterTargetMl && waterTargetMl > 0
          ? round4(Math.min(averageWaterMl / waterTargetMl, 1))
          : null;
      return {
        key: bucket.key,
        from: bucket.start.toISOString(),
        to: bucket.end.toISOString(),
        nutritionAdherenceRate:
          bucket.nutritionRates.length > 0
            ? round4(
                bucket.nutritionRates.reduce((sum, value) => sum + value, 0) /
                  bucket.nutritionRates.length,
              )
            : null,
        averageWaterMl,
        waterAdherenceRate,
      };
    });
}

function adherenceSeries(
  trainingSeriesValue: unknown,
  checkInSeriesValue: unknown,
  nutritionSeriesValue: unknown,
  selectedGranularity: Granularity,
) {
  if (selectedGranularity === 'none') return [];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const item of Array.isArray(trainingSeriesValue) ? trainingSeriesValue : []) {
    const row = item as Record<string, unknown>;
    byKey.set(String(row.key), {
      key: row.key,
      from: row.from,
      to: row.to,
      training: { workoutAdherenceRate: row.workoutAdherenceRate },
    });
  }
  for (const item of Array.isArray(checkInSeriesValue) ? checkInSeriesValue : []) {
    const row = item as Record<string, unknown>;
    const current = byKey.get(String(row.key)) ?? { key: row.key, from: row.from, to: row.to };
    current.checkIns = { complianceRate: row.complianceRate };
    byKey.set(String(row.key), current);
  }
  for (const item of Array.isArray(nutritionSeriesValue) ? nutritionSeriesValue : []) {
    const row = item as Record<string, unknown>;
    const current = byKey.get(String(row.key)) ?? { key: row.key, from: row.from, to: row.to };
    current.nutrition = { adherenceRate: row.nutritionAdherenceRate };
    current.water = { adherenceRate: row.waterAdherenceRate };
    byKey.set(String(row.key), current);
  }
  return [...byKey.values()].sort((left, right) =>
    String(left.key).localeCompare(String(right.key)),
  );
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function granularity<T extends Granularity>(value: unknown, allowed: T[], fallback: T): T {
  if (!value) return fallback;
  if (!allowed.includes(value as T)) throw badRequest('GRANULARITY_INVALID');
  return value as T;
}

function measurementDto(
  item: { value: number; measuredAt: Date; _id: ObjectId },
  metric: { _id: ObjectId; unit: string; key?: string; name: string },
) {
  return {
    id: item._id.toHexString(),
    value: item.value,
    unit: metric.unit,
    metricDefinitionId: metric._id.toHexString(),
    metricKey: metric.key ?? null,
    metricName: metric.name,
    measuredAt: item.measuredAt.toISOString(),
  };
}

function encodeDateIdCursor(occurredAt: Date, id: ObjectId) {
  return encodeCursor({ occurredAt: occurredAt.toISOString(), id: id.toHexString() });
}

function encodeActivityCursor(category: ActivityCategory, occurredAt: Date, id: ObjectId) {
  return encodeCursor({ category, occurredAt: occurredAt.toISOString(), id: id.toHexString() });
}

function activityTimeField(category: ActivityCategory) {
  return category === 'WORKOUT_COMPLETED'
    ? 'completedAt'
    : category === 'PR_ACHIEVED'
      ? 'occurredAt'
      : category === 'CHECKIN_SUBMITTED'
        ? 'submittedAt'
        : 'createdAt';
}

function activityItem(
  category: ActivityCategory,
  item: Record<string, unknown>,
  timeField: string,
) {
  return {
    relationshipId: (item.relationshipId as ObjectId | undefined)?.toHexString() ?? null,
    traineeDisplay: null,
    occurredAt: (item[timeField] as Date).toISOString(),
    summary:
      category === 'WORKOUT_COMPLETED'
        ? 'Workout completed'
        : category === 'PR_ACHIEVED'
          ? 'Personal record achieved'
          : category === 'CHECKIN_SUBMITTED'
            ? 'Check-in submitted'
            : 'InBody uploaded',
  };
}

function latestPrDto(item: Record<string, unknown>) {
  return {
    occurredAt: (item.occurredAt as Date).toISOString(),
    exerciseId: (item.exerciseId as ObjectId | undefined)?.toHexString() ?? null,
    value: item.value ?? null,
  };
}

function isValidTimezone(timezone: string) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function localDaysAgoStart(now: Date, timezone: string, daysAgo: number) {
  const parts = localParts(now, timezone);
  return utcFromLocal(timezone, parts.year, parts.month, parts.day - daysAgo);
}

function localDaySpan(from: Date, to: Date, timezone: string) {
  const fromParts = localParts(from, timezone);
  const toParts = localParts(to, timezone);
  const fromUtc = Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day);
  const toUtc = Date.UTC(toParts.year, toParts.month - 1, toParts.day);
  return Math.floor((toUtc - fromUtc) / (24 * 60 * 60 * 1000)) + 1;
}

function localDateString(date: Date, timezone: string) {
  const parts = localParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(
    2,
    '0',
  )}`;
}

function localDateInstant(localDate: string, timezone: string) {
  const [year = 0, month = 1, day = 1] = localDate.split('-').map(Number);
  return utcFromLocal(timezone, year, month, day);
}

function bucketWindow(date: Date, timezone: string, selectedGranularity: Granularity) {
  const parts = localParts(date, timezone);
  if (selectedGranularity === 'month') {
    const start = utcFromLocal(timezone, parts.year, parts.month, 1);
    const end = utcFromLocal(timezone, parts.year, parts.month + 1, 1);
    return {
      key: `${parts.year}-${String(parts.month).padStart(2, '0')}`,
      start,
      end,
    };
  }
  if (selectedGranularity === 'week') {
    const localUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
    const dayOfWeek = new Date(localUtc).getUTCDay();
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const monday = new Date(localUtc - daysSinceMonday * 24 * 60 * 60 * 1000);
    const start = utcFromLocal(
      timezone,
      monday.getUTCFullYear(),
      monday.getUTCMonth() + 1,
      monday.getUTCDate(),
    );
    const end = utcFromLocal(
      timezone,
      monday.getUTCFullYear(),
      monday.getUTCMonth() + 1,
      monday.getUTCDate() + 7,
    );
    return {
      key: localDateString(start, timezone),
      start,
      end,
    };
  }
  const start = utcFromLocal(timezone, parts.year, parts.month, parts.day);
  const end = utcFromLocal(timezone, parts.year, parts.month, parts.day + 1);
  return {
    key: localDateString(start, timezone),
    start,
    end,
  };
}

function localParts(date: Date, timezone: string) {
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(date)
    .reduce<Record<string, number>>((parts, part) => {
      if (part.type !== 'literal') parts[part.type] = Number(part.value);
      return parts;
    }, {});
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

function utcFromLocal(timezone: string, year: number, month: number, day: number) {
  let guess = new Date(Date.UTC(year, month - 1, day));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = localParts(guess, timezone);
    const diff =
      Date.UTC(year, month - 1, day) -
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    if (diff === 0) return guess;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

function serializeAccess(access: {
  pureWorkspaceWide: boolean;
  assignedTrainees: boolean;
  self: boolean;
  includeBranchIds: ObjectId[];
  excludeBranchIds: ObjectId[];
  includeRelationshipIds: ObjectId[];
  excludeRelationshipIds: ObjectId[];
}) {
  return {
    pureWorkspaceWide: access.pureWorkspaceWide,
    assignedTrainees: access.assignedTrainees,
    self: access.self,
    includeBranchIds: access.includeBranchIds.map((id) => id.toHexString()),
    excludeBranchIds: access.excludeBranchIds.map((id) => id.toHexString()),
    includeRelationshipIds: access.includeRelationshipIds.map((id) => id.toHexString()),
    excludeRelationshipIds: access.excludeRelationshipIds.map((id) => id.toHexString()),
  };
}

function notFound(code: string) {
  return new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
}

function permissionDenied(code: string) {
  return new AppError({ code, httpStatus: 403, message: 'Permission denied.' });
}

function badRequest(code: string) {
  return new AppError({ code, httpStatus: 422, message: 'Invalid analytics request.' });
}
