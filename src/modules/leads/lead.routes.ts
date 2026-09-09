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
  CompleteOwnerActivationBody,
  ConvertLeadBody,
  ErrorResponse,
  LeadListQuery,
  LeadParams,
  LeadStatusBody,
  MarkDuplicateBody,
  MergeLeadBody,
  PublicCreateLeadBody,
  ReissueOwnerActivationBody,
  UpdateLeadBody,
} from './lead.schemas';

export async function registerLeadRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.post<{ Body: Static<typeof PublicCreateLeadBody> }>(
    '/api/v1/public/leads',
    {
      schema: {
        tags: ['Leads'],
        body: PublicCreateLeadBody,
        response: { 201: {}, 400: ErrorResponse, 422: ErrorResponse },
      },
    },
    async (request, reply) => {
      const data = await container.leads.createPublicLead(request.ctx, request.body);
      return reply.status(201).send({ data });
    },
  );

  app.get<{ Querystring: Static<typeof LeadListQuery> }>(
    '/api/v1/platform/leads',
    platformOptions(container, Permissions.LeadsRead, { querystring: LeadListQuery }),
    async (request) => await container.leads.listLeads(request.query),
  );

  app.get<{ Params: Static<typeof LeadParams> }>(
    '/api/v1/platform/leads/:leadId',
    platformOptions(container, Permissions.LeadsRead, { params: LeadParams }),
    async (request) => ({ data: await container.leads.getLead(request.params.leadId) }),
  );

  app.patch<{ Params: Static<typeof LeadParams>; Body: Static<typeof UpdateLeadBody> }>(
    '/api/v1/platform/leads/:leadId',
    platformOptions(container, Permissions.LeadsUpdate, {
      params: LeadParams,
      body: UpdateLeadBody,
    }),
    async (request) => ({
      data: await container.leads.updateLead(request.ctx, request.params.leadId, request.body),
    }),
  );

  app.post<{ Params: Static<typeof LeadParams>; Body: Static<typeof LeadStatusBody> }>(
    '/api/v1/platform/leads/:leadId/status',
    platformOptions(container, Permissions.LeadsUpdate, {
      params: LeadParams,
      body: LeadStatusBody,
    }),
    async (request) => ({
      data: await container.leads.changeStatus(request.ctx, request.params.leadId, request.body),
    }),
  );

  app.post<{ Params: Static<typeof LeadParams>; Body: Static<typeof ConvertLeadBody> }>(
    '/api/v1/platform/leads/:leadId/convert',
    platformOptions(container, Permissions.LeadsConvert, {
      params: LeadParams,
      body: ConvertLeadBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /platform/leads/:leadId/convert',
        (tx) => container.leads.convert(request.ctx, request.params.leadId, request.body, tx),
        redactOwnerInvitationToken,
      ),
  );

  app.post<{
    Params: Static<typeof LeadParams>;
    Body: Static<typeof ReissueOwnerActivationBody>;
  }>(
    '/api/v1/platform/leads/:leadId/owner-activation/reissue',
    platformOptions(container, Permissions.LeadsConvert, {
      params: LeadParams,
      body: ReissueOwnerActivationBody,
    }),
    async (request) => ({
      data: await container.leads.reissueOwnerActivation(request.ctx, request.params.leadId),
    }),
  );

  app.post<{ Params: Static<typeof LeadParams>; Body: Static<typeof MarkDuplicateBody> }>(
    '/api/v1/platform/leads/:leadId/mark-duplicate',
    platformOptions(container, Permissions.LeadsMarkDuplicate, {
      params: LeadParams,
      body: MarkDuplicateBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /platform/leads/:leadId/mark-duplicate',
        (tx) => container.leads.markDuplicate(request.ctx, request.params.leadId, request.body, tx),
      ),
  );

  app.post<{ Params: Static<typeof LeadParams>; Body: Static<typeof MergeLeadBody> }>(
    '/api/v1/platform/leads/:leadId/merge',
    platformOptions(container, Permissions.LeadsMerge, { params: LeadParams, body: MergeLeadBody }),
    async (request, reply) =>
      await idempotent(reply, container, request, 'POST /platform/leads/:leadId/merge', (tx) =>
        container.leads.merge(request.ctx, request.params.leadId, request.body, tx),
      ),
  );

  app.post<{ Body: Static<typeof CompleteOwnerActivationBody> }>(
    '/api/v1/public/owner-activations/complete',
    {
      schema: {
        tags: ['Owner activations'],
        body: CompleteOwnerActivationBody,
        response: { 200: {}, 400: ErrorResponse, 401: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const actorId = `owner-activation:${container.credentialDigests.hashHighEntropySecret(
        request.body.token,
      )}`;
      const result = await container.idempotency.runInTransactionForActor(actorId, {
        routeKey: 'POST /public/owner-activations/complete',
        key: idempotencyKey(request.headers),
        fingerprint: { body: request.body },
        unitOfWork: container.unitOfWork,
        operation: async (tx) => ({
          body: await container.leads.completeOwnerActivation(
            request.ctx,
            request.body,
            metadata(request),
            tx,
          ),
        }),
      });
      return reply.status(result.statusCode).send({ data: result.body });
    },
  );
}

function platformOptions(
  container: AppContainer,
  permission: string,
  schema: Record<string, unknown>,
) {
  return {
    preHandler: [requireAuth(), requireAccess(container, { context: 'PLATFORM', permission })],
    schema: {
      tags: ['Leads'],
      ...schema,
      response: { 200: {}, 201: {}, 400: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
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
  storedBody?: (body: unknown) => unknown,
) {
  const result = await container.idempotency.runInTransaction(request.ctx, {
    routeKey,
    key: idempotencyKey(request.headers),
    fingerprint: { params: request.params, body: request.body },
    unitOfWork: container.unitOfWork,
    operation: async (tx) => {
      const body = await operation(tx);
      return { body, ...(storedBody ? { storedBody: storedBody(body) } : {}) };
    },
  });
  return reply.status(result.statusCode).send({ data: result.body });
}

function redactOwnerInvitationToken(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const record = body as Record<string, unknown>;
  const ownerInvitation =
    record.ownerInvitation && typeof record.ownerInvitation === 'object'
      ? { ...(record.ownerInvitation as Record<string, unknown>) }
      : undefined;
  if (ownerInvitation) delete ownerInvitation.token;
  return { ...record, ...(ownerInvitation ? { ownerInvitation } : {}) };
}

function metadata(request: { ip: string; headers: Record<string, unknown> }) {
  const userAgent =
    typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined;
  return {
    ipAddress: request.ip,
    ...(userAgent ? { userAgent } : {}),
  };
}
