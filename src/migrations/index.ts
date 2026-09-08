import { migration001FoundationIndexes } from './001-foundation-indexes';
import { migration002Stage2AuthIndexes } from './002-stage2-auth-indexes';
import { migration003Stage2MfaIndexes } from './003-stage2-mfa-indexes';
import { migration004Stage3WorkspacesIndexes } from './004-stage3-workspaces-indexes';
import { migration005Stage4AccessControlIndexes } from './005-stage4-access-control-indexes';
import { migration006Stage4AccessControlCompatibilityFix } from './006-stage4-access-control-compatibility-fix';
import { migration007Stage5CommercialPermissions } from './007-stage5-commercial-permissions';
import { migration008Stage5SubscriptionsAndBillingIndexes } from './008-stage5-subscriptions-and-billing-indexes';
import { migration009Stage5ExistingWorkspaceBackfill } from './009-stage5-existing-workspace-backfill';
import { migration010Stage5WorkspaceUsageRevision } from './010-stage5-workspace-usage-revision';
import { migration011Stage6Leads } from './011-stage6-leads';
import type { Migration } from './migration.types';

export const migrations: Migration[] = [
  migration001FoundationIndexes,
  migration002Stage2AuthIndexes,
  migration003Stage2MfaIndexes,
  migration004Stage3WorkspacesIndexes,
  migration005Stage4AccessControlIndexes,
  migration006Stage4AccessControlCompatibilityFix,
  migration007Stage5CommercialPermissions,
  migration008Stage5SubscriptionsAndBillingIndexes,
  migration009Stage5ExistingWorkspaceBackfill,
  migration010Stage5WorkspaceUsageRevision,
  migration011Stage6Leads,
];
