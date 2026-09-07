import type { Static } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContainer } from '../../bootstrap/app-container';
import { AppError } from '../../core/errors/app-error';
import {
  assertAllowedCookieOrigin,
  clearRefreshCookie,
  readCookie,
  refreshCookieName,
  setRefreshCookie,
} from './auth.cookies';
import {
  AuthTokenResponse,
  ErrorResponse,
  ForgotPasswordBody,
  LoginBody,
  RefreshBody,
  RegisterBody,
  ResendVerificationBody,
  ResetPasswordBody,
  SuccessResponse,
  VerifyBody,
} from './auth.schemas';

export async function registerAuthRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.post<{ Body: Static<typeof RegisterBody> }>(
    '/api/v1/auth/register',
    {
      schema: {
        tags: ['Auth'],
        body: RegisterBody,
        response: {
          201: AuthTokenResponse,
          400: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const result = await container.auth.register({
        ...request.body,
        metadata: metadata(request),
      });
      if (request.body.clientType === 'WEB' && result.refreshToken) {
        setRefreshCookie(reply, container.config, result.refreshToken);
      }
      const { refreshToken: _refreshToken, ...body } = result;
      return reply.status(201).send({
        data: request.body.clientType === 'WEB' ? body : result,
      });
    },
  );

  app.post<{ Body: Static<typeof LoginBody> }>(
    '/api/v1/auth/login',
    {
      schema: {
        tags: ['Auth'],
        body: LoginBody,
        response: { 200: AuthTokenResponse, 401: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (request, reply) => {
      const result = await container.auth.login({
        ...request.body,
        metadata: metadata(request),
      });
      if (request.body.clientType === 'WEB' && result.refreshToken) {
        setRefreshCookie(reply, container.config, result.refreshToken);
      }
      const { refreshToken: _refreshToken, ...body } = result;
      return reply.send({
        data: request.body.clientType === 'WEB' ? body : result,
      });
    },
  );

  app.post<{ Body: Static<typeof RefreshBody> }>(
    '/api/v1/auth/refresh',
    {
      schema: {
        tags: ['Auth'],
        body: RefreshBody,
        response: { 200: AuthTokenResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request, reply) => {
      if (request.body.clientType === 'WEB') {
        assertAllowedCookieOrigin(request, container.config);
      }
      const refreshToken =
        request.body.clientType === 'WEB'
          ? readCookie(request, refreshCookieName)
          : request.body.refreshToken;
      if (!refreshToken) throw invalidRefresh();
      const result = await container.auth.refresh({
        refreshToken,
        clientType: request.body.clientType,
      });
      if (request.body.clientType === 'WEB' && result.refreshToken) {
        setRefreshCookie(reply, container.config, result.refreshToken);
      }
      const { refreshToken: _refreshToken, ...body } = result;
      return reply.send({
        data: request.body.clientType === 'WEB' ? body : result,
      });
    },
  );

  app.post(
    '/api/v1/auth/logout',
    {
      schema: {
        tags: ['Auth'],
        response: { 200: SuccessResponse, 401: ErrorResponse },
      },
    },
    async (request, reply) => {
      if (readCookie(request, refreshCookieName)) {
        assertAllowedCookieOrigin(request, container.config);
        clearRefreshCookie(reply, container.config);
      }
      const result = await container.auth.logout(request.ctx);
      return reply.send({ data: result });
    },
  );

  app.post<{ Body: Static<typeof VerifyBody> }>(
    '/api/v1/auth/verify-email',
    {
      schema: {
        tags: ['Auth'],
        body: VerifyBody,
        response: { 200: SuccessResponse, 401: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.auth.verify({
        purpose: 'EMAIL_VERIFICATION',
        ...request.body,
        ctx: request.ctx,
        metadata: metadata(request),
      }),
    }),
  );

  app.post<{ Body: Static<typeof VerifyBody> }>(
    '/api/v1/auth/verify-phone',
    {
      schema: {
        tags: ['Auth'],
        body: VerifyBody,
        response: { 200: SuccessResponse, 401: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.auth.verify({
        purpose: 'PHONE_VERIFICATION',
        ...request.body,
        ctx: request.ctx,
        metadata: metadata(request),
      }),
    }),
  );

  app.post<{ Body: Static<typeof ResendVerificationBody> }>(
    '/api/v1/auth/resend-verification',
    {
      schema: {
        tags: ['Auth'],
        body: ResendVerificationBody,
        response: { 200: SuccessResponse, 429: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.auth.resendVerification({
        ...request.body,
        metadata: metadata(request),
      }),
    }),
  );

  app.post<{ Body: Static<typeof ForgotPasswordBody> }>(
    '/api/v1/auth/forgot-password',
    {
      schema: {
        tags: ['Auth'],
        body: ForgotPasswordBody,
        response: { 200: SuccessResponse, 429: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.auth.forgotPassword({
        ...request.body,
        metadata: metadata(request),
      }),
    }),
  );

  app.post<{ Body: Static<typeof ResetPasswordBody> }>(
    '/api/v1/auth/reset-password',
    {
      schema: {
        tags: ['Auth'],
        body: ResetPasswordBody,
        response: { 200: SuccessResponse, 401: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => ({
      data: await container.auth.resetPassword({
        ...request.body,
        metadata: metadata(request),
      }),
    }),
  );
}

function metadata(request: FastifyRequest) {
  return {
    ipAddress: request.ctx.ipAddress,
    ...(request.ctx.userAgent ? { userAgent: request.ctx.userAgent } : {}),
  };
}

function invalidRefresh(): AppError {
  return new AppError({
    code: 'REFRESH_TOKEN_INVALID',
    httpStatus: 401,
    message: 'The refresh token is invalid.',
  });
}
