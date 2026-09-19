import { createHash, randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import type { AppConfig } from '../../config/config.types';
import type { AccessControlService } from '../../core/access-control/access-control.service';
import type { AuditWriter } from '../../core/audit/audit.writer';
import type { Database } from '../../core/database/database';
import type { TransactionContext, UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { OutboxWriter } from '../../core/events/outbox.writer';
import type { RequestContext } from '../../core/request-context/request-context';
import type { StorageProvider } from '../../core/storage/storage.provider';
import type { FileRepository } from '../files/file.repository';
import type { FileDocument, GeneratedFileIntentDocument } from '../files/file.types';
import { Permissions } from '../permissions/permission.registry';
import type { SubscriptionRepository } from '../subscriptions/subscription.repository';
import type {
  WorkspaceMembershipRepository,
  WorkspaceRepository,
} from '../workspaces/workspace.repository';
import type { WorkspaceExportRepository } from './export.repository';
import type { WorkspaceExportRequestDocument } from './export.types';

const exportContentType = 'application/zip';
const manifestVersion = 1 as const;
const readyTtlDefaultMs = 7 * 24 * 60 * 60 * 1000;
const sensitiveDownloadTtlMs = 2 * 60 * 1000;

export class WorkspaceExportApplicationService {
  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly unitOfWork: UnitOfWork,
    private readonly exports: WorkspaceExportRepository,
    private readonly files: FileRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly accessControl: AccessControlService,
    private readonly storage: StorageProvider,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(ctx: RequestContext, workspaceId: string, tx: TransactionContext) {
    if (ctx.supportSessionId) throw forbidden('EXPORT_SUPPORT_FORBIDDEN');
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId: id,
      permission: Permissions.ExportsWorkspaceCreate,
      scope: { type: 'WORKSPACE' },
    });
    const [workspace, membership, subscription] = await Promise.all([
      this.workspaces.findById(id, tx),
      ctx.userId ? this.memberships.findByUserInWorkspace(id, new ObjectId(ctx.userId)) : null,
      this.subscriptions.findByWorkspaceId(id, tx),
    ]);
    if (workspace?.status !== 'ACTIVE' || workspace?.deletionLockRequestId) {
      throw conflict('WORKSPACE_DELETION_LOCKED');
    }
    if (membership?.status !== 'ACTIVE') throw forbidden('WORKSPACE_MEMBERSHIP_REQUIRED');
    if (!subscription || !exportAllowed(subscription.lifecycleStatus, subscription.expiredAt)) {
      throw conflict('EXPORT_NOT_ALLOWED_FOR_SUBSCRIPTION');
    }
    const now = this.clock();
    const document: WorkspaceExportRequestDocument = {
      _id: new ObjectId(),
      workspaceId: id,
      requestedByUserId: new ObjectId(ctx.userId ?? ''),
      requestedByMembershipId: membership._id,
      status: 'PENDING',
      requestedAt: now,
      attemptCount: 0,
      format: 'ZIP_JSON_V1',
      manifestVersion,
      scopeSnapshot: {
        includesUploadedBinaries: false,
        requestedByUserId: new ObjectId(ctx.userId ?? ''),
        requestedByMembershipId: membership._id,
      },
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.exports.create(document, tx);
    await this.audit.write(
      auditEvent(ctx, id, 'WorkspaceExportRequested', created._id, 'create'),
      tx,
    );
    await this.outbox.write(
      {
        eventType: 'WorkspaceExportRequested',
        aggregateType: 'workspace_export',
        aggregateId: created._id,
        workspaceId: id,
        payload: { exportId: created._id.toHexString() },
        correlationId: ctx.correlationId,
      },
      tx,
    );
    return { export: safeExport(created) };
  }

  async list(ctx: RequestContext, workspaceId: string, query: { cursor?: string; limit?: number }) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId: id,
      permission: Permissions.ExportsWorkspaceRead,
      scope: { type: 'WORKSPACE' },
    });
    const exports = await this.exports.list({
      workspaceId: id,
      limit: Math.min(query.limit ?? 50, 100),
      ...(query.cursor ? { after: decodeCursor(query.cursor) } : {}),
    });
    return page(exports.map(safeExport), exports);
  }

  async get(ctx: RequestContext, workspaceId: string, exportId: string) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId: id,
      permission: Permissions.ExportsWorkspaceRead,
      scope: { type: 'WORKSPACE' },
    });
    const exportRequest = await this.exports.findById(id, objectId(exportId, 'EXPORT_NOT_FOUND'));
    if (!exportRequest) throw notFound('EXPORT_NOT_FOUND');
    return { export: safeExport(exportRequest) };
  }

  async createDownloadUrl(ctx: RequestContext, workspaceId: string, exportId: string) {
    if (ctx.supportSessionId) throw forbidden('EXPORT_SUPPORT_FORBIDDEN');
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const exportObjectId = objectId(exportId, 'EXPORT_NOT_FOUND');
    await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId: id,
      permission: Permissions.ExportsWorkspaceDownload,
      scope: { type: 'WORKSPACE' },
    });
    const workspace = await this.workspaces.findById(id);
    if (workspace?.status !== 'ACTIVE' || workspace?.deletionLockRequestId) {
      throw conflict('WORKSPACE_DELETION_LOCKED');
    }
    const exportRequest = await this.exports.findById(id, exportObjectId);
    if (!exportRequest) throw notFound('EXPORT_NOT_FOUND');
    if (
      exportRequest.status !== 'READY' ||
      !exportRequest.expiresAt ||
      exportRequest.expiresAt <= this.clock()
    ) {
      throw conflict('EXPORT_NOT_READY');
    }
    if (!exportRequest.artifactFileId) throw conflict('EXPORT_ARTIFACT_NOT_READY');
    const file = await this.files.findGeneratedFileForExport(id, exportObjectId);
    if (!file?._id.equals(exportRequest.artifactFileId) || file.status !== 'ACTIVE') {
      throw conflict('EXPORT_ARTIFACT_NOT_READY');
    }
    const expiresAt = new Date(this.clock().getTime() + sensitiveDownloadTtlMs);
    const signed = await this.storage.createDownloadUrl({
      key: file.storageKey,
      fileName: file.originalName,
      contentType: file.mimeType,
      expiresAt,
    });
    await this.audit.write(
      auditEvent(ctx, id, 'WorkspaceExportDownloadUrlIssued', exportObjectId, 'read', {
        exportId: exportObjectId.toHexString(),
        fileId: file._id.toHexString(),
      }),
    );
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }

  async generateDue(): Promise<number> {
    let processed = 0;
    const limit = this.config.exports?.batchSize ?? 10;
    for (let index = 0; index < limit; index += 1) {
      const now = this.clock();
      const claim = await this.exports.claimNext({
        now,
        workerId: this.config.worker.id,
        leaseMs: this.config.exports?.processingClaimTtlMs ?? 10 * 60 * 1000,
      });
      if (!claim) break;
      await this.generateClaimed(claim.exportRequest, claim.claimId).catch(async (error) => {
        await this.exports.markFailed({
          exportId: claim.exportRequest._id,
          workspaceId: claim.exportRequest.workspaceId,
          claimId: claim.claimId,
          now: this.clock(),
          code: 'EXPORT_GENERATION_FAILED',
          message: error instanceof Error ? error.message : 'Unknown export failure',
        });
      });
      processed += 1;
    }
    return processed;
  }

  async expireDue(): Promise<number> {
    const now = this.clock();
    let count = 0;
    for (const due of await this.exports.expireDue(now, this.config.exports?.batchSize ?? 10)) {
      await this.unitOfWork.withTransaction(async (tx) => {
        const expired = await this.exports.expire(due._id, now, undefined, tx);
        if (!expired) return;
        if (expired.artifactFileId) {
          await this.files.markGeneratedExportFilePurgeEligible({
            workspaceId: expired.workspaceId,
            exportId: expired._id,
            now,
            tx,
          });
        }
        await this.audit.write(
          auditEvent(
            { correlationId: 'system' } as RequestContext,
            expired.workspaceId,
            'WorkspaceExportExpired',
            expired._id,
            'expire',
          ),
          tx,
        );
        await this.outbox.write(
          {
            eventType: 'WorkspaceExportExpired',
            aggregateType: 'workspace_export',
            aggregateId: expired._id,
            workspaceId: expired.workspaceId,
            payload: { exportId: expired._id.toHexString() },
            correlationId: 'system',
          },
          tx,
        );
        count += 1;
      });
    }
    return count;
  }

  private async generateClaimed(exportRequest: WorkspaceExportRequestDocument, claimId: string) {
    const workspace = await this.workspaces.findById(exportRequest.workspaceId);
    if (workspace?.status !== 'ACTIVE' || workspace?.deletionLockRequestId) {
      throw new Error('Workspace is not exportable');
    }
    const existing = await this.files.findGeneratedFileForExport(
      exportRequest.workspaceId,
      exportRequest._id,
    );
    const artifact = existing ?? (await this.createArtifact(exportRequest));
    const now = this.clock();
    const expiresAt = new Date(
      now.getTime() + (this.config.exports?.readyTtlMs ?? readyTtlDefaultMs),
    );
    await this.unitOfWork.withTransaction(async (tx) => {
      const freshWorkspace = await this.workspaces.findById(exportRequest.workspaceId, tx);
      if (freshWorkspace?.status !== 'ACTIVE' || freshWorkspace?.deletionLockRequestId) {
        throw conflict('WORKSPACE_DELETION_LOCKED');
      }
      const ready = await this.exports.markReady(
        {
          exportId: exportRequest._id,
          workspaceId: exportRequest.workspaceId,
          claimId,
          now,
          expiresAt,
          artifactFileId: artifact._id,
          artifactSizeBytes: artifact.sizeBytes,
          artifactSha256: artifact.verifiedChecksumSha256 ?? '',
        },
        tx,
      );
      await this.audit.write(
        auditEvent(
          { correlationId: 'system' } as RequestContext,
          ready.workspaceId,
          'WorkspaceExportReady',
          ready._id,
          'complete',
        ),
        tx,
      );
      await this.outbox.write(
        {
          eventType: 'WorkspaceExportReady',
          aggregateType: 'workspace_export',
          aggregateId: ready._id,
          workspaceId: ready.workspaceId,
          payload: {
            exportId: ready._id.toHexString(),
            requestedByUserId: ready.requestedByUserId.toHexString(),
          },
          correlationId: 'system',
        },
        tx,
      );
    });
  }

  private async createArtifact(
    exportRequest: WorkspaceExportRequestDocument,
  ): Promise<FileDocument> {
    const now = this.clock();
    const key = `workspaces/${exportRequest.workspaceId.toHexString()}/exports/${exportRequest._id.toHexString()}/${randomUUID()}.zip`;
    const intent: GeneratedFileIntentDocument = {
      _id: new ObjectId(),
      workspaceId: exportRequest.workspaceId,
      purpose: 'WORKSPACE_EXPORT',
      exportId: exportRequest._id,
      storageProvider: this.storage.provider,
      storageKey: key,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    };
    await this.files.createGeneratedFileIntent(intent);
    const tempDir = await mkdtemp(join(tmpdir(), 'stage17-export-'));
    const tempPath = join(tempDir, `${exportRequest._id.toHexString()}.zip`);
    try {
      const artifact = await this.writeArchiveToFile(exportRequest, tempPath);
      const object = await this.storage.putObjectFromFile({
        key,
        path: tempPath,
        contentType: exportContentType,
        sizeBytes: artifact.sizeBytes,
        checksumSha256: artifact.sha256,
      });
      await this.files.markGeneratedObjectWritten({
        intentId: intent._id,
        sizeBytes: object.sizeBytes,
        checksumSha256: artifact.sha256,
        now: this.clock(),
      });
      return await this.unitOfWork.withTransaction(async (tx) => {
        const file: FileDocument = {
          _id: new ObjectId(),
          workspaceId: exportRequest.workspaceId,
          origin: 'SYSTEM_GENERATED',
          generatedPurpose: 'WORKSPACE_EXPORT',
          generatedForExportId: exportRequest._id,
          subjectType: 'WORKSPACE',
          subjectId: exportRequest.workspaceId,
          storageProvider: this.storage.provider,
          storageKey: key,
          originalName: `workspace-export-${exportRequest._id.toHexString()}.zip`,
          mimeType: exportContentType,
          sizeBytes: object.sizeBytes,
          verifiedChecksumSha256: artifact.sha256,
          classification: 'SENSITIVE',
          status: 'ACTIVE',
          version: 0,
          createdAt: this.clock(),
          confirmedAt: this.clock(),
        };
        return await this.files.createGeneratedFile({
          intentId: intent._id,
          file,
          now: this.clock(),
          tx,
        });
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async writeArchiveToFile(
    exportRequest: WorkspaceExportRequestDocument,
    path: string,
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const handle = await open(path, 'w');
    const writer = new StreamingZipWriter(handle);
    try {
      const datasets: ExportDatasetSummary[] = [];
      for (const collection of exportCollections) {
        const summary = await this.writeDatasetEntry(writer, collection, exportRequest.workspaceId);
        datasets.push(summary);
      }
      await writer.writeEntry(
        'manifest.json',
        Buffer.from(
          JSON.stringify(
            [
              {
                format: 'ZIP_JSON_V1',
                manifestVersion,
                generatedAt: this.clock().toISOString(),
                workspaceId: exportRequest.workspaceId.toHexString(),
                uploadedBinariesIncluded: false,
                binaryPolicy:
                  'Uploaded Stage 13 binary objects are excluded from Stage 17 V1 exports.',
                datasets: datasets.map((dataset) => dataset.fileName).sort(),
                datasetCounts: Object.fromEntries(
                  datasets.map((dataset) => [dataset.collection, dataset.rowCount]),
                ),
              },
            ],
            jsonReplacer,
            2,
          ),
        ),
      );
      return await writer.close();
    } catch (error) {
      await writer.abort();
      throw error;
    }
  }

  private async writeDatasetEntry(
    writer: StreamingZipWriter,
    collection: string,
    workspaceId: ObjectId,
  ): Promise<ExportDatasetSummary> {
    const batchSize = Math.min(this.config.exports?.batchSize ?? 100, 500);
    const fileName = `${collection}.json`;
    const entry = await writer.startEntry(fileName);
    let rowCount = 0;
    let afterId: ObjectId | undefined;
    await entry.write(Buffer.from('['));
    while (true) {
      const batch = await this.database.db
        .collection(collection)
        .find(exportDatasetPredicate(collection, workspaceId, afterId), {
          projection: exportProjection(collection),
        })
        .sort({ _id: 1 })
        .limit(batchSize)
        .toArray();
      if (batch.length === 0) break;
      for (const row of batch) {
        await entry.write(
          Buffer.from(`${rowCount > 0 ? ',' : ''}\n${JSON.stringify(row, jsonReplacer, 2)}`),
        );
        rowCount += 1;
      }
      const lastId = batch.at(-1)?._id;
      if (!(lastId instanceof ObjectId)) break;
      afterId = lastId;
      if (batch.length < batchSize) break;
    }
    await entry.write(Buffer.from(rowCount > 0 ? '\n]' : ']'));
    await entry.close();
    return { collection, fileName, rowCount };
  }
}

const exportCollections = [
  'workspaces',
  'branches',
  'workspace_memberships',
  'membership_branch_assignments',
  'coaching_relationships',
  'trainee_staff_assignments',
  'exercises',
  'program_templates',
  'program_template_revisions',
  'programs',
  'program_revisions',
  'program_progress',
  'program_progress_events',
  'workout_sessions',
  'personal_records',
  'personal_record_events',
  'foods',
  'nutrition_plans',
  'nutrition_plan_revisions',
  'metric_definitions',
  'measurement_entries',
  'progress_photo_entries',
  'trainee_health_profiles',
  'coaching_notes',
  'adherence_configs',
  'daily_tracking_entries',
  'checkin_templates',
  'checkin_template_revisions',
  'checkin_assignments',
  'checkin_instances',
  'files',
  'documents',
] as const;

interface ExportDatasetSummary {
  collection: string;
  fileName: string;
  rowCount: number;
}

function exportProjection(collection: string): Record<string, 0> {
  if (collection === 'files') return { storageKey: 0 };
  if (collection === 'workspace_memberships') return {};
  return {};
}

function exportDatasetPredicate(collection: string, workspaceId: ObjectId, afterId?: ObjectId) {
  if (collection === 'workspaces') {
    return { _id: workspaceId, ...(afterId ? { _id: { $gt: afterId } } : {}) };
  }
  return {
    workspaceId,
    ...(afterId ? { _id: { $gt: afterId } } : {}),
  };
}

function exportAllowed(status: string, expiredAt?: Date): boolean {
  if (['TRIAL', 'ACTIVE', 'GRACE_PERIOD', 'FROZEN'].includes(status)) return true;
  return status === 'EXPIRED' && Boolean(expiredAt);
}

function page<T>(items: T[], raw: WorkspaceExportRequestDocument[]) {
  const last = raw.at(-1);
  return {
    data: items,
    meta: {
      hasMore: false,
      nextCursor: last
        ? Buffer.from(
            JSON.stringify({
              requestedAt: last.requestedAt.toISOString(),
              id: last._id.toHexString(),
            }),
          ).toString('base64url')
        : null,
    },
  };
}

function decodeCursor(value: string): { requestedAt: Date; id: ObjectId } {
  const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
    requestedAt: string;
    id: string;
  };
  return { requestedAt: new Date(parsed.requestedAt), id: new ObjectId(parsed.id) };
}

function safeExport(item: WorkspaceExportRequestDocument) {
  return {
    id: item._id.toHexString(),
    workspaceId: item.workspaceId.toHexString(),
    requestedByUserId: item.requestedByUserId.toHexString(),
    status: item.status,
    requestedAt: item.requestedAt.toISOString(),
    completedAt: item.completedAt?.toISOString(),
    failedAt: item.failedAt?.toISOString(),
    failure: item.failure,
    expiresAt: item.expiresAt?.toISOString(),
    expiredAt: item.expiredAt?.toISOString(),
    format: item.format,
    manifestVersion: item.manifestVersion,
    version: item.version,
  };
}

function auditEvent(
  ctx: RequestContext,
  workspaceId: ObjectId,
  eventType: string,
  entityId: ObjectId,
  action: string,
  after?: Record<string, unknown>,
) {
  return {
    eventType,
    workspaceId,
    actor: {
      ...(ctx.userId && ObjectId.isValid(ctx.userId) ? { userId: new ObjectId(ctx.userId) } : {}),
      ...(ctx.workspaceMembershipId && ObjectId.isValid(ctx.workspaceMembershipId)
        ? { workspaceMembershipId: new ObjectId(ctx.workspaceMembershipId) }
        : {}),
      ...(ctx.platformMembershipId && ObjectId.isValid(ctx.platformMembershipId)
        ? { platformMembershipId: new ObjectId(ctx.platformMembershipId) }
        : {}),
    },
    entity: { type: eventType, id: entityId },
    action,
    ...(after ? { after } : {}),
    correlationId: ctx.correlationId,
  };
}

function objectId(value: string, code: string): ObjectId {
  if (!ObjectId.isValid(value)) throw notFound(code);
  return new ObjectId(value);
}

function notFound(code: string): AppError {
  return new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
}

function forbidden(code = 'FORBIDDEN'): AppError {
  return new AppError({ code, httpStatus: 403, message: 'Forbidden.' });
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The export state changed.' });
}

function jsonReplacer(_key: string, value: unknown) {
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

interface ZipCentralEntry {
  nameBytes: Buffer;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

class StreamingZipWriter {
  private readonly hash = createHash('sha256');
  private readonly centralEntries: ZipCentralEntry[] = [];
  private offset = 0;
  private closed = false;
  private aborted = false;

  constructor(private readonly handle: FileHandle) {}

  async startEntry(name: string): Promise<StreamingZipEntry> {
    if (this.closed || this.aborted) throw new Error('ZIP writer is closed');
    const nameBytes = Buffer.from(name);
    const localHeaderOffset = this.offset;
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x08, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    await this.write(local);
    return new StreamingZipEntry(this, nameBytes, localHeaderOffset);
  }

  async writeEntry(name: string, content: Uint8Array): Promise<void> {
    const entry = await this.startEntry(name);
    await entry.write(content);
    await entry.close();
  }

  async close(): Promise<{ sizeBytes: number; sha256: string }> {
    if (this.closed) throw new Error('ZIP writer already closed');
    this.closed = true;
    const centralOffset = this.offset;
    let centralSize = 0;
    for (const entry of this.centralEntries) {
      const central = Buffer.alloc(46 + entry.nameBytes.length);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x08, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt32LE(0, 12);
      central.writeUInt32LE(entry.crc, 16);
      central.writeUInt32LE(entry.compressedSize, 20);
      central.writeUInt32LE(entry.uncompressedSize, 24);
      central.writeUInt16LE(entry.nameBytes.length, 28);
      central.writeUInt32LE(entry.localHeaderOffset, 42);
      entry.nameBytes.copy(central, 46);
      await this.write(central);
      centralSize += central.byteLength;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.centralEntries.length, 8);
    end.writeUInt16LE(this.centralEntries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    await this.write(end);
    await this.handle.close();
    return { sizeBytes: this.offset, sha256: this.hash.digest('hex') };
  }

  async abort(): Promise<void> {
    if (this.closed || this.aborted) return;
    this.aborted = true;
    await this.handle.close().catch(() => undefined);
  }

  async write(chunk: Uint8Array): Promise<void> {
    await this.handle.write(chunk);
    this.hash.update(chunk);
    this.offset += chunk.byteLength;
  }

  async finishEntry(entry: ZipCentralEntry): Promise<void> {
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(entry.crc, 4);
    descriptor.writeUInt32LE(entry.compressedSize, 8);
    descriptor.writeUInt32LE(entry.uncompressedSize, 12);
    await this.write(descriptor);
    this.centralEntries.push(entry);
  }
}

class StreamingZipEntry {
  private crc = 0xffffffff;
  private size = 0;
  private closed = false;

  constructor(
    private readonly writer: StreamingZipWriter,
    private readonly nameBytes: Buffer,
    private readonly localHeaderOffset: number,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('ZIP entry is closed');
    this.crc = crc32Update(this.crc, chunk);
    this.size += chunk.byteLength;
    await this.writer.write(chunk);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const crc = (this.crc ^ 0xffffffff) >>> 0;
    await this.writer.finishEntry({
      nameBytes: this.nameBytes,
      crc,
      compressedSize: this.size,
      uncompressedSize: this.size,
      localHeaderOffset: this.localHeaderOffset,
    });
  }
}

function crc32Update(current: number, input: Uint8Array): number {
  let crc = current;
  for (const byte of input) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return crc;
}
