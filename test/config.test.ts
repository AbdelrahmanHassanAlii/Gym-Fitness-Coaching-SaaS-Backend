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
});
