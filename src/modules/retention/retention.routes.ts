import type { FastifyInstance } from 'fastify';
import type { AppContainer } from '../../bootstrap/app-container';
import { AppError } from '../../core/errors/app-error';
import { requireAuth } from '../auth/auth.middleware';
import {
  approveDeletionBodySchema,
  cancelDeletionBodySchema,
  deletionIdParamsSchema,
  listDeletionQuerySchema,
  postponeDeletionBodySchema,
} from './retention.schemas';

export async function registerRetentionRoutes(app: FastifyInstance, container: AppContainer) {
  app.get(
    '/api/v1/platform/workspace-deletions',
    {
      preHandler: requireAuth(),
      schema: { tags: ['Retention'], querystring: listDeletionQuerySchema },
    },
    async (request) => {
      return await container.retention.list(
        request.ctx,
        request.query as { limit?: number; after?: string },
      );
    },
  );

  app.get(
    '/api/v1/platform/workspace-deletions/:deletionId',
    { preHandler: requireAuth(), schema: { tags: ['Retention'], params: deletionIdParamsSchema } },
    async (request) => {
      const params = request.params as { deletionId: string };
      return await container.retention.get(request.ctx, params.deletionId);
    },
  );

  app.post(
    '/api/v1/platform/workspace-deletions/:deletionId/approve',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Retention'],
        params: deletionIdParamsSchema,
        body: approveDeletionBodySchema,
      },
    },
    async (request) => {
      const key = request.headers['idempotency-key'];
      if (!key || Array.isArray(key)) {
        throw new AppError({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          httpStatus: 400,
          message: 'Idempotency-Key is required.',
        });
      }
      const params = request.params as { deletionId: string };
      const result = await container.idempotency.runInTransaction(request.ctx, {
        key,
        routeKey: 'POST /api/v1/platform/workspace-deletions/:deletionId/approve',
        fingerprint: { params: request.params, body: request.body },
        unitOfWork: container.unitOfWork,
        operation: async (tx) => ({
          body: await container.retention.approve(
            request.ctx,
            params.deletionId,
            request.body as { expectedVersion: number; reason: string },
            tx,
          ),
        }),
      });
      return { data: result.body };
    },
  );

  app.post(
    '/api/v1/platform/workspace-deletions/:deletionId/postpone',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Retention'],
        params: deletionIdParamsSchema,
        body: postponeDeletionBodySchema,
      },
    },
    async (request) => {
      const params = request.params as { deletionId: string };
      return await container.retention.postpone(
        request.ctx,
        params.deletionId,
        request.body as { expectedVersion: number; reason: string; reviewAfter: string },
      );
    },
  );

  app.post(
    '/api/v1/platform/workspace-deletions/:deletionId/cancel',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Retention'],
        params: deletionIdParamsSchema,
        body: cancelDeletionBodySchema,
      },
    },
    async (request) => {
      const params = request.params as { deletionId: string };
      return await container.retention.cancel(
        request.ctx,
        params.deletionId,
        request.body as { expectedVersion: number; reason: string },
      );
    },
  );
}
