import type { ObjectId } from 'mongodb';

export const UploadIntentStatuses = ['PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED'] as const;
export type UploadIntentStatus = (typeof UploadIntentStatuses)[number];

export const FileStatuses = ['ACTIVE', 'SOFT_DELETED', 'PURGE_PENDING', 'PURGED'] as const;
export type FileStatus = (typeof FileStatuses)[number];

export const DocumentStatuses = ['ACTIVE', 'DELETED'] as const;
export type DocumentStatus = (typeof DocumentStatuses)[number];

export const FileClassifications = ['STANDARD', 'SENSITIVE'] as const;
export type FileClassification = (typeof FileClassifications)[number];

export const DocumentCategories = [
  'INBODY',
  'BLOOD_TEST',
  'MEDICAL_REPORT',
  'DIET_DOCUMENT',
  'TRAINING_DOCUMENT',
  'INJURY_REPORT',
  'OTHER',
] as const;
export type DocumentCategory = (typeof DocumentCategories)[number];

export const UploadPurposes = ['DOCUMENT', 'PROGRESS_PHOTO', 'GENERIC'] as const;
export type UploadPurpose = (typeof UploadPurposes)[number];

export const SubjectTypes = ['COACHING_RELATIONSHIP', 'WORKSPACE'] as const;
export type SubjectType = (typeof SubjectTypes)[number];

export const FileOrigins = ['USER_UPLOAD', 'SYSTEM_GENERATED'] as const;
export type FileOrigin = (typeof FileOrigins)[number];

export const GeneratedFilePurposes = ['WORKSPACE_EXPORT'] as const;
export type GeneratedFilePurpose = (typeof GeneratedFilePurposes)[number];

export const GeneratedFileIntentStatuses = [
  'PENDING',
  'OBJECT_WRITTEN',
  'FILE_CREATED',
  'CLEANED',
  'FAILED',
] as const;
export type GeneratedFileIntentStatus = (typeof GeneratedFileIntentStatuses)[number];

export interface UploadIntentDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  uploaderUserId: ObjectId;
  uploaderMembershipId?: ObjectId;
  purpose: UploadPurpose;
  subjectType: SubjectType;
  subjectId?: ObjectId;
  storageProvider: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  reservedBytes: number;
  expectedChecksumSha256?: string;
  classification: FileClassification;
  status: UploadIntentStatus;
  version: number;
  expiresAt: Date;
  createdAt: Date;
  confirmedAt?: Date;
  cancelledAt?: Date;
  expiredAt?: Date;
  orphanCleanupStatus?: 'PENDING' | 'DONE' | 'FAILED';
  orphanCleanupAttempts?: number;
  lastCleanupError?: string;
}

export interface FileDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  origin?: FileOrigin;
  uploadIntentId?: ObjectId;
  uploaderUserId?: ObjectId;
  uploaderMembershipId?: ObjectId;
  generatedPurpose?: GeneratedFilePurpose;
  generatedForExportId?: ObjectId;
  subjectType: SubjectType;
  subjectId?: ObjectId;
  storageProvider: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  verifiedChecksumSha256?: string;
  classification: FileClassification;
  status: FileStatus;
  version: number;
  createdAt: Date;
  confirmedAt: Date;
  deletedAt?: Date;
  deletedBy?: ObjectId;
  purgeEligibleAt?: Date;
  restoredAt?: Date;
  restoredBy?: ObjectId;
  purgePendingAt?: Date;
  physicallyDeletedAt?: Date;
  expiresAt?: Date;
}

export interface GeneratedFileIntentDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  purpose: GeneratedFilePurpose;
  exportId: ObjectId;
  storageProvider: string;
  storageKey: string;
  status: GeneratedFileIntentStatus;
  fileId?: ObjectId;
  sizeBytes?: number;
  checksumSha256?: string;
  cleanupAttempts?: number;
  lastCleanupError?: string;
  createdAt: Date;
  objectWrittenAt?: Date;
  fileCreatedAt?: Date;
  cleanedAt?: Date;
  failedAt?: Date;
  updatedAt: Date;
}

export interface BusinessDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  fileId: ObjectId;
  category: DocumentCategory;
  title?: string;
  description?: string;
  uploadedByUserId: ObjectId;
  uploadedByMembershipId?: ObjectId;
  classification: FileClassification;
  documentDate?: Date;
  status: DocumentStatus;
  version: number;
  createdAt: Date;
  deletedAt?: Date;
  deletedBy?: ObjectId;
}
