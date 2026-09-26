import type { ObjectId } from 'mongodb';
import { seedNow, seedWorkspaceTimezone } from './seed-clock';
import type { SeedDataset } from './seed-config';
import { SeedIdFactory } from './seed-ids';
import { seedPassword } from './seed-passwords';

export const lockedStage18Baseline = 'd2fb55b2f9b7a7775e0b9072835aed9e4b2831f3';
export const seedVersion = 'v1';

export interface SeedManifest {
  _id: ObjectId;
  namespace: string;
  dataset: SeedDataset;
  seedVersion: typeof seedVersion;
  lockedBaseline: typeof lockedStage18Baseline;
  status: 'READY';
  createdAt: Date;
  logicalSeed: string;
  workspaceTimezone: string;
  password: {
    sharedPassword: typeof seedPassword;
    note: string;
  };
  targetCounts: Record<string, number>;
  actualCounts: Record<string, number>;
  knownLogins: Array<{
    alias: string;
    email: string;
    role: string;
  }>;
  knownIds: {
    workspaces: Record<string, ObjectId>;
    branches: Record<string, ObjectId>;
    memberships: Record<string, ObjectId>;
    relationships: Record<string, ObjectId>;
    scenarios: Record<string, ObjectId>;
    pagination: Record<string, ObjectId>;
    support: Record<string, ObjectId>;
    notifications: Record<string, ObjectId>;
    files: Record<string, ObjectId>;
    exports: Record<string, ObjectId>;
    versions: Record<string, number>;
  };
  qaScenarios: Record<
    string,
    {
      fixtureAliases: string[];
      status: 'MANIFEST_READY';
    }
  >;
  warnings: string[];
}

const targetCountsByDataset: Record<SeedDataset, Record<string, number>> = {
  SMALL: {
    workspaces: 3,
    branches: 5,
    users: 18,
    workspaceMemberships: 20,
    platformMemberships: 2,
    leads: 8,
    traineeRelationships: 24,
    programs: 10,
    workoutSessions: 60,
    personalRecordEvents: 12,
    nutritionPlans: 12,
    nutritionDailyLogs: 60,
    progressMeasurements: 100,
    progressPhotos: 12,
    checkinInstances: 40,
    filesDocuments: 15,
    notifications: 40,
    notificationDeliveries: 60,
    payments: 8,
    exports: 4,
    supportSessions: 5,
    deletionRetentionFixtures: 4,
  },
  REALISTIC: {
    workspaces: 4,
    branches: 12,
    users: 84,
    workspaceMemberships: 90,
    platformMemberships: 4,
    leads: 60,
    traineeRelationships: 220,
    programs: 100,
    workoutSessions: 1500,
    personalRecordEvents: 250,
    nutritionPlans: 160,
    nutritionDailyLogs: 1800,
    progressMeasurements: 2000,
    progressPhotos: 160,
    checkinInstances: 800,
    filesDocuments: 250,
    notifications: 1000,
    notificationDeliveries: 1500,
    payments: 80,
    exports: 20,
    supportSessions: 24,
    deletionRetentionFixtures: 16,
  },
  STRESS: {
    workspaces: 6,
    branches: 30,
    users: 360,
    workspaceMemberships: 420,
    platformMemberships: 8,
    leads: 1000,
    traineeRelationships: 2400,
    programs: 1000,
    workoutSessions: 50000,
    personalRecordEvents: 10000,
    nutritionPlans: 3000,
    nutritionDailyLogs: 75000,
    progressMeasurements: 100000,
    progressPhotos: 4000,
    checkinInstances: 25000,
    filesDocuments: 5000,
    notifications: 100000,
    notificationDeliveries: 120000,
    payments: 2000,
    exports: 250,
    supportSessions: 500,
    deletionRetentionFixtures: 200,
  },
};

const loginAliases = [
  ['platform.support_admin', 'support.admin', 'Platform support/admin actor'],
  ['workspace.owner_active', 'owner.active', 'Active workspace owner'],
  ['workspace.manager_branch_a', 'manager.branch-a', 'Manager scoped to one branch'],
  ['workspace.trainer_primary', 'trainer.primary', 'Primary trainer'],
  ['workspace.trainer_secondary', 'trainer.secondary', 'Secondary trainer'],
  ['workspace.assistant_active', 'assistant.active', 'Assistant trainer'],
  ['workspace.nutritionist_active', 'nutritionist.active', 'Nutritionist'],
  ['workspace.mixed_role', 'mixed.role', 'Mixed role staff actor'],
  ['trainee.self_active', 'trainee.self', 'Trainee SELF actor'],
  ['trainee.self_restricted', 'trainee.restricted', 'Restricted trainee actor'],
] as const;

