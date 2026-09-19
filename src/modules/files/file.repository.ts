import { type Collection, MongoServerError, type ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type {
  BusinessDocument,
  DocumentStatus,
  FileDocument,
  FileStatus,
  GeneratedFileIntentDocument,
  UploadIntentDocument,
} from './file.types';

export class FileRepository {
  private readonly uploadIntents: Collection<UploadIntentDocument>;
  private readonly generatedFileIntents: Collection<GeneratedFileIntentDocument>;
  private readonly files: Collection<FileDocument>;
  private readonly documents: Collection<BusinessDocument>;

  constructor(database: Database) {
    this.uploadIntents = database.db.collection<UploadIntentDocument>('upload_intents');
    this.generatedFileIntents =
      database.db.collection<GeneratedFileIntentDocument>('generated_file_intents');
    this.files = database.db.collection<FileDocument>('files');
    this.documents = database.db.collection<BusinessDocument>('documents');
  }

  async createUploadIntent(
    intent: UploadIntentDocument,
    tx?: TransactionContext,
  ): Promise<UploadIntentDocument> {
    await this.uploadIntents.insertOne(intent, tx ? { session: tx.session } : undefined);
    return intent;
  }

  async findUploadIntent(
    workspaceId: ObjectId,
    intentId: ObjectId,
    tx?: TransactionContext,
  ): Promise<UploadIntentDocument | null> {
    return await this.uploadIntents.findOne(
      { _id: intentId, workspaceId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async confirmUploadIntent(input: {
    workspaceId: ObjectId;
    intentId: ObjectId;
    expectedVersion: number;
    file: FileDocument;
    now: Date;
    tx: TransactionContext;
  }): Promise<{ intent: UploadIntentDocument; file: FileDocument }> {
    try {
      await this.files.insertOne(input.file, { session: input.tx.session });
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw conflict('UPLOAD_ALREADY_CONFIRMED');
      }
      throw error;
    }
    const intent = await this.uploadIntents.findOneAndUpdate(
      {
        _id: input.intentId,
        workspaceId: input.workspaceId,
        status: 'PENDING',
        version: input.expectedVersion,
      },
      {
        $set: { status: 'CONFIRMED', confirmedAt: input.now },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!intent) throw conflict('UPLOAD_INTENT_VERSION_CONFLICT');
    return { intent, file: input.file };
  }

  async expireIntent(
    intentId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ): Promise<UploadIntentDocument | null> {
    return await this.uploadIntents.findOneAndUpdate(
      { _id: intentId, status: 'PENDING', expiresAt: { $lte: now } },
      {
        $set: {
          status: 'EXPIRED',
          expiredAt: now,
          orphanCleanupStatus: 'PENDING',
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: tx.session },
    );
  }

  async listExpiredPending(now: Date, limit: number): Promise<UploadIntentDocument[]> {
    return await this.uploadIntents
      .find({ status: 'PENDING', expiresAt: { $lte: now } })
      .sort({ expiresAt: 1, _id: 1 })
      .limit(limit)
      .toArray();
  }

  async listOrphanCleanupDue(limit: number): Promise<UploadIntentDocument[]> {
    return await this.uploadIntents
      .find({
        status: { $in: ['EXPIRED', 'CANCELLED'] },
        orphanCleanupStatus: { $in: ['PENDING', 'FAILED'] },
      })
      .sort({ expiresAt: 1, _id: 1 })
      .limit(limit)
      .toArray();
  }

  async markOrphanCleaned(intentId: ObjectId): Promise<void> {
    await this.uploadIntents.updateOne(
      { _id: intentId, orphanCleanupStatus: { $in: ['PENDING', 'FAILED'] } },
      { $set: { orphanCleanupStatus: 'DONE' }, $unset: { lastCleanupError: '' } },
    );
  }

  async markOrphanCleanupFailed(intentId: ObjectId, error: string): Promise<void> {
    await this.uploadIntents.updateOne(
      { _id: intentId, orphanCleanupStatus: { $in: ['PENDING', 'FAILED'] } },
      {
        $set: { orphanCleanupStatus: 'FAILED', lastCleanupError: error },
        $inc: { orphanCleanupAttempts: 1 },
      },
    );
  }

  async findFile(
    workspaceId: ObjectId,
    fileId: ObjectId,
    tx?: TransactionContext,
  ): Promise<FileDocument | null> {
    return await this.files.findOne(
      { _id: fileId, workspaceId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async createGeneratedFileIntent(
    intent: GeneratedFileIntentDocument,
    tx?: TransactionContext,
  ): Promise<GeneratedFileIntentDocument> {
    await this.generatedFileIntents.insertOne(intent, tx ? { session: tx.session } : undefined);
    return intent;
  }

  async markGeneratedObjectWritten(input: {
    intentId: ObjectId;
    sizeBytes: number;
    checksumSha256: string;
    now: Date;
  }): Promise<void> {
    await this.generatedFileIntents.updateOne(
      { _id: input.intentId, status: 'PENDING' },
      {
        $set: {
          status: 'OBJECT_WRITTEN',
          sizeBytes: input.sizeBytes,
          checksumSha256: input.checksumSha256,
          objectWrittenAt: input.now,
          updatedAt: input.now,
        },
      },
    );
  }

  async createGeneratedFile(input: {
    intentId: ObjectId;
    file: FileDocument;
    now: Date;
    tx: TransactionContext;
  }): Promise<FileDocument> {
    try {
      await this.files.insertOne(input.file, { session: input.tx.session });
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw conflict('GENERATED_FILE_ALREADY_EXISTS');
      }
      throw error;
    }
    await this.generatedFileIntents.updateOne(
      { _id: input.intentId },
      {
        $set: {
          status: 'FILE_CREATED',
          fileId: input.file._id,
          fileCreatedAt: input.now,
          updatedAt: input.now,
        },
      },
      { session: input.tx.session },
    );
    return input.file;
  }

  async listGeneratedIntentCleanupDue(limit: number): Promise<GeneratedFileIntentDocument[]> {
    return await this.generatedFileIntents
      .find({
        status: { $in: ['OBJECT_WRITTEN', 'FAILED'] },
        fileId: { $exists: false },
      })
      .sort({ updatedAt: 1, _id: 1 })
      .limit(limit)
      .toArray();
  }

  async markGeneratedIntentCleaned(intentId: ObjectId, now: Date): Promise<void> {
    await this.generatedFileIntents.updateOne(
      { _id: intentId, status: { $in: ['OBJECT_WRITTEN', 'FAILED'] }, fileId: { $exists: false } },
      {
        $set: { status: 'CLEANED', cleanedAt: now, updatedAt: now },
        $unset: { lastCleanupError: '' },
      },
    );
  }

  async markGeneratedIntentCleanupFailed(
    intentId: ObjectId,
    error: string,
    now: Date,
  ): Promise<void> {
    await this.generatedFileIntents.updateOne(
      { _id: intentId, status: { $in: ['OBJECT_WRITTEN', 'FAILED'] }, fileId: { $exists: false } },
      {
        $set: { status: 'FAILED', lastCleanupError: error, failedAt: now, updatedAt: now },
        $inc: { cleanupAttempts: 1 },
      },
    );
  }

  async findGeneratedFileForExport(
    workspaceId: ObjectId,
    exportId: ObjectId,
    tx?: TransactionContext,
  ): Promise<FileDocument | null> {
    return await this.files.findOne(
      {
        workspaceId,
        origin: 'SYSTEM_GENERATED',
        generatedPurpose: 'WORKSPACE_EXPORT',
        generatedForExportId: exportId,
        status: 'ACTIVE',
      },
      tx ? { session: tx.session } : undefined,
    );
  }

  async markGeneratedExportFilePurgeEligible(input: {
    workspaceId: ObjectId;
    exportId: ObjectId;
    now: Date;
    tx?: TransactionContext;
  }): Promise<void> {
    await this.files.updateMany(
      {
        workspaceId: input.workspaceId,
        origin: 'SYSTEM_GENERATED',
        generatedPurpose: 'WORKSPACE_EXPORT',
        generatedForExportId: input.exportId,
        status: 'ACTIVE',
      },
      {
        $set: {
          status: 'PURGE_PENDING',
          deletedAt: input.now,
          purgeEligibleAt: input.now,
          purgePendingAt: input.now,
        },
        $inc: { version: 1 },
      },
      input.tx ? { session: input.tx.session } : undefined,
    );
  }

  async markWorkspaceGeneratedExportFilesPurgeEligible(input: {
    workspaceId: ObjectId;
    now: Date;
    tx?: TransactionContext;
  }): Promise<number> {
    const result = await this.files.updateMany(
      {
        workspaceId: input.workspaceId,
        origin: 'SYSTEM_GENERATED',
        generatedPurpose: 'WORKSPACE_EXPORT',
        status: 'ACTIVE',
      },
      {
        $set: {
          status: 'PURGE_PENDING',
          deletedAt: input.now,
          purgeEligibleAt: input.now,
          purgePendingAt: input.now,
        },
        $inc: { version: 1 },
      },
      input.tx ? { session: input.tx.session } : undefined,
    );
    return result.modifiedCount;
  }

  async markWorkspaceFilesPurgeEligible(input: {
    workspaceId: ObjectId;
    retainFileIds: ObjectId[];
    now: Date;
    tx: TransactionContext;
  }): Promise<number> {
    const result = await this.files.updateMany(
      {
        workspaceId: input.workspaceId,
        status: 'ACTIVE',
        ...(input.retainFileIds.length > 0 ? { _id: { $nin: input.retainFileIds } } : {}),
      },
      {
        $set: {
          status: 'PURGE_PENDING',
          deletedAt: input.now,
          purgeEligibleAt: input.now,
          purgePendingAt: input.now,
        },
        $inc: { version: 1 },
      },
      { session: input.tx.session },
    );
    return result.modifiedCount;
  }

  async deleteWorkspaceDocuments(input: {
    workspaceId: ObjectId;
    retainFileIds: ObjectId[];
    now: Date;
    tx: TransactionContext;
  }): Promise<number> {
    const result = await this.documents.updateMany(
      {
        workspaceId: input.workspaceId,
        status: 'ACTIVE',
        ...(input.retainFileIds.length > 0 ? { fileId: { $nin: input.retainFileIds } } : {}),
      },
      { $set: { status: 'DELETED', deletedAt: input.now } },
      { session: input.tx.session },
    );
    return result.modifiedCount;
  }

  async findDocumentForFile(
    workspaceId: ObjectId,
    fileId: ObjectId,
    tx?: TransactionContext,
  ): Promise<BusinessDocument | null> {
    return await this.documents.findOne(
      { workspaceId, fileId, status: 'ACTIVE' },
      tx ? { session: tx.session } : undefined,
    );
  }

  async softDeleteFile(input: {
    workspaceId: ObjectId;
    fileId: ObjectId;
    expectedVersion: number;
    actorId: ObjectId;
    purgeEligibleAt: Date;
    now: Date;
    tx: TransactionContext;
  }): Promise<FileDocument> {
    const file = await this.files.findOneAndUpdate(
      {
        _id: input.fileId,
        workspaceId: input.workspaceId,
        status: 'ACTIVE',
        version: input.expectedVersion,
      },
      {
        $set: {
          status: 'SOFT_DELETED',
          deletedAt: input.now,
          deletedBy: input.actorId,
          purgeEligibleAt: input.purgeEligibleAt,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!file) throw conflict('FILE_VERSION_CONFLICT');
    return file;
  }

  async restoreFile(input: {
    workspaceId: ObjectId;
    fileId: ObjectId;
    expectedVersion: number;
    actorId: ObjectId;
    now: Date;
    tx: TransactionContext;
  }): Promise<FileDocument> {
    const file = await this.files.findOneAndUpdate(
      {
        _id: input.fileId,
        workspaceId: input.workspaceId,
        status: 'SOFT_DELETED',
        version: input.expectedVersion,
        purgeEligibleAt: { $gt: input.now },
      },
      {
        $set: { status: 'ACTIVE', restoredAt: input.now, restoredBy: input.actorId },
        $unset: { deletedAt: '', deletedBy: '', purgeEligibleAt: '' },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!file) throw conflict('FILE_RESTORE_INVALID');
    return file;
  }

  async listPurgeDue(now: Date, limit: number): Promise<FileDocument[]> {
    return await this.files
      .find({
        status: { $in: ['SOFT_DELETED', 'PURGE_PENDING'] },
        purgeEligibleAt: { $lte: now },
      })
      .sort({ purgeEligibleAt: 1, _id: 1 })
      .limit(limit)
      .toArray();
  }

  async markPurgePending(fileId: ObjectId, now: Date): Promise<FileDocument | null> {
    return await this.files.findOneAndUpdate(
      {
        _id: fileId,
        status: { $in: ['SOFT_DELETED', 'PURGE_PENDING'] },
        purgeEligibleAt: { $lte: now },
      },
      { $set: { status: 'PURGE_PENDING', purgePendingAt: now } },
      { returnDocument: 'after' },
    );
  }

  async markPurged(
    fileId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ): Promise<FileDocument | null> {
    return await this.files.findOneAndUpdate(
      { _id: fileId, status: 'PURGE_PENDING' },
      {
        $set: { status: 'PURGED', physicallyDeletedAt: now },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: tx.session },
    );
  }

  async listDocuments(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    after?: { createdAt: Date; id: ObjectId };
    limit: number;
  }): Promise<BusinessDocument[]> {
    return await this.documents
      .find({
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        status: 'ACTIVE',
        ...(input.after
          ? {
              $or: [
                { createdAt: { $lt: input.after.createdAt } },
                { createdAt: input.after.createdAt, _id: { $lt: input.after.id } },
              ],
            }
          : {}),
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(input.limit)
      .toArray();
  }

  async findDocument(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    documentId: ObjectId,
    tx?: TransactionContext,
  ): Promise<BusinessDocument | null> {
    return await this.documents.findOne(
      { _id: documentId, workspaceId, relationshipId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async createDocument(
    document: BusinessDocument,
    tx: TransactionContext,
  ): Promise<BusinessDocument> {
    try {
      await this.documents.insertOne(document, { session: tx.session });
      return document;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw conflict('DOCUMENT_FILE_ALREADY_USED');
      }
      throw error;
    }
  }

  async deleteDocument(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    documentId: ObjectId;
    expectedVersion: number;
    actorId: ObjectId;
    now: Date;
    tx: TransactionContext;
  }): Promise<BusinessDocument> {
    const document = await this.documents.findOneAndUpdate(
      {
        _id: input.documentId,
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        status: 'ACTIVE',
        version: input.expectedVersion,
      },
      {
        $set: { status: 'DELETED', deletedAt: input.now, deletedBy: input.actorId },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!document) throw conflict('DOCUMENT_VERSION_CONFLICT');
    return document;
  }

  async countFilesByStatus(workspaceId: ObjectId, status: FileStatus): Promise<number> {
    return await this.files.countDocuments({ workspaceId, status });
  }

  async countDocumentsByStatus(workspaceId: ObjectId, status: DocumentStatus): Promise<number> {
    return await this.documents.countDocuments({ workspaceId, status });
  }
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The file or document changed.' });
}
