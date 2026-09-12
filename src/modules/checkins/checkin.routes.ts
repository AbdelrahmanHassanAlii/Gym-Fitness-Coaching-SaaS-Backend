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
  AssignmentCreateBody,
  AssignmentParams,
  AssignmentPatchBody,
  CheckInParams,
  ErrorResponse,
  ExpectedVersionBody,
  ListQuery,
  RelationshipParams,
  ReviewBody,
  SubmitBody,
  TemplateCreateBody,
  TemplateParams,
  TemplateRevisionBody,
  WorkspaceParams,
} from './checkin.schemas';

export async function registerCheckInRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.get<{ Params: Static<typeof WorkspaceParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/checkin-templates',
    workspaceOptions(container, Permissions.CheckInTemplatesRead, {
      params: WorkspaceParams,
      querystring: ListQuery,
    }),
    async (request) =>
      await container.checkins.listTemplates(
        request.ctx,
        request.params.workspaceId,
        request.query,
      ),
  );

  app.post<{ Params: Static<typeof WorkspaceParams>; Body: Static<typeof TemplateCreateBody> }>(
    '/api/v1/workspaces/:workspaceId/checkin-templates',
    workspaceOptions(container, Permissions.CheckInTemplatesCreate, {
      params: WorkspaceParams,
      body: TemplateCreateBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/checkin-templates',
        (tx) =>
          container.checkins.createTemplate(
            request.ctx,
            request.params.workspaceId,
            request.body,
            tx,
          ),
      ),
  );

  app.get<{ Params: Static<typeof TemplateParams> }>(
    '/api/v1/workspaces/:workspaceId/checkin-templates/:templateId',
    workspaceOptions(container, Permissions.CheckInTemplatesRead, { params: TemplateParams }),
    async (request) => ({
      data: await container.checkins.getTemplate(
        request.ctx,
        request.params.workspaceId,
        request.params.templateId,
      ),
    }),
  );

  app.post<{
    Params: Static<typeof TemplateParams>;
    Body: Static<typeof TemplateRevisionBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/checkin-templates/:templateId/revisions',
    workspaceOptions(container, Permissions.CheckInTemplatesUpdate, {
      params: TemplateParams,
      body: TemplateRevisionBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/checkin-templates/:templateId/revisions',
        (tx) =>
          container.checkins.createRevision(
            request.ctx,
            request.params.workspaceId,
            request.params.templateId,
            request.body,
            tx,
          ),
      ),
  );

  app.post<{ Params: Static<typeof TemplateParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/workspaces/:workspaceId/checkin-templates/:templateId/archive',
    workspaceOptions(container, Permissions.CheckInTemplatesArchive, {
      params: TemplateParams,
      body: ExpectedVersionBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/checkin-templates/:templateId/archive',
        (tx) =>
          container.checkins.archiveTemplate(
            request.ctx,
            request.params.workspaceId,
            request.params.templateId,
            request.body,
            tx,
          ),
      ),
  );

  app.get<{ Params: Static<typeof RelationshipParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkin-assignments',
    workspaceOptions(container, Permissions.CheckInAssignmentsRead, {
      params: RelationshipParams,
      querystring: ListQuery,
    }),
    async (request) =>
      await container.checkins.listAssignments(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
  );

  app.post<{
    Params: Static<typeof RelationshipParams>;
    Body: Static<typeof AssignmentCreateBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkin-assignments',
    workspaceOptions(container, Permissions.CheckInsAssign, {
      params: RelationshipParams,
      body: AssignmentCreateBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/relationships/:relationshipId/checkin-assignments',
        (tx) =>
          container.checkins.createAssignment(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            request.body,
            tx,
          ),
      ),
  );

  app.patch<{ Params: Static<typeof AssignmentParams>; Body: Static<typeof AssignmentPatchBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkin-assignments/:assignmentId',
    workspaceOptions(container, Permissions.CheckInAssignmentsUpdate, {
      params: AssignmentParams,
      body: AssignmentPatchBody,
    }),
    async (request) => ({
      data: await container.checkins.updateAssignment(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.assignmentId,
        request.body,
      ),
    }),
  );

  app.post<{ Params: Static<typeof AssignmentParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkin-assignments/:assignmentId/end',
    workspaceOptions(container, Permissions.CheckInAssignmentsEnd, {
      params: AssignmentParams,
      body: ExpectedVersionBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/relationships/:relationshipId/checkin-assignments/:assignmentId/end',
        (tx) =>
          container.checkins.endAssignment(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            request.params.assignmentId,
            request.body,
            tx,
          ),
      ),
  );

  app.get<{ Params: Static<typeof RelationshipParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkins',
    workspaceOptions(container, Permissions.CheckInsRead, {
      params: RelationshipParams,
      querystring: ListQuery,
    }),
    async (request) =>
      await container.checkins.listInstances(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
  );

  app.get<{ Params: Static<typeof CheckInParams> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkins/:checkinId',
    workspaceOptions(container, Permissions.CheckInsRead, { params: CheckInParams }),
    async (request) => ({
      data: await container.checkins.getInstance(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.checkinId,
      ),
    }),
  );

  app.post<{ Params: Static<typeof CheckInParams>; Body: Static<typeof SubmitBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkins/:checkinId/submit',
    workspaceOptions(container, Permissions.CheckInsSubmit, {
      params: CheckInParams,
      body: SubmitBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/relationships/:relationshipId/checkins/:checkinId/submit',
        (tx) =>
          container.checkins.submit(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            request.params.checkinId,
            request.body,
            tx,
          ),
      ),
  );

  app.post<{ Params: Static<typeof CheckInParams>; Body: Static<typeof ReviewBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkins/:checkinId/review',
    workspaceOptions(container, Permissions.CheckInsReview, {
      params: CheckInParams,
      body: ReviewBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/relationships/:relationshipId/checkins/:checkinId/review',
        (tx) =>
          container.checkins.review(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            request.params.checkinId,
            request.body,
            tx,
          ),
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
      tags: ['Check-Ins'],
      ...schema,
      response: { 200: {}, 201: {}, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
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
