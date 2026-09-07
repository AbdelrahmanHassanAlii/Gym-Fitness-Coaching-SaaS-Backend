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
});
