import { randomUUID } from 'node:crypto';
import { type Collection, MongoServerError, type ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { WorkspaceExportRequestDocument } from './export.types';

const activeStatuses = ['PENDING', 'PROCESSING', 'READY'] as const;

export class WorkspaceExportRepository {
  private readonly exports: Collection<WorkspaceExportRequestDocument>;

  constructor(database: Database) {
    this.exports = database.db.collection<WorkspaceExportRequestDocument>(
      'workspace_export_requests',
    );
  }

  async create(document: WorkspaceExportRequestDocument, tx: TransactionContext) {
    try {
      await this.exports.insertOne(document, { session: tx.session });
      return document;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw conflict('ACTIVE_EXPORT_EXISTS');
      }
      throw error;
    }
  }

  async findById(workspaceId: ObjectId, exportId: ObjectId, tx?: TransactionContext) {
    return await this.exports.findOne(
      { _id: exportId, workspaceId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async list(input: {
    workspaceId: ObjectId;
    limit: number;
    after?: { requestedAt: Date; id: ObjectId };
  }) {
    return await this.exports
      .find({
        workspaceId: input.workspaceId,
        ...(input.after
          ? {
              $or: [
                { requestedAt: { $lt: input.after.requestedAt } },
                { requestedAt: input.after.requestedAt, _id: { $lt: input.after.id } },
              ],
            }
          : {}),
      })
      .sort({ requestedAt: -1, _id: -1 })
      .limit(input.limit)
      .toArray();
  }

  async claimNext(input: {
    now: Date;
    workerId: string;
    leaseMs: number;
    limitWorkspaceIds?: ObjectId[];
  }) {
    const claimId = randomUUID();
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
    const result = await this.exports.findOneAndUpdate(
      {
        ...(input.limitWorkspaceIds?.length
          ? { workspaceId: { $in: input.limitWorkspaceIds } }
          : {}),
        $or: [
          { status: 'PENDING' },
          { status: 'PROCESSING', processingLeaseExpiresAt: { $lte: input.now } },
        ],
      },
      {
        $set: {
          status: 'PROCESSING',
          processingClaimId: claimId,
          processingClaimedByWorkerId: input.workerId,
          processingLeaseExpiresAt: leaseExpiresAt,
          processingStartedAt: input.now,
          lastAttemptAt: input.now,
          updatedAt: input.now,
        },
        $inc: { attemptCount: 1, version: 1 },
      },
      { sort: { requestedAt: 1, _id: 1 }, returnDocument: 'after' },
    );
    return result ? { exportRequest: result, claimId } : null;
  }

  async markReady(
    input: {
      exportId: ObjectId;
      workspaceId: ObjectId;
      claimId: string;
      now: Date;
      expiresAt: Date;
      artifactFileId: ObjectId;
      artifactSizeBytes: number;
      artifactSha256: string;
    },
    tx: TransactionContext,
  ) {
    const result = await this.exports.findOneAndUpdate(
      {
        _id: input.exportId,
        workspaceId: input.workspaceId,
        status: 'PROCESSING',
        processingClaimId: input.claimId,
        processingLeaseExpiresAt: { $gt: input.now },
      },
      {
        $set: {
          status: 'READY',
          completedAt: input.now,
          expiresAt: input.expiresAt,
          artifactFileId: input.artifactFileId,
          artifactSizeBytes: input.artifactSizeBytes,
          artifactSha256: input.artifactSha256,
          updatedAt: input.now,
        },
        $unset: {
          processingClaimId: '',
          processingClaimedByWorkerId: '',
          processingLeaseExpiresAt: '',
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: tx.session },
    );
    if (!result) throw conflict('EXPORT_CLAIM_STALE');
    return result;
  }

  async markFailed(
    input: {
      exportId: ObjectId;
      workspaceId: ObjectId;
      claimId: string;
      now: Date;
      code: string;
      message?: string;
    },
    tx?: TransactionContext,
  ) {
    const result = await this.exports.findOneAndUpdate(
      {
        _id: input.exportId,
        workspaceId: input.workspaceId,
        status: 'PROCESSING',
        processingClaimId: input.claimId,
      },
      {
        $set: {
          status: 'FAILED',
          failedAt: input.now,
          failure: {
            code: input.code,
            ...(input.message ? { message: input.message } : {}),
            retryable: false,
          },
          updatedAt: input.now,
        },
        $unset: {
          processingClaimId: '',
          processingClaimedByWorkerId: '',
          processingLeaseExpiresAt: '',
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    return result;
  }

  async expireDue(now: Date, limit: number) {
    return await this.exports
      .find({ status: 'READY', expiresAt: { $lte: now } })
      .sort({ expiresAt: 1, _id: 1 })
      .limit(limit)
      .toArray();
  }

  async expire(exportId: ObjectId, now: Date, reason: string | undefined, tx: TransactionContext) {
    return await this.exports.findOneAndUpdate(
      { _id: exportId, status: 'READY' },
      {
        $set: {
          status: 'EXPIRED',
          expiredAt: now,
          expiresAt: now,
          ...(reason ? { expirationReason: reason } : {}),
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: tx.session },
    );
  }

  async terminateActiveForWorkspace(workspaceId: ObjectId, now: Date, tx?: TransactionContext) {
    await this.exports.updateMany(
      { workspaceId, status: { $in: ['PENDING', 'PROCESSING'] } },
      {
        $set: {
          status: 'FAILED',
          failedAt: now,
          failure: { code: 'WORKSPACE_DELETION_APPROVED', retryable: false },
          updatedAt: now,
        },
        $unset: {
          processingClaimId: '',
          processingClaimedByWorkerId: '',
          processingLeaseExpiresAt: '',
        },
        $inc: { version: 1 },
      },
      tx ? { session: tx.session } : undefined,
    );
    await this.exports.updateMany(
      { workspaceId, status: 'READY' },
      {
        $set: {
          status: 'EXPIRED',
          expiredAt: now,
          expiresAt: now,
          expirationReason: 'WORKSPACE_DELETION_APPROVED',
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      tx ? { session: tx.session } : undefined,
    );
  }

  async countActiveDownloadable(workspaceId: ObjectId) {
    return await this.exports.countDocuments({ workspaceId, status: { $in: activeStatuses } });
  }
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The export state changed.' });
}
