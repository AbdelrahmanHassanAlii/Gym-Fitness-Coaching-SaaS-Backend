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
  ApprovePaymentBody,
  ArchivePlanBody,
  ChangeTermsBody,
  CreateManualPaymentBody,
  CreatePlanBody,
  CreatePlanVersionBody,
  ErrorResponse,
  PaymentParams,
  PlanParams,
  RejectPaymentBody,
  StartTrialBody,
  TransitionSubscriptionBody,
  UpdatePlanBody,
  WorkspaceParams,
} from './subscription.schemas';

export async function registerSubscriptionRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.get<{ Params: Static<typeof WorkspaceParams> }>(
    '/api/v1/workspaces/:workspaceId/subscription',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.BillingSubscriptionRead,
        }),
      ],
      schema: {
        tags: ['Subscriptions'],
        params: WorkspaceParams,
        response: { 200: {}, 403: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.subscriptions.getWorkspaceSubscription(
        request.ctx,
        request.params.workspaceId,
      ),
    }),
  );

  app.get<{ Params: Static<typeof WorkspaceParams> }>(
    '/api/v1/workspaces/:workspaceId/subscription/usage',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.BillingUsageRead,
        }),
      ],
      schema: {
        tags: ['Subscriptions'],
        params: WorkspaceParams,
        response: { 200: {}, 403: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.subscriptions.getWorkspaceUsage(
        request.ctx,
        request.params.workspaceId,
      ),
    }),
  );

  app.post<{
    Params: Static<typeof WorkspaceParams>;
    Body: Static<typeof CreateManualPaymentBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/payments',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.BillingPaymentsCreate,
        }),
      ],
      schema: {
        tags: ['Payments'],
        params: WorkspaceParams,
        body: CreateManualPaymentBody,
        response: { 201: {}, 400: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request, reply) => {
      const result = await container.idempotency.runInTransaction(request.ctx, {
        routeKey: 'POST /workspaces/:workspaceId/payments',
        key: idempotencyKey(request.headers),
        fingerprint: { params: request.params, body: request.body },
        unitOfWork: container.unitOfWork,
        operation: async (tx) => ({
          statusCode: 201,
          body: await container.subscriptions.createManualPayment(
            request.ctx,
            request.params.workspaceId,
            request.body,
            tx,
          ),
        }),
      });
      return reply.status(result.statusCode).send({ data: result.body });
    },
  );

  app.get<{ Params: Static<typeof WorkspaceParams> }>(
    '/api/v1/workspaces/:workspaceId/payments',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'WORKSPACE',
          permission: Permissions.BillingPaymentsRead,
        }),
      ],
      schema: {
        tags: ['Payments'],
        params: WorkspaceParams,
        response: { 200: {}, 403: ErrorResponse },
      },
    },
    async (request) =>
      await container.subscriptions.listWorkspacePayments(request.ctx, request.params.workspaceId),
  );

  app.get(
    '/api/v1/platform/subscription-plans',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'PLATFORM', permission: Permissions.PlansRead }),
      ],
      schema: { tags: ['Subscriptions'], response: { 200: {}, 403: ErrorResponse } },
    },
    async (request) => await container.subscriptions.listPlans(request.ctx),
  );

  app.post<{ Body: Static<typeof CreatePlanBody> }>(
    '/api/v1/platform/subscription-plans',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'PLATFORM', permission: Permissions.PlansCreate }),
      ],
      schema: {
        tags: ['Subscriptions'],
        body: CreatePlanBody,
        response: { 201: {}, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const result = await container.idempotency.runInTransaction(request.ctx, {
        routeKey: 'POST /platform/subscription-plans',
        key: idempotencyKey(request.headers),
        fingerprint: { body: request.body },
        unitOfWork: container.unitOfWork,
        operation: async (tx) => ({
          statusCode: 201,
          body: await container.subscriptions.createPlan(request.ctx, request.body, tx),
        }),
      });
      return reply.status(result.statusCode).send({ data: result.body });
    },
  );

  app.get<{ Params: Static<typeof PlanParams> }>(
    '/api/v1/platform/subscription-plans/:planId',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'PLATFORM', permission: Permissions.PlansRead }),
      ],
      schema: {
        tags: ['Subscriptions'],
        params: PlanParams,
        response: { 200: {}, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.subscriptions.getPlan(request.ctx, request.params.planId),
    }),
  );

  app.patch<{ Params: Static<typeof PlanParams>; Body: Static<typeof UpdatePlanBody> }>(
    '/api/v1/platform/subscription-plans/:planId',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'PLATFORM', permission: Permissions.PlansUpdate }),
      ],
      schema: {
        tags: ['Subscriptions'],
        params: PlanParams,
        body: UpdatePlanBody,
        response: { 200: {}, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.subscriptions.updatePlan(
        request.ctx,
        request.params.planId,
        request.body,
      ),
    }),
  );

  app.post<{ Params: Static<typeof PlanParams>; Body: Static<typeof CreatePlanVersionBody> }>(
    '/api/v1/platform/subscription-plans/:planId/versions',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'PLATFORM',
          permission: Permissions.PlansVersionsCreate,
        }),
      ],
      schema: {
        tags: ['Subscriptions'],
        params: PlanParams,
        body: CreatePlanVersionBody,
        response: { 201: {}, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const result = await container.idempotency.runInTransaction(request.ctx, {
        routeKey: 'POST /platform/subscription-plans/:planId/versions',
        key: idempotencyKey(request.headers),
        fingerprint: { params: request.params, body: request.body },
        unitOfWork: container.unitOfWork,
        operation: async (tx) => ({
          statusCode: 201,
          body: await container.subscriptions.createPlanVersion(
            request.ctx,
            request.params.planId,
            request.body,
            tx,
          ),
        }),
      });
      return reply.status(result.statusCode).send({ data: result.body });
    },
  );

  app.post<{ Params: Static<typeof PlanParams>; Body: Static<typeof ArchivePlanBody> }>(
    '/api/v1/platform/subscription-plans/:planId/archive',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'PLATFORM', permission: Permissions.PlansArchive }),
      ],
      schema: {
        tags: ['Subscriptions'],
        params: PlanParams,
        body: ArchivePlanBody,
        response: { 200: {}, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.subscriptions.archivePlan(
        request.ctx,
        request.params.planId,
        request.body.expectedVersion,
      ),
    }),
  );

  app.get<{ Params: Static<typeof WorkspaceParams> }>(
    '/api/v1/platform/workspaces/:workspaceId/subscription',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, {
          context: 'PLATFORM',
          permission: Permissions.SubscriptionsRead,
        }),
      ],
      schema: {
        tags: ['Subscriptions'],
        params: WorkspaceParams,
        response: { 200: {}, 403: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.subscriptions.getPlatformSubscription(
        request.ctx,
        request.params.workspaceId,
      ),
    }),
  );

  app.post<{ Params: Static<typeof WorkspaceParams>; Body: Static<typeof StartTrialBody> }>(
    '/api/v1/platform/workspaces/:workspaceId/subscription/start-trial',
    commandOptions(container, Permissions.SubscriptionsStartTrial, StartTrialBody),
    async (request, reply) =>
      await idempotent(reply, container, request, 'start-trial', (tx) =>
        container.subscriptions.startTrial(
          request.ctx,
          request.params.workspaceId,
          request.body,
          tx,
        ),
      ),
  );

  for (const command of ['upgrade', 'downgrade'] as const) {
    app.post<{ Params: Static<typeof WorkspaceParams>; Body: Static<typeof ChangeTermsBody> }>(
      `/api/v1/platform/workspaces/:workspaceId/subscription/${command}`,
      commandOptions(container, Permissions.SubscriptionsChangePlan, ChangeTermsBody),
      async (request, reply) =>
        await idempotent(reply, container, request, command, (tx) =>
          container.subscriptions.changePlan(
            request.ctx,
            request.params.workspaceId,
            request.body,
            command === 'upgrade' ? 'UPGRADE' : 'DOWNGRADE',
            tx,
          ),
        ),
    );
  }

  app.post<{
    Params: Static<typeof WorkspaceParams>;
    Body: Static<typeof TransitionSubscriptionBody>;
  }>(
    '/api/v1/platform/workspaces/:workspaceId/subscription/freeze',
    commandOptions(container, Permissions.SubscriptionsFreeze, TransitionSubscriptionBody),
    async (request, reply) =>
      await idempotent(reply, container, request, 'freeze', (tx) =>
        container.subscriptions.freeze(request.ctx, request.params.workspaceId, request.body, tx),
      ),
  );

  app.post<{ Params: Static<typeof WorkspaceParams>; Body: Static<typeof ChangeTermsBody> }>(
    '/api/v1/platform/workspaces/:workspaceId/subscription/reactivate',
    commandOptions(container, Permissions.SubscriptionsReactivate, ChangeTermsBody),
    async (request, reply) =>
      await idempotent(reply, container, request, 'reactivate', (tx) =>
        container.subscriptions.reactivate(
          request.ctx,
          request.params.workspaceId,
          request.body,
          tx,
        ),
      ),
  );

  app.post<{
    Params: Static<typeof WorkspaceParams>;
    Body: Static<typeof TransitionSubscriptionBody>;
  }>(
    '/api/v1/platform/workspaces/:workspaceId/subscription/cancel',
    commandOptions(container, Permissions.SubscriptionsCancel, TransitionSubscriptionBody),
    async (request, reply) =>
      await idempotent(reply, container, request, 'cancel', (tx) =>
        container.subscriptions.cancel(request.ctx, request.params.workspaceId, request.body, tx),
      ),
  );

  app.get(
    '/api/v1/platform/payments',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'PLATFORM', permission: Permissions.PaymentsRead }),
      ],
      schema: { tags: ['Payments'], response: { 200: {}, 403: ErrorResponse } },
    },
    async (request) => await container.subscriptions.listPlatformPayments(request.ctx),
  );

  app.get<{ Params: Static<typeof PaymentParams> }>(
    '/api/v1/platform/payments/:paymentId',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'PLATFORM', permission: Permissions.PaymentsRead }),
      ],
      schema: {
        tags: ['Payments'],
        params: PaymentParams,
        response: { 200: {}, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.subscriptions.getPlatformPayment(request.ctx, request.params.paymentId),
    }),
  );

  app.post<{ Params: Static<typeof PaymentParams>; Body: Static<typeof ApprovePaymentBody> }>(
    '/api/v1/platform/payments/:paymentId/approve',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'PLATFORM', permission: Permissions.PaymentsApprove }),
      ],
      schema: {
        tags: ['Payments'],
        params: PaymentParams,
        body: ApprovePaymentBody,
        response: { 200: {}, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) =>
      await idempotent(reply, container, request, 'approve-payment', (tx) =>
        container.subscriptions.approvePayment(
          request.ctx,
          request.params.paymentId,
          request.body,
          tx,
        ),
      ),
  );

  app.post<{ Params: Static<typeof PaymentParams>; Body: Static<typeof RejectPaymentBody> }>(
    '/api/v1/platform/payments/:paymentId/reject',
    {
      preHandler: [
        requireAuth(),
        requireAccess(container, { context: 'PLATFORM', permission: Permissions.PaymentsReject }),
      ],
      schema: {
        tags: ['Payments'],
        params: PaymentParams,
        body: RejectPaymentBody,
        response: { 200: {}, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) =>
      await idempotent(reply, container, request, 'reject-payment', (tx) =>
        container.subscriptions.rejectPayment(
          request.ctx,
          request.params.paymentId,
          request.body,
          tx,
        ),
      ),
  );
}

function commandOptions(container: AppContainer, permission: string, body: unknown) {
  return {
    preHandler: [requireAuth(), requireAccess(container, { context: 'PLATFORM', permission })],
    schema: {
      tags: ['Subscriptions'],
      params: WorkspaceParams,
      body,
      response: { 200: {}, 403: ErrorResponse, 409: ErrorResponse },
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
  command: string,
  operation: (tx: TransactionContext) => Promise<unknown>,
) {
  const result = await container.idempotency.runInTransaction(request.ctx, {
    routeKey: `POST /platform/subscription/${command}`,
    key: idempotencyKey(request.headers),
    fingerprint: { params: request.params, body: request.body },
    unitOfWork: container.unitOfWork,
    operation: async (tx) => ({ body: await operation(tx) }),
  });
  return reply.status(result.statusCode).send({ data: result.body });
}
