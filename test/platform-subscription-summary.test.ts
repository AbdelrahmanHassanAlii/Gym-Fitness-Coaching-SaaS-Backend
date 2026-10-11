import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { Permissions } from '../src/modules/permissions/permission.registry';
import { SubscriptionLifecycleStatuses } from '../src/modules/subscriptions/subscription.types';
import { WorkspaceStatuses } from '../src/modules/workspaces/workspace.types';
import {
  assertSummaryAuthorization,
  assertSummarySupportDenial,
  type SummaryHarness,
  summaryGet,
  summaryHarness,
} from './platform-workspace-summary.helpers';

describe('Platform subscription summary', () => {
  let h: SummaryHarness;
  beforeAll(async () => {
    h = await summaryHarness('platform_subscription_summary');
  }, 30_000);
  afterEach(async () => await h.clear());
  afterAll(async () => await h.close());

  test('requires unrestricted MFA Platform commercial authority, honors DENY, rejects tenant roles', async () => {
    await assertSummaryAuthorization(h, 'subscription-summary', Permissions.SubscriptionsRead);
  });

  test('rejects resolved support before authorization or business lookup, with no write residue', async () => {
    await assertSummarySupportDenial(h, 'subscription-summary', Permissions.SubscriptionsRead);
  });

  test('absence returns 200/null without provisioning, writes, audit, outbox, or idempotency', async () => {
    const workspaceId = await h.workspace();
    const actor = await h.actor(Permissions.SubscriptionsRead);
    const subscriptionEnsure = spyOn(h.container.subscriptionsRepo, 'ensurePendingActivation');
    const usageEnsure = spyOn(h.container.workspaceUsage, 'ensure');
    try {
      const before = await h.snapshot();
      const response = await get(workspaceId, actor.token);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json<unknown>()).toEqual({
        data: { workspaceId: workspaceId.toHexString(), subscription: null },
      });
      expect(subscriptionEnsure).not.toHaveBeenCalled();
      expect(usageEnsure).not.toHaveBeenCalled();
      expect(await h.snapshot()).toEqual(before);
    } finally {
      subscriptionEnsure.mockRestore();
      usageEnsure.mockRestore();
    }
  });

  test('pending intent is not current terms and all missing lifecycle dates normalize to null', async () => {
    const workspaceId = await h.workspace();
    const actor = await h.actor(Permissions.SubscriptionsRead);
    await h.db.collection('subscriptions').insertOne({
      _id: new ObjectId(),
      workspaceId,
      lifecycleStatus: 'PENDING_ACTIVATION',
      pendingActivationIntent: { planVersionId: new ObjectId(), createdBy: actor.userId },
      version: 123,
    });
    const before = await h.snapshot();
    expect((await get(workspaceId, actor.token)).json<unknown>()).toEqual({
      data: {
        workspaceId: workspaceId.toHexString(),
        subscription: {
          lifecycleStatus: 'PENDING_ACTIVATION',
          startedAt: null,
          expiresAt: null,
          graceEndsAt: null,
          frozenAt: null,
          expiredAt: null,
          cancelledAt: null,
          currentTerms: null,
        },
      },
    });
    expect(await h.snapshot()).toEqual(before);
  });

  test('uses subscribed pointer/version and current disabled-plan metadata; emits only exact minimized fields', async () => {
    const workspaceId = await h.workspace();
    const actor = await h.actor(Permissions.SubscriptionsRead);
    const seed = await seedSubscription(workspaceId);
    await h.db.collection('subscription_terms').insertOne({
      _id: new ObjectId(),
      workspaceId,
      subscriptionId: seed.subscriptionId,
      planVersionId: new ObjectId(),
      effectiveFrom: new Date('2030-01-01T00:00:00.000Z'),
    });
    const before = await h.snapshot();
    const response = await get(workspaceId, actor.token);
    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({
      data: {
        workspaceId: workspaceId.toHexString(),
        subscription: {
          lifecycleStatus: 'ACTIVE',
          startedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-12-31T00:00:00.000Z',
          graceEndsAt: '2027-01-07T00:00:00.000Z',
          frozenAt: '2027-01-08T00:00:00.000Z',
          expiredAt: '2027-02-08T00:00:00.000Z',
          cancelledAt: '2027-03-08T00:00:00.000Z',
          currentTerms: {
            planId: seed.planId.toHexString(),
            planName: 'Renamed archived plan',
            planVersionId: seed.planVersionId.toHexString(),
            billingPeriod: 'YEARLY',
            effectiveFrom: '2026-02-01T00:00:00.000Z',
            effectiveTo: '2026-12-31T00:00:00.000Z',
          },
        },
      },
    });
    expect(await h.snapshot()).toEqual(before);
    await h.db
      .collection('subscription_terms')
      .updateOne({ _id: seed.termsId }, { $unset: { effectiveTo: '' } });
    expect(
      (await get(workspaceId, actor.token)).json().data.subscription.currentTerms.effectiveTo,
    ).toBeNull();
  });

  test('fails safely for missing/mismatched terms and broken version/plan references without writes', async () => {
    const actor = await h.actor(Permissions.SubscriptionsRead);
    for (const defect of [
      'missing-terms',
      'wrong-workspace',
      'wrong-subscription',
      'missing-version',
      'missing-plan',
    ]) {
      const workspaceId = await h.workspace();
      const seed = await seedSubscription(workspaceId);
      if (defect === 'missing-terms')
        await h.db.collection('subscription_terms').deleteOne({ _id: seed.termsId });
      if (defect === 'wrong-workspace')
        await h.db
          .collection('subscription_terms')
          .updateOne({ _id: seed.termsId }, { $set: { workspaceId: new ObjectId() } });
      if (defect === 'wrong-subscription')
        await h.db
          .collection('subscription_terms')
          .updateOne({ _id: seed.termsId }, { $set: { subscriptionId: new ObjectId() } });
      if (defect === 'missing-version')
        await h.db.collection('subscription_plan_versions').deleteOne({ _id: seed.planVersionId });
      if (defect === 'missing-plan')
        await h.db.collection('subscription_plans').deleteOne({ _id: seed.planId });
      const before = await h.snapshot();
      const response = await get(workspaceId, actor.token);
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('SUBSCRIPTION_SUMMARY_INTEGRITY_ERROR');
      expect(response.json().data).toBeUndefined();
      expect(await h.snapshot()).toEqual(before);
    }
  });

  test('reads every workspace status and subscription lifecycle; missing workspace 404, malformed ID 400', async () => {
    const actor = await h.actor(Permissions.SubscriptionsRead);
    for (const status of WorkspaceStatuses) {
      const workspaceId = await h.workspace(status);
      await seedSubscription(workspaceId);
      expect((await get(workspaceId, actor.token)).statusCode).toBe(200);
    }
    const workspaceId = await h.workspace();
    await seedSubscription(workspaceId);
    for (const lifecycleStatus of SubscriptionLifecycleStatuses) {
      await h.db
        .collection('subscriptions')
        .updateOne({ workspaceId }, { $set: { lifecycleStatus } });
      const response = await get(workspaceId, actor.token);
      expect(response.statusCode).toBe(200);
      expect(response.json().data.subscription.lifecycleStatus).toBe(lifecycleStatus);
    }
    const missing = await get(new ObjectId(), actor.token);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('WORKSPACE_NOT_FOUND');
    expect(
      (await summaryGet(h.app, '/api/v1/platform/workspaces/bad/subscription-summary', actor.token))
        .statusCode,
    ).toBe(400);
  });

  async function get(workspaceId: ObjectId, token: string) {
    return await summaryGet(
      h.app,
      `/api/v1/platform/workspaces/${workspaceId}/subscription-summary`,
      token,
    );
  }

  async function seedSubscription(workspaceId: ObjectId) {
    const subscriptionId = new ObjectId();
    const termsId = new ObjectId();
    const planId = new ObjectId();
    const planVersionId = new ObjectId();
    await h.db.collection('subscription_plans').insertOne({
      _id: planId,
      key: `plan-${planId}`,
      name: 'Renamed archived plan',
      active: false,
      currentVersionId: new ObjectId(),
      version: 99,
    });
    await h.db.collection('subscription_plan_versions').insertOne({
      _id: planVersionId,
      planId,
      version: 1,
      defaultLimits: { activeStaff: 9 },
      features: { private: true },
    });
    await h.db.collection('subscriptions').insertOne({
      _id: subscriptionId,
      workspaceId,
      currentTermsId: termsId,
      lifecycleStatus: 'ACTIVE',
      version: 42,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-12-31T00:00:00.000Z'),
      graceEndsAt: new Date('2027-01-07T00:00:00.000Z'),
      frozenAt: new Date('2027-01-08T00:00:00.000Z'),
      expiredAt: new Date('2027-02-08T00:00:00.000Z'),
      cancelledAt: new Date('2027-03-08T00:00:00.000Z'),
      pendingActivationIntent: { createdBy: new ObjectId() },
      deletionLockRequestId: new ObjectId(),
    });
    await h.db.collection('subscription_terms').insertOne({
      _id: termsId,
      subscriptionId,
      workspaceId,
      planVersionId,
      billingPeriod: 'YEARLY',
      effectiveFrom: new Date('2026-02-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-12-31T00:00:00.000Z'),
      limits: { storageBytes: 999 },
      enabledFeatures: ['private'],
      source: 'PURCHASE',
      createdBy: new ObjectId(),
    });
    return { subscriptionId, termsId, planId, planVersionId };
  }
});
