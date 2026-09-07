import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/config.types';
import { AppError } from '../../core/errors/app-error';

export const refreshCookieName = '__Secure-gym_refresh';
const refreshCookiePath = '/api/v1/auth';

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [key, ...valueParts] = part.trim().split('=');
    if (key === name) return decodeURIComponent(valueParts.join('='));
  }
  return undefined;
}

export function setRefreshCookie(
  reply: FastifyReply,
  config: AppConfig,
  refreshToken: string,
): void {
  reply.header(
    'set-cookie',
    serializeCookie(refreshCookieName, refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: config.auth.webRefreshCookieSameSite,
      path: refreshCookiePath,
      maxAge: config.auth.refreshTokenTtlSeconds,
    }),
  );
}

export function clearRefreshCookie(reply: FastifyReply, config: AppConfig): void {
  reply.header(
    'set-cookie',
    serializeCookie(refreshCookieName, '', {
      httpOnly: true,
      secure: true,
      sameSite: config.auth.webRefreshCookieSameSite,
      path: refreshCookiePath,
      maxAge: 0,
    }),
  );
}

export function assertAllowedCookieOrigin(request: FastifyRequest, config: AppConfig): void {
  const origin = request.headers.origin;
  if (!origin) {
    if (config.env === 'production') {
      throw new AppError({
        code: 'AUTH_ORIGIN_REQUIRED',
        httpStatus: 403,
        message: 'A valid Origin header is required.',
      });
    }
    return;
  }

  if (!config.app.allowedOrigins.includes(origin)) {
    throw new AppError({
      code: 'AUTH_ORIGIN_DENIED',
      httpStatus: 403,
      message: 'The request origin is not allowed.',
    });
  }
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'LAX' | 'STRICT' | 'NONE';
    path: string;
    maxAge: number;
  },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
    `SameSite=${formatSameSite(options.sameSite)}`,
    options.httpOnly ? 'HttpOnly' : '',
    options.secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function formatSameSite(value: 'LAX' | 'STRICT' | 'NONE'): string {
  if (value === 'LAX') return 'Lax';
  if (value === 'STRICT') return 'Strict';
  return 'None';
}
