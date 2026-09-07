import type { AppConfig, NodeEnvironment } from './config.types';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function integer(name: string, fallback: number, minimum = 0): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`Invalid integer environment variable ${name}: ${raw}`);
  }
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`Invalid boolean environment variable ${name}: ${raw}`);
}

function environment(): NodeEnvironment {
  const value = (process.env.NODE_ENV ?? 'development') as NodeEnvironment;
  if (!['development', 'test', 'production'].includes(value)) {
    throw new Error(`Invalid NODE_ENV: ${value}`);
  }
  return value;
}

function csv(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  const env = environment();
  const maxSupportMinutes = integer('SUPPORT_SESSION_MAX_MINUTES', 60, 1);
  const defaultSupportMinutes = integer('SUPPORT_SESSION_DEFAULT_MINUTES', 30, 1);

  if (defaultSupportMinutes > maxSupportMinutes) {
    throw new Error('SUPPORT_SESSION_DEFAULT_MINUTES cannot exceed SUPPORT_SESSION_MAX_MINUTES');
  }

  const allowedOrigins = csv('WEB_ALLOWED_ORIGINS');
  if (env === 'production' && allowedOrigins.length === 0) {
    throw new Error('WEB_ALLOWED_ORIGINS is required in production');
  }

  return {
    env,
    app: {
      host: process.env.APP_HOST?.trim() || '0.0.0.0',
      port: integer('APP_PORT', 3000, 1),
      docsEnabled: boolean('DOCS_ENABLED', env !== 'production'),
      trustProxy: boolean('TRUST_PROXY', false),
      allowedOrigins,
    },
    mongo: {
      uri: required('MONGODB_URI'),
      dbName: process.env.MONGODB_DB_NAME?.trim() || 'gym_platform',
      connectTimeoutMs: integer('MONGODB_CONNECT_TIMEOUT_MS', 5_000, 500),
    },
    logging: {
      level: process.env.LOG_LEVEL?.trim() || (env === 'production' ? 'info' : 'debug'),
    },
    worker: {
      id: process.env.WORKER_ID?.trim() || `worker-${process.pid}`,
      outboxPollIntervalMs: integer('OUTBOX_POLL_INTERVAL_MS', 1_000, 100),
      outboxLockMs: integer('OUTBOX_LOCK_MS', 30_000, 1_000),
      outboxMaxAttempts: integer('OUTBOX_MAX_ATTEMPTS', 8, 1),
      jobLeaseMs: integer('JOB_LEASE_MS', 30_000, 1_000),
    },
    support: {
      defaultSessionMinutes: defaultSupportMinutes,
      maxSessionMinutes: maxSupportMinutes,
    },
  };
}
