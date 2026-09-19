import { ObjectId } from 'mongodb';
import type { AppConfig } from '../../config/config.types';
import type { AccessControlService } from '../../core/access-control/access-control.service';
import type { AuditWriter } from '../../core/audit/audit.writer';
import type { TransactionContext, UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { OutboxWriter } from '../../core/events/outbox.writer';
import type { RequestContext } from '../../core/request-context/request-context';
import type { WorkspaceExportRepository } from '../exports/export.repository';
import type { FileRepository } from '../files/file.repository';
import { Permissions } from '../permissions/permission.registry';
import type { SubscriptionRepository } from '../subscriptions/subscription.repository';
import type { SubscriptionDocument } from '../subscriptions/subscription.types';
import type { WorkspaceRepository } from '../workspaces/workspace.repository';
import { deletionStepIds, deletionTargets, type RetentionRepository } from './retention.repository';
import type {
  DeletionActorMetadata,
  DeletionCheckpoint,
  DeletionCheckpointStepId,
  WorkspaceDeletionRequestDocument,
} from './retention.types';

const msPerDay = 24 * 60 * 60 * 1000;

export class RetentionApplicationService {
  constructor(
    private readonly config: AppConfig,
    private readonly unitOfWork: UnitOfWork,
    private readonly repository: RetentionRepository,
    private readonly exportsRepo: WorkspaceExportRepository,
    private readonly filesRepo: FileRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly accessControl: AccessControlService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(ctx: RequestContext, input: { limit?: number; after?: string }) {
    await this.authorizePlatform(ctx, Permissions.DeletionRead);
    const after = input.after ? objectId(input.after, 'WORKSPACE_DELETION_NOT_FOUND') : undefined;
    const items = await this.repository.list(Math.min(input.limit ?? 50, 100), after);
    return { items: items.map(readModel), nextCursor: items.at(-1)?._id.toHexString() };
  }

  async get(ctx: RequestContext, deletionId: string) {
    await this.authorizePlatform(ctx, Permissions.DeletionRead);
    const deletion = await this.requireDeletionDocument(
      objectId(deletionId, 'WORKSPACE_DELETION_NOT_FOUND'),
    );
    return { deletion: readModel(deletion) };
  }

  async approve(
    ctx: RequestContext,
    deletionId: string,
    input: { expectedVersion: number; reason: string },
    tx?: TransactionContext,
  ) {
    await this.authorizePlatform(ctx, Permissions.DeletionApprove);
    const id = objectId(deletionId, 'WORKSPACE_DELETION_NOT_FOUND');
    const now = this.clock();
    const operation = async (transaction: TransactionContext) => {
      const deletion = await this.requireDeletionDocument(id, transaction);
      if (!['PENDING_APPROVAL', 'POSTPONED'].includes(deletion.status)) {
        throw conflict('WORKSPACE_DELETION_INVALID_TRANSITION');
      }
      const subscription = await this.subscriptions.findByWorkspaceId(
        deletion.workspaceId,
        transaction,
      );
      if (!subscription || !isDeletionEligible(subscription, now, this.eligibilityDays())) {
        throw conflict('WORKSPACE_DELETION_NOT_ELIGIBLE');
      }
      await this.repository.claimSubscriptionForApproval({
        workspaceId: deletion.workspaceId,
        subscriptionId: deletion.subscriptionId,
        expectedVersion: subscription.version,
        deletionRequestId: deletion._id,
        now,
        tx: transaction,
      });
      await this.repository.restrictWorkspace({
        workspaceId: deletion.workspaceId,
        deletionRequestId: deletion._id,
        now,
        tx: transaction,
      });
      const approved = await this.repository.approve({
        deletionId: deletion._id,
        expectedVersion: input.expectedVersion,
        actor: platformActor(ctx, input.reason),
        reason: input.reason.trim(),
        now,
        tx: transaction,
      });
      await this.exportsRepo.terminateActiveForWorkspace(deletion.workspaceId, now, transaction);
      await this.writeAudit(
        ctx,
        deletion.workspaceId,
        'WorkspaceDeletionApproved',
        deletion._id,
        'approve',
        transaction,
        { reason: input.reason.trim() },
      );
      await this.writeOutbox(
        ctx,
        deletion.workspaceId,
        'WorkspaceDeletionApproved',
        'workspace_deletion',
        deletion._id,
        transaction,
      );
      return { deletion: readModel(approved) };
    };
    return tx ? await operation(tx) : await this.unitOfWork.withTransaction(operation);
  }

  async postpone(
    ctx: RequestContext,
    deletionId: string,
    input: { expectedVersion: number; reason: string; reviewAfter: string },
  ) {
    await this.authorizePlatform(ctx, Permissions.DeletionPostpone);
    const id = objectId(deletionId, 'WORKSPACE_DELETION_NOT_FOUND');
    const now = this.clock();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const deletion = await this.repository.postpone({
        deletionId: id,
        expectedVersion: input.expectedVersion,
        actor: platformActor(ctx, input.reason),
        reason: input.reason.trim(),
        reviewAfter: new Date(input.reviewAfter),
        now,
        tx,
      });
      await this.writeAudit(
        ctx,
        deletion.workspaceId,
        'WorkspaceDeletionPostponed',
        id,
        'postpone',
        tx,
        {
          reason: input.reason.trim(),
        },
      );
      await this.writeOutbox(
        ctx,
        deletion.workspaceId,
        'WorkspaceDeletionPostponed',
        'workspace_deletion',
        id,
        tx,
      );
      return { deletion: readModel(deletion) };
    });
  }

  async cancel(
    ctx: RequestContext,
    deletionId: string,
    input: { expectedVersion: number; reason: string },
  ) {
    await this.authorizePlatform(ctx, Permissions.DeletionCancel);
    const id = objectId(deletionId, 'WORKSPACE_DELETION_NOT_FOUND');
    const now = this.clock();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const deletion = await this.repository.cancel({
        deletionId: id,
        expectedVersion: input.expectedVersion,
        actor: platformActor(ctx, input.reason),
        reason: input.reason.trim(),
        now,
        tx,
      });
      await this.writeAudit(
        ctx,
        deletion.workspaceId,
        'WorkspaceDeletionCancelled',
        id,
        'cancel',
        tx,
        {
          reason: input.reason.trim(),
        },
      );
      await this.writeOutbox(
        ctx,
        deletion.workspaceId,
        'WorkspaceDeletionCancelled',
        'workspace_deletion',
        id,
        tx,
      );
      return { deletion: readModel(deletion) };
    });
  }

  async sendWarnings(): Promise<number> {
    const now = this.clock();
    const expired = await this.repository.findExpiredSubscriptions(this.batchSize());
    let count = 0;
    for (const subscription of expired) {
      if (!subscription.expiredAt) continue;
      const eligibilityAt = addDays(subscription.expiredAt, this.eligibilityDays());
      for (const offset of this.warningOffsets()) {
        const warningDueAt = addDays(eligibilityAt, -offset);
        if (warningDueAt > now) continue;
        await this.unitOfWork.withTransaction(async (tx) => {
          const fresh = await this.subscriptions.findByWorkspaceId(subscription.workspaceId, tx);
          if (!fresh?.expiredAt || fresh.lifecycleStatus !== 'EXPIRED') return;
          const freshEligibilityAt = addDays(fresh.expiredAt, this.eligibilityDays());
          if (freshEligibilityAt.getTime() !== eligibilityAt.getTime()) return;
          const created = await this.repository.createWarning(
            {
              _id: new ObjectId(),
              workspaceId: subscription.workspaceId,
              subscriptionId: subscription._id,
              expiredAt: fresh.expiredAt,
              eligibilityAt,
              warningOffsetDays: offset,
              status: 'EMITTED',
              outboxEventType: 'RetentionWarningDue',
              createdAt: now,
              updatedAt: now,
            },
            tx,
          );
          if (!created) return;
          await this.writeAudit(
            systemContext(),
            subscription.workspaceId,
            'RetentionWarningEmitted',
            subscription._id,
            'system',
            tx,
            { warningOffsetDays: offset },
          );
          await this.writeOutbox(
            systemContext(),
            subscription.workspaceId,
            'RetentionWarningDue',
            'subscription',
            subscription._id,
            tx,
            { warningOffsetDays: offset, eligibilityAt: eligibilityAt.toISOString() },
          );
          count += 1;
        });
      }
    }
    return count;
  }

  async createDeletionRequests(): Promise<number> {
    const now = this.clock();
    const expired = await this.repository.findExpiredSubscriptions(this.batchSize());
    let count = 0;
    for (const subscription of expired) {
      if (!isDeletionEligible(subscription, now, this.eligibilityDays())) continue;
      const workspace = await this.workspaces.findById(subscription.workspaceId);
      if (workspace?.status !== 'ACTIVE') continue;
      if (await this.repository.hasActiveDeletion(subscription.workspaceId)) continue;
      await this.unitOfWork.withTransaction(async (tx) => {
        const fresh = await this.subscriptions.findByWorkspaceId(subscription.workspaceId, tx);
        const freshWorkspace = await this.workspaces.findById(subscription.workspaceId, tx);
        if (!fresh || !freshWorkspace || freshWorkspace.status !== 'ACTIVE') return;
        if (!isDeletionEligible(fresh, now, this.eligibilityDays())) return;
        if (await this.repository.hasActiveDeletion(subscription.workspaceId, tx)) return;
        const deletion: WorkspaceDeletionRequestDocument = {
          _id: new ObjectId(),
          workspaceId: subscription.workspaceId,
          subscriptionId: subscription._id,
          subscriptionVersionAtEligibility: fresh.version,
          eligibilityBasis: {
            expiredAt: fresh.expiredAt as Date,
            eligibilityAt: addDays(fresh.expiredAt as Date, this.eligibilityDays()),
          },
          status: 'PENDING_APPROVAL',
          createdActor: { type: 'SYSTEM', reason: 'RETENTION_ELIGIBLE' },
          createdAt: now,
          processingAttemptCount: 0,
          checkpoints: initialCheckpoints(),
          retainedPaymentProofFileIds: [],
          workspaceSnapshot: { name: freshWorkspace.name, type: freshWorkspace.type },
          version: 0,
          updatedAt: now,
        };
        await this.repository.createDeletionRequest(deletion, tx);
        await this.writeAudit(
          systemContext(),
          subscription.workspaceId,
          'WorkspaceDeletionRequestCreated',
          deletion._id,
          'system',
          tx,
        );
        await this.writeOutbox(
          systemContext(),
          subscription.workspaceId,
          'WorkspaceDeletionRequested',
          'workspace_deletion',
          deletion._id,
          tx,
        );
        count += 1;
      });
    }
    return count;
  }

  async reviewPostponed(): Promise<number> {
    return await this.repository.returnPostponedForReview(this.clock());
  }

  async processDeletions(workerId: string): Promise<number> {
    const now = this.clock();
    const deletion = await this.repository.claimNextForProcessing(
      workerId,
      new Date(now.getTime() + 10 * 60 * 1000),
      now,
    );
    if (!deletion) return 0;
    try {
      await this.runDeletion(deletion._id, workerId);
      return 1;
    } catch (error) {
      await this.repository.markFailed({
        deletionId: deletion._id,
        code: error instanceof AppError ? error.code : 'WORKSPACE_DELETION_PROCESSING_FAILED',
        message: error instanceof Error ? error.message : 'Workspace deletion failed.',
        now: this.clock(),
      });
      return 0;
    }
  }

  private async runDeletion(deletionId: ObjectId, workerId: string) {
    const deletion = await this.requireDeletionDocument(deletionId);
    const retainFileIds = await this.step(deletion, 'TERMINATE_ACTIVE_EXPORTS', async () => {
      await this.exportsRepo.terminateActiveForWorkspace(deletion.workspaceId, this.clock());
      return deletion.retainedPaymentProofFileIds;
    });
    const proofIds = await this.step(deletion, 'DETERMINE_RETAINED_EVIDENCE', async () => {
      const ids = await this.repository.findPaymentProofFileIds(deletion.workspaceId);
      return ids;
    });
    await this.step(deletion, 'REMOVE_CUSTOMER_ACCESS', async () => proofIds);
    await this.step(deletion, 'STAGE13_MARK_FILES', async () => {
      const now = this.clock();
      await this.unitOfWork.withTransaction(async (tx) => {
        await this.filesRepo.deleteWorkspaceDocuments({
          workspaceId: deletion.workspaceId,
          retainFileIds: proofIds,
          now,
          tx,
        });
        await this.filesRepo.markWorkspaceFilesPurgeEligible({
          workspaceId: deletion.workspaceId,
          retainFileIds: proofIds,
          now,
          tx,
        });
      });
      return proofIds;
    });
    await this.step(deletion, 'DELETE_TENANT_DATA', async () => {
      for (const target of deletionTargets) {
        let cursor: ObjectId | undefined;
        let remaining = true;
        while (remaining) {
          const request = {
            target,
            workspaceId: deletion.workspaceId,
            limit: this.batchSize(),
            ...(cursor ? { afterId: cursor } : {}),
          };
          const result = await this.repository.deleteBatch(request);
          cursor = result.lastId;
          remaining = result.remaining;
        }
      }
      return proofIds;
    });
    await this.step(deletion, 'VERIFY_NO_LIVE_WORKSPACE_DATA', async () => {
      await this.verifyNoLiveWorkspaceData(deletion.workspaceId, proofIds);
      return proofIds;
    });
    await this.step(deletion, 'FINALIZE_TOMBSTONE', async () => {
      const now = this.clock();
      await this.unitOfWork.withTransaction(async (tx) => {
        await this.repository.complete({
          deletionId: deletion._id,
          workspaceId: deletion.workspaceId,
          liveDataDeletedAt: now,
          now,
          tx,
        });
        await this.writeAudit(
          systemContext(),
          deletion.workspaceId,
          'WorkspaceDeletionCompleted',
          deletion._id,
          'system',
          tx,
          { workerId },
        );
        await this.writeOutbox(
          systemContext(),
          deletion.workspaceId,
          'WorkspaceDeletionCompleted',
          'workspace_deletion',
          deletion._id,
          tx,
        );
      });
      return proofIds;
    });
    void retainFileIds;
  }

  private async step<T>(
    deletion: WorkspaceDeletionRequestDocument,
    stepId: DeletionCheckpointStepId,
    work: () => Promise<T>,
  ): Promise<T> {
    const now = this.clock();
    await this.repository.updateCheckpoint({
      deletionId: deletion._id,
      currentStep: stepId,
      now,
      step: {
        stepId,
        state: 'RUNNING',
        affectedCount: checkpointFor(deletion, stepId).affectedCount,
        attemptCount: checkpointFor(deletion, stepId).attemptCount + 1,
        startedAt: now,
      },
    });
    try {
      const result = await work();
      await this.repository.updateCheckpoint({
        deletionId: deletion._id,
        currentStep: stepId,
        now: this.clock(),
        step: {
          stepId,
          state: 'COMPLETED',
          affectedCount: checkpointFor(deletion, stepId).affectedCount,
          attemptCount: checkpointFor(deletion, stepId).attemptCount + 1,
          startedAt: now,
          completedAt: this.clock(),
        },
      });
      return result;
    } catch (error) {
      await this.repository.updateCheckpoint({
        deletionId: deletion._id,
        currentStep: stepId,
        now: this.clock(),
        step: {
          stepId,
          state: 'FAILED',
          affectedCount: checkpointFor(deletion, stepId).affectedCount,
          attemptCount: checkpointFor(deletion, stepId).attemptCount + 1,
          startedAt: now,
          lastError: {
            code: error instanceof AppError ? error.code : 'CHECKPOINT_FAILED',
            message: error instanceof Error ? error.message : 'Checkpoint failed.',
            at: this.clock(),
          },
        },
      });
      throw error;
    }
  }

  private async verifyNoLiveWorkspaceData(workspaceId: ObjectId, retainFileIds: ObjectId[]) {
    for (const target of deletionTargets) {
      const count = await this.repository.countTarget(target, workspaceId);
      if (count > 0) throw conflict('WORKSPACE_DELETION_VERIFICATION_FAILED');
    }
    if ((await this.repository.countActiveGeneratedExports(workspaceId)) > 0) {
      throw conflict('WORKSPACE_DELETION_EXPORTS_REMAIN');
    }
    if ((await this.repository.countDownloadableFiles(workspaceId, retainFileIds)) > 0) {
      throw conflict('WORKSPACE_DELETION_FILES_REMAIN');
    }
  }

  private async requireDeletionDocument(id: ObjectId, tx?: TransactionContext) {
    const deletion = await this.repository.findById(id, tx);
    if (!deletion) throw notFound('WORKSPACE_DELETION_NOT_FOUND');
    return deletion;
  }

  private async authorizePlatform(ctx: RequestContext, permission: string) {
    if (ctx.supportSessionId) throw forbidden('SUPPORT_ACCESS_FORBIDDEN');
    await this.accessControl.authorize(ctx, {
      context: 'PLATFORM',
      permission,
      scope: { type: 'WORKSPACE' },
    });
  }

  private batchSize() {
    return this.config.retention?.batchSize ?? 25;
  }

  private eligibilityDays() {
    return this.config.retention?.deletionEligibilityDays ?? 180;
  }

  private warningOffsets() {
    return this.config.retention?.warningOffsetsDays ?? [30, 7, 1];
  }

  private async writeAudit(
    ctx: RequestContext,
    workspaceId: ObjectId | undefined,
    action: string,
    targetId: ObjectId,
    command: string,
    tx: TransactionContext,
    metadata?: Record<string, unknown>,
  ) {
    await this.audit.write(
      {
        ...(workspaceId ? { workspaceId } : {}),
        actor: auditActor(ctx),
        eventType: action,
        entity: { type: 'stage17', id: targetId },
        action,
        after: { command, ...metadata },
        correlationId: ctx.correlationId,
        ipAddress: ctx.ipAddress,
        ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
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
    payload?: Record<string, unknown>,
  ) {
    await this.outbox.write(
      {
        ...(workspaceId ? { workspaceId } : {}),
        eventType,
        aggregateType,
        aggregateId,
        payload: payload ?? {},
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }
}

function initialCheckpoints(): DeletionCheckpoint[] {
  return deletionStepIds.map((stepId) => ({
    stepId,
    state: 'PENDING',
    affectedCount: 0,
    attemptCount: 0,
  }));
}

function checkpointFor(
  deletion: WorkspaceDeletionRequestDocument,
  stepId: DeletionCheckpointStepId,
): DeletionCheckpoint {
  return (
    deletion.checkpoints.find((item) => item.stepId === stepId) ?? {
      stepId,
      state: 'PENDING',
      affectedCount: 0,
      attemptCount: 0,
    }
  );
}

function platformActor(ctx: RequestContext, reason: string): DeletionActorMetadata {
  return {
    type: 'PLATFORM',
    ...(ctx.userId ? { userId: new ObjectId(ctx.userId) } : {}),
    ...(ctx.platformMembershipId
      ? { platformMembershipId: new ObjectId(ctx.platformMembershipId) }
      : {}),
    reason,
  };
}

function systemContext(): RequestContext {
  return {
    correlationId: 'system',
    ipAddress: 'system',
    locale: 'en',
    timezone: 'UTC',
  };
}

function auditActor(ctx: RequestContext) {
  return {
    ...(ctx.userId ? { userId: new ObjectId(ctx.userId) } : {}),
    ...(ctx.platformMembershipId
      ? { platformMembershipId: new ObjectId(ctx.platformMembershipId) }
      : {}),
    ...(ctx.workspaceMembershipId
      ? { workspaceMembershipId: new ObjectId(ctx.workspaceMembershipId) }
      : {}),
  };
}

function isDeletionEligible(subscription: SubscriptionDocument, now: Date, days: number): boolean {
  return Boolean(
    subscription.lifecycleStatus === 'EXPIRED' &&
      subscription.expiredAt &&
      addDays(subscription.expiredAt, days) <= now &&
      !subscription.deletionLockRequestId,
  );
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * msPerDay);
}

function readModel(deletion: WorkspaceDeletionRequestDocument) {
  return {
    id: deletion._id.toHexString(),
    workspaceId: deletion.workspaceId.toHexString(),
    subscriptionId: deletion.subscriptionId.toHexString(),
    status: deletion.status,
    eligibilityBasis: {
      expiredAt: deletion.eligibilityBasis.expiredAt.toISOString(),
      eligibilityAt: deletion.eligibilityBasis.eligibilityAt.toISOString(),
    },
    reviewAfter: deletion.reviewAfter?.toISOString(),
    approvedAt: deletion.approvedAt?.toISOString(),
    cancelledAt: deletion.cancelledAt?.toISOString(),
    completedAt: deletion.completedAt?.toISOString(),
    liveDataDeletedAt: deletion.liveDataDeletedAt?.toISOString(),
    backupExpiryAt: deletion.backupExpiryAt?.toISOString(),
    currentStep: deletion.currentStep,
    version: deletion.version,
    createdAt: deletion.createdAt.toISOString(),
    updatedAt: deletion.updatedAt.toISOString(),
  };
}

function objectId(value: string, code: string): ObjectId {
  if (!ObjectId.isValid(value)) throw notFound(code);
  return new ObjectId(value);
}

function notFound(code: string): AppError {
  return new AppError({
    code,
    httpStatus: 404,
    message: 'The requested retention resource was not found.',
  });
}

function forbidden(code: string): AppError {
  return new AppError({ code, httpStatus: 403, message: 'This operation is forbidden.' });
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The retention state has changed.' });
}
