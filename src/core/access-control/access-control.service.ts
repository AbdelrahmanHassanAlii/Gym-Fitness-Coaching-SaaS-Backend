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
import type {
  AuthorizationDecision,
  AuthorizationRequest,
  WorkspaceQueryAccess,
  WorkspaceQueryAccessRequest,
} from './access-control.types';

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
    private readonly relationships?: {
      findByIdInWorkspace(
        workspaceId: ObjectId,
        relationshipId: ObjectId,
      ): Promise<{
        _id: ObjectId;
        workspaceId: ObjectId;
        homeBranchId?: ObjectId;
        traineeUserId?: ObjectId;
        status?: string;
      } | null>;
    },
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

  async resolveWorkspaceQueryAccess(
    ctx: RequestContext,
    input: WorkspaceQueryAccessRequest,
  ): Promise<WorkspaceQueryAccess> {
    if (!ctx.userId || !ctx.authSessionId) throw authRequired();
    if (!permissionKeys.has(input.permission)) throw permissionDenied('PERMISSION_UNKNOWN');
    if (input.mfaSatisfied === false) {
      throw new AppError({
        code: 'TWO_FACTOR_REQUIRED',
        httpStatus: 403,
        message: 'MFA is required for this action.',
      });
    }

    if (ctx.supportSessionId && !ctx.effectiveMembershipId) {
      throw permissionDenied('SUPPORT_WORKSPACE_DENIED');
    }

    const now = new Date();
    const workspace = await this.workspaces.findById(input.workspaceId);
    if (!workspace) throw notFound('WORKSPACE_NOT_FOUND');
    if (workspace.status !== 'ACTIVE') {
      throw new AppError({
        code: 'WORKSPACE_INACTIVE',
        httpStatus: 409,
        message: 'The workspace is not active.',
      });
    }

    if (ctx.supportSessionId) {
      if (ctx.workspaceId !== input.workspaceId.toHexString() || !ctx.effectiveMembershipId) {
        throw permissionDenied('SUPPORT_WORKSPACE_DENIED');
      }
      await this.assertSupportSensitivePermission(ctx, input.permission, now);
    }

    const membership = ctx.supportSessionId
      ? await this.workspaceMemberships.findByIdInWorkspace(
          input.workspaceId,
          new ObjectId(required(ctx.effectiveMembershipId)),
        )
      : await this.workspaceMemberships.findByUserInWorkspace(
          input.workspaceId,
          new ObjectId(ctx.userId),
        );
    if (membership?.status !== 'ACTIVE') {
      throw permissionDenied('WORKSPACE_MEMBERSHIP_REQUIRED');
    }
    ctx.workspaceId = workspace._id.toHexString();
    ctx.workspaceMembershipId = membership._id.toHexString();

    if (input.branchId) {
      const branches = await this.branches.listByIdsInWorkspace(input.workspaceId, [
        input.branchId,
      ]);
      if (branches[0]?.status !== 'ACTIVE') throw permissionDenied('SCOPE_DENIED');
    }
    if (input.relationshipId && this.relationships) {
      const relationship = await this.relationships.findByIdInWorkspace(
        input.workspaceId,
        input.relationshipId,
      );
      if (!relationship) throw notFound('RELATIONSHIP_NOT_FOUND');
    }

    const profiles = await this.profiles.findManyByIds(membership.permissionProfileIds);
    const eligibleProfiles = profiles.filter(
      (profile) =>
        profile.context === 'WORKSPACE' &&
        profile.status === 'ACTIVE' &&
        profile.workspaceId?.equals(workspace._id),
    );
    const grants = (
      await this.grants.listCurrent(
        'WORKSPACE_MEMBERSHIP',
        membership._id,
        'WORKSPACE',
        workspace._id,
      )
    ).filter((grant) => !grant.expiresAt || grant.expiresAt > now);

    const branchResourceIds = grants.flatMap((grant) =>
      ['BRANCH', 'MULTIPLE_BRANCHES'].includes(grant.scope.type)
        ? (grant.scope.resourceIds ?? [])
        : [],
    );
    const specificResourceIds = grants.flatMap((grant) =>
      grant.scope.type === 'SPECIFIC_TRAINEES' ? (grant.scope.resourceIds ?? []) : [],
    );
    if (branchResourceIds.length > (input.maxBranches ?? 100)) {
      throw permissionDenied('SCOPE_RESOURCE_LIMIT_EXCEEDED');
    }
    if (specificResourceIds.length > (input.maxSpecificTrainees ?? 500)) {
      throw permissionDenied('SCOPE_RESOURCE_LIMIT_EXCEEDED');
    }
    for (const grant of grants) {
      if (
        (grant.scope.type === 'BRANCH' ||
          grant.scope.type === 'MULTIPLE_BRANCHES' ||
          grant.scope.type === 'SPECIFIC_TRAINEES') &&
        (grant.scope.resourceIds ?? []).length === 0
      ) {
        throw permissionDenied('SCOPE_RESOURCE_REQUIRED');
      }
    }
    if (branchResourceIds.length > 0) {
      const uniqueBranchIds = uniqueObjectIds(branchResourceIds);
      const branches = await this.branches.listByIdsInWorkspace(workspace._id, uniqueBranchIds);
      const activeIds = new Set(
        branches
          .filter((branch) => branch.status === 'ACTIVE')
          .map((branch) => branch._id.toHexString()),
      );
      if (!uniqueBranchIds.every((branchId) => activeIds.has(branchId.toHexString()))) {
        throw permissionDenied('SCOPE_DENIED');
      }
    }
    if (specificResourceIds.length > 0 && this.relationships) {
      for (const relationshipId of uniqueObjectIds(specificResourceIds)) {
        const relationship = await this.relationships.findByIdInWorkspace(
          workspace._id,
          relationshipId,
        );
        if (!relationship) throw permissionDenied('SCOPE_DENIED');
      }
    }

    const profileEntries = eligibleProfiles.flatMap((profile) =>
      profile.permissions.filter((entry) => entry.permission === input.permission),
    );
    let baseline: 'ALLOW' | 'DENY' | 'NONE' = 'NONE';
    const reasons: string[] = [];
    if (profileEntries.some((entry) => entry.effect === 'DENY')) {
      baseline = 'DENY';
      reasons.push('profile-deny');
    } else if (profileEntries.some((entry) => entry.effect === 'ALLOW')) {
      baseline = 'ALLOW';
      reasons.push('profile-allow');
    }

    const decisions = aggregateGrantDecisions(
      grants.filter((grant) => grant.permission === input.permission),
    );
    const workspaceDecision = decisions.workspace;
    const workspaceAllowed =
      workspaceDecision === 'ALLOW' || (workspaceDecision !== 'DENY' && baseline === 'ALLOW');
    let includeBranchIds = decisions.branch.allow;
    const excludeBranchIds = decisions.branch.deny;
    const includeRelationshipIds = decisions.relationship.allow;
    const excludeRelationshipIds = decisions.relationship.deny;
    const assignedTrainees =
      decisions.assignedTrainees === 'ALLOW' ||
      (workspaceAllowed &&
        ['TRAINER', 'ASSISTANT_TRAINER', 'NUTRITIONIST'].some((role) =>
          membership.roles.includes(role as never),
        ));
    const self =
      decisions.self === 'ALLOW' ||
      (workspaceAllowed && membership.roles.includes('TRAINEE' as never));

    if (input.relationshipId && includeRelationshipIds.length > 0) {
      if (!includeRelationshipIds.some((id) => id.equals(input.relationshipId))) {
        throw permissionDenied('PERMISSION_DENIED');
      }
    }
    if (
      input.relationshipId &&
      excludeRelationshipIds.some((id) => id.equals(input.relationshipId))
    ) {
      throw permissionDenied('PERMISSION_DENIED');
    }
    if (input.branchId && includeBranchIds.length > 0) {
      if (!includeBranchIds.some((id) => id.equals(input.branchId))) {
        throw permissionDenied('PERMISSION_DENIED');
      }
    }
    if (input.branchId && excludeBranchIds.some((id) => id.equals(input.branchId))) {
      throw permissionDenied('PERMISSION_DENIED');
    }

    let effectiveWorkspaceAllowed = workspaceAllowed;
    if (
      membership.roles.includes('GYM_MANAGER' as never) &&
      !membership.roles.includes('GYM_OWNER' as never)
    ) {
      const activeBranchAssignments = await this.branchAssignments.listActive(
        workspace._id,
        membership._id,
      );
      const assignedBranchIds = activeBranchAssignments.map((assignment) => assignment.branchId);
      if (workspaceAllowed && includeBranchIds.length === 0) {
        includeBranchIds = assignedBranchIds;
        effectiveWorkspaceAllowed = false;
      } else if (includeBranchIds.length > 0) {
        includeBranchIds = includeBranchIds.filter((branchId) =>
          assignedBranchIds.some((assignedBranchId) => assignedBranchId.equals(branchId)),
        );
      }
    }
    if (
      ['TRAINER', 'ASSISTANT_TRAINER', 'NUTRITIONIST'].some((role) =>
        membership.roles.includes(role as never),
      ) &&
      !membership.roles.includes('GYM_OWNER' as never) &&
      !membership.roles.includes('GYM_MANAGER' as never)
    ) {
      effectiveWorkspaceAllowed = false;
    }

    const allowed =
      effectiveWorkspaceAllowed ||
      assignedTrainees ||
      self ||
      includeBranchIds.length > 0 ||
      includeRelationshipIds.length > 0;
    if (!allowed) throw permissionDenied('PERMISSION_DENIED');

    return {
      allowed,
      permission: input.permission,
      workspaceId: workspace._id,
      membershipId: membership._id,
      userId: membership.userId,
      roles: membership.roles,
      workspaceAllowed: effectiveWorkspaceAllowed,
      assignedTrainees,
      self,
      includeBranchIds,
      excludeBranchIds,
      includeRelationshipIds,
      excludeRelationshipIds,
      ...(input.branchId ? { requestedBranchId: input.branchId } : {}),
      ...(input.relationshipId ? { requestedRelationshipId: input.relationshipId } : {}),
      pureWorkspaceWide:
        effectiveWorkspaceAllowed &&
        includeBranchIds.length === 0 &&
        excludeBranchIds.length === 0 &&
        includeRelationshipIds.length === 0 &&
        excludeRelationshipIds.length === 0 &&
        !assignedTrainees &&
        !self &&
        !input.branchId,
      reasons: reasons.length > 0 ? reasons : ['explicit-query-access'],
    };
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
    if (ctx.supportSessionId) {
      return await this.authorizeWorkspaceSupport(ctx, input, now);
    }
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

  private async authorizeWorkspaceSupport(
    ctx: RequestContext,
    input: AuthorizationRequest,
    now: Date,
  ): Promise<AuthorizationDecision> {
    if (!input.workspaceId || ctx.workspaceId !== input.workspaceId.toHexString()) {
      throw permissionDenied('SUPPORT_WORKSPACE_DENIED');
    }
    const workspace = await this.workspaces.findById(input.workspaceId);
    if (!workspace) throw notFound('WORKSPACE_NOT_FOUND');
    if (ctx.effectiveMembershipId) {
      await this.assertSupportSensitivePermission(ctx, input.permission, now);
      const membership = await this.workspaceMemberships.findByIdInWorkspace(
        input.workspaceId,
        new ObjectId(ctx.effectiveMembershipId),
      );
      if (membership?.status !== 'ACTIVE') {
        throw permissionDenied('SUPPORT_EFFECTIVE_MEMBERSHIP_REQUIRED');
      }
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
    if (!supportWorkspacePermission(input.permission)) {
      throw permissionDenied('SUPPORT_WRITE_NOT_WHITELISTED');
    }
    await this.assertSupportSensitivePermission(ctx, input.permission, now);
    return {
      allowed: true,
      permission: input.permission,
      context: input.context,
      ...(input.scope ? { scope: input.scope } : {}),
      source: 'PROFILE',
      effect: 'ALLOW',
      reasons: ['support-workspace-read-only'],
    };
  }

  private async assertSupportSensitivePermission(
    ctx: RequestContext,
    permission: string,
    now: Date,
  ): Promise<void> {
    const required = supportSensitivePlatformPermission(permission);
    if (!required) return;
    await this.authorizePlatform(
      ctx,
      {
        context: 'PLATFORM',
        permission: required,
        scope: { type: 'WORKSPACE' },
      },
      now,
    );
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

function aggregateGrantDecisions(grants: AccessGrantDocument[]): {
  workspace?: PermissionEffect;
  assignedTrainees?: PermissionEffect;
  self?: PermissionEffect;
  branch: { allow: ObjectId[]; deny: ObjectId[] };
  relationship: { allow: ObjectId[]; deny: ObjectId[] };
} {
  const workspace = strongest(grants.filter((grant) => grant.scope.type === 'WORKSPACE'));
  const assignedTrainees = strongest(
    grants.filter((grant) => grant.scope.type === 'ASSIGNED_TRAINEES'),
  );
  const self = strongest(grants.filter((grant) => grant.scope.type === 'SELF'));
  const branch = atomDecisions(
    grants.filter(
      (grant) => grant.scope.type === 'BRANCH' || grant.scope.type === 'MULTIPLE_BRANCHES',
    ),
  );
  const relationship = atomDecisions(
    grants.filter((grant) => grant.scope.type === 'SPECIFIC_TRAINEES'),
  );
  return {
    ...(workspace ? { workspace } : {}),
    ...(assignedTrainees ? { assignedTrainees } : {}),
    ...(self ? { self } : {}),
    branch,
    relationship,
  };
}

function strongest(grants: AccessGrantDocument[]): PermissionEffect | undefined {
  if (grants.length === 0) return undefined;
  const bestSpecificity = Math.max(...grants.map((grant) => scopeSpecificity[grant.scope.type]));
  const strongestGrants = grants.filter(
    (grant) => scopeSpecificity[grant.scope.type] === bestSpecificity,
  );
  return strongestGrants.some((grant) => grant.effect === 'DENY') ? 'DENY' : 'ALLOW';
}

function atomDecisions(grants: AccessGrantDocument[]): {
  allow: ObjectId[];
  deny: ObjectId[];
} {
  const byId = new Map<string, { id: ObjectId; specificity: number; effect: PermissionEffect }>();
  for (const grant of grants) {
    const specificity = scopeSpecificity[grant.scope.type];
    for (const id of grant.scope.resourceIds ?? []) {
      const key = id.toHexString();
      const current = byId.get(key);
      if (
        !current ||
        specificity > current.specificity ||
        (specificity === current.specificity && grant.effect === 'DENY')
      ) {
        byId.set(key, { id, specificity, effect: grant.effect });
      }
    }
  }
  return {
    allow: [...byId.values()].filter((item) => item.effect === 'ALLOW').map((item) => item.id),
    deny: [...byId.values()].filter((item) => item.effect === 'DENY').map((item) => item.id),
  };
}

function required(value: string | undefined): string {
  if (!value) throw permissionDenied('SUPPORT_EFFECTIVE_MEMBERSHIP_REQUIRED');
  return value;
}

function uniqueObjectIds(ids: ObjectId[]): ObjectId[] {
  const seen = new Set<string>();
  const result: ObjectId[] = [];
  for (const id of ids) {
    const key = id.toHexString();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(id);
  }
  return result;
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

function supportWorkspacePermission(permission: string): boolean {
  return (
    permission.endsWith('.read') ||
    permission.endsWith('.download') ||
    permission === 'files.download' ||
    permission === 'billing.subscription.read' ||
    permission === 'billing.usage.read' ||
    permission === 'billing.payments.read'
  );
}

function supportSensitivePlatformPermission(permission: string): string | null {
  if (permission === 'medical_documents.download') return 'support.sensitive_files.read';
  if (
    [
      'medical_documents.read',
      'health.read',
      'checkins.read',
      'progress_photos.read',
      'dashboard.trainer.read',
      'dashboard.gym.read',
      'dashboard.relationship.read',
      'analytics.progress.read',
      'analytics.nutrition.read',
      'analytics.adherence.read',
    ].includes(permission)
  ) {
    return 'support.sensitive.read';
  }
  return null;
}
