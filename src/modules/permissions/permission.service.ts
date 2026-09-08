import { ObjectId } from 'mongodb';
import type { AccessControlService } from '../../core/access-control/access-control.service';
import type { AuditWriter } from '../../core/audit/audit.writer';
import type { TransactionContext, UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { OutboxWriter } from '../../core/events/outbox.writer';
import type { RequestContext } from '../../core/request-context/request-context';
import type { PlatformMembershipRepository } from '../platform/platform.repository';
import type {
  BranchRepository,
  WorkspaceMembershipRepository,
  WorkspaceRepository,
} from '../workspaces/workspace.repository';
import { permissionKeys } from './permission.registry';
import type {
  AccessGrantRepository,
  PermissionDefinitionRepository,
  PermissionProfileRepository,
} from './permission.repository';
import type {
  AccessGrantDocument,
  AccessGrantSubjectType,
  PermissionContext,
  PermissionEffect,
  PermissionProfileDocument,
  PermissionProfileEntry,
  PermissionScope,
} from './permission.types';

export class PermissionApplicationService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly definitions: PermissionDefinitionRepository,
    private readonly profiles: PermissionProfileRepository,
    private readonly grants: AccessGrantRepository,
    private readonly accessControl: AccessControlService,
    private readonly platformMemberships: PlatformMembershipRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly branches: BranchRepository,
    private readonly workspaceMemberships: WorkspaceMembershipRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async listDefinitions() {
    return (await this.definitions.listActive()).map((definition) => ({
      key: definition.key,
      category: definition.category,
      module: definition.module,
      displayName: definition.displayName,
      description: definition.description,
      allowedScopes: definition.allowedScopes,
      allowedContexts: definition.allowedContexts,
      system: definition.system,
      state: definition.state,
    }));
  }

  async listWorkspaceProfiles(_ctx: RequestContext, workspaceId: string) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    return (await this.profiles.listWorkspace(id)).map(safeProfile);
  }

  async listPlatformProfiles(_ctx: RequestContext) {
    return (await this.profiles.listPlatform()).map(safeProfile);
  }

  async createWorkspaceProfile(
    ctx: RequestContext,
    workspaceId: string,
    input: { name: string; roleKey?: string; permissions: PermissionProfileEntry[] },
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.assertWorkspaceExists(id);
    await this.validateProfileEntries(ctx, 'WORKSPACE', input.permissions, id);
    return await this.unitOfWork.withTransaction(async (tx) => {
      const createInput: {
        context: 'WORKSPACE';
        workspaceId: ObjectId;
        name: string;
        roleKey?: string;
        permissions: PermissionProfileEntry[];
      } = {
        context: 'WORKSPACE',
        workspaceId: id,
        name: input.name.trim(),
        permissions: input.permissions,
      };
      if (input.roleKey) createInput.roleKey = input.roleKey.trim();
      const profile = await this.profiles.create(createInput, tx);
      await this.writeAudit(ctx, id, 'PermissionProfileCreated', profile._id, 'create', tx);
      await this.writeOutbox(
        ctx,
        id,
        'PermissionProfileCreated',
        'permission_profile',
        profile._id,
        tx,
      );
      return safeProfile(profile);
    });
  }

  async createPlatformProfile(
    ctx: RequestContext,
    input: { name: string; roleKey?: string; permissions: PermissionProfileEntry[] },
  ) {
    await this.validateProfileEntries(ctx, 'PLATFORM', input.permissions);
    return await this.unitOfWork.withTransaction(async (tx) => {
      const createInput: {
        context: 'PLATFORM';
        name: string;
        roleKey?: string;
        permissions: PermissionProfileEntry[];
      } = {
        context: 'PLATFORM',
        name: input.name.trim(),
        permissions: input.permissions,
      };
      if (input.roleKey) createInput.roleKey = input.roleKey.trim();
      const profile = await this.profiles.create(createInput, tx);
      await this.writeAudit(ctx, undefined, 'PermissionProfileCreated', profile._id, 'create', tx);
      await this.writeOutbox(
        ctx,
        undefined,
        'PermissionProfileCreated',
        'permission_profile',
        profile._id,
        tx,
      );
      return safeProfile(profile);
    });
  }

  async updateProfile(
    ctx: RequestContext,
    profileId: string,
    workspaceId: string | undefined,
    input: { expectedVersion: number; name?: string; permissions?: PermissionProfileEntry[] },
  ) {
    const id = objectId(profileId, 'PERMISSION_PROFILE_NOT_FOUND');
    const workspaceObjectId = workspaceId
      ? objectId(workspaceId, 'WORKSPACE_NOT_FOUND')
      : undefined;
    const existing = await this.requireProfileContext(id, workspaceObjectId);
    if (input.permissions)
      await this.validateProfileEntries(
        ctx,
        existing.context,
        input.permissions,
        workspaceObjectId,
      );
    return await this.unitOfWork.withTransaction(async (tx) => {
      const updateInput: { name?: string; permissions?: PermissionProfileEntry[] } = {};
      if (input.name) updateInput.name = input.name.trim();
      if (input.permissions) updateInput.permissions = input.permissions;
      const profile = await this.profiles.update(id, input.expectedVersion, updateInput, tx);
      await this.writeAudit(
        ctx,
        workspaceObjectId,
        'PermissionProfileUpdated',
        profile._id,
        'update',
        tx,
      );
      await this.writeOutbox(
        ctx,
        workspaceObjectId,
        'PermissionProfileUpdated',
        'permission_profile',
        profile._id,
        tx,
      );
      return safeProfile(profile);
    });
  }

  async archiveProfile(
    ctx: RequestContext,
    profileId: string,
    workspaceId: string | undefined,
    expectedVersion: number,
  ) {
    const id = objectId(profileId, 'PERMISSION_PROFILE_NOT_FOUND');
    const workspaceObjectId = workspaceId
      ? objectId(workspaceId, 'WORKSPACE_NOT_FOUND')
      : undefined;
    await this.requireProfileContext(id, workspaceObjectId);
    return await this.unitOfWork.withTransaction(async (tx) => {
      const profile = await this.profiles.archive(id, expectedVersion, new Date(), tx);
      await this.writeAudit(
        ctx,
        workspaceObjectId,
        'PermissionProfileArchived',
        profile._id,
        'archive',
        tx,
      );
      await this.writeOutbox(
        ctx,
        workspaceObjectId,
        'PermissionProfileArchived',
        'permission_profile',
        profile._id,
        tx,
      );
      return safeProfile(profile);
    });
  }

  async replaceWorkspaceMembershipProfiles(
    ctx: RequestContext,
    workspaceId: string,
    membershipId: string,
    input: { expectedVersion: number; profileIds: string[] },
  ) {
    const workspaceObjectId = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const membershipObjectId = objectId(membershipId, 'WORKSPACE_MEMBERSHIP_NOT_FOUND');
    const profileIds = uniqueObjectIds(input.profileIds, 'PERMISSION_PROFILE_DUPLICATE');
    const membership = await this.workspaceMemberships.findByIdInWorkspace(
      workspaceObjectId,
      membershipObjectId,
    );
    if (!membership) throw notFound('WORKSPACE_MEMBERSHIP_NOT_FOUND');
    await this.assertAssignableProfiles('WORKSPACE', profileIds, workspaceObjectId);
    await this.assertCanDelegateProfiles(ctx, 'WORKSPACE', profileIds, workspaceObjectId);
    return await this.unitOfWork.withTransaction(async (tx) => {
      const updated = await this.workspaceMemberships.replacePermissionProfiles(
        workspaceObjectId,
        membershipObjectId,
        input.expectedVersion,
        profileIds,
        new Date(),
        tx,
      );
      await this.writeAudit(
        ctx,
        workspaceObjectId,
        'MembershipPermissionProfilesReplaced',
        updated._id,
        'replace',
        tx,
      );
      await this.writeOutbox(
        ctx,
        workspaceObjectId,
        'MembershipPermissionProfilesReplaced',
        'workspace_membership',
        updated._id,
        tx,
      );
      return safeAssignment(updated._id, updated.permissionProfileIds, updated.accessVersion ?? 0);
    });
  }

  async replacePlatformMembershipProfiles(
    ctx: RequestContext,
    membershipId: string,
    input: { expectedVersion: number; profileIds: string[] },
  ) {
    const membershipObjectId = objectId(membershipId, 'PLATFORM_MEMBERSHIP_NOT_FOUND');
    const profileIds = uniqueObjectIds(input.profileIds, 'PERMISSION_PROFILE_DUPLICATE');
    const membership = await this.platformMemberships.findById(membershipObjectId);
    if (!membership) throw notFound('PLATFORM_MEMBERSHIP_NOT_FOUND');
    await this.assertAssignableProfiles('PLATFORM', profileIds);
    await this.assertCanDelegateProfiles(ctx, 'PLATFORM', profileIds);
    return await this.unitOfWork.withTransaction(async (tx) => {
      const updated = await this.platformMemberships.replacePermissionProfiles(
        membershipObjectId,
        input.expectedVersion,
        profileIds,
        new Date(),
        tx,
      );
      await this.writeAudit(
        ctx,
        undefined,
        'MembershipPermissionProfilesReplaced',
        updated._id,
        'replace',
        tx,
      );
      await this.writeOutbox(
        ctx,
        undefined,
        'MembershipPermissionProfilesReplaced',
        'platform_membership',
        updated._id,
        tx,
      );
      return safeAssignment(updated._id, updated.permissionProfileIds, updated.accessVersion ?? 0);
    });
  }

  async listWorkspaceAccess(_ctx: RequestContext, workspaceId: string, membershipId: string) {
    const workspaceObjectId = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const membershipObjectId = objectId(membershipId, 'WORKSPACE_MEMBERSHIP_NOT_FOUND');
    const membership = await this.workspaceMemberships.findByIdInWorkspace(
      workspaceObjectId,
      membershipObjectId,
    );
    if (!membership) throw notFound('WORKSPACE_MEMBERSHIP_NOT_FOUND');
    return (
      await this.grants.listCurrent(
        'WORKSPACE_MEMBERSHIP',
        membershipObjectId,
        'WORKSPACE',
        workspaceObjectId,
      )
    ).map(safeGrant);
  }

  async replaceWorkspaceAccess(
    ctx: RequestContext,
    workspaceId: string,
    membershipId: string,
    input: { expectedVersion: number; grants: GrantInput[] },
  ) {
    const workspaceObjectId = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const membershipObjectId = objectId(membershipId, 'WORKSPACE_MEMBERSHIP_NOT_FOUND');
    const membership = await this.workspaceMemberships.findByIdInWorkspace(
      workspaceObjectId,
      membershipObjectId,
    );
    if (!membership) throw notFound('WORKSPACE_MEMBERSHIP_NOT_FOUND');
    const grants = await this.validateGrants(ctx, 'WORKSPACE', input.grants, workspaceObjectId);
    await this.assertCanReplaceAccessSet(
      ctx,
      'WORKSPACE_MEMBERSHIP',
      membershipObjectId,
      'WORKSPACE',
      workspaceObjectId,
      grants,
    );
    return await this.replaceAccessSet(
      ctx,
      'WORKSPACE_MEMBERSHIP',
      membershipObjectId,
      'WORKSPACE',
      workspaceObjectId,
      input.expectedVersion,
      grants,
    );
  }

  async listPlatformAccess(_ctx: RequestContext, membershipId: string) {
    const membershipObjectId = objectId(membershipId, 'PLATFORM_MEMBERSHIP_NOT_FOUND');
    const membership = await this.platformMemberships.findById(membershipObjectId);
    if (!membership) throw notFound('PLATFORM_MEMBERSHIP_NOT_FOUND');
    return (
      await this.grants.listCurrent('PLATFORM_MEMBERSHIP', membershipObjectId, 'PLATFORM')
    ).map(safeGrant);
  }

  async replacePlatformAccess(
    ctx: RequestContext,
    membershipId: string,
    input: { expectedVersion: number; grants: GrantInput[] },
  ) {
    const membershipObjectId = objectId(membershipId, 'PLATFORM_MEMBERSHIP_NOT_FOUND');
    const membership = await this.platformMemberships.findById(membershipObjectId);
    if (!membership) throw notFound('PLATFORM_MEMBERSHIP_NOT_FOUND');
    const grants = await this.validateGrants(ctx, 'PLATFORM', input.grants);
    await this.assertCanReplaceAccessSet(
      ctx,
      'PLATFORM_MEMBERSHIP',
      membershipObjectId,
      'PLATFORM',
      undefined,
      grants,
    );
    return await this.replaceAccessSet(
      ctx,
      'PLATFORM_MEMBERSHIP',
      membershipObjectId,
      'PLATFORM',
      undefined,
      input.expectedVersion,
      grants,
    );
  }

  private async replaceAccessSet(
    ctx: RequestContext,
    subjectType: AccessGrantSubjectType,
    subjectId: ObjectId,
    context: PermissionContext,
    workspaceId: ObjectId | undefined,
    expectedVersion: number,
    grants: ValidatedGrant[],
  ) {
    return await this.unitOfWork.withTransaction(async (tx) => {
      if (subjectType === 'WORKSPACE_MEMBERSHIP' && workspaceId) {
        await this.workspaceMemberships.bumpAccessVersion(
          workspaceId,
          subjectId,
          expectedVersion,
          new Date(),
          tx,
        );
      } else {
        await this.platformMemberships.bumpAccessVersion(
          subjectId,
          expectedVersion,
          new Date(),
          tx,
        );
      }
      const created = await this.grants.replaceCurrent(
        subjectType,
        subjectId,
        context,
        workspaceId,
        grants,
        objectId(ctx.userId, 'AUTH_REQUIRED'),
        new Date(),
        tx,
      );
      await this.writeAudit(
        ctx,
        workspaceId,
        'ExplicitAccessOverrideSetReplaced',
        subjectId,
        'replace',
        tx,
        undefined,
        { grants: grants.map(safeValidatedGrant), accessVersionIncremented: true },
      );
      await this.writeOutbox(
        ctx,
        workspaceId,
        'ExplicitAccessOverrideSetReplaced',
        'access_grants',
        subjectId,
        tx,
        { subjectType, context, grantCount: grants.length },
      );
      return { grants: created.map(safeGrant) };
    });
  }

  private async assertWorkspaceExists(workspaceId: ObjectId) {
    const workspace = await this.workspaces.findById(workspaceId);
    if (!workspace) throw notFound('WORKSPACE_NOT_FOUND');
  }

  private async requireProfileContext(profileId: ObjectId, workspaceId: ObjectId | undefined) {
    const profile = await this.profiles.findById(profileId);
    if (!profile) throw notFound('PERMISSION_PROFILE_NOT_FOUND');
    if (
      workspaceId &&
      (profile.context !== 'WORKSPACE' || !profile.workspaceId?.equals(workspaceId))
    ) {
      throw notFound('PERMISSION_PROFILE_NOT_FOUND');
    }
    if (!workspaceId && profile.context !== 'PLATFORM')
      throw notFound('PERMISSION_PROFILE_NOT_FOUND');
    return profile;
  }

  private async assertAssignableProfiles(
    context: PermissionContext,
    profileIds: ObjectId[],
    workspaceId?: ObjectId,
  ) {
    const profiles = await this.profiles.findManyByIds(profileIds);
    if (profiles.length !== profileIds.length) throw notFound('PERMISSION_PROFILE_NOT_FOUND');
    for (const profile of profiles) {
      const workspaceMatches =
        context === 'WORKSPACE' && workspaceId && profile.workspaceId?.equals(workspaceId);
      if (
        profile.status !== 'ACTIVE' ||
        profile.context !== context ||
        (context === 'WORKSPACE' && !workspaceMatches)
      ) {
        throw notFound('PERMISSION_PROFILE_NOT_FOUND');
      }
    }
  }

  private async validateProfileEntries(
    ctx: RequestContext,
    context: PermissionContext,
    entries: PermissionProfileEntry[],
    workspaceId?: ObjectId,
  ) {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.permission)) throw duplicate('PERMISSION_PROFILE_PERMISSION_DUPLICATE');
      seen.add(entry.permission);
      await this.assertPermissionAllowed(entry.permission, context, { type: 'WORKSPACE' });
      await this.assertCanDelegate(
        ctx,
        context,
        entry.permission,
        { type: 'WORKSPACE' },
        workspaceId,
      );
    }
  }

  private async validateGrants(
    ctx: RequestContext,
    context: PermissionContext,
    grants: GrantInput[],
    workspaceId?: ObjectId,
  ): Promise<ValidatedGrant[]> {
    const seen = new Set<string>();
    const validated: ValidatedGrant[] = [];
    for (const grant of grants) {
      const scope: PermissionScope = {
        type: grant.scope.type,
        ...(grant.scope.resourceIds
          ? {
              resourceIds: grant.scope.resourceIds.map((id) =>
                objectId(id, 'SCOPE_RESOURCE_NOT_FOUND'),
              ),
            }
          : {}),
      };
      await this.assertPermissionAllowed(grant.permission, context, scope);
      await this.validateScopeResources(context, scope, workspaceId);
      await this.assertCanDelegate(ctx, context, grant.permission, scope, workspaceId);
      const key = grantKey(grant.permission, scope);
      if (seen.has(key)) throw duplicate('ACCESS_GRANT_DUPLICATE');
      seen.add(key);
      validated.push({
        permission: grant.permission,
        effect: grant.effect,
        scope,
        ...(grant.expiresAt ? { expiresAt: new Date(grant.expiresAt) } : {}),
      });
    }
    return validated;
  }

  private async assertPermissionAllowed(
    permission: string,
    context: PermissionContext,
    scope: PermissionScope,
  ) {
    if (!permissionKeys.has(permission)) throw invalid('PERMISSION_UNKNOWN');
    const definition = await this.definitions.findActiveByKey(permission);
    if (!definition?.allowedContexts.includes(context)) {
      throw invalid('PERMISSION_CONTEXT_INVALID');
    }
    if (!definition.allowedScopes.includes(scope.type)) {
      throw invalid('PERMISSION_SCOPE_INVALID');
    }
    return definition;
  }

  private async validateScopeResources(
    context: PermissionContext,
    scope: PermissionScope,
    workspaceId?: ObjectId,
  ) {
    const ids = scope.resourceIds ?? [];
    if (scope.type === 'WORKSPACE' || scope.type === 'SELF' || scope.type === 'ASSIGNED_TRAINEES') {
      if (ids.length > 0) throw invalid('PERMISSION_SCOPE_RESOURCE_INVALID');
      return;
    }
    if (ids.length === 0) throw invalid('PERMISSION_SCOPE_RESOURCE_REQUIRED');
    if (scope.type !== 'BRANCH' && scope.type !== 'MULTIPLE_BRANCHES') return;
    if (context !== 'WORKSPACE' || !workspaceId) throw invalid('PERMISSION_SCOPE_INVALID');
    const branches = await this.branches.listByIdsInWorkspace(workspaceId, ids);
    const activeBranchIds = new Set(
      branches
        .filter((branch) => branch.status === 'ACTIVE')
        .map((branch) => branch._id.toHexString()),
    );
    if (!ids.every((id) => activeBranchIds.has(id.toHexString()))) {
      throw notFound('SCOPE_RESOURCE_NOT_FOUND');
    }
  }

  private async assertCanReplaceAccessSet(
    ctx: RequestContext,
    subjectType: AccessGrantSubjectType,
    subjectId: ObjectId,
    context: PermissionContext,
    workspaceId: ObjectId | undefined,
    nextGrants: ValidatedGrant[],
  ) {
    const previousGrants = await this.grants.listCurrent(
      subjectType,
      subjectId,
      context,
      workspaceId,
    );
    const nextKeys = new Set(nextGrants.map((grant) => grantKey(grant.permission, grant.scope)));
    for (const previousGrant of previousGrants) {
      const key = grantKey(previousGrant.permission, previousGrant.scope);
      if (!nextKeys.has(key)) {
        await this.assertCanDelegate(
          ctx,
          context,
          previousGrant.permission,
          previousGrant.scope,
          workspaceId,
        );
      }
    }
  }

  private async assertCanDelegateProfiles(
    ctx: RequestContext,
    context: PermissionContext,
    profileIds: ObjectId[],
    workspaceId?: ObjectId,
  ) {
    const profiles = await this.profiles.findManyByIds(profileIds);
    for (const profile of profiles) {
      for (const entry of profile.permissions) {
        await this.assertCanDelegate(
          ctx,
          context,
          entry.permission,
          { type: 'WORKSPACE' },
          workspaceId,
        );
      }
    }
  }

  private async assertCanDelegate(
    ctx: RequestContext,
    context: PermissionContext,
    permission: string,
    scope: PermissionScope,
    workspaceId?: ObjectId,
  ) {
    const allowed = await this.accessControl.canDelegate(ctx, {
      context,
      permission,
      ...(workspaceId ? { workspaceId } : {}),
      scope,
    });
    if (!allowed) {
      throw new AppError({
        code: 'DELEGATION_DENIED',
        httpStatus: 403,
        message: 'Permission delegation is denied.',
      });
    }
  }

  private async writeAudit(
    ctx: RequestContext,
    workspaceId: ObjectId | undefined,
    eventType: string,
    entityId: ObjectId,
    action: string,
    tx: TransactionContext,
    before?: Record<string, unknown>,
    after?: Record<string, unknown>,
  ) {
    await this.audit.write(
      {
        eventType,
        ...(workspaceId ? { workspaceId } : {}),
        actor: {
          ...(ctx.userId ? { userId: objectId(ctx.userId, 'AUTH_REQUIRED') } : {}),
          ...(ctx.platformMembershipId
            ? { platformMembershipId: objectId(ctx.platformMembershipId, 'AUTH_REQUIRED') }
            : {}),
          ...(ctx.workspaceMembershipId
            ? { workspaceMembershipId: objectId(ctx.workspaceMembershipId, 'AUTH_REQUIRED') }
            : {}),
        },
        entity: { type: eventType, id: entityId },
        action,
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
        ipAddress: ctx.ipAddress,
        ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }

  private async writeOutbox(
    ctx: RequestContext,
    workspaceId: ObjectId | undefined,
    eventType: string,
    aggregateType: string,
    aggregateId: ObjectId,
    tx: TransactionContext,
    payload: Record<string, unknown> = {},
  ) {
    await this.outbox.write(
      {
        eventType,
        aggregateType,
        aggregateId,
        ...(workspaceId ? { workspaceId } : {}),
        payload: {
          context: workspaceId ? 'WORKSPACE' : 'PLATFORM',
          aggregateId: aggregateId.toHexString(),
          ...payload,
        },
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }
}

interface GrantInput {
  permission: string;
  effect: PermissionEffect;
  scope: { type: PermissionScope['type']; resourceIds?: string[] };
  expiresAt?: string;
}

interface ValidatedGrant {
  permission: string;
  effect: PermissionEffect;
  scope: PermissionScope;
  expiresAt?: Date;
}

function safeProfile(profile: PermissionProfileDocument) {
  return {
    id: profile._id.toHexString(),
    context: profile.context,
    workspaceId: profile.workspaceId?.toHexString(),
    name: profile.name,
    roleKey: profile.roleKey,
    permissions: profile.permissions,
    isSystemDefault: profile.isSystemDefault,
    status: profile.status,
    version: profile.version,
  };
}

function safeAssignment(membershipId: ObjectId, profileIds: ObjectId[], accessVersion: number) {
  return {
    membershipId: membershipId.toHexString(),
    profileIds: profileIds.map((id) => id.toHexString()),
    accessVersion,
  };
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

function safeValidatedGrant(grant: ValidatedGrant) {
  return {
    permission: grant.permission,
    effect: grant.effect,
    scope: {
      type: grant.scope.type,
      resourceIds: grant.scope.resourceIds?.map((id) => id.toHexString()),
    },
    expiresAt: grant.expiresAt?.toISOString(),
  };
}

function objectId(value: string | undefined, code: string): ObjectId {
  if (!value || !ObjectId.isValid(value)) throw notFound(code);
  return new ObjectId(value);
}

function uniqueObjectIds(values: string[], code: string): ObjectId[] {
  const seen = new Set<string>();
  return values.map((value) => {
    const id = objectId(value, 'PERMISSION_PROFILE_NOT_FOUND');
    const key = id.toHexString();
    if (seen.has(key)) throw duplicate(code);
    seen.add(key);
    return id;
  });
}

function grantKey(permission: string, scope: PermissionScope): string {
  return `${permission}|${scope.type}|${(scope.resourceIds ?? [])
    .map((id) => id.toHexString())
    .sort()
    .join(',')}`;
}

function invalid(code: string): AppError {
  return new AppError({ code, httpStatus: 422, message: 'The permission request is invalid.' });
}

function duplicate(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'Duplicate permission access entry.' });
}

function notFound(code: string): AppError {
  return new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
}
