import type { Db, ObjectId } from 'mongodb';
import { PasswordHasher } from '../../core/auth/password-hasher';
import { fingerprint } from '../../core/idempotency/idempotency.service';
import { systemPermissionProfiles } from '../../modules/permissions/permission.registry';
import { offsetDays, seedNow, seedWorkspaceTimezone } from './seed-clock';
import type { SeedDataset } from './seed-config';
import { SeedIdFactory } from './seed-ids';
import type { SeedManifest, SeedQaScenarioCoverage } from './seed-manifest';
import { seedPassword } from './seed-passwords';

type Doc = Record<string, unknown> & { _id: ObjectId };
type FixtureStatus = 'READY' | 'PROVIDER_DEPENDENT' | 'UNAVAILABLE_WITH_REASON';

export interface SeedPlan {
  collections: Record<string, Doc[]>;
  actualCounts: Record<string, number>;
  fixtureAliases: SeedManifest['fixtureAliases'];
  qaScenarios: Record<string, SeedQaScenarioCoverage>;
  ownedRecords: SeedOwnedRecord[];
}

interface SeedOwnedRecord extends Doc {
  namespace: string;
  dataset: SeedDataset;
  collection: string;
  recordId: ObjectId;
  alias?: string;
  createdAt: Date;
}

const datasetWorkspaceAliases: Record<SeedDataset, string[]> = {
  SMALL: ['workspace.active_main', 'workspace.multi_branch', 'workspace.restricted'],
  REALISTIC: [
    'workspace.active_main',
    'workspace.multi_branch',
    'workspace.nutrition_focus',
    'workspace.restricted',
  ],
  STRESS: [
    'workspace.active_main',
    'workspace.multi_branch',
    'workspace.nutrition_focus',
    'workspace.progress_heavy',
    'workspace.support_target',
    'workspace.restricted',
  ],
};

const nonExpiringFixtureDate = new Date('2099-01-01T00:00:00.000Z');

const knownUserAliases = [
  'platform.support_admin',
  'workspace.owner_active',
  'workspace.manager_branch_a',
  'workspace.trainer_primary',
  'workspace.trainer_secondary',
  'workspace.assistant_active',
  'workspace.nutritionist_active',
  'workspace.mixed_role',
  'workspace.explicit_deny',
  'workspace.inactive_membership',
  'trainee.self_active',
  'trainee.self_restricted',
] as const;

const workspaceRoleByLoginAlias: Record<string, string[]> = {
  'workspace.owner_active': ['GYM_OWNER'],
  'workspace.manager_branch_a': ['GYM_MANAGER'],
  'workspace.trainer_primary': ['TRAINER'],
  'workspace.trainer_secondary': ['TRAINER'],
  'workspace.assistant_active': ['ASSISTANT_TRAINER'],
  'workspace.nutritionist_active': ['NUTRITIONIST'],
  'workspace.mixed_role': ['GYM_MANAGER', 'TRAINER'],
  'workspace.explicit_deny': ['GYM_MANAGER'],
  'workspace.inactive_membership': ['TRAINER'],
  'trainee.self_active': ['TRAINEE'],
  'trainee.self_restricted': ['TRAINEE'],
};

const membershipAliasByLoginAlias: Record<string, string> = {
  'workspace.owner_active': 'owner.active',
  'workspace.manager_branch_a': 'manager.branch_a',
  'workspace.trainer_primary': 'trainer.primary',
  'workspace.trainer_secondary': 'trainer.secondary',
  'workspace.assistant_active': 'assistant.active',
  'workspace.nutritionist_active': 'nutritionist.active',
  'workspace.mixed_role': 'staff.mixed_role',
  'workspace.explicit_deny': 'staff.explicit_deny',
  'workspace.inactive_membership': 'staff.inactive_membership',
  'trainee.self_active': 'trainee.self_active',
  'trainee.self_restricted': 'trainee.self_restricted',
};

const branchAliases = [
  'branch.main',
  'branch.downtown',
  'branch.women_only',
  'branch.rehab',
  'branch.nutrition_studio',
  'branch.inactive',
];

export async function buildV1BusinessSeedPlan(manifest: SeedManifest): Promise<SeedPlan> {
  const ids = new SeedIdFactory(manifest.namespace, manifest.dataset);
  const passwordHash = await new PasswordHasher().hash(seedPassword);
  const count = (key: string) => manifest.targetCounts[key] ?? 0;
  const collections: Record<string, Doc[]> = {};
  const fixtureAliases: SeedManifest['fixtureAliases'] = {};
  const add = (collection: string, doc: Doc) => {
    const collectionDocs = collections[collection] ?? [];
    collectionDocs.push(doc);
    collections[collection] = collectionDocs;
    return doc;
  };
  const addAlias = (
    alias: string,
    collection: string,
    doc: Doc,
    status: FixtureStatus = 'READY',
    reason?: string,
  ) => {
    add(collection, doc);
    const existing = fixtureAliases[alias];
    const next: SeedManifest['fixtureAliases'][string] = {
      status: existing?.status === 'PROVIDER_DEPENDENT' ? existing.status : status,
      records: [...(existing?.records ?? []), { collection, id: doc._id }],
    };
    const nextReason = reason ?? existing?.reason;
    if (nextReason) next.reason = nextReason;
    fixtureAliases[alias] = next;
    return doc;
  };
  const registerAlias = (
    alias: string,
    collection: string,
    id: ObjectId,
    status: FixtureStatus = 'READY',
    reason?: string,
  ) => {
    const existing = fixtureAliases[alias];
    const next: SeedManifest['fixtureAliases'][string] = {
      status: existing?.status === 'PROVIDER_DEPENDENT' ? existing.status : status,
      records: [...(existing?.records ?? []), { collection, id }],
    };
    const nextReason = reason ?? existing?.reason;
    if (nextReason) next.reason = nextReason;
    fixtureAliases[alias] = next;
  };
  const markUnavailable = (alias: string, reason: string) => {
    fixtureAliases[alias] = { status: 'UNAVAILABLE_WITH_REASON', records: [], reason };
  };
  const id = (kind: string, key: string) => ids.objectId(kind, key);
  const roleProfileId = (workspaceId: ObjectId, roleKey: string) =>
    id('permission_profile', `${workspaceId.toHexString()}:${roleKey}`);
  const primaryWorkspaceId = mustId(activeWorkspaceId(manifest), 'workspace.active_main');
  const supportUserId = id('user', 'platform.support_admin');
  const ownerUserId = id('user', 'workspace.owner_active');
  const primaryTrainerMembershipId = mustId(
    manifest.knownIds.memberships['trainer.primary'],
    'trainer.primary',
  );
  const nutritionistMembershipId = mustId(
    manifest.knownIds.memberships['nutritionist.active'],
    'nutritionist.active',
  );
  const assistantMembershipId = mustId(
    manifest.knownIds.memberships['assistant.active'],
    'assistant.active',
  );
  const mainBranchId = mustId(manifest.knownIds.branches['branch.main'], 'branch.main');

  for (const alias of knownUserAliases) {
    const login = manifest.knownLogins.find((item) => item.alias === alias);
    if (!login) continue;
    add('users', userDoc(id('user', alias), login.email, passwordHash, alias));
  }

  const userCount = Math.max(
    count('users'),
    knownUserAliases.length + count('traineeRelationships'),
  );
  for (let index = knownUserAliases.length; index < userCount; index += 1) {
    const alias = `trainee.generated_${String(index - knownUserAliases.length + 1).padStart(4, '0')}`;
    add(
      'users',
      userDoc(id('user', alias), `${alias}@seed.${manifest.namespace}.local`, passwordHash, alias),
    );
  }

  for (let index = 0; index < count('platformMemberships'); index += 1) {
    const userId = index === 0 ? supportUserId : id('user', `platform.generated_${index}`);
    if (index > 0) {
      add(
        'users',
        userDoc(
          userId,
          `platform.generated-${index}@seed.${manifest.namespace}.local`,
          passwordHash,
          `platform.generated_${index}`,
        ),
      );
    }
    add('platform_memberships', {
      _id:
        index === 0
          ? mustId(
              manifest.knownIds.memberships['platform.support_admin'],
              'platform.support_admin',
            )
          : id('platform_membership', `generated_${index}`),
      userId,
      status: 'ACTIVE',
      permissionProfileIds: [],
      accessVersion: 1,
      createdAt: seedNow,
      updatedAt: seedNow,
    });
  }

  const workspaceAliases = datasetWorkspaceAliases[manifest.dataset];
  workspaceAliases.forEach((alias, index) => {
    const workspaceId = manifest.knownIds.workspaces[alias] ?? id('workspace', alias);
    const doc = {
      _id: workspaceId,
      type: 'GYM',
      name: `Seed ${manifest.namespace} ${alias.replace('workspace.', '').replaceAll('_', ' ')}`,
      ownerUserId,
      status: alias.includes('restricted') ? 'RESTRICTED' : 'ACTIVE',
      timezone: seedWorkspaceTimezone,
      defaultLanguage: 'en',
      country: 'EG',
      city: index % 2 === 0 ? 'Cairo' : 'Giza',
      governorate: 'Cairo',
      createdAt: offsetDays(-90 + index),
      updatedAt: seedNow,
    };
    if (manifest.knownIds.workspaces[alias]) addAlias(alias, 'workspaces', doc);
    else add('workspaces', doc);
    for (const profile of systemPermissionProfiles.filter((item) => item.context === 'WORKSPACE')) {
      add('permission_profiles', {
        _id: roleProfileId(workspaceId, profile.roleKey),
        context: 'WORKSPACE',
        workspaceId,
        roleKey: profile.roleKey,
        isSystemDefault: true,
        name: profile.name,
        permissions: profile.permissions,
        status: 'ACTIVE',
        version: 0,
        createdAt: seedNow,
        updatedAt: seedNow,
      });
    }
  });

  addBranches(add, addAlias, manifest, id, workspaceAliases);
  addKnownWorkspaceMemberships(
    add,
    addAlias,
    manifest,
    roleProfileId,
    primaryWorkspaceId,
    mainBranchId,
  );
  addGeneratedTraineeMemberships(add, manifest, id, primaryWorkspaceId, roleProfileId);
  addAccessFixtures(addAlias, registerAlias, manifest, id, primaryWorkspaceId);
  addCommercial(add, addAlias, manifest, id, workspaceAliases);
  addLeads(add, manifest, id, supportUserId, primaryWorkspaceId);

  const relationships = addRelationships(
    add,
    addAlias,
    manifest,
    id,
    primaryWorkspaceId,
    mainBranchId,
  );
  const programs = addTraining(add, manifest, id, relationships, primaryTrainerMembershipId);
  addWorkouts(add, manifest, id, relationships, programs);
  addNutrition(add, manifest, id, relationships, nutritionistMembershipId);
  addProgress(add, addAlias, manifest, id, relationships, primaryTrainerMembershipId);
  addCheckins(add, manifest, id, relationships, primaryTrainerMembershipId);
  addFiles(add, addAlias, manifest, id, relationships, primaryTrainerMembershipId);
  addNotifications(add, addAlias, manifest, id, ownerUserId);
  addSupport(
    add,
    addAlias,
    manifest,
    id,
    supportUserId,
    primaryWorkspaceId,
    primaryTrainerMembershipId,
  );
  addExportsAndRetention(add, addAlias, manifest, id, primaryWorkspaceId, ownerUserId);
  addIdempotencyFixtures(
    add,
    addAlias,
    manifest,
    id,
    ownerUserId,
    passwordHash,
    primaryWorkspaceId,
    roleProfileId,
  );
  registerAlias(
    'pagination.progress_500_plus',
    'coaching_relationships',
    mustId(
      manifest.knownIds.relationships['relationship.pagination.progress_500_plus'],
      'relationship.pagination.progress_500_plus',
    ),
  );
  registerAlias(
    'pagination.analytics_category_bound',
    'coaching_relationships',
    mustId(
      manifest.knownIds.relationships['relationship.timezone.boundary'],
      'relationship.timezone.boundary',
    ),
  );
  addAssignments(
    add,
    manifest,
    relationships,
    primaryTrainerMembershipId,
    assistantMembershipId,
    nutritionistMembershipId,
  );
  markProviderDependentFixtures(fixtureAliases);
  markUnavailableFixtures(fixtureAliases, markUnavailable);
  const qaScenarios = buildQaCoverage(manifest, fixtureAliases);
  const ownedRecords = buildOwnershipRecords(manifest, id, collections, fixtureAliases);
  collections.seed_owned_records = ownedRecords;

  return {
    collections,
    actualCounts: actualCounts(collections),
    fixtureAliases,
    qaScenarios,
    ownedRecords,
  };
}

