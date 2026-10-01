import { describe, expect, test } from 'bun:test';
import type { AppConfig } from '../src/config/config.types';
import { AppError } from '../src/core/errors/app-error';
import { buildV1BusinessSeedPlan } from '../src/seeds/v1/business-seed';
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
      allowStress: false,
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
        allowStress: false,
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
        allowStress: false,
        emitManifestPath: undefined,
        logicalSeed: undefined,
      }),
    ).not.toThrow();
  });

  test('requires explicit stress opt-in even for safe local targets', () => {
    const config = fakeConfig({
      env: 'development',
      dbName: 'gym_seed_local',
      uri: 'mongodb://localhost:27017',
    });

    expect(() =>
      assertSeedGuards(config, {
        dataset: 'STRESS',
        namespace: 'v1-dev',
        allowNonProduction: true,
        resetNamespace: true,
        dryRun: true,
        allowStress: false,
        emitManifestPath: undefined,
        logicalSeed: undefined,
      }),
    ).toThrow(AppError);
  });

  test('builds real SMALL business fixtures for core QA aliases', async () => {
    const manifest = buildSeedManifest({
      namespace: 'v1-dev',
      dataset: 'SMALL',
      logicalSeed: undefined,
    });
    const plan = await buildV1BusinessSeedPlan(manifest);

    expect(plan.fixtureAliases['permission.explicit_deny_over_allow']?.status).toBe('READY');
    expect(plan.fixtureAliases['permission.scoped_deny_inside_allow']?.status).toBe('READY');
    expect(plan.fixtureAliases['staff.inactive_membership']?.status).toBe('READY');
    expect(plan.fixtureAliases['pagination.progress_500_plus']?.status).toBe('READY');
    expect(plan.fixtureAliases['support.session.sensitive_denied']?.status).toBe('READY');
    expect(plan.fixtureAliases['idempotency.replay_target']?.status).toBe('READY');
    expect(plan.fixtureAliases['file.upload.checksum_mismatch_fixture']?.status).toBe(
      'PROVIDER_DEPENDENT',
    );
    expect(plan.qaScenarios['QA-001']?.status).toBe('READY');
    expect(plan.qaScenarios['QA-019']?.status).toBe('READY');
    expect(plan.qaScenarios['QA-023']?.status).toBe('READY');
  });

  test('progress pagination fixture targets one relationship with more than 500 measurements', async () => {
    const manifest = buildSeedManifest({
      namespace: 'v1-dev',
      dataset: 'SMALL',
      logicalSeed: undefined,
    });
    const plan = await buildV1BusinessSeedPlan(manifest);
    const relationshipId =
      manifest.knownIds.relationships['relationship.pagination.progress_500_plus'];
    const measurements = plan.collections.measurement_entries ?? [];

    expect(
      measurements.filter(
        (measurement) => String(measurement.relationshipId) === String(relationshipId),
      ).length,
    ).toBeGreaterThan(500);
    expect(plan.fixtureAliases['progress.measurement.pagination_anchor_500']?.records[0]?.id).toBe(
      plan.collections.measurement_entries?.[500]?._id,
    );
  });

  test('support-sensitive denial fixture has active parent auth and no sensitive grants', async () => {
    const manifest = buildSeedManifest({
      namespace: 'v1-dev',
      dataset: 'SMALL',
      logicalSeed: undefined,
    });
    const plan = await buildV1BusinessSeedPlan(manifest);
    const deniedId = manifest.knownIds.support['support.session.sensitive_denied'];
    const session = plan.collections.support_sessions?.find((item) => item._id.equals(deniedId));
    const parentSession = plan.collections.auth_sessions?.find(
      (item) => String(item._id) === String(session?.parentAuthSessionId),
    );

    expect(session?.allowSensitiveData).toBe(false);
    expect(session?.allowSensitiveFileDownload).toBe(false);
    expect(parentSession?.status).toBe('ACTIVE');
  });

  test('seed ownership records cover generated business documents', async () => {
    const manifest = buildSeedManifest({
      namespace: 'v1-dev',
      dataset: 'SMALL',
      logicalSeed: undefined,
    });
    const plan = await buildV1BusinessSeedPlan(manifest);

    expect(plan.collections.seed_owned_records?.length).toBeGreaterThan(0);
    expect(
      plan.collections.seed_owned_records?.some(
        (record) =>
          record.collection === 'workspace_memberships' && record.alias === 'staff.explicit_deny',
      ),
    ).toBe(true);
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
