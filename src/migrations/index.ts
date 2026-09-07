import { migration001FoundationIndexes } from './001-foundation-indexes';
import type { Migration } from './migration.types';

export const migrations: Migration[] = [migration001FoundationIndexes];
