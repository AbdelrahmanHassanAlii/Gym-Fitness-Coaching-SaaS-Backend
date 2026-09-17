import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { AppContainer } from '../../bootstrap/app-container';
import { idempotencyKey } from '../../core/idempotency/idempotency.service';
import { requireAuth } from '../auth/auth.middleware';
import {
  ErrorResponse,
  ExpectedVersionBody,
  PolicyParams,
  PortalAccessPolicyBody,
  SessionParams,
  SupportAccessRequestBody,
} from './support-access.schemas';

export async function registerSupportAccessRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.get(
    '/api/v1/platform/support/policies',
    {
      preHandler: requireAuth(),
      schema: { tags: ['Support'], response: { 401: ErrorResponse, 403: ErrorResponse } },
    },
    async (request) => await container.supportAccess.listPolicies(request.ctx),
  );

  app.post<{ Body: Static<typeof PortalAccessPolicyBody> }>(
    '/api/v1/platform/support/policies',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Support'],
        body: PortalAccessPolicyBody,
        response: { 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request) => await container.supportAccess.createPolicy(request.ctx, request.body),
  );

  app.get<{ Params: Static<typeof PolicyParams> }>(
    '/api/v1/platform/support/policies/:policyId',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Support'],
        params: PolicyParams,
        response: { 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) =>
      await container.supportAccess.getPolicy(request.ctx, request.params.policyId),
  );

  app.patch<{ Params: Static<typeof PolicyParams>; Body: Static<typeof PortalAccessPolicyBody> }>(
    '/api/v1/platform/support/policies/:policyId',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Support'],
        params: PolicyParams,
        body: PortalAccessPolicyBody,
        response: { 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) =>
      await container.supportAccess.updatePolicy(request.ctx, request.params.policyId, {
        ...request.body,
        expectedVersion: request.body.expectedVersion ?? 0,
      }),
  );

  app.post<{ Params: Static<typeof PolicyParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/platform/support/policies/:policyId/disable',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Support'],
        params: PolicyParams,
        body: ExpectedVersionBody,
        response: { 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) =>
      await container.supportAccess.disablePolicy(
        request.ctx,
        request.params.policyId,
        request.body,
      ),
  );

  app.post<{ Params: Static<typeof PolicyParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/platform/support/policies/:policyId/archive',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Support'],
        params: PolicyParams,
        body: ExpectedVersionBody,
        response: { 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) =>
      await container.supportAccess.archivePolicy(
        request.ctx,
        request.params.policyId,
        request.body,
      ),
  );

  app.post<{ Body: Static<typeof SupportAccessRequestBody> }>(
    '/api/v1/platform/support/access-requests',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Support'],
        body: SupportAccessRequestBody,
        response: {
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const result = await container.idempotency.runInTransaction<unknown>(request.ctx, {
        key: idempotencyKey(request.headers),
        routeKey: 'support.access-requests.start',
        fingerprint: request.body,
        unitOfWork: container.unitOfWork,
        operation: async (tx) =>
          await container.supportAccess.startSession(request.ctx, request.body, tx),
      });
      reply.code(result.statusCode as 200 | 201 | 403);
      return result.body;
    },
  );

  app.get<{ Params: Static<typeof SessionParams> }>(
    '/api/v1/platform/support/sessions',
    {
      preHandler: requireAuth(),
      schema: { tags: ['Support'], response: { 401: ErrorResponse, 403: ErrorResponse } },
    },
    async (request) => await container.supportAccess.listSessions(request.ctx),
  );

  app.get<{ Params: Static<typeof SessionParams> }>(
    '/api/v1/platform/support/sessions/:sessionId',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Support'],
        params: SessionParams,
        response: { 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) =>
      await container.supportAccess.getSession(request.ctx, request.params.sessionId),
  );

  app.post<{ Params: Static<typeof SessionParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/platform/support/sessions/:sessionId/end',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Support'],
        params: SessionParams,
        body: ExpectedVersionBody,
        response: { 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) =>
      await container.supportAccess.endOwnSession(
        request.ctx,
        request.params.sessionId,
        request.body,
      ),
  );

  app.post<{ Params: Static<typeof SessionParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/platform/support/sessions/:sessionId/revoke',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Support'],
        params: SessionParams,
        body: ExpectedVersionBody,
        response: { 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) =>
      await container.supportAccess.revokeSession(
        request.ctx,
        request.params.sessionId,
        request.body,
      ),
  );
}

export async function registerSupportAccessContext(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.addHook('preHandler', async (request) => {
    const header = request.headers['x-support-session-id'];
    if (!header) return;
    if (Array.isArray(header) || !header.trim()) return;
    await container.supportAccess.resolveForRequest(request.ctx, header, {
      method: request.method,
      url: request.url,
      params: request.params,
    });
  });
}
