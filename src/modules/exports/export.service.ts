import { createHash, randomUUID } from 'node:crypto';
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
    const archive = await this.buildArchive(exportRequest);
    const checksum = createHash('sha256').update(archive).digest('hex');
    const object = await this.storage.putObject({
      key,
      body: archive,
      contentType: exportContentType,
      checksumSha256: checksum,
    });
    await this.files.markGeneratedObjectWritten({
      intentId: intent._id,
      sizeBytes: object.sizeBytes,
      checksumSha256: checksum,
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
        verifiedChecksumSha256: checksum,
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
  }

  private async buildArchive(exportRequest: WorkspaceExportRequestDocument): Promise<Uint8Array> {
    const datasets: Record<string, unknown[]> = {};
    for (const collection of exportCollections) {
      datasets[`${collection}.json`] = await this.database.db
        .collection(collection)
        .find(
          { workspaceId: exportRequest.workspaceId },
          { projection: exportProjection(collection) },
        )
        .sort({ _id: 1 })
        .limit(10_000)
        .toArray();
    }
    datasets['manifest.json'] = [
      {
        format: 'ZIP_JSON_V1',
        manifestVersion,
        generatedAt: this.clock().toISOString(),
        workspaceId: exportRequest.workspaceId.toHexString(),
        uploadedBinariesIncluded: false,
        binaryPolicy: 'Uploaded Stage 13 binary objects are excluded from Stage 17 V1 exports.',
        datasets: Object.keys(datasets)
          .filter((name) => name !== 'manifest.json')
          .sort(),
      },
    ];
    return zipStore(
      Object.fromEntries(
        Object.entries(datasets)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, value]) => [name, Buffer.from(JSON.stringify(value, jsonReplacer, 2))]),
      ),
    );
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

function exportProjection(collection: string): Record<string, 0> {
  if (collection === 'files') return { storageKey: 0 };
  if (collection === 'workspace_memberships') return {};
  return {};
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

function zipStore(files: Record<string, Uint8Array>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const crc = crc32(content);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.byteLength, 18);
    local.writeUInt32LE(content.byteLength, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    chunks.push(local, content);
    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(0, 8);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(content.byteLength, 20);
    centralHeader.writeUInt32LE(content.byteLength, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    nameBytes.copy(centralHeader, 46);
    central.push(centralHeader);
    offset += local.byteLength + content.byteLength;
  }
  const centralOffset = offset;
  const centralSize = central.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
