import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { AccessControlService } from '../../core/access-control/access-control.service';
import type { AuthorizationDecision } from '../../core/access-control/access-control.types';
import type { AuditWriter } from '../../core/audit/audit.writer';
import type { TransactionContext, UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { OutboxWriter } from '../../core/events/outbox.writer';
import type { RequestContext } from '../../core/request-context/request-context';
import type { StorageProvider } from '../../core/storage/storage.provider';
import { Permissions } from '../permissions/permission.registry';
import type { WorkspaceUsageRepository } from '../subscriptions/subscription.repository';
import type { EntitlementService } from '../subscriptions/subscription.service';
import type { SupportAccessApplicationService } from '../support-access/support-access.service';
import type { CoachingRelationshipRepository } from '../trainees/trainee.repository';
import type { CoachingRelationshipDocument } from '../trainees/trainee.types';
import type { WorkspaceMembershipRepository } from '../workspaces/workspace.repository';
import type { WorkspaceMembershipDocument } from '../workspaces/workspace.types';
import type { FileRepository } from './file.repository';
import type {
  BusinessDocument,
  DocumentCategory,
  FileClassification,
  FileDocument,
  SubjectType,
  UploadIntentDocument,
  UploadPurpose,
} from './file.types';

export interface CreateUploadIntentInput {
  purpose: UploadPurpose;
  subjectType: SubjectType;
  subjectId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256?: string;
  classification?: FileClassification;
  sensitive?: boolean;
}

export interface ConfirmUploadInput {
  expectedVersion: number;
}

export interface CreateDocumentInput {
  fileId: string;
  category: DocumentCategory;
  title?: string;
  description?: string;
  classification?: FileClassification;
  documentDate?: string;
}

export interface ExpectedVersionInput {
  expectedVersion: number;
}

const uploadIntentTtlMs = 15 * 60 * 1000;
const uploadUrlTtlMs = 10 * 60 * 1000;
const standardDownloadTtlMs = 5 * 60 * 1000;
const sensitiveDownloadTtlMs = 2 * 60 * 1000;
const restoreWindowMs = 30 * 24 * 60 * 60 * 1000;
const maxUploadBytes = 200 * 1024 * 1024;
const allowedMimeTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const mandatorySensitiveCategories = new Set<DocumentCategory>([
  'INBODY',
  'BLOOD_TEST',
  'MEDICAL_REPORT',
  'INJURY_REPORT',
]);

export class FileApplicationService {
  private supportAccess?: SupportAccessApplicationService;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly files: FileRepository,
    private readonly relationships: CoachingRelationshipRepository,
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly accessControl: AccessControlService,
    private readonly entitlements: EntitlementService,
    private readonly usage: WorkspaceUsageRepository,
    private readonly storage: StorageProvider,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  setSupportAccessPort(supportAccess: SupportAccessApplicationService): void {
    this.supportAccess = supportAccess;
  }

  async createUploadIntent(
    ctx: RequestContext,
    workspaceId: string,
    input: CreateUploadIntentInput,
    tx: TransactionContext,
  ) {
    const ids = await this.authorizeUpload(ctx, workspaceId, input, tx);
    await this.entitlements.assertAndReserveStorage(ids.workspaceId, input.sizeBytes, tx);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + uploadIntentTtlMs);
    const subjectId = 'subjectId' in ids ? ids.subjectId : undefined;
    const classification = input.sensitive ? 'SENSITIVE' : (input.classification ?? 'STANDARD');
    validateUploadInput(input);
    const intent: UploadIntentDocument = {
      _id: new ObjectId(),
      workspaceId: ids.workspaceId,
      uploaderUserId: actorId(ctx),
      uploaderMembershipId: ids.membership._id,
      purpose: input.purpose,
      subjectType: input.subjectType,
      ...(subjectId ? { subjectId } : {}),
      storageProvider: this.storage.provider,
      storageKey: storageKey(ids.workspaceId, now),
      originalName: input.fileName.trim(),
      mimeType: input.mimeType.trim().toLowerCase(),
      reservedBytes: input.sizeBytes,
      ...(input.checksumSha256
        ? { expectedChecksumSha256: normalizeChecksum(input.checksumSha256) }
        : {}),
      classification,
      status: 'PENDING',
      version: 0,
      expiresAt,
      createdAt: now,
    };
    await this.files.createUploadIntent(intent, tx);
    await this.audit.write(
      auditEvent(ctx, ids.workspaceId, 'UploadIntentCreated', intent._id, 'create', {
        purpose: intent.purpose,
        subjectType: intent.subjectType,
        reservedBytes: intent.reservedBytes,
        classification: intent.classification,
      }),
      tx,
    );
    const uploadExpiresAt = minDate(new Date(now.getTime() + uploadUrlTtlMs), expiresAt);
    const presigned = await this.storage.createUploadUrl({
      key: intent.storageKey,
      contentType: intent.mimeType,
      sizeBytes: intent.reservedBytes,
      ...(intent.expectedChecksumSha256 ? { checksumSha256: intent.expectedChecksumSha256 } : {}),
      expiresAt: uploadExpiresAt,
    });
    return {
      uploadIntentId: intent._id.toHexString(),
      uploadUrl: presigned.url,
      expiresAt: intent.expiresAt.toISOString(),
      uploadUrlExpiresAt: presigned.expiresAt.toISOString(),
      reservedBytes: intent.reservedBytes,
      expectedVersion: intent.version,
    };
  }

  async confirmUpload(
    ctx: RequestContext,
    workspaceId: string,
    uploadIntentId: string,
    input: ConfirmUploadInput,
    tx: TransactionContext,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const intentId = objectId(uploadIntentId, 'UPLOAD_INTENT_NOT_FOUND');
    const intent = await this.files.findUploadIntent(id, intentId);
    if (!intent) throw notFound('UPLOAD_INTENT_NOT_FOUND');
    await this.authorizeIntent(ctx, intent);
    if (intent.status !== 'PENDING') throw conflict('UPLOAD_INTENT_NOT_PENDING');
    if (intent.version !== input.expectedVersion) throw conflict('UPLOAD_INTENT_VERSION_CONFLICT');
    if (intent.expiresAt.getTime() <= Date.now()) throw conflict('UPLOAD_INTENT_EXPIRED');
    const stat = await this.storage.statObject(intent.storageKey);
    if (!stat) throw conflict('UPLOAD_OBJECT_NOT_FOUND');
    if (stat.key !== intent.storageKey) throw conflict('UPLOAD_OBJECT_MISMATCH');
    if (stat.sizeBytes > intent.reservedBytes) throw conflict('UPLOAD_OBJECT_MISMATCH');
    if (stat.sizeBytes < 0) throw conflict('UPLOAD_OBJECT_MISMATCH');
    if (stat.contentType && stat.contentType.toLowerCase() !== intent.mimeType) {
      throw conflict('UPLOAD_OBJECT_MISMATCH');
    }
    if (intent.expectedChecksumSha256 && !stat.checksumSha256) {
      throw conflict('UPLOAD_CHECKSUM_NOT_VERIFIABLE');
    }
    if (
      intent.expectedChecksumSha256 &&
      stat.checksumSha256 &&
      stat.checksumSha256.toLowerCase() !== intent.expectedChecksumSha256
    ) {
      throw conflict('UPLOAD_OBJECT_MISMATCH');
    }
    const now = new Date();
    const file: FileDocument = {
      _id: new ObjectId(),
      workspaceId: intent.workspaceId,
      origin: 'USER_UPLOAD',
      uploadIntentId: intent._id,
      uploaderUserId: intent.uploaderUserId,
      ...(intent.uploaderMembershipId ? { uploaderMembershipId: intent.uploaderMembershipId } : {}),
      subjectType: intent.subjectType,
      ...(intent.subjectId ? { subjectId: intent.subjectId } : {}),
      storageProvider: intent.storageProvider,
      storageKey: intent.storageKey,
      originalName: intent.originalName,
      mimeType: intent.mimeType,
      sizeBytes: stat.sizeBytes,
      ...(intent.expectedChecksumSha256
        ? { verifiedChecksumSha256: intent.expectedChecksumSha256 }
        : {}),
      classification: intent.classification,
      status: 'ACTIVE',
      version: 0,
      createdAt: now,
      confirmedAt: now,
    };
    const result = await this.files.confirmUploadIntent({
      workspaceId: id,
      intentId: intent._id,
      expectedVersion: input.expectedVersion,
      file,
      now,
      tx,
    });
    await this.usage.commitReservedStorage(id, intent.reservedBytes, file.sizeBytes, tx);
    await this.audit.write(
      auditEvent(ctx, id, 'FileConfirmed', file._id, 'confirm', {
        uploadIntentId: intent._id.toHexString(),
        sizeBytes: file.sizeBytes,
        classification: file.classification,
      }),
      tx,
    );
    return { file: safeFile(result.file) };
  }

  async createDownloadUrl(ctx: RequestContext, workspaceId: string, fileId: string) {
    const { file, effectiveClassification } = await this.loadAuthorizedDownloadFile(
      ctx,
      workspaceId,
      fileId,
    );
    await this.entitlements.assert(file.workspaceId, 'READ', 'documents');
    const ttl =
      effectiveClassification === 'SENSITIVE' ? sensitiveDownloadTtlMs : standardDownloadTtlMs;
    if (ctx.supportSessionId && effectiveClassification === 'SENSITIVE') {
      if (!this.supportAccess) throw forbidden();
      await this.supportAccess.requireSensitive(ctx, 'FILE');
    }
    const expiresAt = new Date(Date.now() + ttl);
    const signed = await this.storage.createDownloadUrl({
      key: file.storageKey,
      fileName: file.originalName,
      contentType: file.mimeType,
      expiresAt,
    });
    if (effectiveClassification === 'SENSITIVE') {
      await this.audit.write(
        auditEvent(ctx, file.workspaceId, 'SensitiveFileDownloadUrlIssued', file._id, 'read', {
          fileId: file._id.toHexString(),
        }),
      );
    }
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }

  async deleteFile(
    ctx: RequestContext,
    workspaceId: string,
    fileId: string,
    input: ExpectedVersionInput,
    tx: TransactionContext,
  ) {
    const file = await this.loadAuthorizedFile(ctx, workspaceId, fileId, {
      permission: Permissions.FilesDelete,
      requireActive: true,
    });
    await this.entitlements.assert(file.workspaceId, 'WRITE', 'documents');
    const deleted = await this.files.softDeleteFile({
      workspaceId: file.workspaceId,
      fileId: file._id,
      expectedVersion: input.expectedVersion,
      actorId: actorId(ctx),
      now: new Date(),
      purgeEligibleAt: new Date(this.clock().getTime() + restoreWindowMs),
      tx,
    });
    await this.audit.write(
      auditEvent(ctx, file.workspaceId, 'FileSoftDeleted', file._id, 'delete', {
        purgeEligibleAt: deleted.purgeEligibleAt?.toISOString(),
      }),
      tx,
    );
    return { file: safeFile(deleted) };
  }

  async restoreFile(
    ctx: RequestContext,
    workspaceId: string,
    fileId: string,
    input: ExpectedVersionInput,
    tx: TransactionContext,
  ) {
    const file = await this.loadAuthorizedFile(ctx, workspaceId, fileId, {
      permission: Permissions.FilesRestore,
      requireActive: false,
    });
    await this.entitlements.assert(file.workspaceId, 'WRITE', 'documents');
    const restored = await this.files.restoreFile({
      workspaceId: file.workspaceId,
      fileId: file._id,
      expectedVersion: input.expectedVersion,
      actorId: actorId(ctx),
      now: this.clock(),
      tx,
    });
    await this.audit.write(
      auditEvent(ctx, file.workspaceId, 'FileRestored', file._id, 'restore'),
      tx,
    );
    return { file: safeFile(restored) };
  }

  async listDocuments(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    query: { cursor?: string; limit?: number },
  ) {
    const ids = await this.authorizeRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.DocumentsRead,
      false,
    );
    await this.entitlements.assert(ids.workspaceId, 'READ', 'documents');
    const documents = await this.files.listDocuments({
      workspaceId: ids.workspaceId,
      relationshipId: ids.relationship._id,
      ...(query.cursor ? { after: decodeCursor(query.cursor) } : {}),
      limit: query.limit ?? 50,
    });
    const visible = [];
    for (const document of documents) {
      if (document.classification === 'SENSITIVE') {
        await this.requireSensitive(ctx, ids.workspaceId, 'read');
      }
      visible.push(safeDocument(document));
    }
    return page(visible, documents);
  }

  async createDocument(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: CreateDocumentInput,
    tx: TransactionContext,
  ) {
    const ids = await this.authorizeRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.DocumentsUpload,
      true,
      tx,
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'documents');
    const file = await this.files.findFile(
      ids.workspaceId,
      objectId(input.fileId, 'FILE_NOT_FOUND'),
      tx,
    );
    if (file?.status !== 'ACTIVE') throw notFound('FILE_NOT_FOUND');
    if (file.origin === 'SYSTEM_GENERATED') throw notFound('FILE_NOT_FOUND');
    if (!file.subjectId?.equals(ids.relationship._id)) throw forbidden();
    const classification = classificationForDocument(
      input.category,
      input.classification ?? file.classification,
    );
    if (classification === 'SENSITIVE') await this.requireSensitive(ctx, ids.workspaceId, 'upload');
    if (file.classification === 'STANDARD' && classification === 'SENSITIVE') {
      file.classification = 'SENSITIVE';
    }
    const now = new Date();
    const document: BusinessDocument = {
      _id: new ObjectId(),
      workspaceId: ids.workspaceId,
      relationshipId: ids.relationship._id,
      fileId: file._id,
      category: input.category,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      uploadedByUserId: actorId(ctx),
      uploadedByMembershipId: ids.membership._id,
      classification,
      ...(input.documentDate
        ? { documentDate: date(input.documentDate, 'DOCUMENT_DATE_INVALID') }
        : {}),
      status: 'ACTIVE',
      version: 0,
      createdAt: now,
    };
    const created = await this.files.createDocument(document, tx);
    await this.audit.write(
      auditEvent(ctx, ids.workspaceId, 'DocumentCreated', created._id, 'create', {
        category: created.category,
        fileId: created.fileId.toHexString(),
        classification: created.classification,
      }),
      tx,
    );
    await this.outbox.write(
      {
        eventType: 'DocumentUploaded',
        aggregateType: 'document',
        aggregateId: created._id,
        workspaceId: ids.workspaceId,
        payload: {
          documentId: created._id.toHexString(),
          relationshipId: created.relationshipId.toHexString(),
          category: created.category,
          classification: created.classification,
        },
        correlationId: ctx.correlationId,
      },
      tx,
    );
    return { document: safeDocument(created) };
  }

  async getDocument(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    documentId: string,
  ) {
    const ids = await this.authorizeRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.DocumentsRead,
      false,
    );
    await this.entitlements.assert(ids.workspaceId, 'READ', 'documents');
    const document = await this.files.findDocument(
      ids.workspaceId,
      ids.relationship._id,
      objectId(documentId, 'DOCUMENT_NOT_FOUND'),
    );
    if (document?.status !== 'ACTIVE') throw notFound('DOCUMENT_NOT_FOUND');
    if (document.classification === 'SENSITIVE')
      await this.requireSensitive(ctx, ids.workspaceId, 'read');
    return { document: safeDocument(document) };
  }

  async deleteDocument(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    documentId: string,
    input: ExpectedVersionInput,
    tx: TransactionContext,
  ) {
    const ids = await this.authorizeRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.DocumentsDelete,
      true,
      tx,
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'documents');
    const existing = await this.files.findDocument(
      ids.workspaceId,
      ids.relationship._id,
      objectId(documentId, 'DOCUMENT_NOT_FOUND'),
      tx,
    );
    if (existing?.status !== 'ACTIVE') throw notFound('DOCUMENT_NOT_FOUND');
    if (existing.classification === 'SENSITIVE')
      await this.requireSensitive(ctx, ids.workspaceId, 'upload');
    const deleted = await this.files.deleteDocument({
      workspaceId: ids.workspaceId,
      relationshipId: ids.relationship._id,
      documentId: existing._id,
      expectedVersion: input.expectedVersion,
      actorId: actorId(ctx),
      now: new Date(),
      tx,
    });
    const file = await this.files.findFile(ids.workspaceId, deleted.fileId, tx);
    if (file?.status === 'ACTIVE') {
      await this.files.softDeleteFile({
        workspaceId: ids.workspaceId,
        fileId: file._id,
        expectedVersion: file.version,
        actorId: actorId(ctx),
        now: new Date(),
        purgeEligibleAt: new Date(this.clock().getTime() + restoreWindowMs),
        tx,
      });
    }
    await this.audit.write(
      auditEvent(ctx, ids.workspaceId, 'DocumentDeleted', deleted._id, 'delete'),
      tx,
    );
    return { document: safeDocument(deleted) };
  }

  async expireUploadIntents(limit = 50): Promise<number> {
    let count = 0;
    const now = new Date();
    for (const intent of await this.files.listExpiredPending(now, limit)) {
      await this.unitOfWork.withTransaction(async (tx) => {
        const expired = await this.files.expireIntent(intent._id, now, tx);
        if (!expired) return;
        await this.usage.releaseReservedStorage(expired.workspaceId, expired.reservedBytes, tx);
        await this.audit.write(
          {
            eventType: 'UploadIntentExpired',
            workspaceId: expired.workspaceId,
            actor: {},
            entity: { type: 'upload_intent', id: expired._id },
            action: 'expire',
            after: { reservedBytes: expired.reservedBytes },
            correlationId: 'system',
          },
          tx,
        );
        count++;
      });
    }
    await this.cleanupOrphans(limit);
    return count;
  }

  async cleanupGeneratedFileIntents(limit = 50): Promise<number> {
    let cleaned = 0;
    const now = this.clock();
    for (const intent of await this.files.listGeneratedIntentCleanupDue(limit)) {
      try {
        await this.storage.deleteObject(intent.storageKey);
        await this.files.markGeneratedIntentCleaned(intent._id, now);
        cleaned++;
      } catch (error) {
        await this.files.markGeneratedIntentCleanupFailed(
          intent._id,
          error instanceof Error ? error.message : 'Unknown generated cleanup failure',
          now,
        );
      }
    }
    return cleaned;
  }

  async purgeFiles(limit = 50): Promise<number> {
    let count = 0;
    const now = new Date();
    for (const due of await this.files.listPurgeDue(now, limit)) {
      const pending = await this.files.markPurgePending(due._id, now);
      if (!pending) continue;
      await this.storage.deleteObject(pending.storageKey);
      await this.unitOfWork.withTransaction(async (tx) => {
        const purged = await this.files.markPurged(pending._id, now, tx);
        if (!purged) return;
        if (purged.origin !== 'SYSTEM_GENERATED') {
          await this.usage.releaseCommittedStorage(purged.workspaceId, purged.sizeBytes, tx);
        }
        await this.audit.write(
          {
            eventType: 'FilePurged',
            workspaceId: purged.workspaceId,
            actor: {},
            entity: { type: 'file', id: purged._id },
            action: 'purge',
            after: { sizeBytes: purged.sizeBytes },
            correlationId: 'system',
          },
          tx,
        );
        count++;
      });
    }
    return count;
  }

  private async cleanupOrphans(limit: number): Promise<void> {
    for (const intent of await this.files.listOrphanCleanupDue(limit)) {
      try {
        await this.storage.deleteObject(intent.storageKey);
        await this.files.markOrphanCleaned(intent._id);
      } catch (error) {
        await this.files.markOrphanCleanupFailed(
          intent._id,
          error instanceof Error ? error.message : 'Unknown cleanup failure',
        );
      }
    }
  }

  private async loadAuthorizedFile(
    ctx: RequestContext,
    workspaceId: string,
    fileId: string,
    options: { permission: string; requireActive: boolean },
  ): Promise<FileDocument> {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const file = await this.files.findFile(id, objectId(fileId, 'FILE_NOT_FOUND'));
    if (!file) throw notFound('FILE_NOT_FOUND');
    if (file.origin === 'SYSTEM_GENERATED') throw notFound('FILE_NOT_FOUND');
    if (options.requireActive && file.status !== 'ACTIVE') throw conflict('FILE_NOT_AVAILABLE');
    await this.authorizeFileContext(ctx, file, options.permission);
    if (file.classification === 'SENSITIVE') await this.requireSensitive(ctx, id, 'download');
    return file;
  }

  private async loadAuthorizedDownloadFile(
    ctx: RequestContext,
    workspaceId: string,
    fileId: string,
  ): Promise<{ file: FileDocument; effectiveClassification: FileClassification }> {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const file = await this.files.findFile(id, objectId(fileId, 'FILE_NOT_FOUND'));
    if (!file) throw notFound('FILE_NOT_FOUND');
    if (file.origin === 'SYSTEM_GENERATED') throw notFound('FILE_NOT_FOUND');
    if (file.status !== 'ACTIVE') throw conflict('FILE_NOT_AVAILABLE');
    const linkedDocument = await this.files.findDocumentForFile(id, file._id);
    if (linkedDocument?.status === 'ACTIVE') {
      await this.authorizeRelationship(
        ctx,
        file.workspaceId.toHexString(),
        linkedDocument.relationshipId.toHexString(),
        Permissions.FilesDownload,
        false,
      );
      const effectiveClassification = strongestClassification(
        file.classification,
        classificationForDocument(linkedDocument.category, linkedDocument.classification),
      );
      if (effectiveClassification === 'SENSITIVE') {
        await this.requireSensitive(ctx, id, 'download');
      }
      return { file, effectiveClassification };
    }
    await this.authorizeFileContext(ctx, file, Permissions.FilesDownload);
    if (file.classification === 'SENSITIVE') await this.requireSensitive(ctx, id, 'download');
    return { file, effectiveClassification: file.classification };
  }

  private async authorizeFileContext(ctx: RequestContext, file: FileDocument, permission: string) {
    if (file.subjectType === 'COACHING_RELATIONSHIP' && file.subjectId) {
      await this.authorizeRelationship(
        ctx,
        file.workspaceId.toHexString(),
        file.subjectId.toHexString(),
        permission,
        false,
      );
      return;
    }
    await this.workspacePermission(ctx, file.workspaceId, permission);
  }

  private async authorizeUpload(
    ctx: RequestContext,
    workspaceId: string,
    input: CreateUploadIntentInput,
    tx?: TransactionContext,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    if (input.subjectType === 'COACHING_RELATIONSHIP') {
      if (!input.subjectId) throw invalid('SUBJECT_REQUIRED');
      const ids = await this.authorizeRelationship(
        ctx,
        workspaceId,
        input.subjectId,
        Permissions.DocumentsUpload,
        true,
        tx,
      );
      if (
        (input.sensitive || input.classification === 'SENSITIVE') &&
        input.purpose === 'DOCUMENT'
      ) {
        await this.requireSensitive(ctx, id, 'upload');
      }
      return { ...ids, subjectId: ids.relationship._id };
    }
    const decision = await this.workspacePermission(ctx, id, Permissions.DocumentsUpload);
    return { workspaceId: id, membership: await this.actorMembership(ctx, id, tx), decision };
  }

  private async authorizeIntent(ctx: RequestContext, intent: UploadIntentDocument) {
    if (!intent.uploaderUserId.equals(actorId(ctx))) {
      await this.authorizeFileContext(
        ctx,
        {
          _id: new ObjectId(),
          workspaceId: intent.workspaceId,
          uploadIntentId: intent._id,
          uploaderUserId: intent.uploaderUserId,
          subjectType: intent.subjectType,
          ...(intent.subjectId ? { subjectId: intent.subjectId } : {}),
          storageProvider: intent.storageProvider,
          storageKey: intent.storageKey,
          originalName: intent.originalName,
          mimeType: intent.mimeType,
          sizeBytes: intent.reservedBytes,
          classification: intent.classification,
          status: 'ACTIVE',
          version: 0,
          createdAt: intent.createdAt,
          confirmedAt: intent.createdAt,
        },
        Permissions.DocumentsUpload,
      );
      return;
    }
    if (intent.subjectType === 'COACHING_RELATIONSHIP' && intent.subjectId) {
      await this.authorizeRelationship(
        ctx,
        intent.workspaceId.toHexString(),
        intent.subjectId.toHexString(),
        Permissions.DocumentsUpload,
        true,
      );
    } else {
      await this.workspacePermission(ctx, intent.workspaceId, Permissions.DocumentsUpload);
    }
  }

  private async authorizeRelationship(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    permission: string,
    requireOpenForWrite: boolean,
    tx?: TransactionContext,
  ): Promise<{
    workspaceId: ObjectId;
    relationship: CoachingRelationshipDocument;
    membership: WorkspaceMembershipDocument;
    decision: AuthorizationDecision;
  }> {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relationship = await this.relationships.findByIdInWorkspace(
      id,
      objectId(relationshipId, 'RELATIONSHIP_NOT_FOUND'),
      tx,
    );
    if (!relationship) throw notFound('RELATIONSHIP_NOT_FOUND');
    if (requireOpenForWrite && !['ACTIVE', 'NEEDS_REASSIGNMENT'].includes(relationship.status)) {
      throw conflict('RELATIONSHIP_NOT_ACTIVE');
    }
    const membership = await this.actorMembership(ctx, id, tx);
    const decision = await this.workspacePermission(ctx, id, permission);
    if (isTraineeSelf(ctx, relationship))
      return { workspaceId: id, relationship, membership, decision };
    const assignments = await this.relationships.listActiveAssignments(relationship._id, tx);
    const assigned = assignments.some((assignment) =>
      assignment.staffMembershipId.equals(membership._id),
    );
    if (assigned) return { workspaceId: id, relationship, membership, decision };
    if (decision.source === 'EXPLICIT_GRANT' && staff(membership) && assigned) {
      return { workspaceId: id, relationship, membership, decision };
    }
    throw forbidden();
  }

  private async requireSensitive(
    ctx: RequestContext,
    workspaceId: ObjectId,
    mode: 'read' | 'upload' | 'download',
  ) {
    const permission =
      mode === 'upload'
        ? Permissions.MedicalDocumentsUpload
        : mode === 'download'
          ? Permissions.MedicalDocumentsDownload
          : Permissions.MedicalDocumentsRead;
    await this.workspacePermission(ctx, workspaceId, permission);
  }

  private async workspacePermission(
    ctx: RequestContext,
    workspaceId: ObjectId,
    permission: string,
  ) {
    return await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId,
      permission,
      scope: { type: 'WORKSPACE' },
    });
  }

  private async actorMembership(
    ctx: RequestContext,
    workspaceId: ObjectId,
    tx?: TransactionContext,
  ) {
    if (ctx.supportSessionId && ctx.effectiveMembershipId) {
      const membership = await this.memberships.findByIdInWorkspace(
        workspaceId,
        objectId(ctx.effectiveMembershipId, 'WORKSPACE_MEMBERSHIP_NOT_FOUND'),
        tx,
      );
      if (membership?.status !== 'ACTIVE') throw forbidden();
      ctx.workspaceMembershipId = membership._id.toHexString();
      return membership;
    }
    const membership = await this.memberships.findByUserInWorkspace(workspaceId, actorId(ctx), tx);
    if (membership?.status !== 'ACTIVE') throw forbidden();
    ctx.workspaceMembershipId = membership._id.toHexString();
    return membership;
  }
}

