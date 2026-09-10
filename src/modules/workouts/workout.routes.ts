import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { AppContainer } from '../../bootstrap/app-container';
import { requireAccess } from '../../core/access-control/access-control.middleware';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { idempotencyKey } from '../../core/idempotency/idempotency.service';
import type { RequestContext } from '../../core/request-context/request-context';
import { requireAuth } from '../auth/auth.middleware';
import { Permissions } from '../permissions/permission.registry';
import {
  AbandonBody,
  ErrorResponse,
  ExpectedVersionBody,
  ListQuery,
  ProgressCommandBody,
  ProgressParams,
  RelationshipParams,
  WorkoutCorrectionBody,
  WorkoutParams,
  WorkoutPatchBody,
} from './workout.schemas';

export async function registerWorkoutRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.post<{ Params: Static<typeof RelationshipParams> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts/start',
    workspaceOptions(container, Permissions.WorkoutsCreate, { params: RelationshipParams }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/relationships/:relationshipId/workouts/start',
        (tx) =>
          container.workouts.start(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            tx,
          ),
      ),
  );

  app.get<{ Params: Static<typeof RelationshipParams> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts/current',
    workspaceOptions(container, Permissions.WorkoutsRead, { params: RelationshipParams }),
    async (request) => ({
      data: await container.workouts.current(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
      ),
    }),
  );

  app.get<{ Params: Static<typeof RelationshipParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts',
    workspaceOptions(container, Permissions.WorkoutsRead, {
      params: RelationshipParams,
      querystring: ListQuery,
    }),
    async (request) =>
      await container.workouts.list(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
  );

  app.patch<{ Params: Static<typeof WorkoutParams>; Body: Static<typeof WorkoutPatchBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId',
    workspaceOptions(container, Permissions.WorkoutsUpdate, {
      params: WorkoutParams,
      body: WorkoutPatchBody,
    }),
    async (request) => ({
      data: await container.workouts.patch(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.workoutId,
        request.body,
      ),
    }),
  );

  app.post<{ Params: Static<typeof WorkoutParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/complete',
    workspaceOptions(container, Permissions.WorkoutsComplete, {
      params: WorkoutParams,
      body: ExpectedVersionBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/complete',
        (tx) =>
          container.workouts.complete(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            request.params.workoutId,
            request.body,
            tx,
          ),
      ),
  );

  app.post<{ Params: Static<typeof WorkoutParams>; Body: Static<typeof AbandonBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/abandon',
    workspaceOptions(container, Permissions.WorkoutsAbandon, {
      params: WorkoutParams,
      body: AbandonBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/abandon',
        (tx) =>
          container.workouts.abandon(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            request.params.workoutId,
            request.body,
            tx,
          ),
      ),
  );

  app.post<{ Params: Static<typeof WorkoutParams>; Body: Static<typeof WorkoutCorrectionBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/corrections',
    workspaceOptions(container, Permissions.WorkoutsCorrect, {
      params: WorkoutParams,
      body: WorkoutCorrectionBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/corrections',
        (tx) =>
          container.workouts.staffCorrection(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            request.params.workoutId,
            request.body,
            tx,
          ),
      ),
  );

  app.post<{ Params: Static<typeof ProgressParams>; Body: Static<typeof ProgressCommandBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/progress/skip',
    workspaceOptions(container, Permissions.WorkoutsDaySkip, {
      params: ProgressParams,
      body: ProgressCommandBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/progress/skip',
        (tx) =>
          container.workouts.skipOrDefer(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            request.params.programId,
            request.body,
            'SKIPPED',
            tx,
          ),
      ),
  );

  app.post<{ Params: Static<typeof ProgressParams>; Body: Static<typeof ProgressCommandBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/progress/defer',
    workspaceOptions(container, Permissions.WorkoutsDayDefer, {
      params: ProgressParams,
      body: ProgressCommandBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/progress/defer',
        (tx) =>
          container.workouts.skipOrDefer(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            request.params.programId,
            request.body,
            'DEFERRED',
            tx,
          ),
      ),
  );

  app.get<{ Params: Static<typeof RelationshipParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/personal-records',
    workspaceOptions(container, Permissions.PersonalRecordsRead, {
      params: RelationshipParams,
      querystring: ListQuery,
    }),
    async (request) =>
      await container.workouts.listPersonalRecords(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
  );

  app.get<{ Params: Static<typeof RelationshipParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/personal-record-events',
    workspaceOptions(container, Permissions.PersonalRecordsRead, {
      params: RelationshipParams,
      querystring: ListQuery,
    }),
    async (request) =>
      await container.workouts.listPersonalRecordEvents(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
  );
}

function workspaceOptions(
  container: AppContainer,
  permission: string,
  schema: Record<string, unknown>,
) {
  return {
    preHandler: [requireAuth(), requireAccess(container, { context: 'WORKSPACE', permission })],
    schema: {
      tags: ['Workouts'],
      ...schema,
      response: { 200: {}, 201: {}, 403: ErrorResponse, 409: ErrorResponse },
    },
  };
}

async function idempotent(
  reply: { status: (statusCode: number) => { send: (body: unknown) => unknown } },
  container: AppContainer,
  request: {
    ctx: RequestContext;
    headers: Record<string, unknown>;
    params: unknown;
    body?: unknown;
  },
  routeKey: string,
  operation: (tx: TransactionContext) => Promise<unknown>,
) {
  const result = await container.idempotency.runInTransaction(request.ctx, {
    routeKey,
    key: idempotencyKey(request.headers),
    fingerprint: { params: request.params, body: request.body ?? {} },
    unitOfWork: container.unitOfWork,
    operation: async (tx) => ({ body: await operation(tx) }),
  });
  return reply.status(result.statusCode).send({ data: result.body });
}
