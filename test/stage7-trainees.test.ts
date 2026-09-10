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
          async findOne() {
            return { _id: new ObjectId() };
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
    expect(indexes(calls, 'coaching_relationships')).not.toContainEqual(
      expect.objectContaining({ name: 'coaching_relationships_trainee_status' }),
    );
    expect(indexes(calls, 'referral_codes')).not.toContainEqual(
      expect.objectContaining({ name: 'referral_codes_owner_workspace_user' }),
    );
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

  test('migration 012 adds Stage 7 system-profile permissions without erasing existing defaults', async () => {
    const workspace = await container.workspaceRepo.create({
      type: 'GYM',
      name: 'Additive Migration Gym',
      ownerUserId: new ObjectId(),
      timezone: 'Africa/Cairo',
      defaultLanguage: 'en',
    });
    const existingPermission = { permission: 'workspace.read', effect: 'ALLOW' };
    await db.collection('permission_profiles').insertOne({
      _id: new ObjectId(),
      context: 'WORKSPACE',
      workspaceId: workspace._id,
      roleKey: 'GYM_OWNER',
      name: 'Gym Owner',
      permissions: [existingPermission],
      isSystemDefault: true,
      status: 'ACTIVE',
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await migration012Stage7TraineeRelationships.up(db);
    await migration012Stage7TraineeRelationships.up(db);

    const ownerProfile = await container.permissionProfiles.findSystemDefault({
      context: 'WORKSPACE',
      workspaceId: workspace._id,
      roleKey: 'GYM_OWNER',
    });
    const managerProfile = await container.permissionProfiles.findSystemDefault({
      context: 'WORKSPACE',
      workspaceId: workspace._id,
      roleKey: 'GYM_MANAGER',
    });
    const ownerPermissions = ownerProfile?.permissions.map((entry) => entry.permission) ?? [];

    expect(ownerPermissions).toContain('workspace.read');
    expect(ownerPermissions).toContain('trainees.assignments.primary.manage');
    expect(ownerPermissions.filter((permission) => permission === 'trainees.invite')).toHaveLength(
      1,
    );
    expect(managerProfile?.permissions.map((entry) => entry.permission)).toEqual(
      expect.arrayContaining([
        'trainees.read',
        'trainees.update',
        'trainees.invite',
        'trainees.accept',
        'trainees.reject',
        'trainees.end',
        'trainees.reactivate',
        'trainees.assignments.primary.manage',
        'trainees.assignments.assistant.manage',
        'trainees.assignments.nutritionist.manage',
        'trainees.migrate_in',
      ]),
    );
    expect(managerProfile?.permissions.map((entry) => entry.permission)).not.toContain(
      'platform_workspaces.manage',
    );
    expect(managerProfile?.permissions.map((entry) => entry.permission)).not.toContain(
      'trainees.migrate_out',
    );
  });

  test('referral join requires writable destination entitlement and rolls back pending state', async () => {
    const seed = await seedGym(container);
    const trainee = await seedUser(db, 'frozen-referral@example.com');
    await createReferralCode(
      db,
      seed.workspaceObjectId,
      'freeze-code',
      new ObjectId(seed.trainerUserId),
    );
    await db
      .collection('subscriptions')
      .updateOne({ workspaceId: seed.workspaceObjectId }, { $set: { lifecycleStatus: 'FROZEN' } });

    await expect(
      container.trainees.joinReferral(ctx(trainee._id), 'freeze-code', {
        homeBranchId: seed.branchId,
      }),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_FROZEN' });

    expect(
      await db.collection('coaching_relationships').countDocuments({
        workspaceId: seed.workspaceObjectId,
        traineeUserId: trainee._id,
      }),
    ).toBe(0);
    expect(
      await db.collection('workspace_memberships').countDocuments({
        workspaceId: seed.workspaceObjectId,
        userId: trainee._id,
      }),
    ).toBe(0);
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(0);

    await db
      .collection('subscriptions')
      .updateOne({ workspaceId: seed.workspaceObjectId }, { $set: { lifecycleStatus: 'ACTIVE' } });
    const joined = await container.trainees.joinReferral(ctx(trainee._id), 'freeze-code', {
      homeBranchId: seed.branchId,
    });
    expect(joined.relationship.status).toBe('PENDING');
  });

  test('stale reconciliation event is a no-op when trainer eligibility is restored inside the transaction', async () => {
    const seed = await seedGym(container);
    const accepted = await activeRelationshipFromInvite(
      container,
      seed,
      'stale-reconcile@example.com',
    );
    const relationshipId = new ObjectId(accepted.relationship.id);
    const before = await db.collection('coaching_relationships').findOne({ _id: relationshipId });
    const primaryId = before?.currentPrimaryTrainerAssignmentId;
    if (!(primaryId instanceof ObjectId)) throw new Error('primary missing');
    await container.membershipBranchAssignments.endActive(
      seed.workspaceObjectId,
      new ObjectId(seed.trainerMembershipId),
      seed.branchObjectId,
    );
    const originalWithTransaction = container.unitOfWork.withTransaction.bind(container.unitOfWork);
    let restored = false;
    container.unitOfWork.withTransaction = (async (operation) => {
      if (!restored) {
        restored = true;
        await container.membershipBranchAssignments.createActive(
          seed.workspaceObjectId,
          new ObjectId(seed.trainerMembershipId),
          seed.branchObjectId,
        );
      }
      return await originalWithTransaction(operation);
    }) as typeof container.unitOfWork.withTransaction;
    try {
      const changed = await container.trainees.reconcilePrimaryEligibility(
        seed.workspaceObjectId,
        new ObjectId(seed.trainerMembershipId),
        'stale-branch-event',
      );
      expect(changed).toBe(0);
    } finally {
      container.unitOfWork.withTransaction = originalWithTransaction;
    }

    const relationship = await db
      .collection('coaching_relationships')
      .findOne({ _id: relationshipId });
    const primary = await db.collection('trainee_staff_assignments').findOne({ _id: primaryId });
    expect(relationship?.status).toBe('ACTIVE');
    expect(relationship?.currentPrimaryTrainerAssignmentId).toEqual(primaryId);
    expect(primary?.active).toBe(true);
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(1);
    expect(
      await db.collection('outbox_events').countDocuments({
        eventType: 'TraineeNeedsReassignment',
        aggregateId: relationshipId,
      }),
    ).toBe(0);
  });

  test('reconciliation is idempotent and processes more than one batch', async () => {
    const seed = await seedGym(container);
    const relationshipIds: ObjectId[] = [];
    const relationshipDocuments = [];
    const assignmentDocuments = [];
    const now = new Date();
    for (let index = 0; index < 26; index += 1) {
      const relationshipId = new ObjectId();
      const assignmentId = new ObjectId();
      relationshipIds.push(relationshipId);
      relationshipDocuments.push({
        _id: relationshipId,
        workspaceId: seed.workspaceObjectId,
        traineeUserId: new ObjectId(),
        traineeMembershipId: new ObjectId(),
        status: 'ACTIVE',
        homeBranchId: seed.branchObjectId,
        currentPrimaryTrainerAssignmentId: assignmentId,
        engagementPeriods: [{ startedAt: now }],
        version: 1,
        activatedBy: new ObjectId(seed.ownerUserId),
        activatedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      assignmentDocuments.push({
        _id: assignmentId,
        workspaceId: seed.workspaceObjectId,
        relationshipId,
        staffMembershipId: new ObjectId(seed.trainerMembershipId),
        assignmentType: 'PRIMARY_TRAINER',
        active: true,
        startedAt: now,
        assignedBy: new ObjectId(seed.ownerUserId),
        createdAt: now,
        updatedAt: now,
      });
    }
    await db.collection('coaching_relationships').insertMany(relationshipDocuments);
    await db.collection('trainee_staff_assignments').insertMany(assignmentDocuments);
    await container.membershipBranchAssignments.endActive(
      seed.workspaceObjectId,
      new ObjectId(seed.trainerMembershipId),
      seed.branchObjectId,
    );

    const first = await container.trainees.reconcilePrimaryEligibility(
      seed.workspaceObjectId,
      new ObjectId(seed.trainerMembershipId),
      'branch-ended',
    );
    const second = await container.trainees.reconcilePrimaryEligibility(
      seed.workspaceObjectId,
      new ObjectId(seed.trainerMembershipId),
      'branch-ended',
    );

    expect(first).toBe(26);
    expect(second).toBe(0);
    expect(
      await db.collection('coaching_relationships').countDocuments({
        _id: { $in: relationshipIds },
        status: 'NEEDS_REASSIGNMENT',
      }),
    ).toBe(26);
    expect(
      await db.collection('outbox_events').countDocuments({
        eventType: 'TraineeNeedsReassignment',
        aggregateId: { $in: relationshipIds },
      }),
    ).toBe(26);
  });

  test('migration retaining source keeps source active and does not emit source ended audit or outbox', async () => {
    const gym = await seedGym(container);
    const independent = await seedIndependent(container);
    await addMigrationActorToIndependent(container, independent, new ObjectId(gym.ownerUserId));
    const source = await seedIndependentSourceRelationship(
      container,
      independent,
      'retain-source@example.com',
    );
    const beforeOutbox = await db.collection('outbox_events').countDocuments({
      workspaceId: independent.workspaceObjectId,
      eventType: 'TraineeEnded',
    });
    const beforeAudit = await db.collection('audit_events').countDocuments({
      workspaceId: independent.workspaceObjectId,
      eventType: 'TraineeEnded',
    });

    const migrated = await container.trainees.migrateIndependentToGym(gym.ownerCtx, {
      sourceWorkspaceId: independent.workspaceId,
      destinationWorkspaceId: gym.workspaceId,
      sourceRelationshipId: source.relationship._id.toHexString(),
      destinationHomeBranchId: gym.branchId,
      destinationPrimaryTrainerMembershipId: gym.trainerMembershipId,
      expectedSourceVersion: 1,
      endSourceRelationship: false,
    });

    const sourceSaved = await db
      .collection('coaching_relationships')
      .findOne({ _id: source.relationship._id });
    const sourceMembership = await db.collection('workspace_memberships').findOne({
      workspaceId: independent.workspaceObjectId,
      userId: source.trainee._id,
    });
    const sourcePrimary = await db
      .collection('trainee_staff_assignments')
      .findOne({ _id: source.primary._id });
    expect(sourceSaved?.status).toBe('ACTIVE');
    expect(sourceSaved?.version).toBe(1);
    expect(sourceMembership?.roles).toContain('TRAINEE');
    expect(sourcePrimary?.active).toBe(true);
    expect(await activeTraineeUsage(db, independent.workspaceId)).toBe(1);
    expect(migrated.destinationRelationship.status).toBe('ACTIVE');
    expect(await activeTraineeUsage(db, gym.workspaceId)).toBe(1);
    expect(
      await db.collection('outbox_events').countDocuments({
        workspaceId: independent.workspaceObjectId,
        eventType: 'TraineeEnded',
      }),
    ).toBe(beforeOutbox);
    expect(
      await db.collection('audit_events').countDocuments({
        workspaceId: independent.workspaceObjectId,
        eventType: 'TraineeEnded',
      }),
    ).toBe(beforeAudit);
  });

  test('trainee invitation tokens are replay-redacted and reissue invalidates older tokens', async () => {
    const seed = await seedGym(container);
    const trainee = await seedUser(db, 'token-reissue@example.com');
    const inviteBody = {
      email: trainee.email,
      homeBranchId: seed.branchId,
      primaryTrainerMembershipId: seed.trainerMembershipId,
    };
    const first = await container.idempotency.runInTransaction(seed.ownerCtx, {
      key: 'stage7-invite-redaction',
      routeKey: 'POST /api/v1/workspaces/:workspaceId/trainee-invitations',
      fingerprint: { workspaceId: seed.workspaceId, body: inviteBody },
      unitOfWork: container.unitOfWork,
      operation: (tx) =>
        container.trainees
          .inviteTrainee(seed.ownerCtx, seed.workspaceId, inviteBody, tx)
          .then((body) => ({
            statusCode: 201,
            body,
            storedBody: { invitation: body.invitation },
          })),
    });
    const replay = await container.idempotency.runInTransaction(seed.ownerCtx, {
      key: 'stage7-invite-redaction',
      routeKey: 'POST /api/v1/workspaces/:workspaceId/trainee-invitations',
      fingerprint: { workspaceId: seed.workspaceId, body: inviteBody },
      unitOfWork: container.unitOfWork,
      operation: () => {
        throw new Error('should replay');
      },
    });
    expect(first.body.token).toBeTruthy();
    expect((replay.body as { token?: string }).token).toBeUndefined();
    const record = await db.collection('idempotency_records').findOne({
      key: 'stage7-invite-redaction',
      routeKey: 'POST /api/v1/workspaces/:workspaceId/trainee-invitations',
    });
    expect(JSON.stringify(record?.responseBody)).not.toContain(first.body.token);
    expect(JSON.stringify(await db.collection('audit_events').find({}).toArray())).not.toContain(
      first.body.token,
    );
    expect(JSON.stringify(await db.collection('outbox_events').find({}).toArray())).not.toContain(
      first.body.token,
    );

    const reissued = await container.trainees.reissueTraineeInvitation(
      seed.ownerCtx,
      seed.workspaceId,
      first.body.invitation.id,
    );
    await expect(
      container.trainees.acceptTraineeInvitation(ctx(trainee._id), first.body.token),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    const accepted = await container.trainees.acceptTraineeInvitation(
      ctx(trainee._id),
      reissued.token,
    );
    expect(accepted.relationship.status).toBe('ACTIVE');

    const secondTrainee = await seedUser(db, 'token-reissue-second@example.com');
    const secondInvite = await container.trainees.inviteTrainee(seed.ownerCtx, seed.workspaceId, {
      email: secondTrainee.email,
      homeBranchId: seed.branchId,
      primaryTrainerMembershipId: seed.trainerMembershipId,
    });
    const tokenB = await container.trainees.reissueTraineeInvitation(
      seed.ownerCtx,
      seed.workspaceId,
      secondInvite.invitation.id,
    );
    const tokenC = await container.trainees.reissueTraineeInvitation(
      seed.ownerCtx,
      seed.workspaceId,
      secondInvite.invitation.id,
    );
    await expect(
      container.trainees.acceptTraineeInvitation(ctx(secondTrainee._id), tokenB.token),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    const invitationBeforeRace = await db
      .collection('invitations')
      .findOne({ _id: new ObjectId(secondInvite.invitation.id) });
    if (!invitationBeforeRace?.tokenDigest) throw new Error('invitation digest missing');
    const raceTokenA = container.credentialDigests.randomSecret(32);
    const raceTokenB = container.credentialDigests.randomSecret(32);
    const concurrentReissues = await Promise.allSettled([
      container.invitations.rotatePendingTraineeInvitationToken(
        new ObjectId(secondInvite.invitation.id),
        seed.workspaceObjectId,
        invitationBeforeRace.tokenDigest,
        container.credentialDigests.hashHighEntropySecret(raceTokenA),
        new Date(Date.now() + 60_000),
      ),
      container.invitations.rotatePendingTraineeInvitationToken(
        new ObjectId(secondInvite.invitation.id),
        seed.workspaceObjectId,
        invitationBeforeRace.tokenDigest,
        container.credentialDigests.hashHighEntropySecret(raceTokenB),
        new Date(Date.now() + 60_000),
      ),
    ]);
    expect(concurrentReissues.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(
      container.trainees.acceptTraineeInvitation(ctx(secondTrainee._id), tokenC.token),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    const winningToken = concurrentReissues[0]?.status === 'fulfilled' ? raceTokenA : raceTokenB;
    expect(
      await container.trainees.acceptTraineeInvitation(ctx(secondTrainee._id), winningToken),
    ).toMatchObject({ relationship: { status: 'ACTIVE' } });
  });

  test('invitation acceptance rejects unsafe states and quota failure rolls back before retry', async () => {
    const seed = await seedGym(container);
    const invited = await seedUser(db, 'invite-rollback@example.com');
    const wrong = await seedUser(db, 'invite-wrong@example.com');
    const invitation = await container.trainees.inviteTrainee(seed.ownerCtx, seed.workspaceId, {
      email: invited.email,
      homeBranchId: seed.branchId,
      primaryTrainerMembershipId: seed.trainerMembershipId,
    });
    await expect(
      container.trainees.acceptTraineeInvitation(ctx(wrong._id), invitation.token),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    await db
      .collection('subscription_terms')
      .updateOne({ workspaceId: seed.workspaceObjectId }, { $set: { 'limits.activeTrainees': 0 } });
    await expect(
      container.trainees.acceptTraineeInvitation(ctx(invited._id), invitation.token),
    ).rejects.toMatchObject({ code: 'TRAINEE_LIMIT_EXCEEDED' });
    expect(
      await db.collection('invitations').findOne({ _id: new ObjectId(invitation.invitation.id) }),
    ).toMatchObject({ status: 'PENDING' });
    expect(
      await db.collection('coaching_relationships').countDocuments({
        workspaceId: seed.workspaceObjectId,
        traineeUserId: invited._id,
        status: 'ACTIVE',
      }),
    ).toBe(0);
    expect(
      await db.collection('workspace_memberships').countDocuments({
        workspaceId: seed.workspaceObjectId,
        userId: invited._id,
      }),
    ).toBe(0);
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(0);
    await db
      .collection('subscription_terms')
      .updateOne({ workspaceId: seed.workspaceObjectId }, { $set: { 'limits.activeTrainees': 1 } });
    const accepted = await container.trainees.acceptTraineeInvitation(
      ctx(invited._id),
      invitation.token,
    );
    expect(accepted.relationship.status).toBe('ACTIVE');
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(1);

    const expiredUser = await seedUser(db, 'invite-expired@example.com');
    const expired = await container.trainees.inviteTrainee(seed.ownerCtx, seed.workspaceId, {
      email: expiredUser.email,
      homeBranchId: seed.branchId,
      primaryTrainerMembershipId: seed.trainerMembershipId,
    });
    await db
      .collection('invitations')
      .updateOne(
        { _id: new ObjectId(expired.invitation.id) },
        { $set: { expiresAt: new Date(0) } },
      );
    await expect(
      container.trainees.acceptTraineeInvitation(ctx(expiredUser._id), expired.token),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  });

  test('invalidated invitation branch or primary blocks activation without partial writes', async () => {
    const branchSeed = await seedGym(container);
    const branchUser = await seedUser(db, 'branch-invalid@example.com');
    const branchInvite = await container.trainees.inviteTrainee(
      branchSeed.ownerCtx,
      branchSeed.workspaceId,
      {
        email: branchUser.email,
        homeBranchId: branchSeed.branchId,
        primaryTrainerMembershipId: branchSeed.trainerMembershipId,
      },
    );
    await db
      .collection('branches')
      .updateOne({ _id: branchSeed.branchObjectId }, { $set: { status: 'ARCHIVED' } });
    await expect(
      container.trainees.acceptTraineeInvitation(ctx(branchUser._id), branchInvite.token),
    ).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
    expect(
      await db.collection('workspace_memberships').countDocuments({
        workspaceId: branchSeed.workspaceObjectId,
        userId: branchUser._id,
      }),
    ).toBe(0);

    const primarySeed = await seedGym(container);
    const primaryUser = await seedUser(db, 'primary-invalid@example.com');
    const primaryInvite = await container.trainees.inviteTrainee(
      primarySeed.ownerCtx,
      primarySeed.workspaceId,
      {
        email: primaryUser.email,
        homeBranchId: primarySeed.branchId,
        primaryTrainerMembershipId: primarySeed.trainerMembershipId,
      },
    );
    await container.membershipBranchAssignments.endActive(
      primarySeed.workspaceObjectId,
      new ObjectId(primarySeed.trainerMembershipId),
      primarySeed.branchObjectId,
    );
    await expect(
      container.trainees.acceptTraineeInvitation(ctx(primaryUser._id), primaryInvite.token),
    ).rejects.toMatchObject({ code: 'PRIMARY_TRAINER_INELIGIBLE' });
    expect(await activeTraineeUsage(db, primarySeed.workspaceId)).toBe(0);
  });

  test('mixed-role end preserves custom profiles and grants while trainee-only end releases once and reactivates same records', async () => {
    const seed = await seedGym(container);
    const staffTrainee = await seedUser(db, 'mixed-custom@example.com');
    const trainerProfile = await container.permissionProfiles.findSystemDefault({
      context: 'WORKSPACE',
      workspaceId: seed.workspaceObjectId,
      roleKey: 'TRAINER',
    });
    const customProfile = await container.permissionProfiles.create({
      context: 'WORKSPACE',
      workspaceId: seed.workspaceObjectId,
      name: `Custom ${new ObjectId().toHexString()}`,
      permissions: [{ permission: 'documents.read', effect: 'ALLOW' }],
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
      {
        roles: ['TRAINER'],
        permissionProfileIds: [trainerProfile?._id ?? new ObjectId(), customProfile._id],
      },
    );
    await container.accessGrants.replaceCurrent(
      'WORKSPACE_MEMBERSHIP',
      staffMembership._id,
      'WORKSPACE',
      seed.workspaceObjectId,
      [{ permission: 'documents.read', effect: 'DENY', scope: { type: 'WORKSPACE' } }],
      new ObjectId(seed.ownerUserId),
    );
    await container.membershipBranchAssignments.createActive(
      seed.workspaceObjectId,
      staffMembership._id,
      seed.branchObjectId,
    );
    const invite = await container.trainees.inviteTrainee(seed.ownerCtx, seed.workspaceId, {
      email: staffTrainee.email,
      homeBranchId: seed.branchId,
      primaryTrainerMembershipId: seed.trainerMembershipId,
    });
    const accepted = await container.trainees.acceptTraineeInvitation(
      ctx(staffTrainee._id),
      invite.token,
    );
    await container.trainees.endRelationship(
      seed.ownerCtx,
      seed.workspaceId,
      accepted.relationship.id,
      {
        expectedVersion: accepted.relationship.version,
      },
    );
    const mixedMembership = await container.workspaceMemberships.findByUserInWorkspace(
      seed.workspaceObjectId,
      staffTrainee._id,
    );
    expect(mixedMembership?.status).toBe('ACTIVE');
    expect(mixedMembership?.roles).toEqual(['TRAINER']);
    expect(mixedMembership?.permissionProfileIds).toContainEqual(customProfile._id);
    expect(mixedMembership?.permissionProfileIds).toContainEqual(trainerProfile?._id);
    expect(
      await container.accessGrants.listCurrent(
        'WORKSPACE_MEMBERSHIP',
        staffMembership._id,
        'WORKSPACE',
        seed.workspaceObjectId,
      ),
    ).toHaveLength(1);

    const traineeOnly = await activeRelationshipFromInvite(
      container,
      seed,
      'trainee-only-reactivate@example.com',
    );
    const traineeOnlyUserId = new ObjectId(traineeOnly.relationship.traineeUserId);
    const relationshipId = traineeOnly.relationship.id;
    await container.trainees.endRelationship(seed.ownerCtx, seed.workspaceId, relationshipId, {
      expectedVersion: traineeOnly.relationship.version,
    });
    await expect(
      container.trainees.endRelationship(seed.ownerCtx, seed.workspaceId, relationshipId, {
        expectedVersion: traineeOnly.relationship.version,
      }),
    ).rejects.toMatchObject({ code: 'COACHING_RELATIONSHIP_VERSION_CONFLICT' });
    const endedMembership = await container.workspaceMemberships.findByUserInWorkspace(
      seed.workspaceObjectId,
      traineeOnlyUserId,
    );
    expect(endedMembership?.status).toBe('ENDED');
    expect(endedMembership?.engagementPeriods.at(-1)?.endedAt).toBeInstanceOf(Date);
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(0);
    const reactivated = await container.trainees.reactivateRelationship(
      seed.ownerCtx,
      seed.workspaceId,
      relationshipId,
      {
        expectedVersion: traineeOnly.relationship.version + 1,
        homeBranchId: seed.branchId,
        primaryTrainerMembershipId: seed.trainerMembershipId,
      },
    );
    const reactivatedMembership = await container.workspaceMemberships.findByUserInWorkspace(
      seed.workspaceObjectId,
      traineeOnlyUserId,
    );
    expect(reactivated.relationship.status).toBe('ACTIVE');
    expect(reactivatedMembership?._id).toEqual(endedMembership?._id);
    expect(reactivatedMembership?.status).toBe('ACTIVE');
    expect(reactivatedMembership?.engagementPeriods).toHaveLength(2);
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(1);
  });

  test('quota counts relationship states, releases once, and only one final-slot activation wins', async () => {
    const seed = await seedGym(container);
    const active = await activeRelationshipFromInvite(container, seed, 'quota-active@example.com');
    await container.trainees.removePrimary(
      seed.ownerCtx,
      seed.workspaceId,
      active.relationship.id,
      {
        expectedVersion: active.relationship.version,
      },
    );
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(1);
    await container.trainees.endRelationship(
      seed.ownerCtx,
      seed.workspaceId,
      active.relationship.id,
      {
        expectedVersion: active.relationship.version + 1,
      },
    );
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(0);
    await expect(
      container.trainees.endRelationship(seed.ownerCtx, seed.workspaceId, active.relationship.id, {
        expectedVersion: active.relationship.version + 1,
      }),
    ).rejects.toMatchObject({ code: 'COACHING_RELATIONSHIP_VERSION_CONFLICT' });
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(0);

    await db
      .collection('subscription_terms')
      .updateOne({ workspaceId: seed.workspaceObjectId }, { $set: { 'limits.activeTrainees': 1 } });
    const code = `slot-${new ObjectId().toHexString()}`;
    await createReferralCode(db, seed.workspaceObjectId, code);
    const firstUser = await seedUser(db, 'slot-one@example.com');
    const secondUser = await seedUser(db, 'slot-two@example.com');
    const firstPending = await container.trainees.joinReferral(ctx(firstUser._id), code, {
      homeBranchId: seed.branchId,
    });
    const secondPending = await container.trainees.joinReferral(ctx(secondUser._id), code, {
      homeBranchId: seed.branchId,
    });
    const results = await Promise.allSettled([
      container.trainees.acceptPending(
        seed.ownerCtx,
        seed.workspaceId,
        firstPending.relationship.id,
        {
          expectedVersion: firstPending.relationship.version,
          primaryTrainerMembershipId: seed.trainerMembershipId,
        },
      ),
      container.trainees.acceptPending(
        seed.ownerCtx,
        seed.workspaceId,
        secondPending.relationship.id,
        {
          expectedVersion: secondPending.relationship.version,
          primaryTrainerMembershipId: seed.trainerMembershipId,
        },
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await activeTraineeUsage(db, seed.workspaceId)).toBe(1);
    expect(
      await db.collection('coaching_relationships').countDocuments({
        _id: {
          $in: [
            new ObjectId(firstPending.relationship.id),
            new ObjectId(secondPending.relationship.id),
          ],
        },
        status: 'ACTIVE',
      }),
    ).toBe(1);
  });

  test('migration enforces both workspace permissions, destination states, quota rollback, and history isolation', async () => {
    const gym = await seedGym(container);
    const independent = await seedIndependent(container);
    const source = await seedIndependentSourceRelationship(
      container,
      independent,
      'migration-hardening@example.com',
    );

    await expect(
      container.trainees.migrateIndependentToGym(ctx(new ObjectId(gym.ownerUserId)), {
        sourceWorkspaceId: independent.workspaceId,
        destinationWorkspaceId: gym.workspaceId,
        sourceRelationshipId: source.relationship._id.toHexString(),
        destinationHomeBranchId: gym.branchId,
        destinationPrimaryTrainerMembershipId: gym.trainerMembershipId,
        expectedSourceVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });

    await addMigrationActorToIndependent(container, independent, new ObjectId(gym.ownerUserId));
    await container.accessGrants.replaceCurrent(
      'WORKSPACE_MEMBERSHIP',
      new ObjectId(gym.ownerCtx.workspaceMembershipId),
      'WORKSPACE',
      gym.workspaceObjectId,
      [{ permission: 'trainees.migrate_in', effect: 'DENY', scope: { type: 'WORKSPACE' } }],
      new ObjectId(gym.ownerUserId),
    );
    await expect(
      container.trainees.migrateIndependentToGym(gym.ownerCtx, {
        sourceWorkspaceId: independent.workspaceId,
        destinationWorkspaceId: gym.workspaceId,
        sourceRelationshipId: source.relationship._id.toHexString(),
        destinationHomeBranchId: gym.branchId,
        destinationPrimaryTrainerMembershipId: gym.trainerMembershipId,
        expectedSourceVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await container.accessGrants.replaceCurrent(
      'WORKSPACE_MEMBERSHIP',
      new ObjectId(gym.ownerCtx.workspaceMembershipId),
      'WORKSPACE',
      gym.workspaceObjectId,
      [],
      new ObjectId(gym.ownerUserId),
    );

    await db
      .collection('subscription_terms')
      .updateOne({ workspaceId: gym.workspaceObjectId }, { $set: { 'limits.activeTrainees': 0 } });
    await expect(
      container.trainees.migrateIndependentToGym(gym.ownerCtx, {
        sourceWorkspaceId: independent.workspaceId,
        destinationWorkspaceId: gym.workspaceId,
        sourceRelationshipId: source.relationship._id.toHexString(),
        destinationHomeBranchId: gym.branchId,
        destinationPrimaryTrainerMembershipId: gym.trainerMembershipId,
        expectedSourceVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'TRAINEE_LIMIT_EXCEEDED' });
    expect(
      await db.collection('coaching_relationships').countDocuments({
        workspaceId: gym.workspaceObjectId,
        traineeUserId: source.trainee._id,
      }),
    ).toBe(0);
    expect(
      (await db.collection('coaching_relationships').findOne({ _id: source.relationship._id }))
        ?.status,
    ).toBe('ACTIVE');
    expect(await activeTraineeUsage(db, independent.workspaceId)).toBe(1);
    await db
      .collection('subscription_terms')
      .updateOne({ workspaceId: gym.workspaceObjectId }, { $set: { 'limits.activeTrainees': 2 } });

    await db.collection('coaching_relationships').insertOne({
      _id: new ObjectId(),
      workspaceId: gym.workspaceObjectId,
      traineeUserId: source.trainee._id,
      status: 'PENDING',
      homeBranchId: gym.branchObjectId,
      engagementPeriods: [],
      version: 0,
      requestedBy: source.trainee._id,
      requestedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      container.trainees.migrateIndependentToGym(gym.ownerCtx, {
        sourceWorkspaceId: independent.workspaceId,
        destinationWorkspaceId: gym.workspaceId,
        sourceRelationshipId: source.relationship._id.toHexString(),
        destinationHomeBranchId: gym.branchId,
        destinationPrimaryTrainerMembershipId: gym.trainerMembershipId,
        expectedSourceVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'DESTINATION_RELATIONSHIP_EXISTS' });
    await db.collection('coaching_relationships').deleteOne({
      workspaceId: gym.workspaceObjectId,
      traineeUserId: source.trainee._id,
    });

    const migrated = await container.trainees.migrateIndependentToGym(gym.ownerCtx, {
      sourceWorkspaceId: independent.workspaceId,
      destinationWorkspaceId: gym.workspaceId,
      sourceRelationshipId: source.relationship._id.toHexString(),
      destinationHomeBranchId: gym.branchId,
      destinationPrimaryTrainerMembershipId: gym.trainerMembershipId,
      expectedSourceVersion: 1,
    });
    const destination = await db
      .collection('coaching_relationships')
      .findOne({ _id: new ObjectId(migrated.destinationRelationship.id) });
    expect(destination?.engagementPeriods).toHaveLength(1);
    expect(destination?.engagementPeriods).not.toEqual(source.relationship.engagementPeriods);
    expect(
      await db.collection('trainee_staff_assignments').countDocuments({
        relationshipId: destination?._id,
        active: true,
      }),
    ).toBe(1);
  });

  test('referral lifecycle states and self-read boundaries remain narrow', async () => {
    const seed = await seedGym(container);
    const code = `lifecycle-${new ObjectId().toHexString()}`;
    await createReferralCode(db, seed.workspaceObjectId, code, new ObjectId(seed.trainerUserId));
    const trainee = await seedUser(db, 'referral-lifecycle@example.com');
    const other = await seedUser(db, 'referral-other@example.com');
    const pending = await container.trainees.joinReferral(ctx(trainee._id), code, {
      homeBranchId: seed.branchId,
    });
    const repeated = await container.trainees.joinReferral(ctx(trainee._id), code, {
      homeBranchId: seed.branchId,
    });
    expect(repeated.relationship.id).toBe(pending.relationship.id);
    await expect(
      container.trainees.getRelationship(
        ctx(trainee._id),
        seed.workspaceId,
        pending.relationship.id,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const accepted = await container.trainees.acceptPending(
      seed.ownerCtx,
      seed.workspaceId,
      pending.relationship.id,
      {
        expectedVersion: pending.relationship.version,
      },
    );
    expect(
      await container.trainees.getRelationship(
        ctx(trainee._id),
        seed.workspaceId,
        accepted.relationship.id,
      ),
    ).toMatchObject({ relationship: { id: accepted.relationship.id } });
    await expect(
      container.trainees.getRelationship(
        ctx(other._id),
        seed.workspaceId,
        accepted.relationship.id,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      container.trainees.joinReferral(ctx(trainee._id), code, { homeBranchId: seed.branchId }),
    ).rejects.toMatchObject({ code: 'COACHING_RELATIONSHIP_EXISTS' });
    await container.trainees.endRelationship(
      seed.ownerCtx,
      seed.workspaceId,
      accepted.relationship.id,
      {
        expectedVersion: accepted.relationship.version,
      },
    );
    await expect(
      container.trainees.joinReferral(ctx(trainee._id), code, { homeBranchId: seed.branchId }),
    ).rejects.toMatchObject({ code: 'COACHING_RELATIONSHIP_EXISTS' });
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

async function createReferralCode(
  db: Db,
  ownerWorkspaceId: ObjectId,
  code: string,
  ownerUserId?: ObjectId,
) {
  await db.collection('referral_codes').insertOne({
    _id: new ObjectId(),
    code,
    ownerWorkspaceId,
    ...(ownerUserId ? { ownerUserId } : {}),
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function addMigrationActorToIndependent(
  container: AppContainer,
  independent: Awaited<ReturnType<typeof seedIndependent>>,
  actorId: ObjectId,
) {
  const membership = await container.workspaceMemberships.createActive({
    workspaceId: independent.workspaceObjectId,
    userId: actorId,
    roles: ['TRAINER'],
  });
  await assignSystemProfile(container, independent.workspaceObjectId, membership._id, 'TRAINER');
  return membership;
}

async function seedIndependentSourceRelationship(
  container: AppContainer,
  independent: Awaited<ReturnType<typeof seedIndependent>>,
  email: string,
) {
  const db = container.database.db;
  const trainee = await seedUser(db, email);
  const membership = await container.workspaceMemberships.createActive({
    workspaceId: independent.workspaceObjectId,
    userId: trainee._id,
    roles: ['TRAINEE'],
  });
  await assignSystemProfile(container, independent.workspaceObjectId, membership._id, 'TRAINEE');
  await db
    .collection('workspace_usage')
    .updateOne({ workspaceId: independent.workspaceObjectId }, { $set: { activeTrainees: 1 } });
  const relationship = await container.coachingRelationships.createActive({
    workspaceId: independent.workspaceObjectId,
    traineeUserId: trainee._id,
    traineeMembershipId: membership._id,
    activatedBy: new ObjectId(independent.ownerUserId),
  });
  const primary = await container.coachingRelationships.createAssignment({
    workspaceId: independent.workspaceObjectId,
    relationshipId: relationship._id,
    staffMembershipId: new ObjectId(independent.trainerMembershipId),
    assignmentType: 'PRIMARY_TRAINER',
    assignedBy: new ObjectId(independent.ownerUserId),
  });
  const active = await container.coachingRelationships.setPrimaryPointer(
    relationship._id,
    independent.workspaceObjectId,
    relationship.version,
    ['ACTIVE'],
    primary._id,
  );
  return { trainee, membership, relationship: active, primary };
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
