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
import { registerHealthRoutes } from './health.routes';

export async function buildApp(container: AppContainer) {
  const { config } = container;

  const app = Fastify({
    logger: createLoggerOptions(config),
    trustProxy: config.app.trustProxy,
    disableRequestLogging: false,
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
  registerErrorHandler(app);

  await registerHealthRoutes(app, container);

  return app;
}
