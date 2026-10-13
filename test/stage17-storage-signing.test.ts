import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { FakeStorageProvider } from '../src/core/storage/fake-storage.provider';
import { S3CompatibleStorageProvider } from '../src/core/storage/s3-storage.provider';
import { DownloadUrlExpiredError } from '../src/core/storage/storage.provider';

const config = {
  endpoint: 'https://storage.example.test',
  region: 'us-east-1',
  bucket: 'private',
  accessKey: 'TEST',
  secretKey: 'test-secret',
};
const now = new Date('2026-10-13T10:00:00.500Z');
const input = {
  key: 'workspace/export.zip',
  fileName: 'export.zip',
  contentType: 'application/zip',
  cacheControl: 'private, no-store',
  expiresAtIsHardDeadline: true as const,
};

describe('Stage 17 export storage signing', () => {
  test.each([120_000, 35_250, 1_000])(
    'hard deadline with %i milliseconds remaining',
    async (remaining) => {
      const provider = new S3CompatibleStorageProvider(config, () => now);
      const deadline = new Date(now.getTime() + remaining);
      const result = await provider.createDownloadUrl({ ...input, expiresAt: deadline });
      const query = new URL(result.url).searchParams;
      const seconds = Number(query.get('X-Amz-Expires'));
      expect(seconds).toBe(Math.floor(remaining / 1000));
      expect(result.expiresAt.getTime()).toBe(Date.parse('2026-10-13T10:00:00Z') + seconds * 1000);
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(deadline.getTime());
      expect(query.get('response-content-disposition')).toBe('attachment; filename="export.zip"');
      expect(query.get('response-content-type')).toBe('application/zip');
      expect(query.get('response-cache-control')).toBe('private, no-store');

      // Independently recompute SigV4: the cache override must be part of the signed query.
      const signature = query.get('X-Amz-Signature');
      query.delete('X-Amz-Signature');
      const canonicalQuery = [...query.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      const canonical = [
        'GET',
        '/private/workspace/export.zip',
        canonicalQuery,
        'host:storage.example.test\n',
        'host',
        'UNSIGNED-PAYLOAD',
      ].join('\n');
      const scope = '20261013/us-east-1/s3/aws4_request';
      const toSign = [
        'AWS4-HMAC-SHA256',
        '20261013T100000Z',
        scope,
        createHash('sha256').update(canonical).digest('hex'),
      ].join('\n');
      let key = createHmac('sha256', `AWS4${config.secretKey}`).update('20261013').digest();
      for (const value of ['us-east-1', 's3', 'aws4_request'])
        key = createHmac('sha256', key).update(value).digest();
      expect(signature).toBe(createHmac('sha256', key).update(toSign).digest('hex'));
    },
  );

  test.each([0, -1, 1, 499, 999])('does not round %i milliseconds upward', async (remaining) => {
    const provider = new S3CompatibleStorageProvider(config, () => now);
    await expect(
      provider.createDownloadUrl({ ...input, expiresAt: new Date(now.getTime() + remaining) }),
    ).rejects.toBeInstanceOf(DownloadUrlExpiredError);
  });

  test('rechecks elapsed time at signing and returns actual expiry', async () => {
    let clock = now;
    const provider = new S3CompatibleStorageProvider(config, () => clock);
    const deadline = new Date(now.getTime() + 30_000);
    clock = new Date(now.getTime() + 25_000);
    const result = await provider.createDownloadUrl({ ...input, expiresAt: deadline });
    expect(new URL(result.url).searchParams.get('X-Amz-Expires')).toBe('5');
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(deadline.getTime());
    clock = deadline;
    await expect(
      provider.createDownloadUrl({ ...input, expiresAt: deadline }),
    ).rejects.toBeInstanceOf(DownloadUrlExpiredError);
  });

  test('optional settings do not alter legacy download signing', async () => {
    const provider = new S3CompatibleStorageProvider(config);
    const expiresAt = new Date(0);
    const result = await provider.createDownloadUrl({
      key: input.key,
      fileName: input.fileName,
      contentType: 'application/pdf',
      expiresAt,
    });
    expect(result.expiresAt).toBe(expiresAt);
    expect(new URL(result.url).searchParams.get('X-Amz-Expires')).toBe('1');
    expect(new URL(result.url).searchParams.has('response-cache-control')).toBe(false);
  });

  test('fake provider captures export options and enforces deadline', async () => {
    const fake = new FakeStorageProvider(() => now);
    const request = { ...input, expiresAt: new Date(now.getTime() + 20_000) };
    const result = await fake.createDownloadUrl(request);
    expect(fake.downloadRequests).toEqual([request]);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(request.expiresAt.getTime());
    await expect(fake.createDownloadUrl({ ...request, expiresAt: now })).rejects.toBeInstanceOf(
      DownloadUrlExpiredError,
    );
    expect(fake.downloadRequests).toHaveLength(1);
  });
});
