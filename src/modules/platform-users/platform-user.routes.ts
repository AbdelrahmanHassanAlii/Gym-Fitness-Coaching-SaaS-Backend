import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { AppContainer } from '../../bootstrap/app-container';
import { requireAuth } from '../auth/auth.middleware';
import {
  ErrorResponse,
  PlatformUserDetailParams,
  PlatformUserDetailResponse,
  PlatformUserDirectoryQuery,
  PlatformUserDirectoryResponse,
  PlatformUserEmptyQuery,
} from './platform-user.schemas';
import { rejectPlatformUserSupport } from './platform-user.service';

export async function registerPlatformUserRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const preHandler = [
    requireAuth(),
    async (request: import('fastify').FastifyRequest) => {
      rejectPlatformUserSupport(request.ctx);
    },
  ];
  const description =
    'Read-only Platform members, not all system accounts. Requires PLATFORM platform_users.read, MFA and ACTIVE actor membership. Support forbidden (403 SUPPORT_ACCESS_FORBIDDEN). Top-level status is account status; nested status is membership status. Minimized PII; private, no-store.';
  app.get<{ Querystring: Static<typeof PlatformUserDirectoryQuery> }>(
    '/api/v1/platform/users',
    {
      preHandler,
      schema: {
        tags: ['Platform'],
        description,
        querystring: PlatformUserDirectoryQuery,
        response: {
          200: PlatformUserDirectoryResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          422: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const response = await container.platformUsers.directory(request.ctx, request.query);
      reply.header('Cache-Control', 'private, no-store');
      return response;
    },
  );
  app.get<{ Params: Static<typeof PlatformUserDetailParams> }>(
    '/api/v1/platform/users/:userId',
    {
      preHandler,
      schema: {
        tags: ['Platform'],
        description: `${description} Unknown user or account without Platform membership: 404 USER_NOT_FOUND.`,
        params: PlatformUserDetailParams,
        querystring: PlatformUserEmptyQuery,
        response: {
          200: PlatformUserDetailResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const data = await container.platformUsers.detail(request.ctx, request.params.userId);
      reply.header('Cache-Control', 'private, no-store');
      return { data };
    },
  );
}
