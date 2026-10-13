export interface PresignedUrl {
  url: string;
  expiresAt: Date;
  headers?: Record<string, string>;
}

export interface PresignedUploadRequest extends PresignedUrl {
  method: 'PUT';
  headers: Record<string, string>;
}

export interface ObjectMetadata {
  key: string;
  sizeBytes: number;
  contentType?: string;
  checksumSha256?: string;
  eTag?: string;
}

export interface CreateUploadUrlInput {
  key: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256?: string;
  expiresAt: Date;
}

export interface CreateDownloadUrlInput {
  key: string;
  fileName: string;
  contentType: string;
  expiresAt: Date;
  cacheControl?: string;
  expiresAtIsHardDeadline?: true;
}

export class DownloadUrlExpiredError extends Error {
  constructor() {
    super('No positive signing lifetime fits within the download deadline.');
  }
}

export function strictDownloadExpiry(deadline: Date, now: Date) {
  const expiresInSeconds = Math.floor((deadline.getTime() - now.getTime()) / 1000);
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds < 1)
    throw new DownloadUrlExpiredError();
  // SigV4's timestamp has whole-second precision; round down, never past the deadline.
  const expiresAt = new Date(Math.floor(now.getTime() / 1000) * 1000 + expiresInSeconds * 1000);
  return { expiresInSeconds, expiresAt };
}

export interface StorageProvider {
  readonly provider: string;
  createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUploadRequest>;
  putObject(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    checksumSha256?: string;
  }): Promise<ObjectMetadata>;
  putObjectFromFile(input: {
    key: string;
    path: string;
    contentType: string;
    sizeBytes: number;
    checksumSha256?: string;
  }): Promise<ObjectMetadata>;
  statObject(key: string): Promise<ObjectMetadata | null>;
  createDownloadUrl(input: CreateDownloadUrlInput): Promise<PresignedUrl>;
  deleteObject(key: string): Promise<void>;
}
