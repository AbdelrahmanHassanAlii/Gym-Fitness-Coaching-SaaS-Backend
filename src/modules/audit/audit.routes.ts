import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { AppContainer } from '../../bootstrap/app-container';
import { requireAccess } from '../../core/access-control/access-control.middleware';
import { requireAuth } from '../auth/auth.middleware';
import { Permissions } from '../permissions/permission.registry';
import {
  AuditQuerySchema,
  ErrorResponse,
  WorkspaceAuditQuerySchema,
  WorkspaceParams,
} from './audit.schemas';

export async function registerAuditRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.get<{
    Params: Static<typeof WorkspaceParams>;
    Querystring: Static<typeof WorkspaceAuditQuerySchema>;
  }>(
    '/api/v1/workspaces/:workspaceId/audit',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.AuditWorkspaceRead,
        }),
      ],
      schema: {
        tags: ['Audit'],
        params: WorkspaceParams,
        querystring: WorkspaceAuditQuerySchema,
        response: { 200: {}, 401: ErrorResponse, 403: ErrorResponse, 422: ErrorResponse },
      },
    },
    async (request) =>
      await container.auditService.listWorkspace(
        request.ctx,
        request.params.workspaceId,
        request.query,
      ),
  );

  app.get<{ Querystring: Static<typeof AuditQuerySchema> }>(
    '/api/v1/platform/audit',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'PLATFORM',
          permission: Permissions.AuditPlatformRead,
        }),
      ],
      schema: {
        tags: ['Audit', 'Platform'],
        querystring: AuditQuerySchema,
        response: { 200: {}, 401: ErrorResponse, 403: ErrorResponse, 422: ErrorResponse },
      },
    },
    async (request) => await container.auditService.listPlatform(request.ctx, request.query),
  );
}