const aliasGroups = {
  workspaces: [
    'workspace.active_main',
    'workspace.multi_branch',
    'workspace.nutrition_focus',
    'workspace.progress_heavy',
    'workspace.support_target',
    'workspace.restricted',
  ],
  branches: [
    'branch.main',
    'branch.downtown',
    'branch.women_only',
    'branch.rehab',
    'branch.nutrition_studio',
    'branch.inactive',
  ],
  memberships: [
    'owner.active',
    'manager.branch_a',
    'manager.multi_branch',
    'trainer.primary',
    'trainer.secondary',
    'assistant.active',
    'nutritionist.active',
    'staff.mixed_role',
    'staff.explicit_deny',
    'staff.inactive_membership',
    'platform.support_admin',
    'trainee.self_active',
    'trainee.self_restricted',
  ],
  relationships: [
    'relationship.active.primary_trainer',
    'relationship.active.assistant_assigned',
    'relationship.active.nutrition_only',
    'relationship.active.multi_staff',
    'relationship.active.unassigned',
    'relationship.inactive.ended',
    'relationship.branch_a',
    'relationship.branch_b_denied',
    'relationship.self.active',
    'relationship.pagination.progress_500_plus',
    'relationship.timezone.boundary',
    'relationship.file_sensitive',
    'relationship.export_subject',
  ],
  scenarios: [
    'permission.owner.workspace_allow',
    'permission.manager.branch_allow',
    'permission.trainer.relationship_allow',
    'permission.trainee.self_allow',
    'permission.explicit_deny_over_allow',
    'permission.scoped_deny_inside_allow',
    'permission.branch_assignment_removed',
    'permission.relationship_unassigned',
    'permission.inactive_membership',
    'permission.restricted_workspace',
    'commercial.quota.near_limit',
    'commercial.quota.exceeded',
    'idempotency.replay_target',
    'idempotency.mismatch_target',
    'expected_version.stale_conflict_target',
    'expected_version.valid_update_target',
  ],
  pagination: [
    'pagination.progress_500_plus',
    'pagination.notifications_1000_plus',
    'pagination.workouts_month_range',
    'pagination.checkins_status_filtered',
    'pagination.files_category_bound',
    'pagination.analytics_category_bound',
  ],
  support: [
    'support.policy.workspace_enabled',
    'support.policy.workspace_denied',
    'support.request.pending',
    'support.request.approved',
    'support.request.denied',
    'support.session.active_read_only',
    'support.session.active_user_context',
    'support.session.expired',
    'support.session.sensitive_allowed',
    'support.session.sensitive_denied',
  ],
  notifications: [
    'notification.unread.checkin_due',
    'notification.read.workout_completed',
    'notification.delivery.pending',
    'notification.delivery.sent',
    'notification.delivery.failed_retryable',
    'notification.delivery.failed_terminal',
    'notification.delivery.cancelled',
    'notification.preference.email_off',
    'notification.preference.push_on',
    'notification.device.fake_active',
  ],
  files: [
    'file.profile_photo.verified',
    'file.progress_photo.verified',
    'file.inbody_report.verified',
    'file.medical_document.sensitive',
    'file.upload.pending',
    'file.upload.reserved',
    'file.upload.checksum_mismatch_fixture',
    'file.generated.export_artifact',
    'document.trainee_contract',
    'document.retention_notice',
  ],
  exports: [
    'export.request.pending',
    'export.request.processing',
    'export.request.completed',
    'export.artifact.downloadable',
    'retention.warning.active',
    'retention.warning.expired',
    'deletion.request.scheduled',
    'deletion.request.cancelled',
    'deletion.request.completed_fixture',
  ],
} as const;

