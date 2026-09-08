import { ObjectId } from 'mongodb';
import { permissionKeys } from '../../modules/permissions/permission.registry';
import type {
  AccessGrantRepository,
  PermissionProfileRepository,
} from '../../modules/permissions/permission.repository';
import type {
  AccessGrantDocument,
  PermissionEffect,
} from '../../modules/permissions/permission.types';
import type { PlatformMembershipRepository } from '../../modules/platform/platform.repository';
import type {
  MembershipBranchAssignmentRepository,
  WorkspaceMembershipRepository,
  WorkspaceRepository,
} from '../../modules/workspaces/workspace.repository';
import { AppError } from '../errors/app-error';
import type { RequestContext } from '../request-context/request-context';
import type { AuthorizationDecision, AuthorizationRequest } from './access-control.types';

const scopeSpecificity = {
  SELF: 60,
  SPECIFIC_TRAINEES: 50,
  BRANCH: 40,
  MULTIPLE_BRANCHES: 35,
  ASSIGNED_TRAINEES: 30,
  WORKSPACE: 10,
} as const;

export class AccessControlService {
  constructor(
    private readonly platformMemberships: PlatformMembershipRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly workspaceMemberships: WorkspaceMembershipRepository,
    private readonly branchAssignments: MembershipBranchAssignmentRepository,
    private readonly profiles: PermissionProfileRepository,
    private readonly grants: AccessGrantRepository,
  ) {}

  async authorize(
    ctx: RequestContext,
    input: AuthorizationRequest,
  ): Promise<AuthorizationDecision> {
    if (!ctx.userId || !ctx.authSessionId) throw authRequired();
    if (!permissionKeys.has(input.permission)) throw permissionDenied('PERMISSION_UNKNOWN');
    if (input.mfaSatisfied === false || (input.context === 'PLATFORM' && !ctx.mfaSatisfied)) {
      throw new AppError({
        code: 'TWO_FACTOR_REQUIRED',
        httpStatus: 403,
        message: 'MFA is required for this action.',
      });
    }

    const now = new Date();
    if (input.context === 'PLATFORM') {
      return await this.authorizePlatform(ctx, input, now);
    }
    return await this.authorizeWorkspace(ctx, input, now);
  }

