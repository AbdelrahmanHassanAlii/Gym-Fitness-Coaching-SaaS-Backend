import type { Db } from 'mongodb';
import type { SeedDataset } from './seed-config';

export async function resetSeedNamespace(
  db: Db,
  namespace: string,
  dataset: SeedDataset,
): Promise<number> {
  const result = await db.collection('seed_manifests').deleteMany({ namespace, dataset });
  return result.deletedCount;
}
