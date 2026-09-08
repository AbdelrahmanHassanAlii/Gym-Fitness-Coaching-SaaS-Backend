import { ObjectId } from 'mongodb';
import type { AppConfig } from '../../config/config.types';
import type { AuditWriter } from '../../core/audit/audit.writer';
import type { TransactionContext, UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { OutboxWriter } from '../../core/events/outbox.writer';
import type { RequestContext } from '../../core/request-context/request-context';
import type {
  WorkspaceMembershipRepository,
  WorkspaceRepository,
} from '../workspaces/workspace.repository';
import type {
  ManualPaymentRepository,
  SubscriptionPlanRepository,
  SubscriptionRepository,
  WorkspaceUsageRepository,
} from './subscription.repository';
import type {
  BillingPeriod,
  EntitlementAction,
  ManualPaymentDocument,
  SubscriptionDocument,
  SubscriptionLifecycleStatus,
  SubscriptionLimits,
  SubscriptionPlanDocument,
  SubscriptionPlanVersionDocument,
  SubscriptionTermDocument,
  SubscriptionTermSource,
  UsageCompliance,
  WorkspaceUsageDocument,
} from './subscription.types';

const activeStaffRoles = new Set(['GYM_MANAGER', 'TRAINER', 'ASSISTANT_TRAINER', 'NUTRITIONIST']);
const activeLifecycleMarkers: Array<keyof SubscriptionDocument> = [
  'frozenAt',
  'graceEndsAt',
  'expiredAt',
];

const transitionsToActive = {
  planChange: ['TRIAL', 'ACTIVE', 'GRACE_PERIOD'] as SubscriptionLifecycleStatus[],
  reactivation: [
    'PENDING_ACTIVATION',
    'FROZEN',
    'EXPIRED',
    'GRACE_PERIOD',
  ] as SubscriptionLifecycleStatus[],
  paymentApproval: [
    'PENDING_ACTIVATION',
    'TRIAL',
    'ACTIVE',
    'GRACE_PERIOD',
    'FROZEN',
    'EXPIRED',
  ] as SubscriptionLifecycleStatus[],
};

export class EntitlementService {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly usage: WorkspaceUsageRepository,
  ) {}

  async evaluate(workspaceId: ObjectId, action: EntitlementAction, feature?: string) {
    const subscription = await this.subscriptions.findByWorkspaceId(workspaceId);
    if (!subscription) throw notFound('SUBSCRIPTION_NOT_FOUND');
    const terms = await this.subscriptions.findCurrentTerms(subscription);
    const usage = await this.usage.ensure(workspaceId);
    const accessMode = accessModeFor(subscription.lifecycleStatus);
    const allowedByLifecycle =
      action === 'READ' ||
      subscription.lifecycleStatus === 'TRIAL' ||
      subscription.lifecycleStatus === 'ACTIVE';
    const featureAllowed = !feature || Boolean(terms?.enabledFeatures.includes(feature));
    return {
      allowed: allowedByLifecycle && featureAllowed,
      action,
      accessMode,
      lifecycleStatus: subscription.lifecycleStatus,
      featureAllowed,
      usageCompliance: usageCompliance(terms?.limits, usage),
      subscription,
      terms,
      usage,
    };
  }

  async assert(workspaceId: ObjectId, action: EntitlementAction, feature?: string) {
    const result = await this.evaluate(workspaceId, action, feature);
    if (!result.allowed) {
      throw new AppError({
        code: result.featureAllowed ? 'SUBSCRIPTION_FROZEN' : 'FEATURE_NOT_AVAILABLE',
        httpStatus: 403,
        message: 'The workspace subscription does not allow this action.',
      });
    }
    return result;
  }

  async assertAndReserveTraineeSlot(workspaceId: ObjectId, tx?: TransactionContext): Promise<void> {
    const result = await this.assert(workspaceId, 'ACTIVATE_TRAINEE');
    await this.usage.reserveTrainee(workspaceId, result.terms?.limits.activeTrainees, tx);
  }

  async assertAndReserveStaffSlot(workspaceId: ObjectId, tx?: TransactionContext): Promise<void> {
    const result = await this.assert(workspaceId, 'ACTIVATE_STAFF');
    await this.usage.reserveStaff(workspaceId, result.terms?.limits.activeStaff, tx);
  }

  async assertAndReserveStorage(
    workspaceId: ObjectId,
    bytes: number,
    tx?: TransactionContext,
  ): Promise<void> {
    const result = await this.assert(workspaceId, 'UPLOAD');
    if (!result.terms)
      throw new AppError({
        code: 'STORAGE_LIMIT_EXCEEDED',
        httpStatus: 403,
        message: 'Storage is unavailable.',
      });
    await this.usage.reserveStorage(workspaceId, bytes, result.terms.limits.storageBytes, tx);
  }
}

