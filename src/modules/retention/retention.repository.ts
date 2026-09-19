import {
  type Collection,
  type Document,
  type Filter,
  MongoServerError,
  type ObjectId,
} from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { FileDocument } from '../files/file.types';
import type {
  ManualPaymentDocument,
  SubscriptionDocument,
} from '../subscriptions/subscription.types';
import type { WorkspaceDocument } from '../workspaces/workspace.types';
import type {
  DeletionActorMetadata,
  DeletionCheckpoint,
  DeletionCheckpointStepId,
  RetentionWarningMarkerDocument,
  WorkspaceDeletionRequestDocument,
  WorkspaceDeletionStatus,
} from './retention.types';

export const activeDeletionStatuses: WorkspaceDeletionStatus[] = [
  'PENDING_APPROVAL',
  'POSTPONED',
  'APPROVED',
  'PROCESSING',
  'FAILED',
];

export const deletionStepIds: DeletionCheckpointStepId[] = [
  'TERMINATE_ACTIVE_EXPORTS',
  'DETERMINE_RETAINED_EVIDENCE',
  'REMOVE_CUSTOMER_ACCESS',
  'STAGE13_MARK_FILES',
  'DELETE_TENANT_DATA',
  'VERIFY_NO_LIVE_WORKSPACE_DATA',
  'FINALIZE_TOMBSTONE',
];

export interface DeleteTarget {
  collection: string;
  predicate: (workspaceId: ObjectId) => Filter<Document>;
}

export const deletionTargets: DeleteTarget[] = [
  { collection: 'workspace_memberships', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'branches', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'membership_branch_assignments', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'invitations', predicate: (workspaceId) => ({ workspaceId }) },
  {
    collection: 'permission_profiles',
    predicate: (workspaceId) => ({ context: 'WORKSPACE', workspaceId }),
  },
  {
    collection: 'access_grants',
    predicate: (workspaceId) => ({ context: 'WORKSPACE', workspaceId }),
  },
  { collection: 'coaching_relationships', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'trainee_staff_assignments', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'referral_codes', predicate: (workspaceId) => ({ ownerWorkspaceId: workspaceId }) },
  {
    collection: 'exercises',
    predicate: (workspaceId) => ({ workspaceId, scope: { $in: ['GYM', 'PRIVATE'] } }),
  },
  { collection: 'program_templates', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'program_template_revisions', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'programs', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'program_revisions', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'program_progress', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'program_progress_events', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'workout_sessions', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'personal_records', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'personal_record_events', predicate: (workspaceId) => ({ workspaceId }) },
  {
    collection: 'foods',
    predicate: (workspaceId) => ({ workspaceId, scope: { $in: ['GYM', 'PRIVATE'] } }),
  },
  { collection: 'nutrition_plans', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'nutrition_plan_revisions', predicate: (workspaceId) => ({ workspaceId }) },
  {
    collection: 'metric_definitions',
    predicate: (workspaceId) => ({ workspaceId, scope: { $in: ['GYM', 'PRIVATE'] } }),
  },
  { collection: 'measurement_entries', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'progress_photo_entries', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'trainee_health_profiles', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'coaching_notes', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'adherence_configs', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'daily_tracking_entries', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'checkin_templates', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'checkin_template_revisions', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'checkin_assignments', predicate: (workspaceId) => ({ workspaceId }) },
  { collection: 'checkin_instances', predicate: (workspaceId) => ({ workspaceId }) },
];

export class RetentionRepository {
  private readonly warnings: Collection<RetentionWarningMarkerDocument>;
  private readonly deletions: Collection<WorkspaceDeletionRequestDocument>;
  private readonly subscriptions: Collection<SubscriptionDocument>;
  private readonly workspaces: Collection<WorkspaceDocument>;
  private readonly manualPayments: Collection<ManualPaymentDocument>;
  private readonly files: Collection<FileDocument>;

  constructor(private readonly database: Database) {
    this.warnings = database.db.collection<RetentionWarningMarkerDocument>(
      'retention_warning_markers',
    );
    this.deletions = database.db.collection<WorkspaceDeletionRequestDocument>(
      'workspace_deletion_requests',
    );
    this.subscriptions = database.db.collection<SubscriptionDocument>('subscriptions');
    this.workspaces = database.db.collection<WorkspaceDocument>('workspaces');
    this.manualPayments = database.db.collection<ManualPaymentDocument>('manual_payments');
    this.files = database.db.collection<FileDocument>('files');
  }

