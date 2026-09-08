import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import type { AppContainer } from '../../bootstrap/app-container';
import { AppError } from '../../core/errors/app-error';

export async function registerAuthentication(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization;
    if (!header) return;
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw authRequired();
    }

    const payload = container.jwt.verifyAccessToken(token);
    const sessionId = objectId(payload.sid);
    const session = await container.authSessions.findActive(sessionId);
    if (!session || session.userId.toHexString() !== payload.sub) {
      throw authRequired();
    }

    request.ctx.userId = session.userId.toHexString();
    request.ctx.authSessionId = session._id.toHexString();
    request.ctx.authenticationMethods = session.authenticationMethods;
    request.ctx.mfaSatisfied = Boolean(session.mfaSatisfiedAt);
    request.ctx.restrictedUntilVerified = session.restrictedUntilVerified;
  });
}

export function requireAuth(options: { allowRestricted?: boolean } = {}) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!request.ctx.userId || !request.ctx.authSessionId) {
      throw authRequired();
    }
    if (request.ctx.restrictedUntilVerified && !options.allowRestricted) {
      throw new AppError({
        code: 'AUTH_SESSION_RESTRICTED',
        httpStatus: 403,
        message: 'The account must verify a login identifier before continuing.',
      });
    }
  };
}

function objectId(value: string): ObjectId {
  if (!ObjectId.isValid(value)) throw authRequired();
  return new ObjectId(value);
}

function authRequired(): AppError {
  return new AppError({
    code: 'AUTH_REQUIRED',
    httpStatus: 401,
    message: 'Authentication is required.',
  });
}
