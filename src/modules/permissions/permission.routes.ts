import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import type { AppContainer } from '../../bootstrap/app-container';
import { requireAccess } from '../../core/access-control/access-control.middleware';
import { requireAuth } from '../auth/auth.middleware';
import { IdParams, MembershipParams } from '../workspaces/workspace.schemas';
import { Permissions } from './permission.registry';
import {
  ArchivePermissionProfileBody,
  CreatePermissionProfileBody,
  ErrorResponse,
  PlatformMembershipParams,
  PlatformProfileParams,
  ReplaceAccessGrantsBody,
  ReplacePermissionProfilesBody,
  UpdatePermissionProfileBody,
  WorkspaceMembershipParams,
  WorkspaceProfileParams,
} from './permission.schemas';

export async function registerPermissionRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.get(
    '/api/v1/permissions',
    {
      preHandler: requireAuth(),
      schema: { tags: ['Permissions'], response: { 200: {}, 401: ErrorResponse } },
    },
    async () => ({ data: await container.permissions.listDefinitions() }),
  );

  app.get<{ Params: Static<typeof IdParams> }>(
    '/api/v1/workspaces/:workspaceId/permission-profiles',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.StaffPermissionsManage,
        }),
      ],
      schema: {
        tags: ['Permissions'],
        params: IdParams,
        response: { 200: {}, 403: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.permissions.listWorkspaceProfiles(
        request.ctx,
        request.params.workspaceId,
      ),
    }),
  );

  app.post<{ Params: Static<typeof IdParams>; Body: Static<typeof CreatePermissionProfileBody> }>(
    '/api/v1/workspaces/:workspaceId/permission-profiles',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.StaffPermissionsManage,
        }),
      ],
      schema: {
        tags: ['Permissions'],
        params: IdParams,
        body: CreatePermissionProfileBody,
        response: { 201: {}, 400: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const data = await container.permissions.createWorkspaceProfile(
        request.ctx,
        request.params.workspaceId,
        request.body,
      );
      return reply.status(201).send({ data });
    },
  );

  app.patch<{
    Params: Static<typeof WorkspaceProfileParams>;
    Body: Static<typeof UpdatePermissionProfileBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/permission-profiles/:profileId',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.StaffPermissionsManage,
        }),
      ],
      schema: {
        tags: ['Permissions'],
        params: WorkspaceProfileParams,
        body: UpdatePermissionProfileBody,
        response: { 200: {}, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.permissions.updateProfile(
        request.ctx,
        request.params.profileId,
        request.params.workspaceId,
        request.body,
      ),
    }),
  );

  app.post<{
    Params: Static<typeof WorkspaceProfileParams>;
    Body: Static<typeof ArchivePermissionProfileBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/permission-profiles/:profileId/archive',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.StaffPermissionsManage,
        }),
      ],
      schema: {
        tags: ['Permissions'],
        params: WorkspaceProfileParams,
        body: ArchivePermissionProfileBody,
        response: { 200: {}, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.permissions.archiveProfile(
        request.ctx,
        request.params.profileId,
        request.params.workspaceId,
        request.body.expectedVersion,
      ),
    }),
  );

  app.put<{
    Params: Static<typeof WorkspaceMembershipParams>;
    Body: Static<typeof ReplacePermissionProfilesBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/memberships/:membershipId/permission-profiles',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.StaffPermissionsManage,
        }),
      ],
      schema: {
        tags: ['Permissions'],
        params: WorkspaceMembershipParams,
        body: ReplacePermissionProfilesBody,
        response: { 200: {}, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.permissions.replaceWorkspaceMembershipProfiles(
        request.ctx,
        request.params.workspaceId,
        request.params.membershipId,
        request.body,
      ),
    }),
  );

  app.get<{ Params: Static<typeof WorkspaceMembershipParams> }>(
    '/api/v1/workspaces/:workspaceId/memberships/:membershipId/access',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.StaffPermissionsManage,
        }),
      ],
      schema: { tags: ['Permissions'], params: WorkspaceMembershipParams, response: { 200: {} } },
    },
    async (request) => ({
      data: await container.permissions.listWorkspaceAccess(
        request.ctx,
        request.params.workspaceId,
        request.params.membershipId,
      ),
    }),
  );

  app.put<{
    Params: Static<typeof WorkspaceMembershipParams>;
    Body: Static<typeof ReplaceAccessGrantsBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/memberships/:membershipId/access',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.StaffPermissionsManage,
        }),
      ],
      schema: {
        tags: ['Permissions'],
        params: WorkspaceMembershipParams,
        body: ReplaceAccessGrantsBody,
        response: { 200: {}, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.permissions.replaceWorkspaceAccess(
        request.ctx,
        request.params.workspaceId,
        request.params.membershipId,
        request.body,
      ),
    }),
  );

  app.get<{ Params: Static<typeof MembershipParams> }>(
    '/api/v1/workspaces/:workspaceId/memberships/:membershipId/effective-access',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.StaffPermissionsManage,
        }),
      ],
      schema: { tags: ['Permissions'], params: MembershipParams, response: { 200: {} } },
    },
    async (request) => ({
      data: await container.accessControl.effectiveAccessForWorkspaceMembership(
        request.ctx,
        objectId(request.params.workspaceId),
        objectId(request.params.membershipId),
      ),
    }),
  );

  app.get(
    '/api/v1/platform/permission-profiles',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'PLATFORM',
          permission: Permissions.PlatformPermissionsManage,
        }),
      ],
      schema: { tags: ['Permissions'], response: { 200: {}, 403: ErrorResponse } },
    },
    async (request) => ({ data: await container.permissions.listPlatformProfiles(request.ctx) }),
  );

  app.post<{ Body: Static<typeof CreatePermissionProfileBody> }>(
    '/api/v1/platform/permission-profiles',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'PLATFORM',
          permission: Permissions.PlatformPermissionsManage,
        }),
      ],
      schema: {
        tags: ['Permissions'],
        body: CreatePermissionProfileBody,
        response: { 201: {}, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const data = await container.permissions.createPlatformProfile(request.ctx, request.body);
      return reply.status(201).send({ data });
    },
  );

  app.patch<{
    Params: Static<typeof PlatformProfileParams>;
    Body: Static<typeof UpdatePermissionProfileBody>;
  }>(
    '/api/v1/platform/permission-profiles/:profileId',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'PLATFORM',
          permission: Permissions.PlatformPermissionsManage,
        }),
      ],
      schema: {
        tags: ['Permissions'],
        params: PlatformProfileParams,
        body: UpdatePermissionProfileBody,
        response: { 200: {}, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.permissions.updateProfile(
        request.ctx,
        request.params.profileId,
        undefined,
        request.body,
      ),
    }),
  );

  app.post<{
    Params: Static<typeof PlatformProfileParams>;
    Body: Static<typeof ArchivePermissionProfileBody>;
  }>(
    '/api/v1/platform/permission-profiles/:profileId/archive',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'PLATFORM',
          permission: Permissions.PlatformPermissionsManage,
        }),
      ],
      schema: {
        tags: ['Permissions'],
        params: PlatformProfileParams,
        body: ArchivePermissionProfileBody,
        response: { 200: {}, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.permissions.archiveProfile(
        request.ctx,
        request.params.profileId,
        undefined,
        request.body.expectedVersion,
      ),
    }),
  );

  app.put<{
    Params: Static<typeof PlatformMembershipParams>;
    Body: Static<typeof ReplacePermissionProfilesBody>;
  }>(
    '/api/v1/platform/memberships/:membershipId/permission-profiles',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'PLATFORM',
          permission: Permissions.PlatformPermissionsManage,
        }),
      ],
      schema: {
        tags: ['Permissions'],
        params: PlatformMembershipParams,
        body: ReplacePermissionProfilesBody,
        response: { 200: {}, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.permissions.replacePlatformMembershipProfiles(
        request.ctx,
        request.params.membershipId,
        request.body,
      ),
    }),
  );

  app.get<{ Params: Static<typeof PlatformMembershipParams> }>(
    '/api/v1/platform/memberships/:membershipId/access',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'PLATFORM',
          permission: Permissions.PlatformPermissionsManage,
        }),
      ],
      schema: { tags: ['Permissions'], params: PlatformMembershipParams, response: { 200: {} } },
    },
    async (request) => ({
      data: await container.permissions.listPlatformAccess(
        request.ctx,
        request.params.membershipId,
      ),
    }),
  );

  app.put<{
    Params: Static<typeof PlatformMembershipParams>;
    Body: Static<typeof ReplaceAccessGrantsBody>;
  }>(
    '/api/v1/platform/memberships/:membershipId/access',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'PLATFORM',
          permission: Permissions.PlatformPermissionsManage,
        }),
      ],
      schema: {
        tags: ['Permissions'],
        params: PlatformMembershipParams,
        body: ReplaceAccessGrantsBody,
        response: { 200: {}, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.permissions.replacePlatformAccess(
        request.ctx,
        request.params.membershipId,
        request.body,
      ),
    }),
  );
}

function objectId(value: string): ObjectId {
  return new ObjectId(value);
}