  async createWarning(
    warning: RetentionWarningMarkerDocument,
    tx?: TransactionContext,
  ): Promise<boolean> {
    const result = await this.warnings.updateOne(
      {
        subscriptionId: warning.subscriptionId,
        warningOffsetDays: warning.warningOffsetDays,
        eligibilityAt: warning.eligibilityAt,
      },
      { $setOnInsert: warning },
      { upsert: true, ...(tx ? { session: tx.session } : {}) },
    );
    return result.upsertedCount === 1;
  }

  async findExpiredSubscriptions(limit: number): Promise<SubscriptionDocument[]> {
    return await this.subscriptions
      .find({ lifecycleStatus: 'EXPIRED', expiredAt: { $exists: true } })
      .sort({ expiredAt: 1, _id: 1 })
      .limit(limit)
      .toArray();
  }

  async createDeletionRequest(
    request: WorkspaceDeletionRequestDocument,
    tx?: TransactionContext,
  ): Promise<WorkspaceDeletionRequestDocument> {
    try {
      await this.deletions.insertOne(request, tx ? { session: tx.session } : undefined);
      return request;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw conflict('WORKSPACE_DELETION_ALREADY_ACTIVE');
      }
      throw error;
    }
  }

  async findById(id: ObjectId, tx?: TransactionContext) {
    return await this.deletions.findOne({ _id: id }, tx ? { session: tx.session } : undefined);
  }

  async list(limit: number, after?: ObjectId) {
    const query = after ? { _id: { $lt: after } } : {};
    return await this.deletions.find(query).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
  }

  async hasActiveDeletion(workspaceId: ObjectId, tx?: TransactionContext): Promise<boolean> {
    const existing = await this.deletions.findOne(
      { workspaceId, status: { $in: activeDeletionStatuses } },
      { projection: { _id: 1 }, ...(tx ? { session: tx.session } : {}) },
    );
    return Boolean(existing);
  }

  async claimSubscriptionForApproval(input: {
    workspaceId: ObjectId;
    subscriptionId: ObjectId;
    expectedVersion: number;
    deletionRequestId: ObjectId;
    now: Date;
    tx: TransactionContext;
  }): Promise<SubscriptionDocument> {
    const updated = await this.subscriptions.findOneAndUpdate(
      {
        _id: input.subscriptionId,
        workspaceId: input.workspaceId,
        lifecycleStatus: 'EXPIRED',
        expiredAt: { $exists: true },
        version: input.expectedVersion,
        deletionLockRequestId: { $exists: false },
      },
      {
        $set: {
          deletionLockRequestId: input.deletionRequestId,
          deletionLockClaimedAt: input.now,
          updatedAt: input.now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!updated) throw conflict('WORKSPACE_DELETION_ELIGIBILITY_CHANGED');
    return updated;
  }

  async restrictWorkspace(input: {
    workspaceId: ObjectId;
    deletionRequestId: ObjectId;
    now: Date;
    tx: TransactionContext;
  }): Promise<void> {
    const result = await this.workspaces.updateOne(
      { _id: input.workspaceId, status: 'ACTIVE' },
      {
        $set: {
          status: 'RESTRICTED',
          deletionLockRequestId: input.deletionRequestId,
          deletionLockedAt: input.now,
          updatedAt: input.now,
        },
        $inc: { version: 1 },
      },
      { session: input.tx.session },
    );
    if (result.modifiedCount !== 1) throw conflict('WORKSPACE_DELETION_LOCK_CONFLICT');
  }

  async approve(input: {
    deletionId: ObjectId;
    expectedVersion: number;
    actor: DeletionActorMetadata;
    reason: string;
    now: Date;
    tx: TransactionContext;
  }): Promise<WorkspaceDeletionRequestDocument> {
    const updated = await this.deletions.findOneAndUpdate(
      {
        _id: input.deletionId,
        version: input.expectedVersion,
        status: { $in: ['PENDING_APPROVAL', 'POSTPONED'] },
      },
      {
        $set: {
          status: 'APPROVED',
          approvedAt: input.now,
          approvedBy: input.actor,
          approvalReason: input.reason,
          updatedAt: input.now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!updated) throw conflict('WORKSPACE_DELETION_VERSION_CONFLICT');
    return updated;
  }

  async postpone(input: {
    deletionId: ObjectId;
    expectedVersion: number;
    actor: DeletionActorMetadata;
    reason: string;
    reviewAfter: Date;
    now: Date;
    tx: TransactionContext;
  }): Promise<WorkspaceDeletionRequestDocument> {
    const updated = await this.deletions.findOneAndUpdate(
      {
        _id: input.deletionId,
        version: input.expectedVersion,
        status: { $in: ['PENDING_APPROVAL', 'POSTPONED'] },
      },
      {
        $set: {
          status: 'POSTPONED',
          reviewAfter: input.reviewAfter,
          postponedAt: input.now,
          postponedBy: input.actor,
          postponeReason: input.reason,
          updatedAt: input.now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!updated) throw conflict('WORKSPACE_DELETION_VERSION_CONFLICT');
    return updated;
  }

  async cancel(input: {
    deletionId: ObjectId;
    expectedVersion: number;
    actor: DeletionActorMetadata;
    reason: string;
    now: Date;
    tx: TransactionContext;
  }): Promise<WorkspaceDeletionRequestDocument> {
    const updated = await this.deletions.findOneAndUpdate(
      {
        _id: input.deletionId,
        version: input.expectedVersion,
        status: { $in: ['PENDING_APPROVAL', 'POSTPONED'] },
      },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: input.now,
          cancelledBy: input.actor,
          cancellationReason: input.reason,
          updatedAt: input.now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!updated) throw conflict('WORKSPACE_DELETION_VERSION_CONFLICT');
    return updated;
  }

  async cancelActiveBeforeApproval(input: {
    workspaceId: ObjectId;
    reason: string;
    now: Date;
    tx?: TransactionContext;
  }): Promise<ObjectId[]> {
    const candidates = await this.deletions
      .find(
        {
          workspaceId: input.workspaceId,
          status: { $in: ['PENDING_APPROVAL', 'POSTPONED'] },
        },
        input.tx
          ? { session: input.tx.session, projection: { _id: 1 } }
          : { projection: { _id: 1 } },
      )
      .toArray();
    if (candidates.length === 0) return [];
    const result = await this.deletions.updateMany(
      {
        workspaceId: input.workspaceId,
        status: { $in: ['PENDING_APPROVAL', 'POSTPONED'] },
        _id: { $in: candidates.map((candidate) => candidate._id) },
      },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: input.now,
          cancelledBy: { type: 'SYSTEM', reason: input.reason },
          cancellationReason: input.reason,
          updatedAt: input.now,
        },
        $inc: { version: 1 },
      },
      input.tx ? { session: input.tx.session } : undefined,
    );
    return result.modifiedCount > 0 ? candidates.map((candidate) => candidate._id) : [];
  }

  async returnPostponedForReview(now: Date): Promise<number> {
    const result = await this.deletions.updateMany(
      { status: 'POSTPONED', reviewAfter: { $lte: now } },
      {
        $set: { status: 'PENDING_APPROVAL', updatedAt: now },
        $inc: { version: 1 },
      },
    );
    return result.modifiedCount;
  }

  async claimNextForProcessing(workerId: string, leaseExpiresAt: Date, now: Date) {
    const updated = await this.deletions.findOneAndUpdate(
      {
        status: { $in: ['APPROVED', 'FAILED', 'PROCESSING'] },
        $or: [
          { status: { $in: ['APPROVED', 'FAILED'] } },
          { status: 'PROCESSING', processingLeaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: 'PROCESSING',
          processingClaimedByWorkerId: workerId,
          processingLeaseExpiresAt: leaseExpiresAt,
          processingStartedAt: now,
          updatedAt: now,
        },
        $inc: { version: 1, processingAttemptCount: 1 },
      },
      { sort: { updatedAt: 1, _id: 1 }, returnDocument: 'after' },
    );
    return updated;
  }

  async updateCheckpoint(input: {
    deletionId: ObjectId;
    step: DeletionCheckpoint;
    currentStep?: DeletionCheckpointStepId;
    now: Date;
  }) {
    const existing = await this.findById(input.deletionId);
    if (!existing) throw conflict('WORKSPACE_DELETION_NOT_FOUND');
    const checkpoints = upsertCheckpoint(existing.checkpoints, input.step);
    await this.deletions.updateOne(
      { _id: input.deletionId },
      {
        $set: {
          checkpoints,
          ...(input.currentStep ? { currentStep: input.currentStep } : {}),
          updatedAt: input.now,
        },
        $inc: { version: 1 },
      },
    );
  }

  async markFailed(input: {
    deletionId: ObjectId;
    code: string;
    message: string;
    now: Date;
  }): Promise<void> {
    await this.deletions.updateOne(
      { _id: input.deletionId, status: 'PROCESSING' },
      {
        $set: {
          status: 'FAILED',
          failure: {
            code: input.code,
            message: input.message,
            failedAt: input.now,
            retryable: true,
          },
          updatedAt: input.now,
        },
        $inc: { version: 1 },
      },
    );
  }

  async complete(input: {
    deletionId: ObjectId;
    workspaceId: ObjectId;
    liveDataDeletedAt: Date;
    backupExpiryAt?: Date;
    now: Date;
    tx: TransactionContext;
  }): Promise<void> {
    await this.workspaces.updateOne(
      { _id: input.workspaceId, status: 'RESTRICTED' },
      {
        $set: {
          status: 'ARCHIVED',
          liveDataDeletedAt: input.liveDataDeletedAt,
          deletionCompletedAt: input.now,
          ...(input.backupExpiryAt ? { backupExpiryAt: input.backupExpiryAt } : {}),
          updatedAt: input.now,
        },
        $inc: { version: 1 },
      },
      { session: input.tx.session },
    );
    const result = await this.deletions.updateOne(
      { _id: input.deletionId, status: 'PROCESSING' },
      {
        $set: {
          status: 'COMPLETED',
          completedAt: input.now,
          liveDataDeletedAt: input.liveDataDeletedAt,
          ...(input.backupExpiryAt ? { backupExpiryAt: input.backupExpiryAt } : {}),
          updatedAt: input.now,
        },
        $inc: { version: 1 },
      },
      { session: input.tx.session },
    );
    if (result.modifiedCount !== 1) throw conflict('WORKSPACE_DELETION_COMPLETION_CONFLICT');
  }

  async findPaymentProofFileIds(workspaceId: ObjectId): Promise<ObjectId[]> {
    const payments = await this.manualPayments
      .find({ workspaceId, proofFileId: { $exists: true } }, { projection: { proofFileId: 1 } })
      .toArray();
    return [
      ...new Map(
        payments.flatMap((payment) =>
          payment.proofFileId ? [[payment.proofFileId.toHexString(), payment.proofFileId]] : [],
        ),
      ).values(),
    ];
  }

  async deleteBatch(input: {
    target: DeleteTarget;
    workspaceId: ObjectId;
    afterId?: ObjectId;
    limit: number;
  }): Promise<{ deletedCount: number; lastId?: ObjectId; remaining: boolean }> {
    const collection = this.database.db.collection(input.target.collection);
    const base = input.target.predicate(input.workspaceId);
    const ids = await collection
      .find(
        { ...base, ...(input.afterId ? { _id: { $gt: input.afterId } } : {}) },
        { projection: { _id: 1 } },
      )
      .sort({ _id: 1 })
      .limit(input.limit)
      .toArray();
    if (ids.length === 0) return { deletedCount: 0, remaining: false };
    const lastId = ids[ids.length - 1]?._id as ObjectId;
    const deleteResult = await collection.deleteMany({ _id: { $in: ids.map((item) => item._id) } });
    const next = await collection.findOne(
      { ...base, _id: { $gt: lastId } },
      { projection: { _id: 1 } },
    );
    return {
      deletedCount: deleteResult.deletedCount,
      lastId,
      remaining: Boolean(next),
    };
  }

  async countTarget(target: DeleteTarget, workspaceId: ObjectId): Promise<number> {
    return await this.database.db
      .collection(target.collection)
      .countDocuments(target.predicate(workspaceId));
  }

  async countActiveGeneratedExports(workspaceId: ObjectId): Promise<number> {
    return await this.database.db.collection('workspace_export_requests').countDocuments({
      workspaceId,
      status: { $in: ['PENDING', 'PROCESSING', 'READY'] },
    });
  }

  async countDownloadableFiles(workspaceId: ObjectId, retainFileIds: ObjectId[]): Promise<number> {
    return await this.files.countDocuments({
      workspaceId,
      status: 'ACTIVE',
      _id: { $nin: retainFileIds },
    });
  }

  async countActiveDocuments(workspaceId: ObjectId, retainFileIds: ObjectId[]): Promise<number> {
    return await this.database.db.collection('documents').countDocuments({
      workspaceId,
      status: 'ACTIVE',
      ...(retainFileIds.length > 0 ? { fileId: { $nin: retainFileIds } } : {}),
    });
  }

  async countExistingFiles(fileIds: ObjectId[]): Promise<number> {
    if (fileIds.length === 0) return 0;
    return await this.files.countDocuments({ _id: { $in: fileIds } });
  }

  async workspaceIsDeletionLocked(workspaceId: ObjectId): Promise<boolean> {
    const workspace = await this.workspaces.findOne(
      { _id: workspaceId },
      { projection: { status: 1, deletionLockRequestId: 1 } },
    );
    return Boolean(
      workspace && workspace.status === 'RESTRICTED' && workspace.deletionLockRequestId,
    );
  }
}

function upsertCheckpoint(
  checkpoints: DeletionCheckpoint[],
  next: DeletionCheckpoint,
): DeletionCheckpoint[] {
  const others = checkpoints.filter((item) => item.stepId !== next.stepId);
  return [...others, next].sort(
    (left, right) => deletionStepIds.indexOf(left.stepId) - deletionStepIds.indexOf(right.stepId),
  );
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The retention state has changed.' });
}
