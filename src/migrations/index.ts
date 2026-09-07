import { migration001FoundationIndexes } from './001-foundation-indexes';
import { migration002Stage2AuthIndexes } from './002-stage2-auth-indexes';
import type { Migration } from './migration.types';

export const migrations: Migration[] = [
  migration001FoundationIndexes,
  migration002Stage2AuthIndexes,
];