const qaScenarioAliases: Record<string, string[]> = {
  'QA-001': ['owner.active', 'workspace.active_main', 'relationship.active.primary_trainer'],
  'QA-002': ['manager.branch_a', 'permission.manager.branch_allow', 'relationship.branch_a'],
  'QA-003': ['trainer.primary', 'relationship.active.primary_trainer'],
  'QA-004': ['assistant.active', 'relationship.active.assistant_assigned'],
  'QA-005': ['nutritionist.active', 'relationship.active.nutrition_only'],
  'QA-006': ['trainee.self_active', 'relationship.self.active'],
  'QA-007': ['permission.explicit_deny_over_allow', 'staff.explicit_deny'],
  'QA-008': ['permission.scoped_deny_inside_allow', 'relationship.branch_b_denied'],
  'QA-009': ['permission.branch_assignment_removed'],
  'QA-010': ['workspace.restricted', 'permission.restricted_workspace'],
  'QA-011': ['commercial.subscription.frozen'],
  'QA-012': ['commercial.quota.near_limit', 'commercial.quota.exceeded'],
  'QA-013': ['idempotency.replay_target'],
  'QA-014': ['idempotency.mismatch_target'],
  'QA-015': ['expected_version.stale_conflict_target', 'expected_version.valid_update_target'],
  'QA-016': ['support.session.sensitive_denied', 'file.medical_document.sensitive'],
  'QA-017': ['support.session.sensitive_allowed', 'relationship.file_sensitive'],
  'QA-018': ['support.session.active_read_only'],
  'QA-019': ['pagination.progress_500_plus', 'progress.measurement.pagination_anchor_500'],
  'QA-020': ['pagination.analytics_category_bound', 'relationship.timezone.boundary'],
  'QA-021': ['file.upload.checksum_mismatch_fixture'],
  'QA-022': ['commercial.quota.exceeded', 'file.upload.reserved'],
  'QA-023': ['notification.delivery.failed_retryable', 'notification.delivery.cancelled'],
  'QA-024': ['export.request.completed', 'export.artifact.downloadable'],
  'QA-025': ['deletion.request.scheduled', 'deletion.request.cancelled'],
  'QA-026': ['retention.warning.active', 'retention.warning.expired'],
  'QA-027': ['relationship.timezone.boundary', 'pagination.analytics_category_bound'],
  'QA-028': ['permission.inactive_membership'],
  'QA-029': ['relationship.self.active'],
  'QA-030': ['support.policy.workspace_denied', 'support.session.expired'],
};

export function buildSeedManifest(input: {
  namespace: string;
  dataset: SeedDataset;
  logicalSeed: string | undefined;
}): SeedManifest {
  const ids = new SeedIdFactory(input.namespace, input.dataset);
  const logicalSeed = input.logicalSeed ?? `${input.namespace}:${input.dataset}`;
  const manifestId = ids.objectId('seed_manifest', logicalSeed);
  const knownIds = {
    workspaces: objectIdRecord(ids, 'workspace', aliasGroups.workspaces),
    branches: objectIdRecord(ids, 'branch', aliasGroups.branches),
    memberships: objectIdRecord(ids, 'membership', aliasGroups.memberships),
    relationships: objectIdRecord(ids, 'relationship', aliasGroups.relationships),
    scenarios: objectIdRecord(ids, 'scenario', aliasGroups.scenarios),
    pagination: objectIdRecord(ids, 'pagination', aliasGroups.pagination),
    support: objectIdRecord(ids, 'support', aliasGroups.support),
    notifications: objectIdRecord(ids, 'notification', aliasGroups.notifications),
    files: objectIdRecord(ids, 'file', aliasGroups.files),
    exports: objectIdRecord(ids, 'export', aliasGroups.exports),
    versions: {
      'expected_version.current': 1,
      'expected_version.stale': 0,
      'access_version.current': 1,
    },
  };

  return {
    _id: manifestId,
    namespace: input.namespace,
    dataset: input.dataset,
    seedVersion,
    lockedBaseline: lockedStage18Baseline,
    status: 'READY',
    createdAt: seedNow,
    logicalSeed,
    workspaceTimezone: seedWorkspaceTimezone,
    password: {
      sharedPassword: seedPassword,
      note: 'Non-secret seed password for local/QA users only. Hashes and tokens are not stored.',
    },
    targetCounts: targetCountsByDataset[input.dataset],
    actualCounts: { seedManifests: 1 },
    knownLogins: loginAliases.map(([alias, localPart, role]) => ({
      alias,
      email: `${localPart}@seed.${input.namespace}.local`,
      role,
    })),
    knownIds,
    qaScenarios: Object.fromEntries(
      Object.entries(qaScenarioAliases).map(([id, fixtureAliases]) => [
        id,
        { fixtureAliases, status: 'MANIFEST_READY' as const },
      ]),
    ),
    warnings: [
      'V1-DATA-03 seeds the deterministic manifest and stable fixture identifiers in seed_manifests.',
      'Business collection fixture insertion remains intentionally outside locked Stage 2-18 behavior changes.',
      'Use the manifest aliases as stable references for frontend/QA until deeper fixture builders are added.',
    ],
  };
}

function objectIdRecord(
  ids: SeedIdFactory,
  kind: string,
  aliases: readonly string[],
): Record<string, ObjectId> {
  return Object.fromEntries(aliases.map((alias) => [alias, ids.objectId(kind, alias)]));
}
