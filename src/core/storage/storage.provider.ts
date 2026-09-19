export interface PresignedUrl {
  url: string;
  expiresAt: Date;
  headers?: Record<string, string>;
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
}

export interface StorageProvider {
  readonly provider: string;
  createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUrl>;
  putObject(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    checksumSha256?: string;
  }): Promise<ObjectMetadata>;
  statObject(key: string): Promise<ObjectMetadata | null>;
  createDownloadUrl(input: CreateDownloadUrlInput): Promise<PresignedUrl>;
  deleteObject(key: string): Promise<void>;
}
