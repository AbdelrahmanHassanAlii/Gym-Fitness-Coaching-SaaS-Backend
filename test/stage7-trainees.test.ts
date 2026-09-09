import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Db, ObjectId } from 'mongodb';
import type { AppContainer } from '../src/bootstrap/app-container';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { migrations } from '../src/migrations';
import { migration012Stage7TraineeRelationships } from '../src/migrations/012-stage7-trainee-relationships';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { systemPermissionProfiles } from '../src/modules/permissions/permission.registry';

describe('Stage 7 migration 012', () => {
  test('creates relationship and assignment indexes plus trainee permission seeds', async () => {
    const calls: Array<{ collection: string; indexes: unknown[] }> = [];
    const updates: Array<{ collection: string; filter: unknown }> = [];
    const db = {
      collection(name: string) {
        return {
          async createIndexes(indexes: unknown[]) {
            calls.push({ collection: name, indexes });
          },
          async updateOne(filter: unknown) {
            updates.push({ collection: name, filter });
          },
          find() {
            return {
              async toArray() {
                return [{ _id: new ObjectId() }];
              },
            };
          },
        };
      },
    };

    await migration012Stage7TraineeRelationships.up(db as never);

    expect(indexes(calls, 'coaching_relationships')).toContainEqual(
      expect.objectContaining({
        name: 'coaching_relationships_workspace_trainee_unique',
        unique: true,
        key: { workspaceId: 1, traineeUserId: 1 },
      }),
    );
    expect(indexes(calls, 'trainee_staff_assignments')).toContainEqual(
      expect.objectContaining({
        name: 'trainee_assignments_one_active_primary',
        unique: true,
        partialFilterExpression: { assignmentType: 'PRIMARY_TRAINER', active: true },
      }),
    );
    expect(JSON.stringify(updates)).toContain('trainees.assignments.primary.manage');
    expect(JSON.stringify(updates)).toContain('TRAINEE');
  });
});

