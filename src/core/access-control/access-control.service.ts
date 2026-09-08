import { ObjectId } from 'mongodb';
import {
  permissionDefinitions,
  permissionKeys,
} from '../../modules/permissions/permission.registry';
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
  BranchRepository,
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
    private readonly branches: BranchRepository,
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

  async canDelegate(ctx: RequestContext, input: AuthorizationRequest): Promise<boolean> {
    try {
      await this.authorize(ctx, input);
      return true;
    } catch {
      return false;
    }
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
    const eligibleProfiles = profiles.filter(
      (profile) =>
        profile.context === 'WORKSPACE' &&
        profile.status === 'ACTIVE' &&
        profile.workspaceId?.equals(workspaceId),
    );
    const grants = await this.grants.listCurrent(
      'WORKSPACE_MEMBERSHIP',
      membership._id,
      'WORKSPACE',
      workspaceId,
    );
    const now = new Date();
    const activeGrants = grants.filter((grant) => !grant.expiresAt || grant.expiresAt > now);
    return {
      membershipId: membership._id.toHexString(),
      workspaceId: membership.workspaceId.toHexString(),
      accessVersion: membership.accessVersion ?? 0,
      profiles: profiles.map((profile) => ({
        id: profile._id.toHexString(),
        name: profile.name,
        roleKey: profile.roleKey,
        version: profile.version,
        status: profile.status,
        contributes: eligibleProfiles.some((eligibleProfile) =>
          eligibleProfile._id.equals(profile._id),
        ),
      })),
      grants: activeGrants.map(safeGrant),
      permissions: permissionDefinitions
        .filter((definition) => definition.allowedContexts.includes('WORKSPACE'))
        .map((definition) => {
          const decision = this.evaluateDecision(
            {
              context: 'WORKSPACE',
              workspaceId,
              permission: definition.key,
              scope: { type: 'WORKSPACE' },
            },
            eligibleProfiles,
            activeGrants,
            now,
          );
          return safePermissionDecision(decision);
        }),
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
    return this.assertAllowed(this.evaluateDecision(input, eligibleProfiles, grants, now));
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
    return this.assertAllowed(this.evaluateDecision(input, eligibleProfiles, grants, now));
  }

  private async assertStructuralScope(
    input: AuthorizationRequest,
    membershipId: ObjectId,
  ): Promise<void> {
    if (!input.scope || !input.workspaceId) return;
    if (input.scope.type !== 'BRANCH' && input.scope.type !== 'MULTIPLE_BRANCHES') return;
    const branchIds = input.scope.resourceIds ?? [];
    if (branchIds.length === 0) throw notFound('SCOPE_RESOURCE_NOT_FOUND');

    const [branches, activeAssignments] = await Promise.all([
      this.branches.listByIdsInWorkspace(input.workspaceId, branchIds),
      this.branchAssignments.listActive(input.workspaceId, membershipId),
    ]);
    const activeBranchIds = new Set(
      branches
        .filter((branch) => branch.status === 'ACTIVE')
        .map((branch) => branch._id.toHexString()),
    );
    const assignedBranchIds = new Set(
      activeAssignments.map((assignment) => assignment.branchId.toHexString()),
    );

    for (const branchId of branchIds) {
      const key = branchId.toHexString();
      const assignmentSatisfied =
        input.scope.requiresAssignment === false || assignedBranchIds.has(key);
      if (!activeBranchIds.has(key) || !assignmentSatisfied) {
        throw permissionDenied('SCOPE_DENIED');
      }
    }
  }

  private evaluateDecision(
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

    return {
      allowed: effect === 'ALLOW',
      permission: input.permission,
      context: input.context,
      ...(input.scope ? { scope: input.scope } : {}),
      source,
      effect,
      reasons: reasons.length > 0 ? reasons : ['default-deny'],
    };
  }

  private assertAllowed(decision: AuthorizationDecision): AuthorizationDecision {
    if (!decision.allowed) throw permissionDenied('PERMISSION_DENIED');
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

function safePermissionDecision(decision: AuthorizationDecision) {
  return {
    permission: decision.permission,
    effect: decision.effect,
    allowed: decision.allowed,
    source: decision.source,
    explicitOverrideApplied: decision.source === 'EXPLICIT_GRANT',
    explicitDeny: decision.source === 'EXPLICIT_GRANT' && decision.effect === 'DENY',
    profileBaselineApplied: decision.reasons.some((reason) => reason.startsWith('profile-')),
    scope: decision.scope
      ? {
          type: decision.scope.type,
          resourceIds: decision.scope.resourceIds?.map((id) => id.toHexString()),
        }
      : undefined,
    reasons: decision.reasons,
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
