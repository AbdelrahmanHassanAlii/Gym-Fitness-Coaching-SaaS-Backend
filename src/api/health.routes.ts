import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { AppContainer } from '../bootstrap/app-container';

const HealthResponse = Type.Object({
  data: Type.Object({
    status: Type.Union([Type.Literal('ok'), Type.Literal('not_ready')]),
  }),
});

export async function registerHealthRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.get(
    '/health/live',
    {
      schema: {
        tags: ['Health'],
        response: { 200: HealthResponse },
      },
    },
    async () => ({ data: { status: 'ok' as const } }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['Health'],
        response: {
          200: HealthResponse,
          503: HealthResponse,
        },
      },
    },
    async (_request, reply) => {
      try {
        const ready = await container.database.ping();
        if (!ready) {
          return reply.status(503).send({ data: { status: 'not_ready' as const } });
        }
        return reply.status(200).send({ data: { status: 'ok' as const } });
      } catch {
        return reply.status(503).send({ data: { status: 'not_ready' as const } });
      }
    },
  );
}
