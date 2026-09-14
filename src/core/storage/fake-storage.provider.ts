import type {
  CreateDownloadUrlInput,
  CreateUploadUrlInput,
  ObjectMetadata,
  PresignedUrl,
  StorageProvider,
} from './storage.provider';

export class FakeStorageProvider implements StorageProvider {
  readonly provider = 'fake';
  readonly objects = new Map<string, ObjectMetadata>();
  failNextUploadUrl = false;
  failNextDownloadUrl = false;
  failNextStat = false;
  failNextDelete = false;

  async createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUrl> {
    if (this.failNextUploadUrl) {
      this.failNextUploadUrl = false;
      throw new Error('Injected upload presign failure');
    }
    return {
      url: `https://storage.test/upload/${encodeURIComponent(input.key)}?signature=test`,
      expiresAt: input.expiresAt,
    };
  }

  async statObject(key: string): Promise<ObjectMetadata | null> {
    if (this.failNextStat) {
      this.failNextStat = false;
      throw new Error('Injected stat failure');
    }
    return this.objects.get(key) ?? null;
  }

  async createDownloadUrl(input: CreateDownloadUrlInput): Promise<PresignedUrl> {
    if (this.failNextDownloadUrl) {
      this.failNextDownloadUrl = false;
      throw new Error('Injected download presign failure');
    }
    return {
      url: `https://storage.test/download/${encodeURIComponent(input.key)}?signature=test&name=${encodeURIComponent(input.fileName)}`,
      expiresAt: input.expiresAt,
    };
  }

  async deleteObject(key: string): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error('Injected delete failure');
    }
    this.objects.delete(key);
  }

  putObject(input: ObjectMetadata): void {
    this.objects.set(input.key, input);
  }
}
