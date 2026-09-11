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
  ActivateNutritionPlanBody,
  CreateNutritionPlanBody,
  CreateNutritionPlanRevisionBody,
  ErrorResponse,
  ExpectedVersionBody,
  FoodBody,
  FoodParams,
  FoodPatchBody,
  ListQuery,
  NutritionPlanParams,
  PlatformFoodBody,
  PlatformFoodParams,
  RelationshipParams,
  WorkspaceParams,
} from './nutrition.schemas';

export async function registerNutritionRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.get<{ Params: Static<typeof WorkspaceParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/foods',
    workspaceOptions(container, Permissions.FoodsRead, {
      params: WorkspaceParams,
      querystring: ListQuery,
    }),
    async (request) =>
      await container.nutrition.listFoods(request.ctx, request.params.workspaceId, request.query),
  );

  app.post<{ Params: Static<typeof WorkspaceParams>; Body: Static<typeof FoodBody> }>(
    '/api/v1/workspaces/:workspaceId/foods',
    workspaceOptions(container, Permissions.FoodsCreate, {
      params: WorkspaceParams,
      body: FoodBody,
    }),
    async (request, reply) => {
      const data = await container.nutrition.createFood(
        request.ctx,
        request.params.workspaceId,
        request.body,
      );
      return reply.status(201).send({ data });
    },
  );

  app.patch<{ Params: Static<typeof FoodParams>; Body: Static<typeof FoodPatchBody> }>(
    '/api/v1/workspaces/:workspaceId/foods/:foodId',
    workspaceOptions(container, Permissions.FoodsUpdate, {
      params: FoodParams,
      body: FoodPatchBody,
    }),
    async (request) => ({
      data: await container.nutrition.updateFood(
        request.ctx,
        request.params.workspaceId,
        request.params.foodId,
        request.body,
      ),
    }),
  );

  app.post<{ Params: Static<typeof FoodParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/workspaces/:workspaceId/foods/:foodId/archive',
    workspaceOptions(container, Permissions.FoodsArchive, {
      params: FoodParams,
      body: ExpectedVersionBody,
    }),
    async (request) => ({
      data: await container.nutrition.archiveFood(
        request.ctx,
        request.params.workspaceId,
        request.params.foodId,
        request.body,
      ),
    }),
  );

  app.get<{ Querystring: Static<typeof ListQuery> }>(
    '/api/v1/platform/foods',
    platformOptions(container, Permissions.SystemFoodsRead, { querystring: ListQuery }),
    async (request) => await container.nutrition.listPlatformFoods(request.ctx, request.query),
  );

  app.post<{ Body: Static<typeof PlatformFoodBody> }>(
    '/api/v1/platform/foods',
    platformOptions(container, Permissions.SystemFoodsCreate, { body: PlatformFoodBody }),
    async (request, reply) => {
      const data = await container.nutrition.createPlatformFood(request.ctx, request.body);
      return reply.status(201).send({ data });
    },
  );

  app.patch<{ Params: Static<typeof PlatformFoodParams>; Body: Static<typeof FoodPatchBody> }>(
    '/api/v1/platform/foods/:foodId',
    platformOptions(container, Permissions.SystemFoodsUpdate, {
      params: PlatformFoodParams,
      body: FoodPatchBody,
    }),
    async (request) => ({
      data: await container.nutrition.updateFood(
        request.ctx,
        undefined,
        request.params.foodId,
        request.body,
        true,
      ),
    }),
  );

  app.post<{ Params: Static<typeof PlatformFoodParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/platform/foods/:foodId/archive',
    platformOptions(container, Permissions.SystemFoodsArchive, {
      params: PlatformFoodParams,
      body: ExpectedVersionBody,
    }),
    async (request) => ({
      data: await container.nutrition.archiveFood(
        request.ctx,
        undefined,
        request.params.foodId,
        request.body,
        true,
      ),
    }),
  );

  app.get<{ Params: Static<typeof RelationshipParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans',
    workspaceOptions(container, Permissions.NutritionPlansRead, {
      params: RelationshipParams,
      querystring: ListQuery,
    }),
    async (request) =>
      await container.nutrition.listPlans(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
  );

  app.post<{
    Params: Static<typeof RelationshipParams>;
    Body: Static<typeof CreateNutritionPlanBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans',
    workspaceOptions(container, Permissions.NutritionPlansCreate, {
      params: RelationshipParams,
      body: CreateNutritionPlanBody,
    }),
    async (request, reply) => {
      const data = await container.nutrition.createPlan(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.body,
      );
      return reply.status(201).send({ data });
    },
  );

  app.get<{ Params: Static<typeof NutritionPlanParams> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans/:planId',
    workspaceOptions(container, Permissions.NutritionPlansRead, { params: NutritionPlanParams }),
    async (request) => ({
      data: await container.nutrition.getPlan(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.planId,
      ),
    }),
  );

  app.post<{
    Params: Static<typeof NutritionPlanParams>;
    Body: Static<typeof CreateNutritionPlanRevisionBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans/:planId/revisions',
    workspaceOptions(container, Permissions.NutritionPlansUpdate, {
      params: NutritionPlanParams,
      body: CreateNutritionPlanRevisionBody,
    }),
    async (request) => ({
      data: await container.nutrition.createRevision(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.planId,
        request.body,
      ),
    }),
  );

  app.post<{
    Params: Static<typeof NutritionPlanParams>;
    Body: Static<typeof ActivateNutritionPlanBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans/:planId/activate',
    workspaceOptions(container, Permissions.NutritionPlansActivate, {
      params: NutritionPlanParams,
      body: ActivateNutritionPlanBody,
    }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request,
        'POST /workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans/:planId/activate',
        (tx) =>
          container.nutrition.activatePlan(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            request.params.planId,
            request.body,
            tx,
          ),
      ),
  );

  app.post<{
    Params: Static<typeof NutritionPlanParams>;
    Body: Static<typeof ExpectedVersionBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans/:planId/complete',
    workspaceOptions(container, Permissions.NutritionPlansComplete, {
      params: NutritionPlanParams,
      body: ExpectedVersionBody,
    }),
    async (request) => ({
      data: await container.nutrition.completePlan(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.planId,
        request.body,
      ),
    }),
  );

  app.post<{
    Params: Static<typeof NutritionPlanParams>;
    Body: Static<typeof ExpectedVersionBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans/:planId/archive',
    workspaceOptions(container, Permissions.NutritionPlansArchive, {
      params: NutritionPlanParams,
      body: ExpectedVersionBody,
    }),
    async (request) => ({
      data: await container.nutrition.archivePlan(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.planId,
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
      tags: ['Nutrition'],
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
      tags: ['Nutrition'],
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
