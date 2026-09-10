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
  ActivateProgramBody,
  CreateProgramBody,
  CreateProgramRevisionBody,
  CreateTemplateBody,
  CreateTemplateRevisionBody,
  ErrorResponse,
  ExerciseBody,
  ExerciseParams,
  ExercisePatchBody,
  ExpectedVersionBody,
  ListQuery,
  PlatformExerciseBody,
  PlatformExerciseParams,
  ProgramParams,
  RelationshipParams,
  TemplateParams,
  WorkspaceParams,
} from './training.schemas';

export async function registerTrainingRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.get<{ Params: Static<typeof WorkspaceParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/exercises',
    workspaceOptions(container, Permissions.ExercisesRead, {
      params: WorkspaceParams,
      querystring: ListQuery,
    }),
    async (request) =>
      await container.training.listExercises(
        request.ctx,
        request.params.workspaceId,
        request.query,
      ),
  );

  app.post<{ Params: Static<typeof WorkspaceParams>; Body: Static<typeof ExerciseBody> }>(
    '/api/v1/workspaces/:workspaceId/exercises',
    workspaceOptions(container, Permissions.ExercisesCreate, {
      params: WorkspaceParams,
      body: ExerciseBody,
    }),
    async (request, reply) => {
      const data = await container.training.createExercise(
        request.ctx,
        request.params.workspaceId,
        request.body,
      );
      return reply.status(201).send({ data });
    },
  );

  app.patch<{ Params: Static<typeof ExerciseParams>; Body: Static<typeof ExercisePatchBody> }>(
    '/api/v1/workspaces/:workspaceId/exercises/:exerciseId',
    workspaceOptions(container, Permissions.ExercisesUpdate, {
      params: ExerciseParams,
      body: ExercisePatchBody,
    }),
    async (request) => ({
      data: await container.training.updateExercise(
        request.ctx,
        request.params.workspaceId,
        request.params.exerciseId,
        request.body,
      ),
    }),
  );

  app.post<{ Params: Static<typeof ExerciseParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/workspaces/:workspaceId/exercises/:exerciseId/archive',
    workspaceOptions(container, Permissions.ExercisesArchive, {
      params: ExerciseParams,
      body: ExpectedVersionBody,
    }),
    async (request) => ({
      data: await container.training.archiveExercise(
        request.ctx,
        request.params.workspaceId,
        request.params.exerciseId,
        request.body,
      ),
    }),
  );

  app.get<{ Querystring: Static<typeof ListQuery> }>(
    '/api/v1/platform/exercises',
    platformOptions(container, Permissions.SystemExercisesRead, { querystring: ListQuery }),
    async (request) => await container.training.listPlatformExercises(request.ctx, request.query),
  );

  app.post<{ Body: Static<typeof PlatformExerciseBody> }>(
    '/api/v1/platform/exercises',
    platformOptions(container, Permissions.SystemExercisesCreate, { body: PlatformExerciseBody }),
    async (request, reply) => {
      const data = await container.training.createPlatformExercise(request.ctx, request.body);
      return reply.status(201).send({ data });
    },
  );

  app.patch<{
    Params: Static<typeof PlatformExerciseParams>;
    Body: Static<typeof ExercisePatchBody>;
  }>(
    '/api/v1/platform/exercises/:exerciseId',
    platformOptions(container, Permissions.SystemExercisesUpdate, {
      params: PlatformExerciseParams,
      body: ExercisePatchBody,
    }),
    async (request) => ({
      data: await container.training.updateExercise(
        request.ctx,
        undefined,
        request.params.exerciseId,
        request.body,
        true,
      ),
    }),
  );

  app.post<{
    Params: Static<typeof PlatformExerciseParams>;
    Body: Static<typeof ExpectedVersionBody>;
  }>(
    '/api/v1/platform/exercises/:exerciseId/archive',
    platformOptions(container, Permissions.SystemExercisesArchive, {
      params: PlatformExerciseParams,
      body: ExpectedVersionBody,
    }),
    async (request) => ({
      data: await container.training.archiveExercise(
        request.ctx,
        undefined,
        request.params.exerciseId,
        request.body,
        true,
      ),
    }),
  );

  app.get<{ Params: Static<typeof WorkspaceParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/program-templates',
    workspaceOptions(container, Permissions.ProgramTemplatesRead, {
      params: WorkspaceParams,
      querystring: ListQuery,
    }),
    async (request) =>
      await container.training.listTemplates(
        request.ctx,
        request.params.workspaceId,
        request.query,
      ),
  );

  app.post<{ Params: Static<typeof WorkspaceParams>; Body: Static<typeof CreateTemplateBody> }>(
    '/api/v1/workspaces/:workspaceId/program-templates',
    workspaceOptions(container, Permissions.ProgramTemplatesCreate, {
      params: WorkspaceParams,
      body: CreateTemplateBody,
    }),
    async (request, reply) => {
      const data = await container.training.createTemplate(
        request.ctx,
        request.params.workspaceId,
        request.body,
      );
      return reply.status(201).send({ data });
    },
  );

  app.get<{ Params: Static<typeof TemplateParams> }>(
    '/api/v1/workspaces/:workspaceId/program-templates/:templateId',
    workspaceOptions(container, Permissions.ProgramTemplatesRead, { params: TemplateParams }),
    async (request) => ({
      data: await container.training.getTemplate(
        request.ctx,
        request.params.workspaceId,
        request.params.templateId,
      ),
    }),
  );

  app.post<{
    Params: Static<typeof TemplateParams>;
    Body: Static<typeof CreateTemplateRevisionBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/program-templates/:templateId/revisions',
    workspaceOptions(container, Permissions.ProgramTemplatesUpdate, {
      params: TemplateParams,
      body: CreateTemplateRevisionBody,
    }),
    async (request) => ({
      data: await container.training.createTemplateRevision(
        request.ctx,
        request.params.workspaceId,
        request.params.templateId,
        request.body,
      ),
    }),
  );

  app.post<{ Params: Static<typeof TemplateParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/workspaces/:workspaceId/program-templates/:templateId/archive',
    workspaceOptions(container, Permissions.ProgramTemplatesArchive, {
      params: TemplateParams,
      body: ExpectedVersionBody,
    }),
    async (request) => ({
      data: await container.training.archiveTemplate(
        request.ctx,
        request.params.workspaceId,
        request.params.templateId,
        request.body,
      ),
    }),
  );

  app.get<{ Params: Static<typeof RelationshipParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs',
    workspaceOptions(container, Permissions.ProgramsRead, {
      params: RelationshipParams,
      querystring: ListQuery,
    }),
    async (request) =>
      await container.training.listPrograms(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
  );

  app.post<{ Params: Static<typeof RelationshipParams>; Body: Static<typeof CreateProgramBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs',
    workspaceOptions(container, Permissions.ProgramsCreate, {
      params: RelationshipParams,
      body: CreateProgramBody,
    }),
    async (request, reply) => {
      const data = await container.training.createProgram(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.body,
      );
      return reply.status(201).send({ data });
    },
  );

  app.get<{ Params: Static<typeof ProgramParams> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId',
    workspaceOptions(container, Permissions.ProgramsRead, { params: ProgramParams }),
    async (request) => ({
      data: await container.training.getProgram(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.programId,
      ),
    }),
  );

  app.post<{
    Params: Static<typeof ProgramParams>;
    Body: Static<typeof CreateProgramRevisionBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/revisions',
    workspaceOptions(container, Permissions.ProgramsUpdate, {
      params: ProgramParams,
      body: CreateProgramRevisionBody,
    }),
    async (request) => ({
      data: await container.training.createProgramRevision(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.programId,
        request.body,
      ),
    }),
  );

  app.post<{ Params: Static<typeof ProgramParams>; Body: Static<typeof ActivateProgramBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/activate',
    workspaceOptions(container, Permissions.ProgramsActivate, {
      params: ProgramParams,
      body: ActivateProgramBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/activate',
        (tx) =>
          container.training.activateProgram(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            request.params.programId,
            request.body,
            tx,
          ),
      ),
  );

  app.post<{ Params: Static<typeof ProgramParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/complete',
    workspaceOptions(container, Permissions.ProgramsComplete, {
      params: ProgramParams,
      body: ExpectedVersionBody,
    }),
    async (request) => ({
      data: await container.training.completeProgram(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.programId,
        request.body,
      ),
    }),
  );

  app.post<{ Params: Static<typeof ProgramParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/archive',
    workspaceOptions(container, Permissions.ProgramsArchive, {
      params: ProgramParams,
      body: ExpectedVersionBody,
    }),
    async (request) => ({
      data: await container.training.archiveProgram(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.programId,
        request.body,
      ),
    }),
  );

  app.get<{ Params: Static<typeof ProgramParams> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/progress',
    workspaceOptions(container, Permissions.ProgramsRead, { params: ProgramParams }),
    async (request) => ({
      data: await container.training.getProgress(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.programId,
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
      tags: ['Training'],
      ...schema,
      response: { 200: {}, 201: {}, 403: ErrorResponse, 409: ErrorResponse },
    },
  };
}

function platformOptions(
  container: AppContainer,
  permission: string,
  schema: Record<string, unknown>,
) {
  return {
    preHandler: [requireAuth(), requireAccess(container, { context: 'PLATFORM', permission })],
    schema: {
      tags: ['Training'],
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
    operation: async (tx) => ({ body: await operation(tx) }),
  });
  return reply.status(result.statusCode).send({ data: result.body });
}