  async effectiveAccessForWorkspaceMembership(
    ctx: RequestContext,
    workspaceId: ObjectId,
    membershipId: ObjectId,
  ) {
    await this.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId,
      permission: 'staff.permissions.manage',
      scope: { type: 'WORKSPACE' },
    });
    const membership = await this.workspaceMemberships.findByIdInWorkspace(
      workspaceId,
      membershipId,
    );
    if (!membership) throw notFound('WORKSPACE_MEMBERSHIP_NOT_FOUND');
    const profiles = await this.profiles.findManyByIds(membership.permissionProfileIds);
    const grants = await this.grants.listCurrent(
      'WORKSPACE_MEMBERSHIP',
      membership._id,
      'WORKSPACE',
      workspaceId,
    );
    const now = new Date();
    return {
      membershipId: membership._id.toHexString(),
      workspaceId: membership.workspaceId.toHexString(),
      accessVersion: membership.accessVersion ?? 0,
      profiles: profiles.map((profile) => ({
        id: profile._id.toHexString(),
        name: profile.name,
        roleKey: profile.roleKey,
        version: profile.version,
      })),
      grants: grants.filter((grant) => !grant.expiresAt || grant.expiresAt > now).map(safeGrant),
    };
  }

  private async authorizePlatform(
    ctx: RequestContext,
    input: AuthorizationRequest,
    now: Date,
  ): Promise<AuthorizationDecision> {
    const membership = await this.platformMemberships.findActiveByUserId(new ObjectId(ctx.userId));
    if (!membership) throw permissionDenied('PLATFORM_MEMBERSHIP_REQUIRED');
    ctx.platformMembershipId = membership._id.toHexString();

    const profiles = await this.profiles.findManyByIds(membership.permissionProfileIds);
    const eligibleProfiles = profiles.filter(
      (profile) => profile.context === 'PLATFORM' && profile.status === 'ACTIVE',
    );
    const grants = await this.grants.listCurrent('PLATFORM_MEMBERSHIP', membership._id, 'PLATFORM');
    return this.evaluate(input, eligibleProfiles, grants, now);
  }

  private async authorizeWorkspace(
    ctx: RequestContext,
    input: AuthorizationRequest,
    now: Date,
  ): Promise<AuthorizationDecision> {
    if (!input.workspaceId) throw notFound('WORKSPACE_NOT_FOUND');
    const [workspace, membership] = await Promise.all([
      this.workspaces.findById(input.workspaceId),
      this.workspaceMemberships.findByUserInWorkspace(input.workspaceId, new ObjectId(ctx.userId)),
    ]);
    if (!workspace || !membership) throw notFound('WORKSPACE_NOT_FOUND');
    if (workspace.status !== 'ACTIVE') {
      throw new AppError({
        code: 'WORKSPACE_INACTIVE',
        httpStatus: 409,
        message: 'The workspace is not active.',
      });
    }
    if (membership.status !== 'ACTIVE') throw permissionDenied('WORKSPACE_MEMBERSHIP_REQUIRED');
    ctx.workspaceId = workspace._id.toHexString();
    ctx.workspaceMembershipId = membership._id.toHexString();

    await this.assertStructuralScope(input, membership._id);

    const profiles = await this.profiles.findManyByIds(membership.permissionProfileIds);
    const eligibleProfiles = profiles.filter(
      (profile) =>
        profile.context === 'WORKSPACE' &&
        profile.status === 'ACTIVE' &&
        profile.workspaceId?.equals(workspace._id),
    );
    const grants = await this.grants.listCurrent(
      'WORKSPACE_MEMBERSHIP',
      membership._id,
      'WORKSPACE',
      workspace._id,
    );
    return this.evaluate(input, eligibleProfiles, grants, now);
  }

  private async assertStructuralScope(
    input: AuthorizationRequest,
    membershipId: ObjectId,
  ): Promise<void> {
    if (!input.scope || !input.workspaceId) return;
    if (input.scope.type !== 'BRANCH' && input.scope.type !== 'MULTIPLE_BRANCHES') return;
    for (const branchId of input.scope.resourceIds ?? []) {
      const activeAssignments = await this.branchAssignments.listActive(
        input.workspaceId,
        membershipId,
      );
      if (!activeAssignments.some((assignment) => assignment.branchId.equals(branchId))) {
        throw permissionDenied('SCOPE_DENIED');
      }
    }
  }

  private evaluate(
    input: AuthorizationRequest,
    profiles: Array<{ permissions: Array<{ permission: string; effect: PermissionEffect }> }>,
    grants: AccessGrantDocument[],
    now: Date,
  ): AuthorizationDecision {
    const profileEntries = profiles.flatMap((profile) =>
      profile.permissions.filter((entry) => entry.permission === input.permission),
    );
    let source: AuthorizationDecision['source'] = 'NONE';
    let effect: AuthorizationDecision['effect'] = 'DENY';
    const reasons: string[] = [];

    if (profileEntries.some((entry) => entry.effect === 'DENY')) {
      source = 'PROFILE';
      effect = 'DENY';
      reasons.push('profile-deny');
    } else if (profileEntries.some((entry) => entry.effect === 'ALLOW')) {
      source = 'PROFILE';
      effect = 'ALLOW';
      reasons.push('profile-allow');
    }

    const applicableGrants = grants.filter(
      (grant) =>
        grant.permission === input.permission &&
        (!grant.expiresAt || grant.expiresAt > now) &&
        scopeApplies(grant, input.scope),
    );

    if (applicableGrants.length > 0) {
      const bestSpecificity = Math.max(
        ...applicableGrants.map((grant) => scopeSpecificity[grant.scope.type]),
      );
      const strongest = applicableGrants.filter(
        (grant) => scopeSpecificity[grant.scope.type] === bestSpecificity,
      );
      source = 'EXPLICIT_GRANT';
      effect = strongest.some((grant) => grant.effect === 'DENY') ? 'DENY' : 'ALLOW';
      reasons.push(`explicit-${effect.toLowerCase()}`);
    }

    const decision = {
      allowed: effect === 'ALLOW',
      permission: input.permission,
      context: input.context,
      ...(input.scope ? { scope: input.scope } : {}),
      source,
      effect,
      reasons: reasons.length > 0 ? reasons : ['default-deny'],
    };
    if (!decision.allowed)
      throw permissionDenied(source === 'NONE' ? 'PERMISSION_DENIED' : 'PERMISSION_DENIED');
    return decision;
  }
}

function scopeApplies(
  grant: AccessGrantDocument,
  requestedScope: AuthorizationRequest['scope'],
): boolean {
  if (!requestedScope) return grant.scope.type === 'WORKSPACE';
  if (grant.scope.type === 'WORKSPACE') return true;
  if (grant.scope.type !== requestedScope.type) return false;
  const grantIds = grant.scope.resourceIds ?? [];
  const requestedIds = requestedScope.resourceIds ?? [];
  if (grantIds.length === 0 && requestedIds.length === 0) return true;
  return requestedIds.every((requestedId) =>
    grantIds.some((grantId) => grantId.equals(requestedId)),
  );
}

function safeGrant(grant: AccessGrantDocument) {
  return {
    id: grant._id.toHexString(),
    permission: grant.permission,
    effect: grant.effect,
    scope: {
      type: grant.scope.type,
      resourceIds: grant.scope.resourceIds?.map((id) => id.toHexString()),
    },
    expiresAt: grant.expiresAt?.toISOString(),
    createdAt: grant.createdAt.toISOString(),
  };
}

function authRequired(): AppError {
  return new AppError({
    code: 'AUTH_REQUIRED',
    httpStatus: 401,
    message: 'Authentication is required.',
  });
}

function notFound(code: string): AppError {
  return new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
}

function permissionDenied(reason: string): AppError {
  return new AppError({
    code: reason,
    httpStatus: 403,
    message: 'Permission denied.',
  });
}