function validateUploadInput(input: CreateUploadIntentInput): void {
  if (input.sizeBytes <= 0 || input.sizeBytes > maxUploadBytes) throw invalid('FILE_TOO_LARGE');
  if (!allowedMimeTypes.has(input.mimeType.trim().toLowerCase()))
    throw invalid('UNSUPPORTED_FILE_TYPE');
  if (input.checksumSha256) normalizeChecksum(input.checksumSha256);
  if (!input.fileName.trim()) throw invalid('FILE_NAME_REQUIRED');
}

function classificationForDocument(
  category: DocumentCategory,
  requested: FileClassification,
): FileClassification {
  if (mandatorySensitiveCategories.has(category)) return 'SENSITIVE';
  return requested;
}

function strongestClassification(
  left: FileClassification,
  right: FileClassification,
): FileClassification {
  return left === 'SENSITIVE' || right === 'SENSITIVE' ? 'SENSITIVE' : 'STANDARD';
}

function storageKey(workspaceId: ObjectId, now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `workspaces/${workspaceId.toHexString()}/${yyyy}/${mm}/${randomUUID()}`;
}

function normalizeChecksum(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw invalid('CHECKSUM_INVALID');
  return normalized;
}

function safeFile(file: FileDocument) {
  return {
    id: file._id.toHexString(),
    status: file.status,
    originalName: file.originalName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    classification: file.classification,
    version: file.version,
    createdAt: file.createdAt.toISOString(),
    confirmedAt: file.confirmedAt.toISOString(),
    ...(file.deletedAt ? { deletedAt: file.deletedAt.toISOString() } : {}),
    ...(file.purgeEligibleAt ? { purgeEligibleAt: file.purgeEligibleAt.toISOString() } : {}),
    ...(file.physicallyDeletedAt
      ? { physicallyDeletedAt: file.physicallyDeletedAt.toISOString() }
      : {}),
  };
}

