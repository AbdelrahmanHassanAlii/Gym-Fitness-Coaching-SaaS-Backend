import type { AppConfig } from '../../config/config.types';
import { AppError } from '../../core/errors/app-error';
import type { SeedCliOptions } from './seed-config';

const namespacePattern = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const defaultDbPrefixes = ['gym_seed_', 'gym_dev_', 'gym_qa_', 'gym_test_'];
const defaultUriHosts = ['localhost', '127.0.0.1', 'host.docker.internal', 'mongo', 'mongodb'];
const deniedDbNames = new Set(['gym_platform', 'production', 'prod', 'main']);

export function assertSeedGuards(config: AppConfig, options: SeedCliOptions): void {
  const failures: string[] = [];

  if (config.env === 'production') failures.push('config.env is production');
  if (process.env.NODE_ENV === 'production') failures.push('NODE_ENV is production');
  if (!options.allowNonProduction) failures.push('missing --allow-non-production');
  if (!namespacePattern.test(options.namespace))
    failures.push('namespace does not match safe pattern');
  if (!isDatabaseAllowed(config.mongo.dbName)) {
    failures.push(`database ${config.mongo.dbName} is not seed/dev/qa/test allowlisted`);
  }
  if (!isUriAllowed(config.mongo.uri)) {
    failures.push('MongoDB URI host is not allowlisted for seed execution');
  }

  if (failures.length) {
    throw new AppError({
      code: 'V1_SEED_GUARD_FAILED',
      httpStatus: 403,
      message: 'V1 seed execution failed non-production safety guards.',
      details: { failures },
    });
  }
}

function isDatabaseAllowed(dbName: string): boolean {
  const normalized = dbName.trim().toLowerCase();
  if (deniedDbNames.has(normalized)) return false;
  const explicit = csvEnv('SEED_DATABASE_ALLOWLIST');
  if (explicit.includes(dbName)) return true;
  return defaultDbPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function isUriAllowed(uri: string): boolean {
  const explicit = csvEnv('SEED_URI_ALLOWLIST');
  const hosts = mongoHosts(uri);
  if (hosts.length === 0) return false;
  return hosts.every((host) => defaultUriHosts.includes(host) || explicit.includes(host));
}

function mongoHosts(uri: string): string[] {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'mongodb+srv:') {
      return [parsed.hostname.toLowerCase()];
    }
    if (parsed.protocol !== 'mongodb:') return [];
    return parsed.host
      .split(',')
      .map((host) => host.split(':')[0]?.toLowerCase())
      .filter((host): host is string => Boolean(host));
  } catch {
    return [];
  }
}

function csvEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}
