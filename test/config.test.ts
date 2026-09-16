import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config/config';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('loadConfig', () => {
  test('requires MongoDB URI', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.MONGODB_URI;
    expect(() => loadConfig()).toThrow('MONGODB_URI');
  });

  test('rejects support default longer than max', () => {
    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
    process.env.SUPPORT_SESSION_DEFAULT_MINUTES = '61';
    process.env.SUPPORT_SESSION_MAX_MINUTES = '60';
    expect(() => loadConfig()).toThrow('cannot exceed');
  });

  test('loads audit retention policy representation without enabling deletion', () => {
    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
    delete process.env.AUDIT_RETENTION_POLICY;
    expect(loadConfig().audit?.retentionPolicy).toBe('INDEFINITE');

    process.env.AUDIT_RETENTION_POLICY = 'configured_externally';
    expect(loadConfig().audit?.retentionPolicy).toBe('CONFIGURED_EXTERNALLY');

    process.env.AUDIT_RETENTION_POLICY = 'delete_after_30_days';
    expect(() => loadConfig()).toThrow('Invalid AUDIT_RETENTION_POLICY');
  });

  test('requires auth secrets in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
    process.env.WEB_ALLOWED_ORIGINS = 'https://example.com';
    process.env.JWT_ACTIVE_KEY_ID = 'local';
    process.env.JWT_PRIVATE_KEY =
      '-----BEGIN PRIVATE KEY-----\\nMC4CAQAwBQYDK2VwBCIEIP27WzZ2lrwob/CusOSRmtVPlS0TPTrBOFjTuBztUPm8\\n-----END PRIVATE KEY-----';
    process.env.JWT_PUBLIC_KEYS =
      '{"local":"-----BEGIN PUBLIC KEY-----\\\\nMCowBQYDK2VwAyEAVk4E+7jo4OHXHcYC1lvT+vqaViaFNdUPnMcuSDPpp60=\\\\n-----END PUBLIC KEY-----"}';
    process.env.TOTP_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    delete process.env.OTP_HMAC_SECRET;
    expect(() => loadConfig()).toThrow('OTP_HMAC_SECRET');
  });

  test('requires explicit storage configuration in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
    process.env.WEB_ALLOWED_ORIGINS = 'https://example.com';
    process.env.JWT_ACTIVE_KEY_ID = 'local';
    process.env.JWT_PRIVATE_KEY =
      '-----BEGIN PRIVATE KEY-----\\nMC4CAQAwBQYDK2VwBCIEIP27WzZ2lrwob/CusOSRmtVPlS0TPTrBOFjTuBztUPm8\\n-----END PRIVATE KEY-----';
    process.env.JWT_PUBLIC_KEYS =
      '{"local":"-----BEGIN PUBLIC KEY-----\\\\nMCowBQYDK2VwAyEAVk4E+7jo4OHXHcYC1lvT+vqaViaFNdUPnMcuSDPpp60=\\\\n-----END PUBLIC KEY-----"}';
    process.env.TOTP_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    process.env.OTP_HMAC_SECRET = 'otp-secret';
    delete process.env.STORAGE_ENDPOINT;
    process.env.STORAGE_REGION = 'us-east-1';
    process.env.STORAGE_BUCKET_PRIVATE = 'private';
    process.env.STORAGE_ACCESS_KEY = 'access';
    process.env.STORAGE_SECRET_KEY = 'secret';
    expect(() => loadConfig()).toThrow('STORAGE_ENDPOINT');

    process.env.STORAGE_ENDPOINT = 'https://storage.example.com';
    delete process.env.STORAGE_BUCKET_PRIVATE;
    expect(() => loadConfig()).toThrow('STORAGE_BUCKET_PRIVATE');

    process.env.STORAGE_BUCKET_PRIVATE = 'private';
    delete process.env.STORAGE_REGION;
    expect(() => loadConfig()).toThrow('STORAGE_REGION');

    process.env.STORAGE_REGION = 'us-east-1';
    delete process.env.STORAGE_SECRET_KEY;
    expect(() => loadConfig()).toThrow('STORAGE_SECRET_KEY');
  });
});
