import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import type { AppContainer } from '../bootstrap/app-container';
import { registerErrorHandler } from '../core/errors/error-handler';
import { createLoggerOptions } from '../core/logging/logger';
import { registerRequestContext } from '../core/request-context/request-context.plugin';
import { registerAuditRoutes } from '../modules/audit/audit.routes';
import { registerAuthentication } from '../modules/auth/auth.middleware';
import { registerAuthRoutes } from '../modules/auth/auth.routes';
import { registerCheckInRoutes } from '../modules/checkins/checkin.routes';
import { registerFileRoutes } from '../modules/files/file.routes';
import { registerLeadRoutes } from '../modules/leads/lead.routes';
import { registerNotificationRoutes } from '../modules/notifications/notification.routes';
import { registerNutritionRoutes } from '../modules/nutrition/nutrition.routes';
import { registerPermissionRoutes } from '../modules/permissions/permission.routes';
import { registerProgressRoutes } from '../modules/progress/progress.routes';
import { registerSubscriptionRoutes } from '../modules/subscriptions/subscription.routes';
import {
  registerSupportAccessContext,
  registerSupportAccessRoutes,
} from '../modules/support-access/support-access.routes';
import { registerTraineeRoutes } from '../modules/trainees/trainee.routes';
import { registerTrainingRoutes } from '../modules/training/training.routes';
import { registerWorkoutRoutes } from '../modules/workouts/workout.routes';
import { registerWorkspaceRoutes } from '../modules/workspaces/workspace.routes';
import { registerHealthRoutes } from './health.routes';

export async function buildApp(container: AppContainer) {
  const { config } = container;

  const app = Fastify({
    logger: createLoggerOptions(config),
    trustProxy: config.app.trustProxy,
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  });

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (config.env !== 'production' && config.app.allowedOrigins.length === 0) {
        return callback(null, true);
      }
      return callback(null, config.app.allowedOrigins.includes(origin));
    },
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Gym & Fitness Coaching SaaS API',
        version: '0.1.0',
        description: 'V1 backend foundation for the multi-tenant Gym/Fitness Coaching SaaS.',
      },
      servers: [{ url: process.env.OPENAPI_SERVER_URL?.trim() || 'http://localhost:3000' }],
      tags: [
        { name: 'Health' },
        { name: 'Auth' },
        { name: 'Me' },
        { name: 'Platform' },
        { name: 'Workspaces' },
        { name: 'Branches' },
        { name: 'Memberships' },
        { name: 'Invitations' },
        { name: 'Permissions' },
        { name: 'Subscriptions' },
        { name: 'Payments' },
        { name: 'Leads' },
        { name: 'Owner activations' },
        { name: 'Trainees' },
        { name: 'Training' },
        { name: 'Workouts' },
        { name: 'Nutrition' },
        { name: 'Progress' },
        { name: 'Check-Ins' },
        { name: 'Files' },
        { name: 'Notifications' },
        { name: 'Support' },
        { name: 'Audit' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Use the access token returned by the Auth endpoints. In Apidog, store it as an environment/global variable such as accessToken and send it as a Bearer token.',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  if (config.app.docsEnabled) {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    });
  }

  await registerRequestContext(app);
  await registerAuthentication(app, container);
  await registerSupportAccessContext(app, container);
  registerErrorHandler(app);

  await registerHealthRoutes(app, container);
  await registerAuthRoutes(app, container);
  await registerWorkspaceRoutes(app, container);
  await registerPermissionRoutes(app, container);
  await registerSubscriptionRoutes(app, container);
  await registerLeadRoutes(app, container);
  await registerTraineeRoutes(app, container);
  await registerTrainingRoutes(app, container);
  await registerWorkoutRoutes(app, container);
  await registerNutritionRoutes(app, container);
  await registerProgressRoutes(app, container);
  await registerCheckInRoutes(app, container);
  await registerFileRoutes(app, container);
  await registerNotificationRoutes(app, container);
  await registerSupportAccessRoutes(app, container);
  await registerAuditRoutes(app, container);

  return app;
}
