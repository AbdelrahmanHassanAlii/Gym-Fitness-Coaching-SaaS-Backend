import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Db } from 'mongodb';
import type { AppConfig } from '../../config/config.types';
import { AppError } from '../../core/errors/app-error';
import { migrations } from '../../migrations';
import { MigrationRunner } from '../../migrations/migration-runner';
import { resetSeedNamespace } from './seed-cleanup';
import type { SeedCliOptions } from './seed-config';
import { assertSeedGuards } from './seed-guards';
import { buildSeedManifest, type SeedManifest } from './seed-manifest';

export interface SeedRunResult {
  dryRun: boolean;
  resetNamespace: boolean;
  deletedManifestCount: number;
  manifest: SeedManifest;
  emittedManifestPath: string | undefined;
}

export async function runV1Seed(input: {
  config: AppConfig;
  db: Db;
  options: SeedCliOptions;
}): Promise<SeedRunResult> {
  assertSeedGuards(input.config, input.options);
  await verifyMigrations(input.db);

  const manifest = buildSeedManifest({
    namespace: input.options.namespace,
    dataset: input.options.dataset,
    logicalSeed: input.options.logicalSeed,
  });

  validateManifest(manifest);

  let deletedManifestCount = 0;
  if (!input.options.dryRun) {
    if (input.options.resetNamespace) {
      deletedManifestCount = await resetSeedNamespace(
        input.db,
        input.options.namespace,
        input.options.dataset,
      );
    }

    await input.db.collection<SeedManifest>('seed_manifests').updateOne(
      { _id: manifest._id },
      {
        $set: {
          ...manifest,
          updatedAt: manifest.createdAt,
        },
      },
      { upsert: true },
    );
  }

  if (input.options.emitManifestPath) {
    await writeManifestFile(input.options.emitManifestPath, manifest);
  }

  return {
    dryRun: input.options.dryRun,
    resetNamespace: input.options.resetNamespace,
    deletedManifestCount,
    manifest,
    emittedManifestPath: input.options.emitManifestPath,
  };
}

async function verifyMigrations(db: Db): Promise<void> {
  const runner = new MigrationRunner(db, migrations);
  const status = await runner.status();
  const missing = status.filter((migration) => !migration.applied);
  if (missing.length) {
    throw new AppError({
      code: 'V1_SEED_MIGRATIONS_REQUIRED',
      httpStatus: 409,
      message: 'Run database migrations before V1 seeding.',
      details: { missing: missing.map((migration) => migration.id) },
    });
  }
}

function validateManifest(manifest: SeedManifest): void {
  const relationshipIds = new Set(
    Object.values(manifest.knownIds.relationships).map((id) => id.toHexString()),
  );
  const membershipIds = new Set(
    Object.values(manifest.knownIds.memberships).map((id) => id.toHexString()),
  );
  const overlap = [...relationshipIds].filter((id) => membershipIds.has(id));
  if (overlap.length) {
    throw new AppError({
      code: 'V1_SEED_MANIFEST_INVALID',
      httpStatus: 500,
      message: 'Seed manifest generated overlapping relationship and membership ids.',
      details: { overlap },
    });
  }
}

async function writeManifestFile(path: string, manifest: SeedManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
