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
  readonly bodies = new Map<string, Uint8Array>();
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
      headers: {
        'content-length': String(input.sizeBytes),
        'content-type': input.contentType,
        'if-none-match': '*',
        ...(input.checksumSha256 ? { 'x-checksum-sha256': input.checksumSha256 } : {}),
      },
    };
  }

  async statObject(key: string): Promise<ObjectMetadata | null> {
    if (this.failNextStat) {
      this.failNextStat = false;
      throw new Error('Injected stat failure');
    }
    return this.objects.get(key) ?? null;
  }

  putObject(input: ObjectMetadata, options?: { overwrite?: boolean }): void;
  putObject(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    checksumSha256?: string;
  }): Promise<ObjectMetadata>;
  putObject(
    input:
      | ObjectMetadata
      | { key: string; body: Uint8Array; contentType: string; checksumSha256?: string },
    options: { overwrite?: boolean } = {},
  ): undefined | Promise<ObjectMetadata> {
    if ('body' in input) {
      const metadata: ObjectMetadata = {
        key: input.key,
        sizeBytes: input.body.byteLength,
        contentType: input.contentType,
        ...(input.checksumSha256 ? { checksumSha256: input.checksumSha256 } : {}),
      };
      this.putObjectMetadata(metadata);
      return Promise.resolve(metadata);
    }
    this.putObjectMetadata(input, options);
    return undefined;
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

  putObjectMetadata(input: ObjectMetadata, options: { overwrite?: boolean } = {}): void {
    if (!options.overwrite && this.objects.has(input.key)) {
      throw new Error('Object already exists');
    }
    this.objects.set(input.key, input);
  }

  async putObjectFromFile(input: {
    key: string;
    path: string;
    contentType: string;
    sizeBytes: number;
    checksumSha256?: string;
  }): Promise<ObjectMetadata> {
    const body = new Uint8Array(await Bun.file(input.path).arrayBuffer());
    if (body.byteLength !== input.sizeBytes) {
      throw new Error('Generated artifact size mismatch');
    }
    this.bodies.set(input.key, body);
    const metadata: ObjectMetadata = {
      key: input.key,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      ...(input.checksumSha256 ? { checksumSha256: input.checksumSha256 } : {}),
    };
    this.putObjectMetadata(metadata);
    return metadata;
  }
}
