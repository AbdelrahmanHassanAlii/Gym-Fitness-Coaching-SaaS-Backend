import type { Static } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContainer } from '../../bootstrap/app-container';
import { idempotencyKey } from '../../core/idempotency/idempotency.service';
import type { RequestContext } from '../../core/request-context/request-context';
import { requireAuth } from '../auth/auth.middleware';
import { ErrorResponse, ExportParams, ListQuery, WorkspaceParams } from './export.schemas';

export async function registerExportRoutes(app: FastifyInstance, container: AppContainer) {
  app.post<{ Params: Static<typeof WorkspaceParams> }>(
    '/api/v1/workspaces/:workspaceId/exports',
    routeOptions({ params: WorkspaceParams }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request.ctx,
        idempotencyKey(request.headers),
        'POST /workspaces/:workspaceId/exports',
        request.params,
        (tx) => container.exports.create(request.ctx, request.params.workspaceId, tx),
      ),
  );

  app.get<{ Params: Static<typeof WorkspaceParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/exports',
    routeOptions({ params: WorkspaceParams, querystring: ListQuery }),
    async (request) =>
      await container.exports.list(request.ctx, request.params.workspaceId, request.query),
  );

  app.get<{ Params: Static<typeof ExportParams> }>(
    '/api/v1/workspaces/:workspaceId/exports/:exportId',
    routeOptions({ params: ExportParams }),
    async (request) =>
      await container.exports.get(request.ctx, request.params.workspaceId, request.params.exportId),
  );

  app.post<{ Params: Static<typeof ExportParams> }>(
    '/api/v1/workspaces/:workspaceId/exports/:exportId/download-url',
    routeOptions({ params: ExportParams }),
    async (request) => ({
      data: await container.exports.createDownloadUrl(
        request.ctx,
        request.params.workspaceId,
        request.params.exportId,
      ),
    }),
  );
}

function routeOptions(schema: Record<string, unknown>) {
  return {
    preHandler: [requireAuth()],
    schema: {
      ...schema,
      response: { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
      tags: ['Exports'],
    },
  };
}

async function idempotent<T>(
  reply: FastifyReply,
  container: AppContainer,
  ctx: RequestContext,
  key: string | undefined,
  routeKey: string,
  fingerprint: unknown,
  operation: (
    tx: Parameters<AppContainer['unitOfWork']['withTransaction']>[0] extends (
      tx: infer TTx,
    ) => unknown
      ? TTx
      : never,
  ) => Promise<T>,
) {
  const result = await container.idempotency.runInTransaction(ctx, {
    key,
    routeKey,
    fingerprint,
    unitOfWork: container.unitOfWork,
    operation: async (tx) => ({ body: { data: await operation(tx) } }),
  });
  return reply.status(result.statusCode).send(result.body);
}
