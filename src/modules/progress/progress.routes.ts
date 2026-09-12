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
  AdherenceConfigBody,
  DailyTrackingBody,
  DailyTrackingParams,
  ErrorResponse,
  ExpectedVersionBody,
  HealthProfileBody,
  ListQuery,
  MeasurementBody,
  MeasurementParams,
  MeasurementPatchBody,
  MetricDefinitionBody,
  MetricDefinitionParams,
  MetricDefinitionPatchBody,
  NoteBody,
  NoteParams,
  NotePatchBody,
  RelationshipParams,
  WorkspaceParams,
} from './progress.schemas';

export async function registerProgressRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.get<{ Params: Static<typeof WorkspaceParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/metric-definitions',
    workspaceOptions(container, Permissions.MetricDefinitionsRead, {
      params: WorkspaceParams,
      querystring: ListQuery,
    }),
    async (request) =>
      await container.progress.listMetricDefinitions(
        request.ctx,
        request.params.workspaceId,
        request.query,
      ),
  );

  app.post<{ Params: Static<typeof WorkspaceParams>; Body: Static<typeof MetricDefinitionBody> }>(
    '/api/v1/workspaces/:workspaceId/metric-definitions',
    workspaceOptions(container, Permissions.MetricDefinitionsCreate, {
      params: WorkspaceParams,
      body: MetricDefinitionBody,
    }),
    async (request, reply) => {
      const data = await container.progress.createMetricDefinition(
        request.ctx,
        request.params.workspaceId,
        request.body,
      );
      return reply.status(201).send({ data });
    },
  );

  app.patch<{
    Params: Static<typeof MetricDefinitionParams>;
    Body: Static<typeof MetricDefinitionPatchBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/metric-definitions/:metricDefinitionId',
    workspaceOptions(container, Permissions.MetricDefinitionsUpdate, {
      params: MetricDefinitionParams,
      body: MetricDefinitionPatchBody,
    }),
    async (request) => ({
      data: await container.progress.updateMetricDefinition(
        request.ctx,
        request.params.workspaceId,
        request.params.metricDefinitionId,
        request.body,
      ),
    }),
  );

  app.post<{
    Params: Static<typeof MetricDefinitionParams>;
    Body: Static<typeof ExpectedVersionBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/metric-definitions/:metricDefinitionId/archive',
    workspaceOptions(container, Permissions.MetricDefinitionsArchive, {
      params: MetricDefinitionParams,
      body: ExpectedVersionBody,
    }),
    async (request) => ({
      data: await container.progress.archiveMetricDefinition(
        request.ctx,
        request.params.workspaceId,
        request.params.metricDefinitionId,
        request.body,
      ),
    }),
  );

  app.get<{ Params: Static<typeof RelationshipParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/measurements',
    workspaceOptions(container, Permissions.MeasurementsRead, {
      params: RelationshipParams,
      querystring: ListQuery,
    }),
    async (request) =>
      await container.progress.listMeasurements(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
  );

  app.post<{ Params: Static<typeof RelationshipParams>; Body: Static<typeof MeasurementBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/measurements',
    workspaceOptions(container, Permissions.MeasurementsCreate, {
      params: RelationshipParams,
      body: MeasurementBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/relationships/:relationshipId/measurements',
        (tx) =>
          container.progress.createMeasurement(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            request.body,
            tx,
          ),
      ),
  );

  app.patch<{
    Params: Static<typeof MeasurementParams>;
    Body: Static<typeof MeasurementPatchBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/measurements/:measurementId',
    workspaceOptions(container, Permissions.MeasurementsUpdate, {
      params: MeasurementParams,
      body: MeasurementPatchBody,
    }),
    async (request) => ({
      data: await container.progress.updateMeasurement(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.measurementId,
        request.body,
      ),
    }),
  );

  app.get<{ Params: Static<typeof RelationshipParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/progress-photos',
    { preHandler: [requireAuth()], schema: { params: RelationshipParams, querystring: ListQuery } },
    async (request) =>
      await container.progress.listProgressPhotos(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
  );

  app.get<{ Params: Static<typeof RelationshipParams> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/health-profile',
    { preHandler: [requireAuth()], schema: { params: RelationshipParams } },
    async (request) => ({
      data: await container.progress.getHealthProfile(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
      ),
    }),
  );

  app.put<{ Params: Static<typeof RelationshipParams>; Body: Static<typeof HealthProfileBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/health-profile',
    workspaceOptions(container, Permissions.HealthUpdate, {
      params: RelationshipParams,
      body: HealthProfileBody,
    }),
    async (request) => ({
      data: await container.progress.putHealthProfile(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.body,
      ),
    }),
  );

  app.get<{ Params: Static<typeof RelationshipParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/notes',
    { preHandler: [requireAuth()], schema: { params: RelationshipParams, querystring: ListQuery } },
    async (request) =>
      await container.progress.listNotes(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
  );

  app.post<{ Params: Static<typeof RelationshipParams>; Body: Static<typeof NoteBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/notes',
    workspaceOptions(container, Permissions.NotesCreate, {
      params: RelationshipParams,
      body: NoteBody,
    }),
    async (request, reply) => {
      const data = await container.progress.createNote(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.body,
      );
      return reply.status(201).send({ data });
    },
  );

  app.patch<{ Params: Static<typeof NoteParams>; Body: Static<typeof NotePatchBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/notes/:noteId',
    workspaceOptions(container, Permissions.NotesUpdate, {
      params: NoteParams,
      body: NotePatchBody,
    }),
    async (request) => ({
      data: await container.progress.updateNote(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.noteId,
        request.body,
      ),
    }),
  );

  app.post<{ Params: Static<typeof NoteParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/notes/:noteId/archive',
    workspaceOptions(container, Permissions.NotesArchive, {
      params: NoteParams,
      body: ExpectedVersionBody,
    }),
    async (request) => ({
      data: await container.progress.archiveNote(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.noteId,
        request.body,
      ),
    }),
  );

  app.get<{ Params: Static<typeof RelationshipParams> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/adherence-config',
    workspaceOptions(container, Permissions.AdherenceRead, { params: RelationshipParams }),
    async (request) => ({
      data: await container.progress.getAdherenceConfig(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
      ),
    }),
  );

  app.put<{ Params: Static<typeof RelationshipParams>; Body: Static<typeof AdherenceConfigBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/adherence-config',
    workspaceOptions(container, Permissions.AdherenceConfigure, {
      params: RelationshipParams,
      body: AdherenceConfigBody,
    }),
    async (request) => ({
      data: await container.progress.putAdherenceConfig(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.body,
      ),
    }),
  );

  app.get<{ Params: Static<typeof DailyTrackingParams> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/daily-tracking/:localDate',
    workspaceOptions(container, Permissions.AdherenceRead, { params: DailyTrackingParams }),
    async (request) => ({
      data: await container.progress.getDailyTracking(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.localDate,
      ),
    }),
  );

  app.put<{ Params: Static<typeof DailyTrackingParams>; Body: Static<typeof DailyTrackingBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/daily-tracking/:localDate',
    {
      preHandler: [requireAuth()],
      schema: { params: DailyTrackingParams, body: DailyTrackingBody },
    },
    async (request) => ({
      data: await container.progress.putDailyTracking(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.localDate,
        request.body,
      ),
    }),
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
      tags: ['Progress'],
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
    body: unknown;
  },
  routeKey: string,
  operation: (tx: TransactionContext) => Promise<unknown>,
) {
  const result = await container.idempotency.runInTransaction(request.ctx, {
    routeKey,
    key: idempotencyKey(request.headers),
    fingerprint: { params: request.params, body: request.body },
    unitOfWork: container.unitOfWork,
    operation: async (tx) => ({ body: await operation(tx), statusCode: 201 }),
  });
  return reply.status(result.statusCode).send({ data: result.body });
}
