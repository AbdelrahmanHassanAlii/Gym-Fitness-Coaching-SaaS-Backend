import { migration001FoundationIndexes } from './001-foundation-indexes';
import { migration002Stage2AuthIndexes } from './002-stage2-auth-indexes';
import { migration003Stage2MfaIndexes } from './003-stage2-mfa-indexes';
import { migration004Stage3WorkspacesIndexes } from './004-stage3-workspaces-indexes';
import { migration005Stage4AccessControlIndexes } from './005-stage4-access-control-indexes';
import type { Migration } from './migration.types';

export const migrations: Migration[] = [
  migration001FoundationIndexes,
  migration002Stage2AuthIndexes,
  migration003Stage2MfaIndexes,
  migration004Stage3WorkspacesIndexes,
  migration005Stage4AccessControlIndexes,
];
