import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { AccessControlService } from '../src/core/access-control/access-control.service';
import type { RequestContext } from '../src/core/request-context/request-context';
import { Permissions } from '../src/modules/permissions/permission.registry';
import type { PermissionScope } from '../src/modules/permissions/permission.types';
import { TraineeApplicationService } from '../src/modules/trainees/trainee.service';

describe('Stage 19 current-user effective access decisions', () => {
  test('own active membership succeeds with minimized decision response', async () => {
    const ids = testIds();
    const result = await accessServiceWith({
      ids,
      profiles: [profile(ids, [{ permission: Permissions.WorkoutsCreate, effect: 'ALLOW' }])],
      accessVersion: 3,
    }).currentEffectiveAccessDecisions(ctx(ids), ids.workspaceId, {
      expectedAccessVersion: 3,
      requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
    });

    expect(result).toEqual({
      workspaceId: hex(ids.workspaceId),
      membershipId: hex(ids.membershipId),
      accessVersion: 3,
      context: 'USER',
      decisions: [
        {
          request: { permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' },
          allowed: true,
          effect: 'ALLOW',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('grant');
    expect(JSON.stringify(result)).not.toContain('profile');
    expect(JSON.stringify(result)).not.toContain('includeBranchIds');
    expect(JSON.stringify(result)).not.toContain('supportSessionId');
  });

  test('rejects malformed request shapes with frozen codes', async () => {
    const ids = testIds();
    const service = accessServiceWith({ ids });
    const cases = [
      {
        body: { requests: requestList(26) },
        code: 'ACCESS_DECISION_BATCH_TOO_LARGE',
      },
      {
        body: { requests: [{ permission: 'missing.permission', scope: 'WORKSPACE' }] },
        code: 'PERMISSION_UNKNOWN',
      },
      {
        body: { requests: [{ permission: Permissions.WorkoutsCreate, scope: 'NOPE' }] },
        code: 'PERMISSION_SCOPE_INVALID',
      },
      {
        body: {
          requests: [
            {
              permission: Permissions.WorkoutsCreate,
              scope: 'WORKSPACE',
              branchId: hex(ids.branchId),
            },
          ],
        },
        code: 'PERMISSION_SCOPE_INVALID',
      },
      {
        body: { requests: [{ permission: Permissions.WorkoutsCreate, scope: 'BRANCH' }] },
        code: 'PERMISSION_SCOPE_INVALID',
      },
      {
        body: {
          requests: [
            {
              permission: Permissions.WorkoutsCreate,
              scope: 'RELATIONSHIP',
              branchId: hex(ids.branchId),
              relationshipId: hex(ids.relationshipId),
            },
          ],
        },
        code: 'PERMISSION_SCOPE_INVALID',
      },
      {
        body: {
          requests: [
            { permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' },
            { permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' },
          ],
        },
        code: 'ACCESS_DECISION_REQUEST_DUPLICATE',
      },
    ];

    for (const testCase of cases) {
      await expect(
        service.currentEffectiveAccessDecisions(ctx(ids), ids.workspaceId, testCase.body as never),
      ).rejects.toMatchObject({ code: testCase.code });
    }
  });

  test('validates branch and relationship workspace ownership before evaluation', async () => {
    const ids = testIds();
    await expect(
      accessServiceWith({ ids, branches: [] }).currentEffectiveAccessDecisions(
        ctx(ids),
        ids.workspaceId,
        {
          requests: [
            {
              permission: Permissions.WorkoutsCreate,
              scope: 'BRANCH',
              branchId: hex(ids.branchId),
            },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });

    await expect(
      accessServiceWith({ ids, relationship: null }).currentEffectiveAccessDecisions(
        ctx(ids),
        ids.workspaceId,
        {
          requests: [
            {
              permission: Permissions.WorkoutsCreate,
              scope: 'RELATIONSHIP',
              relationshipId: hex(ids.relationshipId),
            },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: 'RELATIONSHIP_NOT_FOUND' });
  });

  test('returns DENY decisions without exposing policy provenance', async () => {
    const ids = testIds();
    const result = await accessServiceWith({
      ids,
      profiles: [profile(ids, [{ permission: Permissions.WorkoutsCreate, effect: 'ALLOW' }])],
      grants: [
        grant(ids, Permissions.WorkoutsCreate, 'DENY', {
          scope: { type: 'SPECIFIC_TRAINEES', resourceIds: [ids.relationshipId] },
        }),
      ],
    }).currentEffectiveAccessDecisions(ctx(ids), ids.workspaceId, {
      requests: [
        {
          permission: Permissions.WorkoutsCreate,
          scope: 'RELATIONSHIP',
          relationshipId: hex(ids.relationshipId),
        },
      ],
    });

    expect(result.decisions).toEqual([
      {
        request: {
          permission: Permissions.WorkoutsCreate,
          scope: 'RELATIONSHIP',
          relationshipId: hex(ids.relationshipId),
        },
        allowed: false,
        effect: 'DENY',
      },
    ]);
  });

  test('preserves locked Stage 4 branch assignment checks', async () => {
    const ids = testIds();
    const result = await accessServiceWith({
      ids,
      profiles: [profile(ids, [{ permission: Permissions.WorkoutsCreate, effect: 'ALLOW' }])],
    }).currentEffectiveAccessDecisions(ctx(ids), ids.workspaceId, {
      requests: [
        {
          permission: Permissions.WorkoutsCreate,
          scope: 'BRANCH',
          branchId: hex(ids.branchId),
        },
      ],
    });

    expect(result.decisions).toEqual([
      {
        request: {
          permission: Permissions.WorkoutsCreate,
          scope: 'BRANCH',
          branchId: hex(ids.branchId),
        },
        allowed: false,
        effect: 'DENY',
      },
    ]);
  });

  test('enforces accessVersion precondition and support context boundaries', async () => {
    const ids = testIds();
    const service = accessServiceWith({
      ids,
      profiles: [profile(ids, [{ permission: Permissions.WorkoutsCreate, effect: 'ALLOW' }])],
      accessVersion: 4,
    });

    await expect(
      service.currentEffectiveAccessDecisions(ctx(ids), ids.workspaceId, {
        expectedAccessVersion: 3,
        requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_MEMBERSHIP_ACCESS_VERSION_CONFLICT' });

    await expect(
      service.currentEffectiveAccessDecisions(supportWorkspaceCtx(ids), ids.workspaceId, {
        requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
      }),
    ).rejects.toMatchObject({ code: 'SUPPORT_WORKSPACE_DENIED' });

    await expect(
      service.currentEffectiveAccessDecisions(supportUserCtx(ids), ids.workspaceId, {
        requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
      }),
    ).resolves.toMatchObject({ context: 'SUPPORT_USER_CONTEXT' });
  });

  test('rejects decisions when accessVersion changes during evaluation', async () => {
    const ids = testIds();
    await expect(
      accessServiceWith({
        ids,
        profiles: [profile(ids, [{ permission: Permissions.WorkoutsCreate, effect: 'ALLOW' }])],
        accessVersion: 3,
        postEvaluationAccessVersion: 4,
      }).currentEffectiveAccessDecisions(ctx(ids), ids.workspaceId, {
        expectedAccessVersion: 3,
        requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_MEMBERSHIP_ACCESS_VERSION_CONFLICT' });
  });
});

describe('Stage 19 trainee self relationship discovery', () => {
  test('returns only minimized ACTIVE self relationship identity', async () => {
    const ids = testIds();
    const result = await traineeServiceWith({ ids }).getCurrentUserRelationship(
      ctx(ids),
      hex(ids.workspaceId),
    );

    expect(result).toEqual({
      relationship: {
        id: hex(ids.relationshipId),
        workspaceId: hex(ids.workspaceId),
        status: 'ACTIVE',
        version: 2,
      },
    });
    expect(JSON.stringify(result)).not.toContain('traineeUserId');
    expect(JSON.stringify(result)).not.toContain('traineeMembershipId');
    expect(JSON.stringify(result)).not.toContain('homeBranchId');
  });

  test('returns 200-null semantics for absent and non-ACTIVE relationships', async () => {
    const ids = testIds();
    for (const status of ['PENDING', 'NEEDS_REASSIGNMENT', 'ENDED', 'ARCHIVED'] as const) {
      await expect(
        traineeServiceWith({ ids, relationshipStatus: status }).getCurrentUserRelationship(
          ctx(ids),
          hex(ids.workspaceId),
        ),
      ).resolves.toEqual({ relationship: null });
    }

    await expect(
      traineeServiceWith({ ids, relationship: null }).getCurrentUserRelationship(
        ctx(ids),
        hex(ids.workspaceId),
      ),
    ).resolves.toEqual({ relationship: null });
  });

  test('uses authenticated/effective user identity and active membership as hard boundaries', async () => {
    const ids = testIds();
    const otherUserId = new ObjectId();
    const service = traineeServiceWith({ ids });
    await service.getCurrentUserRelationship(
      ctx(ids, { userId: otherUserId }),
      hex(ids.workspaceId),
    );
    expect(service.lastRelationshipLookup()).toEqual({
      workspaceId: hex(ids.workspaceId),
      traineeUserId: hex(otherUserId),
    });

    await expect(
      traineeServiceWith({ ids, membershipStatus: 'SUSPENDED' }).getCurrentUserRelationship(
        ctx(ids),
        hex(ids.workspaceId),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await expect(
      traineeServiceWith({ ids, workspaceStatus: 'ARCHIVED' }).getCurrentUserRelationship(
        ctx(ids),
        hex(ids.workspaceId),
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_INACTIVE' });
  });
});

function accessServiceWith(input: {
  ids: ReturnType<typeof testIds>;
  profiles?: Array<Record<string, unknown>>;
  grants?: Array<Record<string, unknown>>;
  branches?: Array<Record<string, unknown>>;
  relationship?: AccessRelationshipFixture | null;
  accessVersion?: number;
  postEvaluationAccessVersion?: number;
  membershipStatus?: 'ACTIVE' | 'SUSPENDED' | 'ENDED';
}) {
  const profiles = input.profiles ?? [];
  return new AccessControlService(
    { findActiveByUserId: async () => null } as never,
    { findById: async () => ({ _id: input.ids.workspaceId, status: 'ACTIVE' }) } as never,
    { listByIdsInWorkspace: async () => input.branches ?? [branch(input.ids, 'ACTIVE')] } as never,
    {
      findByIdInWorkspace: async () => {
        const accessVersion = input.postEvaluationAccessVersion ?? input.accessVersion;
        return membership(accessVersion === undefined ? input : { ...input, accessVersion });
      },
      findByUserInWorkspace: async () => membership(input),
    } as never,
    { listActive: async () => [] } as never,
    { findManyByIds: async () => profiles } as never,
    { listCurrent: async () => input.grants ?? [] } as never,
    {
      findByIdInWorkspace: async (_workspaceId: ObjectId, relationshipId: ObjectId) => {
        if (input.relationship === null || !relationshipId.equals(input.ids.relationshipId)) {
          return null;
        }
        return (
          input.relationship ?? {
            _id: input.ids.relationshipId,
            workspaceId: input.ids.workspaceId,
            traineeUserId: input.ids.traineeUserId,
            status: 'ACTIVE',
          }
        );
      },
    },
  );
}

function traineeServiceWith(input: {
  ids: ReturnType<typeof testIds>;
  relationshipStatus?: 'PENDING' | 'ACTIVE' | 'NEEDS_REASSIGNMENT' | 'ENDED' | 'ARCHIVED';
  relationship?: TraineeRelationshipFixture | null;
  membershipStatus?: 'ACTIVE' | 'SUSPENDED' | 'ENDED';
  workspaceStatus?: 'ACTIVE' | 'ARCHIVED';
}) {
  let lastLookup: { workspaceId: string; traineeUserId: string } | undefined;
  const relationships = {
    findByWorkspaceAndUser: async (workspaceId: ObjectId, traineeUserId: ObjectId) => {
      lastLookup = { workspaceId: hex(workspaceId), traineeUserId: hex(traineeUserId) };
      if (input.relationship === null) return null;
      return (
        input.relationship ?? {
          _id: input.ids.relationshipId,
          workspaceId: input.ids.workspaceId,
          traineeUserId,
          status: input.relationshipStatus ?? 'ACTIVE',
          version: 2,
        }
      );
    },
  };
  const workspaces = {
    findById: async () => ({
      _id: input.ids.workspaceId,
      status: input.workspaceStatus ?? 'ACTIVE',
    }),
  };
  const memberships = {
    findByUserInWorkspace: async () => ({
      _id: input.ids.membershipId,
      workspaceId: input.ids.workspaceId,
      userId: input.ids.userId,
      status: input.membershipStatus ?? 'ACTIVE',
      roles: ['TRAINEE'],
    }),
  };
  const service = new TraineeApplicationService(
    undefined as never,
    relationships as never,
    undefined as never,
    workspaces as never,
    memberships as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  ) as TraineeApplicationService & {
    lastRelationshipLookup(): { workspaceId: string; traineeUserId: string } | undefined;
  };
  service.lastRelationshipLookup = () => lastLookup;
  return service;
}

function testIds() {
  return {
    userId: new ObjectId(),
    traineeUserId: new ObjectId(),
    workspaceId: new ObjectId(),
    membershipId: new ObjectId(),
    branchId: new ObjectId(),
    relationshipId: new ObjectId(),
    sessionId: new ObjectId(),
    profileId: new ObjectId(),
    grantId: new ObjectId(),
    supportSessionId: new ObjectId(),
  };
}

function ctx(ids: ReturnType<typeof testIds>, options: { userId?: ObjectId } = {}): RequestContext {
  return {
    correlationId: 'stage19-test',
    userId: hex(options.userId ?? ids.userId),
    authSessionId: hex(ids.sessionId),
    ipAddress: '127.0.0.1',
    locale: 'en',
    timezone: 'Africa/Cairo',
  };
}

interface AccessRelationshipFixture {
  _id: ObjectId;
  workspaceId: ObjectId;
  homeBranchId?: ObjectId;
  traineeUserId?: ObjectId;
  status?: string;
}

interface TraineeRelationshipFixture {
  _id: ObjectId;
  workspaceId: ObjectId;
  traineeUserId: ObjectId;
  status: 'PENDING' | 'ACTIVE' | 'NEEDS_REASSIGNMENT' | 'ENDED' | 'ARCHIVED';
  version: number;
}

function supportWorkspaceCtx(ids: ReturnType<typeof testIds>): RequestContext {
  return {
    ...ctx(ids),
    supportSessionId: hex(ids.supportSessionId),
    workspaceId: hex(ids.workspaceId),
  };
}

function supportUserCtx(ids: ReturnType<typeof testIds>): RequestContext {
  return {
    ...supportWorkspaceCtx(ids),
    effectiveUserId: hex(ids.userId),
    effectiveMembershipId: hex(ids.membershipId),
  };
}

function requestList(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    permission: index === 0 ? Permissions.WorkoutsCreate : Permissions.WorkoutsRead,
    scope: 'WORKSPACE',
  }));
}

function membership(input: {
  ids: ReturnType<typeof testIds>;
  profiles?: Array<Record<string, unknown>>;
  accessVersion?: number;
  membershipStatus?: 'ACTIVE' | 'SUSPENDED' | 'ENDED';
}) {
  return {
    _id: input.ids.membershipId,
    workspaceId: input.ids.workspaceId,
    userId: input.ids.userId,
    status: input.membershipStatus ?? 'ACTIVE',
    roles: ['GYM_OWNER'],
    permissionProfileIds: (input.profiles ?? []).map((item) => item._id as ObjectId),
    accessVersion: input.accessVersion ?? 0,
  };
}

function profile(
  ids: ReturnType<typeof testIds>,
  permissions: Array<{ permission: string; effect: 'ALLOW' | 'DENY' }>,
) {
  return {
    _id: ids.profileId,
    context: 'WORKSPACE',
    workspaceId: ids.workspaceId,
    permissions,
    status: 'ACTIVE',
  };
}

function grant(
  ids: ReturnType<typeof testIds>,
  permission: string,
  effect: 'ALLOW' | 'DENY',
  options: { scope?: PermissionScope } = {},
) {
  return {
    _id: ids.grantId,
    context: 'WORKSPACE',
    workspaceId: ids.workspaceId,
    subjectType: 'WORKSPACE_MEMBERSHIP',
    subjectId: ids.membershipId,
    permission,
    effect,
    scope: options.scope ?? { type: 'WORKSPACE' },
    createdBy: ids.userId,
    createdAt: new Date(),
  };
}

function branch(ids: ReturnType<typeof testIds>, status: 'ACTIVE' | 'ARCHIVED') {
  return {
    _id: ids.branchId,
    workspaceId: ids.workspaceId,
    status,
  };
}

function hex(id: ObjectId) {
  return id.toHexString();
}
