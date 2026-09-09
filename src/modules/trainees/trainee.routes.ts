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
  AcceptRelationshipBody,
  ErrorResponse,
  ExpectedVersionBody,
  HomeBranchBody,
  InvitationParams,
  InviteTraineeBody,
  MigrationBody,
  PrimaryTrainerBody,
  ReactivateRelationshipBody,
  ReferralJoinBody,
  ReferralParams,
  RelationshipParams,
  RelationshipQuery,
  StaffAssignmentBody,
  StaffAssignmentParams,
  SuccessResponse,
  WorkspaceParams,
} from './trainee.schemas';

export async function registerTraineeRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.get<{
    Params: Static<typeof WorkspaceParams>;
    Querystring: Static<typeof RelationshipQuery>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.TraineesRead,
        }),
      ],
      schema: { tags: ['Trainees'], params: WorkspaceParams, querystring: RelationshipQuery },
    },
    async (request) => ({
      data: await container.trainees.listRelationships(
        request.ctx,
        request.params.workspaceId,
        request.query,
      ),
    }),
  );

  app.get<{ Params: Static<typeof RelationshipParams> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Trainees'],
        params: RelationshipParams,
        response: { 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.trainees.getRelationship(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
      ),
    }),
  );

  app.post<{ Params: Static<typeof WorkspaceParams>; Body: Static<typeof InviteTraineeBody> }>(
    '/api/v1/workspaces/:workspaceId/trainee-invitations',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'WORKSPACE', permission: Permissions.TraineesInvite }),
      ],
      schema: {
        tags: ['Trainees'],
        params: WorkspaceParams,
        body: InviteTraineeBody,
        response: { 201: {}, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const result = await container.idempotency.runInTransaction(request.ctx, {
        key: idempotencyKey(request.headers),
        routeKey: 'POST /api/v1/workspaces/:workspaceId/trainee-invitations',
        fingerprint: { workspaceId: request.params.workspaceId, body: request.body },
        unitOfWork: container.unitOfWork,
        operation: (tx) =>
          container.trainees
            .inviteTrainee(request.ctx, request.params.workspaceId, request.body, tx)
            .then((body) => ({
              statusCode: 201,
              body,
              storedBody: { invitation: body.invitation },
            })),
      });
      return reply.status(result.statusCode).send({ data: result.body });
    },
  );

  app.post<{ Params: Static<typeof InvitationParams> }>(
    '/api/v1/workspaces/:workspaceId/trainee-invitations/:invitationId/reissue',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'WORKSPACE', permission: Permissions.TraineesInvite }),
      ],
      schema: { tags: ['Trainees'], params: InvitationParams },
    },
    async (request) => ({
      data: await container.trainees.reissueTraineeInvitation(
        request.ctx,
        request.params.workspaceId,
        request.params.invitationId,
      ),
    }),
  );

  app.post<{ Params: Static<typeof ReferralParams>; Body: Static<typeof ReferralJoinBody> }>(
    '/api/v1/referrals/:code/join',
    {
      preHandler: requireAuth(),
      schema: { tags: ['Trainees'], params: ReferralParams, body: ReferralJoinBody },
    },
    async (request) => {
      const result = await container.idempotency.runInTransaction(request.ctx, {
        key: idempotencyKey(request.headers),
        routeKey: 'POST /api/v1/referrals/:code/join',
        fingerprint: { code: request.params.code, body: request.body },
        unitOfWork: container.unitOfWork,
        operation: (tx) =>
          container.trainees
            .joinReferral(request.ctx, request.params.code, request.body, tx)
            .then((body) => ({ body })),
      });
      return { data: result.body };
    },
  );

  app.post<{
    Params: Static<typeof RelationshipParams>;
    Body: Static<typeof AcceptRelationshipBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/accept',
    relationshipCommand<Static<typeof AcceptRelationshipBody>>(
      container,
      Permissions.TraineesAccept,
      'POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/accept',
      RelationshipParams,
      AcceptRelationshipBody,
      (request, tx) =>
        container.trainees.acceptPending(
          request.ctx,
          request.params.workspaceId,
          request.params.relationshipId,
          request.body,
          tx,
        ),
    ),
  );

  app.post<{ Params: Static<typeof RelationshipParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/reject',
    relationshipCommand<Static<typeof ExpectedVersionBody>>(
      container,
      Permissions.TraineesReject,
      'POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/reject',
      RelationshipParams,
      ExpectedVersionBody,
      (request, tx) =>
        container.trainees.rejectPending(
          request.ctx,
          request.params.workspaceId,
          request.params.relationshipId,
          request.body,
          tx,
        ),
    ),
  );

  app.post<{ Params: Static<typeof RelationshipParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/end',
    relationshipCommand<Static<typeof ExpectedVersionBody>>(
      container,
      Permissions.TraineesEnd,
      'POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/end',
      RelationshipParams,
      ExpectedVersionBody,
      (request, tx) =>
        container.trainees.endRelationship(
          request.ctx,
          request.params.workspaceId,
          request.params.relationshipId,
          request.body,
          tx,
        ),
    ),
  );

  app.post<{
    Params: Static<typeof RelationshipParams>;
    Body: Static<typeof ReactivateRelationshipBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/reactivate',
    relationshipCommand<Static<typeof ReactivateRelationshipBody>>(
      container,
      Permissions.TraineesReactivate,
      'POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/reactivate',
      RelationshipParams,
      ReactivateRelationshipBody,
      (request, tx) =>
        container.trainees.reactivateRelationship(
          request.ctx,
          request.params.workspaceId,
          request.params.relationshipId,
          request.body,
          tx,
        ),
    ),
  );

  app.put<{ Params: Static<typeof RelationshipParams>; Body: Static<typeof HomeBranchBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/home-branch',
    relationshipCommand<Static<typeof HomeBranchBody>>(
      container,
      Permissions.TraineesUpdate,
      'PUT /api/v1/workspaces/:workspaceId/relationships/:relationshipId/home-branch',
      RelationshipParams,
      HomeBranchBody,
      (request, tx) =>
        container.trainees.changeHomeBranch(
          request.ctx,
          request.params.workspaceId,
          request.params.relationshipId,
          request.body,
          tx,
        ),
    ),
  );

  app.put<{ Params: Static<typeof RelationshipParams>; Body: Static<typeof PrimaryTrainerBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/primary-trainer',
    relationshipCommand<Static<typeof PrimaryTrainerBody>>(
      container,
      Permissions.TraineesAssignmentsPrimaryManage,
      'PUT /api/v1/workspaces/:workspaceId/relationships/:relationshipId/primary-trainer',
      RelationshipParams,
      PrimaryTrainerBody,
      (request, tx) =>
        container.trainees.setPrimary(
          request.ctx,
          request.params.workspaceId,
          request.params.relationshipId,
          request.body,
          tx,
        ),
    ),
  );

  app.delete<{
    Params: Static<typeof RelationshipParams>;
    Body: Static<typeof ExpectedVersionBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/primary-trainer',
    relationshipCommand<Static<typeof ExpectedVersionBody>>(
      container,
      Permissions.TraineesAssignmentsPrimaryManage,
      'DELETE /api/v1/workspaces/:workspaceId/relationships/:relationshipId/primary-trainer',
      RelationshipParams,
      ExpectedVersionBody,
      (request, tx) =>
        container.trainees.removePrimary(
          request.ctx,
          request.params.workspaceId,
          request.params.relationshipId,
          request.body,
          tx,
        ),
    ),
  );

  app.post<{ Params: Static<typeof RelationshipParams>; Body: Static<typeof StaffAssignmentBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/assistants',
    relationshipCommand<Static<typeof StaffAssignmentBody>>(
      container,
      Permissions.TraineesAssignmentsAssistantManage,
      'POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/assistants',
      RelationshipParams,
      StaffAssignmentBody,
      (request, tx) =>
        container.trainees.addStaffAssignment(
          request.ctx,
          request.params.workspaceId,
          request.params.relationshipId,
          { ...request.body, assignmentType: 'ASSISTANT_TRAINER' },
          tx,
        ),
    ),
  );

  app.delete<{
    Params: Static<typeof StaffAssignmentParams>;
    Body: Static<typeof ExpectedVersionBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/assistants/:membershipId',
    relationshipCommand<Static<typeof ExpectedVersionBody>>(
      container,
      Permissions.TraineesAssignmentsAssistantManage,
      'DELETE /api/v1/workspaces/:workspaceId/relationships/:relationshipId/assistants/:membershipId',
      StaffAssignmentParams,
      ExpectedVersionBody,
      (request, tx) =>
        container.trainees.removeStaffAssignment(
          request.ctx,
          request.params.workspaceId,
          request.params.relationshipId,
          request.params.membershipId ?? '',
          'ASSISTANT_TRAINER',
          request.body,
          tx,
        ),
    ),
  );

  app.post<{ Params: Static<typeof RelationshipParams>; Body: Static<typeof StaffAssignmentBody> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutritionists',
    relationshipCommand<Static<typeof StaffAssignmentBody>>(
      container,
      Permissions.TraineesAssignmentsNutritionistManage,
      'POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutritionists',
      RelationshipParams,
      StaffAssignmentBody,
      (request, tx) =>
        container.trainees.addStaffAssignment(
          request.ctx,
          request.params.workspaceId,
          request.params.relationshipId,
          { ...request.body, assignmentType: 'NUTRITIONIST' },
          tx,
        ),
    ),
  );

  app.delete<{
    Params: Static<typeof StaffAssignmentParams>;
    Body: Static<typeof ExpectedVersionBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutritionists/:membershipId',
    relationshipCommand<Static<typeof ExpectedVersionBody>>(
      container,
      Permissions.TraineesAssignmentsNutritionistManage,
      'DELETE /api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutritionists/:membershipId',
      StaffAssignmentParams,
      ExpectedVersionBody,
      (request, tx) =>
        container.trainees.removeStaffAssignment(
          request.ctx,
          request.params.workspaceId,
          request.params.relationshipId,
          request.params.membershipId ?? '',
          'NUTRITIONIST',
          request.body,
          tx,
        ),
    ),
  );

  app.post<{ Body: Static<typeof MigrationBody> }>(
    '/api/v1/workspace-migrations/trainees',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Trainees'],
        body: MigrationBody,
        response: { 200: {}, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => {
      const result = await container.idempotency.runInTransaction(request.ctx, {
        key: idempotencyKey(request.headers),
        routeKey: 'POST /api/v1/workspace-migrations/trainees',
        fingerprint: request.body,
        unitOfWork: container.unitOfWork,
        operation: (tx) =>
          container.trainees
            .migrateIndependentToGym(request.ctx, request.body, tx)
            .then((body) => ({ body })),
      });
      return { data: result.body };
    },
  );
}

interface RelationshipCommandRequest<Body> {
  ctx: RequestContext;
  headers: Record<string, unknown>;
  params: { workspaceId: string; relationshipId: string; membershipId?: string };
  body: Body;
}

function relationshipCommand<Body>(
  container: AppContainer,
  permission: string,
  routeKey: string,
  params: unknown,
  body: unknown,
  operation: (
    request: RelationshipCommandRequest<Body>,
    tx: TransactionContext,
  ) => Promise<unknown>,
) {
  return {
    preHandler: [requireAuth(), requireAccess(container, { context: 'WORKSPACE', permission })],
    schema: {
      tags: ['Trainees'],
      params,
      body,
      response: { 200: {}, 403: ErrorResponse, 409: ErrorResponse },
    },
    handler: async (request: RelationshipCommandRequest<Body>) => {
      const result = await container.idempotency.runInTransaction(request.ctx, {
        key: idempotencyKey(request.headers),
        routeKey,
        fingerprint: { params: request.params, body: request.body },
        unitOfWork: container.unitOfWork,
        operation: (tx) => operation(request, tx).then((body) => ({ body })),
      });
      return { data: result.body };
    },
  };
}

void SuccessResponse;
