import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import type { AppContainer } from '../src/bootstrap/app-container';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import type { RequestContext } from '../src/core/request-context/request-context';
import { migrations } from '../src/migrations';
import { migration023Stage18DashboardsAnalytics } from '../src/migrations/023-stage18-dashboards-analytics';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { AnalyticsRepository } from '../src/modules/analytics/analytics.repository';
import { AnalyticsApplicationService } from '../src/modules/analytics/analytics.service';
import {
  Permissions,
  systemPermissionProfiles,
} from '../src/modules/permissions/permission.registry';
import { INTEGRATION_TEST_TIMEOUT_MS } from './integration-timeouts';

const STAGE18_TEST_TIMEOUT_MS = 120_000;

describe('Stage 18 dashboards and analytics', () => {
  let container: AppContainer;
  let app: FastifyInstance;
  let fixture: Awaited<ReturnType<typeof seedStage18Fixture>>;

  beforeAll(async () => {
    container = await createAppContainer(integrationConfig(`stage18_${new ObjectId()}`));
    await new MigrationRunner(container.database.db, migrations).migrate();
    app = await buildApp(container);
    fixture = await seedStage18Fixture(container);
  }, STAGE18_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (app) await app.close();
    if (container) {
      await container.database.db.dropDatabase();
      await container.database.close();
    }
  }, STAGE18_TEST_TIMEOUT_MS);

  test(
    'migration 023 seeds exact permissions, default profiles, indexes, and no analytics collections',
    async () => {
      const local = await createAppContainer(
        integrationConfig(`stage18_migration_${new ObjectId()}`),
      );
      try {
        await new MigrationRunner(local.database.db, migrations).migrate();
        const keys = [
          Permissions.DashboardTrainerRead,
          Permissions.DashboardGymRead,
          Permissions.DashboardRelationshipRead,
          Permissions.AnalyticsTrainingRead,
          Permissions.AnalyticsProgressRead,
          Permissions.AnalyticsNutritionRead,
          Permissions.AnalyticsAdherenceRead,
        ];
        expect(
          await local.database.db
            .collection('permission_definitions')
            .countDocuments({ key: { $in: keys } }),
        ).toBe(7);
        expect(
          await local.database.db.collection('permission_profiles').countDocuments({
            isSystemDefault: false,
            permissions: { $elemMatch: { permission: { $in: keys } } },
          }),
        ).toBe(0);
        const owner = await local.permissionProfiles.findSystemDefault({
          context: 'WORKSPACE',
          workspaceId: fixture.workspaceId,
          roleKey: 'GYM_OWNER',
        });
        expect(
          systemPermissionProfiles
            .find((profile) => profile.roleKey === 'GYM_OWNER')
            ?.permissions.map((entry) => entry.permission),
        ).toEqual(expect.arrayContaining(keys));
        expect(owner).toBeNull();
        expect(
          await local.database.db.listCollections({ name: 'analytics_snapshots' }).hasNext(),
        ).toBe(false);
        await migration023Stage18DashboardsAnalytics.up(local.database.db);
        await migration023Stage18DashboardsAnalytics.up(local.database.db);
        expect(
          (await local.database.db.collection('workout_sessions').indexes()).map(
            (index) => index.name,
          ),
        ).toContain('workouts_recent_completed_activity');
        expect(
          (await local.database.db.collection('documents').indexes()).map((index) => index.name),
        ).toContain('documents_recent_inbody_activity');
      } finally {
        await local.database.db.dropDatabase();
        await local.database.close();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  test('trainer dashboard is assignment-rooted, exact, audited, and has no recent activity', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${hex(fixture.workspaceId)}/dashboard/trainer`,
      headers: await bearer(container, fixture.trainer.userId),
    });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.summary).toMatchObject({
      assignedActiveTrainees: 1,
      newlyAssignedTrainees: 1,
      completedWorkouts: 2,
      overdueCheckIns: 1,
      pendingReviewCheckIns: 1,
    });
    expect(data.needsAttention.CHECKIN_OVERDUE.count).toBe(1);
    expect(data.needsAttention.CHECKIN_PENDING_REVIEW.count).toBe(1);
    expect(data.recentActivity).toBeNull();
    expect(await auditCount(container, 'trainer_dashboard')).toBeGreaterThan(0);

    const activityParam = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${hex(fixture.workspaceId)}/dashboard/trainer?activityLimit=1`,
      headers: await bearer(container, fixture.trainer.userId),
    });
    expect(activityParam.statusCode).toBe(422);
    expect(activityParam.json().error.code).toBe('RECENT_ACTIVITY_NOT_ALLOWED');
  });

  test('gym dashboard computes branch counts and gates recent activity before source queries', async () => {
    const owner = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${hex(fixture.workspaceId)}/dashboard/gym?activityLimit=1`,
      headers: await bearer(container, fixture.owner.userId),
    });
    expect(owner.statusCode).toBe(200);
    const data = owner.json().data;
    expect(data.summary).toMatchObject({
      activeTrainees: 3,
      needsReassignment: 1,
      completedWorkouts: 4,
      overdueCheckIns: 2,
      pendingReviewCheckIns: 2,
    });
    const main = data.branchBreakdown.items.find(
      (item: { branchId: string }) => item.branchId === hex(fixture.branchId),
    );
    expect(main).toMatchObject({
      activeTrainees: 2,
      needsReassignment: 1,
      completedWorkouts: 3,
      overdueCheckIns: 2,
      pendingReviewCheckIns: 2,
    });
    expect(Object.keys(data.recentActivity)).toEqual([
      'WORKOUT_COMPLETED',
      'PR_ACHIEVED',
      'CHECKIN_SUBMITTED',
      'INBODY_UPLOADED',
    ]);
    expect(data.recentActivity.WORKOUT_COMPLETED.hasMore).toBe(true);

    const countingRepo = new CountingAnalyticsRepository(container.database);
    container.analytics = new AnalyticsApplicationService(
      countingRepo,
      container.accessControl,
      container.audit,
    );
    const manager = await container.analytics.gymDashboard(
      ctx(fixture.manager.userId),
      hex(fixture.workspaceId),
      {},
    );
    expect(manager.recentActivity).toBeNull();
    expect(countingRepo.activityCalls).toBe(0);
    await expect(
      container.analytics.gymDashboard(ctx(fixture.owner.userId), hex(fixture.workspaceId), {
        branchId: hex(fixture.branchId),
        activityLimit: 1,
      }),
    ).rejects.toMatchObject({ code: 'RECENT_ACTIVITY_NOT_ALLOWED' });
    expect(countingRepo.activityCalls).toBe(0);
  });

  test('relationship routes require Stage 4 permission plus current domain eligibility and block cross-workspace IDs', async () => {
    await expect(
      container.analytics.relationshipDashboard(
        ctx(fixture.trainer.userId),
        hex(fixture.workspaceId),
        hex(fixture.unassignedRelationshipId),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      container.analytics.trainingAnalytics(
        ctx(fixture.trainer.userId),
        hex(fixture.workspaceId),
        hex(fixture.otherWorkspaceRelationshipId),
        {},
      ),
    ).rejects.toMatchObject({ code: 'RELATIONSHIP_NOT_FOUND' });
    for (const route of relationshipRoutes(
      fixture.workspaceId,
      fixture.otherWorkspaceRelationshipId,
    )) {
      const response = await app.inject({
        method: 'GET',
        url: route,
        headers: await bearer(container, fixture.owner.userId),
      });
      expect(response.statusCode).toBe(404);
    }
  });

  test('relationship dashboard enforces stable null field visibility by actor', async () => {
    const assistant = await container.analytics.relationshipDashboard(
      ctx(fixture.assistant.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
    );
    expect(assistant.training).not.toBeNull();
    expect(assistant.progress).not.toBeNull();
    expect(assistant.checkIns).not.toBeNull();
    expect(assistant.nutrition).toBeNull();

    const nutritionist = await container.analytics.relationshipDashboard(
      ctx(fixture.nutritionist.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
    );
    expect(nutritionist.training).toBeNull();
    expect(nutritionist.progress).toBeNull();
    expect(nutritionist.checkIns).toBeNull();
    expect(nutritionist.nutrition).not.toBeNull();

    const trainee = await container.analytics.relationshipDashboard(
      ctx(fixture.trainee.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
    );
    const serialized = JSON.stringify(trainee);
    expect(serialized).not.toContain('membershipId');
    expect(serialized).not.toContain('fileId');
    expect(serialized).not.toContain('signedUrl');
    expect(serialized).not.toContain('storageKey');
    expect(serialized).not.toContain('sensitive answer');
  });

  test('analytics formulas use persisted Stage 8-12 truth and actor component filters', async () => {
    const training = await container.analytics.trainingAnalytics(
      ctx(fixture.trainer.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
      { from: '2026-09-01', to: '2026-10-01' },
    );
    expect(training.summary).toMatchObject({
      completedSessions: 2,
      abandonedSessions: 1,
      programDaysCompleted: 2,
      programDaysSkipped: 1,
      programDaysDeferred: 1,
      workoutAdherenceRate: 0.6667,
      prCount: 1,
    });

    const progress = await container.analytics.progressAnalytics(
      ctx(fixture.trainer.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
      { from: '2026-09-01', to: '2026-10-01' },
    );
    expect(progress.summary.delta).toBe(5);
    expect(progress.summary.percentChange).toBeNull();
    expect(progress.points).toHaveLength(2);
    expect(progress.photoSummary.count).toBe(1);

    const nutrition = await container.analytics.nutritionAnalytics(
      ctx(fixture.nutritionist.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
      { from: '2026-09-01', to: '2026-10-01' },
    );
    expect(nutrition.targets).toMatchObject({ targetCalories: 2200, waterTargetMl: 3000 });
    expect(nutrition.nutritionTracking.averageAdherenceRate).toBe(0.875);
    expect(nutrition.waterTracking.averageMl).toBe(2500);

    const assistantAdherence = await container.analytics.adherenceAnalytics(
      ctx(fixture.assistant.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
      { from: '2026-09-01', to: '2026-10-01' },
    );
    expect(assistantAdherence.training).not.toBeNull();
    expect(assistantAdherence.checkIns).toMatchObject({
      dueCount: 4,
      submittedOrReviewedCount: 2,
      complianceRate: 0.5,
    });
    expect(assistantAdherence.nutrition).toBeNull();
    expect(assistantAdherence.water).toBeNull();
  });

  test('workspace timezone drives date-only ranges, DST boundaries, and invalid timezone errors', async () => {
    const metric = await container.database.db
      .collection('metric_definitions')
      .findOne({ normalizedKey: 'body_weight' });
    if (!metric) throw new Error('missing body weight metric');
    await container.database.db
      .collection('workspaces')
      .updateOne({ _id: fixture.workspaceId }, { $set: { timezone: 'America/New_York' } });
    const dstIncluded = new ObjectId();
    const dstExcluded = new ObjectId();
    await container.database.db
      .collection('measurement_entries')
      .insertMany([
        measurement(
          fixture.workspaceId,
          fixture.relationshipId,
          metric._id,
          81,
          new Date('2026-03-08T05:00:00.000Z'),
          dstIncluded,
        ),
        measurement(
          fixture.workspaceId,
          fixture.relationshipId,
          metric._id,
          82,
          new Date('2026-03-09T04:00:00.000Z'),
          dstExcluded,
        ),
      ]);
    const dst = await container.analytics.progressAnalytics(
      ctx(fixture.trainer.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
      { from: '2026-03-08', to: '2026-03-09', metricDefinitionId: hex(metric._id) },
    );
    expect(dst.range).toMatchObject({
      from: '2026-03-08T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
      timezone: 'America/New_York',
    });
    expect(dst.points.map((point: { value: number }) => point.value)).toEqual([81]);

    await container.database.db
      .collection('workspaces')
      .updateOne({ _id: fixture.workspaceId }, { $set: { timezone: 'Africa/Cairo' } });
    const cairo = await container.analytics.trainingAnalytics(
      ctx(fixture.trainer.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
      { from: '2026-09-01', to: '2026-09-02' },
    );
    expect(cairo.range).toMatchObject({
      from: '2026-08-31T21:00:00.000Z',
      to: '2026-09-01T21:00:00.000Z',
      timezone: 'Africa/Cairo',
    });
    await expect(
      container.analytics.trainingAnalytics(
        ctx(fixture.trainer.userId),
        hex(fixture.workspaceId),
        hex(fixture.relationshipId),
        { from: '2026-09-01T00:00:00' },
      ),
    ).rejects.toMatchObject({ code: 'FROM_TIMEZONE_REQUIRED' });
    await container.database.db
      .collection('workspaces')
      .updateOne({ _id: fixture.workspaceId }, { $set: { timezone: 'No/Such_Zone' } });
    await expect(
      container.analytics.gymDashboard(ctx(fixture.owner.userId), hex(fixture.workspaceId), {}),
    ).rejects.toMatchObject({ code: 'WORKSPACE_TIMEZONE_INVALID' });
    await container.database.db
      .collection('workspaces')
      .updateOne({ _id: fixture.workspaceId }, { $set: { timezone: 'Africa/Cairo' } });
  });

  test('Recent Activity paginates by category and returns only safe DTO fields', async () => {
    const sameTime = new Date('2026-09-16T00:00:00.000Z');
    const firstId = new ObjectId('000000000000000000000101');
    const secondId = new ObjectId('000000000000000000000102');
    await container.database.db.collection('personal_record_events').insertMany([
      {
        _id: secondId,
        workspaceId: fixture.workspaceId,
        relationshipId: fixture.westRelationshipId,
        eventType: 'ACHIEVED',
        occurredAt: sameTime,
        exerciseId: new ObjectId(),
        value: 120,
        internalMembershipId: new ObjectId(),
        createdAt: sameTime,
      },
      {
        _id: firstId,
        workspaceId: fixture.workspaceId,
        relationshipId: fixture.relationshipId,
        eventType: 'ACHIEVED',
        occurredAt: sameTime,
        exerciseId: new ObjectId(),
        value: 115,
        fileId: new ObjectId(),
        createdAt: sameTime,
      },
    ]);
    const first = await container.analytics.gymDashboard(
      ctx(fixture.owner.userId),
      hex(fixture.workspaceId),
      { activityCategory: 'PR_ACHIEVED', activityLimit: 1 },
    );
    if (!first.recentActivity) throw new Error('expected recent activity');
    const pageOne = first.recentActivity.PR_ACHIEVED as {
      items: Array<Record<string, unknown>>;
      hasMore: boolean;
      nextCursor: string;
    };
    expect(pageOne.hasMore).toBe(true);
    expect(Object.keys(pageOne.items[0] ?? {}).sort()).toEqual([
      'occurredAt',
      'relationshipId',
      'summary',
      'traineeDisplay',
    ]);
    expect(JSON.stringify(pageOne.items)).not.toContain('fileId');
    expect(JSON.stringify(pageOne.items)).not.toContain('internalMembershipId');
    const second = await container.analytics.gymDashboard(
      ctx(fixture.owner.userId),
      hex(fixture.workspaceId),
      {
        activityCategory: 'PR_ACHIEVED',
        activityLimit: 1,
        activityCursor: pageOne.nextCursor,
      },
    );
    if (!second.recentActivity) throw new Error('expected recent activity');
    const pageTwo = second.recentActivity.PR_ACHIEVED as { items: Array<Record<string, unknown>> };
    expect(pageTwo.items[0]?.relationshipId).not.toEqual(pageOne.items[0]?.relationshipId);
    await expect(
      container.analytics.gymDashboard(ctx(fixture.owner.userId), hex(fixture.workspaceId), {
        activityCursor: pageOne.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'ACTIVITY_CURSOR_REQUIRES_CATEGORY' });
    await expect(
      container.analytics.gymDashboard(ctx(fixture.owner.userId), hex(fixture.workspaceId), {
        activityCategory: 'PR_ACHIEVED',
        activityCursor: 'not-a-cursor',
      }),
    ).rejects.toMatchObject({ code: 'ACTIVITY_CURSOR_INVALID' });
  });

  test('Recent Activity cursors are category-bound across all categories', async () => {
    const sameTime = new Date('2026-09-17T00:00:00.000Z');
    const activitySeeds = [
      {
        category: 'WORKOUT_COMPLETED',
        collection: 'workout_sessions',
        docs: [
          {
            ...workout(fixture.workspaceId, fixture.relationshipId, 'COMPLETED', sameTime),
            _id: new ObjectId('000000000000000000000201'),
            rawActuals: { secret: true },
          },
          {
            ...workout(fixture.workspaceId, fixture.westRelationshipId, 'COMPLETED', sameTime),
            _id: new ObjectId('000000000000000000000202'),
          },
        ],
      },
      {
        category: 'PR_ACHIEVED',
        collection: 'personal_record_events',
        docs: [
          {
            _id: new ObjectId('000000000000000000000211'),
            workspaceId: fixture.workspaceId,
            relationshipId: fixture.relationshipId,
            eventType: 'ACHIEVED',
            occurredAt: sameTime,
            exerciseId: new ObjectId(),
            internalEventId: 'hidden',
            createdAt: sameTime,
          },
          {
            _id: new ObjectId('000000000000000000000212'),
            workspaceId: fixture.workspaceId,
            relationshipId: fixture.westRelationshipId,
            eventType: 'ACHIEVED',
            occurredAt: sameTime,
            exerciseId: new ObjectId(),
            createdAt: sameTime,
          },
        ],
      },
      {
        category: 'CHECKIN_SUBMITTED',
        collection: 'checkin_instances',
        docs: [
          {
            ...checkin(
              fixture.workspaceId,
              fixture.relationshipId,
              'SUBMITTED',
              sameTime,
              'hidden',
            ),
            _id: new ObjectId('000000000000000000000221'),
          },
          {
            ...checkin(
              fixture.workspaceId,
              fixture.westRelationshipId,
              'REVIEWED',
              sameTime,
              'hidden',
            ),
            _id: new ObjectId('000000000000000000000222'),
          },
        ],
      },
      {
        category: 'INBODY_UPLOADED',
        collection: 'documents',
        docs: [
          {
            _id: new ObjectId('000000000000000000000231'),
            workspaceId: fixture.workspaceId,
            relationshipId: fixture.relationshipId,
            category: 'INBODY',
            status: 'ACTIVE',
            title: 'Sensitive title',
            fileId: new ObjectId(),
            createdAt: sameTime,
          },
          {
            _id: new ObjectId('000000000000000000000232'),
            workspaceId: fixture.workspaceId,
            relationshipId: fixture.westRelationshipId,
            category: 'INBODY',
            status: 'ACTIVE',
            fileId: new ObjectId(),
            storageKey: 'hidden',
            createdAt: sameTime,
          },
        ],
      },
    ] as const;
    for (const seed of activitySeeds) {
      await container.database.db.collection(seed.collection).insertMany(seed.docs);
    }
    const cursors = new Map<string, string>();
    for (const seed of activitySeeds) {
      const first = await container.analytics.gymDashboard(
        ctx(fixture.owner.userId),
        hex(fixture.workspaceId),
        { activityCategory: seed.category, activityLimit: 1 },
      );
      const pageOne = first.recentActivity?.[seed.category] as {
        items: Array<Record<string, unknown>>;
        nextCursor: string;
        hasMore: boolean;
      };
      expect(pageOne.hasMore).toBe(true);
      expect(Object.keys(pageOne.items[0] ?? {}).sort()).toEqual([
        'occurredAt',
        'relationshipId',
        'summary',
        'traineeDisplay',
      ]);
      expect(JSON.stringify(pageOne.items)).not.toContain('_id');
      expect(JSON.stringify(pageOne.items)).not.toContain('hidden');
      const second = await container.analytics.gymDashboard(
        ctx(fixture.owner.userId),
        hex(fixture.workspaceId),
        {
          activityCategory: seed.category,
          activityLimit: 1,
          activityCursor: pageOne.nextCursor,
        },
      );
      const pageTwo = second.recentActivity?.[seed.category] as {
        items: Array<Record<string, unknown>>;
      };
      expect(pageTwo.items[0]?.relationshipId).not.toEqual(pageOne.items[0]?.relationshipId);
      cursors.set(seed.category, pageOne.nextCursor);
    }
    await expect(
      container.analytics.gymDashboard(ctx(fixture.owner.userId), hex(fixture.workspaceId), {
        activityCategory: 'PR_ACHIEVED',
        activityCursor: cursors.get('WORKOUT_COMPLETED'),
      }),
    ).rejects.toMatchObject({ code: 'ACTIVITY_CURSOR_INVALID' });
    await expect(
      container.analytics.gymDashboard(ctx(fixture.owner.userId), hex(fixture.workspaceId), {
        activityCategory: 'INBODY_UPLOADED',
        activityCursor: cursors.get('CHECKIN_SUBMITTED'),
      }),
    ).rejects.toMatchObject({ code: 'ACTIVITY_CURSOR_INVALID' });
  });

  test('trainer attention excludes nutritionist-only assignments for mixed-role memberships', async () => {
    const mixedRelationshipId = new ObjectId();
    await container.database.db
      .collection('coaching_relationships')
      .insertOne(
        relationship(
          fixture.workspaceId,
          mixedRelationshipId,
          new ObjectId(),
          undefined,
          fixture.branchId,
          'ACTIVE',
          new Date('2026-09-18T00:00:00.000Z'),
        ),
      );
    await container.database.db
      .collection('checkin_instances')
      .insertOne(
        checkin(
          fixture.workspaceId,
          mixedRelationshipId,
          'OVERDUE',
          new Date('2026-09-18T00:00:00.000Z'),
        ),
      );
    await container.database.db
      .collection('trainee_staff_assignments')
      .insertOne(
        staffAssignment(
          fixture.workspaceId,
          mixedRelationshipId,
          fixture.trainer.membershipId,
          'NUTRITIONIST',
          new Date('2026-09-18T00:00:00.000Z'),
        ),
      );
    const excluded = await container.analytics.trainerDashboard(
      ctx(fixture.trainer.userId),
      hex(fixture.workspaceId),
      { attentionCategory: 'CHECKIN_OVERDUE', attentionLimit: 10 },
    );
    const excludedOverdue = excluded.needsAttention.CHECKIN_OVERDUE as {
      items: Array<{ relationshipId: string }>;
    };
    expect(
      excludedOverdue.items.some(
        (item: { relationshipId: string }) => item.relationshipId === hex(mixedRelationshipId),
      ),
    ).toBe(false);
    await container.database.db
      .collection('trainee_staff_assignments')
      .insertOne(
        staffAssignment(
          fixture.workspaceId,
          mixedRelationshipId,
          fixture.trainer.membershipId,
          'ASSISTANT_TRAINER',
          new Date('2026-09-18T00:00:00.000Z'),
        ),
      );
    const included = await container.analytics.trainerDashboard(
      ctx(fixture.trainer.userId),
      hex(fixture.workspaceId),
      { attentionCategory: 'CHECKIN_OVERDUE', attentionLimit: 10 },
    );
    const includedOverdue = included.needsAttention.CHECKIN_OVERDUE as {
      items: Array<{ relationshipId: string }>;
    };
    expect(
      includedOverdue.items.some(
        (item: { relationshipId: string }) => item.relationshipId === hex(mixedRelationshipId),
      ),
    ).toBe(true);
    await container.database.db
      .collection('checkin_instances')
      .deleteMany({ workspaceId: fixture.workspaceId, relationshipId: mixedRelationshipId });
    await container.database.db
      .collection('trainee_staff_assignments')
      .deleteMany({ workspaceId: fixture.workspaceId, relationshipId: mixedRelationshipId });
    await container.database.db
      .collection('coaching_relationships')
      .deleteOne({ _id: mixedRelationshipId, workspaceId: fixture.workspaceId });
  });

  test('progress points paginate while summary stays full-window and latest is before to', async () => {
    const metric = await container.database.db
      .collection('metric_definitions')
      .findOne({ normalizedKey: 'body_weight' });
    if (!metric) throw new Error('missing body weight metric');
    const inserts = Array.from({ length: 6 }, (_, index) =>
      measurement(
        fixture.workspaceId,
        fixture.relationshipId,
        metric._id,
        10 + index,
        new Date(`2026-09-${String(20 + index).padStart(2, '0')}T00:00:00.000Z`),
      ),
    );
    await container.database.db.collection('measurement_entries').insertMany(inserts);
    const first = await container.analytics.progressAnalytics(
      ctx(fixture.trainer.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
      { from: '2026-09-01', to: '2026-10-01', limit: 2, metricDefinitionId: hex(metric._id) },
    );
    expect(first.points).toHaveLength(2);
    expect(first.page.hasMore).toBe(true);
    expect(first.summary.latest?.value).toBe(15);
    expect(first.summary.latestInWindow?.value).toBe(15);
    const second = await container.analytics.progressAnalytics(
      ctx(fixture.trainer.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
      {
        from: '2026-09-01',
        to: '2026-10-01',
        limit: 2,
        cursor: first.page.nextCursor,
        metricDefinitionId: hex(metric._id),
      },
    );
    expect(second.points[0]).not.toEqual(first.points[0]);
    expect(second.summary).toEqual(first.summary);
  });

  test('progress pagination exceeds 500 points and local buckets use latest visible measurement', async () => {
    const metric = await container.database.db
      .collection('metric_definitions')
      .findOne({ normalizedKey: 'body_weight' });
    if (!metric) throw new Error('missing body weight metric');
    await container.database.db
      .collection('workspaces')
      .updateOne({ _id: fixture.workspaceId }, { $set: { timezone: 'America/New_York' } });
    const bulk = Array.from({ length: 520 }, (_, index) =>
      measurement(
        fixture.workspaceId,
        fixture.relationshipId,
        metric._id,
        1000 + index,
        new Date(Date.UTC(2026, 0, 1, 12, 0, index)),
      ),
    );
    await container.database.db
      .collection('measurement_entries')
      .insertMany([
        ...bulk,
        measurement(
          fixture.workspaceId,
          fixture.relationshipId,
          metric._id,
          3000,
          new Date('2026-03-08T06:30:00.000Z'),
        ),
        measurement(
          fixture.workspaceId,
          fixture.relationshipId,
          metric._id,
          3001,
          new Date('2026-03-08T07:30:00.000Z'),
        ),
        measurement(
          fixture.workspaceId,
          fixture.relationshipId,
          metric._id,
          4000,
          new Date('2026-03-09T04:00:00.000Z'),
        ),
      ]);
    const pageOne = await container.analytics.progressAnalytics(
      ctx(fixture.trainer.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
      {
        from: '2026-01-01',
        to: '2026-01-02',
        limit: 500,
        metricDefinitionId: hex(metric._id),
      },
    );
    expect(pageOne.points).toHaveLength(500);
    expect(pageOne.page.hasMore).toBe(true);
    const pageTwo = await container.analytics.progressAnalytics(
      ctx(fixture.trainer.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
      {
        from: '2026-01-01',
        to: '2026-01-02',
        limit: 500,
        cursor: pageOne.page.nextCursor,
        metricDefinitionId: hex(metric._id),
      },
    );
    const allPointIds = new Set([
      ...pageOne.points.map((point: { id: string }) => point.id),
      ...pageTwo.points.map((point: { id: string }) => point.id),
    ]);
    expect(pageTwo.points).toHaveLength(20);
    expect(allPointIds.size).toBe(520);
    expect(pageTwo.summary).toEqual(pageOne.summary);

    const day = await container.analytics.progressAnalytics(
      ctx(fixture.trainer.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
      {
        from: '2026-03-08',
        to: '2026-03-09',
        granularity: 'day',
        metricDefinitionId: hex(metric._id),
      },
    );
    expect(day.buckets).toHaveLength(1);
    expect(day.buckets[0]?.latest.value).toBe(3001);

    const week = await container.analytics.progressAnalytics(
      ctx(fixture.trainer.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
      {
        from: '2026-03-01',
        to: '2026-03-10',
        granularity: 'week',
        metricDefinitionId: hex(metric._id),
      },
    );
    expect(
      week.buckets.map((bucket: { latest: { value: number } }) => bucket.latest.value),
    ).toEqual([3001, 4000]);

    const month = await container.analytics.progressAnalytics(
      ctx(fixture.trainer.userId),
      hex(fixture.workspaceId),
      hex(fixture.relationshipId),
      {
        from: '2026-01-01',
        to: '2026-04-01',
        granularity: 'month',
        metricDefinitionId: hex(metric._id),
      },
    );
    expect(
      month.buckets.some((bucket: { latest: { value: number } }) => bucket.latest.value === 4000),
    ).toBe(true);
    await container.database.db
      .collection('workspaces')
      .updateOne({ _id: fixture.workspaceId }, { $set: { timezone: 'Africa/Cairo' } });
  });

  test('Stage 18 USER_CONTEXT support sensitive mapping covers all sensitive analytics permissions', async () => {
    const supportWithoutSensitive = await seedPlatformActor(container, []);
    const supportWithSensitive = await seedPlatformActor(container, [
      Permissions.SupportSensitiveRead,
    ]);
    const missing = supportCtx(supportWithoutSensitive, fixture.owner, fixture.workspaceId);
    const allowed = supportCtx(supportWithSensitive, fixture.owner, fixture.workspaceId);
    for (const call of [
      (ctxArg: RequestContext) =>
        container.analytics.trainerDashboard(ctxArg, hex(fixture.workspaceId), {}),
      (ctxArg: RequestContext) =>
        container.analytics.gymDashboard(ctxArg, hex(fixture.workspaceId), {}),
      (ctxArg: RequestContext) =>
        container.analytics.relationshipDashboard(
          ctxArg,
          hex(fixture.workspaceId),
          hex(fixture.relationshipId),
        ),
      (ctxArg: RequestContext) =>
        container.analytics.progressAnalytics(
          ctxArg,
          hex(fixture.workspaceId),
          hex(fixture.relationshipId),
          {},
        ),
      (ctxArg: RequestContext) =>
        container.analytics.nutritionAnalytics(
          ctxArg,
          hex(fixture.workspaceId),
          hex(fixture.relationshipId),
          {},
        ),
      (ctxArg: RequestContext) =>
        container.analytics.adherenceAnalytics(
          ctxArg,
          hex(fixture.workspaceId),
          hex(fixture.relationshipId),
          {},
        ),
    ]) {
      await expect(call(missing)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(call(allowed)).resolves.toBeTruthy();
    }
    await expect(
      container.analytics.trainingAnalytics(
        missing,
        hex(fixture.workspaceId),
        hex(fixture.relationshipId),
        {},
      ),
    ).resolves.toBeTruthy();
  });

  test('Needs Attention pagination uses per-category cursors and denies do not affect counts', async () => {
    await container.accessGrants.replaceCurrent(
      'WORKSPACE_MEMBERSHIP',
      fixture.owner.membershipId,
      'WORKSPACE',
      fixture.workspaceId,
      [
        {
          permission: Permissions.DashboardGymRead,
          effect: 'DENY',
          scope: { type: 'SPECIFIC_TRAINEES', resourceIds: [fixture.deniedRelationshipId] },
        },
      ],
      fixture.owner.userId,
    );
    const first = await container.analytics.gymDashboard(
      ctx(fixture.owner.userId),
      hex(fixture.workspaceId),
      {
        attentionCategory: 'CHECKIN_OVERDUE',
        attentionLimit: 1,
      },
    );
    const overdue = first.needsAttention.CHECKIN_OVERDUE as {
      count: number;
      items: Array<{ relationshipId: string }>;
      hasMore: boolean;
    };
    expect(overdue.count).toBe(1);
    expect(overdue.items).toHaveLength(1);
    expect(overdue.hasMore).toBe(false);
    expect(overdue.items[0]?.relationshipId).toBe(hex(fixture.relationshipId));
    await container.accessGrants.replaceCurrent(
      'WORKSPACE_MEMBERSHIP',
      fixture.owner.membershipId,
      'WORKSPACE',
      fixture.workspaceId,
      [],
      fixture.owner.userId,
    );
  });

  test('non-check-in Needs Attention categories consume their own relationship cursors', async () => {
    const now = new Date('2026-09-19T00:00:00.000Z');
    const visibleIds = [
      new ObjectId('000000000000000000000301'),
      new ObjectId('000000000000000000000303'),
      new ObjectId('000000000000000000000304'),
    ];
    const deniedId = new ObjectId('000000000000000000000302');
    const reassignmentIds = [
      new ObjectId('000000000000000000000311'),
      new ObjectId('000000000000000000000313'),
      new ObjectId('000000000000000000000314'),
    ];
    const deniedReassignmentId = new ObjectId('000000000000000000000312');
    await container.database.db
      .collection('coaching_relationships')
      .insertMany([
        ...visibleIds.map((id) =>
          relationship(
            fixture.workspaceId,
            id,
            new ObjectId(),
            undefined,
            fixture.branchId,
            'ACTIVE',
            now,
          ),
        ),
        relationship(
          fixture.workspaceId,
          deniedId,
          new ObjectId(),
          undefined,
          fixture.branchId,
          'ACTIVE',
          now,
        ),
        ...reassignmentIds.map((id) =>
          relationship(
            fixture.workspaceId,
            id,
            new ObjectId(),
            undefined,
            fixture.branchId,
            'NEEDS_REASSIGNMENT',
            now,
          ),
        ),
        relationship(
          fixture.workspaceId,
          deniedReassignmentId,
          new ObjectId(),
          undefined,
          fixture.branchId,
          'NEEDS_REASSIGNMENT',
          now,
        ),
      ]);
    await container.accessGrants.replaceCurrent(
      'WORKSPACE_MEMBERSHIP',
      fixture.owner.membershipId,
      'WORKSPACE',
      fixture.workspaceId,
      [
        {
          permission: Permissions.DashboardGymRead,
          effect: 'DENY',
          scope: { type: 'SPECIFIC_TRAINEES', resourceIds: [deniedId, deniedReassignmentId] },
        },
      ],
      fixture.owner.userId,
    );
    for (const category of [
      'NO_WORKOUT_ACTIVITY_7_DAYS',
      'NO_ACTIVE_PROGRAM',
      'NO_ACTIVE_NUTRITION_PLAN',
      'NEEDS_REASSIGNMENT',
    ] as const) {
      const first = await container.analytics.gymDashboard(
        ctx(fixture.owner.userId),
        hex(fixture.workspaceId),
        { attentionCategory: category, attentionLimit: 2 },
      );
      const pageOne = first.needsAttention[category] as {
        items: Array<{ relationshipId: string }>;
        nextCursor: string;
        hasMore: boolean;
      };
      expect(pageOne.hasMore).toBe(true);
      const second = await container.analytics.gymDashboard(
        ctx(fixture.owner.userId),
        hex(fixture.workspaceId),
        {
          attentionCategory: category,
          attentionLimit: 2,
          attentionCursor: pageOne.nextCursor,
        },
      );
      const pageTwo = second.needsAttention[category] as {
        items: Array<{ relationshipId: string }>;
      };
      const ids = [...pageOne.items, ...pageTwo.items].map((item) => item.relationshipId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain(hex(deniedId));
      expect(ids).not.toContain(hex(deniedReassignmentId));
    }
    await expect(
      container.analytics.gymDashboard(ctx(fixture.owner.userId), hex(fixture.workspaceId), {
        attentionCategory: 'NO_ACTIVE_PROGRAM',
        attentionCursor: 'not-a-cursor',
      }),
    ).rejects.toMatchObject({ code: 'ATTENTION_CURSOR_INVALID' });
    await container.accessGrants.replaceCurrent(
      'WORKSPACE_MEMBERSHIP',
      fixture.owner.membershipId,
      'WORKSPACE',
      fixture.workspaceId,
      [],
      fixture.owner.userId,
    );
  });

  test('support workspace context and restricted workspaces are denied for all Stage 18 routes', async () => {
    for (const call of serviceCalls(fixture.workspaceId, fixture.relationshipId)) {
      await expect(
        call({ ...ctx(fixture.owner.userId), supportSessionId: new ObjectId().toHexString() }),
      ).rejects.toMatchObject({
        code: 'SUPPORT_WORKSPACE_DENIED',
      });
    }

    await container.database.db
      .collection('workspaces')
      .updateOne({ _id: fixture.workspaceId }, { $set: { status: 'RESTRICTED' } });
    for (const call of serviceCalls(fixture.workspaceId, fixture.relationshipId)) {
      await expect(call(ctx(fixture.owner.userId))).rejects.toMatchObject({
        code: 'WORKSPACE_INACTIVE',
      });
    }
    await container.database.db
      .collection('workspaces')
      .updateOne({ _id: fixture.workspaceId }, { $set: { status: 'ACTIVE' } });
  });

  test('branch breakdown pagination continues deterministically and rejects branchId with cursor', async () => {
    const branchIds = [
      new ObjectId('000000000000000000000401'),
      new ObjectId('000000000000000000000402'),
      new ObjectId('000000000000000000000403'),
    ];
    await container.database.db.collection('branches').insertMany(
      branchIds.map((id, index) => ({
        _id: id,
        workspaceId: fixture.workspaceId,
        name: `AAA Stage18 ${index}`,
        status: 'ACTIVE',
        timezone: 'Africa/Cairo',
        version: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );
    const first = await container.analytics.gymDashboard(
      ctx(fixture.owner.userId),
      hex(fixture.workspaceId),
      { branchLimit: 2 },
    );
    const firstPage = first.branchBreakdown as {
      items: Array<{ branchId: string; name: string }>;
      nextCursor: string;
      hasMore: boolean;
    };
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.items.map((item) => item.branchId)).toEqual([
      hex(branchIds[0] as ObjectId),
      hex(branchIds[1] as ObjectId),
    ]);
    const second = await container.analytics.gymDashboard(
      ctx(fixture.owner.userId),
      hex(fixture.workspaceId),
      { branchLimit: 2, branchCursor: firstPage.nextCursor },
    );
    const secondPage = second.branchBreakdown as { items: Array<{ branchId: string }> };
    expect(secondPage.items[0]?.branchId).toBe(hex(branchIds[2] as ObjectId));
    await expect(
      container.analytics.gymDashboard(ctx(fixture.owner.userId), hex(fixture.workspaceId), {
        branchId: hex(fixture.branchId),
        branchCursor: firstPage.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'BRANCH_CURSOR_NOT_ALLOWED' });
  });

  test('Stage 18 routes obey scoped narrow ALLOW and scoped DENY at route level', async () => {
    await container.accessGrants.replaceCurrent(
      'WORKSPACE_MEMBERSHIP',
      fixture.owner.membershipId,
      'WORKSPACE',
      fixture.workspaceId,
      [
        {
          permission: Permissions.DashboardGymRead,
          effect: 'DENY',
          scope: { type: 'BRANCH', resourceIds: [fixture.branchId] },
        },
        {
          permission: Permissions.DashboardRelationshipRead,
          effect: 'DENY',
          scope: { type: 'SPECIFIC_TRAINEES', resourceIds: [fixture.relationshipId] },
        },
      ],
      fixture.owner.userId,
    );
    const gym = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${hex(fixture.workspaceId)}/dashboard/gym`,
      headers: await bearer(container, fixture.owner.userId),
    });
    expect(gym.statusCode).toBe(200);
    expect(gym.json().data.summary.activeTrainees).toBe(1);
    const deniedRelationship = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${hex(fixture.workspaceId)}/relationships/${hex(
        fixture.relationshipId,
      )}/dashboard`,
      headers: await bearer(container, fixture.owner.userId),
    });
    expect(deniedRelationship.statusCode).toBe(403);
    await container.accessGrants.replaceCurrent(
      'WORKSPACE_MEMBERSHIP',
      fixture.owner.membershipId,
      'WORKSPACE',
      fixture.workspaceId,
      [],
      fixture.owner.userId,
    );
  });

  test('profile DENY plus narrow explicit ALLOW reaches only the granted Stage 18 route data', async () => {
    await container.database.db.collection('permission_profiles').updateOne(
      { workspaceId: fixture.workspaceId, roleKey: 'GYM_OWNER', isSystemDefault: true },
      {
        $addToSet: {
          permissions: {
            $each: [
              { permission: Permissions.DashboardGymRead, effect: 'DENY' },
              { permission: Permissions.DashboardRelationshipRead, effect: 'DENY' },
            ],
          },
        },
      },
    );
    await container.accessGrants.replaceCurrent(
      'WORKSPACE_MEMBERSHIP',
      fixture.owner.membershipId,
      'WORKSPACE',
      fixture.workspaceId,
      [
        {
          permission: Permissions.DashboardGymRead,
          effect: 'ALLOW',
          scope: { type: 'BRANCH', resourceIds: [fixture.branchId] },
        },
        {
          permission: Permissions.DashboardRelationshipRead,
          effect: 'ALLOW',
          scope: { type: 'SPECIFIC_TRAINEES', resourceIds: [fixture.relationshipId] },
        },
      ],
      fixture.owner.userId,
    );
    const gym = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${hex(fixture.workspaceId)}/dashboard/gym`,
      headers: await bearer(container, fixture.owner.userId),
    });
    expect(gym.statusCode).toBe(200);
    expect(
      gym.json().data.branchBreakdown.items.map((item: { branchId: string }) => item.branchId),
    ).toEqual([hex(fixture.branchId)]);
    const allowedRelationship = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${hex(fixture.workspaceId)}/relationships/${hex(
        fixture.relationshipId,
      )}/dashboard`,
      headers: await bearer(container, fixture.owner.userId),
    });
    expect(allowedRelationship.statusCode).toBe(200);
    const deniedRelationship = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${hex(fixture.workspaceId)}/relationships/${hex(
        fixture.westRelationshipId,
      )}/dashboard`,
      headers: await bearer(container, fixture.owner.userId),
    });
    expect(deniedRelationship.statusCode).toBe(403);
    await container.accessGrants.replaceCurrent(
      'WORKSPACE_MEMBERSHIP',
      fixture.owner.membershipId,
      'WORKSPACE',
      fixture.workspaceId,
      [],
      fixture.owner.userId,
    );
    await container.database.db.collection('permission_profiles').updateOne(
      { workspaceId: fixture.workspaceId, roleKey: 'GYM_OWNER', isSystemDefault: true },
      {
        $pull: {
          permissions: {
            permission: {
              $in: [Permissions.DashboardGymRead, Permissions.DashboardRelationshipRead],
            },
            effect: 'DENY',
          },
        } as never,
      },
    );
  });
});

