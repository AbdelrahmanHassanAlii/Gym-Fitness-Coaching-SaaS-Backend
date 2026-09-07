import type { FastifyError, FastifyInstance } from 'fastify';
import { AppError } from './app-error';

interface FastifyValidationError extends FastifyError {
  validation?: unknown;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyValidationError, request, reply) => {
    if (error instanceof AppError) {
      request.log.warn(
        { code: error.code, details: error.details },
        'Application request rejected',
      );
      return reply.status(error.httpStatus).send({
        error: {
          code: error.code,
          message: error.expose ? error.message : 'Request failed',
          ...(error.details ? { details: error.details } : {}),
          correlationId: request.ctx.correlationId,
        },
      });
    }

    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request payload or parameters are invalid.',
          details: { validation: error.validation },
          correlationId: request.ctx.correlationId,
        },
      });
    }

    request.log.error({ err: error }, 'Unhandled request error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        correlationId: request.ctx.correlationId,
      },
    });
  });
}
