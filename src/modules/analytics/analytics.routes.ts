import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { AppContainer } from '../../bootstrap/app-container';
import { requireAuth } from '../auth/auth.middleware';
import {
  AnalyticsQuery,
  DashboardQuery,
  ErrorResponse,
  ProgressAnalyticsQuery,
  RelationshipParams,
  TrainerDashboardQuery,
  WorkspaceParams,
} from './analytics.schemas';

export async function registerAnalyticsRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.get<{
    Params: Static<typeof WorkspaceParams>;
    Querystring: Static<typeof TrainerDashboardQuery>;
  }>(
    '/api/v1/workspaces/:workspaceId/dashboard/trainer',
    options({ params: WorkspaceParams, querystring: TrainerDashboardQuery }),
    async (request) => ({
      data: await container.analytics.trainerDashboard(
        request.ctx,
        request.params.workspaceId,
        request.query,
      ),
    }),
  );

  app.get<{ Params: Static<typeof WorkspaceParams>; Querystring: Static<typeof DashboardQuery> }>(
    '/api/v1/workspaces/:workspaceId/dashboard/gym',
    options({ params: WorkspaceParams, querystring: DashboardQuery }),
    async (request) => ({
      data: await container.analytics.gymDashboard(
        request.ctx,
        request.params.workspaceId,
        request.query,
      ),
    }),
  );

  app.get<{ Params: Static<typeof RelationshipParams> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/dashboard',
    options({ params: RelationshipParams }),
    async (request) => ({
      data: await container.analytics.relationshipDashboard(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
      ),
    }),
  );

  app.get<{
    Params: Static<typeof RelationshipParams>;
    Querystring: Static<typeof AnalyticsQuery>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/analytics/training',
    options({ params: RelationshipParams, querystring: AnalyticsQuery }),
    async (request) => ({
      data: await container.analytics.trainingAnalytics(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
    }),
  );

  app.get<{
    Params: Static<typeof RelationshipParams>;
    Querystring: Static<typeof ProgressAnalyticsQuery>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/analytics/progress',
    options({ params: RelationshipParams, querystring: ProgressAnalyticsQuery }),
    async (request) => ({
      data: await container.analytics.progressAnalytics(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
    }),
  );

  app.get<{
    Params: Static<typeof RelationshipParams>;
    Querystring: Static<typeof AnalyticsQuery>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/analytics/nutrition',
    options({ params: RelationshipParams, querystring: AnalyticsQuery }),
    async (request) => ({
      data: await container.analytics.nutritionAnalytics(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
    }),
  );

  app.get<{
    Params: Static<typeof RelationshipParams>;
    Querystring: Static<typeof AnalyticsQuery>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/analytics/adherence',
    options({ params: RelationshipParams, querystring: AnalyticsQuery }),
    async (request) => ({
      data: await container.analytics.adherenceAnalytics(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
    }),
  );
}

function options(schema: Record<string, unknown>) {
  return {
    preHandler: [requireAuth()],
    schema: {
      tags: ['Analytics'],
      ...schema,
      response: { 200: {}, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    },
  };
}
