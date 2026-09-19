import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
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
    const headers = {
      'content-length': String(input.sizeBytes),
      'content-type': input.contentType,
      'if-none-match': '*',
      ...(input.checksumSha256 ? { 'x-amz-checksum-sha256': input.checksumSha256 } : {}),
    };
    return {
      url: this.presign('PUT', input.key, input.expiresAt, headers),
      expiresAt: input.expiresAt,
      headers,
    };
  }

  async statObject(key: string): Promise<ObjectMetadata | null> {
    const response = await fetch(this.objectUrl(key), {
      method: 'HEAD',
      headers: this.signedHeaders('HEAD', key),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Object storage HEAD failed with status ${response.status}`);
    const size = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error('Object storage HEAD returned an invalid content length');
    }
    const contentType = response.headers.get('content-type');
    const checksumSha256 = response.headers.get('x-amz-checksum-sha256');
    const eTag = response.headers.get('etag');
    return {
      key,
      sizeBytes: size,
      ...(contentType ? { contentType } : {}),
      ...(checksumSha256 ? { checksumSha256 } : {}),
      ...(eTag ? { eTag } : {}),
    };
  }

  async putObject(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    checksumSha256?: string;
  }): Promise<ObjectMetadata> {
    const response = await fetch(this.objectUrl(input.key), {
      method: 'PUT',
      headers: this.signedHeaders('PUT', input.key, {
        'content-length': String(input.body.byteLength),
        'content-type': input.contentType,
        'if-none-match': '*',
        ...(input.checksumSha256 ? { 'x-amz-checksum-sha256': input.checksumSha256 } : {}),
      }),
      body: input.body,
    });
    if (!response.ok) throw new Error(`Object storage PUT failed with status ${response.status}`);
    const eTag = response.headers.get('etag');
    return {
      key: input.key,
      sizeBytes: input.body.byteLength,
      contentType: input.contentType,
      ...(input.checksumSha256 ? { checksumSha256: input.checksumSha256 } : {}),
      ...(eTag ? { eTag } : {}),
    };
  }

  async putObjectFromFile(input: {
    key: string;
    path: string;
    contentType: string;
    sizeBytes: number;
    checksumSha256?: string;
  }): Promise<ObjectMetadata> {
    const response = await fetch(this.objectUrl(input.key), {
      method: 'PUT',
      headers: this.signedHeaders('PUT', input.key, {
        'content-length': String(input.sizeBytes),
        'content-type': input.contentType,
        'if-none-match': '*',
        ...(input.checksumSha256 ? { 'x-amz-checksum-sha256': input.checksumSha256 } : {}),
      }),
      body: Readable.toWeb(createReadStream(input.path)) as never,
    });
    if (!response.ok) throw new Error(`Object storage PUT failed with status ${response.status}`);
    const eTag = response.headers.get('etag');
    return {
      key: input.key,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      ...(input.checksumSha256 ? { checksumSha256: input.checksumSha256 } : {}),
      ...(eTag ? { eTag } : {}),
    };
  }

  async createDownloadUrl(input: CreateDownloadUrlInput): Promise<PresignedUrl> {
    return {
      url: this.presign(
        'GET',
        input.key,
        input.expiresAt,
        {},
        {
          'response-content-disposition': `attachment; filename="${safeFileName(input.fileName)}"`,
          'response-content-type': input.contentType,
        },
      ),
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
    signedRequestHeaders: Record<string, string>,
    queryParams: Record<string, string> = {},
  ): string {
    const now = new Date();
    const amzDate = amzTimestamp(now);
    const dateStamp = amzDate.slice(0, 8);
    const expires = Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
    const credentialScope = `${dateStamp}/${this.config.region}/${service}/aws4_request`;
    const host = new URL(this.config.endpoint).host;
    const path = `/${this.config.bucket}/${encodeKey(key)}`;
    const normalizedHeaders = normalizeHeaders({ host, ...signedRequestHeaders });
    const signedHeaders = Object.keys(normalizedHeaders).sort().join(';');
    const query = new URLSearchParams({
      ...queryParams,
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKey}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expires),
      'X-Amz-SignedHeaders': signedHeaders,
    });
    const canonicalQuery = canonicalSearch(query);
    const canonicalRequest = [
      method,
      path,
      canonicalQuery,
      canonicalHeaders(normalizedHeaders),
      signedHeaders,
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

  private signedHeaders(
    method: 'DELETE' | 'HEAD' | 'PUT',
    key: string,
    extraHeaders: Record<string, string> = {},
  ): Record<string, string> {
    const now = new Date();
    const amzDate = amzTimestamp(now);
    const dateStamp = amzDate.slice(0, 8);
    const host = new URL(this.config.endpoint).host;
    const path = `/${this.config.bucket}/${encodeKey(key)}`;
    const credentialScope = `${dateStamp}/${this.config.region}/${service}/aws4_request`;
    const headers = normalizeHeaders({
      host,
      'x-amz-content-sha256': emptyPayloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    });
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalRequest = [
      method,
      path,
      '',
      canonicalHeaders(headers),
      signedHeaders,
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
      Authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
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

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value.trim()]),
  );
}

function canonicalHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}\n`)
    .join('');
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
