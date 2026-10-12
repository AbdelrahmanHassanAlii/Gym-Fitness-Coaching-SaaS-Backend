import { Type } from '@sinclair/typebox';
import { ErrorResponse } from '../auth/auth.schemas';

const strict = { additionalProperties: false };
const Id = Type.String({ pattern: '^[0-9a-f]{24}$' });
const Version = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const AssignmentParams = Type.Object({ userId: Id }, strict);
export const AssignmentBody = Type.Object(
  { expectedVersion: Version, profileIds: Type.Array(Id, { maxItems: 20 }) },
  strict,
);
export const AssignmentHeaders = Type.Object(
  { 'idempotency-key': Type.String({ minLength: 1, pattern: '\\S' }) },
  { additionalProperties: true },
);
export const SelectorQuery = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  },
  strict,
);
export const AssignmentResponse = Type.Object(
  {
    data: Type.Object(
      {
        userId: Id,
        platformMembership: Type.Object(
          {
            id: Id,
            status: Type.Union(['ACTIVE', 'SUSPENDED', 'ENDED'].map((s) => Type.Literal(s))),
            version: Version,
          },
          strict,
        ),
        permissionProfiles: Type.Array(
          Type.Union([
            Type.Object(
              {
                id: Id,
                name: Type.String(),
                status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')]),
              },
              strict,
            ),
            Type.Object({ id: Id, name: Type.Null(), status: Type.Literal('UNAVAILABLE') }, strict),
          ]),
          { maxItems: 10_000 },
        ),
      },
      strict,
    ),
  },
  strict,
);
export const SelectorResponse = Type.Object(
  {
    data: Type.Object(
      {
        permissionProfiles: Type.Array(Type.Object({ id: Id, name: Type.String() }, strict), {
          maxItems: 100,
        }),
        nextCursor: Type.Union([Type.String(), Type.Null()]),
      },
      strict,
    ),
  },
  strict,
);
export const AssignmentErrors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  500: ErrorResponse,
};
