import { AppError } from '../../core/errors/app-error';

export const seedDatasets = ['SMALL', 'REALISTIC', 'STRESS'] as const;
export type SeedDataset = (typeof seedDatasets)[number];

export interface SeedCliOptions {
  dataset: SeedDataset;
  namespace: string;
  allowNonProduction: boolean;
  resetNamespace: boolean;
  dryRun: boolean;
  emitManifestPath: string | undefined;
  logicalSeed: string | undefined;
}

const booleanFlags = new Set(['allow-non-production', 'reset-namespace', 'dry-run']);
const valueFlags = new Set(['dataset', 'namespace', 'emit-manifest', 'seed']);

export function parseSeedArgs(argv: string[]): SeedCliOptions {
  const parsed = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item?.startsWith('--')) {
      throw invalidArg(`Unexpected argument: ${item ?? ''}`);
    }

    const key = item.slice(2);
    if (booleanFlags.has(key)) {
      parsed.set(key, true);
      continue;
    }

    if (!valueFlags.has(key)) {
      throw invalidArg(`Unknown option: --${key}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw invalidArg(`Missing value for --${key}.`);
    }
    parsed.set(key, value);
    index += 1;
  }

  const dataset = datasetValue(parsed.get('dataset'));
  const namespace = stringValue(parsed.get('namespace'), 'namespace');

  return {
    dataset,
    namespace,
    allowNonProduction: parsed.get('allow-non-production') === true,
    resetNamespace: parsed.get('reset-namespace') === true,
    dryRun: parsed.get('dry-run') === true,
    emitManifestPath: optionalStringValue(parsed.get('emit-manifest'), 'emit-manifest'),
    logicalSeed: optionalStringValue(parsed.get('seed'), 'seed'),
  };
}

function datasetValue(value: string | true | undefined): SeedDataset {
  if (typeof value !== 'string') {
    throw invalidArg('Supply --dataset SMALL|REALISTIC|STRESS.');
  }
  const normalized = value.toUpperCase();
  if (!seedDatasets.includes(normalized as SeedDataset)) {
    throw invalidArg('Dataset must be SMALL, REALISTIC, or STRESS.');
  }
  return normalized as SeedDataset;
}

function stringValue(value: string | true | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidArg(`Supply --${name}.`);
  }
  return value.trim();
}

function optionalStringValue(value: string | true | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, name);
}

function invalidArg(message: string): AppError {
  return new AppError({
    code: 'V1_SEED_ARG_INVALID',
    httpStatus: 422,
    message,
  });
}
