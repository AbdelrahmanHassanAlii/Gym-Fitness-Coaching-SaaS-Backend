import { describe, expect, test } from 'bun:test';
import type { AppConfig } from '../src/config/config.types';
import { AppError } from '../src/core/errors/app-error';
import { parseSeedArgs } from '../src/seeds/v1/seed-config';
import { assertSeedGuards } from '../src/seeds/v1/seed-guards';
import { SeedIdFactory } from '../src/seeds/v1/seed-ids';
import { buildSeedManifest } from '../src/seeds/v1/seed-manifest';

describe('V1 seed tooling', () => {
  test('parses required deterministic seed options', () => {
    const options = parseSeedArgs([
      '--dataset',
      'SMALL',
      '--namespace',
      'v1-dev',
      '--allow-non-production',
      '--reset-namespace',
      '--dry-run',
      '--emit-manifest',
      '.seed-output/v1/v1-dev/SMALL/manifest.json',
      '--seed',
      'demo',
    ]);

    expect(options).toEqual({
      dataset: 'SMALL',
      namespace: 'v1-dev',
      allowNonProduction: true,
      resetNamespace: true,
      dryRun: true,
      emitManifestPath: '.seed-output/v1/v1-dev/SMALL/manifest.json',
      logicalSeed: 'demo',
    });
  });

  test('rejects unknown seed arguments', () => {
    expect(() => parseSeedArgs(['--dataset', 'SMALL', '--wat'])).toThrow(AppError);
  });

  test('generates stable ObjectIds and separates entity kinds', () => {
    const first = new SeedIdFactory('v1-dev', 'SMALL');
    const second = new SeedIdFactory('v1-dev', 'SMALL');

    expect(first.objectId('relationship', 'relationship.self.active').toHexString()).toBe(
      second.objectId('relationship', 'relationship.self.active').toHexString(),
    );
    expect(first.objectId('relationship', 'same-key').toHexString()).not.toBe(
      first.objectId('membership', 'same-key').toHexString(),
    );
  });

  test('builds deterministic manifests with stable QA aliases', () => {
    const first = buildSeedManifest({
      namespace: 'v1-dev',
      dataset: 'REALISTIC',
      logicalSeed: undefined,
    });
    const second = buildSeedManifest({
      namespace: 'v1-dev',
      dataset: 'REALISTIC',
      logicalSeed: undefined,
    });

    expect(first._id.toHexString()).toBe(second._id.toHexString());
    expect(first.knownLogins.find((login) => login.alias === 'workspace.owner_active')?.email).toBe(
      'owner.active@seed.v1-dev.local',
    );
    expect(first.qaScenarios['QA-019']?.fixtureAliases).toContain('pagination.progress_500_plus');
    expect(first.knownIds.relationships['relationship.self.active']?.toHexString()).not.toBe(
      first.knownIds.memberships['trainee.self_active']?.toHexString(),
    );
  });

  test('fails closed for production and non-allowlisted database targets', () => {
    const config = fakeConfig({
      env: 'production',
      dbName: 'gym_platform',
      uri: 'mongodb://prod.example.com:27017',
    });

    expect(() =>
      assertSeedGuards(config, {
        dataset: 'SMALL',
        namespace: 'v1-dev',
        allowNonProduction: false,
        resetNamespace: false,
        dryRun: true,
        emitManifestPath: undefined,
        logicalSeed: undefined,
      }),
    ).toThrow(AppError);
  });

  test('allows explicit non-production local seed targets', () => {
    const config = fakeConfig({
      env: 'development',
      dbName: 'gym_seed_local',
      uri: 'mongodb://localhost:27017',
    });

    expect(() =>
      assertSeedGuards(config, {
        dataset: 'SMALL',
        namespace: 'v1-dev',
        allowNonProduction: true,
        resetNamespace: true,
        dryRun: true,
        emitManifestPath: undefined,
        logicalSeed: undefined,
      }),
    ).not.toThrow();
  });
});

function fakeConfig(input: { env: AppConfig['env']; dbName: string; uri: string }): AppConfig {
  return {
    env: input.env,
    app: {
      host: '0.0.0.0',
      port: 3000,
      docsEnabled: true,
      trustProxy: false,
      allowedOrigins: [],
    },
    mongo: {
      uri: input.uri,
      dbName: input.dbName,
      connectTimeoutMs: 500,
    },
    logging: {
      level: 'debug',
    },
    auth: {
      jwtActiveKeyId: 'local',
      jwtPrivateKey: 'unused',
      jwtPublicKeys: {},
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2592000,
      webRefreshCookieSameSite: 'LAX',
      otpHmacSecret: 'unused',
      totpEncryptionKey: 'unused',
      loginIdentifierIpWindowMs: 1,
      loginIdentifierIpMaxAttempts: 1,
      loginIdentifierIpBlockMs: 1,
      loginIpWindowMs: 1,
      loginIpMaxAttempts: 1,
      challengeTtlSeconds: 1,
      challengeMaxAttempts: 1,
      challengeResendCooldownSeconds: 1,
      challengeMaxSendsPerHour: 1,
      mfaChallengeTtlSeconds: 1,
      mfaChallengeMaxAttempts: 1,
      recoveryCodeCount: 1,
      passwordResetIdentifierMaxPerHour: 1,
      passwordResetIpMaxPerHour: 1,
    },
    worker: {
      id: 'test',
      outboxPollIntervalMs: 1,
      outboxLockMs: 1,
      outboxMaxAttempts: 1,
      jobLeaseMs: 1,
    },
    subscriptions: {
      trialExpiryAction: 'FROZEN',
      paidGraceDays: 0,
      frozenToExpiredDays: 30,
    },
    support: {
      defaultSessionMinutes: 30,
      maxSessionMinutes: 60,
    },
  };
}