class CountingAnalyticsRepository extends AnalyticsRepository {
  activityCalls = 0;
  override async recentActivity(...args: Parameters<AnalyticsRepository['recentActivity']>) {
    this.activityCalls += 1;
    return await super.recentActivity(...args);
  }
}

async function seedStage18Fixture(container: AppContainer) {
  const db = container.database.db;
  const now = new Date('2026-09-20T10:00:00.000Z');
  const owner = await seedActor(container, 'GYM_OWNER');
  const manager = await seedActor(container, 'GYM_MANAGER');
  const trainer = await seedActor(container, 'TRAINER');
  const assistant = await seedActor(container, 'ASSISTANT_TRAINER');
  const nutritionist = await seedActor(container, 'NUTRITIONIST');
  const trainee = await seedActor(container, 'TRAINEE');
  const otherTrainee = await seedActor(container, 'TRAINEE');
  const workspace = await container.workspaceRepo.create({
    type: 'GYM',
    name: 'Stage 18 Gym',
    ownerUserId: owner.userId,
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
  });
  const branch = await container.branches.create({
    workspaceId: workspace._id,
    name: 'Main',
    timezone: 'Africa/Cairo',
  });
  const west = await container.branches.create({
    workspaceId: workspace._id,
    name: 'West',
    timezone: 'Africa/Cairo',
  });
  for (const actor of [owner, manager, trainer, assistant, nutritionist, trainee, otherTrainee]) {
    actor.membershipId = (
      await container.workspaceMemberships.createActive({
        workspaceId: workspace._id,
        userId: actor.userId,
        roles: [actor.role as never],
      })
    )._id;
    await assignProfile(container, workspace._id, actor.membershipId, actor.role);
  }
  for (const actor of [manager, trainer, assistant, nutritionist]) {
    await container.membershipBranchAssignments.createActive(
      workspace._id,
      actor.membershipId,
      branch._id,
    );
  }
  const relationshipId = new ObjectId();
  const unassignedRelationshipId = new ObjectId();
  const deniedRelationshipId = new ObjectId();
  const westRelationshipId = new ObjectId();
  await db
    .collection('coaching_relationships')
    .insertMany([
      relationship(
        workspace._id,
        relationshipId,
        trainee.userId,
        trainee.membershipId,
        branch._id,
        'ACTIVE',
        now,
      ),
      relationship(
        workspace._id,
        unassignedRelationshipId,
        otherTrainee.userId,
        otherTrainee.membershipId,
        branch._id,
        'ACTIVE',
        now,
      ),
      relationship(
        workspace._id,
        deniedRelationshipId,
        new ObjectId(),
        undefined,
        branch._id,
        'NEEDS_REASSIGNMENT',
        now,
      ),
      relationship(
        workspace._id,
        westRelationshipId,
        new ObjectId(),
        undefined,
        west._id,
        'ACTIVE',
        now,
      ),
    ]);
  await db
    .collection('trainee_staff_assignments')
    .insertMany([
      staffAssignment(workspace._id, relationshipId, trainer.membershipId, 'PRIMARY_TRAINER', now),
      staffAssignment(
        workspace._id,
        relationshipId,
        assistant.membershipId,
        'ASSISTANT_TRAINER',
        now,
      ),
      staffAssignment(
        workspace._id,
        relationshipId,
        nutritionist.membershipId,
        'NUTRITIONIST',
        now,
      ),
    ]);
  await seedAnalyticsFacts(
    db,
    workspace._id,
    relationshipId,
    deniedRelationshipId,
    westRelationshipId,
    now,
  );
  const otherWorkspace = await container.workspaceRepo.create({
    type: 'GYM',
    name: 'Other Stage 18 Gym',
    ownerUserId: owner.userId,
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
  });
  const otherWorkspaceRelationshipId = new ObjectId();
  await db
    .collection('coaching_relationships')
    .insertOne(
      relationship(
        otherWorkspace._id,
        otherWorkspaceRelationshipId,
        owner.userId,
        undefined,
        undefined,
        'ACTIVE',
        now,
      ),
    );
  return {
    workspaceId: workspace._id,
    branchId: branch._id,
    relationshipId,
    unassignedRelationshipId,
    deniedRelationshipId,
    westRelationshipId,
    otherWorkspaceRelationshipId,
    owner,
    manager,
    trainer,
    assistant,
    nutritionist,
    trainee,
  };
}