function safeDocument(document: BusinessDocument) {
  return {
    id: document._id.toHexString(),
    relationshipId: document.relationshipId.toHexString(),
    fileId: document.fileId.toHexString(),
    category: document.category,
    ...(document.title ? { title: document.title } : {}),
    ...(document.description ? { description: document.description } : {}),
    classification: document.classification,
    status: document.status,
    version: document.version,
    ...(document.documentDate ? { documentDate: document.documentDate.toISOString() } : {}),
    createdAt: document.createdAt.toISOString(),
    ...(document.deletedAt ? { deletedAt: document.deletedAt.toISOString() } : {}),
  };
}

function page(items: unknown[], documents: BusinessDocument[]) {
  const last = documents.at(-1);
  return {
    data: items,
    pageInfo: {
      hasMore: documents.length >= 50,
      ...(last ? { nextCursor: `${last.createdAt.toISOString()}_${last._id.toHexString()}` } : {}),
    },
  };
}

function decodeCursor(cursor: string): { createdAt: Date; id: ObjectId } {
  const [iso, id] = cursor.split('_');
  return { createdAt: date(iso ?? '', 'CURSOR_INVALID'), id: objectId(id ?? '', 'CURSOR_INVALID') };
}

function minDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function date(value: string, code: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw invalid(code);
  return parsed;
}

