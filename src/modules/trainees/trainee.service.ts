import { ObjectId } from 'mongodb';
import type { AccessControlService } from '../../core/access-control/access-control.service';
import type { AuditWriter } from '../../core/audit/audit.writer';
import type { CredentialDigests } from '../../core/auth/credential-digests';
import { normalizePhoneToE164 } from '../../core/auth/phone-normalizer';
import type { TransactionContext, UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { OutboxWriter } from '../../core/events/outbox.writer';
import type { RequestContext } from '../../core/request-context/request-context';
import { normalizeEmail } from '../auth/auth.normalization';
import type { IdentityRepository } from '../identity/identity.repository';
import type { UserDocument } from '../identity/identity.types';
import { Permissions, systemPermissionProfiles } from '../permissions/permission.registry';
import type { PermissionProfileRepository } from '../permissions/permission.repository';
import type { WorkspaceUsageRepository } from '../subscriptions/subscription.repository';
import type { EntitlementService } from '../subscriptions/subscription.service';
import type { TrainingRelationshipLifecyclePort } from '../training/training.service';
import type {
  BranchRepository,
  InvitationRepository,
  MembershipBranchAssignmentRepository,
  WorkspaceMembershipRepository,
  WorkspaceRepository,
} from '../workspaces/workspace.repository';
import type {
  BranchDocument,
  InvitationDocument,
  WorkspaceDocument,
  WorkspaceMembershipDocument,
  WorkspaceMembershipRole,
} from '../workspaces/workspace.types';
import type { CoachingRelationshipRepository } from './trainee.repository';
import type {
  CoachingRelationshipDocument,
  CoachingRelationshipStatus,
  TraineeStaffAssignmentDocument,
  TraineeStaffAssignmentType,
} from './trainee.types';

const traineeCountedStatuses = new Set<CoachingRelationshipStatus>([
  'ACTIVE',
  'NEEDS_REASSIGNMENT',
]);
const reconciliationBatchSize = 25;
const staffProfileRoles = new Set<WorkspaceMembershipRole>([
  'GYM_OWNER',
  'GYM_MANAGER',
  'TRAINER',
  'ASSISTANT_TRAINER',
  'NUTRITIONIST',
  'TRAINEE',
]);

export class TraineeApplicationService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly relationships: CoachingRelationshipRepository,
    private readonly identity: IdentityRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly branches: BranchRepository,
    private readonly branchAssignments: MembershipBranchAssignmentRepository,
    private readonly invitations: InvitationRepository,
    private readonly permissionProfiles: PermissionProfileRepository,
    private readonly accessControl: AccessControlService,
    private readonly entitlements: EntitlementService,
    private readonly usage: WorkspaceUsageRepository,
    private readonly credentialDigests: CredentialDigests,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly trainingLifecycle?: TrainingRelationshipLifecyclePort,
  ) {}

  async listRelationships(
    ctx: RequestContext,
    workspaceId: string,
    filters: { status?: CoachingRelationshipStatus },
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId: id,
      permission: Permissions.TraineesRead,
      scope: { type: 'WORKSPACE' },
    });
    await this.entitlements.assert(id, 'READ');
    return page((await this.relationships.list(id, filters)).map(safeRelationship));
  }

  async getRelationship(ctx: RequestContext, workspaceId: string, relationshipId: string) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relationship = await this.requireRelationship(
      id,
      objectId(relationshipId, 'RELATIONSHIP_NOT_FOUND'),
    );
    if (!(await this.canReadRelationship(ctx, id, relationship))) throw forbidden();
    await this.entitlements.assert(id, 'READ');
    return { relationship: safeRelationship(relationship) };
  }

  async inviteTrainee(
    ctx: RequestContext,
    workspaceId: string,
    input: {
      email?: string;
      phone?: string;
      homeBranchId?: string;
      primaryTrainerMembershipId?: string;
      expiresAt?: string;
    },
    tx?: TransactionContext,
  ) {
    const actorId = actorObjectId(ctx);
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.entitlements.assert(id, 'WRITE', undefined, tx);
    const now = new Date();
    const token = this.credentialDigests.randomSecret(32);
    const response = await this.withTransaction(tx, async (tx) => {
      const workspace = await this.requireWorkspace(id, tx);
      const accessMembership = await this.requireActiveActorMembership(ctx, id, tx);
      const identifier = normalizeInviteIdentifier(input.email, input.phone);
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : addDays(now, 7);
      if (!(expiresAt > now)) throw invalid('INVITATION_EXPIRY_INVALID');
      const homeBranchId = input.homeBranchId
        ? objectId(input.homeBranchId, 'BRANCH_NOT_FOUND')
        : undefined;
      const proposedPrimaryTrainerMembershipId = await this.resolveInvitationPrimary(
        workspace,
        homeBranchId,
        input.primaryTrainerMembershipId,
        actorId,
        now,
        tx,
      );
      await this.invitations.supersedePendingForIdentifier(id, identifier, now, tx);
      const invitation = await this.invitations.create(
        {
          _id: new ObjectId(),
          workspaceId: id,
          type: 'TRAINEE_INVITATION',
          ...identifier,
          intendedRoles: ['TRAINEE'],
          branchIds: homeBranchId ? [homeBranchId] : [],
          stage7Context: {
            ...(homeBranchId ? { homeBranchId } : {}),
            ...(proposedPrimaryTrainerMembershipId ? { proposedPrimaryTrainerMembershipId } : {}),
          },
          invitedBy: actorId,
          tokenDigest: this.credentialDigests.hashHighEntropySecret(token),
          expiresAt,
          status: 'PENDING',
          createdAt: now,
          updatedAt: now,
        },
        tx,
      );
      await this.writeAudit(ctx, id, 'TraineeInvited', invitation._id, 'invite', tx, {
        membership: accessMembership,
      });
      await this.writeOutbox(
        ctx,
        id,
        'TraineeInvited',
        'invitation',
        invitation._id,
        { invitationId: invitation._id.toHexString() },
        tx,
      );
      return { invitation: safeInvitation(invitation), token };
    });
    return response;
  }

  async reissueTraineeInvitation(ctx: RequestContext, workspaceId: string, invitationId: string) {
    const actorId = actorObjectId(ctx);
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const invId = objectId(invitationId, 'INVITATION_NOT_FOUND');
    return await this.unitOfWork.withTransaction(async (tx) => {
      const membership = await this.requireActiveActorMembership(ctx, id, tx);
      const now = new Date();
      const existing = await this.invitations.findPendingByIdInWorkspace(id, invId, now, tx);
      if (existing?.type !== 'TRAINEE_INVITATION') throw invalidInvitation();
      const token = this.credentialDigests.randomSecret(32);
      const invitation = await this.invitations.rotatePendingTraineeInvitationToken(
        invId,
        id,
        existing.tokenDigest,
        this.credentialDigests.hashHighEntropySecret(token),
        addDays(now, 7),
        now,
        tx,
      );
      await this.writeAudit(
        ctx,
        id,
        'TraineeInvitationTokenReissued',
        invitation._id,
        'reissue',
        tx,
        { membership },
      );
      await this.writeOutbox(
        ctx,
        id,
        'TraineeInvitationTokenReissued',
        'invitation',
        invitation._id,
        { invitationId: invitation._id.toHexString() },
        tx,
      );
      void actorId;
      return {
        invitationId: invitation._id.toHexString(),
        token,
        expiresAt: invitation.expiresAt.toISOString(),
      };
    });
  }

  async acceptTraineeInvitation(ctx: RequestContext, token: string, tx?: TransactionContext) {
    const { user } = await this.requireAuthenticatedUser(ctx, tx);
    const now = new Date();
    const digest = this.credentialDigests.hashHighEntropySecret(token);
    return await this.withTransaction(tx, async (tx) => {
      const invitation = await this.invitations.findPendingByDigest(digest, now, tx);
      if (!invitation?.workspaceId || invitation.type !== 'TRAINEE_INVITATION')
        throw invalidInvitation();
      assertUserOwnsVerifiedInvitationIdentifier(user, invitation);
      const workspace = await this.requireWorkspace(invitation.workspaceId, tx);
      if (workspace.status !== 'ACTIVE') throw conflict('WORKSPACE_INACTIVE');
      const existing = await this.relationships.findByWorkspaceAndUser(workspace._id, user._id, tx);
      if (existing && existing.status !== 'PENDING') throw conflict('COACHING_RELATIONSHIP_EXISTS');
      const homeBranchId = await this.requireActivationHomeBranch(
        workspace,
        invitation.stage7Context?.homeBranchId,
        tx,
      );
      const membership = await this.ensureTraineeMembership(workspace._id, user._id, now, tx);
      await this.entitlements.assertAndReserveTraineeSlot(workspace._id, tx);
      const relationship =
        existing ??
        (await this.relationships.createActive(
          {
            workspaceId: workspace._id,
            traineeUserId: user._id,
            traineeMembershipId: membership._id,
            ...(homeBranchId ? { homeBranchId } : {}),
            activatedBy: user._id,
            now,
          },
          tx,
        ));
      let activated = relationship;
      if (existing) {
        activated = await this.relationships.transition(
          existing._id,
          workspace._id,
          existing.version,
          ['PENDING'],
          'ACTIVE',
          {
            traineeMembershipId: membership._id,
            ...(homeBranchId ? { homeBranchId } : {}),
            activatedBy: user._id,
            activatedAt: now,
          },
          { openEngagement: true },
          now,
          tx,
        );
      }
      const primary = await this.assignPrimaryInTransaction(
        ctx,
        workspace,
        activated,
        invitation.stage7Context?.proposedPrimaryTrainerMembershipId,
        user._id,
        now,
        tx,
      );
      activated = await this.relationships.setPrimaryPointer(
        activated._id,
        workspace._id,
        activated.version,
        ['ACTIVE'],
        primary._id,
        now,
        tx,
      );
      const accepted = await this.invitations.acceptPending(invitation._id, user._id, now, tx);
      if (!accepted) throw invalidInvitation();
      await this.writeAudit(
        ctx,
        workspace._id,
        'TraineeActivated',
        activated._id,
        'accept_invitation',
        tx,
      );
      await this.writeOutbox(
        ctx,
        workspace._id,
        'TraineeActivated',
        'coaching_relationship',
        activated._id,
        { relationshipId: activated._id.toHexString(), invitationId: invitation._id.toHexString() },
        tx,
      );
      return { relationship: safeRelationship(activated), membership: safeMembership(membership) };
    });
  }

  async joinReferral(
    ctx: RequestContext,
    code: string,
    input: { homeBranchId?: string },
    tx?: TransactionContext,
  ) {
    const actorId = actorObjectId(ctx);
    return await this.withTransaction(tx, async (tx) => {
      const now = new Date();
      const referral = await this.relationships.findReferralCode(code, now);
      if (!referral) throw notFound('REFERRAL_CODE_NOT_FOUND');
      const workspace = await this.requireWorkspace(referral.ownerWorkspaceId, tx);
      if (workspace.status !== 'ACTIVE') throw conflict('WORKSPACE_INACTIVE');
      await this.entitlements.assert(workspace._id, 'WRITE', undefined, tx);
      const existing = await this.relationships.findByWorkspaceAndUser(workspace._id, actorId, tx);
      if (existing) {
        if (existing.status === 'PENDING') return { relationship: safeRelationship(existing) };
        throw conflict('COACHING_RELATIONSHIP_EXISTS');
      }
      const homeBranchId =
        workspace.type === 'GYM'
          ? objectId(input.homeBranchId ?? '', 'BRANCH_NOT_FOUND')
          : undefined;
      if (workspace.type === 'GYM') {
        if (!homeBranchId) throw notFound('BRANCH_NOT_FOUND');
        await this.requireActiveBranch(workspace._id, homeBranchId, tx);
      }
      const proposedPrimaryTrainerMembershipId = referral.ownerUserId
        ? await this.resolveTrainerMembershipByUser(
            workspace,
            referral.ownerUserId,
            homeBranchId,
            tx,
          )
        : workspace.type === 'INDEPENDENT_TRAINER'
          ? await this.resolveIndependentPrimary(workspace, homeBranchId, tx)
          : undefined;
      const relationship = await this.relationships.createPending(
        {
          workspaceId: workspace._id,
          traineeUserId: actorId,
          ...(homeBranchId ? { homeBranchId } : {}),
          ...(proposedPrimaryTrainerMembershipId ? { proposedPrimaryTrainerMembershipId } : {}),
          requestedBy: actorId,
          now,
        },
        tx,
      );
      await this.writeAudit(
        ctx,
        workspace._id,
        'TraineeRelationshipRequested',
        relationship._id,
        'request',
        tx,
      );
      await this.writeOutbox(
        ctx,
        workspace._id,
        'TraineeRelationshipRequested',
        'coaching_relationship',
        relationship._id,
        { relationshipId: relationship._id.toHexString(), code },
        tx,
      );
      return { relationship: safeRelationship(relationship) };
    });
  }

  async acceptPending(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: { expectedVersion: number; primaryTrainerMembershipId?: string },
    tx?: TransactionContext,
  ) {
    return await this.activateExisting(
      ctx,
      workspaceId,
      relationshipId,
      input,
      'TraineeActivated',
      tx,
    );
  }

  async rejectPending(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: { expectedVersion: number; reason?: string },
    tx?: TransactionContext,
  ) {
    return await this.withRelationshipTransaction(
      ctx,
      workspaceId,
      relationshipId,
      async ({ workspace, relationship, actorId, now, tx }) => {
        const updated = await this.relationships.transition(
          relationship._id,
          workspace._id,
          input.expectedVersion,
          ['PENDING'],
          'ENDED',
          {
            endedBy: actorId,
            endedAt: now,
            ...(input.reason?.trim() ? { endReason: input.reason.trim() } : {}),
          },
          {},
          now,
          tx,
        );
        await this.writeAudit(ctx, workspace._id, 'TraineeRejected', updated._id, 'reject', tx);
        await this.writeOutbox(
          ctx,
          workspace._id,
          'TraineeRejected',
          'coaching_relationship',
          updated._id,
          { relationshipId: updated._id.toHexString() },
          tx,
        );
        return { relationship: safeRelationship(updated) };
      },
      tx,
    );
  }

  async endRelationship(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: { expectedVersion: number; reason?: string },
    tx?: TransactionContext,
  ) {
    return await this.withRelationshipTransaction(
      ctx,
      workspaceId,
      relationshipId,
      async ({ workspace, relationship, actorId, now, tx }) => {
        await this.trainingLifecycle?.closeActiveProgramForRelationshipEnd(
          ctx,
          workspace._id,
          relationship._id,
          now,
          tx,
        );
        await this.relationships.closeActiveAssignmentsForRelationship(
          relationship._id,
          actorId,
          input.reason?.trim(),
          now,
          tx,
        );
        const updated = await this.relationships.transition(
          relationship._id,
          workspace._id,
          input.expectedVersion,
          ['ACTIVE', 'NEEDS_REASSIGNMENT'],
          'ENDED',
          {
            endedBy: actorId,
            endedAt: now,
            ...(input.reason?.trim() ? { endReason: input.reason.trim() } : {}),
          },
          {
            closeEngagement:
              relationship.status === 'ACTIVE' || relationship.status === 'NEEDS_REASSIGNMENT',
          },
          now,
          tx,
        );
        await this.usage.releaseTrainee(workspace._id, tx);
        await this.removeTraineeMembershipContribution(
          workspace._id,
          relationship.traineeUserId,
          now,
          tx,
        );
        await this.writeAudit(ctx, workspace._id, 'TraineeEnded', updated._id, 'end', tx);
        await this.writeOutbox(
          ctx,
          workspace._id,
          'TraineeEnded',
          'coaching_relationship',
          updated._id,
          { relationshipId: updated._id.toHexString() },
          tx,
        );
        return { relationship: safeRelationship(updated) };
      },
      tx,
    );
  }

  async reactivateRelationship(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: { expectedVersion: number; homeBranchId?: string; primaryTrainerMembershipId?: string },
    tx?: TransactionContext,
  ) {
    return await this.activateExisting(
      ctx,
      workspaceId,
      relationshipId,
      input,
      'TraineeReactivated',
      tx,
    );
  }

  async setPrimary(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: { expectedVersion: number; primaryTrainerMembershipId: string; reason?: string },
    tx?: TransactionContext,
  ) {
    return await this.withRelationshipTransaction(
      ctx,
      workspaceId,
      relationshipId,
      async ({ workspace, relationship, actorId, now, tx }) => {
        if (workspace.type !== 'GYM' && relationship.status === 'ACTIVE')
          throw conflict('INDEPENDENT_PRIMARY_REASSIGNMENT_UNSUPPORTED');
        const target = objectId(input.primaryTrainerMembershipId, 'WORKSPACE_MEMBERSHIP_NOT_FOUND');
        await this.assertEligiblePrimary(workspace, relationship, target, tx);
        const old = await this.relationships.findActivePrimary(relationship._id, tx);
        if (old)
          await this.relationships.closeAssignment(old._id, actorId, input.reason?.trim(), now, tx);
        const assignment = await this.relationships.createAssignment(
          {
            workspaceId: workspace._id,
            relationshipId: relationship._id,
            staffMembershipId: target,
            assignmentType: 'PRIMARY_TRAINER',
            assignedBy: actorId,
            ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
            now,
          },
          tx,
        );
        const updated = await this.relationships.setPrimaryPointer(
          relationship._id,
          workspace._id,
          input.expectedVersion,
          ['ACTIVE', 'NEEDS_REASSIGNMENT'],
          assignment._id,
          now,
          tx,
        );
        await this.writeAudit(
          ctx,
          workspace._id,
          'PrimaryTrainerAssigned',
          updated._id,
          'assign_primary',
          tx,
        );
        await this.writeOutbox(
          ctx,
          workspace._id,
          'PrimaryTrainerAssigned',
          'coaching_relationship',
          updated._id,
          {
            relationshipId: updated._id.toHexString(),
            assignmentId: assignment._id.toHexString(),
            previousAssignmentId: old?._id.toHexString(),
          },
          tx,
        );
        return { relationship: safeRelationship(updated), assignment: safeAssignment(assignment) };
      },
      tx,
    );
  }

  async removePrimary(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: { expectedVersion: number; reason?: string },
    tx?: TransactionContext,
  ) {
    return await this.withRelationshipTransaction(
      ctx,
      workspaceId,
      relationshipId,
      async ({ workspace, relationship, actorId, now, tx }) => {
        if (workspace.type !== 'GYM') throw conflict('INDEPENDENT_PRIMARY_REMOVAL_UNSUPPORTED');
        const old = await this.relationships.findActivePrimary(relationship._id, tx);
        if (old)
          await this.relationships.closeAssignment(old._id, actorId, input.reason?.trim(), now, tx);
        const updated = await this.relationships.markNeedsReassignment(
          relationship._id,
          workspace._id,
          input.expectedVersion,
          now,
          tx,
        );
        await this.writeAudit(
          ctx,
          workspace._id,
          'PrimaryTrainerRemoved',
          updated._id,
          'remove_primary',
          tx,
        );
        await this.writeOutbox(
          ctx,
          workspace._id,
          'PrimaryTrainerRemoved',
          'coaching_relationship',
          updated._id,
          {
            relationshipId: updated._id.toHexString(),
            previousAssignmentId: old?._id.toHexString(),
          },
          tx,
        );
        await this.writeOutbox(
          ctx,
          workspace._id,
          'TraineeNeedsReassignment',
          'coaching_relationship',
          updated._id,
          { relationshipId: updated._id.toHexString() },
          tx,
        );
        return { relationship: safeRelationship(updated) };
      },
      tx,
    );
  }

  async changeHomeBranch(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: { expectedVersion: number; homeBranchId: string; primaryTrainerMembershipId?: string },
    tx?: TransactionContext,
  ) {
    return await this.withRelationshipTransaction(
      ctx,
      workspaceId,
      relationshipId,
      async ({ workspace, relationship, actorId, now, tx }) => {
        if (workspace.type !== 'GYM') throw conflict('HOME_BRANCH_UNSUPPORTED');
        const newBranchId = objectId(input.homeBranchId, 'BRANCH_NOT_FOUND');
        await this.requireActiveBranch(workspace._id, newBranchId, tx);
        const currentPrimary = await this.relationships.findActivePrimary(relationship._id, tx);
        let activePrimary = currentPrimary;
        if (
          currentPrimary &&
          (await this.isEligibleTrainerForBranch(
            workspace._id,
            currentPrimary.staffMembershipId,
            newBranchId,
            tx,
          ))
        ) {
          activePrimary = currentPrimary;
        } else {
          if (!input.primaryTrainerMembershipId)
            throw conflict('PRIMARY_TRAINER_REPLACEMENT_REQUIRED');
          await this.accessControl.authorize(ctx, {
            context: 'WORKSPACE',
            workspaceId: workspace._id,
            permission: Permissions.TraineesAssignmentsPrimaryManage,
            scope: { type: 'WORKSPACE' },
          });
          if (currentPrimary)
            await this.relationships.closeAssignment(
              currentPrimary._id,
              actorId,
              'home-branch-change',
              now,
              tx,
            );
          const replacement = objectId(
            input.primaryTrainerMembershipId,
            'WORKSPACE_MEMBERSHIP_NOT_FOUND',
          );
          const branchRelationship = { ...relationship, homeBranchId: newBranchId };
          await this.assertEligiblePrimary(workspace, branchRelationship, replacement, tx);
          activePrimary = await this.relationships.createAssignment(
            {
              workspaceId: workspace._id,
              relationshipId: relationship._id,
              staffMembershipId: replacement,
              assignmentType: 'PRIMARY_TRAINER',
              assignedBy: actorId,
              reason: 'home-branch-change',
              now,
            },
            tx,
          );
        }
        const updated = await this.relationships.changeHomeBranch(
          relationship._id,
          workspace._id,
          input.expectedVersion,
          newBranchId,
          activePrimary?._id,
          now,
          tx,
        );
        await this.writeAudit(
          ctx,
          workspace._id,
          'TraineeHomeBranchChanged',
          updated._id,
          'change_home_branch',
          tx,
        );
        await this.writeOutbox(
          ctx,
          workspace._id,
          'TraineeHomeBranchChanged',
          'coaching_relationship',
          updated._id,
          {
            relationshipId: updated._id.toHexString(),
            previousBranchId: relationship.homeBranchId?.toHexString(),
            newBranchId: newBranchId.toHexString(),
            primaryAssignmentId: activePrimary?._id.toHexString(),
          },
          tx,
        );
        return { relationship: safeRelationship(updated) };
      },
      tx,
    );
  }

  async addStaffAssignment(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: {
      staffMembershipId: string;
      assignmentType: 'ASSISTANT_TRAINER' | 'NUTRITIONIST';
      expectedVersion: number;
      reason?: string;
    },
    tx?: TransactionContext,
  ) {
    return await this.withRelationshipTransaction(
      ctx,
      workspaceId,
      relationshipId,
      async ({ workspace, relationship, actorId, now, tx }) => {
        if (!['ACTIVE', 'NEEDS_REASSIGNMENT'].includes(relationship.status))
          throw conflict('COACHING_RELATIONSHIP_STATUS_INVALID');
        if (relationship.version !== input.expectedVersion)
          throw conflict('COACHING_RELATIONSHIP_VERSION_CONFLICT');
        const staffMembershipId = objectId(
          input.staffMembershipId,
          'WORKSPACE_MEMBERSHIP_NOT_FOUND',
        );
        await this.assertEligibleStaffAssignment(
          workspace,
          relationship,
          staffMembershipId,
          input.assignmentType,
          tx,
        );
        const assignment = await this.relationships.createAssignment(
          {
            workspaceId: workspace._id,
            relationshipId: relationship._id,
            staffMembershipId,
            assignmentType: input.assignmentType,
            assignedBy: actorId,
            ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
            now,
          },
          tx,
        );
        await this.relationships.bumpVersion(
          relationship._id,
          workspace._id,
          input.expectedVersion,
          ['ACTIVE', 'NEEDS_REASSIGNMENT'],
          now,
          tx,
        );
        const eventType =
          input.assignmentType === 'ASSISTANT_TRAINER'
            ? 'AssistantTrainerAssigned'
            : 'NutritionistAssigned';
        await this.writeAudit(ctx, workspace._id, eventType, relationship._id, 'assign_staff', tx);
        await this.writeOutbox(
          ctx,
          workspace._id,
          eventType,
          'coaching_relationship',
          relationship._id,
          {
            relationshipId: relationship._id.toHexString(),
            assignmentId: assignment._id.toHexString(),
          },
          tx,
        );
        return { assignment: safeAssignment(assignment) };
      },
      tx,
    );
  }

  async removeStaffAssignment(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    staffMembershipId: string,
    assignmentType: 'ASSISTANT_TRAINER' | 'NUTRITIONIST',
    input: { expectedVersion: number; reason?: string },
    tx?: TransactionContext,
  ) {
    return await this.withRelationshipTransaction(
      ctx,
      workspaceId,
      relationshipId,
      async ({ workspace, relationship, actorId, now, tx }) => {
        if (!['ACTIVE', 'NEEDS_REASSIGNMENT'].includes(relationship.status))
          throw conflict('COACHING_RELATIONSHIP_STATUS_INVALID');
        if (relationship.version !== input.expectedVersion)
          throw conflict('COACHING_RELATIONSHIP_VERSION_CONFLICT');
        const staffId = objectId(staffMembershipId, 'WORKSPACE_MEMBERSHIP_NOT_FOUND');
        const assignment = await this.relationships.findActiveAssignment(
          relationship._id,
          staffId,
          assignmentType,
          tx,
        );
        if (!assignment) throw notFound('TRAINEE_ASSIGNMENT_NOT_FOUND');
        await this.relationships.closeAssignment(
          assignment._id,
          actorId,
          input.reason?.trim(),
          now,
          tx,
        );
        await this.relationships.bumpVersion(
          relationship._id,
          workspace._id,
          input.expectedVersion,
          ['ACTIVE', 'NEEDS_REASSIGNMENT'],
          now,
          tx,
        );
        const eventType =
          assignmentType === 'ASSISTANT_TRAINER'
            ? 'AssistantTrainerRemoved'
            : 'NutritionistRemoved';
        await this.writeAudit(
          ctx,
          workspace._id,
          eventType,
          relationship._id,
          'remove_staff_assignment',
          tx,
        );
        await this.writeOutbox(
          ctx,
          workspace._id,
          eventType,
          'coaching_relationship',
          relationship._id,
          {
            relationshipId: relationship._id.toHexString(),
            assignmentId: assignment._id.toHexString(),
          },
          tx,
        );
        return { removed: true };
      },
      tx,
    );
  }

  async migrateIndependentToGym(
    ctx: RequestContext,
    input: {
      sourceWorkspaceId: string;
      destinationWorkspaceId: string;
      sourceRelationshipId: string;
      destinationHomeBranchId: string;
      destinationPrimaryTrainerMembershipId: string;
      expectedSourceVersion: number;
      expectedDestinationVersion?: number;
      endSourceRelationship?: boolean;
    },
    tx?: TransactionContext,
  ) {
    const actorId = actorObjectId(ctx);
    const sourceWorkspaceId = objectId(input.sourceWorkspaceId, 'WORKSPACE_NOT_FOUND');
    const destinationWorkspaceId = objectId(input.destinationWorkspaceId, 'WORKSPACE_NOT_FOUND');
    await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId: sourceWorkspaceId,
      permission: Permissions.TraineesMigrateOut,
      scope: { type: 'WORKSPACE' },
    });
    await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId: destinationWorkspaceId,
      permission: Permissions.TraineesMigrateIn,
      scope: { type: 'WORKSPACE' },
    });
    return await this.withTransaction(tx, async (tx) => {
      const now = new Date();
      const sourceWorkspace = await this.requireWorkspace(sourceWorkspaceId, tx);
      const destinationWorkspace = await this.requireWorkspace(destinationWorkspaceId, tx);
      if (sourceWorkspace.type !== 'INDEPENDENT_TRAINER' || destinationWorkspace.type !== 'GYM')
        throw conflict('TRAINEE_MIGRATION_DIRECTION_INVALID');
      const source = await this.requireRelationship(
        sourceWorkspaceId,
        objectId(input.sourceRelationshipId, 'RELATIONSHIP_NOT_FOUND'),
        tx,
      );
      if (
        !traineeCountedStatuses.has(source.status) ||
        source.version !== input.expectedSourceVersion
      )
        throw conflict('SOURCE_RELATIONSHIP_VERSION_CONFLICT');
      const destinationBranch = objectId(input.destinationHomeBranchId, 'BRANCH_NOT_FOUND');
      await this.requireActiveBranch(destinationWorkspaceId, destinationBranch, tx);
      const existingDest = await this.relationships.findByWorkspaceAndUser(
        destinationWorkspaceId,
        source.traineeUserId,
        tx,
      );
      let destination: CoachingRelationshipDocument;
      const membership = await this.ensureTraineeMembership(
        destinationWorkspaceId,
        source.traineeUserId,
        now,
        tx,
      );
      await this.entitlements.assertAndReserveTraineeSlot(destinationWorkspaceId, tx);
      if (!existingDest) {
        if (input.expectedDestinationVersion !== undefined)
          throw conflict('DESTINATION_RELATIONSHIP_VERSION_INVALID');
        destination = await this.relationships.createActive(
          {
            workspaceId: destinationWorkspaceId,
            traineeUserId: source.traineeUserId,
            traineeMembershipId: membership._id,
            homeBranchId: destinationBranch,
            activatedBy: actorId,
            now,
          },
          tx,
        );
      } else if (existingDest.status === 'ENDED') {
        if (input.expectedDestinationVersion === undefined)
          throw conflict('DESTINATION_RELATIONSHIP_VERSION_REQUIRED');
        destination = await this.relationships.transition(
          existingDest._id,
          destinationWorkspaceId,
          input.expectedDestinationVersion,
          ['ENDED'],
          'ACTIVE',
          {
            traineeMembershipId: membership._id,
            homeBranchId: destinationBranch,
            activatedBy: actorId,
            activatedAt: now,
          },
          { openEngagement: true },
          now,
          tx,
        );
      } else {
        throw conflict('DESTINATION_RELATIONSHIP_EXISTS');
      }
      const primaryId = objectId(
        input.destinationPrimaryTrainerMembershipId,
        'WORKSPACE_MEMBERSHIP_NOT_FOUND',
      );
      await this.assertEligiblePrimary(destinationWorkspace, destination, primaryId, tx);
      const primary = await this.relationships.createAssignment(
        {
          workspaceId: destinationWorkspaceId,
          relationshipId: destination._id,
          staffMembershipId: primaryId,
          assignmentType: 'PRIMARY_TRAINER',
          assignedBy: actorId,
          reason: 'migration',
          now,
        },
        tx,
      );
      destination = await this.relationships.setPrimaryPointer(
        destination._id,
        destinationWorkspaceId,
        destination.version,
        ['ACTIVE'],
        primary._id,
        now,
        tx,
      );
      const shouldEndSource = input.endSourceRelationship ?? true;
      if (shouldEndSource) {
        await this.relationships.closeActiveAssignmentsForRelationship(
          source._id,
          actorId,
          'migration',
          now,
          tx,
        );
        await this.relationships.transition(
          source._id,
          sourceWorkspaceId,
          input.expectedSourceVersion,
          ['ACTIVE', 'NEEDS_REASSIGNMENT'],
          'ENDED',
          { endedBy: actorId, endedAt: now, endReason: 'migration' },
          { closeEngagement: true },
          now,
          tx,
        );
        await this.usage.releaseTrainee(sourceWorkspaceId, tx);
        await this.removeTraineeMembershipContribution(
          sourceWorkspaceId,
          source.traineeUserId,
          now,
          tx,
        );
      }
      if (shouldEndSource) {
        await this.writeAudit(
          ctx,
          sourceWorkspaceId,
          'TraineeEnded',
          source._id,
          'migrate_out',
          tx,
        );
      }
      await this.writeAudit(
        ctx,
        destinationWorkspaceId,
        'TraineeReactivated',
        destination._id,
        'migrate_in',
        tx,
      );
      if (shouldEndSource) {
        await this.writeOutbox(
          ctx,
          sourceWorkspaceId,
          'TraineeEnded',
          'coaching_relationship',
          source._id,
          { relationshipId: source._id.toHexString(), migration: true },
          tx,
        );
      }
      await this.writeOutbox(
        ctx,
        destinationWorkspaceId,
        'TraineeReactivated',
        'coaching_relationship',
        destination._id,
        {
          relationshipId: destination._id.toHexString(),
          sourceRelationshipId: source._id.toHexString(),
        },
        tx,
      );
      return {
        sourceRelationship: safeRelationship(source),
        destinationRelationship: safeRelationship(destination),
      };
    });
  }

  async reconcilePrimaryEligibility(
    workspaceId: ObjectId,
    staffMembershipId: ObjectId,
    reason: string,
  ) {
    let changed = 0;
    let afterId: ObjectId | undefined;
    while (true) {
      const assignments = await this.relationships.listActivePrimaryAssignmentsForStaff(
        workspaceId,
        staffMembershipId,
        { ...(afterId ? { afterId } : {}), limit: reconciliationBatchSize },
      );
      if (assignments.length === 0) break;
      afterId = assignments.at(-1)?._id;
      for (const assignment of assignments) {
        const relationship = await this.relationships.findByIdInWorkspace(
          workspaceId,
          assignment.relationshipId,
        );
        if (relationship?.status !== 'ACTIVE') continue;
        const workspace = await this.workspaces.findById(workspaceId);
        if (!workspace) continue;
        if (await this.isEligiblePrimary(workspace, relationship, staffMembershipId)) continue;
        await this.unitOfWork.withTransaction(async (tx) => {
          const fresh = await this.relationships.findByIdInWorkspace(
            workspaceId,
            relationship._id,
            tx,
          );
          if (fresh?.status !== 'ACTIVE') return;
          if (!fresh.currentPrimaryTrainerAssignmentId?.equals(assignment._id)) return;
          const primary = await this.relationships.findActivePrimaryById(
            assignment._id,
            workspaceId,
            fresh._id,
            tx,
          );
          if (!primary?.staffMembershipId.equals(staffMembershipId)) return;
          const currentWorkspace = await this.workspaces.findById(workspaceId, tx);
          if (!currentWorkspace) return;
          if (await this.isEligiblePrimary(currentWorkspace, fresh, staffMembershipId, tx)) return;
          const now = new Date();
          await this.relationships.closeAssignment(primary._id, staffMembershipId, reason, now, tx);
          const updated = await this.relationships.markNeedsReassignment(
            fresh._id,
            workspaceId,
            fresh.version,
            now,
            tx,
          );
          const systemCtx = {
            correlationId: `stage7-reconcile-${fresh._id.toHexString()}`,
            ipAddress: 'system',
            locale: 'en',
            timezone: 'UTC',
          } as RequestContext;
          await this.writeAudit(
            systemCtx,
            workspaceId,
            'TraineeNeedsReassignment',
            updated._id,
            'system_reconcile',
            tx,
          );
          await this.writeOutbox(
            systemCtx,
            workspaceId,
            'TraineeNeedsReassignment',
            'coaching_relationship',
            updated._id,
            { relationshipId: updated._id.toHexString(), reason },
            tx,
          );
          changed += 1;
        });
      }
    }
    return changed;
  }

  private async activateExisting(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: { expectedVersion: number; homeBranchId?: string; primaryTrainerMembershipId?: string },
    eventType: 'TraineeActivated' | 'TraineeReactivated',
    tx?: TransactionContext,
  ) {
    return await this.withRelationshipTransaction(
      ctx,
      workspaceId,
      relationshipId,
      async ({ workspace, relationship, actorId, now, tx }) => {
        const allowedFrom =
          eventType === 'TraineeActivated'
            ? (['PENDING'] as CoachingRelationshipStatus[])
            : (['ENDED'] as CoachingRelationshipStatus[]);
        const homeBranchId = await this.requireActivationHomeBranch(
          workspace,
          input.homeBranchId
            ? objectId(input.homeBranchId, 'BRANCH_NOT_FOUND')
            : relationship.homeBranchId,
          tx,
        );
        const membership = await this.ensureTraineeMembership(
          workspace._id,
          relationship.traineeUserId,
          now,
          tx,
        );
        await this.entitlements.assertAndReserveTraineeSlot(workspace._id, tx);
        let updated = await this.relationships.transition(
          relationship._id,
          workspace._id,
          input.expectedVersion,
          allowedFrom,
          'ACTIVE',
          {
            traineeMembershipId: membership._id,
            ...(homeBranchId ? { homeBranchId } : {}),
            activatedBy: actorId,
            activatedAt: now,
          },
          { openEngagement: true },
          now,
          tx,
        );
        const primaryId = input.primaryTrainerMembershipId
          ? objectId(input.primaryTrainerMembershipId, 'WORKSPACE_MEMBERSHIP_NOT_FOUND')
          : updated.proposedPrimaryTrainerMembershipId;
        const primary = await this.assignPrimaryInTransaction(
          ctx,
          workspace,
          updated,
          primaryId,
          actorId,
          now,
          tx,
        );
        updated = await this.relationships.setPrimaryPointer(
          updated._id,
          workspace._id,
          updated.version,
          ['ACTIVE'],
          primary._id,
          now,
          tx,
        );
        await this.writeAudit(
          ctx,
          workspace._id,
          eventType,
          updated._id,
          eventType === 'TraineeActivated' ? 'accept' : 'reactivate',
          tx,
        );
        await this.writeOutbox(
          ctx,
          workspace._id,
          eventType,
          'coaching_relationship',
          updated._id,
          { relationshipId: updated._id.toHexString() },
          tx,
        );
        return { relationship: safeRelationship(updated), membership: safeMembership(membership) };
      },
      tx,
    );
  }

  private async assignPrimaryInTransaction(
    ctx: RequestContext,
    workspace: WorkspaceDocument,
    relationship: CoachingRelationshipDocument,
    primaryId: ObjectId | undefined,
    actorId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ) {
    const target =
      primaryId ??
      (workspace.type === 'INDEPENDENT_TRAINER'
        ? await this.resolveIndependentPrimary(workspace, relationship.homeBranchId, tx)
        : undefined);
    if (!target) throw conflict('PRIMARY_TRAINER_REQUIRED');
    await this.assertEligiblePrimary(workspace, relationship, target, tx);
    const assignment = await this.relationships.createAssignment(
      {
        workspaceId: workspace._id,
        relationshipId: relationship._id,
        staffMembershipId: target,
        assignmentType: 'PRIMARY_TRAINER',
        assignedBy: actorId,
        now,
      },
      tx,
    );
    await this.writeOutbox(
      ctx,
      workspace._id,
      'PrimaryTrainerAssigned',
      'coaching_relationship',
      relationship._id,
      {
        relationshipId: relationship._id.toHexString(),
        assignmentId: assignment._id.toHexString(),
      },
      tx,
    );
    return assignment;
  }

  private async ensureTraineeMembership(
    workspaceId: ObjectId,
    userId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ) {
    let membership = await this.memberships.findByUserInWorkspace(workspaceId, userId, tx);
    const traineeProfileId = await this.requireSystemProfile(workspaceId, 'TRAINEE', tx);
    if (!membership) {
      membership = await this.memberships.createActive(
        { workspaceId, userId, roles: ['TRAINEE'], now },
        tx,
      );
    } else if (membership.status === 'ACTIVE') {
      const roles = uniqueRoles([...membership.roles, 'TRAINEE']);
      const profileIds = uniqueObjectIds([...membership.permissionProfileIds, traineeProfileId]);
      membership = await this.memberships.updateRoleAndProfileContributions(
        workspaceId,
        membership._id,
        membership.accessVersion ?? 0,
        { roles, permissionProfileIds: profileIds, now },
        tx,
      );
      return membership;
    } else if (membership.status === 'ENDED') {
      membership = await this.memberships.reactivate(
        workspaceId,
        membership._id,
        uniqueRoles([...membership.roles, 'TRAINEE']),
        now,
        tx,
      );
    } else {
      throw conflict('WORKSPACE_MEMBERSHIP_INCOMPATIBLE');
    }
    membership = await this.memberships.updateRoleAndProfileContributions(
      workspaceId,
      membership._id,
      membership.accessVersion ?? 0,
      {
        roles: uniqueRoles([...membership.roles, 'TRAINEE']),
        permissionProfileIds: uniqueObjectIds([
          ...membership.permissionProfileIds,
          traineeProfileId,
        ]),
        now,
      },
      tx,
    );
    return membership;
  }

  private async removeTraineeMembershipContribution(
    workspaceId: ObjectId,
    userId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ) {
    const membership = await this.memberships.findByUserInWorkspace(workspaceId, userId, tx);
    if (membership?.status !== 'ACTIVE') return;
    const traineeProfileId = await this.requireSystemProfile(workspaceId, 'TRAINEE', tx);
    const roles = membership.roles.filter((role) => role !== 'TRAINEE');
    const profileIds = membership.permissionProfileIds.filter((id) => !id.equals(traineeProfileId));
    if (roles.length === 0) {
      await this.memberships.updateRoleAndProfileContributions(
        workspaceId,
        membership._id,
        membership.accessVersion ?? 0,
        { roles, permissionProfileIds: profileIds, now },
        tx,
      );
      await this.memberships.transition(workspaceId, membership._id, ['ACTIVE'], 'ENDED', now, tx);
      return;
    }
    await this.memberships.updateRoleAndProfileContributions(
      workspaceId,
      membership._id,
      membership.accessVersion ?? 0,
      { roles, permissionProfileIds: profileIds, now },
      tx,
    );
  }

  private async requireSystemProfile(
    workspaceId: ObjectId,
    roleKey: WorkspaceMembershipRole,
    tx: TransactionContext,
  ): Promise<ObjectId> {
    if (!staffProfileRoles.has(roleKey)) throw conflict('WORKSPACE_ROLE_INVALID');
    const existing = await this.permissionProfiles.findSystemDefault(
      { context: 'WORKSPACE', workspaceId, roleKey },
      tx,
    );
    if (existing) return existing._id;
    const seed = systemPermissionProfiles.find(
      (profile) => profile.context === 'WORKSPACE' && profile.roleKey === roleKey,
    );
    if (!seed) throw conflict('WORKSPACE_SYSTEM_PROFILE_MISSING');
    const created = await this.permissionProfiles.create(
      {
        context: 'WORKSPACE',
        workspaceId,
        roleKey,
        name: seed.name,
        permissions: seed.permissions,
        isSystemDefault: true,
      },
      tx,
    );
    return created._id;
  }

  private async assertEligiblePrimary(
    workspace: WorkspaceDocument,
    relationship: { workspaceId: ObjectId; homeBranchId?: ObjectId | undefined },
    membershipId: ObjectId,
    tx?: TransactionContext,
  ) {
    if (!(await this.isEligiblePrimary(workspace, relationship, membershipId, tx)))
      throw conflict('PRIMARY_TRAINER_INELIGIBLE');
  }

  private async isEligiblePrimary(
    workspace: WorkspaceDocument,
    relationship: { workspaceId: ObjectId; homeBranchId?: ObjectId | undefined },
    membershipId: ObjectId,
    tx?: TransactionContext,
  ) {
    const membership = await this.memberships.findByIdInWorkspace(workspace._id, membershipId, tx);
    if (membership?.status !== 'ACTIVE' || !membership.roles.includes('TRAINER')) return false;
    if (!membership.engagementPeriods.some((period) => !period.endedAt)) return false;
    if (workspace.type === 'GYM') {
      if (!relationship.homeBranchId) return false;
      return await this.isEligibleTrainerForBranch(
        workspace._id,
        membershipId,
        relationship.homeBranchId,
        tx,
      );
    }
    return workspace.ownerUserId.equals(membership.userId);
  }

  private async isEligibleTrainerForBranch(
    workspaceId: ObjectId,
    membershipId: ObjectId,
    branchId: ObjectId,
    tx?: TransactionContext,
  ) {
    const assignments = await this.branchAssignments.listActive(workspaceId, membershipId, tx);
    return assignments.some((assignment) => assignment.branchId.equals(branchId));
  }

  private async assertEligibleStaffAssignment(
    workspace: WorkspaceDocument,
    relationship: CoachingRelationshipDocument,
    membershipId: ObjectId,
    type: TraineeStaffAssignmentType,
    tx: TransactionContext,
  ) {
    const membership = await this.memberships.findByIdInWorkspace(workspace._id, membershipId, tx);
    const requiredRole = type === 'ASSISTANT_TRAINER' ? 'ASSISTANT_TRAINER' : 'NUTRITIONIST';
    if (membership?.status !== 'ACTIVE' || !membership.roles.includes(requiredRole))
      throw conflict('TRAINEE_STAFF_ASSIGNMENT_INELIGIBLE');
    if (workspace.type === 'GYM' && relationship.homeBranchId) {
      const assignments = await this.branchAssignments.listActive(workspace._id, membershipId, tx);
      if (!assignments.some((assignment) => assignment.branchId.equals(relationship.homeBranchId)))
        throw conflict('TRAINEE_STAFF_ASSIGNMENT_BRANCH_INELIGIBLE');
    }
  }

  private async resolveInvitationPrimary(
    workspace: WorkspaceDocument,
    homeBranchId: ObjectId | undefined,
    primaryId: string | undefined,
    actorId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ) {
    if (workspace.type === 'GYM') {
      if (!homeBranchId) throw notFound('BRANCH_NOT_FOUND');
      await this.requireActiveBranch(workspace._id, homeBranchId, tx);
      if (!primaryId) throw conflict('PRIMARY_TRAINER_REQUIRED');
      const id = objectId(primaryId, 'WORKSPACE_MEMBERSHIP_NOT_FOUND');
      await this.assertEligiblePrimary(
        workspace,
        { workspaceId: workspace._id, homeBranchId },
        id,
        tx,
      );
      return id;
    }
    void actorId;
    void now;
    return await this.resolveIndependentPrimary(workspace, undefined, tx);
  }

  private async resolveTrainerMembershipByUser(
    workspace: WorkspaceDocument,
    userId: ObjectId,
    homeBranchId: ObjectId | undefined,
    tx: TransactionContext,
  ) {
    const membership = await this.memberships.findByUserInWorkspace(workspace._id, userId, tx);
    if (!membership) throw conflict('REFERRAL_OWNER_INELIGIBLE');
    await this.assertEligiblePrimary(
      workspace,
      { workspaceId: workspace._id, homeBranchId },
      membership._id,
      tx,
    );
    return membership._id;
  }

  private async resolveIndependentPrimary(
    workspace: WorkspaceDocument,
    homeBranchId: ObjectId | undefined,
    tx: TransactionContext,
  ) {
    const membership = await this.memberships.findByUserInWorkspace(
      workspace._id,
      workspace.ownerUserId,
      tx,
    );
    if (!membership) throw conflict('PRIMARY_TRAINER_REQUIRED');
    await this.assertEligiblePrimary(
      workspace,
      { workspaceId: workspace._id, homeBranchId },
      membership._id,
      tx,
    );
    return membership._id;
  }

  private async requireActivationHomeBranch(
    workspace: WorkspaceDocument,
    homeBranchId: ObjectId | undefined,
    tx: TransactionContext,
  ) {
    if (workspace.type === 'INDEPENDENT_TRAINER') return undefined;
    if (!homeBranchId) throw notFound('BRANCH_NOT_FOUND');
    await this.requireActiveBranch(workspace._id, homeBranchId, tx);
    return homeBranchId;
  }

  private async requireActiveBranch(
    workspaceId: ObjectId,
    branchId: ObjectId,
    tx?: TransactionContext,
  ): Promise<BranchDocument> {
    const branch = await this.branches.findByIdInWorkspace(workspaceId, branchId, tx);
    if (branch?.status !== 'ACTIVE') throw notFound('BRANCH_NOT_FOUND');
    return branch;
  }

  private async withRelationshipTransaction<T>(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    operation: (input: {
      workspace: WorkspaceDocument;
      relationship: CoachingRelationshipDocument;
      actorId: ObjectId;
      now: Date;
      tx: TransactionContext;
    }) => Promise<T>,
    tx?: TransactionContext,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relId = objectId(relationshipId, 'RELATIONSHIP_NOT_FOUND');
    await this.entitlements.assert(id, 'WRITE', undefined, tx);
    return await this.withTransaction(tx, async (tx) => {
      const workspace = await this.requireWorkspace(id, tx);
      const relationship = await this.requireRelationship(id, relId, tx);
      return await operation({
        workspace,
        relationship,
        actorId: actorObjectId(ctx),
        now: new Date(),
        tx,
      });
    });
  }

  private async canReadRelationship(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationship: CoachingRelationshipDocument,
  ): Promise<boolean> {
    try {
      await this.accessControl.authorize(ctx, {
        context: 'WORKSPACE',
        workspaceId,
        permission: Permissions.TraineesRead,
        scope: { type: 'WORKSPACE' },
      });
      return true;
    } catch {
      if (!ctx.userId || !ObjectId.isValid(ctx.userId)) return false;
      if (!relationship.traineeUserId.equals(new ObjectId(ctx.userId))) return false;
      const membership = await this.memberships.findByUserInWorkspace(
        workspaceId,
        relationship.traineeUserId,
      );
      return membership?.status === 'ACTIVE' && membership.roles.includes('TRAINEE');
    }
  }

  private async requireActiveActorMembership(
    ctx: RequestContext,
    workspaceId: ObjectId,
    tx?: TransactionContext,
  ) {
    const actorId = actorObjectId(ctx);
    const membership = await this.memberships.findByUserInWorkspace(workspaceId, actorId, tx);
    if (membership?.status !== 'ACTIVE') throw forbidden();
    ctx.workspaceMembershipId = membership._id.toHexString();
    return membership;
  }

  private async requireAuthenticatedUser(
    ctx: RequestContext,
    tx?: TransactionContext,
  ): Promise<{ user: UserDocument }> {
    const id = actorObjectId(ctx);
    const user = await this.identity.findById(id, tx);
    if (user?.status !== 'ACTIVE') throw forbidden();
    return { user };
  }

  private async requireWorkspace(workspaceId: ObjectId, tx?: TransactionContext) {
    const workspace = await this.workspaces.findById(workspaceId, tx);
    if (!workspace) throw notFound('WORKSPACE_NOT_FOUND');
    return workspace;
  }

  private async requireRelationship(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    tx?: TransactionContext,
  ) {
    const relationship = await this.relationships.findByIdInWorkspace(
      workspaceId,
      relationshipId,
      tx,
    );
    if (!relationship) throw notFound('RELATIONSHIP_NOT_FOUND');
    return relationship;
  }

  private async withTransaction<T>(
    tx: TransactionContext | undefined,
    operation: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    if (tx) return await operation(tx);
    return await this.unitOfWork.withTransaction(operation);
  }

  private async writeAudit(
    ctx: RequestContext,
    workspaceId: ObjectId,
    eventType: string,
    entityId: ObjectId,
    action: string,
    tx: TransactionContext,
    extra?: { membership?: WorkspaceMembershipDocument },
  ) {
    await this.audit.write(
      {
        eventType,
        workspaceId,
        actor: {
          ...(ctx.userId && ObjectId.isValid(ctx.userId)
            ? { userId: new ObjectId(ctx.userId) }
            : {}),
          ...(extra?.membership
            ? { workspaceMembershipId: extra.membership._id }
            : ctx.workspaceMembershipId && ObjectId.isValid(ctx.workspaceMembershipId)
              ? { workspaceMembershipId: new ObjectId(ctx.workspaceMembershipId) }
              : {}),
        },
        entity: { type: eventType, id: entityId },
        action,
        ipAddress: ctx.ipAddress,
        ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }

  private async writeOutbox(
    ctx: RequestContext,
    workspaceId: ObjectId,
    eventType: string,
    aggregateType: string,
    aggregateId: ObjectId,
    payload: Record<string, unknown>,
    tx: TransactionContext,
  ) {
    await this.outbox.write(
      {
        eventType,
        aggregateType,
        aggregateId,
        workspaceId,
        payload,
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }
}

function safeRelationship(relationship: CoachingRelationshipDocument) {
  return {
    id: relationship._id.toHexString(),
    workspaceId: relationship.workspaceId.toHexString(),
    traineeUserId: relationship.traineeUserId.toHexString(),
    traineeMembershipId: relationship.traineeMembershipId?.toHexString(),
    status: relationship.status,
    homeBranchId: relationship.homeBranchId?.toHexString(),
    proposedPrimaryTrainerMembershipId:
      relationship.proposedPrimaryTrainerMembershipId?.toHexString(),
    currentPrimaryTrainerAssignmentId:
      relationship.currentPrimaryTrainerAssignmentId?.toHexString(),
    engagementPeriods: relationship.engagementPeriods.map((period) => ({
      startedAt: period.startedAt.toISOString(),
      endedAt: period.endedAt?.toISOString(),
    })),
    version: relationship.version,
    createdAt: relationship.createdAt.toISOString(),
    updatedAt: relationship.updatedAt.toISOString(),
  };
}

function safeAssignment(assignment: TraineeStaffAssignmentDocument) {
  return {
    id: assignment._id.toHexString(),
    relationshipId: assignment.relationshipId.toHexString(),
    staffMembershipId: assignment.staffMembershipId.toHexString(),
    assignmentType: assignment.assignmentType,
    active: assignment.active,
    startedAt: assignment.startedAt.toISOString(),
    endedAt: assignment.endedAt?.toISOString(),
  };
}

function safeInvitation(invitation: InvitationDocument) {
  return {
    id: invitation._id.toHexString(),
    workspaceId: invitation.workspaceId?.toHexString(),
    type: invitation.type,
    email: invitation.email,
    phone: invitation.phone,
    status: invitation.status,
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

function safeMembership(membership: WorkspaceMembershipDocument) {
  return {
    id: membership._id.toHexString(),
    workspaceId: membership.workspaceId.toHexString(),
    userId: membership.userId.toHexString(),
    roles: membership.roles,
    status: membership.status,
    permissionProfileIds: membership.permissionProfileIds.map((id) => id.toHexString()),
    accessVersion: membership.accessVersion ?? 0,
  };
}

function normalizeInviteIdentifier(email?: string, phone?: string) {
  if (email && phone) throw invalid('INVITATION_IDENTIFIER_INVALID');
  if (email) return { email: email.trim(), normalizedEmail: normalizeEmail(email) };
  if (phone) return { phone: phone.trim(), normalizedPhone: normalizePhoneToE164(phone) };
  throw invalid('INVITATION_IDENTIFIER_REQUIRED');
}

function assertUserOwnsVerifiedInvitationIdentifier(
  user: UserDocument,
  invitation: InvitationDocument,
) {
  if (invitation.normalizedEmail) {
    if (user.normalizedEmail !== invitation.normalizedEmail || !user.emailVerifiedAt)
      throw invalidInvitation();
    return;
  }
  if (invitation.normalizedPhone) {
    if (user.normalizedPhone !== invitation.normalizedPhone || !user.phoneVerifiedAt)
      throw invalidInvitation();
    return;
  }
  throw invalidInvitation();
}

function page<T>(data: T[]) {
  return { data, meta: { nextCursor: null, hasMore: false } };
}

function objectId(value: string, code: string): ObjectId {
  if (!value || !ObjectId.isValid(value)) throw notFound(code);
  return new ObjectId(value);
}

function actorObjectId(ctx: RequestContext): ObjectId {
  if (!ctx.userId || !ObjectId.isValid(ctx.userId))
    throw new AppError({
      code: 'AUTH_REQUIRED',
      httpStatus: 401,
      message: 'Authentication is required.',
    });
  return new ObjectId(ctx.userId);
}

function uniqueRoles(roles: WorkspaceMembershipRole[]): WorkspaceMembershipRole[] {
  return [...new Set(roles)];
}

function uniqueObjectIds(ids: ObjectId[]): ObjectId[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    const key = id.toHexString();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function invalid(code: string): AppError {
  return new AppError({ code, httpStatus: 422, message: 'The trainee request is invalid.' });
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The coaching relationship changed.' });
}

function notFound(code: string): AppError {
  return new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
}

function forbidden(): AppError {
  return new AppError({
    code: 'PERMISSION_DENIED',
    httpStatus: 403,
    message: 'Permission denied.',
  });
}

function invalidInvitation(): AppError {
  return new AppError({
    code: 'INVITATION_INVALID',
    httpStatus: 401,
    message: 'The invitation is invalid or expired.',
  });
}
