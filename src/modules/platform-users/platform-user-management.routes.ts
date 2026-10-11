import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { AppContainer } from '../../bootstrap/app-container';
import { AppError } from '../../core/errors/app-error';
import { idempotencyKey } from '../../core/idempotency/idempotency.service';
import { requireAuth } from '../auth/auth.middleware';
import { managementError, rejectManagementSupport } from '../platform/platform-authority.guard';
import {
  ManagementBody,
  ManagementHeaders,
  ManagementParams,
  ManagementResponses,
} from './platform-user-management.schemas';

export async function registerPlatformUserManagementRoutes(
  app: FastifyInstance,
  container: AppContainer,
) {
  const securityGuards = [
    requireAuth(),
    async (request: import('fastify').FastifyRequest) => {
      if (!request.ctx.mfaSatisfied)
        throw new AppError({
          code: 'TWO_FACTOR_REQUIRED',
          httpStatus: 403,
          message: 'MFA is required.',
        });
      if (request.headers['x-support-session-id'] !== undefined)
        throw managementError('SUPPORT_ACCESS_FORBIDDEN', 403);
      rejectManagementSupport(request.ctx);
      await container.platformUserManagement.authorize(request.ctx);
      if (request.method === 'POST') {
        const body = request.body;
        if (
          typeof body !== 'object' ||
          body === null ||
          !('expectedVersion' in body) ||
          Object.keys(body).length !== 1 ||
          typeof body.expectedVersion !== 'number' ||
          !Number.isSafeInteger(body.expectedVersion) ||
          body.expectedVersion < 0
        )
          throw managementError('VALIDATION_FAILED', 400);
      }
    },
  ];
  const description =
    'Platform membership lifecycle only. Requires platform_users.manage, unrestricted authenticated session, MFA, ACTIVE actor account/membership. Support: SUPPORT_ACCESS_FORBIDDEN. Self mutation forbidden. Independent durable management authorities protected. Private, no-store. Reactivation preserves assignments; sessions are not revoked.';
  app.get<{ Params: Static<typeof ManagementParams> }>(
    '/api/v1/platform/users/:userId/management-state',
    {
      preValidation: securityGuards,
      schema: {
        tags: ['Platform'],
        description,
        params: ManagementParams,
        response: ManagementResponses,
      },
    },
    async (request, reply) => {
      const data = await container.platformUserManagement.state(request.ctx, request.params.userId);
      return reply.header('Cache-Control', 'private, no-store').send({ data });
    },
  );
  for (const command of ['suspend', 'reactivate', 'end'] as const) {
    app.post<{ Params: Static<typeof ManagementParams>; Body: Static<typeof ManagementBody> }>(
      `/api/v1/platform/users/:userId/${command}`,
      {
        preValidation: securityGuards,
        schema: {
          tags: ['Platform'],
          description: `${description} Required Idempotency-Key and expectedVersion; stale revision: PLATFORM_MEMBERSHIP_VERSION_CONFLICT (409).`,
          params: ManagementParams,
          body: ManagementBody,
          headers: ManagementHeaders,
          response: ManagementResponses,
        },
        schemaErrorFormatter: (_errors, dataVar) =>
          dataVar === 'headers'
            ? managementError('IDEMPOTENCY_KEY_REQUIRED', 400)
            : new Error('Management request validation failed.'),
      },
      async (request, reply) => {
        const userId = request.params.userId;
        const result = await container.idempotency.runInTransaction(request.ctx, {
          key: idempotencyKey(request.headers),
          routeKey: `POST /api/v1/platform/users/${userId}/${command}`,
          fingerprint: { userId, command, body: request.body },
          unitOfWork: container.unitOfWork,
          operation: async (tx) => ({
            body: await container.platformUserManagement.transition(
              request.ctx,
              userId,
              command,
              request.body.expectedVersion,
              tx,
            ),
          }),
        });
        return reply
          .header('Cache-Control', 'private, no-store')
          .status(result.statusCode)
          .send({ data: result.body });
      },
    );
  }
}
