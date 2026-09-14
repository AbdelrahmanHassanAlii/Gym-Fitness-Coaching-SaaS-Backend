import { createHash, createHmac } from 'node:crypto';
import type {
  CreateDownloadUrlInput,
  CreateUploadUrlInput,
  ObjectMetadata,
  PresignedUrl,
  StorageProvider,
} from './storage.provider';

interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

const service = 's3';
const emptyPayloadHash = 'UNSIGNED-PAYLOAD';

export class S3CompatibleStorageProvider implements StorageProvider {
  readonly provider = 's3';

  constructor(private readonly config: S3Config) {}

  async createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUrl> {
    return {
      url: this.presign('PUT', input.key, input.expiresAt, {
        'content-type': input.contentType,
        ...(input.checksumSha256 ? { 'x-amz-checksum-sha256': input.checksumSha256 } : {}),
      }),
      expiresAt: input.expiresAt,
    };
  }

  async statObject(key: string): Promise<ObjectMetadata | null> {
    const response = await fetch(this.objectUrl(key), { method: 'HEAD' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Object storage HEAD failed with status ${response.status}`);
    const size = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    const contentType = response.headers.get('content-type');
    const checksumSha256 = response.headers.get('x-amz-checksum-sha256');
    return {
      key,
      sizeBytes: Number.isFinite(size) ? size : 0,
      ...(contentType ? { contentType } : {}),
      ...(checksumSha256 ? { checksumSha256 } : {}),
    };
  }

  async createDownloadUrl(input: CreateDownloadUrlInput): Promise<PresignedUrl> {
    return {
      url: this.presign('GET', input.key, input.expiresAt, {
        'response-content-disposition': `attachment; filename="${safeFileName(input.fileName)}"`,
        'response-content-type': input.contentType,
      }),
      expiresAt: input.expiresAt,
    };
  }

  async deleteObject(key: string): Promise<void> {
    const response = await fetch(this.objectUrl(key), {
      method: 'DELETE',
      headers: this.signedHeaders('DELETE', key),
    });
    if (!response.ok && response.status !== 404 && response.status !== 204) {
      throw new Error(`Object storage delete failed with status ${response.status}`);
    }
  }

  private objectUrl(key: string): string {
    return `${this.config.endpoint.replace(/\/$/, '')}/${this.config.bucket}/${encodeKey(key)}`;
  }

  private presign(
    method: 'GET' | 'PUT',
    key: string,
    expiresAt: Date,
    extraParams: Record<string, string>,
  ): string {
    const now = new Date();
    const amzDate = amzTimestamp(now);
    const dateStamp = amzDate.slice(0, 8);
    const expires = Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
    const credentialScope = `${dateStamp}/${this.config.region}/${service}/aws4_request`;
    const host = new URL(this.config.endpoint).host;
    const path = `/${this.config.bucket}/${encodeKey(key)}`;
    const query = new URLSearchParams({
      ...extraParams,
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKey}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expires),
      'X-Amz-SignedHeaders': 'host',
    });
    const canonicalQuery = canonicalSearch(query);
    const canonicalRequest = [
      method,
      path,
      canonicalQuery,
      `host:${host}\n`,
      'host',
      emptyPayloadHash,
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256(canonicalRequest),
    ].join('\n');
    const signature = hmac(
      signingKey(this.config.secretKey, dateStamp, this.config.region),
      stringToSign,
    );
    return `${this.config.endpoint.replace(/\/$/, '')}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  private signedHeaders(method: 'DELETE', key: string): Record<string, string> {
    const now = new Date();
    const amzDate = amzTimestamp(now);
    const dateStamp = amzDate.slice(0, 8);
    const host = new URL(this.config.endpoint).host;
    const path = `/${this.config.bucket}/${encodeKey(key)}`;
    const credentialScope = `${dateStamp}/${this.config.region}/${service}/aws4_request`;
    const canonicalRequest = [
      method,
      path,
      '',
      `host:${host}\nx-amz-content-sha256:${emptyPayloadHash}\nx-amz-date:${amzDate}\n`,
      'host;x-amz-content-sha256;x-amz-date',
      emptyPayloadHash,
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256(canonicalRequest),
    ].join('\n');
    const signature = hmac(
      signingKey(this.config.secretKey, dateStamp, this.config.region),
      stringToSign,
    );
    return {
      Authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${credentialScope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
      'x-amz-content-sha256': emptyPayloadHash,
      'x-amz-date': amzDate,
    };
  }
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function canonicalSearch(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function amzTimestamp(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const kDate = createHmac('sha256', `AWS4${secret}`).update(date).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  return createHmac('sha256', kService).update('aws4_request').digest();
}

function safeFileName(value: string): string {
  return value.replaceAll(/["\r\n]/g, '_');
}
