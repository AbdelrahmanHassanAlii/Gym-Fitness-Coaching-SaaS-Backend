import 'fastify';
import type { RequestContext } from './request-context';

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}
