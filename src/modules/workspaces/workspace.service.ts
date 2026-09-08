import { ObjectId } from 'mongodb';
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
import type { PlatformMembershipRepository } from '../platform/platform.repository';
import type { PlatformMembershipDocument } from '../platform/platform.types';
import type {
  BranchRepository,
  InvitationRepository,
  MembershipBranchAssignmentRepository,
  WorkspaceMembershipRepository,
  WorkspaceRepository,
} from './workspace.repository';
import type {
  BranchDocument,
  InvitationDocument,
  MembershipBranchAssignmentDocument,
  WorkspaceDocument,
  WorkspaceMembershipDocument,
  WorkspaceMembershipRole,
  WorkspaceType,
} from './workspace.types';

export class WorkspaceApplicationService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly identity: IdentityRepository,
    private readonly platformMemberships: PlatformMembershipRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly branches: BranchRepository,
    private readonly branchAssignments: MembershipBranchAssignmentRepository,
    private readonly invitations: InvitationRepository,
    private readonly credentialDigests: CredentialDigests,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async me(ctx: RequestContext) {
    const { user, session } = await this.requireAuthenticatedUser(ctx, { allowRestricted: true });
    return {
      user: safeUser(user),
      session: {
        id: session.id,
        restrictedUntilVerified: session.restrictedUntilVerified,
        mfaSatisfied: session.mfaSatisfied,
      },
    };
  }

  async listMyWorkspaces(ctx: RequestContext) {
    const { user } = await this.requireAuthenticatedUser(ctx);
    const memberships = await this.memberships.listActiveByUser(user._id);
    const rows = await Promise.all(
      memberships.map(async (membership) => {
        const workspace = await this.workspaces.findById(membership.workspaceId);
        if (workspace?.status !== 'ACTIVE') return null;
        return {
          workspace: safeWorkspace(workspace),
          membership: safeMembership(membership),
        };
      }),
    );
    return rows.filter((row): row is NonNullable<typeof row> => Boolean(row));
  }

  async createWorkspace(
    ctx: RequestContext,
    input: {
      type: WorkspaceType;
      name: string;
      ownerUserId: string;
      timezone: string;
      defaultLanguage: 'ar' | 'en';
      country?: string;
      city?: string;
      governorate?: string;
    },
  ) {
    const actor = await this.requirePlatformAccess(ctx);
    const ownerUserId = objectId(input.ownerUserId, 'USER_NOT_FOUND');
    const owner = await this.identity.findById(ownerUserId);
    if (owner?.status !== 'ACTIVE') throw notFound('USER_NOT_FOUND', 'User not found.');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const workspace = await this.workspaces.create(
        {
          type: input.type,
          name: input.name.trim(),
          ownerUserId,
          timezone: input.timezone,
          defaultLanguage: input.defaultLanguage,
          ...compact({
            country: input.country,
            city: input.city,
            governorate: input.governorate,
          }),
          now,
        },
        tx,
      );
      const ownerMembership = await this.memberships.createActive(
        {
          workspaceId: workspace._id,
          userId: ownerUserId,
          roles: [input.type === 'GYM' ? 'GYM_OWNER' : 'TRAINER'],
          now,
        },
        tx,
      );
      await this.writeBusinessAudit(ctx, actor, 'WorkspaceCreated', workspace, 'create', tx);
      await this.writeOutbox(
        ctx,
        workspace._id,
        'WorkspaceCreated',
        'workspace',
        workspace._id,
        {
          ownerMembershipId: ownerMembership._id.toHexString(),
        },
        tx,
      );
      return {
        workspace: safeWorkspace(workspace),
        ownerMembership: safeMembership(ownerMembership),
      };
    });
  }

  async listPlatformMemberships(ctx: RequestContext) {
    await this.requirePlatformAccess(ctx);
    return (await this.platformMemberships.list()).map(safePlatformMembership);
  }

  async createPlatformMembership(ctx: RequestContext, userId: string) {
    const actor = await this.requirePlatformAccess(ctx);
    const targetUserId = objectId(userId, 'USER_NOT_FOUND');
    const targetUser = await this.identity.findById(targetUserId);
    if (targetUser?.status !== 'ACTIVE') throw notFound('USER_NOT_FOUND', 'User not found.');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const existing = await this.platformMemberships.findByUserId(targetUserId, tx);
      if (existing) {
        throw new AppError({
          code: 'PLATFORM_MEMBERSHIP_EXISTS',
          httpStatus: 409,
          message: 'The user already has a Platform membership. Use lifecycle commands.',
          details: { status: existing.status },
        });
      }
      const membership = await this.platformMemberships.createActive(targetUserId, now, tx);
      await this.writeBusinessAudit(
        ctx,
        actor,
        'PlatformMembershipCreated',
        membership,
        'create',
        tx,
      );
      return safePlatformMembership(membership);
    });
  }

  async transitionPlatformMembership(
    ctx: RequestContext,
    platformMembershipId: string,
    command: 'suspend' | 'reactivate' | 'end',
  ) {
    const actor = await this.requirePlatformAccess(ctx);
    const id = objectId(platformMembershipId, 'PLATFORM_MEMBERSHIP_NOT_FOUND');
    const transition =
      command === 'suspend'
        ? { from: ['ACTIVE'] as const, to: 'SUSPENDED' as const }
        : command === 'reactivate'
          ? { from: ['SUSPENDED', 'ENDED'] as const, to: 'ACTIVE' as const }
          : { from: ['ACTIVE', 'SUSPENDED'] as const, to: 'ENDED' as const };
    return await this.unitOfWork.withTransaction(async (tx) => {
      const membership = await this.platformMemberships.transition(
        id,
        [...transition.from],
        transition.to,
        new Date(),
        tx,
      );
      await this.writeBusinessAudit(
        ctx,
        actor,
        'PlatformMembershipChanged',
        membership,
        command,
        tx,
      );
      return safePlatformMembership(membership);
    });
  }

  async getWorkspace(ctx: RequestContext, workspaceId: string) {
    const { workspace, membership } = await this.requireWorkspaceAccess(ctx, workspaceId);
    return { workspace: safeWorkspace(workspace), membership: safeMembership(membership) };
  }

  async listBranches(ctx: RequestContext, workspaceId: string) {
    const { workspace } = await this.requireWorkspaceAccess(ctx, workspaceId);
    return (await this.branches.listByWorkspace(workspace._id)).map(safeBranch);
  }

  async createBranch(
    ctx: RequestContext,
    workspaceId: string,
    input: {
      name: string;
      code?: string;
      timezone?: string;
      address?: string;
      city?: string;
      governorate?: string;
    },
  ) {
    const access = await this.requireWorkspaceAccess(ctx, workspaceId);
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const branch = await this.branches.create(
        {
          workspaceId: access.workspace._id,
          name: input.name.trim(),
          timezone: input.timezone ?? access.workspace.timezone,
          ...compact({
            code: input.code?.trim(),
            address: input.address,
            city: input.city,
            governorate: input.governorate,
          }),
          now,
        },
        tx,
      );
      await this.writeBusinessAudit(ctx, access, 'BranchCreated', branch, 'create', tx);
      await this.writeOutbox(
        ctx,
        access.workspace._id,
        'BranchCreated',
        'branch',
        branch._id,
        {},
        tx,
      );
      return safeBranch(branch);
    });
  }

  async archiveBranch(ctx: RequestContext, workspaceId: string, branchId: string) {
    const access = await this.requireWorkspaceAccess(ctx, workspaceId);
    const branchObjectId = objectId(branchId, 'BRANCH_NOT_FOUND');
    return await this.unitOfWork.withTransaction(async (tx) => {
      const branch = await this.branches.archive(
        access.workspace._id,
        branchObjectId,
        new Date(),
        tx,
      );
      await this.writeBusinessAudit(ctx, access, 'BranchArchived', branch, 'archive', tx);
      await this.writeOutbox(
        ctx,
        access.workspace._id,
        'BranchArchived',
        'branch',
        branch._id,
        {},
        tx,
      );
      return safeBranch(branch);
    });
  }

  async listMemberships(ctx: RequestContext, workspaceId: string) {
    const { workspace } = await this.requireWorkspaceAccess(ctx, workspaceId);
    return (await this.memberships.listByWorkspace(workspace._id)).map(safeMembership);
  }

  async transitionMembership(
    ctx: RequestContext,
    workspaceId: string,
    membershipId: string,
    command: 'suspend' | 'reactivate' | 'end',
  ) {
    const access = await this.requireWorkspaceAccess(ctx, workspaceId);
    const id = objectId(membershipId, 'WORKSPACE_MEMBERSHIP_NOT_FOUND');
    const now = new Date();
    const transition =
      command === 'suspend'
        ? { from: ['ACTIVE'] as const, to: 'SUSPENDED' as const, event: 'StaffMembershipSuspended' }
        : command === 'reactivate'
          ? {
              from: ['SUSPENDED', 'ENDED'] as const,
              to: 'ACTIVE' as const,
              event: 'StaffMembershipActivated',
            }
          : {
              from: ['ACTIVE', 'SUSPENDED'] as const,
              to: 'ENDED' as const,
              event: 'StaffMembershipEnded',
            };

    return await this.unitOfWork.withTransaction(async (tx) => {
      const membership = await this.memberships.transition(
        access.workspace._id,
        id,
        [...transition.from],
        transition.to,
        now,
        tx,
      );
      await this.writeBusinessAudit(ctx, access, transition.event, membership, command, tx);
      await this.writeOutbox(
        ctx,
        access.workspace._id,
        transition.event,
        'workspace_membership',
        membership._id,
        {},
        tx,
      );
      return safeMembership(membership);
    });
  }

  async inviteStaff(
    ctx: RequestContext,
    workspaceId: string,
    input: {
      email?: string;
      phone?: string;
      roles: WorkspaceMembershipRole[];
      branchIds?: string[];
      expiresAt?: string;
    },
  ) {
    const access = await this.requireWorkspaceAccess(ctx, workspaceId);
    const identifier = normalizeInviteIdentifier(input.email, input.phone);
    const now = new Date();
    const expiresAt = input.expiresAt
      ? new Date(input.expiresAt)
      : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    if (!(expiresAt > now)) {
      throw new AppError({
        code: 'INVITATION_EXPIRY_INVALID',
        httpStatus: 422,
        message: 'Invitation expiry must be in the future.',
      });
    }
    const branchIds = (input.branchIds ?? []).map((id) => objectId(id, 'BRANCH_NOT_FOUND'));
    const token = this.credentialDigests.randomSecret(32);
    const invitation = await this.unitOfWork.withTransaction(async (tx) => {
      for (const branchId of branchIds) {
        const branch = await this.branches.findByIdInWorkspace(access.workspace._id, branchId, tx);
        if (branch?.status !== 'ACTIVE') throw notFound('BRANCH_NOT_FOUND', 'Branch not found.');
      }
      await this.invitations.supersedePendingForIdentifier(
        access.workspace._id,
        identifier,
        now,
        tx,
      );
      const created = await this.invitations.create(
        {
          _id: new ObjectId(),
          workspaceId: access.workspace._id,
          type: 'STAFF_INVITATION',
          ...identifier,
          intendedRoles: input.roles,
          branchIds,
          invitedBy: access.user._id,
          tokenDigest: this.credentialDigests.hashHighEntropySecret(token),
          expiresAt,
          status: 'PENDING',
          createdAt: now,
          updatedAt: now,
        },
        tx,
      );
      await this.writeBusinessAudit(ctx, access, 'StaffInvited', created, 'invite', tx);
      await this.writeOutbox(
        ctx,
        access.workspace._id,
        'StaffInvited',
        'invitation',
        created._id,
        {},
        tx,
      );
      return created;
    });
    return { invitation: safeInvitation(invitation), token };
  }

  async acceptInvitation(ctx: RequestContext, token: string) {
    const { user } = await this.requireAuthenticatedUser(ctx);
    const now = new Date();
    const digest = this.credentialDigests.hashHighEntropySecret(token);
    const invitation = await this.invitations.findPendingByDigest(digest, now);
    if (!invitation?.workspaceId) throw invalidInvitation();
    assertUserOwnsVerifiedInvitationIdentifier(user, invitation);
    return await this.unitOfWork.withTransaction(async (tx) => {
      const freshInvitation = await this.invitations.findPendingByDigest(digest, now, tx);
      if (!freshInvitation?.workspaceId) throw invalidInvitation();
      const workspace = await this.workspaces.findById(freshInvitation.workspaceId, tx);
      if (workspace?.status !== 'ACTIVE') {
        throw new AppError({
          code: 'WORKSPACE_INACTIVE',
          httpStatus: 409,
          message: 'The workspace cannot currently accept invitations.',
        });
      }
      const membership = await this.createOrReactivateMembershipFromInvitation(
        freshInvitation,
        user._id,
        now,
        tx,
      );
      for (const branchId of freshInvitation.branchIds) {
        const branch = await this.branches.findByIdInWorkspace(workspace._id, branchId, tx);
        if (branch?.status !== 'ACTIVE') throw invalidInvitation();
        await this.branchAssignments.createActive(workspace._id, membership._id, branchId, now, tx);
      }
      const accepted = await this.invitations.acceptPending(freshInvitation._id, user._id, now, tx);
      if (!accepted) throw invalidInvitation();
      const access = { user, workspace, membership };
      await this.writeBusinessAudit(
        ctx,
        access,
        'StaffMembershipActivated',
        membership,
        'accept',
        tx,
      );
      await this.writeOutbox(
        ctx,
        workspace._id,
        'StaffMembershipActivated',
        'workspace_membership',
        membership._id,
        { invitationId: freshInvitation._id.toHexString() },
        tx,
      );
      return { workspace: safeWorkspace(workspace), membership: safeMembership(membership) };
    });
  }

  async revokeInvitation(ctx: RequestContext, workspaceId: string, invitationId: string) {
    const access = await this.requireWorkspaceAccess(ctx, workspaceId);
    const id = objectId(invitationId, 'INVITATION_NOT_FOUND');
    return await this.unitOfWork.withTransaction(async (tx) => {
      const invitation = await this.invitations.revokePending(
        access.workspace._id,
        id,
        new Date(),
        tx,
      );
      await this.writeBusinessAudit(
        ctx,
        access,
        'StaffInvitationRevoked',
        invitation,
        'revoke',
        tx,
      );
      await this.writeOutbox(
        ctx,
        access.workspace._id,
        'StaffInvitationRevoked',
        'invitation',
        invitation._id,
        {},
        tx,
      );
      return safeInvitation(invitation);
    });
  }

  async listMembershipBranchAssignments(
    ctx: RequestContext,
    workspaceId: string,
    membershipId: string,
  ) {
    const access = await this.requireWorkspaceAccess(ctx, workspaceId);
    const id = objectId(membershipId, 'WORKSPACE_MEMBERSHIP_NOT_FOUND');
    await this.requireMembershipInWorkspace(access.workspace._id, id);
    return (await this.branchAssignments.listActive(access.workspace._id, id)).map(safeAssignment);
  }

  async assignMembershipBranch(
    ctx: RequestContext,
    workspaceId: string,
    membershipId: string,
    branchId: string,
  ) {
    const access = await this.requireWorkspaceAccess(ctx, workspaceId);
    const memberId = objectId(membershipId, 'WORKSPACE_MEMBERSHIP_NOT_FOUND');
    const branchObjectId = objectId(branchId, 'BRANCH_NOT_FOUND');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const membership = await this.requireMembershipInWorkspace(
        access.workspace._id,
        memberId,
        tx,
      );
      if (membership.status !== 'ACTIVE') {
        throw new AppError({
          code: 'WORKSPACE_MEMBERSHIP_INACTIVE',
          httpStatus: 409,
          message: 'Inactive workspace memberships cannot receive branch assignments.',
        });
      }
      const branch = await this.branches.findByIdInWorkspace(
        access.workspace._id,
        branchObjectId,
        tx,
      );
      if (branch?.status !== 'ACTIVE') throw notFound('BRANCH_NOT_FOUND', 'Branch not found.');
      const assignment = await this.branchAssignments.createActive(
        access.workspace._id,
        memberId,
        branchObjectId,
        now,
        tx,
      );
      await this.writeBusinessAudit(
        ctx,
        access,
        'MembershipBranchAssigned',
        assignment,
        'assign',
        tx,
      );
      return safeAssignment(assignment);
    });
  }

  async removeMembershipBranchAssignment(
    ctx: RequestContext,
    workspaceId: string,
    membershipId: string,
    branchId: string,
  ) {
    const access = await this.requireWorkspaceAccess(ctx, workspaceId);
    const memberId = objectId(membershipId, 'WORKSPACE_MEMBERSHIP_NOT_FOUND');
    const branchObjectId = objectId(branchId, 'BRANCH_NOT_FOUND');
    return await this.unitOfWork.withTransaction(async (tx) => {
      await this.requireMembershipInWorkspace(access.workspace._id, memberId, tx);
      const removed = await this.branchAssignments.endActive(
        access.workspace._id,
        memberId,
        branchObjectId,
        new Date(),
        tx,
      );
      if (!removed) throw notFound('BRANCH_ASSIGNMENT_NOT_FOUND', 'Branch assignment not found.');
      await this.writeBusinessAudit(
        ctx,
        access,
        'MembershipBranchAssignmentEnded',
        memberId,
        'remove',
        tx,
      );
      return { success: true as const };
    });
  }

  private async createOrReactivateMembershipFromInvitation(
    invitation: InvitationDocument,
    userId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ): Promise<WorkspaceMembershipDocument> {
    if (!invitation.workspaceId) throw invalidInvitation();
    const existing = await this.memberships.findByUserInWorkspace(
      invitation.workspaceId,
      userId,
      tx,
    );
    if (!existing) {
      return await this.memberships.createActive(
        { workspaceId: invitation.workspaceId, userId, roles: invitation.intendedRoles, now },
        tx,
      );
    }
    if (existing.status === 'ACTIVE') return existing;
    if (existing.status === 'SUSPENDED' || existing.status === 'ENDED') {
      return await this.memberships.reactivate(existing._id, invitation.intendedRoles, now, tx);
    }
    throw new AppError({
      code: 'WORKSPACE_MEMBERSHIP_REACTIVATION_INVALID',
      httpStatus: 409,
      message: 'The workspace membership cannot be reactivated by this invitation.',
    });
  }

  private async requireAuthenticatedUser(
    ctx: RequestContext,
    options: { allowRestricted?: boolean } = {},
  ) {
    if (!ctx.userId || !ctx.authSessionId) throw authRequired();
    const user = await this.identity.findById(objectId(ctx.userId, 'AUTH_REQUIRED'));
    if (user?.status !== 'ACTIVE') throw authRequired();
    if (ctx.restrictedUntilVerified && !options.allowRestricted) {
      throw new AppError({
        code: 'AUTH_SESSION_RESTRICTED',
        httpStatus: 403,
        message: 'The account must verify a login identifier before continuing.',
      });
    }
    return {
      user,
      session: {
        id: ctx.authSessionId,
        restrictedUntilVerified: Boolean(ctx.restrictedUntilVerified),
        mfaSatisfied: Boolean(ctx.mfaSatisfied),
      },
    };
  }

  private async requirePlatformAccess(ctx: RequestContext) {
    const { user } = await this.requireAuthenticatedUser(ctx);
    if (!ctx.mfaSatisfied) {
      throw new AppError({
        code: 'TWO_FACTOR_REQUIRED',
        httpStatus: 403,
        message: 'MFA is required for Platform access.',
      });
    }
    const membership = await this.platformMemberships.findActiveByUserId(user._id);
    if (!membership) {
      throw new AppError({
        code: 'PLATFORM_ACCESS_DENIED',
        httpStatus: 403,
        message: 'Platform access is denied.',
      });
    }
    ctx.platformMembershipId = membership._id.toHexString();
    return { user, platformMembership: membership };
  }

  private async requireWorkspaceAccess(ctx: RequestContext, workspaceId: string) {
    const { user } = await this.requireAuthenticatedUser(ctx);
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const [workspace, membership] = await Promise.all([
      this.workspaces.findById(id),
      this.memberships.findByUserInWorkspace(id, user._id),
    ]);
    if (!workspace || !membership) throw notFound('WORKSPACE_NOT_FOUND', 'Workspace not found.');
    if (workspace.status !== 'ACTIVE') {
      throw new AppError({
        code: 'WORKSPACE_INACTIVE',
        httpStatus: 409,
        message: 'The workspace is not active.',
      });
    }
    if (membership.status !== 'ACTIVE') {
      throw new AppError({
        code: 'WORKSPACE_ACCESS_DENIED',
        httpStatus: 403,
        message: 'Workspace access is denied.',
      });
    }
    ctx.workspaceId = id.toHexString();
    ctx.workspaceMembershipId = membership._id.toHexString();
    return { user, workspace, membership };
  }

  private async requireMembershipInWorkspace(
    workspaceId: ObjectId,
    membershipId: ObjectId,
    tx?: TransactionContext,
  ) {
    const membership = await this.memberships.findByIdInWorkspace(workspaceId, membershipId, tx);
    if (!membership) {
      throw notFound('WORKSPACE_MEMBERSHIP_NOT_FOUND', 'Workspace membership not found.');
    }
    return membership;
  }

  private async writeBusinessAudit(
    ctx: RequestContext,
    access: {
      user: UserDocument;
      workspace?: WorkspaceDocument;
      membership?: WorkspaceMembershipDocument;
      platformMembership?: PlatformMembershipDocument;
    },
    eventType: string,
    entity: { _id: ObjectId } | ObjectId,
    action: string,
    tx: TransactionContext,
  ) {
    const entityId = entity instanceof ObjectId ? entity : entity._id;
    await this.audit.write(
      {
        eventType,
        ...compact({ workspaceId: access.workspace?._id, userAgent: ctx.userAgent }),
        actor: {
          userId: access.user._id,
          ...(access.platformMembership
            ? { platformMembershipId: access.platformMembership._id }
            : {}),
          ...(access.membership ? { workspaceMembershipId: access.membership._id } : {}),
        },
        entity: { type: eventType, id: entityId },
        action,
        ipAddress: ctx.ipAddress,
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

function normalizeInviteIdentifier(email?: string, phone?: string) {
  if (email && phone) {
    throw new AppError({
      code: 'INVITATION_IDENTIFIER_INVALID',
      httpStatus: 422,
      message: 'Invite exactly one email or phone identifier.',
    });
  }
  if (email) {
    const normalizedEmail = normalizeEmail(email);
    return { email: email.trim(), normalizedEmail };
  }
  if (phone) {
    const normalizedPhone = normalizePhoneToE164(phone);
    return { phone: phone.trim(), normalizedPhone };
  }
  throw new AppError({
    code: 'INVITATION_IDENTIFIER_REQUIRED',
    httpStatus: 422,
    message: 'Invite an email or phone identifier.',
  });
}

function assertUserOwnsVerifiedInvitationIdentifier(
  user: UserDocument,
  invitation: InvitationDocument,
) {
  const emailMatches =
    invitation.normalizedEmail &&
    user.normalizedEmail === invitation.normalizedEmail &&
    Boolean(user.emailVerifiedAt);
  const phoneMatches =
    invitation.normalizedPhone &&
    user.normalizedPhone === invitation.normalizedPhone &&
    Boolean(user.phoneVerifiedAt);
  if (!emailMatches && !phoneMatches) throw invalidInvitation();
}

function safeUser(user: UserDocument) {
  return {
    id: user._id.toHexString(),
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone,
    emailVerified: Boolean(user.emailVerifiedAt),
    phoneVerified: Boolean(user.phoneVerifiedAt),
    status: user.status,
  };
}

function safeWorkspace(workspace: WorkspaceDocument) {
  return {
    id: workspace._id.toHexString(),
    type: workspace.type,
    name: workspace.name,
    ownerUserId: workspace.ownerUserId.toHexString(),
    status: workspace.status,
    timezone: workspace.timezone,
    defaultLanguage: workspace.defaultLanguage,
    country: workspace.country,
    city: workspace.city,
    governorate: workspace.governorate,
  };
}

function safePlatformMembership(membership: PlatformMembershipDocument) {
  return {
    id: membership._id.toHexString(),
    userId: membership.userId.toHexString(),
    status: membership.status,
    createdAt: membership.createdAt.toISOString(),
    updatedAt: membership.updatedAt.toISOString(),
    suspendedAt: membership.suspendedAt?.toISOString(),
    endedAt: membership.endedAt?.toISOString(),
  };
}

function safeMembership(membership: WorkspaceMembershipDocument) {
  return {
    id: membership._id.toHexString(),
    workspaceId: membership.workspaceId.toHexString(),
    userId: membership.userId.toHexString(),
    roles: membership.roles,
    status: membership.status,
    joinedAt: membership.joinedAt.toISOString(),
    endedAt: membership.endedAt?.toISOString(),
  };
}

function safeBranch(branch: BranchDocument) {
  return {
    id: branch._id.toHexString(),
    workspaceId: branch.workspaceId.toHexString(),
    name: branch.name,
    code: branch.code,
    timezone: branch.timezone,
    status: branch.status,
    address: branch.address,
    city: branch.city,
    governorate: branch.governorate,
  };
}

function safeInvitation(invitation: InvitationDocument) {
  return {
    id: invitation._id.toHexString(),
    workspaceId: invitation.workspaceId?.toHexString(),
    type: invitation.type,
    email: invitation.email,
    phone: invitation.phone,
    intendedRoles: invitation.intendedRoles,
    branchIds: invitation.branchIds.map((id) => id.toHexString()),
    expiresAt: invitation.expiresAt.toISOString(),
    status: invitation.status,
  };
}

function safeAssignment(assignment: MembershipBranchAssignmentDocument) {
  return {
    id: assignment._id.toHexString(),
    workspaceId: assignment.workspaceId.toHexString(),
    membershipId: assignment.membershipId.toHexString(),
    branchId: assignment.branchId.toHexString(),
    active: assignment.active,
    startedAt: assignment.startedAt.toISOString(),
    endedAt: assignment.endedAt?.toISOString(),
  };
}

function objectId(value: string, code: string): ObjectId {
  if (!ObjectId.isValid(value)) throw notFound(code, 'Resource not found.');
  return new ObjectId(value);
}

function authRequired(): AppError {
  return new AppError({
    code: 'AUTH_REQUIRED',
    httpStatus: 401,
    message: 'Authentication is required.',
  });
}

function invalidInvitation(): AppError {
  return new AppError({
    code: 'INVITATION_INVALID',
    httpStatus: 401,
    message: 'The invitation is invalid or expired.',
  });
}

function notFound(code: string, message: string): AppError {
  return new AppError({ code, httpStatus: 404, message });
}

function compact<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
