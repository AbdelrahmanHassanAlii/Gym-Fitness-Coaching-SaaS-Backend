import { describe, expect, test } from 'bun:test';
import { AppError } from '../src/core/errors/app-error';

describe('AppError', () => {
  test('retains stable API metadata', () => {
    const error = new AppError({
      code: 'TEST_ERROR',
      httpStatus: 409,
      message: 'Conflict',
      details: { resource: 'x' },
    });

    expect(error.code).toBe('TEST_ERROR');
    expect(error.httpStatus).toBe(409);
    expect(error.details).toEqual({ resource: 'x' });
    expect(error.expose).toBe(true);
  });
});
