import { type Collection, MongoServerError, ObjectId, type UpdateFilter } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type {
  BillingPeriod,
  ManualPaymentDocument,
  SubscriptionDocument,
  SubscriptionLifecycleStatus,
  SubscriptionLimits,
  SubscriptionPlanDocument,
  SubscriptionPlanVersionDocument,
  SubscriptionTermDocument,
  WorkspaceUsageDocument,
} from './subscription.types';

export class SubscriptionPlanRepository {
  private readonly plans: Collection<SubscriptionPlanDocument>;
  private readonly versions: Collection<SubscriptionPlanVersionDocument>;

  constructor(database: Database) {
    this.plans = database.db.collection<SubscriptionPlanDocument>('subscription_plans');
    this.versions = database.db.collection<SubscriptionPlanVersionDocument>(
      'subscription_plan_versions',
    );
  }

  async create(
    input: { key: string; customerType: 'INDIVIDUAL_TRAINER' | 'GYM'; name: string; now?: Date },
    tx?: TransactionContext,
  ): Promise<SubscriptionPlanDocument> {
    const now = input.now ?? new Date();
    const plan: SubscriptionPlanDocument = {
      _id: new ObjectId(),
      key: input.key,
      customerType: input.customerType,
      name: input.name,
      active: true,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.plans.insertOne(plan, tx ? { session: tx.session } : undefined);
      return plan;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw conflict('SUBSCRIPTION_PLAN_KEY_CONFLICT');
      }
      throw error;
    }
  }

  async list(): Promise<SubscriptionPlanDocument[]> {
    return await this.plans.find({}).sort({ key: 1 }).toArray();
  }

  async findById(
    planId: ObjectId,
    tx?: TransactionContext,
  ): Promise<SubscriptionPlanDocument | null> {
    return await this.plans.findOne({ _id: planId }, tx ? { session: tx.session } : undefined);
  }

  async updateMetadata(
    planId: ObjectId,
    expectedVersion: number,
    input: { name?: string; active?: boolean; now?: Date },
    tx?: TransactionContext,
  ): Promise<SubscriptionPlanDocument> {
    const result = await this.plans.findOneAndUpdate(
      { _id: planId, version: expectedVersion },
      { $set: { ...compact(input), updatedAt: input.now ?? new Date() }, $inc: { version: 1 } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('SUBSCRIPTION_PLAN_VERSION_CONFLICT');
    return result;
  }

  async archive(
    planId: ObjectId,
    expectedVersion: number,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<SubscriptionPlanDocument> {
    const result = await this.plans.findOneAndUpdate(
      { _id: planId, active: true, version: expectedVersion },
      { $set: { active: false, updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('SUBSCRIPTION_PLAN_ARCHIVE_INVALID');
    return result;
  }

  async createVersion(
    input: {
      planId: ObjectId;
      billingOptions: BillingPeriod[];
      defaultLimits: SubscriptionLimits;
      features: Record<string, boolean>;
      trialDays?: number;
      effectiveFrom: Date;
      createdBy: ObjectId;
      now?: Date;
    },
    tx?: TransactionContext,
  ): Promise<SubscriptionPlanVersionDocument> {
    const now = input.now ?? new Date();
    const plan = await this.plans.findOneAndUpdate(
      { _id: input.planId, active: true },
      { $inc: { version: 1 }, $set: { updatedAt: now } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!plan) throw notFound('SUBSCRIPTION_PLAN_NOT_FOUND');
    const versionNumber = plan.version;
    const version: SubscriptionPlanVersionDocument = {
      _id: new ObjectId(),
      planId: input.planId,
      version: versionNumber,
      billingOptions: input.billingOptions,
      defaultLimits: input.defaultLimits,
      features: input.features,
      ...(input.trialDays !== undefined ? { trialDefaults: { days: input.trialDays } } : {}),
      effectiveFrom: input.effectiveFrom,
      createdBy: input.createdBy,
      createdAt: now,
    };
    await this.versions.insertOne(version, tx ? { session: tx.session } : undefined);
    await this.plans.updateOne(
      { _id: input.planId },
      { $set: { currentVersionId: version._id, updatedAt: now } },
      tx ? { session: tx.session } : undefined,
    );
    return version;
  }

  async findVersionById(
    versionId: ObjectId,
    tx?: TransactionContext,
  ): Promise<SubscriptionPlanVersionDocument | null> {
    return await this.versions.findOne(
      { _id: versionId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async listVersions(planId: ObjectId): Promise<SubscriptionPlanVersionDocument[]> {
    return await this.versions.find({ planId }).sort({ version: -1 }).toArray();
  }

  async findVersionWithPlan(
    versionId: ObjectId,
    tx?: TransactionContext,
  ): Promise<{
    version: SubscriptionPlanVersionDocument;
    plan: SubscriptionPlanDocument;
  } | null> {
    const version = await this.findVersionById(versionId, tx);
    if (!version) return null;
    const plan = await this.findById(version.planId, tx);
    if (!plan) return null;
    return { version, plan };
  }
}

export class SubscriptionRepository {
  private readonly subscriptions: Collection<SubscriptionDocument>;
  private readonly terms: Collection<SubscriptionTermDocument>;

  constructor(database: Database) {
    this.subscriptions = database.db.collection<SubscriptionDocument>('subscriptions');
    this.terms = database.db.collection<SubscriptionTermDocument>('subscription_terms');
  }

  async ensurePendingActivation(
    workspaceId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<SubscriptionDocument> {
    const existing = await this.findByWorkspaceId(workspaceId, tx);
    if (existing) return existing;
    const subscription: SubscriptionDocument = {
      _id: new ObjectId(),
      workspaceId,
      lifecycleStatus: 'PENDING_ACTIVATION',
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.subscriptions.insertOne(subscription, tx ? { session: tx.session } : undefined);
    return subscription;
  }

  async findByWorkspaceId(
    workspaceId: ObjectId,
    tx?: TransactionContext,
  ): Promise<SubscriptionDocument | null> {
    return await this.subscriptions.findOne(
      { workspaceId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async transition(
    workspaceId: ObjectId,
    expectedVersion: number,
    from: SubscriptionLifecycleStatus[],
    to: SubscriptionLifecycleStatus,
    patch: Partial<SubscriptionDocument>,
    unset: Array<keyof SubscriptionDocument> = [],
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<SubscriptionDocument> {
    const update: UpdateFilter<SubscriptionDocument> = {
      $set: { ...patch, lifecycleStatus: to, updatedAt: now },
      $inc: { version: 1 },
      ...(unset.length > 0
        ? { $unset: Object.fromEntries(unset.map((field) => [field, ''])) }
        : {}),
    };
    const result = await this.subscriptions.findOneAndUpdate(
      { workspaceId, lifecycleStatus: { $in: from }, version: expectedVersion },
      update,
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('SUBSCRIPTION_VERSION_CONFLICT');
    return result;
  }

  async attachTerms(
    workspaceId: ObjectId,
    expectedVersion: number,
    allowedSources: SubscriptionLifecycleStatus[],
    term: Omit<SubscriptionTermDocument, '_id' | 'createdAt'> & { now?: Date },
    status: SubscriptionLifecycleStatus,
    patch: Partial<SubscriptionDocument>,
    unset: Array<keyof SubscriptionDocument> = [],
    tx?: TransactionContext,
  ): Promise<{ subscription: SubscriptionDocument; terms: SubscriptionTermDocument }> {
    const now = term.now ?? new Date();
    const existing = await this.findByWorkspaceId(workspaceId, tx);
    if (!existing) throw notFound('SUBSCRIPTION_NOT_FOUND');
    const terms: SubscriptionTermDocument = {
      _id: new ObjectId(),
      subscriptionId: existing._id,
      workspaceId,
      planVersionId: term.planVersionId,
      billingPeriod: term.billingPeriod,
      limits: term.limits,
      enabledFeatures: term.enabledFeatures,
      effectiveFrom: term.effectiveFrom,
      ...(term.effectiveTo ? { effectiveTo: term.effectiveTo } : {}),
      source: term.source,
      createdBy: term.createdBy,
      createdAt: now,
    };
    const update: UpdateFilter<SubscriptionDocument> = {
      $set: {
        ...patch,
        lifecycleStatus: status,
        currentTermsId: terms._id,
        updatedAt: now,
      },
      $inc: { version: 1 },
      ...(unset.length > 0
        ? { $unset: Object.fromEntries(unset.map((field) => [field, ''])) }
        : {}),
    };
    const subscription = await this.subscriptions.findOneAndUpdate(
      {
        _id: existing._id,
        workspaceId,
        version: expectedVersion,
        lifecycleStatus: { $in: allowedSources },
      },
      update,
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!subscription) throw conflict('SUBSCRIPTION_VERSION_CONFLICT');
    await this.terms.updateMany(
      { subscriptionId: existing._id, effectiveTo: { $exists: false } },
      { $set: { effectiveTo: terms.effectiveFrom } },
      tx ? { session: tx.session } : undefined,
    );
    await this.terms.insertOne(terms, tx ? { session: tx.session } : undefined);
    return { subscription, terms };
  }

  async setPendingActivationIntent(
    workspaceId: ObjectId,
    expectedVersion: number,
    intent: NonNullable<SubscriptionDocument['pendingActivationIntent']>,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<SubscriptionDocument> {
    const result = await this.subscriptions.findOneAndUpdate(
      { workspaceId, version: expectedVersion, lifecycleStatus: 'PENDING_ACTIVATION' },
      {
        $set: {
          pendingActivationIntent: intent,
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('SUBSCRIPTION_VERSION_CONFLICT');
    return result;
  }

  async findCurrentTerms(
    subscription: SubscriptionDocument,
    tx?: TransactionContext,
  ): Promise<SubscriptionTermDocument | null> {
    if (!subscription.currentTermsId) return null;
    return await this.terms.findOne(
      {
        _id: subscription.currentTermsId,
        subscriptionId: subscription._id,
        workspaceId: subscription.workspaceId,
      },
      tx ? { session: tx.session } : undefined,
    );
  }

  async listLifecycleDue(statuses: SubscriptionLifecycleStatus[], now = new Date()) {
    return await this.subscriptions
      .find({
        lifecycleStatus: { $in: statuses },
        $or: [
          { expiresAt: { $lte: now } },
          { graceEndsAt: { $lte: now } },
          { frozenAt: { $lte: now } },
        ],
      })
      .sort({ updatedAt: 1 })
      .limit(100)
      .toArray();
  }
}

export class WorkspaceUsageRepository {
  private readonly usage: Collection<WorkspaceUsageDocument>;

  constructor(database: Database) {
    this.usage = database.db.collection<WorkspaceUsageDocument>('workspace_usage');
  }

  async ensure(
    workspaceId: ObjectId,
    counters: Partial<
      Pick<WorkspaceUsageDocument, 'activeStaff' | 'activeTrainees' | 'storageBytes'>
    > = {},
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<WorkspaceUsageDocument> {
    await this.usage.updateOne(
      { workspaceId },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          workspaceId,
          activeTrainees: counters.activeTrainees ?? 0,
          activeStaff: counters.activeStaff ?? 0,
          storageBytes: counters.storageBytes ?? 0,
          reservedStorageBytes: 0,
          revision: 0,
          calculatedAt: now,
          updatedAt: now,
        },
      },
      { upsert: true, ...(tx ? { session: tx.session } : {}) },
    );
    const document = await this.findByWorkspaceId(workspaceId, tx);
    if (!document) throw notFound('WORKSPACE_USAGE_NOT_FOUND');
    return document;
  }

  async findByWorkspaceId(
    workspaceId: ObjectId,
    tx?: TransactionContext,
  ): Promise<WorkspaceUsageDocument | null> {
    return await this.usage.findOne({ workspaceId }, tx ? { session: tx.session } : undefined);
  }

  async repairCalculatedIfRevision(
    workspaceId: ObjectId,
    expectedRevision: number,
    counters: { activeTrainees: number; activeStaff: number; storageBytes: number },
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<WorkspaceUsageDocument | null> {
    const result = await this.usage.findOneAndUpdate(
      { workspaceId, revision: expectedRevision },
      {
        $set: {
          ...counters,
          calculatedAt: now,
          updatedAt: now,
        },
        $inc: { revision: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    return result;
  }

  async reserveTrainee(
    workspaceId: ObjectId,
    limit: number | undefined,
    tx?: TransactionContext,
  ): Promise<void> {
    await this.reserveCounter(workspaceId, 'activeTrainees', limit, 'TRAINEE_LIMIT_EXCEEDED', tx);
  }

  async reserveStaff(
    workspaceId: ObjectId,
    limit: number | undefined,
    tx?: TransactionContext,
  ): Promise<void> {
    await this.reserveCounter(workspaceId, 'activeStaff', limit, 'STAFF_LIMIT_EXCEEDED', tx);
  }

  async reserveStorage(
    workspaceId: ObjectId,
    bytes: number,
    limit: number,
    tx?: TransactionContext,
  ): Promise<void> {
    const result = await this.usage.updateOne(
      {
        workspaceId,
        $expr: {
          $lte: [{ $add: ['$storageBytes', '$reservedStorageBytes', bytes] }, limit],
        },
      },
      { $inc: { reservedStorageBytes: bytes, revision: 1 }, $set: { updatedAt: new Date() } },
      tx ? { session: tx.session } : undefined,
    );
    if (result.modifiedCount !== 1) throw limitExceeded('STORAGE_LIMIT_EXCEEDED', limit);
  }

  private async reserveCounter(
    workspaceId: ObjectId,
    field: 'activeTrainees' | 'activeStaff',
    limit: number | undefined,
    code: string,
    tx?: TransactionContext,
  ): Promise<void> {
    if (limit === undefined) {
      await this.usage.updateOne(
        { workspaceId },
        { $inc: { [field]: 1, revision: 1 }, $set: { updatedAt: new Date() } },
        tx ? { session: tx.session } : undefined,
      );
      return;
    }
    const result = await this.usage.updateOne(
      { workspaceId, [field]: { $lt: limit } },
      { $inc: { [field]: 1, revision: 1 }, $set: { updatedAt: new Date() } },
      tx ? { session: tx.session } : undefined,
    );
    if (result.modifiedCount !== 1) throw limitExceeded(code, limit);
  }
}

export class ManualPaymentRepository {
  private readonly payments: Collection<ManualPaymentDocument>;

  constructor(database: Database) {
    this.payments = database.db.collection<ManualPaymentDocument>('manual_payments');
  }

  async create(
    input: {
      workspaceId: ObjectId;
      subscriptionId?: ObjectId;
      amount: number;
      currency: string;
      paymentMethod: string;
      paymentReference?: string;
      paidAt?: Date;
      notes?: string;
      createdBy: ObjectId;
      now?: Date;
    },
    tx?: TransactionContext,
  ): Promise<ManualPaymentDocument> {
    const now = input.now ?? new Date();
    const payment: ManualPaymentDocument = {
      _id: new ObjectId(),
      workspaceId: input.workspaceId,
      ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
      amount: input.amount,
      currency: input.currency,
      paymentMethod: input.paymentMethod,
      ...(input.paymentReference ? { paymentReference: input.paymentReference } : {}),
      ...(input.paidAt ? { paidAt: input.paidAt } : {}),
      status: 'PENDING',
      ...(input.notes ? { notes: input.notes } : {}),
      version: 0,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await this.payments.insertOne(payment, tx ? { session: tx.session } : undefined);
    return payment;
  }

  async listByWorkspace(workspaceId: ObjectId): Promise<ManualPaymentDocument[]> {
    return await this.payments.find({ workspaceId }).sort({ createdAt: -1 }).limit(100).toArray();
  }

  async listPlatform(): Promise<ManualPaymentDocument[]> {
    return await this.payments.find({}).sort({ createdAt: -1 }).limit(100).toArray();
  }

  async findById(
    paymentId: ObjectId,
    tx?: TransactionContext,
  ): Promise<ManualPaymentDocument | null> {
    return await this.payments.findOne(
      { _id: paymentId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async findByIdInWorkspace(
    workspaceId: ObjectId,
    paymentId: ObjectId,
    tx?: TransactionContext,
  ): Promise<ManualPaymentDocument | null> {
    return await this.payments.findOne(
      { _id: paymentId, workspaceId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async approve(
    paymentId: ObjectId,
    expectedVersion: number,
    reviewedBy: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<ManualPaymentDocument> {
    const result = await this.payments.findOneAndUpdate(
      { _id: paymentId, status: 'PENDING', version: expectedVersion },
      {
        $set: { status: 'APPROVED', reviewedBy, reviewedAt: now, updatedAt: now },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('PAYMENT_REVIEW_CONFLICT');
    return result;
  }

  async reject(
    paymentId: ObjectId,
    expectedVersion: number,
    reviewedBy: ObjectId,
    reason: string,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<ManualPaymentDocument> {
    const result = await this.payments.findOneAndUpdate(
      { _id: paymentId, status: 'PENDING', version: expectedVersion },
      {
        $set: {
          status: 'REJECTED',
          reviewedBy,
          reviewedAt: now,
          rejectionReason: reason,
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('PAYMENT_REVIEW_CONFLICT');
    return result;
  }
}

function compact<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(
    Object.entries(input).filter(([key, value]) => value !== undefined && key !== 'now'),
  );
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The commercial state has changed.' });
}

function limitExceeded(code: string, limit: number): AppError {
  return new AppError({
    code,
    httpStatus: 403,
    message: 'The subscription limit has been reached.',
    details: { limit },
  });
}

function notFound(code: string): AppError {
  return new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
}
