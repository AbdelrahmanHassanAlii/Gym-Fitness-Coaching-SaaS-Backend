import { normalizePhoneToE164 } from '../../core/auth/phone-normalizer';
import { AppError } from '../../core/errors/app-error';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(input: string): string {
  const normalized = input.trim().toLowerCase();
  if (!normalized || !emailPattern.test(normalized)) {
    throw new AppError({
      code: 'AUTH_IDENTIFIER_INVALID',
      httpStatus: 422,
      message: 'The email address is invalid.',
    });
  }
  return normalized;
}

export function normalizeLoginIdentifier(input: string): {
  normalizedEmail?: string;
  normalizedPhone?: string;
  rateLimitKey: string;
} {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new AppError({
      code: 'INVALID_CREDENTIALS',
      httpStatus: 401,
      message: 'The supplied credentials are invalid.',
      expose: true,
    });
  }

  if (trimmed.includes('@')) {
    const normalizedEmail = normalizeEmail(trimmed);
    return { normalizedEmail, rateLimitKey: `email:${normalizedEmail}` };
  }

  const normalizedPhone = normalizePhoneToE164(trimmed);
  return { normalizedPhone, rateLimitKey: `phone:${normalizedPhone}` };
}
