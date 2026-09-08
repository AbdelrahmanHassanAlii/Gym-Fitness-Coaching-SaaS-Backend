import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { AccessControlService } from '../src/core/access-control/access-control.service';
import type { RequestContext } from '../src/core/request-context/request-context';
import { Permissions } from '../src/modules/permissions/permission.registry';

describe('Stage 4 access control', () => {
  test('explicit ALLOW overrides profile DENY for the same permission', async () => {
    const ids = testIds();
    const service = serviceWith({
      ids,
      profiles: [
        {
          _id: ids.profileId,
          context: 'WORKSPACE',
          workspaceId: ids.workspaceId,
          status: 'ACTIVE',
          permissions: [{ permission: Permissions.StaffPermissionsManage, effect: 'DENY' }],
        },
      ],
      grants: [
        {
          _id: ids.grantId,
          context: 'WORKSPACE',
          workspaceId: ids.workspaceId,
          subjectType: 'WORKSPACE_MEMBERSHIP',
          subjectId: ids.membershipId,
          permission: Permissions.StaffPermissionsManage,
          effect: 'ALLOW',
          scope: { type: 'WORKSPACE' },
          createdBy: ids.userId,
          createdAt: new Date(),
        },
      ],
    });

    const decision = await service.authorize(ctx(ids), {
      context: 'WORKSPACE',
      workspaceId: ids.workspaceId,
      permission: Permissions.StaffPermissionsManage,
      scope: { type: 'WORKSPACE' },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe('EXPLICIT_GRANT');
    expect(decision.effect).toBe('ALLOW');
  });

  test('explicit DENY wins over explicit ALLOW at equal specificity', async () => {
    const ids = testIds();
    const service = serviceWith({
      ids,
      profiles: [
        {
          _id: ids.profileId,
          context: 'WORKSPACE',
          workspaceId: ids.workspaceId,
          status: 'ACTIVE',
          permissions: [{ permission: Permissions.StaffPermissionsManage, effect: 'ALLOW' }],
        },
      ],
      grants: ['ALLOW', 'DENY'].map((effect) => ({
        _id: new ObjectId(),
        context: 'WORKSPACE' as const,
        workspaceId: ids.workspaceId,
        subjectType: 'WORKSPACE_MEMBERSHIP' as const,
        subjectId: ids.membershipId,
        permission: Permissions.StaffPermissionsManage,
        effect: effect as 'ALLOW' | 'DENY',
        scope: { type: 'WORKSPACE' as const },
        createdBy: ids.userId,
        createdAt: new Date(),
      })),
    });

    await expect(
      service.authorize(ctx(ids), {
        context: 'WORKSPACE',
        workspaceId: ids.workspaceId,
        permission: Permissions.StaffPermissionsManage,
        scope: { type: 'WORKSPACE' },
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', httpStatus: 403 });
  });

  test('branch-scoped authorization cannot bypass active branch assignment', async () => {
    const ids = testIds();
    const service = serviceWith({
      ids,
      profiles: [],
      branchAssignments: [],
      grants: [
        {
          _id: ids.grantId,
          context: 'WORKSPACE',
          workspaceId: ids.workspaceId,
          subjectType: 'WORKSPACE_MEMBERSHIP',
          subjectId: ids.membershipId,
          permission: Permissions.BranchesManage,
          effect: 'ALLOW',
          scope: { type: 'BRANCH', resourceIds: [ids.branchId] },
          createdBy: ids.userId,
          createdAt: new Date(),
        },
      ],
    });

    await expect(
      service.authorize(ctx(ids), {
        context: 'WORKSPACE',
        workspaceId: ids.workspaceId,
        permission: Permissions.BranchesManage,
        scope: { type: 'BRANCH', resourceIds: [ids.branchId] },
      }),
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED', httpStatus: 403 });
  });
});

function serviceWith(input: {
  ids: ReturnType<typeof testIds>;
  profiles: Array<Record<string, unknown>>;
  grants: Array<Record<string, unknown>>;
  branchAssignments?: Array<Record<string, unknown>>;
}) {
  const { ids } = input;
  return new AccessControlService(
    { findActiveByUserId: async () => null } as never,
    { findById: async () => ({ _id: ids.workspaceId, status: 'ACTIVE' }) } as never,
    {
      findByUserInWorkspace: async () => ({
        _id: ids.membershipId,
        workspaceId: ids.workspaceId,
        userId: ids.userId,
        status: 'ACTIVE',
        permissionProfileIds: input.profiles.map((profile) => profile._id as ObjectId),
      }),
    } as never,
    { listActive: async () => input.branchAssignments ?? [] } as never,
    { findManyByIds: async () => input.profiles } as never,
    {
      listCurrent: async () => input.grants,
    } as never,
  ) as AccessControlService;
}

function testIds() {
  return {
    userId: new ObjectId(),
    workspaceId: new ObjectId(),
    membershipId: new ObjectId(),
    profileId: new ObjectId(),
    grantId: new ObjectId(),
    branchId: new ObjectId(),
  };
}

function ctx(ids: ReturnType<typeof testIds>): RequestContext {
  return {
    correlationId: 'test-correlation',
    userId: ids.userId.toHexString(),
    authSessionId: new ObjectId().toHexString(),
    ipAddress: '127.0.0.1',
    locale: 'en',
    timezone: 'Africa/Cairo',
  };
}
