import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export async function registerRequestContext(app: FastifyInstance): Promise<void> {
  app.decorateRequest('ctx');

  app.addHook('onRequest', async (request, reply) => {
    const incomingCorrelationId = request.headers['x-correlation-id'];
    const correlationId =
      typeof incomingCorrelationId === 'string' && incomingCorrelationId.length <= 128
        ? incomingCorrelationId
        : randomUUID();

    const userAgent = request.headers['user-agent'];

    request.ctx = {
      correlationId,
      ipAddress: request.ip,
      locale: 'en',
      timezone: 'Africa/Cairo',
      ...(userAgent ? { userAgent } : {}),
    };

    reply.header('x-correlation-id', correlationId);
  });
}