async function seedAnalyticsFacts(
  db: AppContainer['database']['db'],
  workspaceId: ObjectId,
  relationshipId: ObjectId,
  deniedRelationshipId: ObjectId,
  westRelationshipId: ObjectId,
  now: Date,
) {
  await db
    .collection('workout_sessions')
    .insertMany([
      workout(workspaceId, relationshipId, 'COMPLETED', new Date('2026-09-10T09:00:00.000Z')),
      workout(workspaceId, relationshipId, 'ABANDONED', new Date('2026-09-11T09:00:00.000Z')),
      workout(workspaceId, deniedRelationshipId, 'COMPLETED', new Date('2026-09-12T09:00:00.000Z')),
      workout(workspaceId, westRelationshipId, 'COMPLETED', new Date('2026-09-13T09:00:00.000Z')),
      workout(workspaceId, relationshipId, 'COMPLETED', new Date('2026-09-14T09:00:00.000Z')),
    ]);
  await db
    .collection('program_progress_events')
    .insertMany([
      progressEvent(workspaceId, relationshipId, 'COMPLETED', '2026-09-01'),
      progressEvent(workspaceId, relationshipId, 'COMPLETED', '2026-09-02'),
      progressEvent(workspaceId, relationshipId, 'SKIPPED', '2026-09-03'),
      progressEvent(workspaceId, relationshipId, 'DEFERRED', '2026-09-04'),
    ]);
  await db
    .collection('checkin_instances')
    .insertMany([
      checkin(workspaceId, relationshipId, 'OVERDUE', new Date('2026-09-05T00:00:00.000Z')),
      checkin(
        workspaceId,
        relationshipId,
        'SUBMITTED',
        new Date('2026-09-06T00:00:00.000Z'),
        'sensitive answer',
      ),
      checkin(workspaceId, relationshipId, 'REVIEWED', new Date('2026-09-07T00:00:00.000Z')),
      checkin(workspaceId, relationshipId, 'DUE', new Date('2026-09-08T00:00:00.000Z')),
      checkin(workspaceId, deniedRelationshipId, 'OVERDUE', new Date('2026-09-09T00:00:00.000Z')),
      checkin(workspaceId, deniedRelationshipId, 'SUBMITTED', new Date('2026-09-10T00:00:00.000Z')),
    ]);
  await db.collection('personal_record_events').insertMany([
    {
      _id: new ObjectId(),
      workspaceId,
      relationshipId,
      eventType: 'ACHIEVED',
      occurredAt: new Date('2026-09-12T00:00:00.000Z'),
      exerciseId: new ObjectId(),
      value: 100,
      createdAt: now,
    },
    {
      _id: new ObjectId(),
      workspaceId,
      relationshipId,
      eventType: 'ADJUSTED',
      occurredAt: new Date('2026-09-13T00:00:00.000Z'),
      exerciseId: new ObjectId(),
      value: 105,
      createdAt: now,
    },
  ]);
  const metricDefinitionId = new ObjectId();
  await db.collection('metric_definitions').insertOne({
    _id: metricDefinitionId,
    workspaceId: null,
    normalizedKey: 'body_weight',
    key: 'BODY_WEIGHT',
    name: 'Body Weight',
    unit: 'kg',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  });
  await db
    .collection('measurement_entries')
    .insertMany([
      measurement(
        workspaceId,
        relationshipId,
        metricDefinitionId,
        0,
        new Date('2026-09-01T00:00:00.000Z'),
      ),
      measurement(
        workspaceId,
        relationshipId,
        metricDefinitionId,
        5,
        new Date('2026-09-10T00:00:00.000Z'),
      ),
      measurement(
        workspaceId,
        relationshipId,
        metricDefinitionId,
        7,
        new Date('2026-10-01T00:00:00.000Z'),
      ),
    ]);
  await db.collection('progress_photo_entries').insertMany([
    {
      _id: new ObjectId(),
      workspaceId,
      relationshipId,
      capturedAt: now,
      visibility: 'TRAINER_VISIBLE',
      photos: [{ type: 'FRONT', fileId: new ObjectId() }],
      createdBy: new ObjectId(),
      version: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: new ObjectId(),
      workspaceId,
      relationshipId,
      capturedAt: now,
      visibility: 'PRIVATE',
      photos: [{ type: 'SIDE', fileId: new ObjectId() }],
      createdBy: new ObjectId(),
      version: 0,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const planId = new ObjectId();
  const revisionId = new ObjectId();
  await db.collection('nutrition_plans').insertOne({
    _id: planId,
    workspaceId,
    relationshipId,
    name: 'Current Plan',
    status: 'ACTIVE',
    currentRevisionId: revisionId,
    version: 0,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('nutrition_plan_revisions').insertOne({
    _id: revisionId,
    workspaceId,
    relationshipId,
    nutritionPlanId: planId,
    revision: 1,
    targetCalories: 2200,
    targetProteinG: 160,
    targetCarbsG: 240,
    targetFatG: 70,
    waterTargetMl: 3000,
    createdBy: new ObjectId(),
    createdAt: now,
  });
  await db.collection('daily_tracking_entries').insertMany([
    {
      _id: new ObjectId(),
      workspaceId,
      relationshipId,
      localDate: '2026-09-01',
      values: { NUTRITION: { adherencePercent: 80 }, WATER: { ml: 2000 } },
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: new ObjectId(),
      workspaceId,
      relationshipId,
      localDate: '2026-09-02',
      values: { NUTRITION: { adherencePercent: 95 }, WATER: { ml: 3000 } },
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.collection('documents').insertOne({
    _id: new ObjectId(),
    workspaceId,
    relationshipId,
    category: 'INBODY',
    status: 'ACTIVE',
    title: 'InBody',
    createdAt: new Date('2026-09-15T00:00:00.000Z'),
  });
}

function serviceCalls(workspaceId: ObjectId, relationshipId: ObjectId) {
  return [
    (ctxArg: ReturnType<typeof ctx>) =>
      containerRef().analytics.trainerDashboard(ctxArg, hex(workspaceId), {}),
    (ctxArg: ReturnType<typeof ctx>) =>
      containerRef().analytics.gymDashboard(ctxArg, hex(workspaceId), {}),
    (ctxArg: ReturnType<typeof ctx>) =>
      containerRef().analytics.relationshipDashboard(ctxArg, hex(workspaceId), hex(relationshipId)),
    (ctxArg: ReturnType<typeof ctx>) =>
      containerRef().analytics.trainingAnalytics(ctxArg, hex(workspaceId), hex(relationshipId), {}),
    (ctxArg: ReturnType<typeof ctx>) =>
      containerRef().analytics.progressAnalytics(ctxArg, hex(workspaceId), hex(relationshipId), {}),
    (ctxArg: ReturnType<typeof ctx>) =>
      containerRef().analytics.nutritionAnalytics(
        ctxArg,
        hex(workspaceId),
        hex(relationshipId),
        {},
      ),
    (ctxArg: ReturnType<typeof ctx>) =>
      containerRef().analytics.adherenceAnalytics(
        ctxArg,
        hex(workspaceId),
        hex(relationshipId),
        {},
      ),
  ];
}

let activeContainer: AppContainer | undefined;
function containerRef() {
  if (!activeContainer) throw new Error('container not set');
  return activeContainer;
}

async function seedActor(container: AppContainer, role: string) {
  activeContainer = container;
  const userId = new ObjectId();
  await container.database.db.collection('users').insertOne({
    _id: userId,
    email: `${role.toLowerCase()}-${userId.toHexString()}@example.test`,
    normalizedEmail: `${role.toLowerCase()}-${userId.toHexString()}@example.test`,
    passwordHash: 'hash',
    emailVerifiedAt: new Date(),
    firstName: 'Stage',
    lastName: 'Eighteen',
    preferredLanguage: 'en',
    timezone: 'Africa/Cairo',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { userId, role, membershipId: new ObjectId() };
}

async function assignProfile(
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
  if (!membership) throw new Error('missing membership');
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

function relationship(
  workspaceId: ObjectId,
  id: ObjectId,
  traineeUserId: ObjectId,
  traineeMembershipId: ObjectId | undefined,
  branchId: ObjectId | undefined,
  status: string,
  now: Date,
) {
  return {
    _id: id,
    workspaceId,
    traineeUserId,
    ...(traineeMembershipId ? { traineeMembershipId } : {}),
    status,
    ...(branchId ? { homeBranchId: branchId } : {}),
    engagementPeriods: [{ startedAt: now }],
    version: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function staffAssignment(
  workspaceId: ObjectId,
  relationshipId: ObjectId,
  staffMembershipId: ObjectId,
  assignmentType: string,
  now: Date,
) {
  return {
    _id: new ObjectId(),
    workspaceId,
    relationshipId,
    staffMembershipId,
    assignmentType,
    active: true,
    startedAt: now,
    assignedBy: new ObjectId(),
    createdAt: now,
    updatedAt: now,
  };
}

function workout(workspaceId: ObjectId, relationshipId: ObjectId, status: string, at: Date) {
  return {
    _id: new ObjectId(),
    workspaceId,
    relationshipId,
    status,
    startedAt: at,
    completedAt: status === 'COMPLETED' ? at : undefined,
    abandonedAt: status === 'ABANDONED' ? at : undefined,
    createdAt: at,
    updatedAt: at,
  };
}

function progressEvent(
  workspaceId: ObjectId,
  relationshipId: ObjectId,
  type: string,
  localDate: string,
) {
  const occurredAt = new Date(`${localDate}T12:00:00.000Z`);
  return {
    _id: new ObjectId(),
    workspaceId,
    relationshipId,
    type,
    occurredAt,
    localDate,
    createdAt: occurredAt,
  };
}

function checkin(
  workspaceId: ObjectId,
  relationshipId: ObjectId,
  status: string,
  dueAt: Date,
  answer?: string,
) {
  return {
    _id: new ObjectId(),
    workspaceId,
    relationshipId,
    assignmentId: new ObjectId(),
    templateId: new ObjectId(),
    templateRevisionId: new ObjectId(),
    status,
    dueAt,
    submittedAt: ['SUBMITTED', 'REVIEWED'].includes(status) ? dueAt : undefined,
    responses: answer ? [{ fieldKey: 'notes', value: answer }] : [],
    periodKey: dueAt.toISOString(),
    periodStartAt: dueAt,
    periodEndAt: dueAt,
    opensAt: dueAt,
    timezone: 'Africa/Cairo',
    version: 0,
    createdAt: dueAt,
    updatedAt: dueAt,
  };
}

function measurement(
  workspaceId: ObjectId,
  relationshipId: ObjectId,
  metricDefinitionId: ObjectId,
  value: number,
  measuredAt: Date,
  id = new ObjectId(),
) {
  return {
    _id: id,
    workspaceId,
    relationshipId,
    metricDefinitionId,
    value,
    measuredAt,
    recordedBy: new ObjectId(),
    createdAt: measuredAt,
    updatedAt: measuredAt,
  };
}

async function seedPlatformActor(container: AppContainer, permissions: string[]) {
  const actor = await seedActor(container, `PLATFORM_${new ObjectId().toHexString()}`);
  const membership = await container.platformMemberships.createActive(actor.userId);
  const profileId = new ObjectId();
  await container.database.db.collection('permission_profiles').insertOne({
    _id: profileId,
    context: 'PLATFORM',
    name: `Stage 18 Platform ${profileId.toHexString()}`,
    roleKey: `STAGE18_${profileId.toHexString()}`,
    permissions: permissions.map((permission) => ({ permission, effect: 'ALLOW' })),
    isSystemDefault: false,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await container.platformMemberships.replacePermissionProfiles(membership._id, 0, [profileId]);
  return { userId: actor.userId, membershipId: membership._id };
}

function supportCtx(
  supportActor: { userId: ObjectId; membershipId: ObjectId },
  effectiveActor: { userId: ObjectId; membershipId: ObjectId },
  workspaceId: ObjectId,
): RequestContext {
  return {
    ...ctx(supportActor.userId),
    platformMembershipId: hex(supportActor.membershipId),
    supportSessionId: new ObjectId().toHexString(),
    workspaceId: hex(workspaceId),
    effectiveUserId: hex(effectiveActor.userId),
    effectiveMembershipId: hex(effectiveActor.membershipId),
  };
}

function relationshipRoutes(workspaceId: ObjectId, relationshipId: ObjectId) {
  const base = `/api/v1/workspaces/${hex(workspaceId)}/relationships/${hex(relationshipId)}`;
  return [
    `${base}/dashboard`,
    `${base}/analytics/training`,
    `${base}/analytics/progress`,
    `${base}/analytics/nutrition`,
    `${base}/analytics/adherence`,
  ];
}

async function bearer(container: AppContainer, userId: ObjectId) {
  const session = await container.authSessions.create({
    userId,
    authenticationMethods: ['pwd'],
    restrictedUntilVerified: false,
    ipAddress: '127.0.0.1',
    clientType: 'API',
    transport: 'JSON',
    mfaSatisfiedAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return {
    authorization: `Bearer ${container.jwt.createAccessToken({ userId: hex(userId), authSessionId: hex(session._id), authenticationMethods: ['pwd'] })}`,
  };
}

function ctx(userId: ObjectId): RequestContext {
  return {
    correlationId: new ObjectId().toHexString(),
    userId: hex(userId),
    authSessionId: new ObjectId().toHexString(),
    ipAddress: '127.0.0.1',
    locale: 'en',
    timezone: 'Africa/Cairo',
  };
}

async function auditCount(container: AppContainer, accessKind: string) {
  return await container.database.db.collection('audit_events').countDocuments({ accessKind });
}

function hex(id: ObjectId) {
  return id.toHexString();
}

function integrationConfig(dbName: string): AppConfig {
  return {
    env: 'test',
    app: { host: '0.0.0.0', port: 3000, docsEnabled: false, trustProxy: false, allowedOrigins: [] },
    mongo: {
      uri:
        process.env.MONGODB_URI ??
        'mongodb://localhost:27017/gym_platform?replicaSet=rs0&directConnection=true',
      dbName,
      connectTimeoutMs: 500,
    },
    logging: { level: 'silent' },
    audit: { retentionPolicy: 'INDEFINITE' },
    auth: {
      jwtActiveKeyId: 'local',
      jwtPrivateKey: [
        '-----BEGIN PRIVATE KEY-----',
        'MC4CAQAwBQYDK2VwBCIEIP27WzZ2lrwob/CusOSRmtVPlS0TPTrBOFjTuBztUPm8',
        '-----END PRIVATE KEY-----',
      ].join('\n'),
      jwtPublicKeys: {
        local: [
          '-----BEGIN PUBLIC KEY-----',
          'MCowBQYDK2VwAyEAVk4E+7jo4OHXHcYC1lvT+vqaViaFNdUPnMcuSDPpp60=',
          '-----END PUBLIC KEY-----',
        ].join('\n'),
      },
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      webRefreshCookieSameSite: 'LAX',
      otpHmacSecret: 'secret',
      totpEncryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      loginIdentifierIpWindowMs: 900_000,
      loginIdentifierIpMaxAttempts: 5,
      loginIdentifierIpBlockMs: 900_000,
      loginIpWindowMs: 900_000,
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
      id: 'test-worker',
      outboxPollIntervalMs: 1000,
      outboxLockMs: 30_000,
      outboxMaxAttempts: 8,
      jobLeaseMs: 30_000,
    },
    subscriptions: { trialExpiryAction: 'FROZEN', paidGraceDays: 0, frozenToExpiredDays: 30 },
    support: { defaultSessionMinutes: 30, maxSessionMinutes: 60 },
  };
}