describe('Stage 7 trainee relationships integration', () => {
  let container: AppContainer;
  let db: Db;

  beforeAll(async () => {
    container = await createAppContainer(
      integrationConfig(`stage7_${new ObjectId().toHexString()}`),
    );
    db = container.database.db;
    await new MigrationRunner(db, migrations).migrate();
  }, 30_000);

  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (container) await container.database.close();
  }, 30_000);

  test('staff invitation acceptance activates a trainee, creates one membership, primary assignment, audit/outbox, and quota', async () => {
    const seed = await seedGym(container);
    const trainee = await seedUser(db, 'trainee-invite@example.com');

    const invitation = await container.trainees.inviteTrainee(seed.ownerCtx, seed.workspaceId, {
      email: trainee.email,
      homeBranchId: seed.branchId,
      primaryTrainerMembershipId: seed.trainerMembershipId,
    });

    expect(invitation.token).toBeTruthy();
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(0);

    const accepted = await container.trainees.acceptTraineeInvitation(
      ctx(trainee._id),
      invitation.token,
    );
    const relationshipId = accepted.relationship.id;
    const relationship = await db
      .collection('coaching_relationships')
      .findOne({ _id: new ObjectId(relationshipId) });
    const membership = await db.collection('workspace_memberships').findOne({
      workspaceId: seed.workspaceObjectId,
      userId: trainee._id,
    });

    expect(relationship).toMatchObject({ status: 'ACTIVE', version: 1 });
    expect(relationship?.engagementPeriods).toHaveLength(1);
    expect(relationship?.currentPrimaryTrainerAssignmentId).toBeInstanceOf(ObjectId);
    expect(membership?.roles).toContain('TRAINEE');
    expect(
      await db
        .collection('workspace_memberships')
        .countDocuments({ workspaceId: seed.workspaceObjectId, userId: trainee._id }),
    ).toBe(1);
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(1);
    expect(
      await db.collection('audit_events').countDocuments({ eventType: 'TraineeActivated' }),
    ).toBeGreaterThan(0);
    expect(
      await db.collection('outbox_events').countDocuments({ eventType: 'TraineeActivated' }),
    ).toBeGreaterThan(0);
  });

  test('existing staff user can become a trainee without losing staff access, and end removes only trainee contribution', async () => {
    const seed = await seedGym(container);
    const staffTrainee = await seedUser(db, 'mixed-role@example.com');
    const trainerProfile = await container.permissionProfiles.findSystemDefault({
      context: 'WORKSPACE',
      workspaceId: seed.workspaceObjectId,
      roleKey: 'TRAINER',
    });
    const staffMembership = await container.workspaceMemberships.createActive({
      workspaceId: seed.workspaceObjectId,
      userId: staffTrainee._id,
      roles: ['TRAINER'],
    });
    await container.workspaceMemberships.updateRoleAndProfileContributions(
      seed.workspaceObjectId,
      staffMembership._id,
      staffMembership.accessVersion ?? 0,
      { roles: ['TRAINER'], permissionProfileIds: trainerProfile ? [trainerProfile._id] : [] },
    );
    await container.membershipBranchAssignments.createActive(
      seed.workspaceObjectId,
      staffMembership._id,
      seed.branchObjectId,
    );

    const invitation = await container.trainees.inviteTrainee(seed.ownerCtx, seed.workspaceId, {
      email: staffTrainee.email,
      homeBranchId: seed.branchId,
      primaryTrainerMembershipId: seed.trainerMembershipId,
    });
    const accepted = await container.trainees.acceptTraineeInvitation(
      ctx(staffTrainee._id),
      invitation.token,
    );
    let membership = await db
      .collection('workspace_memberships')
      .findOne({ _id: staffMembership._id });
    expect(membership?.roles).toEqual(expect.arrayContaining(['TRAINER', 'TRAINEE']));
    expect(membership?.status).toBe('ACTIVE');

    await container.trainees.endRelationship(
      seed.ownerCtx,
      seed.workspaceId,
      accepted.relationship.id,
      {
        expectedVersion: accepted.relationship.version,
        reason: 'left',
      },
    );

    membership = await db.collection('workspace_memberships').findOne({ _id: staffMembership._id });
    expect(membership?.status).toBe('ACTIVE');
    expect(membership?.roles).toEqual(['TRAINER']);
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(0);
  });

  test('referral join creates PENDING without membership or quota, then staff approval activates', async () => {
    const seed = await seedGym(container);
    const trainee = await seedUser(db, 'referral@example.com');
    await db.collection('referral_codes').insertOne({
      _id: new ObjectId(),
      code: 'GYM-CODE-1',
      ownerWorkspaceId: seed.workspaceObjectId,
      ownerUserId: new ObjectId(seed.trainerUserId),
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const joined = await container.trainees.joinReferral(ctx(trainee._id), 'GYM-CODE-1', {
      homeBranchId: seed.branchId,
    });
    expect(joined.relationship.status).toBe('PENDING');
    expect(
      await db
        .collection('workspace_memberships')
        .findOne({ workspaceId: seed.workspaceObjectId, userId: trainee._id }),
    ).toBeNull();
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(0);

    const accepted = await container.trainees.acceptPending(
      seed.ownerCtx,
      seed.workspaceId,
      joined.relationship.id,
      {
        expectedVersion: joined.relationship.version,
      },
    );
    expect(accepted.relationship.status).toBe('ACTIVE');
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(1);
  });

  test('home branch change requires eligible replacement when current primary lacks destination branch', async () => {
    const seed = await seedGym(container);
    const secondBranch = await container.branches.create({
      workspaceId: seed.workspaceObjectId,
      name: 'West',
      timezone: 'Africa/Cairo',
    });
    const replacementUser = await seedUser(db, 'replacement@example.com');
    const replacement = await container.workspaceMemberships.createActive({
      workspaceId: seed.workspaceObjectId,
      userId: replacementUser._id,
      roles: ['TRAINER'],
    });
    await container.membershipBranchAssignments.createActive(
      seed.workspaceObjectId,
      replacement._id,
      secondBranch._id,
    );
    const trainee = await seedUser(db, 'branch-trainee@example.com');
    const invitation = await container.trainees.inviteTrainee(seed.ownerCtx, seed.workspaceId, {
      email: trainee.email,
      homeBranchId: seed.branchId,
      primaryTrainerMembershipId: seed.trainerMembershipId,
    });
    const accepted = await container.trainees.acceptTraineeInvitation(
      ctx(trainee._id),
      invitation.token,
    );

    await expect(
      container.trainees.changeHomeBranch(
        seed.ownerCtx,
        seed.workspaceId,
        accepted.relationship.id,
        {
          expectedVersion: accepted.relationship.version,
          homeBranchId: secondBranch._id.toHexString(),
        },
      ),
    ).rejects.toThrow();

    const changed = await container.trainees.changeHomeBranch(
      seed.ownerCtx,
      seed.workspaceId,
      accepted.relationship.id,
      {
        expectedVersion: accepted.relationship.version,
        homeBranchId: secondBranch._id.toHexString(),
        primaryTrainerMembershipId: replacement._id.toHexString(),
      },
    );
    expect(changed.relationship.homeBranchId).toBe(secondBranch._id.toHexString());
    expect(changed.relationship.currentPrimaryTrainerAssignmentId).toBeTruthy();
  });

  test('primary removal marks NEEDS_REASSIGNMENT and keeps quota counted', async () => {
    const seed = await seedGym(container);
    const active = await activeRelationshipFromInvite(
      container,
      seed,
      'needs-reassignment@example.com',
    );
    const removed = await container.trainees.removePrimary(
      seed.ownerCtx,
      seed.workspaceId,
      active.relationship.id,
      {
        expectedVersion: active.relationship.version,
        reason: 'trainer unavailable',
      },
    );
    expect(removed.relationship.status).toBe('NEEDS_REASSIGNMENT');
    expect(removed.relationship.currentPrimaryTrainerAssignmentId).toBeUndefined();
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(1);
  });

  test('assistant and nutritionist assignments enforce active duplicate uniqueness and no quota effect', async () => {
    const seed = await seedGym(container);
    const active = await activeRelationshipFromInvite(
      container,
      seed,
      'staff-assignment-trainee@example.com',
    );
    const assistantUser = await seedUser(db, 'assistant@example.com');
    const assistant = await container.workspaceMemberships.createActive({
      workspaceId: seed.workspaceObjectId,
      userId: assistantUser._id,
      roles: ['ASSISTANT_TRAINER'],
    });
    await container.membershipBranchAssignments.createActive(
      seed.workspaceObjectId,
      assistant._id,
      seed.branchObjectId,
    );
    const nutritionUser = await seedUser(db, 'nutritionist@example.com');
    const nutritionist = await container.workspaceMemberships.createActive({
      workspaceId: seed.workspaceObjectId,
      userId: nutritionUser._id,
      roles: ['NUTRITIONIST'],
    });
    await container.membershipBranchAssignments.createActive(
      seed.workspaceObjectId,
      nutritionist._id,
      seed.branchObjectId,
    );

    await container.trainees.addStaffAssignment(
      seed.ownerCtx,
      seed.workspaceId,
      active.relationship.id,
      {
        expectedVersion: active.relationship.version,
        staffMembershipId: assistant._id.toHexString(),
        assignmentType: 'ASSISTANT_TRAINER',
      },
    );
    await expect(
      container.trainees.addStaffAssignment(
        seed.ownerCtx,
        seed.workspaceId,
        active.relationship.id,
        {
          expectedVersion: active.relationship.version,
          staffMembershipId: assistant._id.toHexString(),
          assignmentType: 'ASSISTANT_TRAINER',
        },
      ),
    ).rejects.toThrow();
    await expect(
      container.trainees.removeStaffAssignment(
        seed.ownerCtx,
        seed.workspaceId,
        active.relationship.id,
        assistant._id.toHexString(),
        'ASSISTANT_TRAINER',
        { expectedVersion: active.relationship.version },
      ),
    ).rejects.toThrow();
    const refreshed = await container.coachingRelationships.findByIdInWorkspace(
      seed.workspaceObjectId,
      new ObjectId(active.relationship.id),
    );
    await container.trainees.addStaffAssignment(
      seed.ownerCtx,
      seed.workspaceId,
      active.relationship.id,
      {
        expectedVersion: refreshed?.version ?? -1,
        staffMembershipId: nutritionist._id.toHexString(),
        assignmentType: 'NUTRITIONIST',
      },
    );
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(1);
  });

  test('async reconciliation changes ACTIVE primary relationships to NEEDS_REASSIGNMENT when branch eligibility ends but ignores suspension alone', async () => {
    const seed = await seedGym(container);
    const active = await activeRelationshipFromInvite(container, seed, 'reconcile@example.com');

    await container.workspaceMemberships.transition(
      seed.workspaceObjectId,
      new ObjectId(seed.trainerMembershipId),
      ['ACTIVE'],
      'SUSPENDED',
    );
    let saved = await db
      .collection('coaching_relationships')
      .findOne({ _id: new ObjectId(active.relationship.id) });
    expect(saved?.status).toBe('ACTIVE');

    await container.workspaceMemberships.transition(
      seed.workspaceObjectId,
      new ObjectId(seed.trainerMembershipId),
      ['SUSPENDED'],
      'ACTIVE',
    );
    await container.workspaceMemberships.transition(
      seed.workspaceObjectId,
      new ObjectId(seed.trainerMembershipId),
      ['ACTIVE'],
      'ENDED',
    );
    expect(
      await container.trainees.reconcilePrimaryEligibility(
        seed.workspaceObjectId,
        new ObjectId(seed.trainerMembershipId),
        'ended',
      ),
    ).toBe(1);
    saved = await db
      .collection('coaching_relationships')
      .findOne({ _id: new ObjectId(active.relationship.id) });
    expect(saved?.status).toBe('NEEDS_REASSIGNMENT');
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(1);
  });

  test('independent trainer to Gym migration atomically creates destination and optionally ends source', async () => {
    const gym = await seedGym(container);
    const independent = await seedIndependent(container);
    const migrationActorMembership = await container.workspaceMemberships.createActive({
      workspaceId: independent.workspaceObjectId,
      userId: new ObjectId(gym.ownerUserId),
      roles: ['TRAINER'],
    });
    await assignSystemProfile(
      container,
      independent.workspaceObjectId,
      migrationActorMembership._id,
      'TRAINER',
    );
    const trainee = await seedUser(db, 'migrate-trainee@example.com');
    const sourceMembership = await container.workspaceMemberships.createActive({
      workspaceId: independent.workspaceObjectId,
      userId: trainee._id,
      roles: ['TRAINEE'],
    });
    await db
      .collection('workspace_usage')
      .updateOne({ workspaceId: independent.workspaceObjectId }, { $set: { activeTrainees: 1 } });
    const source = await container.coachingRelationships.createActive({
      workspaceId: independent.workspaceObjectId,
      traineeUserId: trainee._id,
      traineeMembershipId: sourceMembership._id,
      activatedBy: new ObjectId(independent.ownerUserId),
    });
    const sourcePrimary = await container.coachingRelationships.createAssignment({
      workspaceId: independent.workspaceObjectId,
      relationshipId: source._id,
      staffMembershipId: new ObjectId(independent.trainerMembershipId),
      assignmentType: 'PRIMARY_TRAINER',
      assignedBy: new ObjectId(independent.ownerUserId),
    });
    await container.coachingRelationships.setPrimaryPointer(
      source._id,
      independent.workspaceObjectId,
      source.version,
      ['ACTIVE'],
      sourcePrimary._id,
    );

    const migrated = await container.trainees.migrateIndependentToGym(gym.ownerCtx, {
      sourceWorkspaceId: independent.workspaceId,
      destinationWorkspaceId: gym.workspaceId,
      sourceRelationshipId: source._id.toHexString(),
      destinationHomeBranchId: gym.branchId,
      destinationPrimaryTrainerMembershipId: gym.trainerMembershipId,
      expectedSourceVersion: 1,
    });

    expect(migrated.destinationRelationship.status).toBe('ACTIVE');
    const sourceSaved = await db.collection('coaching_relationships').findOne({ _id: source._id });
    expect(sourceSaved?.status).toBe('ENDED');
    expect(await activeTraineeUsage(db, gym.workspaceId)).toBe(1);
    expect(await activeTraineeUsage(db, independent.workspaceId)).toBe(0);
  });
});