export class SubscriptionApplicationService {
  constructor(
    private readonly config: AppConfig,
    private readonly unitOfWork: UnitOfWork,
    private readonly plans: SubscriptionPlanRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly usage: WorkspaceUsageRepository,
    private readonly payments: ManualPaymentRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async getWorkspaceSubscription(_ctx: RequestContext, workspaceId: string) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.assertWorkspaceExists(id);
    const subscription = await this.subscriptions.ensurePendingActivation(id);
    const terms = await this.subscriptions.findCurrentTerms(subscription);
    const usage = await this.usage.ensure(id);
    return subscriptionReadModel(subscription, terms, usage);
  }

  async getWorkspaceUsage(_ctx: RequestContext, workspaceId: string) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.assertWorkspaceExists(id);
    const subscription = await this.subscriptions.ensurePendingActivation(id);
    const terms = await this.subscriptions.findCurrentTerms(subscription);
    const usage = await this.usage.ensure(id);
    return {
      usage: safeUsage(usage),
      limits: terms?.limits,
      usageCompliance: usageCompliance(terms?.limits, usage),
    };
  }

  async createManualPayment(
    ctx: RequestContext,
    workspaceId: string,
    input: {
      amount: number;
      currency: string;
      paymentMethod: string;
      paymentReference?: string;
      paidAt?: string;
      notes?: string;
    },
    tx?: TransactionContext,
  ) {
    const actorId = actorObjectId(ctx);
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.assertWorkspaceExists(id);
    const now = new Date();
    return await this.withTransaction(tx, async (tx) => {
      const subscription = await this.subscriptions.ensurePendingActivation(id, now, tx);
      const payment = await this.payments.create(
        {
          workspaceId: id,
          subscriptionId: subscription._id,
          amount: input.amount,
          currency: input.currency.trim().toUpperCase(),
          paymentMethod: input.paymentMethod.trim(),
          ...(input.paymentReference ? { paymentReference: input.paymentReference.trim() } : {}),
          ...(input.paidAt ? { paidAt: new Date(input.paidAt) } : {}),
          ...(input.notes ? { notes: input.notes.trim() } : {}),
          createdBy: actorId,
          now,
        },
        tx,
      );
      await this.writeAudit(ctx, id, 'ManualPaymentCreated', payment._id, 'create', tx);
      await this.writeOutbox(ctx, id, 'ManualPaymentCreated', 'manual_payment', payment._id, tx);
      return { payment: safePayment(payment) };
    });
  }

  async listWorkspacePayments(_ctx: RequestContext, workspaceId: string) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.assertWorkspaceExists(id);
    return await page(this.payments.listByWorkspace(id), safePayment);
  }

  async listPlans(_ctx: RequestContext) {
    return await page(this.plans.list(), safePlan);
  }

  async createPlan(
    ctx: RequestContext,
    input: { key: string; customerType: 'INDIVIDUAL_TRAINER' | 'GYM'; name: string },
    tx?: TransactionContext,
  ) {
    return await this.withTransaction(tx, async (tx) => {
      const plan = await this.plans.create(
        {
          key: input.key.trim(),
          customerType: input.customerType,
          name: input.name.trim(),
        },
        tx,
      );
      await this.writeAudit(ctx, undefined, 'SubscriptionPlanCreated', plan._id, 'create', tx);
      await this.writeOutbox(
        ctx,
        undefined,
        'SubscriptionPlanCreated',
        'subscription_plan',
        plan._id,
        tx,
      );
      return { plan: safePlan(plan) };
    });
  }

  async getPlan(_ctx: RequestContext, planId: string) {
    const plan = await this.requirePlan(objectId(planId, 'SUBSCRIPTION_PLAN_NOT_FOUND'));
    return {
      plan: safePlan(plan),
      versions: (await this.plans.listVersions(plan._id)).map(safePlanVersion),
    };
  }

  async updatePlan(
    ctx: RequestContext,
    planId: string,
    input: { expectedVersion: number; name?: string },
  ) {
    const id = objectId(planId, 'SUBSCRIPTION_PLAN_NOT_FOUND');
    const update: { name?: string } = {};
    if (input.name) update.name = input.name.trim();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const plan = await this.plans.updateMetadata(id, input.expectedVersion, update, tx);
      await this.writeAudit(ctx, undefined, 'SubscriptionPlanUpdated', id, 'update', tx);
      await this.writeOutbox(
        ctx,
        undefined,
        'SubscriptionPlanUpdated',
        'subscription_plan',
        id,
        tx,
      );
      return { plan: safePlan(plan) };
    });
  }

  async createPlanVersion(
    ctx: RequestContext,
    planId: string,
    input: {
      billingOptions: BillingPeriod[];
      defaultLimits: SubscriptionLimits;
      features: Record<string, boolean>;
      trialDays?: number;
      effectiveFrom: string;
    },
    tx?: TransactionContext,
  ) {
    const id = objectId(planId, 'SUBSCRIPTION_PLAN_NOT_FOUND');
    return await this.withTransaction(tx, async (tx) => {
      const version = await this.plans.createVersion(
        compact({
          planId: id,
          billingOptions: input.billingOptions,
          defaultLimits: input.defaultLimits,
          features: input.features,
          trialDays: input.trialDays,
          effectiveFrom: new Date(input.effectiveFrom),
          createdBy: actorObjectId(ctx),
        }),
        tx,
      );
      await this.writeAudit(
        ctx,
        undefined,
        'SubscriptionPlanVersionCreated',
        version._id,
        'create',
        tx,
      );
      await this.writeOutbox(
        ctx,
        undefined,
        'SubscriptionPlanVersionCreated',
        'subscription_plan_version',
        version._id,
        tx,
      );
      return { version: safePlanVersion(version) };
    });
  }

  async archivePlan(ctx: RequestContext, planId: string, expectedVersion: number) {
    const id = objectId(planId, 'SUBSCRIPTION_PLAN_NOT_FOUND');
    return await this.unitOfWork.withTransaction(async (tx) => {
      const plan = await this.plans.archive(id, expectedVersion, new Date(), tx);
      await this.writeAudit(ctx, undefined, 'SubscriptionPlanArchived', id, 'archive', tx);
      await this.writeOutbox(
        ctx,
        undefined,
        'SubscriptionPlanArchived',
        'subscription_plan',
        id,
        tx,
      );
      return { plan: safePlan(plan) };
    });
  }

  async getPlatformSubscription(ctx: RequestContext, workspaceId: string) {
    return await this.getWorkspaceSubscription(ctx, workspaceId);
  }

  async startTrial(
    ctx: RequestContext,
    workspaceId: string,
    input: {
      expectedVersion: number;
      planVersionId: string;
      billingPeriod: BillingPeriod;
      effectiveFrom: string;
      trialDays?: number;
    },
    tx?: TransactionContext,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.assertWorkspaceExists(id);
    const planVersion = await this.requireEligiblePlanVersion(
      objectId(input.planVersionId, 'SUBSCRIPTION_PLAN_VERSION_NOT_FOUND'),
      input.billingPeriod,
    );
    const now = new Date();
    const effectiveFrom = new Date(input.effectiveFrom);
    const trialDays = input.trialDays ?? planVersion.trialDefaults?.days;
    if (!trialDays || trialDays < 1) throw invalid('SUBSCRIPTION_TRIAL_DAYS_REQUIRED');
    return await this.withTransaction(tx, async (tx) => {
      const subscription = await this.subscriptions.ensurePendingActivation(id, now, tx);
      if (subscription.lifecycleStatus !== 'PENDING_ACTIVATION') {
        throw conflict('SUBSCRIPTION_TRIAL_INVALID');
      }
      const result = await this.subscriptions.attachTerms(
        id,
        input.expectedVersion,
        ['PENDING_ACTIVATION'],
        {
          subscriptionId: subscription._id,
          workspaceId: id,
          planVersionId: planVersion._id,
          billingPeriod: input.billingPeriod,
          limits: planVersion.defaultLimits,
          enabledFeatures: enabledFeatures(planVersion.features),
          effectiveFrom,
          effectiveTo: addDays(effectiveFrom, trialDays),
          source: 'TRIAL',
          createdBy: actorObjectId(ctx),
          now,
        },
        'TRIAL',
        {
          startedAt: effectiveFrom,
          expiresAt: addDays(effectiveFrom, trialDays),
        },
        activeLifecycleMarkers,
        tx,
      );
      await this.writeAudit(ctx, id, 'TrialStarted', result.subscription._id, 'start_trial', tx);
      await this.writeOutbox(ctx, id, 'TrialStarted', 'subscription', result.subscription._id, tx);
      return {
        subscription: safeSubscription(result.subscription),
        currentTerms: safeTerms(result.terms),
      };
    });
  }

  async changePlan(
    ctx: RequestContext,
    workspaceId: string,
    input: ChangeTermsInput,
    source: 'UPGRADE' | 'DOWNGRADE' | 'ADMIN_OVERRIDE',
    tx?: TransactionContext,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.assertWorkspaceExists(id);
    const planVersion = await this.requireEligiblePlanVersion(
      objectId(input.planVersionId, 'SUBSCRIPTION_PLAN_VERSION_NOT_FOUND'),
      input.billingPeriod,
    );
    return await this.createTermsSnapshot(
      ctx,
      id,
      planVersion,
      input,
      source,
      'SubscriptionTermsChanged',
      transitionsToActive.planChange,
      tx,
    );
  }

  async freeze(
    ctx: RequestContext,
    workspaceId: string,
    input: { expectedVersion: number },
    tx?: TransactionContext,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.assertWorkspaceExists(id);
    return await this.transitionSubscription(
      ctx,
      id,
      input.expectedVersion,
      ['TRIAL', 'ACTIVE', 'GRACE_PERIOD'],
      'FROZEN',
      { frozenAt: new Date() },
      'SubscriptionFrozen',
      'freeze',
      tx,
    );
  }

  async reactivate(
    ctx: RequestContext,
    workspaceId: string,
    input: ChangeTermsInput,
    tx?: TransactionContext,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.assertWorkspaceExists(id);
    const planVersion = await this.requireEligiblePlanVersion(
      objectId(input.planVersionId, 'SUBSCRIPTION_PLAN_VERSION_NOT_FOUND'),
      input.billingPeriod,
    );
    return await this.createTermsSnapshot(
      ctx,
      id,
      planVersion,
      input,
      'PURCHASE',
      'SubscriptionActivated',
      transitionsToActive.reactivation,
      tx,
    );
  }

  async cancel(
    ctx: RequestContext,
    workspaceId: string,
    input: { expectedVersion: number },
    tx?: TransactionContext,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.assertWorkspaceExists(id);
    return await this.transitionSubscription(
      ctx,
      id,
      input.expectedVersion,
      ['PENDING_ACTIVATION', 'TRIAL', 'ACTIVE', 'GRACE_PERIOD', 'FROZEN', 'EXPIRED'],
      'CANCELLED',
      { cancelledAt: new Date() },
      'SubscriptionCancelled',
      'cancel',
      tx,
    );
  }

  async listPlatformPayments(_ctx: RequestContext) {
    return await page(this.payments.listPlatform(), safePayment);
  }

  async getPlatformPayment(_ctx: RequestContext, paymentId: string) {
    const payment = await this.payments.findById(objectId(paymentId, 'PAYMENT_NOT_FOUND'));
    if (!payment) throw notFound('PAYMENT_NOT_FOUND');
    return { payment: safePayment(payment) };
  }

  async approvePayment(
    ctx: RequestContext,
    paymentId: string,
    input: ChangeTermsInput & { paymentExpectedVersion: number },
    tx?: TransactionContext,
  ) {
    const id = objectId(paymentId, 'PAYMENT_NOT_FOUND');
    const existing = await this.payments.findById(id);
    if (!existing) throw notFound('PAYMENT_NOT_FOUND');
    const planVersion = await this.requireEligiblePlanVersion(
      objectId(input.planVersionId, 'SUBSCRIPTION_PLAN_VERSION_NOT_FOUND'),
      input.billingPeriod,
    );
    await this.assertWorkspaceExists(existing.workspaceId);
    return await this.withTransaction(tx, async (tx) => {
      const payment = await this.payments.approve(
        id,
        input.paymentExpectedVersion,
        actorObjectId(ctx),
        new Date(),
        tx,
      );
      const subscriptionResult = await this.createTermsSnapshotInTransaction(
        ctx,
        payment.workspaceId,
        planVersion,
        input,
        'PURCHASE',
        'PaymentApproved',
        transitionsToActive.paymentApproval,
        tx,
      );
      await this.writeAudit(
        ctx,
        payment.workspaceId,
        'PaymentApproved',
        payment._id,
        'approve',
        tx,
      );
      await this.writeOutbox(
        ctx,
        payment.workspaceId,
        'PaymentApproved',
        'manual_payment',
        payment._id,
        tx,
      );
      await this.writeOutbox(
        ctx,
        payment.workspaceId,
        'SubscriptionActivated',
        'subscription',
        subscriptionResult.subscription._id,
        tx,
      );
      return {
        payment: safePayment(payment),
        subscription: safeSubscription(subscriptionResult.subscription),
        currentTerms: safeTerms(subscriptionResult.terms),
      };
    });
  }

  async rejectPayment(
    ctx: RequestContext,
    paymentId: string,
    input: { expectedVersion: number; reason: string },
    tx?: TransactionContext,
  ) {
    const id = objectId(paymentId, 'PAYMENT_NOT_FOUND');
    return await this.withTransaction(tx, async (tx) => {
      const payment = await this.payments.reject(
        id,
        input.expectedVersion,
        actorObjectId(ctx),
        input.reason.trim(),
        new Date(),
        tx,
      );
      await this.writeAudit(ctx, payment.workspaceId, 'PaymentRejected', payment._id, 'reject', tx);
      await this.writeOutbox(
        ctx,
        payment.workspaceId,
        'PaymentRejected',
        'manual_payment',
        payment._id,
        tx,
      );
      return { payment: safePayment(payment) };
    });
  }

  async expireTrials(now = new Date()): Promise<number> {
    const due = await this.subscriptions.listLifecycleDue(['TRIAL'], now);
    let count = 0;
    for (const subscription of due.filter((item) => item.expiresAt && item.expiresAt <= now)) {
      const target = this.config.subscriptions.trialExpiryAction;
      const patch =
        target === 'GRACE_PERIOD'
          ? { graceEndsAt: addDays(now, this.config.subscriptions.paidGraceDays) }
          : { frozenAt: now };
      await this.systemTransition(subscription, target, patch, 'TrialExpired', now);
      count += 1;
    }
    return count;
  }

  async advanceLifecycle(now = new Date()): Promise<number> {
    const due = await this.subscriptions.listLifecycleDue(
      ['ACTIVE', 'GRACE_PERIOD', 'FROZEN'],
      now,
    );
    let count = 0;
    for (const subscription of due) {
      if (
        subscription.lifecycleStatus === 'ACTIVE' &&
        subscription.expiresAt &&
        subscription.expiresAt <= now
      ) {
        if (this.config.subscriptions.paidGraceDays > 0) {
          await this.systemTransition(
            subscription,
            'GRACE_PERIOD',
            { graceEndsAt: addDays(now, this.config.subscriptions.paidGraceDays) },
            'SubscriptionTermExpired',
            now,
          );
        } else {
          await this.systemTransition(
            subscription,
            'FROZEN',
            { frozenAt: now },
            'SubscriptionFrozen',
            now,
          );
        }
        count += 1;
      } else if (
        subscription.lifecycleStatus === 'GRACE_PERIOD' &&
        subscription.graceEndsAt &&
        subscription.graceEndsAt <= now
      ) {
        await this.systemTransition(
          subscription,
          'FROZEN',
          { frozenAt: now },
          'SubscriptionFrozen',
          now,
        );
        count += 1;
      } else if (
        subscription.lifecycleStatus === 'FROZEN' &&
        subscription.frozenAt &&
        subscription.frozenAt <= addDays(now, -this.config.subscriptions.frozenToExpiredDays)
      ) {
        await this.systemTransition(
          subscription,
          'EXPIRED',
          { expiredAt: now },
          'SubscriptionExpired',
          now,
        );
        count += 1;
      }
    }
    return count;
  }

  async reconcileWorkspaceUsage(now = new Date()): Promise<number> {
    const workspaceIds = await this.workspaces.listIds();
    let repaired = 0;
    for (const workspaceId of workspaceIds) {
      const counters = await this.calculateUsage(workspaceId);
      const current = await this.usage.ensure(workspaceId, counters, now);
      if (
        current.activeStaff !== counters.activeStaff ||
        current.activeTrainees !== counters.activeTrainees ||
        current.storageBytes !== counters.storageBytes
      ) {
        await this.unitOfWork.withTransaction(async (tx) => {
          await this.usage.replaceCalculated(workspaceId, counters, now, tx);
          await this.writeAudit(
            { correlationId: `usage-reconcile-${now.toISOString()}` } as RequestContext,
            workspaceId,
            'WorkspaceUsageReconciled',
            workspaceId,
            'reconcile',
            tx,
          );
        });
        repaired += 1;
      }
    }
    return repaired;
  }

  private async createTermsSnapshot(
    ctx: RequestContext,
    workspaceId: ObjectId,
    planVersion: SubscriptionPlanVersionDocument,
    input: ChangeTermsInput,
    source: SubscriptionTermSource,
    eventType: string,
    allowedSources: SubscriptionLifecycleStatus[],
    tx?: TransactionContext,
  ) {
    return await this.withTransaction(tx, async (tx) => {
      const result = await this.createTermsSnapshotInTransaction(
        ctx,
        workspaceId,
        planVersion,
        input,
        source,
        eventType,
        allowedSources,
        tx,
      );
      return result.response;
    });
  }

  private async createTermsSnapshotInTransaction(
    ctx: RequestContext,
    workspaceId: ObjectId,
    planVersion: SubscriptionPlanVersionDocument,
    input: ChangeTermsInput,
    source: SubscriptionTermSource,
    eventType: string,
    allowedSources: SubscriptionLifecycleStatus[],
    tx: TransactionContext,
  ) {
    const subscription = await this.subscriptions.ensurePendingActivation(
      workspaceId,
      new Date(),
      tx,
    );
    const effectiveFrom = new Date(input.effectiveFrom);
    const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : undefined;
    const result = await this.subscriptions.attachTerms(
      workspaceId,
      input.expectedVersion,
      allowedSources,
      {
        subscriptionId: subscription._id,
        workspaceId,
        planVersionId: planVersion._id,
        billingPeriod: input.billingPeriod,
        limits: input.limits ?? planVersion.defaultLimits,
        enabledFeatures: input.enabledFeatures ?? enabledFeatures(planVersion.features),
        effectiveFrom,
        ...(effectiveTo ? { effectiveTo } : {}),
        source,
        createdBy: actorObjectId(ctx),
      },
      'ACTIVE',
      {
        startedAt: subscription.startedAt ?? effectiveFrom,
        ...(effectiveTo ? { expiresAt: effectiveTo } : {}),
      },
      effectiveTo ? activeLifecycleMarkers : [...activeLifecycleMarkers, 'expiresAt'],
      tx,
    );
    await this.writeAudit(ctx, workspaceId, eventType, result.subscription._id, 'change_terms', tx);
    await this.writeOutbox(
      ctx,
      workspaceId,
      eventType,
      'subscription',
      result.subscription._id,
      tx,
    );
    return {
      subscription: result.subscription,
      terms: result.terms,
      response: {
        subscription: safeSubscription(result.subscription),
        currentTerms: safeTerms(result.terms),
      },
    };
  }

  private async transitionSubscription(
    ctx: RequestContext,
    workspaceId: ObjectId,
    expectedVersion: number,
    from: SubscriptionLifecycleStatus[],
    to: SubscriptionLifecycleStatus,
    patch: Partial<SubscriptionDocument>,
    eventType: string,
    action: string,
    tx?: TransactionContext,
  ) {
    return await this.withTransaction(tx, async (tx) => {
      const subscription = await this.subscriptions.transition(
        workspaceId,
        expectedVersion,
        from,
        to,
        patch,
        [],
        new Date(),
        tx,
      );
      await this.writeAudit(ctx, workspaceId, eventType, subscription._id, action, tx);
      await this.writeOutbox(ctx, workspaceId, eventType, 'subscription', subscription._id, tx);
      return { subscription: safeSubscription(subscription) };
    });
  }

  private async systemTransition(
    subscription: SubscriptionDocument,
    to: SubscriptionLifecycleStatus,
    patch: Partial<SubscriptionDocument>,
    eventType: string,
    now: Date,
  ) {
    await this.unitOfWork.withTransaction(async (tx) => {
      const updated = await this.subscriptions.transition(
        subscription.workspaceId,
        subscription.version,
        [subscription.lifecycleStatus],
        to,
        patch,
        [],
        now,
        tx,
      );
      const ctx = {
        correlationId: `${eventType}-${updated._id.toHexString()}-${now.toISOString()}`,
      } as RequestContext;
      await this.writeAudit(
        ctx,
        updated.workspaceId,
        eventType,
        updated._id,
        'system_transition',
        tx,
      );
      await this.writeOutbox(ctx, updated.workspaceId, eventType, 'subscription', updated._id, tx);
    });
  }

  private async calculateUsage(workspaceId: ObjectId) {
    const memberships = await this.memberships.listByWorkspace(workspaceId);
    const activeStaffUsers = new Set(
      memberships
        .filter(
          (membership) =>
            membership.status === 'ACTIVE' &&
            membership.roles.some((role) => activeStaffRoles.has(role)),
        )
        .map((membership) => membership.userId.toHexString()),
    );
    return { activeTrainees: 0, activeStaff: activeStaffUsers.size, storageBytes: 0 };
  }

  private async requirePlan(planId: ObjectId) {
    const plan = await this.plans.findById(planId);
    if (!plan) throw notFound('SUBSCRIPTION_PLAN_NOT_FOUND');
    return plan;
  }

  private async requireEligiblePlanVersion(versionId: ObjectId, billingPeriod: BillingPeriod) {
    const result = await this.plans.findVersionWithPlan(versionId);
    if (!result) throw notFound('SUBSCRIPTION_PLAN_VERSION_NOT_FOUND');
    if (!result.plan.active) throw invalid('SUBSCRIPTION_PLAN_NOT_ELIGIBLE');
    if (!result.version.billingOptions.includes(billingPeriod)) {
      throw invalid('SUBSCRIPTION_BILLING_PERIOD_NOT_AVAILABLE');
    }
    return result.version;
  }

  private async assertWorkspaceExists(workspaceId: ObjectId) {
    const workspace = await this.workspaces.findById(workspaceId);
    if (!workspace) throw notFound('WORKSPACE_NOT_FOUND');
  }

  private async withTransaction<T>(
    tx: TransactionContext | undefined,
    operation: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    if (tx) return await operation(tx);
    return await this.unitOfWork.withTransaction(operation);
  }

  private async writeAudit(
    ctx: RequestContext,
    workspaceId: ObjectId | undefined,
    eventType: string,
    entityId: ObjectId,
    action: string,
    tx: TransactionContext,
  ) {
    await this.audit.write(
      {
        eventType,
        ...(workspaceId ? { workspaceId } : {}),
        actor: {
          ...(ctx.userId && ObjectId.isValid(ctx.userId)
            ? { userId: new ObjectId(ctx.userId) }
            : {}),
          ...(ctx.platformMembershipId && ObjectId.isValid(ctx.platformMembershipId)
            ? { platformMembershipId: new ObjectId(ctx.platformMembershipId) }
            : {}),
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
    workspaceId: ObjectId | undefined,
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
        ...(workspaceId ? { workspaceId } : {}),
        payload: { aggregateId: aggregateId.toHexString() },
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }
}

interface ChangeTermsInput {
  expectedVersion: number;
  planVersionId: string;
  billingPeriod: BillingPeriod;
  effectiveFrom: string;
  effectiveTo?: string;
  limits?: SubscriptionLimits;
  enabledFeatures?: string[];
}

function subscriptionReadModel(
  subscription: SubscriptionDocument,
  terms: SubscriptionTermDocument | null,
  usage: WorkspaceUsageDocument,
) {
  return {
    subscription: safeSubscription(subscription),
    lifecycleStatus: subscription.lifecycleStatus,
    usageCompliance: usageCompliance(terms?.limits, usage),
    accessMode: accessModeFor(subscription.lifecycleStatus),
    currentTerms: terms ? safeTerms(terms) : null,
    limits: terms?.limits ?? null,
    usage: safeUsage(usage),
  };
}

function safeSubscription(subscription: SubscriptionDocument) {
  return {
    id: subscription._id.toHexString(),
    workspaceId: subscription.workspaceId.toHexString(),
    lifecycleStatus: subscription.lifecycleStatus,
    currentTermsId: subscription.currentTermsId?.toHexString(),
    startedAt: subscription.startedAt?.toISOString(),
    expiresAt: subscription.expiresAt?.toISOString(),
    graceEndsAt: subscription.graceEndsAt?.toISOString(),
    frozenAt: subscription.frozenAt?.toISOString(),
    expiredAt: subscription.expiredAt?.toISOString(),
    cancelledAt: subscription.cancelledAt?.toISOString(),
    version: subscription.version,
  };
}

function safeTerms(terms: SubscriptionTermDocument) {
  return {
    id: terms._id.toHexString(),
    subscriptionId: terms.subscriptionId.toHexString(),
    workspaceId: terms.workspaceId.toHexString(),
    planVersionId: terms.planVersionId.toHexString(),
    billingPeriod: terms.billingPeriod,
    limits: terms.limits,
    enabledFeatures: terms.enabledFeatures,
    effectiveFrom: terms.effectiveFrom.toISOString(),
    effectiveTo: terms.effectiveTo?.toISOString(),
    source: terms.source,
  };
}

function safeUsage(usage: WorkspaceUsageDocument) {
  return {
    workspaceId: usage.workspaceId.toHexString(),
    activeTrainees: usage.activeTrainees,
    activeStaff: usage.activeStaff,
    storageBytes: usage.storageBytes,
    reservedStorageBytes: usage.reservedStorageBytes,
    calculatedAt: usage.calculatedAt.toISOString(),
  };
}

function safePlan(plan: SubscriptionPlanDocument) {
  return {
    id: plan._id.toHexString(),
    key: plan.key,
    customerType: plan.customerType,
    name: plan.name,
    active: plan.active,
    currentVersionId: plan.currentVersionId?.toHexString(),
    version: plan.version,
  };
}

function safePlanVersion(version: SubscriptionPlanVersionDocument) {
  return {
    id: version._id.toHexString(),
    planId: version.planId.toHexString(),
    version: version.version,
    billingOptions: version.billingOptions,
    defaultLimits: version.defaultLimits,
    features: version.features,
    trialDefaults: version.trialDefaults,
    effectiveFrom: version.effectiveFrom.toISOString(),
  };
}

function safePayment(payment: ManualPaymentDocument) {
  return {
    id: payment._id.toHexString(),
    workspaceId: payment.workspaceId.toHexString(),
    subscriptionId: payment.subscriptionId?.toHexString(),
    amount: payment.amount,
    currency: payment.currency,
    paymentMethod: payment.paymentMethod,
    paymentReference: payment.paymentReference,
    paidAt: payment.paidAt?.toISOString(),
    status: payment.status,
    reviewedBy: payment.reviewedBy?.toHexString(),
    reviewedAt: payment.reviewedAt?.toISOString(),
    rejectionReason: payment.rejectionReason,
    notes: payment.notes,
    version: payment.version,
    createdAt: payment.createdAt.toISOString(),
  };
}

async function page<T, R>(promise: Promise<T[]>, mapper: (value: T) => R) {
  return { data: (await promise).map(mapper), meta: { nextCursor: null, hasMore: false } };
}

function usageCompliance(
  limits: SubscriptionLimits | undefined,
  usage: WorkspaceUsageDocument,
): UsageCompliance {
  if (!limits) return 'MULTIPLE_LIMIT_VIOLATIONS';
  const violations = [
    limits.activeTrainees !== undefined && usage.activeTrainees > limits.activeTrainees,
    limits.activeStaff !== undefined && usage.activeStaff > limits.activeStaff,
    usage.storageBytes + usage.reservedStorageBytes > limits.storageBytes,
  ].filter(Boolean).length;
  if (violations > 1) return 'MULTIPLE_LIMIT_VIOLATIONS';
  if (limits.activeTrainees !== undefined && usage.activeTrainees > limits.activeTrainees)
    return 'OVER_TRAINEE_LIMIT';
  if (limits.activeStaff !== undefined && usage.activeStaff > limits.activeStaff)
    return 'OVER_STAFF_LIMIT';
  if (usage.storageBytes + usage.reservedStorageBytes > limits.storageBytes)
    return 'OVER_STORAGE_LIMIT';
  return 'WITHIN_LIMIT';
}

function accessModeFor(status: SubscriptionLifecycleStatus) {
  if (status === 'TRIAL' || status === 'ACTIVE') return 'WRITE';
  if (status === 'PENDING_ACTIVATION') return 'BILLING_RECOVERY_ONLY';
  return 'READ_ONLY';
}

function enabledFeatures(features: Record<string, boolean>): string[] {
  return Object.entries(features)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);
}

function compact<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as {
    [K in keyof T as undefined extends T[K] ? never : K]: T[K];
  } & Partial<T>;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
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

function objectId(value: string, code: string): ObjectId {
  if (!ObjectId.isValid(value)) throw notFound(code);
  return new ObjectId(value);
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The commercial state has changed.' });
}

function invalid(code: string): AppError {
  return new AppError({ code, httpStatus: 422, message: 'The subscription request is invalid.' });
}

function notFound(code: string): AppError {
  return new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
}
