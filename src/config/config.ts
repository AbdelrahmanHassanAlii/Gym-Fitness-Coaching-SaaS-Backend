import { createPrivateKey, createPublicKey } from 'node:crypto';
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

function seconds(name: string, fallback: number, minimum = 1): number {
  return integer(name, fallback, minimum);
}

function minutesToMs(minutes: number): number {
  return minutes * 60 * 1000;
}

function optionalMultilineSecret(name: string, fallback: string): string {
  return (process.env[name]?.trim() || fallback).replaceAll('\\n', '\n');
}

function jwtPrivateKey(env: NodeEnvironment): string {
  const privateKey = optionalMultilineSecret(
    'JWT_PRIVATE_KEY',
    env === 'production' ? required('JWT_PRIVATE_KEY') : developmentEd25519PrivateKey(),
  );
  createPrivateKey(privateKey);
  return privateKey;
}

function jwtPublicKeys(env: NodeEnvironment): Record<string, string> {
  const raw = process.env.JWT_PUBLIC_KEYS?.trim();
  if (!raw) {
    if (env === 'production') {
      throw new Error('Missing required environment variable: JWT_PUBLIC_KEYS');
    }
    return { local: developmentEd25519PublicKey() };
  }

  const parsed = JSON.parse(raw) as Record<string, string>;
  const keys = Object.fromEntries(
    Object.entries(parsed).map(([kid, key]) => [kid, key.replaceAll('\\n', '\n')]),
  );
  for (const key of Object.values(keys)) {
    createPublicKey(key);
  }
  return keys;
}

function developmentEd25519PrivateKey(): string {
  return [
    '-----BEGIN PRIVATE KEY-----',
    'MC4CAQAwBQYDK2VwBCIEIP27WzZ2lrwob/CusOSRmtVPlS0TPTrBOFjTuBztUPm8',
    '-----END PRIVATE KEY-----',
  ].join('\n');
}

function developmentEd25519PublicKey(): string {
  return [
    '-----BEGIN PUBLIC KEY-----',
    'MCowBQYDK2VwAyEAVk4E+7jo4OHXHcYC1lvT+vqaViaFNdUPnMcuSDPpp60=',
    '-----END PUBLIC KEY-----',
  ].join('\n');
}

function developmentTotpKey(): string {
  return 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
}

function secret(name: string, env: NodeEnvironment, developmentFallback: string): string {
  if (env === 'production') return required(name);
  return process.env[name]?.trim() || developmentFallback;
}

function jwtActiveKeyId(env: NodeEnvironment): string {
  const keyId = process.env.JWT_ACTIVE_KEY_ID?.trim();
  if (env === 'production' && !keyId) {
    throw new Error('Missing required environment variable: JWT_ACTIVE_KEY_ID');
  }
  return keyId || 'local';
}

function base64Secret(name: string, value: string, byteLength: number): string {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== byteLength) {
    throw new Error(`${name} must be a base64-encoded ${byteLength}-byte secret`);
  }
  return value;
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

  const totpEncryptionKey = base64Secret(
    'TOTP_ENCRYPTION_KEY',
    secret('TOTP_ENCRYPTION_KEY', env, developmentTotpKey()),
    32,
  );
  const activeJwtKeyId = jwtActiveKeyId(env);
  const privateJwtKey = jwtPrivateKey(env);
  const publicJwtKeys = jwtPublicKeys(env);
  if (!publicJwtKeys[activeJwtKeyId]) {
    throw new Error('JWT_PUBLIC_KEYS must include JWT_ACTIVE_KEY_ID');
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
    auth: {
      jwtActiveKeyId: activeJwtKeyId,
      jwtPrivateKey: privateJwtKey,
      jwtPublicKeys: publicJwtKeys,
      accessTokenTtlSeconds: seconds('ACCESS_TOKEN_TTL_SECONDS', 15 * 60),
      refreshTokenTtlSeconds: seconds('REFRESH_TOKEN_TTL_SECONDS', 30 * 24 * 60 * 60),
      otpHmacSecret: secret('OTP_HMAC_SECRET', env, 'local-dev-otp-hmac-secret'),
      totpEncryptionKey,
      loginIdentifierIpWindowMs: minutesToMs(
        integer('AUTH_LOGIN_IDENTIFIER_IP_WINDOW_MINUTES', 15, 1),
      ),
      loginIdentifierIpMaxAttempts: integer('AUTH_LOGIN_IDENTIFIER_IP_MAX_ATTEMPTS', 5, 1),
      loginIdentifierIpBlockMs: minutesToMs(
        integer('AUTH_LOGIN_IDENTIFIER_IP_BLOCK_MINUTES', 15, 1),
      ),
      loginIpWindowMs: minutesToMs(integer('AUTH_LOGIN_IP_WINDOW_MINUTES', 15, 1)),
      loginIpMaxAttempts: integer('AUTH_LOGIN_IP_MAX_ATTEMPTS', 30, 1),
      challengeTtlSeconds: seconds('AUTH_CHALLENGE_TTL_SECONDS', 10 * 60),
      challengeMaxAttempts: integer('AUTH_CHALLENGE_MAX_ATTEMPTS', 5, 1),
      challengeResendCooldownSeconds: seconds('AUTH_CHALLENGE_RESEND_COOLDOWN_SECONDS', 60),
      challengeMaxSendsPerHour: integer('AUTH_CHALLENGE_MAX_SENDS_PER_HOUR', 5, 1),
      passwordResetIdentifierMaxPerHour: integer(
        'AUTH_PASSWORD_RESET_IDENTIFIER_MAX_PER_HOUR',
        3,
        1,
      ),
      passwordResetIpMaxPerHour: integer('AUTH_PASSWORD_RESET_IP_MAX_PER_HOUR', 10, 1),
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
