import { AppError } from '../errors/app-error';

const egyptMobileLocalPattern = /^01[0125]\d{8}$/;
const e164Pattern = /^\+[1-9]\d{7,14}$/;

export function normalizePhoneToE164(input: string, defaultRegion = 'EG'): string {
  const compact = input.replace(/[ \-().]/g, '');

  if (e164Pattern.test(compact)) {
    return compact;
  }

  if (defaultRegion === 'EG') {
    if (egyptMobileLocalPattern.test(compact)) {
      return `+20${compact.slice(1)}`;
    }

    if (/^20\d{10}$/.test(compact)) {
      return `+${compact}`;
    }
  }

  throw new AppError({
    code: 'INVALID_PHONE_NUMBER',
    httpStatus: 422,
    message: 'The phone number is invalid or ambiguous.',
  });
}
