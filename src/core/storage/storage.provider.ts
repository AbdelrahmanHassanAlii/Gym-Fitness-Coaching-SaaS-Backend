export interface PresignedUrl {
  url: string;
  expiresAt: Date;
}

export interface ObjectMetadata {
  key: string;
  sizeBytes: number;
  contentType?: string;
  checksumSha256?: string;
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
}

export interface StorageProvider {
  readonly provider: string;
  createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUrl>;
  statObject(key: string): Promise<ObjectMetadata | null>;
  createDownloadUrl(input: CreateDownloadUrlInput): Promise<PresignedUrl>;
  deleteObject(key: string): Promise<void>;
}