async function seedGym(container: AppContainer) {
  const db = container.database.db;
  const owner = await seedUser(db, `owner-${new ObjectId().toHexString()}@example.com`);
  const trainer = await seedUser(db, `trainer-${new ObjectId().toHexString()}@example.com`);
  const workspace = await container.workspaceRepo.create({
    type: 'GYM',
    name: 'Stage 7 Gym',
    ownerUserId: owner._id,
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
  });
  await seedCommercial(db, workspace._id);
  const branch = await container.branches.create({
    workspaceId: workspace._id,
    name: 'Main',
    timezone: 'Africa/Cairo',
  });
  const ownerMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: owner._id,
    roles: ['GYM_OWNER'],
  });
  const trainerMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: trainer._id,
    roles: ['TRAINER'],
  });
  await assignSystemProfile(container, workspace._id, ownerMembership._id, 'GYM_OWNER');
  await assignSystemProfile(container, workspace._id, trainerMembership._id, 'TRAINER');
  await container.membershipBranchAssignments.createActive(
    workspace._id,
    trainerMembership._id,
    branch._id,
  );
  return {
    workspaceId: workspace._id.toHexString(),
    workspaceObjectId: workspace._id,
    branchId: branch._id.toHexString(),
    branchObjectId: branch._id,
    ownerUserId: owner._id.toHexString(),
    trainerUserId: trainer._id.toHexString(),
    trainerMembershipId: trainerMembership._id.toHexString(),
    ownerCtx: ctx(owner._id, ownerMembership._id),
  };
}

