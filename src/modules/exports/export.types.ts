import type { ObjectId } from 'mongodb';

export const WorkspaceExportStatuses = [
  'PENDING',
  'PROCESSING',
  'READY',
  'FAILED',
  'EXPIRED',
] as const;
export type WorkspaceExportStatus = (typeof WorkspaceExportStatuses)[number];

export const WorkspaceExportFormats = ['ZIP_JSON_V1'] as const;
export type WorkspaceExportFormat = (typeof WorkspaceExportFormats)[number];

export const ExportSystemCodes = ['WORKSPACE_DELETION_APPROVED'] as const;
export type ExportSystemCode = (typeof ExportSystemCodes)[number];

export interface WorkspaceExportRequestDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  requestedByUserId: ObjectId;
  requestedByMembershipId: ObjectId;
  status: WorkspaceExportStatus;
  requestedAt: Date;
  processingStartedAt?: Date;
  processingClaimId?: string;
  processingClaimedByWorkerId?: string;
  processingLeaseExpiresAt?: Date;
  attemptCount: number;
  lastAttemptAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  failure?: { code: string; message?: string; retryable: false };
  expiresAt?: Date;
  expiredAt?: Date;
  expirationReason?: string;
  artifactFileId?: ObjectId;
  artifactSizeBytes?: number;
  artifactSha256?: string;
  format: WorkspaceExportFormat;
  manifestVersion: 1;
  scopeSnapshot: {
    includesUploadedBinaries: false;
    requestedByUserId: ObjectId;
    requestedByMembershipId: ObjectId;
  };
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
