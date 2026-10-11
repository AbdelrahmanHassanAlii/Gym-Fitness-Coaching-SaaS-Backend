import { Type } from '@sinclair/typebox';
import { ErrorResponse } from '../auth/auth.schemas';

const Id = Type.String({ pattern: '^[0-9a-f]{24}$' });
export const ManagementParams = Type.Object(
  { userId: Type.String() },
  { additionalProperties: false },
);
export const ManagementBody = Type.Object(
  { expectedVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) },
  { additionalProperties: false },
);
export const ManagementHeaders = Type.Object(
  { 'idempotency-key': Type.String({ minLength: 1, pattern: '\\S' }) },
  { additionalProperties: true },
);
export const ManagementResponse = Type.Object(
  {
    data: Type.Object(
      {
        userId: Id,
        platformMembership: Type.Object(
          {
            id: Id,
            status: Type.Union([
              Type.Literal('ACTIVE'),
              Type.Literal('SUSPENDED'),
              Type.Literal('ENDED'),
            ]),
            version: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
            suspendedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
            endedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const ManagementResponses = {
  200: ManagementResponse,
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  500: ErrorResponse,
};
