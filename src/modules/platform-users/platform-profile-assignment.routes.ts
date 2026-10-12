import type { Static } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContainer } from '../../bootstrap/app-container';
import { idempotencyKey } from '../../core/idempotency/idempotency.service';
import { requireAuth } from '../auth/auth.middleware';
import { managementError, rejectManagementSupport } from '../platform/platform-authority.guard';
import {
  AssignmentBody,
  AssignmentErrors,
  AssignmentHeaders,
  AssignmentParams,
  AssignmentResponse,
  SelectorQuery,
  SelectorResponse,
} from './platform-profile-assignment.schemas';
import { canonicalProfiles } from './platform-profile-assignment.service';

const description =
  'Requires platform_permissions.manage, unrestricted authentication, MFA, ACTIVE actor account and Platform membership. Support is forbidden. Errors: 400 VALIDATION_FAILED, IDEMPOTENCY_KEY_REQUIRED; 401 AUTH_REQUIRED; 403 AUTH_SESSION_RESTRICTED, TWO_FACTOR_REQUIRED, PLATFORM_MEMBERSHIP_REQUIRED, PLATFORM_MEMBERSHIP_INACTIVE, PERMISSION_DENIED, SUPPORT_ACCESS_FORBIDDEN, DELEGATION_DENIED, PLATFORM_PERMISSION_SELF_MUTATION_FORBIDDEN; 404 USER_NOT_FOUND, PERMISSION_PROFILE_NOT_FOUND; 409 PLATFORM_MEMBERSHIP_VERSION_CONFLICT, PLATFORM_PERMISSION_TARGET_MEMBERSHIP_INACTIVE, PLATFORM_MEMBERSHIP_TARGET_ACCOUNT_INACTIVE, PERMISSION_PROFILE_DUPLICATE, PLATFORM_LAST_MANAGEMENT_AUTHORITY_REQUIRED, PLATFORM_AUTHORITY_EVALUATION_LIMIT_EXCEEDED, IDEMPOTENCY_KEY_REUSED, IDEMPOTENCY_REQUEST_IN_PROGRESS, IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED, IDEMPOTENCY_CONFLICT, IDEMPOTENCY_COMPLETION_CONFLICT; 500 INTERNAL_ERROR. Private, no-store.';

export async function registerPlatformProfileAssignmentRoutes(
  app: FastifyInstance,
  container: AppContainer,
) {
  const guards = [
    requireAuth(),
    async (request: FastifyRequest) => {
      if (!request.ctx.mfaSatisfied) throw managementError('TWO_FACTOR_REQUIRED', 403);
      if (request.headers['x-support-session-id'] !== undefined)
        throw managementError('SUPPORT_ACCESS_FORBIDDEN', 403);
      rejectManagementSupport(request.ctx);
      await container.platformProfileAssignment.authorize(request.ctx);
      // Fastify may remove extra fields during schema validation; reject them first.
      if (request.method === 'PUT') {
        const body = request.body;
        if (
          !body ||
          typeof body !== 'object' ||
          Object.keys(body).some((k) => !['expectedVersion', 'profileIds'].includes(k)) ||
          !('expectedVersion' in body) ||
          !Number.isSafeInteger(body.expectedVersion) ||
          Number(body.expectedVersion) < 0 ||
          !('profileIds' in body) ||
          !Array.isArray(body.profileIds) ||
          body.profileIds.length > 20 ||
          body.profileIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id))
        )
          throw managementError('VALIDATION_FAILED', 400);
      }
    },
  ];
  const path = '/api/v1/platform/users/:userId/permission-profile-assignment';
  app.get<{ Params: Static<typeof AssignmentParams> }>(
    path,
    {
      preValidation: guards,
      schema: {
        tags: ['Platform'],
        description,
        params: AssignmentParams,
        response: { 200: AssignmentResponse, ...AssignmentErrors },
      },
    },
    async (request, reply) =>
      reply.header('Cache-Control', 'private, no-store').send({
        data: await container.platformProfileAssignment.state(request.ctx, request.params.userId),
      }),
  );
  app.get<{ Querystring: Static<typeof SelectorQuery> }>(
    '/api/v1/platform/permission-profile-selector',
    {
      preValidation: guards,
      schema: {
        tags: ['Platform'],
        description: `${description} ACTIVE Platform profiles including system defaults; selection is not a delegation guarantee. Stable unique active-name cursor; limit 1..100, default 50.`,
        querystring: SelectorQuery,
        response: { 200: SelectorResponse, ...AssignmentErrors },
      },
    },
    async (request, reply) =>
      reply.header('Cache-Control', 'private, no-store').send({
        data: await container.platformProfileAssignment.selector(
          request.ctx,
          request.query.limit,
          request.query.cursor,
        ),
      }),
  );
  app.put<{ Params: Static<typeof AssignmentParams>; Body: Static<typeof AssignmentBody> }>(
    path,
    {
      preValidation: guards,
      schema: {
        tags: ['Platform'],
        description: `${description} Existing ACTIVE target only. expectedVersion is management version; max 20 profiles, duplicates conflict, self forbidden. Idempotency-Key required. Fresh no-op leaves revisions/events unchanged.`,
        params: AssignmentParams,
        body: AssignmentBody,
        headers: AssignmentHeaders,
        response: { 200: AssignmentResponse, ...AssignmentErrors },
      },
      schemaErrorFormatter: (_errors, variable) =>
        variable === 'headers'
          ? managementError('IDEMPOTENCY_KEY_REQUIRED', 400)
          : new Error('Assignment validation failed.'),
    },
    async (request, reply) => {
      const userId = request.params.userId;
      const body = {
        expectedVersion: request.body.expectedVersion,
        profileIds: canonicalProfiles(request.body.profileIds),
      };
      const result = await container.idempotency.runInTransaction(request.ctx, {
        key: idempotencyKey(request.headers),
        routeKey: `PUT /api/v1/platform/users/${userId}/permission-profile-assignment`,
        fingerprint: { userId, body },
        unitOfWork: container.unitOfWork,
        operation: async (tx) => ({
          body: (await container.platformProfileAssignment.replace(request.ctx, userId, body, tx))
            .dto,
        }),
      });
      if (result.replayed) await container.platformProfileAssignment.authorize(request.ctx);
      return reply
        .header('Cache-Control', 'private, no-store')
        .status(result.statusCode)
        .send({ data: result.body });
    },
  );
}