async function seedIndependent(container: AppContainer) {
  const db = container.database.db;
  const owner = await seedUser(db, `independent-${new ObjectId().toHexString()}@example.com`);
  const workspace = await container.workspaceRepo.create({
    type: 'INDEPENDENT_TRAINER',
    name: 'Solo Trainer',
    ownerUserId: owner._id,
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
  });
  await seedCommercial(db, workspace._id);
  const trainerMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: owner._id,
    roles: ['TRAINER'],
  });
  await assignSystemProfile(container, workspace._id, trainerMembership._id, 'TRAINER');
  return {
    workspaceId: workspace._id.toHexString(),
    workspaceObjectId: workspace._id,
    ownerUserId: owner._id.toHexString(),
    trainerMembershipId: trainerMembership._id.toHexString(),
  };
}

async function assignSystemProfile(
  container: AppContainer,
  workspaceId: ObjectId,
  membershipId: ObjectId,
  roleKey: string,
) {
  const seed = systemPermissionProfiles.find(
    (profile) => profile.context === 'WORKSPACE' && profile.roleKey === roleKey,
  );
  if (!seed) throw new Error(`missing system profile seed: ${roleKey}`);
  const profile =
    (await container.permissionProfiles.findSystemDefault({
      context: 'WORKSPACE',
      workspaceId,
      roleKey,
    })) ??
    (await container.permissionProfiles.create({
      context: 'WORKSPACE',
      workspaceId,
      roleKey,
      name: seed.name,
      permissions: seed.permissions,
      isSystemDefault: true,
    }));
  const membership = await container.workspaceMemberships.findByIdInWorkspace(
    workspaceId,
    membershipId,
  );
  if (!membership) throw new Error('membership missing');
  await container.workspaceMemberships.updateRoleAndProfileContributions(
    workspaceId,
    membershipId,
    membership.accessVersion ?? 0,
    { roles: membership.roles, permissionProfileIds: [profile._id] },
  );
}

