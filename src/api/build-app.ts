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
import { registerAuthentication } from '../modules/auth/auth.middleware';
import { registerAuthRoutes } from '../modules/auth/auth.routes';
import { registerLeadRoutes } from '../modules/leads/lead.routes';
import { registerPermissionRoutes } from '../modules/permissions/permission.routes';
import { registerSubscriptionRoutes } from '../modules/subscriptions/subscription.routes';
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
        title: 'Gym Platform API',
        version: '0.1.0',
        description: 'V1 backend foundation for the multi-tenant Gym/Fitness Coaching SaaS.',
      },
      servers: [{ url: '/' }],
      tags: [{ name: 'Health' }],
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

  return app;
}
