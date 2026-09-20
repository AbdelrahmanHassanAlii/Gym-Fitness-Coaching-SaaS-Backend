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
    const range = defaultDashboardRange();
    const newlyAssignedIds = await this.repo.trainerAssignmentRelationshipIds(access, range.from);
    const relationshipIds = await this.repo.scopedRelationshipIds(access, 10_000);
    const [assignedActiveTrainees, completedWorkouts, overdueCheckIns, pendingReviewCheckIns] =
      await Promise.all([
        this.repo.countRelationships(access, ['ACTIVE']),
        this.repo.countCompletedWorkouts(access, range.from, range.to, relationshipIds),
        this.repo.countCheckins(access, ['OVERDUE'], relationshipIds),
        this.repo.countCheckins(access, ['SUBMITTED'], relationshipIds),
      ]);
    await this.writeSensitive(ctx, workspaceId, 'trainer_dashboard', workspaceId);
    return {
      workspaceId: workspaceId.toHexString(),
      generatedAt: new Date().toISOString(),
      window: serializeRange(range),
      summary: {
        assignedActiveTrainees,
        newlyAssignedTrainees: newlyAssignedIds.length,
        completedWorkouts,
        overdueCheckIns,
        pendingReviewCheckIns,
      },
      needsAttention: await this.needsAttention(access, query),
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
    const range = defaultDashboardRange();
    const branchLimit = limit(query.branchLimit, 25, 100);
    const branchCursor = decodeCursor(query.branchCursor);
    const branches = await this.repo.branchPage(access, {
      limit: branchLimit,
      ...(branchCursor ? { cursor: branchCursor } : {}),
      ...(branchId ? { branchId } : {}),
    });
    const branchPage = branches.slice(0, branchLimit);
    const relationshipIds = await this.repo.scopedRelationshipIds(access, 10_000);
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
      this.repo.countCompletedWorkouts(access, range.from, range.to, relationshipIds),
      this.repo.countCheckins(access, ['OVERDUE'], relationshipIds),
      this.repo.countCheckins(access, ['SUBMITTED'], relationshipIds),
    ]);
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
          activeTrainees: 0,
          needsReassignment: 0,
          completedWorkouts: 0,
          overdueCheckIns: 0,
          pendingReviewCheckIns: 0,
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
      needsAttention: await this.needsAttention(access, query),
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
        ? await this.checkinSummary(accessContext, defaultAnalyticsRange())
        : null,
      adherence: await this.adherenceAnalyticsFor(accessContext, {}),
      needsAttention: await this.needsAttention(
        {
          ...accessContext.access,
          requestedRelationshipId: accessContext.relationship._id,
        },
        {},
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
    const range = parseRange(query);
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
    return {
      workspaceId: input.access.workspaceId.toHexString(),
      relationshipId: input.relationship._id.toHexString(),
      range: serializeRange(range),
      granularity: granularity(query.granularity, ['day', 'week'], 'day'),
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
      series: [],
      latestPr: latestPr ? serializeDoc(latestPr) : null,
    };
  }

  private async progressAnalyticsFor(
    input: RelationshipAccessContext,
    query: Record<string, unknown>,
  ) {
    assertSection(input, 'progress');
    const range = parseRange(query);
    const metric = await this.repo.activeMetric(
      input.access.workspaceId,
      maybeOid(query.metricDefinitionId, 'METRIC_DEFINITION_NOT_FOUND'),
    );
    if (!metric) throw notFound('METRIC_DEFINITION_NOT_FOUND');
    const [points, latest] = await Promise.all([
      this.repo.measurementPoints(
        input.access.workspaceId,
        input.relationship._id,
        metric._id,
        range.from,
        range.to,
      ),
      this.repo.latestMeasurement(input.access.workspaceId, input.relationship._id, metric._id),
    ]);
    const first = points[0] ?? null;
    const last = points[points.length - 1] ?? null;
    const delta = first && last ? round2(last.value - first.value) : null;
    return {
      workspaceId: input.access.workspaceId.toHexString(),
      relationshipId: input.relationship._id.toHexString(),
      range: serializeRange(range),
      metricDefinitionId: metric._id.toHexString(),
      summary: {
        firstInWindow: first ? measurementDto(first, metric) : null,
        latestInWindow: last ? measurementDto(last, metric) : null,
        latest: latest ? measurementDto(latest, metric) : null,
        delta,
        percentChange:
          first && last && first.value !== 0
            ? round4((last.value - first.value) / first.value)
            : null,
      },
      points: points.map((point) => measurementDto(point, metric)),
      buckets: [],
      photoSummary: { count: 0 },
    };
  }

  private async nutritionAnalyticsFor(
    input: RelationshipAccessContext,
    query: Record<string, unknown> = {},
  ) {
    assertSection(input, 'nutrition');
    const range = parseRange(query);
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
        averageAdherencePercent: average(
          nutritionDays.map((entry) => entry.values.NUTRITION?.adherencePercent),
        ),
      },
      waterTracking: {
        daysTracked: waterDays.length,
        averageMl: average(waterDays.map((entry) => entry.values.WATER?.ml)),
        targetMl: plan.revision?.waterTargetMl ?? null,
      },
    };
  }

  private async adherenceAnalyticsFor(
    input: RelationshipAccessContext,
    query: Record<string, unknown>,
  ) {
    const visibility = visibilityFor(input.actorKind);
    const range = parseRange(query);
    return {
      workspaceId: input.access.workspaceId.toHexString(),
      relationshipId: input.relationship._id.toHexString(),
      range: serializeRange(range),
      granularity: granularity(query.granularity, ['day', 'week'], 'day'),
      training: visibility.training
        ? (await this.trainingAnalyticsFor(input, query)).summary
        : null,
      checkIns: visibility.checkIns ? await this.checkinSummary(input, range) : null,
      nutrition: visibility.nutrition
        ? (await this.nutritionAnalyticsFor(input, query)).nutritionTracking
        : null,
      water: visibility.nutrition
        ? (await this.nutritionAnalyticsFor(input, query)).waterTracking
        : null,
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
    const relationship = await this.repo.findRelationship(workspaceId, relationshipId);
    if (!relationship) throw notFound('RELATIONSHIP_NOT_FOUND');
    if (!['ACTIVE', 'NEEDS_REASSIGNMENT'].includes(relationship.status)) {
      throw permissionDenied('RELATIONSHIP_NOT_ACCESSIBLE');
    }
    const assigned = await this.repo.relationshipAllowedByAssignment(access, relationshipId);
    const selfAllowed = access.self && relationship.traineeUserId.equals(access.userId);
    const broadAllowed =
      access.workspaceAllowed ||
      (relationship.homeBranchId &&
        access.includeBranchIds.some((branchId) => branchId.equals(relationship.homeBranchId))) ||
      access.includeRelationshipIds.some((id) => id.equals(relationshipId));
    if (!broadAllowed && !assigned && !selfAllowed) throw permissionDenied('PERMISSION_DENIED');
    return { access, relationship, actorKind: actorKind(access.roles, selfAllowed) };
  }

  private async needsAttention(access: WorkspaceQueryAccess, query: Record<string, unknown>) {
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
      );
    }
    return result;
  }

  private async attentionCategory(
    access: WorkspaceQueryAccess,
    category: AttentionCategory,
    limitValue: number,
    cursorValue?: unknown,
  ) {
    if (category === 'CHECKIN_OVERDUE' || category === 'CHECKIN_PENDING_REVIEW') {
      const status = category === 'CHECKIN_OVERDUE' ? 'OVERDUE' : 'SUBMITTED';
      const cursor = decodeDateIdCursor(cursorValue);
      const [items, count] = await Promise.all([
        this.repo.listAttentionCheckins(access, status, limitValue, cursor),
        this.repo.countCheckins(access, [status]),
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
    const cursor = maybeOid(cursorValue, 'ATTENTION_CURSOR_INVALID');
    const rows = await this.repo.listAttentionRelationships(
      access,
      category,
      limitValue,
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      cursor,
    );
    return page(
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
      category === 'NEEDS_REASSIGNMENT' ? rows.length : null,
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
    const limitValue = limit(query.activityLimit, 5, 20);
    const categories = requestedCategory ? [requestedCategory] : activityCategories;
    const result: Record<string, unknown> = {};
    for (const category of categories) {
      result[category] = await this.activityCategory(workspaceId, range, category, limitValue);
    }
    return result;
  }

  private async activityCategory(
    workspaceId: ObjectId,
    range: AnalyticsRange,
    category: ActivityCategory,
    limitValue: number,
  ) {
    const source =
      category === 'WORKOUT_COMPLETED'
        ? await this.repo.recentActivity(
            this.repo.workouts as never,
            workspaceId,
            { status: 'COMPLETED', completedAt: { $gte: range.from, $lt: range.to } },
            { completedAt: -1, _id: -1 },
            limitValue,
          )
        : category === 'PR_ACHIEVED'
          ? await this.repo.recentActivity(
              this.repo.personalRecordEvents,
              workspaceId,
              { eventType: 'ACHIEVED', occurredAt: { $gte: range.from, $lt: range.to } },
              { occurredAt: -1, _id: -1 },
              limitValue,
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
              );
    return page(source, limitValue, serializeDoc, null);
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

function actorKind(roles: string[], self: boolean): RelationshipAccessContext['actorKind'] {
  if (self) return 'TRAINEE';
  if (roles.includes('GYM_OWNER')) return 'OWNER';
  if (roles.includes('GYM_MANAGER')) return 'MANAGER';
  if (roles.includes('TRAINER')) return 'TRAINER';
  if (roles.includes('ASSISTANT_TRAINER')) return 'ASSISTANT_TRAINER';
  if (roles.includes('NUTRITIONIST')) return 'NUTRITIONIST';
  return 'OTHER';
}

function isOwner(roles: string[]) {
  return roles.includes('GYM_OWNER');
}

function parseRange(query: Record<string, unknown>): AnalyticsRange {
  const now = new Date();
  const from = query.from
    ? parseDate(String(query.from), 'from')
    : new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
  const to = query.to ? parseDate(String(query.to), 'to') : now;
  if (to.getTime() <= from.getTime()) throw badRequest('DATE_RANGE_INVALID');
  if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) {
    throw badRequest('DATE_RANGE_TOO_LARGE');
  }
  return { from, to, timezone: 'workspace' };
}

function defaultAnalyticsRange(): AnalyticsRange {
  return parseRange({});
}

function defaultDashboardRange(): AnalyticsRange {
  return defaultAnalyticsRange();
}

function parseDate(value: string, field: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00.000Z`);
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
  return { from: range.from.toISOString().slice(0, 10), to: range.to.toISOString().slice(0, 10) };
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

function decodeDateIdCursor(value: unknown) {
  if (!value) return undefined;
  const parsed = decodeCursor(value) as unknown as { name?: string; id: ObjectId };
  return { dueAt: new Date(String(parsed.name)), id: parsed.id };
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
            name: last.dueAt instanceof Date ? last.dueAt.toISOString() : undefined,
            id: (last._id as ObjectId | undefined)?.toHexString(),
          })
        : null,
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

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function granularity(value: unknown, allowed: Granularity[], fallback: Granularity) {
  if (!value) return fallback;
  if (!allowed.includes(value as Granularity)) throw badRequest('GRANULARITY_INVALID');
  return value;
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

function serializeDoc(doc: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(doc).map(([key, value]) => [
      key,
      value instanceof ObjectId
        ? value.toHexString()
        : value instanceof Date
          ? value.toISOString()
          : value,
    ]),
  );
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