function auditEvent(
  ctx: RequestContext,
  workspaceId: ObjectId,
  eventType: string,
  aggregateId: ObjectId,
  action: string,
  payload?: Record<string, unknown>,
) {
  return {
    eventType,
    workspaceId,
    actor: {
      userId: actorId(ctx),
      ...(ctx.platformMembershipId
        ? { platformMembershipId: new ObjectId(ctx.platformMembershipId) }
        : {}),
      ...(ctx.workspaceMembershipId
        ? { workspaceMembershipId: new ObjectId(ctx.workspaceMembershipId) }
        : {}),
    },
    ...(ctx.supportSessionId ? { supportSessionId: new ObjectId(ctx.supportSessionId) } : {}),
    ...(ctx.supportSessionId
      ? {
          effectiveContext: {
            targetWorkspaceId: ctx.workspaceId,
            effectiveUserId: ctx.effectiveUserId,
            effectiveMembershipId: ctx.effectiveMembershipId,
          },
        }
      : {}),
    entity: { type: eventType, id: aggregateId },
    action,
    ...(payload ? { after: payload } : {}),
    ipAddress: ctx.ipAddress,
    ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
    correlationId: ctx.correlationId,
  };
}

function objectId(value: string, code: string): ObjectId {
  if (!ObjectId.isValid(value)) throw notFound(code);
  return new ObjectId(value);
}

function actorId(ctx: RequestContext): ObjectId {
  if (!ctx.userId || !ObjectId.isValid(ctx.userId)) throw forbidden();
  return new ObjectId(ctx.userId);
}

function isTraineeSelf(ctx: RequestContext, relationship: CoachingRelationshipDocument): boolean {
  return Boolean(ctx.userId && relationship.traineeUserId.equals(new ObjectId(ctx.userId)));
}

function staff(membership: WorkspaceMembershipDocument): boolean {
  return membership.roles.some((role) => role !== 'TRAINEE');
}

function notFound(code: string): AppError {
  return new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
}

function forbidden(): AppError {
  return new AppError({ code: 'FORBIDDEN', httpStatus: 403, message: 'Forbidden.' });
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The file or document changed.' });
}

function invalid(code: string): AppError {
  return new AppError({ code, httpStatus: 422, message: 'The file request is invalid.' });
}