export async function resetV1BusinessSeed(db: Db, plan: SeedPlan): Promise<number> {
  let deleted = 0;
  const ownershipScope = plan.ownedRecords[0];
  const owned = ownershipScope
    ? await db
        .collection<SeedOwnedRecord>('seed_owned_records')
        .find({ namespace: ownershipScope.namespace, dataset: ownershipScope.dataset })
        .toArray()
    : [];
  const byCollection = new Map<string, ObjectId[]>();
  for (const record of owned) {
    if (record.collection === 'seed_owned_records') continue;
    byCollection.set(record.collection, [
      ...(byCollection.get(record.collection) ?? []),
      record.recordId,
    ]);
  }
  for (const [collection, ids] of byCollection) {
    const result = await db.collection(collection).deleteMany({ _id: { $in: ids } });
    deleted += result.deletedCount;
  }
  for (const collection of Object.keys(plan.collections).reverse()) {
    if (collection === 'seed_owned_records') continue;
    const ids = plan.collections[collection]?.map((doc) => doc._id) ?? [];
    if (!ids.length) continue;
    const result = await db.collection(collection).deleteMany({ _id: { $in: ids } });
    deleted += result.deletedCount;
  }
  if (ownershipScope) {
    await db
      .collection('seed_owned_records')
      .deleteMany({ namespace: ownershipScope.namespace, dataset: ownershipScope.dataset });
  }
  return deleted;
}

