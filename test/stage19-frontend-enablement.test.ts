import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { type Db, ObjectId } from 'mongodb';
import { buildApp } from '../src/api/build-app';
import type { AppContainer } from '../src/bootstrap/app-container';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { AccessControlService } from '../src/core/access-control/access-control.service';
import type { RequestContext } from '../src/core/request-context/request-context';
import { migrations } from '../src/migrations';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { Permissions } from '../src/modules/permissions/permission.registry';
import type { PermissionScope } from '../src/modules/permissions/permission.types';
import { TraineeApplicationService } from '../src/modules/trainees/trainee.service';
import type { CoachingRelationshipStatus } from '../src/modules/trainees/trainee.types';

const ROUTE_TEST_TIMEOUT_MS = 30_000;

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

describe('Stage 19 Fastify route integration', () => {
  let container: AppContainer;
  let app: FastifyInstance;
  let db: Db;

  beforeAll(async () => {
    container = await createAppContainer(
      routeIntegrationConfig(`stage19_routes_${new ObjectId().toHexString()}`),
    );
    await new MigrationRunner(container.database.db, migrations).migrate();
    app = await buildApp(container);
    db = container.database.db;
  }, ROUTE_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (app) await app.close();
    if (container) {
      await container.database.db.dropDatabase();
      await container.database.close();
    }
  }, ROUTE_TEST_TIMEOUT_MS);

  test(
    'GET /me/relationship returns only ACTIVE self relationship identity through auth and Mongo',
    async () => {
      const active = await seedRouteWorkspace({
        roles: ['TRAINEE'],
        relationshipStatus: 'ACTIVE',
      });
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${active.workspaceId}/me/relationship`,
        headers: bearer(active.token),
        query: {
          traineeUserId: new ObjectId().toHexString(),
          membershipId: new ObjectId().toHexString(),
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual({
        relationship: {
          id: active.relationshipId,
          workspaceId: active.workspaceId,
          status: 'ACTIVE',
          version: 2,
        },
      });
      expect(Object.keys(response.json().data.relationship)).toEqual([
        'id',
        'workspaceId',
        'status',
        'version',
      ]);

      const none = await seedRouteWorkspace({ roles: ['TRAINEE'], relationship: false });
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/workspaces/${none.workspaceId}/me/relationship`,
            headers: bearer(none.token),
          })
        ).json().data,
      ).toEqual({ relationship: null });

      for (const status of ['PENDING', 'NEEDS_REASSIGNMENT', 'ENDED', 'ARCHIVED'] as const) {
        const seeded = await seedRouteWorkspace({ roles: ['TRAINEE'], relationshipStatus: status });
        const statusResponse = await app.inject({
          method: 'GET',
          url: `/api/v1/workspaces/${seeded.workspaceId}/me/relationship`,
          headers: bearer(seeded.token),
        });
        expect(statusResponse.statusCode, status).toBe(200);
        expect(statusResponse.json().data, status).toEqual({ relationship: null });
      }
    },
    ROUTE_TEST_TIMEOUT_MS,
  );

  test(
    'GET /me/relationship is bounded by authenticated user, workspace, and active lifecycle',
    async () => {
      const other = await seedRouteWorkspace({ roles: ['TRAINEE'], relationshipStatus: 'ACTIVE' });
      const caller = await seedRouteWorkspace({ roles: ['TRAINEE'], relationship: false });
      const wrongUser = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${other.workspaceId}/me/relationship`,
        headers: bearer(caller.token),
      });
      expect(wrongUser.statusCode).toBe(403);

      const wrongWorkspace = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${caller.workspaceId}/me/relationship`,
        headers: bearer(other.token),
      });
      expect(wrongWorkspace.statusCode).toBe(403);

      const inactiveMembership = await seedRouteWorkspace({
        roles: ['TRAINEE'],
        membershipStatus: 'SUSPENDED',
      });
      const inactiveMembershipResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${inactiveMembership.workspaceId}/me/relationship`,
        headers: bearer(inactiveMembership.token),
      });
      expect(inactiveMembershipResponse.statusCode).toBe(403);

      const inactiveWorkspace = await seedRouteWorkspace({
        roles: ['TRAINEE'],
        workspaceStatus: 'ARCHIVED',
      });
      const inactiveWorkspaceResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${inactiveWorkspace.workspaceId}/me/relationship`,
        headers: bearer(inactiveWorkspace.token),
      });
      expect(inactiveWorkspaceResponse.statusCode).toBe(409);
      expect(inactiveWorkspaceResponse.json().error.code).toBe('WORKSPACE_INACTIVE');
    },
    ROUTE_TEST_TIMEOUT_MS,
  );

  test(
    'POST /me/effective-access/decisions validates request shapes and returns minimized decisions',
    async () => {
      const seeded = await seedRouteWorkspace({
        roles: ['GYM_OWNER'],
        permissions: [{ permission: Permissions.WorkoutsCreate, effect: 'ALLOW' }],
        accessVersion: 7,
        branchAssignment: true,
      });

      const valid = await postDecisions(seeded, {
        expectedAccessVersion: 7,
        requests: [
          { permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' },
          { permission: Permissions.WorkoutsCreate, scope: 'BRANCH', branchId: seeded.branchId },
          {
            permission: Permissions.WorkoutsCreate,
            scope: 'RELATIONSHIP',
            relationshipId: seeded.relationshipId,
          },
        ],
      });
      expect(valid.statusCode).toBe(200);
      expect(valid.json().data).toEqual({
        workspaceId: seeded.workspaceId,
        membershipId: seeded.membershipId,
        accessVersion: 7,
        context: 'USER',
        decisions: [
          {
            request: { permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' },
            allowed: true,
            effect: 'ALLOW',
          },
          {
            request: {
              permission: Permissions.WorkoutsCreate,
              scope: 'BRANCH',
              branchId: seeded.branchId,
            },
            allowed: true,
            effect: 'ALLOW',
          },
          {
            request: {
              permission: Permissions.WorkoutsCreate,
              scope: 'RELATIONSHIP',
              relationshipId: seeded.relationshipId,
            },
            allowed: true,
            effect: 'ALLOW',
          },
        ],
      });
      const serialized = JSON.stringify(valid.json().data);
      for (const forbidden of [
        'grant',
        'profile',
        'includeBranchIds',
        'excludeBranchIds',
        'includeRelationshipIds',
        'excludeRelationshipIds',
        'supportSessionId',
        'workspaceAllowed',
        'assignedTrainees',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }

      const malformedCases = [
        {
          request: {
            permission: Permissions.WorkoutsCreate,
            scope: 'WORKSPACE',
            branchId: seeded.branchId,
          },
        },
        {
          request: {
            permission: Permissions.WorkoutsCreate,
            scope: 'WORKSPACE',
            relationshipId: seeded.relationshipId,
          },
        },
        { request: { permission: Permissions.WorkoutsCreate, scope: 'BRANCH' } },
        {
          request: {
            permission: Permissions.WorkoutsCreate,
            scope: 'BRANCH',
            branchId: seeded.branchId,
            relationshipId: seeded.relationshipId,
          },
        },
        { request: { permission: Permissions.WorkoutsCreate, scope: 'RELATIONSHIP' } },
        {
          request: {
            permission: Permissions.WorkoutsCreate,
            scope: 'RELATIONSHIP',
            branchId: seeded.branchId,
            relationshipId: seeded.relationshipId,
          },
        },
        { request: { permission: Permissions.WorkoutsCreate, scope: 'NOPE' } },
      ];
      for (const item of malformedCases) {
        const response = await postDecisions(seeded, { requests: [item.request] });
        expect(response.statusCode).toBe(422);
        expect(response.json().error.code).toBe('PERMISSION_SCOPE_INVALID');
      }

      const unknownPermission = await postDecisions(seeded, {
        requests: [{ permission: 'unknown.permission', scope: 'WORKSPACE' }],
      });
      expect(unknownPermission.statusCode).toBe(422);
      expect(unknownPermission.json().error.code).toBe('PERMISSION_UNKNOWN');

      const duplicate = await postDecisions(seeded, {
        requests: [
          { permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' },
          { permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' },
        ],
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().error.code).toBe('ACCESS_DECISION_REQUEST_DUPLICATE');

      const stale = await postDecisions(seeded, {
        expectedAccessVersion: 6,
        requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe('WORKSPACE_MEMBERSHIP_ACCESS_VERSION_CONFLICT');
    },
    ROUTE_TEST_TIMEOUT_MS,
  );

  test(
    'POST /me/effective-access/decisions rejects wrong-workspace targets and preserves Stage 4 DENY and branch assignment',
    async () => {
      const seeded = await seedRouteWorkspace({
        roles: ['GYM_MANAGER'],
        permissions: [{ permission: Permissions.WorkoutsCreate, effect: 'ALLOW' }],
      });
      const other = await seedRouteWorkspace({
        roles: ['GYM_OWNER'],
        permissions: [{ permission: Permissions.WorkoutsCreate, effect: 'ALLOW' }],
      });

      const wrongBranch = await postDecisions(seeded, {
        requests: [
          { permission: Permissions.WorkoutsCreate, scope: 'BRANCH', branchId: other.branchId },
        ],
      });
      expect(wrongBranch.statusCode).toBe(404);
      expect(wrongBranch.json().error.code).toBe('BRANCH_NOT_FOUND');

      const wrongRelationship = await postDecisions(seeded, {
        requests: [
          {
            permission: Permissions.WorkoutsCreate,
            scope: 'RELATIONSHIP',
            relationshipId: other.relationshipId,
          },
        ],
      });
      expect(wrongRelationship.statusCode).toBe(404);
      expect(wrongRelationship.json().error.code).toBe('RELATIONSHIP_NOT_FOUND');

      const branchWithoutAssignment = await postDecisions(seeded, {
        requests: [
          { permission: Permissions.WorkoutsCreate, scope: 'BRANCH', branchId: seeded.branchId },
        ],
      });
      expect(branchWithoutAssignment.statusCode).toBe(200);
      expect(branchWithoutAssignment.json().data.decisions[0]).toMatchObject({
        allowed: false,
        effect: 'DENY',
      });

      const denied = await seedRouteWorkspace({
        roles: ['GYM_OWNER'],
        permissions: [{ permission: Permissions.WorkoutsCreate, effect: 'ALLOW' }],
        grants: [
          { permission: Permissions.WorkoutsCreate, effect: 'DENY', scope: { type: 'WORKSPACE' } },
        ],
      });
      const denyResponse = await postDecisions(denied, {
        requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
      });
      expect(denyResponse.statusCode).toBe(200);
      expect(denyResponse.json().data.decisions[0]).toMatchObject({
        allowed: false,
        effect: 'DENY',
      });
    },
    ROUTE_TEST_TIMEOUT_MS,
  );

  test(
    'POST /me/effective-access/decisions enforces batch limits and does not accept membership selection',
    async () => {
      const seeded = await seedRouteWorkspace({
        roles: ['GYM_OWNER'],
        permissions: [
          { permission: Permissions.WorkoutsCreate, effect: 'ALLOW' },
          { permission: Permissions.WorkoutsRead, effect: 'ALLOW' },
        ],
      });
      const relationshipIds = await seedAdditionalRelationships(seeded, 26);
      const twentyFive = await postDecisions(seeded, {
        requests: relationshipIds.slice(0, 25).map((relationshipId, index) => ({
          permission: index % 2 === 0 ? Permissions.WorkoutsCreate : Permissions.WorkoutsRead,
          scope: 'RELATIONSHIP',
          relationshipId,
        })),
      });
      expect(twentyFive.statusCode).toBe(200);
      expect(twentyFive.json().data.membershipId).toBe(seeded.membershipId);

      const tooMany = await postDecisions(seeded, {
        requests: relationshipIds.map((relationshipId, index) => ({
          permission: index % 2 === 0 ? Permissions.WorkoutsCreate : Permissions.WorkoutsRead,
          scope: 'RELATIONSHIP',
          relationshipId,
        })),
      });
      expect(tooMany.statusCode).toBe(422);
      expect(tooMany.json().error.code).toBe('ACCESS_DECISION_BATCH_TOO_LARGE');

      const arbitraryMembership = new ObjectId().toHexString();
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${seeded.workspaceId}/me/effective-access/decisions?membershipId=${arbitraryMembership}`,
        headers: bearer(seeded.token),
        payload: {
          membershipId: arbitraryMembership,
          requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    },
    ROUTE_TEST_TIMEOUT_MS,
  );

  test(
    'POST /me/effective-access/decisions uses existing support USER_CONTEXT and denies WORKSPACE_SUPPORT',
    async () => {
      const target = await seedRouteWorkspace({
        roles: ['GYM_OWNER'],
        permissions: [{ permission: Permissions.WorkoutsCreate, effect: 'ALLOW' }],
      });
      const support = await seedSupportActor(target);
      const userContext = await startSupportSession(support, target, 'USER_CONTEXT', 'READ_ONLY');
      const userContextResponse = await postDecisions(
        target,
        {
          requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
        },
        { token: support.token, supportSessionId: userContext },
      );
      expect(userContextResponse.statusCode).toBe(200);
      expect(userContextResponse.json().data).toMatchObject({
        membershipId: target.membershipId,
        context: 'SUPPORT_USER_CONTEXT',
      });
      expect(JSON.stringify(userContextResponse.json().data)).not.toContain('supportSessionId');
      expect(JSON.stringify(userContextResponse.json().data)).not.toContain('grant');
      expect(JSON.stringify(userContextResponse.json().data)).not.toContain('profile');

      const workspaceSupport = await startSupportSession(
        support,
        target,
        'WORKSPACE_SUPPORT',
        'READ_ONLY',
      );
      const workspaceSupportResponse = await postDecisions(
        target,
        {
          requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
        },
        { token: support.token, supportSessionId: workspaceSupport },
      );
      expect(workspaceSupportResponse.statusCode).toBe(403);
      expect(workspaceSupportResponse.json().error.code).toBe('SUPPORT_WORKSPACE_DENIED');

      const arbitraryPost = await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${target.workspaceId}/files/upload-intents`,
        headers: supportHeaders(support.token, userContext),
        payload: {
          purpose: 'GENERIC',
          subjectType: 'WORKSPACE',
          fileName: 'support-write.txt',
          mimeType: 'text/plain',
          sizeBytes: 12,
        },
      });
      expect(arbitraryPost.statusCode).toBe(403);
      expect(arbitraryPost.json().error.code).toBe('SUPPORT_READ_ONLY');

      const similarSuffix = await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${target.workspaceId}/me/effective-access/decisions-extra`,
        headers: supportHeaders(support.token, userContext),
        payload: {
          requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
        },
      });
      expect(similarSuffix.statusCode).toBe(403);
      expect(similarSuffix.json().error.code).toBe('SUPPORT_READ_ONLY');

      const otherMePost = await app.inject({
        method: 'POST',
        url: '/api/v1/me/push-devices',
        headers: supportHeaders(support.token, userContext),
        payload: {
          platform: 'WEB',
          provider: 'stage19',
          token: 'support-write-token',
        },
      });
      expect(otherMePost.statusCode).toBe(403);
      expect(otherMePost.json().error.code).toBe('SUPPORT_READ_ONLY');

      const put = await app.inject({
        method: 'PUT',
        url: '/api/v1/me/notification-preferences',
        headers: supportHeaders(support.token, userContext),
        payload: { expectedVersion: 0 },
      });
      expect(put.statusCode).toBe(403);
      expect(put.json().error.code).toBe('SUPPORT_READ_ONLY');

      const patch = await app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: supportHeaders(support.token, userContext),
        payload: { firstName: 'Blocked' },
      });
      expect(patch.statusCode).toBe(403);
      expect(patch.json().error.code).toBe('SUPPORT_READ_ONLY');

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/workspaces/${target.workspaceId}/files/${new ObjectId().toHexString()}`,
        headers: supportHeaders(support.token, userContext),
        payload: { expectedVersion: 0 },
      });
      expect(del.statusCode).toBe(403);
      expect(del.json().error.code).toBe('SUPPORT_READ_ONLY');

      const wrongWorkspace = await seedRouteWorkspace({
        roles: ['GYM_OWNER'],
        permissions: [{ permission: Permissions.WorkoutsCreate, effect: 'ALLOW' }],
      });
      const wrongWorkspaceResponse = await postDecisions(
        wrongWorkspace,
        {
          requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
        },
        { token: support.token, supportSessionId: userContext },
      );
      expect(wrongWorkspaceResponse.statusCode).toBe(403);
      expect(wrongWorkspaceResponse.json().error.code).toBe('SUPPORT_SESSION_WORKSPACE_MISMATCH');

      const disabledSupport = await seedSupportActor(target);
      const disabled = await startSupportSession(
        disabledSupport,
        target,
        'USER_CONTEXT',
        'READ_ONLY',
      );
      await updateSupportPolicy(disabled, { enabled: false });
      const disabledResponse = await postDecisions(
        target,
        {
          requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
        },
        { token: disabledSupport.token, supportSessionId: disabled },
      );
      expect(disabledResponse.statusCode).toBe(403);
      expect(disabledResponse.json().error.code).toBe('POLICY_DISABLED');

      const archivedSupport = await seedSupportActor(target);
      const archived = await startSupportSession(
        archivedSupport,
        target,
        'USER_CONTEXT',
        'READ_ONLY',
      );
      await updateSupportPolicy(archived, { archivedAt: new Date() });
      const archivedResponse = await postDecisions(
        target,
        {
          requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
        },
        { token: archivedSupport.token, supportSessionId: archived },
      );
      expect(archivedResponse.statusCode).toBe(403);
      expect(archivedResponse.json().error.code).toBe('POLICY_DISABLED');

      const revoked = await startSupportSession(support, target, 'USER_CONTEXT', 'READ_ONLY');
      await updateSupportSession(revoked, { status: 'REVOKED' });
      const revokedResponse = await postDecisions(
        target,
        {
          requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
        },
        { token: support.token, supportSessionId: revoked },
      );
      expect(revokedResponse.statusCode).toBe(403);
      expect(revokedResponse.json().error.code).toBe('SUPPORT_SESSION_NOT_ACTIVE');

      const expired = await startSupportSession(support, target, 'USER_CONTEXT', 'READ_ONLY');
      await updateSupportSession(expired, { expiresAt: new Date(Date.now() - 60_000) });
      const expiredResponse = await postDecisions(
        target,
        {
          requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
        },
        { token: support.token, supportSessionId: expired },
      );
      expect(expiredResponse.statusCode).toBe(403);
      expect(expiredResponse.json().error.code).toBe('SUPPORT_SESSION_EXPIRED');

      const terminated = await startSupportSession(support, target, 'USER_CONTEXT', 'READ_ONLY');
      await updateSupportSession(terminated, { status: 'SECURITY_TERMINATED' });
      const terminatedResponse = await postDecisions(
        target,
        {
          requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
        },
        { token: support.token, supportSessionId: terminated },
      );
      expect(terminatedResponse.statusCode).toBe(403);
      expect(terminatedResponse.json().error.code).toBe('SUPPORT_SESSION_NOT_ACTIVE');

      const staleMembership = await startSupportSession(
        support,
        target,
        'USER_CONTEXT',
        'READ_ONLY',
      );
      await db
        .collection('workspace_memberships')
        .updateOne({ _id: new ObjectId(target.membershipId) }, { $set: { status: 'SUSPENDED' } });
      const staleMembershipResponse = await postDecisions(
        target,
        {
          requests: [{ permission: Permissions.WorkoutsCreate, scope: 'WORKSPACE' }],
        },
        { token: support.token, supportSessionId: staleMembership },
      );
      expect(staleMembershipResponse.statusCode).toBe(403);
      expect(staleMembershipResponse.json().error.code).toBe('TARGET_USER_CONTEXT_INVALID');
    },
    ROUTE_TEST_TIMEOUT_MS,
  );

  async function postDecisions(
    seeded: RouteWorkspaceFixture,
    payload: Record<string, unknown>,
    options: { token?: string; supportSessionId?: string } = {},
  ): Promise<RouteResponse> {
    return (await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${seeded.workspaceId}/me/effective-access/decisions`,
      headers: {
        ...bearer(options.token ?? seeded.token),
        ...(options.supportSessionId ? { 'X-Support-Session-Id': options.supportSessionId } : {}),
      },
      payload,
    })) as RouteResponse;
  }

  function supportHeaders(token: string, supportSessionId: string) {
    return { ...bearer(token), 'X-Support-Session-Id': supportSessionId };
  }

  async function updateSupportSession(sessionId: string, patch: Record<string, unknown>) {
    await db
      .collection('support_sessions')
      .updateOne({ _id: new ObjectId(sessionId) }, { $set: patch });
  }

  async function updateSupportPolicy(sessionId: string, patch: Record<string, unknown>) {
    const session = await db
      .collection('support_sessions')
      .findOne<{ policyId: ObjectId }>({ _id: new ObjectId(sessionId) });
    if (!session) throw new Error('Expected support session for policy update.');
    await db
      .collection('portal_access_policies')
      .updateOne({ _id: session.policyId }, { $set: patch });
  }

  async function seedRouteWorkspace(options: {
    roles: string[];
    permissions?: Array<{ permission: string; effect: 'ALLOW' | 'DENY' }>;
    grants?: Array<{
      permission: string;
      effect: 'ALLOW' | 'DENY';
      scope: { type: string; resourceIds?: ObjectId[] };
    }>;
    relationship?: false;
    relationshipStatus?: CoachingRelationshipStatus;
    membershipStatus?: 'ACTIVE' | 'SUSPENDED' | 'ENDED' | 'ARCHIVED';
    workspaceStatus?: 'ACTIVE' | 'ARCHIVED';
    accessVersion?: number;
    branchAssignment?: boolean;
  }): Promise<RouteWorkspaceFixture> {
    const now = new Date();
    const workspaceId = new ObjectId();
    const userId = new ObjectId();
    const membershipId = new ObjectId();
    const profileId = new ObjectId();
    const branchId = new ObjectId();
    const relationshipId = new ObjectId();
    const sessionId = new ObjectId();
    const permissionProfileIds = options.permissions ? [profileId] : [];
    await db
      .collection('users')
      .insertOne(userDoc(userId, `stage19-${userId.toHexString()}@example.test`));
    await db.collection('auth_sessions').insertOne(authSessionDoc(sessionId, userId));
    await db.collection('workspaces').insertOne({
      _id: workspaceId,
      type: 'GYM',
      name: `Stage 19 ${workspaceId.toHexString()}`,
      ownerUserId: userId,
      status: options.workspaceStatus ?? 'ACTIVE',
      timezone: 'Africa/Cairo',
      defaultLanguage: 'en',
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('workspace_memberships').insertOne({
      _id: membershipId,
      workspaceId,
      userId,
      roles: options.roles,
      status: options.membershipStatus ?? 'ACTIVE',
      joinedAt: now,
      engagementPeriods: [{ startedAt: now }],
      permissionProfileIds,
      accessVersion: options.accessVersion ?? 0,
      createdAt: now,
      updatedAt: now,
    });
    if (options.permissions) {
      await db.collection('permission_profiles').insertOne({
        _id: profileId,
        context: 'WORKSPACE',
        workspaceId,
        name: 'Stage 19 profile',
        roleKey: options.roles[0],
        permissions: options.permissions,
        isSystemDefault: false,
        status: 'ACTIVE',
        version: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (options.grants) {
      await db.collection('access_grants').insertMany(
        options.grants.map((grant) => ({
          _id: new ObjectId(),
          context: 'WORKSPACE',
          workspaceId,
          subjectType: 'WORKSPACE_MEMBERSHIP',
          subjectId: membershipId,
          permission: grant.permission,
          effect: grant.effect,
          scope: grant.scope,
          createdBy: userId,
          createdAt: now,
        })),
      );
    }
    await db.collection('branches').insertOne({
      _id: branchId,
      workspaceId,
      name: 'Main',
      timezone: 'Africa/Cairo',
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    if (options.branchAssignment) {
      await db.collection('membership_branch_assignments').insertOne({
        _id: new ObjectId(),
        workspaceId,
        membershipId,
        branchId,
        active: true,
        startedAt: now,
        createdAt: now,
      });
    }
    if (options.relationship !== false) {
      await db.collection('coaching_relationships').insertOne({
        _id: relationshipId,
        workspaceId,
        traineeUserId: userId,
        traineeMembershipId: membershipId,
        status: options.relationshipStatus ?? 'ACTIVE',
        engagementPeriods: [{ startedAt: now }],
        version: 2,
        createdAt: now,
        updatedAt: now,
      });
    }
    return {
      token: container.jwt.createAccessToken({
        userId: userId.toHexString(),
        authSessionId: sessionId.toHexString(),
        authenticationMethods: ['pwd'],
      }),
      workspaceId: workspaceId.toHexString(),
      userId: userId.toHexString(),
      membershipId: membershipId.toHexString(),
      branchId: branchId.toHexString(),
      relationshipId: relationshipId.toHexString(),
    };
  }

  async function seedSupportActor(target: RouteWorkspaceFixture) {
    const now = new Date();
    const userId = new ObjectId();
    const sessionId = new ObjectId();
    const platformMembershipId = new ObjectId();
    const profileId = new ObjectId();
    await db
      .collection('users')
      .insertOne(userDoc(userId, `support-${userId.toHexString()}@example.test`));
    await db.collection('auth_sessions').insertOne({
      ...authSessionDoc(sessionId, userId),
      mfaSatisfiedAt: now,
    });
    await db.collection('platform_memberships').insertOne({
      _id: platformMembershipId,
      userId,
      roles: ['PLATFORM_SUPPORT'],
      status: 'ACTIVE',
      permissionProfileIds: [profileId],
      accessVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('permission_profiles').insertOne({
      _id: profileId,
      context: 'PLATFORM',
      name: `Stage 19 support profile ${userId.toHexString()}`,
      roleKey: 'PLATFORM_SUPPORT',
      permissions: [{ permission: Permissions.SupportSessionsStart, effect: 'ALLOW' }],
      isSystemDefault: false,
      status: 'ACTIVE',
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('portal_access_policies').insertOne({
      _id: new ObjectId(),
      platformMembershipId,
      allowedTargetTypes: ['GYM'],
      allowedWorkspaceIds: [new ObjectId(target.workspaceId)],
      allowedIpRanges: ['127.0.0.1'],
      allowedSessionTypes: ['READ_ONLY'],
      maxSessionDurationMinutes: 5,
      notificationRequired: false,
      allowSensitiveData: false,
      allowSensitiveFileDownload: false,
      enabled: true,
      revision: 0,
      createdBy: userId,
      createdAt: now,
    });
    return {
      token: container.jwt.createAccessToken({
        userId: userId.toHexString(),
        authSessionId: sessionId.toHexString(),
        authenticationMethods: ['pwd', 'totp'],
      }),
    };
  }

  async function startSupportSession(
    support: { token: string },
    target: RouteWorkspaceFixture,
    contextType: 'USER_CONTEXT' | 'WORKSPACE_SUPPORT',
    sessionType: 'READ_ONLY',
  ) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/support/access-requests',
      headers: { ...bearer(support.token), 'Idempotency-Key': new ObjectId().toHexString() },
      payload: {
        targetType: 'GYM',
        targetWorkspaceId: target.workspaceId,
        ...(contextType === 'USER_CONTEXT'
          ? { targetUserId: target.userId, effectiveMembershipId: target.membershipId }
          : {}),
        contextType,
        sessionType,
        requestedDurationMinutes: 1,
        requestedSensitiveAccess: false,
        requestedSensitiveFileDownload: false,
        reason: 'stage19 route proof',
        reference: 'STAGE-19',
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().data.supportSession.id as string;
  }

  async function seedAdditionalRelationships(seeded: RouteWorkspaceFixture, count: number) {
    const now = new Date();
    const workspaceId = new ObjectId(seeded.workspaceId);
    const relationships = Array.from({ length: count }, () => ({
      _id: new ObjectId(),
      workspaceId,
      traineeUserId: new ObjectId(),
      status: 'ACTIVE',
      engagementPeriods: [{ startedAt: now }],
      version: 0,
      createdAt: now,
      updatedAt: now,
    }));
    await db.collection('coaching_relationships').insertMany(relationships);
    return relationships.map((relationship) => relationship._id.toHexString());
  }
});

interface RouteWorkspaceFixture {
  token: string;
  workspaceId: string;
  userId: string;
  membershipId: string;
  branchId: string;
  relationshipId: string;
}

interface RouteResponse {
  statusCode: number;
  json(): {
    data: {
      decisions: Array<Record<string, unknown>>;
      membershipId?: unknown;
      relationship?: Record<string, unknown> | null;
    } & Record<string, unknown>;
    error: { code: string };
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function userDoc(userId: ObjectId, email: string) {
  const now = new Date();
  return {
    _id: userId,
    normalizedEmail: email,
    passwordHash: 'hash',
    emailVerifiedAt: now,
    firstName: 'Stage',
    lastName: 'Nineteen',
    preferredLanguage: 'en',
    timezone: 'Africa/Cairo',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };
}

function authSessionDoc(sessionId: ObjectId, userId: ObjectId) {
  const now = new Date();
  return {
    _id: sessionId,
    userId,
    status: 'ACTIVE',
    clientType: 'WEB',
    refreshTokenTransport: 'COOKIE',
    ipAddress: '127.0.0.1',
    authenticationMethods: ['PASSWORD'],
    restrictedUntilVerified: false,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
  };
}

function routeIntegrationConfig(dbName: string): AppConfig {
  return {
    env: 'test',
    app: {
      host: '0.0.0.0',
      port: 3000,
      docsEnabled: false,
      trustProxy: false,
      allowedOrigins: [],
    },
    mongo: { uri: mongoUri(), dbName, connectTimeoutMs: 500 },
    logging: { level: 'silent' },
    audit: { retentionPolicy: 'INDEFINITE' },
    auth: {
      jwtActiveKeyId: 'local',
      jwtPrivateKey: [
        '-----BEGIN PRIVATE KEY-----',
        'MC4CAQAwBQYDK2VwBCIEIP27WzZ2lrwob/CusOSRmtVPlS0TPTrBOFjTuBztUPm8',
        '-----END PRIVATE KEY-----',
      ].join('\n'),
      jwtPublicKeys: {
        local: [
          '-----BEGIN PUBLIC KEY-----',
          'MCowBQYDK2VwAyEAVk4E+7jo4OHXHcYC1lvT+vqaViaFNdUPnMcuSDPpp60=',
          '-----END PUBLIC KEY-----',
        ].join('\n'),
      },
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
      id: 'stage19-route-test',
      outboxPollIntervalMs: 1000,
      outboxLockMs: 30_000,
      outboxMaxAttempts: 8,
      jobLeaseMs: 30_000,
    },
    notifications: {
      deliveryBatchSize: 25,
      deliveryClaimMs: 60_000,
      deliveryMaxAttempts: 5,
    },
    subscriptions: { trialExpiryAction: 'FROZEN', paidGraceDays: 0, frozenToExpiredDays: 30 },
    support: { defaultSessionMinutes: 30, maxSessionMinutes: 60 },
  };
}

function mongoUri() {
  return (
    process.env.MONGODB_URI ??
    'mongodb://localhost:27017/gym_platform?replicaSet=rs0&directConnection=true'
  );
}

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