async function activeRelationshipFromInvite(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  email: string,
) {
  const trainee = await seedUser(container.database.db, email);
  const invitation = await container.trainees.inviteTrainee(seed.ownerCtx, seed.workspaceId, {
    email: trainee.email,
    homeBranchId: seed.branchId,
    primaryTrainerMembershipId: seed.trainerMembershipId,
  });
  return await container.trainees.acceptTraineeInvitation(ctx(trainee._id), invitation.token);
}

async function seedUser(db: Db, email: string) {
  const now = new Date();
  const user = {
    _id: new ObjectId(),
    email,
    normalizedEmail: email,
    passwordHash: 'hash',
    emailVerifiedAt: now,
    firstName: 'Stage',
    lastName: 'Seven',
    preferredLanguage: 'en',
    timezone: 'Africa/Cairo',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };
  await db.collection('users').insertOne(user);
  return user;
}

async function seedCommercial(db: Db, workspaceId: ObjectId) {
  const now = new Date();
  const subscriptionId = new ObjectId();
  const termsId = new ObjectId();
  await db.collection('subscriptions').insertOne({
    _id: subscriptionId,
    workspaceId,
    lifecycleStatus: 'ACTIVE',
    currentTermsId: termsId,
    version: 0,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('subscription_terms').insertOne({
    _id: termsId,
    subscriptionId,
    workspaceId,
    billingPeriod: 'MONTHLY',
    limits: { activeTrainees: 50, activeStaff: 50, storageBytes: 1_000_000 },
    enabledFeatures: [],
    effectiveFrom: now,
    source: 'PURCHASE',
    createdBy: new ObjectId(),
    createdAt: now,
  });
  await db.collection('workspace_usage').insertOne({
    _id: new ObjectId(),
    workspaceId,
    activeTrainees: 0,
    activeStaff: 0,
    storageBytes: 0,
    reservedStorageBytes: 0,
    revision: 0,
    calculatedAt: now,
    updatedAt: now,
  });
}

async function activeTraineeUsage(db: Db, workspaceId: string) {
  const usage = await db
    .collection('workspace_usage')
    .findOne({ workspaceId: new ObjectId(workspaceId) });
  return usage?.activeTrainees;
}

function ctx(userId: ObjectId, membershipId?: ObjectId) {
  return {
    correlationId: new ObjectId().toHexString(),
    userId: userId.toHexString(),
    authSessionId: new ObjectId().toHexString(),
    ...(membershipId ? { workspaceMembershipId: membershipId.toHexString() } : {}),
    ipAddress: '127.0.0.1',
    locale: 'en',
    timezone: 'Africa/Cairo',
  };
}

function indexes(calls: Array<{ collection: string; indexes: unknown[] }>, collection: string) {
  return calls.find((call) => call.collection === collection)?.indexes;
}

function mongoUri(): string {
  return process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
}

function integrationConfig(dbName: string): AppConfig {
  return {
    env: 'test',
    app: {
      host: '0.0.0.0',
      port: 3000,
      docsEnabled: false,
      trustProxy: false,
      allowedOrigins: [],
    },
    mongo: {
      uri: mongoUri(),
      dbName,
      connectTimeoutMs: 500,
    },
    logging: { level: 'silent' },
    auth: {
      jwtActiveKeyId: 'test',
      jwtPrivateKey: 'unused',
      jwtPublicKeys: {},
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      webRefreshCookieSameSite: 'LAX',
      otpHmacSecret: 'secret',
      totpEncryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      loginIdentifierIpWindowMs: 15 * 60 * 1000,
      loginIdentifierIpMaxAttempts: 5,
      loginIdentifierIpBlockMs: 15 * 60 * 1000,
      loginIpWindowMs: 15 * 60 * 1000,
      loginIpMaxAttempts: 30,
      challengeTtlSeconds: 600,
      challengeMaxAttempts: 5,
      challengeResendCooldownSeconds: 60,
      challengeMaxSendsPerHour: 5,
      mfaChallengeTtlSeconds: 300,
      mfaChallengeMaxAttempts: 5,
      recoveryCodeCount: 10,
      passwordResetIdentifierMaxPerHour: 3,
      passwordResetIpMaxPerHour: 10,
    },
    worker: {
      id: 'test',
      outboxPollIntervalMs: 1000,
      outboxLockMs: 30_000,
      outboxMaxAttempts: 8,
      jobLeaseMs: 30_000,
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
