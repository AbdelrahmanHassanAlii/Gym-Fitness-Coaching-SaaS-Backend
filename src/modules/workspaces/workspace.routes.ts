import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { AppContainer } from '../../bootstrap/app-container';
import { requireAccess } from '../../core/access-control/access-control.middleware';
import { requireAuth } from '../auth/auth.middleware';
import { Permissions } from '../permissions/permission.registry';
import {
  AcceptInvitationBody,
  BranchParams,
  CreateBranchBody,
  CreatePlatformMembershipBody,
  CreateWorkspaceBody,
  ErrorResponse,
  IdParams,
  InvitationParams,
  InviteStaffBody,
  MembershipBranchParams,
  MembershipParams,
  PlatformMembershipParams,
  SuccessResponse,
  UpdateBranchBody,
  UpdateMeBody,
  UpdateWorkspaceBody,
} from './workspace.schemas';

export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.get(
    '/api/v1/me',
    {
      preHandler: requireAuth({ allowRestricted: true }),
      schema: { tags: ['Me'], response: { 200: {}, 401: ErrorResponse } },
    },
    async (request) => ({ data: await container.workspaces.me(request.ctx) }),
  );

  app.patch<{ Body: Static<typeof UpdateMeBody> }>(
    '/api/v1/me',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Me'],
        body: UpdateMeBody,
        response: { 200: {}, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request) => ({ data: await container.workspaces.updateMe(request.ctx, request.body) }),
  );

  app.get(
    '/api/v1/me/workspaces',
    {
      preHandler: requireAuth(),
      schema: { tags: ['Me'], response: { 200: {}, 401: ErrorResponse, 403: ErrorResponse } },
    },
    async (request) => ({ data: await container.workspaces.listMyWorkspaces(request.ctx) }),
  );

  app.post<{ Body: Static<typeof CreateWorkspaceBody> }>(
    '/api/v1/platform/workspaces',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'PLATFORM',
          permission: Permissions.PlatformWorkspacesManage,
        }),
      ],
      schema: {
        tags: ['Workspaces'],
        body: CreateWorkspaceBody,
        response: { 201: {}, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request, reply) => {
      const data = await container.workspaces.createWorkspace(request.ctx, request.body);
      return reply.status(201).send({ data });
    },
  );

  app.get(
    '/api/v1/platform/memberships',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'PLATFORM',
          permission: Permissions.PlatformMembershipsRead,
        }),
      ],
      schema: {
        tags: ['Platform'],
        response: { 200: {}, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.workspaces.listPlatformMemberships(request.ctx),
    }),
  );

  app.post<{ Body: Static<typeof CreatePlatformMembershipBody> }>(
    '/api/v1/platform/memberships',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'PLATFORM',
          permission: Permissions.PlatformMembershipsManage,
        }),
      ],
      schema: {
        tags: ['Platform'],
        body: CreatePlatformMembershipBody,
        response: { 201: {}, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const data = await container.workspaces.createPlatformMembership(
        request.ctx,
        request.body.userId,
      );
      return reply.status(201).send({ data });
    },
  );

  for (const command of ['suspend', 'reactivate', 'end'] as const) {
    app.post<{ Params: Static<typeof PlatformMembershipParams> }>(
      `/api/v1/platform/memberships/:platformMembershipId/${command}`,
      {
        preHandler: [
          requireAuth(),
          requireAccess(container, {
            context: 'PLATFORM',
            permission: Permissions.PlatformMembershipsManage,
          }),
        ],
        schema: {
          tags: ['Platform'],
          params: PlatformMembershipParams,
          response: { 200: {}, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        },
      },
      async (request) => ({
        data: await container.workspaces.transitionPlatformMembership(
          request.ctx,
          request.params.platformMembershipId,
          command,
        ),
      }),
    );
  }

  app.get<{ Params: Static<typeof IdParams> }>(
    '/api/v1/workspaces/:workspaceId',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'WORKSPACE', permission: Permissions.WorkspacesRead }),
      ],
      schema: { tags: ['Workspaces'], params: IdParams, response: { 200: {}, 404: ErrorResponse } },
    },
    async (request) => ({
      data: await container.workspaces.getWorkspace(request.ctx, request.params.workspaceId),
    }),
  );

  app.patch<{ Params: Static<typeof IdParams>; Body: Static<typeof UpdateWorkspaceBody> }>(
    '/api/v1/workspaces/:workspaceId',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.WorkspacesUpdate,
        }),
      ],
      schema: {
        tags: ['Workspaces'],
        params: IdParams,
        body: UpdateWorkspaceBody,
        response: { 200: {}, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.workspaces.updateWorkspace(
        request.ctx,
        request.params.workspaceId,
        request.body,
      ),
    }),
  );

  app.get<{ Params: Static<typeof IdParams> }>(
    '/api/v1/workspaces/:workspaceId/branches',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'WORKSPACE', permission: Permissions.BranchesRead }),
      ],
      schema: { tags: ['Branches'], params: IdParams, response: { 200: {}, 404: ErrorResponse } },
    },
    async (request) => ({
      data: await container.workspaces.listBranches(request.ctx, request.params.workspaceId),
    }),
  );

  app.get<{ Params: Static<typeof BranchParams> }>(
    '/api/v1/workspaces/:workspaceId/branches/:branchId',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.BranchesRead,
          scope: { type: 'BRANCH', resourceIdParam: 'branchId', requiresAssignment: false },
        }),
      ],
      schema: {
        tags: ['Branches'],
        params: BranchParams,
        response: { 200: {}, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.workspaces.getBranch(
        request.ctx,
        request.params.workspaceId,
        request.params.branchId,
      ),
    }),
  );

  app.patch<{ Params: Static<typeof BranchParams>; Body: Static<typeof UpdateBranchBody> }>(
    '/api/v1/workspaces/:workspaceId/branches/:branchId',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.BranchesUpdate,
          scope: { type: 'BRANCH', resourceIdParam: 'branchId', requiresAssignment: false },
        }),
      ],
      schema: {
        tags: ['Branches'],
        params: BranchParams,
        body: UpdateBranchBody,
        response: { 200: {}, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.workspaces.updateBranch(
        request.ctx,
        request.params.workspaceId,
        request.params.branchId,
        request.body,
      ),
    }),
  );

  app.post<{ Params: Static<typeof IdParams>; Body: Static<typeof CreateBranchBody> }>(
    '/api/v1/workspaces/:workspaceId/branches',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'WORKSPACE', permission: Permissions.BranchesCreate }),
      ],
      schema: {
        tags: ['Branches'],
        params: IdParams,
        body: CreateBranchBody,
        response: { 201: {}, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const data = await container.workspaces.createBranch(
        request.ctx,
        request.params.workspaceId,
        request.body,
      );
      return reply.status(201).send({ data });
    },
  );

  app.post<{ Params: Static<typeof BranchParams> }>(
    '/api/v1/workspaces/:workspaceId/branches/:branchId/archive',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.BranchesArchive,
          scope: { type: 'BRANCH', resourceIdParam: 'branchId', requiresAssignment: false },
        }),
      ],
      schema: {
        tags: ['Branches'],
        params: BranchParams,
        response: { 200: {}, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.workspaces.archiveBranch(
        request.ctx,
        request.params.workspaceId,
        request.params.branchId,
      ),
    }),
  );

  app.get<{ Params: Static<typeof IdParams> }>(
    '/api/v1/workspaces/:workspaceId/memberships',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'WORKSPACE', permission: Permissions.StaffRead }),
      ],
      schema: {
        tags: ['Memberships'],
        params: IdParams,
        response: { 200: {}, 404: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.workspaces.listMemberships(request.ctx, request.params.workspaceId),
    }),
  );

  app.get<{ Params: Static<typeof MembershipParams> }>(
    '/api/v1/workspaces/:workspaceId/memberships/:membershipId',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'WORKSPACE', permission: Permissions.StaffRead }),
      ],
      schema: {
        tags: ['Memberships'],
        params: MembershipParams,
        response: { 200: {}, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.workspaces.getMembership(
        request.ctx,
        request.params.workspaceId,
        request.params.membershipId,
      ),
    }),
  );

  for (const command of ['suspend', 'reactivate', 'end'] as const) {
    app.post<{ Params: Static<typeof MembershipParams> }>(
      `/api/v1/workspaces/:workspaceId/memberships/:membershipId/${command}`,
      {
        preHandler: [
          requireAuth(),
          requireAccess(container, { context: 'WORKSPACE', permission: Permissions.StaffManage }),
        ],
        schema: {
          tags: ['Memberships'],
          params: MembershipParams,
          response: { 200: {}, 409: ErrorResponse },
        },
      },
      async (request) => ({
        data: await container.workspaces.transitionMembership(
          request.ctx,
          request.params.workspaceId,
          request.params.membershipId,
          command,
        ),
      }),
    );
  }

  app.post<{ Params: Static<typeof IdParams>; Body: Static<typeof InviteStaffBody> }>(
    '/api/v1/workspaces/:workspaceId/staff/invitations',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'WORKSPACE', permission: Permissions.StaffInvite }),
      ],
      schema: {
        tags: ['Invitations'],
        params: IdParams,
        body: InviteStaffBody,
        response: { 201: {}, 409: ErrorResponse, 422: ErrorResponse },
      },
    },
    async (request, reply) => {
      const data = await container.workspaces.inviteStaff(
        request.ctx,
        request.params.workspaceId,
        request.body,
      );
      return reply.status(201).send({ data });
    },
  );

  app.post<{ Body: Static<typeof AcceptInvitationBody> }>(
    '/api/v1/invitations/accept',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Invitations'],
        body: AcceptInvitationBody,
        response: { 200: {}, 401: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.workspaces.acceptInvitation(request.ctx, request.body.token),
    }),
  );

  app.post<{ Params: Static<typeof InvitationParams> }>(
    '/api/v1/workspaces/:workspaceId/invitations/:invitationId/revoke',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.StaffInvitesRevoke,
        }),
      ],
      schema: {
        tags: ['Invitations'],
        params: InvitationParams,
        response: { 200: {}, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.workspaces.revokeInvitation(
        request.ctx,
        request.params.workspaceId,
        request.params.invitationId,
      ),
    }),
  );

  app.get<{ Params: Static<typeof MembershipParams> }>(
    '/api/v1/workspaces/:workspaceId/memberships/:membershipId/branches',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.StaffBranchesManage,
        }),
      ],
      schema: {
        tags: ['Branches'],
        params: MembershipParams,
        response: { 200: {}, 404: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.workspaces.listMembershipBranchAssignments(
        request.ctx,
        request.params.workspaceId,
        request.params.membershipId,
      ),
    }),
  );

  app.post<{ Params: Static<typeof MembershipBranchParams> }>(
    '/api/v1/workspaces/:workspaceId/memberships/:membershipId/branches/:branchId',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.StaffBranchesManage,
          scope: { type: 'BRANCH', resourceIdParam: 'branchId', requiresAssignment: false },
        }),
      ],
      schema: {
        tags: ['Branches'],
        params: MembershipBranchParams,
        response: { 201: {}, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const data = await container.workspaces.assignMembershipBranch(
        request.ctx,
        request.params.workspaceId,
        request.params.membershipId,
        request.params.branchId,
      );
      return reply.status(201).send({ data });
    },
  );

  app.delete<{ Params: Static<typeof MembershipBranchParams> }>(
    '/api/v1/workspaces/:workspaceId/memberships/:membershipId/branches/:branchId',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.StaffBranchesManage,
          scope: { type: 'BRANCH', resourceIdParam: 'branchId', requiresAssignment: false },
        }),
      ],
      schema: {
        tags: ['Branches'],
        params: MembershipBranchParams,
        response: { 200: SuccessResponse, 404: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.workspaces.removeMembershipBranchAssignment(
        request.ctx,
        request.params.workspaceId,
        request.params.membershipId,
        request.params.branchId,
      ),
    }),
  );
}
