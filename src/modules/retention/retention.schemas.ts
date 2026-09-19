import { Type } from '@sinclair/typebox';

export const deletionIdParamsSchema = Type.Object({
  deletionId: Type.String(),
});

export const listDeletionQuerySchema = Type.Object({
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Type.String()),
});

export const approveDeletionBodySchema = Type.Object({
  expectedVersion: Type.Number({ minimum: 0 }),
  reason: Type.String({ minLength: 1, maxLength: 500 }),
});

export const postponeDeletionBodySchema = Type.Object({
  expectedVersion: Type.Number({ minimum: 0 }),
  reason: Type.String({ minLength: 1, maxLength: 500 }),
  reviewAfter: Type.String({ format: 'date-time' }),
});

export const cancelDeletionBodySchema = approveDeletionBodySchema;