export async function insertV1BusinessSeed(db: Db, plan: SeedPlan): Promise<void> {
  for (const [collection, docs] of Object.entries(plan.collections)) {
    if (!docs.length) continue;
    for (let index = 0; index < docs.length; index += 500) {
      const batch = docs.slice(index, index + 500);
      await db.collection(collection).bulkWrite(
        batch.map((doc) => ({
          replaceOne: {
            filter: { _id: doc._id },
            replacement: doc,
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
  }
}

function userDoc(_id: ObjectId, email: string, passwordHash: string, alias: string): Doc {
  const [first = 'Seed', last = 'User'] = alias.split('.').at(-1)?.split('_') ?? [];
  return {
    _id,
    email,
    normalizedEmail: email.toLowerCase(),
    passwordHash,
    passwordUpdatedAt: seedNow,
    emailVerifiedAt: seedNow,
    firstName: title(first),
    lastName: title(last),
    preferredLanguage: 'en',
    timezone: seedWorkspaceTimezone,
    status: 'ACTIVE',
    createdAt: seedNow,
    updatedAt: seedNow,
  };
}

function addBranches(
  add: (collection: string, doc: Doc) => Doc,
  addAlias: (alias: string, collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  workspaceAliases: string[],
) {
  const count = seedCount(manifest, 'branches');
  for (let index = 0; index < count; index += 1) {
    const alias = branchAliases[index] ?? `branch.generated_${index + 1}`;
    const workspaceAlias =
      workspaceAliases[Math.min(Math.floor(index / 2), workspaceAliases.length - 1)] ??
      'workspace.active_main';
    const workspaceId =
      manifest.knownIds.workspaces[workspaceAlias] ?? id('workspace', workspaceAlias);
    const doc = {
      _id: manifest.knownIds.branches[alias] ?? id('branch', alias),
      workspaceId,
      name: `Seed ${alias.replace('branch.', '').replaceAll('_', ' ')}`,
      code: `SEED-${index + 1}`,
      city: index % 2 === 0 ? 'Cairo' : 'Giza',
      governorate: 'Cairo',
      timezone: seedWorkspaceTimezone,
      status: alias.includes('inactive') ? 'ARCHIVED' : 'ACTIVE',
      createdAt: offsetDays(-80 + index),
      updatedAt: seedNow,
      ...(alias.includes('inactive') ? { archivedAt: offsetDays(-3) } : {}),
    };
    if (manifest.knownIds.branches[alias]) addAlias(alias, 'branches', doc);
    else add('branches', doc);
  }
}

function addKnownWorkspaceMemberships(
  add: (collection: string, doc: Doc) => Doc,
  addAlias: (alias: string, collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  roleProfileId: (workspaceId: ObjectId, roleKey: string) => ObjectId,
  workspaceId: ObjectId,
  branchId: ObjectId,
) {
  for (const [loginAlias, roles] of Object.entries(workspaceRoleByLoginAlias)) {
    const membershipAlias = mustValue(membershipAliasByLoginAlias[loginAlias], loginAlias);
    const membershipId = mustId(manifest.knownIds.memberships[membershipAlias], membershipAlias);
    const userId = new SeedIdFactory(manifest.namespace, manifest.dataset).objectId(
      'user',
      loginAlias,
    );
    const active = membershipAlias !== 'staff.inactive_membership';
    addAlias(membershipAlias, 'workspace_memberships', {
      _id: membershipId,
      workspaceId,
      userId,
      roles,
      status: active ? 'ACTIVE' : 'ENDED',
      joinedAt: offsetDays(-70),
      ...(active ? {} : { endedAt: offsetDays(-10) }),
      engagementPeriods: [
        { startedAt: offsetDays(-70), ...(active ? {} : { endedAt: offsetDays(-10) }) },
      ],
      permissionProfileIds: roles.map((role) => roleProfileId(workspaceId, role)),
      accessVersion: 1,
      createdAt: offsetDays(-70),
      updatedAt: seedNow,
    });
    if (active && !roles.includes('TRAINEE')) {
      add('membership_branch_assignments', {
        _id: new SeedIdFactory(manifest.namespace, manifest.dataset).objectId(
          'branch_assignment',
          membershipAlias,
        ),
        workspaceId,
        membershipId,
        branchId,
        active: true,
        startedAt: offsetDays(-70),
        createdAt: offsetDays(-70),
      });
    }
  }
}

function addGeneratedTraineeMemberships(
  add: (collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  workspaceId: ObjectId,
  roleProfileId: (workspaceId: ObjectId, roleKey: string) => ObjectId,
) {
  const existing = Object.keys(workspaceRoleByLoginAlias).length;
  const membershipCount = Math.max(
    seedCount(manifest, 'workspaceMemberships'),
    existing + seedCount(manifest, 'traineeRelationships'),
  );
  for (let index = existing; index < membershipCount; index += 1) {
    const key = `membership.generated_${index - existing + 1}`;
    const userKey = `trainee.generated_${String(index - existing + 1).padStart(4, '0')}`;
    add('workspace_memberships', {
      _id: id('membership', key),
      workspaceId,
      userId: id('user', userKey),
      roles: ['TRAINEE'],
      status: 'ACTIVE',
      joinedAt: offsetDays(-60 + (index % 30)),
      engagementPeriods: [{ startedAt: offsetDays(-60 + (index % 30)) }],
      permissionProfileIds: [roleProfileId(workspaceId, 'TRAINEE')],
      accessVersion: 1,
      createdAt: offsetDays(-60 + (index % 30)),
      updatedAt: seedNow,
    });
  }
}

function addAccessFixtures(
  addAlias: (alias: string, collection: string, doc: Doc) => Doc,
  registerAlias: (
    alias: string,
    collection: string,
    id: ObjectId,
    status?: FixtureStatus,
    reason?: string,
  ) => void,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  workspaceId: ObjectId,
) {
  const ownerMembershipId = mustId(manifest.knownIds.memberships['owner.active'], 'owner.active');
  const explicitDenyMembershipId = mustId(
    manifest.knownIds.memberships['staff.explicit_deny'],
    'staff.explicit_deny',
  );
  const mixedMembershipId = mustId(
    manifest.knownIds.memberships['staff.mixed_role'],
    'staff.mixed_role',
  );
  const managerMembershipId = mustId(
    manifest.knownIds.memberships['manager.branch_a'],
    'manager.branch_a',
  );
  const deniedRelationshipId = mustId(
    manifest.knownIds.relationships['relationship.branch_b_denied'],
    'relationship.branch_b_denied',
  );
  const branchAId = mustId(manifest.knownIds.branches['branch.main'], 'branch.main');
  const branchBId = mustId(manifest.knownIds.branches['branch.downtown'], 'branch.downtown');

  addAlias('permission.explicit_deny_over_allow', 'access_grants', {
    _id: id('access_grant', 'explicit_deny.allow'),
    context: 'WORKSPACE',
    workspaceId,
    subjectType: 'WORKSPACE_MEMBERSHIP',
    subjectId: explicitDenyMembershipId,
    permission: 'trainees.read',
    effect: 'ALLOW',
    scope: { type: 'WORKSPACE' },
    createdBy: ownerMembershipId,
    createdAt: seedNow,
  });
  addAlias('permission.explicit_deny_over_allow', 'access_grants', {
    _id: id('access_grant', 'explicit_deny.deny'),
    context: 'WORKSPACE',
    workspaceId,
    subjectType: 'WORKSPACE_MEMBERSHIP',
    subjectId: explicitDenyMembershipId,
    permission: 'trainees.read',
    effect: 'DENY',
    scope: { type: 'SPECIFIC_TRAINEES', resourceIds: [deniedRelationshipId] },
    createdBy: ownerMembershipId,
    createdAt: seedNow,
  });
  addAlias('permission.scoped_deny_inside_allow', 'access_grants', {
    _id: id('access_grant', 'scoped_deny.allow'),
    context: 'WORKSPACE',
    workspaceId,
    subjectType: 'WORKSPACE_MEMBERSHIP',
    subjectId: mixedMembershipId,
    permission: 'trainees.read',
    effect: 'ALLOW',
    scope: { type: 'WORKSPACE' },
    createdBy: ownerMembershipId,
    createdAt: seedNow,
  });
  addAlias('permission.scoped_deny_inside_allow', 'access_grants', {
    _id: id('access_grant', 'scoped_deny.deny'),
    context: 'WORKSPACE',
    workspaceId,
    subjectType: 'WORKSPACE_MEMBERSHIP',
    subjectId: mixedMembershipId,
    permission: 'trainees.read',
    effect: 'DENY',
    scope: { type: 'SPECIFIC_TRAINEES', resourceIds: [deniedRelationshipId] },
    createdBy: ownerMembershipId,
    createdAt: seedNow,
  });
  addAlias('permission.manager.branch_allow', 'access_grants', {
    _id: id('access_grant', 'manager.branch_allow'),
    context: 'WORKSPACE',
    workspaceId,
    subjectType: 'WORKSPACE_MEMBERSHIP',
    subjectId: managerMembershipId,
    permission: 'trainees.read',
    effect: 'ALLOW',
    scope: { type: 'BRANCH', resourceIds: [branchAId] },
    createdBy: ownerMembershipId,
    createdAt: seedNow,
  });
  addAlias('permission.branch_assignment_removed', 'membership_branch_assignments', {
    _id: id('branch_assignment', 'manager.removed_branch'),
    workspaceId,
    membershipId: managerMembershipId,
    branchId: branchBId,
    active: false,
    startedAt: offsetDays(-60),
    endedAt: offsetDays(-3),
    createdAt: offsetDays(-60),
  });
  registerAlias(
    'permission.inactive_membership',
    'workspace_memberships',
    mustId(manifest.knownIds.memberships['staff.inactive_membership'], 'staff.inactive_membership'),
  );
  registerAlias(
    'permission.restricted_workspace',
    'workspaces',
    mustId(manifest.knownIds.workspaces['workspace.restricted'], 'workspace.restricted'),
  );
}

function addCommercial(
  add: (collection: string, doc: Doc) => Doc,
  addAlias: (alias: string, collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  workspaceAliases: string[],
) {
  const ownerId = id('user', 'workspace.owner_active');
  for (const key of ['basic', 'pro', 'enterprise']) {
    const planId = id('subscription_plan', key);
    const versionId = id('subscription_plan_version', `${key}.v1`);
    add('subscription_plans', {
      _id: planId,
      key,
      customerType: 'GYM',
      name: `Seed ${title(key)} Plan`,
      active: true,
      currentVersionId: versionId,
      version: 1,
      createdAt: offsetDays(-120),
      updatedAt: seedNow,
    });
    add('subscription_plan_versions', {
      _id: versionId,
      planId,
      version: 1,
      billingOptions: ['MONTHLY', 'YEARLY'],
      defaultLimits: { activeTrainees: 500, activeStaff: 50, storageBytes: 10_000_000_000 },
      features: { training: true, nutrition: true, progress: true },
      trialDefaults: { days: 14 },
      effectiveFrom: offsetDays(-120),
      createdBy: ownerId,
      createdAt: offsetDays(-120),
    });
  }
  workspaceAliases.forEach((alias, index) => {
    const workspaceId = manifest.knownIds.workspaces[alias] ?? id('workspace', alias);
    const subscriptionId = id('subscription', alias);
    const termsId = id('subscription_terms', alias);
    const status = alias.includes('restricted') ? 'FROZEN' : 'ACTIVE';
    const subscriptionDoc = {
      _id: subscriptionId,
      workspaceId,
      lifecycleStatus: status,
      currentTermsId: termsId,
      startedAt: offsetDays(-90),
      ...(status === 'FROZEN' ? { frozenAt: offsetDays(-5) } : {}),
      version: 1,
      createdAt: offsetDays(-90),
      updatedAt: seedNow,
    };
    if (alias === 'workspace.restricted')
      addAlias('commercial.subscription.frozen', 'subscriptions', subscriptionDoc);
    else add('subscriptions', subscriptionDoc);
    add('subscription_terms', {
      _id: termsId,
      subscriptionId,
      workspaceId,
      planVersionId: id('subscription_plan_version', index % 2 === 0 ? 'pro.v1' : 'basic.v1'),
      billingPeriod: 'MONTHLY',
      limits: { activeTrainees: 500, activeStaff: 50, storageBytes: 10_000_000_000 },
      enabledFeatures: ['training', 'nutrition', 'progress'],
      effectiveFrom: offsetDays(-90),
      source: 'TRIAL',
      createdBy: ownerId,
      createdAt: offsetDays(-90),
    });
    const usageDoc = {
      _id: id('workspace_usage', alias),
      workspaceId,
      activeTrainees:
        alias === 'workspace.multi_branch'
          ? 499
          : alias === 'workspace.restricted'
            ? 500
            : alias === 'workspace.active_main'
              ? seedCount(manifest, 'traineeRelationships')
              : 0,
      activeStaff: alias === 'workspace.restricted' ? 50 : 7,
      storageBytes: alias === 'workspace.restricted' ? 10_000_000_000 : 1024 * 1024 * (index + 1),
      reservedStorageBytes: alias === 'workspace.multi_branch' ? 10_000_000_000 - 1024 : 0,
      revision: 1,
      calculatedAt: seedNow,
      updatedAt: seedNow,
    };
    if (alias === 'workspace.multi_branch') {
      addAlias('commercial.quota.near_limit', 'workspace_usage', usageDoc);
    } else if (alias === 'workspace.restricted') {
      addAlias('commercial.quota.exceeded', 'workspace_usage', usageDoc);
    } else {
      add('workspace_usage', usageDoc);
    }
  });
  for (let index = 0; index < seedCount(manifest, 'payments'); index += 1) {
    add('manual_payments', {
      _id: id('manual_payment', String(index)),
      workspaceId: activeWorkspaceId(manifest),
      subscriptionId: id('subscription', 'workspace.active_main'),
      amount: 1000 + index * 50,
      currency: 'EGP',
      paymentMethod: 'BANK_TRANSFER',
      paymentReference: `SEED-PAY-${index + 1}`,
      paidAt: offsetDays(-30 + index),
      status: index % 3 === 0 ? 'PENDING' : index % 3 === 1 ? 'APPROVED' : 'REJECTED',
      reviewedBy: ownerId,
      reviewedAt: offsetDays(-20 + index),
      version: 1,
      createdBy: ownerId,
      createdAt: offsetDays(-31 + index),
      updatedAt: seedNow,
    });
  }
}

function addLeads(
  add: (collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  assignedTo: ObjectId,
  convertedWorkspaceId: ObjectId,
) {
  const statuses = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST', 'DUPLICATE'];
  for (let index = 0; index < seedCount(manifest, 'leads'); index += 1) {
    const status = statuses[index % statuses.length];
    add('leads', {
      _id: id('lead', String(index)),
      customerInterest: 'GYM',
      gymName: `Seed Lead Gym ${index + 1}`,
      contactPerson: `Seed Lead ${index + 1}`,
      phone: `+20100000${String(index).padStart(4, '0')}`,
      normalizedPhone: `+20100000${String(index).padStart(4, '0')}`,
      email: `lead-${index + 1}@seed.${manifest.namespace}.local`,
      normalizedEmail: `lead-${index + 1}@seed.${manifest.namespace}.local`,
      governorate: 'Cairo',
      city: 'Cairo',
      estimatedTrainees: 50 + index,
      estimatedStaff: 5,
      numberOfBranches: 1 + (index % 3),
      billingInterest: 'MONTHLY',
      source: 'SEED',
      status,
      assignedTo,
      ...(status === 'CONVERTED'
        ? { convertedWorkspaceId, convertedBy: assignedTo, convertedAt: offsetDays(-15) }
        : {}),
      createdAt: offsetDays(-45 + index),
      updatedAt: seedNow,
      version: 1,
    });
  }
}

function addRelationships(
  add: (collection: string, doc: Doc) => Doc,
  addAlias: (alias: string, collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  workspaceId: ObjectId,
  branchId: ObjectId,
): Array<{ relationshipId: ObjectId; traineeUserId: ObjectId; traineeMembershipId: ObjectId }> {
  const result = [];
  const aliases = Object.keys(manifest.knownIds.relationships);
  for (let index = 0; index < seedCount(manifest, 'traineeRelationships'); index += 1) {
    const alias = aliases[index] ?? `relationship.generated_${index + 1}`;
    const relationshipId = manifest.knownIds.relationships[alias] ?? id('relationship', alias);
    const generatedOrdinal = index + 1;
    const generatedKey = String(generatedOrdinal).padStart(4, '0');
    const traineeUserId =
      alias === 'relationship.self.active'
        ? id('user', 'trainee.self_active')
        : alias === 'relationship.branch_b_denied'
          ? id('user', 'trainee.self_restricted')
          : id('user', `trainee.generated_${generatedKey}`);
    const traineeMembershipId =
      alias === 'relationship.self.active'
        ? mustId(manifest.knownIds.memberships['trainee.self_active'], 'trainee.self_active')
        : alias === 'relationship.branch_b_denied'
          ? mustId(
              manifest.knownIds.memberships['trainee.self_restricted'],
              'trainee.self_restricted',
            )
          : id('membership', `membership.generated_${generatedOrdinal}`);
    const status = alias.includes('inactive') ? 'ENDED' : 'ACTIVE';
    const doc = {
      _id: relationshipId,
      workspaceId,
      traineeUserId,
      traineeMembershipId,
      status,
      homeBranchId: branchId,
      proposedPrimaryTrainerMembershipId: mustId(
        manifest.knownIds.memberships['trainer.primary'],
        'trainer.primary',
      ),
      currentPrimaryTrainerAssignmentId: id('trainee_assignment', `${alias}.primary`),
      engagementPeriods: [
        { startedAt: offsetDays(-55), ...(status === 'ENDED' ? { endedAt: offsetDays(-7) } : {}) },
      ],
      version: 1,
      trainingLifecycleRevision: 1,
      workoutLifecycleRevision: 1,
      nutritionLifecycleRevision: 1,
      progressLifecycleRevision: 1,
      checkinLifecycleRevision: 1,
      activatedBy: id('user', 'workspace.owner_active'),
      activatedAt: offsetDays(-55),
      ...(status === 'ENDED'
        ? { endedAt: offsetDays(-7), endReason: 'Seed ended relationship' }
        : {}),
      createdAt: offsetDays(-55),
      updatedAt: seedNow,
    };
    if (manifest.knownIds.relationships[alias]) addAlias(alias, 'coaching_relationships', doc);
    else add('coaching_relationships', doc);
    result.push({ relationshipId, traineeUserId, traineeMembershipId });
  }
  return result;
}

function addAssignments(
  add: (collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  relationships: Array<{ relationshipId: ObjectId }>,
  trainerMembershipId: ObjectId,
  assistantMembershipId: ObjectId,
  nutritionistMembershipId: ObjectId,
) {
  relationships.forEach((relationship, index) => {
    const staff = [
      ['PRIMARY_TRAINER', trainerMembershipId],
      ...(index % 3 === 0 ? ([['ASSISTANT_TRAINER', assistantMembershipId]] as const) : []),
      ...(index % 4 === 0 ? ([['NUTRITIONIST', nutritionistMembershipId]] as const) : []),
    ] as const;
    for (const [assignmentType, staffMembershipId] of staff) {
      add('trainee_staff_assignments', {
        _id: new SeedIdFactory(manifest.namespace, manifest.dataset).objectId(
          'trainee_assignment',
          `${relationship.relationshipId.toHexString()}.${assignmentType}`,
        ),
        workspaceId: activeWorkspaceId(manifest),
        relationshipId: relationship.relationshipId,
        staffMembershipId,
        assignmentType,
        active: true,
        startedAt: offsetDays(-50),
        assignedBy: mustId(manifest.knownIds.memberships['owner.active'], 'owner.active'),
        createdAt: offsetDays(-50),
        updatedAt: seedNow,
      });
    }
  });
}

function addTraining(
  add: (collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  relationships: Array<{ relationshipId: ObjectId }>,
  trainerMembershipId: ObjectId,
) {
  const exerciseIds = ['squat', 'bench_press', 'deadlift', 'treadmill_intervals'].map(
    (key, index) => {
      const exerciseId = id('exercise', key);
      add('exercises', {
        _id: exerciseId,
        scope: 'GYM',
        workspaceId: activeWorkspaceId(manifest),
        ownerMembershipId: trainerMembershipId,
        names: { en: title(key.replaceAll('_', ' ')) },
        normalizedNames: [key.replaceAll('_', ' ')],
        primaryMuscles: ['FULL_BODY'],
        secondaryMuscles: [],
        equipment: index === 3 ? ['TREADMILL'] : ['BARBELL'],
        exerciseType: index === 3 ? 'CARDIO' : 'STRENGTH',
        status: 'ACTIVE',
        version: 1,
        createdAt: offsetDays(-45),
        updatedAt: seedNow,
      });
      return exerciseId;
    },
  );
  const programs = [];
  for (let index = 0; index < seedCount(manifest, 'programs'); index += 1) {
    const relationship = mustValue(relationships[index % relationships.length], 'relationship');
    const programId = id('program', String(index));
    const revisionId = id('program_revision', String(index));
    const status =
      index < relationships.length ? 'ACTIVE' : index % 3 === 0 ? 'COMPLETED' : 'DRAFT';
    const days = [
      {
        dayKey: 'day-1',
        sequence: 1,
        name: 'Strength A',
        type: 'RESISTANCE',
        exercises: [
          {
            prescriptionId: 'rx-1',
            exerciseId: mustId(exerciseIds[index % exerciseIds.length], 'exercise'),
            exerciseNameSnapshot: 'Seed Lift',
            order: 1,
            setStructure: 'STRAIGHT_SETS',
            targetSets: 3,
            repRange: { min: 8, max: 10 },
            restSeconds: 90,
          },
        ],
      },
    ];
    add('programs', {
      _id: programId,
      workspaceId: activeWorkspaceId(manifest),
      relationshipId: relationship.relationshipId,
      name: `Seed Program ${index + 1}`,
      status,
      ...(status === 'ACTIVE' ? { startedAt: offsetDays(-20) } : {}),
      ...(status === 'COMPLETED'
        ? { startedAt: offsetDays(-40), completedAt: offsetDays(-10), endedAt: offsetDays(-10) }
        : {}),
      currentRevisionId: revisionId,
      assignedBy: trainerMembershipId,
      workoutLifecycleRevision: 1,
      createdAt: offsetDays(-40 + (index % 10)),
      updatedAt: seedNow,
      version: 1,
    });
    add('program_revisions', {
      _id: revisionId,
      workspaceId: activeWorkspaceId(manifest),
      relationshipId: relationship.relationshipId,
      programId,
      revision: 1,
      days,
      createdBy: trainerMembershipId,
      createdAt: offsetDays(-40 + (index % 10)),
    });
    add('program_progress', {
      _id: id('program_progress', String(index)),
      workspaceId: activeWorkspaceId(manifest),
      relationshipId: relationship.relationshipId,
      programId,
      programRevisionId: revisionId,
      currentDaySequence: 1,
      completedDayCount: index % 5,
      skippedDayCount: index % 2,
      version: 1,
      workoutLifecycleRevision: 1,
      createdAt: offsetDays(-20),
      updatedAt: seedNow,
    });
    programs.push({
      programId,
      revisionId,
      relationshipId: relationship.relationshipId,
      exerciseId: mustId(exerciseIds[index % exerciseIds.length], 'exercise'),
    });
  }
  return programs;
}

function addWorkouts(
  add: (collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  relationships: Array<{ relationshipId: ObjectId; traineeUserId: ObjectId }>,
  programs: Array<{
    programId: ObjectId;
    revisionId: ObjectId;
    relationshipId: ObjectId;
    exerciseId: ObjectId;
  }>,
) {
  for (let index = 0; index < seedCount(manifest, 'workoutSessions'); index += 1) {
    const relationship = mustValue(relationships[index % relationships.length], 'relationship');
    const program = mustValue(
      programs.find((item) => item.relationshipId.equals(relationship.relationshipId)) ??
        programs[0],
      'program',
    );
    const workoutId = id('workout_session', String(index));
    const status =
      index < relationships.length ? 'IN_PROGRESS' : index % 5 === 0 ? 'ABANDONED' : 'COMPLETED';
    add('workout_sessions', {
      _id: workoutId,
      workspaceId: activeWorkspaceId(manifest),
      relationshipId: relationship.relationshipId,
      traineeUserId: relationship.traineeUserId,
      programId: program.programId,
      programRevisionId: program.revisionId,
      dayKey: 'day-1',
      daySequence: 1,
      performedByUserId: relationship.traineeUserId,
      status,
      startedAt: offsetDays(-30 + (index % 30)),
      ...(status === 'COMPLETED'
        ? {
            completedAt: offsetDays(-29 + (index % 30)),
            completedByUserId: relationship.traineeUserId,
          }
        : {}),
      ...(status === 'ABANDONED'
        ? {
            abandonedAt: offsetDays(-29 + (index % 30)),
            abandonedByUserId: relationship.traineeUserId,
            abandonmentReason: 'Seed scenario',
          }
        : {}),
      exercises: [
        {
          prescriptionId: 'rx-1',
          exerciseId: program.exerciseId,
          exerciseNameSnapshot: 'Seed Lift',
          order: 1,
          setStructure: 'STRAIGHT_SETS',
          targetSets: 3,
          workoutExerciseKey: 'wx-1',
          sets: [
            {
              setKey: 'set-1',
              setIndex: 1,
              setType: 'WORKING',
              weight: 80 + (index % 20),
              reps: 8,
              completed: status === 'COMPLETED',
            },
          ],
        },
      ],
      version: 1,
      createdAt: offsetDays(-30 + (index % 30)),
      updatedAt: seedNow,
    });
    if (index < seedCount(manifest, 'personalRecordEvents')) {
      add('personal_record_events', {
        _id: id('personal_record_event', String(index)),
        workspaceId: activeWorkspaceId(manifest),
        relationshipId: relationship.relationshipId,
        exerciseId: program.exerciseId,
        recordType: 'ESTIMATED_1RM',
        qualifierKey: 'default',
        eventType: 'ACHIEVED',
        newValue: 100 + index,
        sourceWorkoutId: workoutId,
        sourceWorkoutVersion: 1,
        occurredAt: offsetDays(-20 + index),
      });
      add('personal_records', {
        _id: id('personal_record', String(index)),
        workspaceId: activeWorkspaceId(manifest),
        relationshipId: relationship.relationshipId,
        exerciseId: program.exerciseId,
        recordType: 'ESTIMATED_1RM',
        qualifierKey: `seed-${index}`,
        value: 100 + index,
        sourceWorkoutId: workoutId,
        sourceWorkoutVersion: 1,
        achievedAt: offsetDays(-20 + index),
        updatedAt: seedNow,
      });
    }
  }
}

function addNutrition(
  add: (collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  relationships: Array<{ relationshipId: ObjectId }>,
  nutritionistMembershipId: ObjectId,
) {
  const foodId = id('food', 'chicken_breast');
  add('foods', {
    _id: foodId,
    scope: 'SYSTEM',
    workspaceId: null,
    ownerMembershipId: null,
    names: { en: 'Chicken Breast' },
    normalizedNames: ['chicken breast'],
    baseAmount: 100,
    baseUnit: 'GRAM',
    calories: 165,
    proteinG: 31,
    carbsG: 0,
    fatG: 4,
    status: 'ACTIVE',
    version: 1,
    createdBy: nutritionistMembershipId,
    updatedBy: nutritionistMembershipId,
    createdAt: offsetDays(-60),
    updatedAt: seedNow,
  });
  for (let index = 0; index < seedCount(manifest, 'nutritionPlans'); index += 1) {
    const relationship = mustValue(relationships[index % relationships.length], 'relationship');
    const planId = id('nutrition_plan', String(index));
    const revisionId = id('nutrition_plan_revision', String(index));
    const status =
      index < relationships.length ? 'ACTIVE' : index % 3 === 0 ? 'COMPLETED' : 'DRAFT';
    add('nutrition_plans', {
      _id: planId,
      workspaceId: activeWorkspaceId(manifest),
      relationshipId: relationship.relationshipId,
      name: `Seed Nutrition ${index + 1}`,
      status,
      responsibleMembershipId: nutritionistMembershipId,
      currentRevisionId: revisionId,
      ...(status === 'ACTIVE' ? { startedAt: offsetDays(-20) } : {}),
      version: 1,
      createdBy: nutritionistMembershipId,
      createdAt: offsetDays(-20),
      updatedAt: seedNow,
    });
    add('nutrition_plan_revisions', {
      _id: revisionId,
      workspaceId: activeWorkspaceId(manifest),
      relationshipId: relationship.relationshipId,
      nutritionPlanId: planId,
      revision: 1,
      targetCalories: 2200,
      targetProteinG: 150,
      targetCarbsG: 220,
      targetFatG: 70,
      waterTargetMl: 3000,
      calculatedCalories: 165,
      calculatedProteinG: 31,
      calculatedCarbsG: 0,
      calculatedFatG: 4,
      meals: [],
      supplements: [],
      createdBy: nutritionistMembershipId,
      createdAt: offsetDays(-20),
    });
  }
  for (let index = 0; index < seedCount(manifest, 'nutritionDailyLogs'); index += 1) {
    const relationship = mustValue(relationships[index % relationships.length], 'relationship');
    add('daily_tracking_entries', {
      _id: id('daily_tracking', String(index)),
      workspaceId: activeWorkspaceId(manifest),
      relationshipId: relationship.relationshipId,
      localDate: localDate(-index),
      timezoneAtEntry: seedWorkspaceTimezone,
      values: {
        NUTRITION: { adherencePercent: 70 + (index % 31) },
        WATER: { ml: 2000 + (index % 5) * 250 },
      },
      version: 1,
      updatedBy: nutritionistMembershipId,
      createdAt: offsetDays(-index),
      updatedAt: seedNow,
    });
  }
}

function addProgress(
  add: (collection: string, doc: Doc) => Doc,
  addAlias: (alias: string, collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  relationships: Array<{ relationshipId: ObjectId }>,
  trainerMembershipId: ObjectId,
) {
  const metricId = id('metric_definition', 'body_weight');
  add('metric_definitions', {
    _id: metricId,
    scope: 'GYM',
    workspaceId: activeWorkspaceId(manifest),
    ownerMembershipId: trainerMembershipId,
    key: 'SEED_BODY_WEIGHT',
    normalizedKey: 'seed_body_weight',
    name: 'Seed Body Weight',
    normalizedName: 'seed body weight',
    valueType: 'NUMBER',
    unit: 'KG',
    category: 'BODY',
    status: 'ACTIVE',
    version: 1,
    createdBy: trainerMembershipId,
    updatedBy: trainerMembershipId,
    createdAt: offsetDays(-60),
    updatedAt: seedNow,
  });
  const paginationRelationshipId = mustId(
    manifest.knownIds.relationships['relationship.pagination.progress_500_plus'],
    'relationship.pagination.progress_500_plus',
  );
  const measurementCount = Math.max(seedCount(manifest, 'progressMeasurements'), 501);
  const targetMeasurementCount = 501;
  for (let index = 0; index < measurementCount; index += 1) {
    const relationship =
      index < targetMeasurementCount
        ? { relationshipId: paginationRelationshipId }
        : mustValue(relationships[index % relationships.length], 'relationship');
    const doc = {
      _id: id('measurement', String(index)),
      workspaceId: activeWorkspaceId(manifest),
      relationshipId: relationship.relationshipId,
      metricDefinitionId: metricId,
      value: 70 + (index % 25) * 0.2,
      measuredAt: offsetDays(-index),
      source: 'TRAINER',
      recordedBy: trainerMembershipId,
      version: 1,
      createdAt: offsetDays(-index),
      updatedAt: seedNow,
    };
    if (index === 500)
      addAlias('progress.measurement.pagination_anchor_500', 'measurement_entries', doc);
    else add('measurement_entries', doc);
  }
  for (let index = 0; index < seedCount(manifest, 'progressPhotos'); index += 1) {
    const relationship = mustValue(relationships[index % relationships.length], 'relationship');
    add('progress_photo_entries', {
      _id: id('progress_photo', String(index)),
      workspaceId: activeWorkspaceId(manifest),
      relationshipId: relationship.relationshipId,
      capturedAt: offsetDays(-index),
      visibility: index % 2 === 0 ? 'TRAINER_VISIBLE' : 'PRIVATE',
      photos: [],
      createdBy: trainerMembershipId,
      version: 1,
      createdAt: offsetDays(-index),
      updatedAt: seedNow,
    });
  }
}

function addCheckins(
  add: (collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  relationships: Array<{ relationshipId: ObjectId }>,
  trainerMembershipId: ObjectId,
) {
  const templateId = id('checkin_template', 'weekly');
  const revisionId = id('checkin_template_revision', 'weekly');
  add('checkin_templates', {
    _id: templateId,
    workspaceId: activeWorkspaceId(manifest),
    ownerMembershipId: trainerMembershipId,
    name: 'Seed Weekly Progress',
    normalizedName: 'seed weekly progress',
    currentRevisionId: revisionId,
    status: 'ACTIVE',
    version: 1,
    templateUseRevision: 1,
    createdBy: trainerMembershipId,
    updatedBy: trainerMembershipId,
    createdAt: offsetDays(-40),
    updatedAt: seedNow,
  });
  add('checkin_template_revisions', {
    _id: revisionId,
    workspaceId: activeWorkspaceId(manifest),
    templateId,
    revision: 1,
    fields: [
      {
        fieldKey: 'energy',
        type: 'RATING',
        label: 'Energy',
        required: true,
        validation: { min: 1, max: 5 },
      },
    ],
    createdBy: trainerMembershipId,
    createdAt: offsetDays(-40),
  });
  relationships.forEach((relationship, index) => {
    add('checkin_assignments', {
      _id: id('checkin_assignment', String(index)),
      workspaceId: activeWorkspaceId(manifest),
      relationshipId: relationship.relationshipId,
      templateId,
      recurrence: { frequency: 'WEEKLY', dayOfWeek: 1, timezone: seedWorkspaceTimezone },
      active: true,
      version: 1,
      assignmentUseRevision: 1,
      startedAt: offsetDays(-35),
      createdBy: trainerMembershipId,
      updatedBy: trainerMembershipId,
      createdAt: offsetDays(-35),
      updatedAt: seedNow,
    });
  });
  for (let index = 0; index < seedCount(manifest, 'checkinInstances'); index += 1) {
    const relationship = mustValue(relationships[index % relationships.length], 'relationship');
    const status = ['UPCOMING', 'DUE', 'SUBMITTED', 'REVIEWED', 'OVERDUE', 'SKIPPED'][index % 6];
    add('checkin_instances', {
      _id: id('checkin_instance', String(index)),
      workspaceId: activeWorkspaceId(manifest),
      relationshipId: relationship.relationshipId,
      assignmentId: id('checkin_assignment', String(index % relationships.length)),
      templateId,
      templateRevisionId: revisionId,
      periodKey: `2026-W${String((index % 52) + 1).padStart(2, '0')}`,
      periodStartAt: offsetDays(-index - 7),
      periodEndAt: offsetDays(-index),
      opensAt: offsetDays(-index - 6),
      dueAt: offsetDays(-index - 1),
      timezone: seedWorkspaceTimezone,
      dayOfWeek: 1,
      status,
      responses:
        status === 'SUBMITTED' || status === 'REVIEWED' ? [{ fieldKey: 'energy', value: 4 }] : [],
      ...(status === 'SUBMITTED' || status === 'REVIEWED'
        ? { submittedAt: offsetDays(-index) }
        : {}),
      ...(status === 'REVIEWED'
        ? {
            reviewedAt: seedNow,
            trainerFeedback: {
              comment: 'Seed review',
              reviewedByMembershipId: trainerMembershipId,
            },
          }
        : {}),
      version: 1,
      createdAt: offsetDays(-index - 7),
      updatedAt: seedNow,
    });
  }
}

function addFiles(
  add: (collection: string, doc: Doc) => Doc,
  addAlias: (
    alias: string,
    collection: string,
    doc: Doc,
    status?: FixtureStatus,
    reason?: string,
  ) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  relationships: Array<{ relationshipId: ObjectId }>,
  uploaderMembershipId: ObjectId,
) {
  const reservedIntent = {
    _id: mustId(manifest.knownIds.files['file.upload.reserved'], 'file.upload.reserved'),
    workspaceId: activeWorkspaceId(manifest),
    uploaderUserId: id('user', 'workspace.trainer_primary'),
    uploaderMembershipId,
    purpose: 'DOCUMENT',
    subjectType: 'COACHING_RELATIONSHIP',
    subjectId: mustId(
      manifest.knownIds.relationships['relationship.file_sensitive'],
      'relationship.file_sensitive',
    ),
    storageProvider: 'seed',
    storageKey: `seed/${manifest.namespace}/reserved-upload.bin`,
    originalName: 'reserved-upload.pdf',
    mimeType: 'application/pdf',
    reservedBytes: 1024,
    expectedChecksumSha256: 'a'.repeat(64),
    classification: 'SENSITIVE',
    status: 'PENDING',
    version: 0,
    expiresAt: nonExpiringFixtureDate,
    createdAt: seedNow,
  };
  addAlias(
    'file.upload.reserved',
    'upload_intents',
    reservedIntent,
    'PROVIDER_DEPENDENT',
    'Requires storage-provider object state for confirm/download execution.',
  );
  addAlias(
    'file.upload.checksum_mismatch_fixture',
    'upload_intents',
    {
      ...reservedIntent,
      _id: mustId(
        manifest.knownIds.files['file.upload.checksum_mismatch_fixture'],
        'file.upload.checksum_mismatch_fixture',
      ),
      storageKey: `seed/${manifest.namespace}/checksum-mismatch.bin`,
      originalName: 'checksum-mismatch.pdf',
      expectedChecksumSha256: 'b'.repeat(64),
    },
    'PROVIDER_DEPENDENT',
    'Checksum mismatch requires storage-provider HEAD metadata or a fake provider fixture.',
  );

  for (let index = 0; index < seedCount(manifest, 'filesDocuments'); index += 1) {
    const relationship = mustValue(relationships[index % relationships.length], 'relationship');
    const fileAlias =
      index === 0
        ? 'file.medical_document.sensitive'
        : index === 1
          ? 'file.profile_photo.verified'
          : index === 2
            ? 'file.progress_photo.verified'
            : undefined;
    const documentAlias =
      index === 0
        ? 'document.trainee_contract'
        : index === 1
          ? 'document.retention_notice'
          : undefined;
    const fileId = fileAlias
      ? mustId(manifest.knownIds.files[fileAlias], fileAlias)
      : id('file_doc', String(index));
    const fileDoc = {
      _id: fileId,
      workspaceId: activeWorkspaceId(manifest),
      origin: 'USER_UPLOAD',
      uploaderUserId: id('user', 'workspace.trainer_primary'),
      uploaderMembershipId,
      subjectType: 'COACHING_RELATIONSHIP',
      subjectId: relationship.relationshipId,
      storageProvider: 'seed',
      storageKey: `seed/${manifest.namespace}/file-${index + 1}.txt`,
      originalName: `seed-file-${index + 1}.txt`,
      mimeType: 'text/plain',
      sizeBytes: 128 + index,
      classification: index % 5 === 0 ? 'SENSITIVE' : 'STANDARD',
      status: 'ACTIVE',
      version: 1,
      createdAt: offsetDays(-index),
      confirmedAt: offsetDays(-index),
    };
    if (fileAlias) addAlias(fileAlias, 'files', fileDoc);
    else add('files', fileDoc);
    const documentDoc = {
      _id: documentAlias
        ? mustId(manifest.knownIds.files[documentAlias], documentAlias)
        : id('document', String(index)),
      workspaceId: activeWorkspaceId(manifest),
      relationshipId: relationship.relationshipId,
      fileId,
      category: index % 3 === 0 ? 'MEDICAL_REPORT' : 'TRAINING_DOCUMENT',
      title: `Seed Document ${index + 1}`,
      uploadedByUserId: id('user', 'workspace.trainer_primary'),
      uploadedByMembershipId: uploaderMembershipId,
      classification: index % 5 === 0 ? 'SENSITIVE' : 'STANDARD',
      documentDate: offsetDays(-index),
      status: 'ACTIVE',
      version: 1,
      createdAt: offsetDays(-index),
    };
    if (documentAlias) addAlias(documentAlias, 'documents', documentDoc);
    else add('documents', documentDoc);
  }
}

function addNotifications(
  add: (collection: string, doc: Doc) => Doc,
  addAlias: (alias: string, collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  recipientUserId: ObjectId,
) {
  add('notification_preferences', {
    _id: id('notification_preferences', 'owner'),
    userId: recipientUserId,
    channels: { email: true, push: true, inApp: true },
    eventPreferences: {},
    version: 1,
    createdAt: offsetDays(-20),
    updatedAt: seedNow,
  });
  add('push_devices', {
    _id: mustId(
      manifest.knownIds.notifications['notification.device.fake_active'],
      'notification.device.fake_active',
    ),
    userId: recipientUserId,
    platform: 'WEB',
    provider: 'seed',
    token: `seed-token-${manifest.namespace}`,
    tokenFingerprint: `seed-fingerprint-${manifest.namespace}`,
    status: 'ACTIVE',
    label: 'Seed browser',
    createdAt: offsetDays(-20),
    updatedAt: seedNow,
    lastSeenAt: seedNow,
  });
  for (let index = 0; index < seedCount(manifest, 'notifications'); index += 1) {
    const notificationAlias =
      index === 0
        ? 'notification.unread.checkin_due'
        : index === 1
          ? 'notification.read.workout_completed'
          : undefined;
    const notificationId = notificationAlias
      ? mustId(manifest.knownIds.notifications[notificationAlias], notificationAlias)
      : id('notification_doc', String(index));
    const sourceEventId = id('notification_source', String(index));
    const doc = {
      _id: notificationId,
      recipientUserId,
      workspaceId: activeWorkspaceId(manifest),
      eventType: 'SEED_EVENT',
      notificationType: 'SEED_NOTIFICATION',
      category: index % 2 === 0 ? 'CHECK_IN' : 'WORKOUT',
      title: `Seed notification ${index + 1}`,
      body: 'This is fake local seed data.',
      readAt: index % 3 === 0 ? seedNow : undefined,
      sourceEventId,
      sourceType: 'seed',
      sourceId: String(index),
      dedupeKey: `seed:${manifest.namespace}:${index}`,
      templateKey: 'seed.notification',
      templateVersion: 1,
      locale: 'en',
      createdAt: offsetDays(-index),
      updatedAt: seedNow,
    };
    if (notificationAlias) addAlias(notificationAlias, 'notifications', doc);
    else add('notifications', doc);
  }
  for (let index = 0; index < seedCount(manifest, 'notificationDeliveries'); index += 1) {
    const deliveryAlias =
      index === 2
        ? 'notification.delivery.failed_retryable'
        : index === 3
          ? 'notification.delivery.cancelled'
          : index === 0
            ? 'notification.delivery.pending'
            : index === 1
              ? 'notification.delivery.sent'
              : undefined;
    const doc = {
      _id: deliveryAlias
        ? mustId(manifest.knownIds.notifications[deliveryAlias], deliveryAlias)
        : id('notification_delivery', String(index)),
      notificationId:
        index % seedCount(manifest, 'notifications') === 0
          ? mustId(
              manifest.knownIds.notifications['notification.unread.checkin_due'],
              'notification.unread.checkin_due',
            )
          : index % seedCount(manifest, 'notifications') === 1
            ? mustId(
                manifest.knownIds.notifications['notification.read.workout_completed'],
                'notification.read.workout_completed',
              )
            : id('notification_doc', String(index % seedCount(manifest, 'notifications'))),
      sourceEventId: id(
        'notification_source',
        String(index % seedCount(manifest, 'notifications')),
      ),
      recipientUserId,
      channel: index % 2 === 0 ? 'EMAIL' : 'PUSH',
      status: ['PENDING', 'SENT', 'FAILED', 'CANCELLED'][index % 4],
      attemptCount: index % 3,
      ...(deliveryAlias === 'notification.delivery.failed_retryable'
        ? {
            nextAttemptAt: offsetDays(1),
            lastAttemptAt: offsetDays(-1),
            lastError: {
              code: 'SEED_PROVIDER_TEMPORARY_FAILURE',
              message: 'Seed retryable delivery failure.',
              retryable: true,
            },
          }
        : {}),
      ...(deliveryAlias === 'notification.delivery.cancelled'
        ? { cancelledReason: 'PREFERENCES_DISABLED' }
        : {}),
      destinationSnapshot: {
        kind: 'USER_EMAIL',
        fingerprint: `seed-${index}`,
        email: `owner.active@seed.${manifest.namespace}.local`,
      },
      logicalDeliveryKey: `seed-delivery-${index}`,
      providerSupportsIdempotency: true,
      version: 1,
      createdAt: offsetDays(-index),
      updatedAt: seedNow,
    };
    if (deliveryAlias) addAlias(deliveryAlias, 'notification_deliveries', doc);
    else add('notification_deliveries', doc);
  }
}

function addSupport(
  add: (collection: string, doc: Doc) => Doc,
  addAlias: (alias: string, collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  supportUserId: ObjectId,
  targetWorkspaceId: ObjectId,
  effectiveMembershipId: ObjectId,
) {
  const platformMembershipId = mustId(
    manifest.knownIds.memberships['platform.support_admin'],
    'platform.support_admin',
  );
  const policyId = mustId(
    manifest.knownIds.support['support.policy.workspace_enabled'],
    'support.policy.workspace_enabled',
  );
  addAlias('support.policy.workspace_enabled', 'portal_access_policies', {
    _id: policyId,
    platformMembershipId,
    allowedTargetTypes: ['GYM', 'STAFF', 'TRAINEE'],
    allowedWorkspaceIds: [targetWorkspaceId],
    allowedSessionTypes: ['READ_ONLY', 'WRITE_SUPPORT'],
    maxSessionDurationMinutes: 60,
    notificationRequired: true,
    allowSensitiveData: true,
    allowSensitiveFileDownload: true,
    enabled: true,
    revision: 1,
    createdBy: supportUserId,
    createdAt: offsetDays(-10),
    updatedAt: seedNow,
  });
  addAlias('support.policy.workspace_denied', 'portal_access_policies', {
    _id: mustId(
      manifest.knownIds.support['support.policy.workspace_denied'],
      'support.policy.workspace_denied',
    ),
    platformMembershipId,
    allowedTargetTypes: ['GYM'],
    allowedWorkspaceIds: [
      mustId(manifest.knownIds.workspaces['workspace.restricted'], 'workspace.restricted'),
    ],
    allowedSessionTypes: ['READ_ONLY'],
    maxSessionDurationMinutes: 30,
    notificationRequired: true,
    allowSensitiveData: false,
    allowSensitiveFileDownload: false,
    enabled: false,
    revision: 1,
    createdBy: supportUserId,
    createdAt: offsetDays(-10),
    updatedAt: seedNow,
  });
  const supportCount = Math.max(seedCount(manifest, 'supportSessions'), 7);
  for (let index = 0; index < supportCount; index += 1) {
    if (index % 5 === 0) continue;
    add('auth_sessions', {
      _id: id('auth_session', `support_parent_${index}`),
      userId: supportUserId,
      status: 'ACTIVE',
      clientType: 'API',
      refreshTokenTransport: 'JSON',
      ipAddress: '127.0.0.1',
      authenticationMethods: ['pwd', 'totp'],
      mfaSatisfiedAt: offsetDays(-index),
      restrictedUntilVerified: false,
      createdAt: offsetDays(-index),
      lastSeenAt: seedNow,
      expiresAt: offsetDays(1),
    });
  }
  for (let index = 0; index < supportCount; index += 1) {
    const requestAlias =
      index === 0 ? 'support.request.denied' : index === 1 ? 'support.request.approved' : undefined;
    const requestId = requestAlias
      ? mustId(manifest.knownIds.support[requestAlias], requestAlias)
      : id('support_request', String(index));
    const requestDoc = {
      _id: requestId,
      requestedByPlatformMembershipId: platformMembershipId,
      realActorUserId: supportUserId,
      targetType: 'GYM',
      targetWorkspaceId,
      effectiveMembershipId,
      contextType: index % 2 === 0 ? 'WORKSPACE_SUPPORT' : 'USER_CONTEXT',
      requestedSessionType: 'READ_ONLY',
      requestedDurationMinutes: 30,
      requestedSensitiveAccess: index % 2 === 0,
      requestedSensitiveFileDownload: false,
      reason: 'Seed support scenario',
      reference: `SUP-SEED-${index + 1}`,
      sourceIp: '127.0.0.1',
      matchedPolicyId: policyId,
      policyRevision: 1,
      decision: index % 5 === 0 ? 'DENIED' : 'APPROVED',
      notificationRequired: true,
      createdAt: offsetDays(-index),
    };
    if (requestAlias) addAlias(requestAlias, 'support_access_requests', requestDoc);
    else add('support_access_requests', requestDoc);
    if (index % 5 !== 0) {
      const sessionAlias =
        index === 1
          ? 'support.session.active_user_context'
          : index === 2
            ? 'support.session.active_read_only'
            : index === 3
              ? 'support.session.sensitive_allowed'
              : index === 4
                ? 'support.session.expired'
                : index === 6
                  ? 'support.session.sensitive_denied'
                  : undefined;
      const allowSensitive =
        sessionAlias === 'support.session.sensitive_allowed'
          ? true
          : sessionAlias === 'support.session.sensitive_denied'
            ? false
            : index % 2 === 0;
      const sessionDoc = {
        _id: sessionAlias
          ? mustId(manifest.knownIds.support[sessionAlias], sessionAlias)
          : id('support_session', String(index)),
        requestId,
        policyId,
        policyRevision: 1,
        realActorUserId: supportUserId,
        realActorPlatformMembershipId: platformMembershipId,
        parentAuthSessionId: id('auth_session', `support_parent_${index}`),
        targetType: 'GYM',
        targetWorkspaceId,
        effectiveMembershipId,
        contextType: index % 2 === 0 ? 'WORKSPACE_SUPPORT' : 'USER_CONTEXT',
        sessionType: 'READ_ONLY',
        sourceIp: '127.0.0.1',
        reason: 'Seed support scenario',
        reference: `SUP-SEED-${index + 1}`,
        notificationRequired: true,
        allowSensitiveData: allowSensitive,
        allowSensitiveFileDownload: sessionAlias === 'support.session.sensitive_allowed',
        startedAt: offsetDays(-index),
        expiresAt: sessionAlias === 'support.session.expired' ? offsetDays(-1) : offsetDays(1),
        status: sessionAlias === 'support.session.expired' ? 'EXPIRED' : 'ACTIVE',
        version: 1,
        createdAt: offsetDays(-index),
        updatedAt: seedNow,
      };
      if (sessionAlias) addAlias(sessionAlias, 'support_sessions', sessionDoc);
      else add('support_sessions', sessionDoc);
    }
  }
}

function addExportsAndRetention(
  add: (collection: string, doc: Doc) => Doc,
  addAlias: (alias: string, collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  workspaceId: ObjectId,
  requestedByUserId: ObjectId,
) {
  const membershipId = mustId(manifest.knownIds.memberships['owner.active'], 'owner.active');
  const exportRequesters = [
    {
      userId: requestedByUserId,
      membershipId,
    },
    {
      userId: id('user', 'workspace.trainer_primary'),
      membershipId: mustId(manifest.knownIds.memberships['trainer.primary'], 'trainer.primary'),
    },
    {
      userId: id('user', 'workspace.nutritionist_active'),
      membershipId: mustId(
        manifest.knownIds.memberships['nutritionist.active'],
        'nutritionist.active',
      ),
    },
    {
      userId: id('user', 'workspace.assistant_active'),
      membershipId: mustId(manifest.knownIds.memberships['assistant.active'], 'assistant.active'),
    },
  ];
  const artifactFileId = mustId(
    manifest.knownIds.exports['export.artifact.downloadable'],
    'export.artifact.downloadable',
  );
  addAlias('export.artifact.downloadable', 'files', {
    _id: artifactFileId,
    workspaceId,
    origin: 'SYSTEM_GENERATED',
    generatedPurpose: 'WORKSPACE_EXPORT',
    generatedForExportId: mustId(
      manifest.knownIds.exports['export.request.completed'],
      'export.request.completed',
    ),
    subjectType: 'WORKSPACE',
    subjectId: workspaceId,
    storageProvider: 'seed',
    storageKey: `seed/${manifest.namespace}/exports/ready.zip`,
    originalName: 'seed-export-ready.zip',
    mimeType: 'application/zip',
    sizeBytes: 2048,
    verifiedChecksumSha256: 'c'.repeat(64),
    classification: 'STANDARD',
    status: 'ACTIVE',
    version: 1,
    createdAt: offsetDays(-1),
    confirmedAt: offsetDays(-1),
  });
  for (let index = 0; index < seedCount(manifest, 'exports'); index += 1) {
    const exportAlias =
      index === 0
        ? 'export.request.pending'
        : index === 1
          ? 'export.request.completed'
          : index === 2
            ? 'export.request.processing'
            : undefined;
    const status =
      exportAlias === 'export.request.completed'
        ? 'READY'
        : exportAlias === 'export.request.processing'
          ? 'PROCESSING'
          : index === 0
            ? 'PENDING'
            : index % 2 === 0
              ? 'FAILED'
              : 'EXPIRED';
    const doc = {
      _id: exportAlias
        ? mustId(manifest.knownIds.exports[exportAlias], exportAlias)
        : id('workspace_export', String(index)),
      workspaceId,
      requestedByUserId: mustValue(
        exportRequesters[index % exportRequesters.length],
        'export requester',
      ).userId,
      requestedByMembershipId: mustValue(
        exportRequesters[index % exportRequesters.length],
        'export requester',
      ).membershipId,
      status,
      requestedAt: offsetDays(-index),
      attemptCount: index % 2,
      processingStartedAt: status === 'PROCESSING' ? offsetDays(-1) : undefined,
      completedAt: status === 'READY' ? offsetDays(-1) : undefined,
      failedAt: status === 'FAILED' ? seedNow : undefined,
      failure:
        status === 'FAILED'
          ? { code: 'SEED_EXPORT_FAILED', message: 'Seed failed export fixture.', retryable: false }
          : undefined,
      expiresAt: status === 'EXPIRED' ? offsetDays(-1) : undefined,
      expiredAt: status === 'EXPIRED' ? seedNow : undefined,
      artifactFileId: status === 'READY' ? artifactFileId : undefined,
      artifactSizeBytes: status === 'READY' ? 2048 : undefined,
      artifactSha256: status === 'READY' ? 'c'.repeat(64) : undefined,
      format: 'ZIP_JSON_V1',
      manifestVersion: 1,
      scopeSnapshot: {
        includesUploadedBinaries: false,
        requestedByUserId: mustValue(
          exportRequesters[index % exportRequesters.length],
          'export requester',
        ).userId,
        requestedByMembershipId: mustValue(
          exportRequesters[index % exportRequesters.length],
          'export requester',
        ).membershipId,
      },
      version: 1,
      createdAt: offsetDays(-index),
      updatedAt: seedNow,
    };
    if (exportAlias) addAlias(exportAlias, 'workspace_export_requests', doc);
    else add('workspace_export_requests', doc);
  }
  for (let index = 0; index < seedCount(manifest, 'deletionRetentionFixtures'); index += 1) {
    const retentionAlias =
      index === 0
        ? 'retention.warning.active'
        : index === 1
          ? 'retention.warning.expired'
          : undefined;
    const retentionDoc = {
      _id: retentionAlias
        ? mustId(manifest.knownIds.exports[retentionAlias], retentionAlias)
        : id('retention_warning', String(index)),
      workspaceId,
      subscriptionId: id('subscription', 'workspace.active_main'),
      expiredAt: offsetDays(-40),
      eligibilityAt: offsetDays(-10 - index),
      warningOffsetDays: [30, 7, 1][index % 3],
      status: 'EMITTED',
      createdAt: offsetDays(-index),
      updatedAt: seedNow,
    };
    if (retentionAlias) addAlias(retentionAlias, 'retention_warning_markers', retentionDoc);
    else add('retention_warning_markers', retentionDoc);
    const deletionAlias =
      index === 0
        ? 'deletion.request.scheduled'
        : index === 1
          ? 'deletion.request.cancelled'
          : undefined;
    const deletionDoc = {
      _id: deletionAlias
        ? mustId(manifest.knownIds.exports[deletionAlias], deletionAlias)
        : id('workspace_deletion', String(index)),
      workspaceId,
      subscriptionId: id('subscription', 'workspace.active_main'),
      subscriptionVersionAtEligibility: 1,
      eligibilityBasis: { expiredAt: offsetDays(-40), eligibilityAt: offsetDays(-10) },
      status:
        deletionAlias === 'deletion.request.scheduled'
          ? 'PENDING_APPROVAL'
          : deletionAlias === 'deletion.request.cancelled'
            ? 'CANCELLED'
            : index % 2 === 0
              ? 'COMPLETED'
              : 'CANCELLED',
      ...(deletionAlias === 'deletion.request.scheduled' ? { reviewAfter: offsetDays(1) } : {}),
      ...(deletionAlias === 'deletion.request.cancelled'
        ? {
            cancelledAt: offsetDays(-1),
            cancelledBy: {
              type: 'PLATFORM',
              userId: requestedByUserId,
              platformMembershipId: mustId(
                manifest.knownIds.memberships['platform.support_admin'],
                'platform.support_admin',
              ),
              reason: 'Seed cancellation fixture',
            },
            cancellationReason: 'Seed cancelled deletion fixture.',
          }
        : {}),
      createdActor: {
        type: 'PLATFORM',
        userId: requestedByUserId,
        platformMembershipId: mustId(
          manifest.knownIds.memberships['platform.support_admin'],
          'platform.support_admin',
        ),
        reason: 'Seed fixture',
      },
      createdAt: offsetDays(-index),
      processingAttemptCount: 0,
      checkpoints: [],
      retainedPaymentProofFileIds: [],
      workspaceSnapshot: { name: 'Seed Active Main', type: 'GYM' },
      version: 1,
      updatedAt: seedNow,
    };
    if (deletionAlias) addAlias(deletionAlias, 'workspace_deletion_requests', deletionDoc);
    else add('workspace_deletion_requests', deletionDoc);
  }
}

function addIdempotencyFixtures(
  add: (collection: string, doc: Doc) => Doc,
  addAlias: (alias: string, collection: string, doc: Doc) => Doc,
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  actorUserId: ObjectId,
  passwordHash: string,
  workspaceId: ObjectId,
  roleProfileId: (workspaceId: ObjectId, roleKey: string) => ObjectId,
) {
  const routeKey = 'POST /api/v1/workspaces/:workspaceId/files/upload-intents';
  const replayFingerprint = {
    workspaceId: activeWorkspaceId(manifest).toHexString(),
    purpose: 'DOCUMENT',
    subjectType: 'COACHING_RELATIONSHIP',
  };
  addAlias('idempotency.replay_target', 'idempotency_records', {
    _id: mustId(
      manifest.knownIds.scenarios['idempotency.replay_target'],
      'idempotency.replay_target',
    ),
    actorId: actorUserId.toHexString(),
    routeKey,
    key: `seed-replay-${manifest.namespace}`,
    requestHash: fingerprint(replayFingerprint),
    state: 'COMPLETED',
    responseStatus: 201,
    responseBody: { data: { seed: true, fixture: 'idempotency.replay_target' } },
    resourceId: mustId(
      manifest.knownIds.files['file.upload.reserved'],
      'file.upload.reserved',
    ).toHexString(),
    createdAt: seedNow,
    updatedAt: seedNow,
    expiresAt: nonExpiringFixtureDate,
  });
  addAlias('idempotency.mismatch_target', 'idempotency_records', {
    _id: mustId(
      manifest.knownIds.scenarios['idempotency.mismatch_target'],
      'idempotency.mismatch_target',
    ),
    actorId: actorUserId.toHexString(),
    routeKey,
    key: `seed-mismatch-${manifest.namespace}`,
    requestHash: fingerprint({ ...replayFingerprint, mismatch: true }),
    state: 'COMPLETED',
    responseStatus: 201,
    responseBody: { data: { seed: true, fixture: 'idempotency.mismatch_target' } },
    resourceId: mustId(
      manifest.knownIds.files['file.upload.checksum_mismatch_fixture'],
      'file.upload.checksum_mismatch_fixture',
    ).toHexString(),
    createdAt: seedNow,
    updatedAt: seedNow,
    expiresAt: nonExpiringFixtureDate,
  });
  const staleUserId = id('user', 'trainee.cas_stale');
  const staleMembershipId = id('membership', 'membership.cas_stale');
  const validUserId = id('user', 'trainee.cas_valid');
  const validMembershipId = id('membership', 'membership.cas_valid');
  add(
    'users',
    userDoc(
      staleUserId,
      `trainee.cas-stale@seed.${manifest.namespace}.local`,
      passwordHash,
      'trainee.cas_stale',
    ),
  );
  add(
    'users',
    userDoc(
      validUserId,
      `trainee.cas-valid@seed.${manifest.namespace}.local`,
      passwordHash,
      'trainee.cas_valid',
    ),
  );
  for (const [membershipId, userId] of [
    [staleMembershipId, staleUserId],
    [validMembershipId, validUserId],
  ] as const) {
    add('workspace_memberships', {
      _id: membershipId,
      workspaceId,
      userId,
      roles: ['TRAINEE'],
      status: 'ACTIVE',
      joinedAt: offsetDays(-20),
      engagementPeriods: [{ startedAt: offsetDays(-20) }],
      permissionProfileIds: [roleProfileId(workspaceId, 'TRAINEE')],
      accessVersion: 1,
      createdAt: offsetDays(-20),
      updatedAt: seedNow,
    });
  }
  addAlias('expected_version.stale_conflict_target', 'coaching_relationships', {
    _id: mustId(
      manifest.knownIds.scenarios['expected_version.stale_conflict_target'],
      'expected_version.stale_conflict_target',
    ),
    workspaceId: activeWorkspaceId(manifest),
    traineeUserId: staleUserId,
    traineeMembershipId: staleMembershipId,
    status: 'ACTIVE',
    homeBranchId: mustId(manifest.knownIds.branches['branch.main'], 'branch.main'),
    engagementPeriods: [{ startedAt: offsetDays(-20) }],
    version: 2,
    trainingLifecycleRevision: 1,
    workoutLifecycleRevision: 1,
    nutritionLifecycleRevision: 1,
    progressLifecycleRevision: 1,
    checkinLifecycleRevision: 1,
    activatedBy: actorUserId,
    activatedAt: offsetDays(-20),
    createdAt: offsetDays(-20),
    updatedAt: seedNow,
  });
  addAlias('expected_version.valid_update_target', 'coaching_relationships', {
    _id: mustId(
      manifest.knownIds.scenarios['expected_version.valid_update_target'],
      'expected_version.valid_update_target',
    ),
    workspaceId: activeWorkspaceId(manifest),
    traineeUserId: validUserId,
    traineeMembershipId: validMembershipId,
    status: 'ACTIVE',
    homeBranchId: mustId(manifest.knownIds.branches['branch.main'], 'branch.main'),
    engagementPeriods: [{ startedAt: offsetDays(-20) }],
    version: 1,
    trainingLifecycleRevision: 1,
    workoutLifecycleRevision: 1,
    nutritionLifecycleRevision: 1,
    progressLifecycleRevision: 1,
    checkinLifecycleRevision: 1,
    activatedBy: actorUserId,
    activatedAt: offsetDays(-20),
    createdAt: offsetDays(-20),
    updatedAt: seedNow,
  });
}

function actualCounts(collections: Record<string, Doc[]>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(collections).map(([collection, docs]) => [collection, docs.length]),
  );
}

function markProviderDependentFixtures(fixtureAliases: SeedManifest['fixtureAliases']) {
  for (const alias of ['file.upload.reserved', 'file.upload.checksum_mismatch_fixture']) {
    const fixture = fixtureAliases[alias];
    if (!fixture) continue;
    fixtureAliases[alias] = {
      ...fixture,
      status: 'PROVIDER_DEPENDENT',
      reason:
        fixture.reason ??
        'Requires fake/local storage-provider object metadata to execute confirmation.',
    };
  }
}

function markUnavailableFixtures(
  fixtureAliases: SeedManifest['fixtureAliases'],
  markUnavailable: (alias: string, reason: string) => void,
) {
  const unavailable: Record<string, string> = {
    'pagination.analytics_category_bound':
      'Analytics category cursor behavior is generated by dashboard endpoints; seed provides source records but no precomputed cursor token.',
  };
  for (const [alias, reason] of Object.entries(unavailable)) {
    if (!fixtureAliases[alias]) markUnavailable(alias, reason);
  }
}

function buildQaCoverage(
  manifest: SeedManifest,
  fixtureAliases: SeedManifest['fixtureAliases'],
): Record<string, SeedQaScenarioCoverage> {
  return Object.fromEntries(
    Object.entries(manifest.qaScenarios).map(([scenarioId, scenario]) => {
      const records: SeedQaScenarioCoverage['records'] = {};
      const missing: string[] = [];
      let providerDependent = false;
      for (const alias of scenario.fixtureAliases) {
        const fixture =
          fixtureAliases[alias] ?? findManifestBackedFixture(alias, manifest, fixtureAliases);
        if (!fixture || fixture.status === 'UNAVAILABLE_WITH_REASON') {
          missing.push(alias);
          continue;
        }
        records[alias] = fixture.records;
        if (fixture.status === 'PROVIDER_DEPENDENT') providerDependent = true;
      }
      const status =
        missing.length > 0
          ? 'UNAVAILABLE_WITH_REASON'
          : providerDependent
            ? 'PROVIDER_DEPENDENT'
            : 'READY';
      return [
        scenarioId,
        {
          fixtureAliases: scenario.fixtureAliases,
          status,
          datasets: status === 'UNAVAILABLE_WITH_REASON' ? [] : datasetsForScenario(scenarioId),
          records,
          ...(missing.length > 0
            ? { reason: `Missing usable fixture aliases: ${missing.join(', ')}` }
            : {}),
        },
      ];
    }),
  );
}

function findManifestBackedFixture(
  alias: string,
  manifest: SeedManifest,
  fixtureAliases: SeedManifest['fixtureAliases'],
): SeedManifest['fixtureAliases'][string] | undefined {
  if (fixtureAliases[alias]) return fixtureAliases[alias];
  for (const [collection, ids] of [
    ['workspaces', manifest.knownIds.workspaces],
    ['branches', manifest.knownIds.branches],
    ['workspace_memberships', manifest.knownIds.memberships],
    ['coaching_relationships', manifest.knownIds.relationships],
    ['files', manifest.knownIds.files],
    ['support_sessions', manifest.knownIds.support],
    ['notifications', manifest.knownIds.notifications],
    ['workspace_export_requests', manifest.knownIds.exports],
  ] as const) {
    const id = ids[alias];
    if (id) return { status: 'READY', records: [{ collection, id }] };
  }
  return undefined;
}

function datasetsForScenario(scenarioId: string): SeedDataset[] {
  if (['QA-019', 'QA-020', 'QA-027'].includes(scenarioId)) return ['REALISTIC', 'STRESS'];
  return ['SMALL', 'REALISTIC', 'STRESS'];
}

function buildOwnershipRecords(
  manifest: SeedManifest,
  id: (kind: string, key: string) => ObjectId,
  collections: Record<string, Doc[]>,
  fixtureAliases: SeedManifest['fixtureAliases'],
): SeedOwnedRecord[] {
  const aliasByCollectionAndId = new Map<string, string>();
  for (const [alias, fixture] of Object.entries(fixtureAliases)) {
    for (const record of fixture.records) {
      aliasByCollectionAndId.set(`${record.collection}:${record.id.toHexString()}`, alias);
    }
  }
  const records: SeedOwnedRecord[] = [];
  for (const [collection, docs] of Object.entries(collections)) {
    if (collection === 'seed_owned_records') continue;
    for (const doc of docs) {
      const key = `${collection}:${doc._id.toHexString()}`;
      const ownedRecord: SeedOwnedRecord = {
        _id: id('seed_owned_record', key),
        namespace: manifest.namespace,
        dataset: manifest.dataset,
        collection,
        recordId: doc._id,
        createdAt: seedNow,
      };
      const alias = aliasByCollectionAndId.get(key);
      if (alias) ownedRecord.alias = alias;
      records.push(ownedRecord);
    }
  }
  return records;
}

function seedCount(manifest: SeedManifest, key: string): number {
  return manifest.targetCounts[key] ?? 0;
}

function activeWorkspaceId(manifest: SeedManifest): ObjectId {
  return mustId(manifest.knownIds.workspaces['workspace.active_main'], 'workspace.active_main');
}

function mustId(value: ObjectId | undefined, label: string): ObjectId {
  if (!value) throw new Error(`Seed manifest is missing required id: ${label}`);
  return value;
}

function mustValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Seed builder is missing required value: ${label}`);
  return value;
}

function localDate(offset: number): string {
  return offsetDays(offset).toISOString().slice(0, 10);
}

function title(input: string): string {
  return input
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
