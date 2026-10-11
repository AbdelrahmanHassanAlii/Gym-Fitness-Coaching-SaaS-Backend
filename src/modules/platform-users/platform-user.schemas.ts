import { Type } from '@sinclair/typebox';
import { ErrorResponse } from '../auth/auth.schemas';
import { UserStatuses } from '../identity/identity.types';
import { PlatformMembershipStatuses } from '../platform/platform.types';

const id = Type.String({ pattern: '^[0-9a-f]{24}$' });
const date = Type.String({ format: 'date-time' });
const accountStatus = Type.Union(UserStatuses.map((value) => Type.Literal(value)));
const membershipStatus = Type.Union(PlatformMembershipStatuses.map((value) => Type.Literal(value)));
const identity = {
  id,
  displayName: Type.Optional(Type.String({ minLength: 1 })),
  email: Type.Optional(Type.String()),
  status: accountStatus,
  createdAt: date,
};

export const PlatformUserDirectoryQuery = Type.Object(
  {
    q: Type.Optional(
      Type.String({
        maxLength: 254,
        description:
          'Exact full email (trimmed/lowercased) or exact user ObjectId only. Blank means no search. Invalid nonempty search: 422 PLATFORM_USER_SEARCH_INVALID.',
      }),
    ),
    platformMembershipStatus: Type.Optional(membershipStatus),
    cursor: Type.Optional(
      Type.String({
        description:
          'Opaque lowercase 24-hex membership ObjectId. Invalid cursor: 422 CURSOR_INVALID.',
      }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  },
  { additionalProperties: false },
);

export const PlatformUserDetailParams = Type.Object(
  { userId: id },
  { additionalProperties: false },
);
export const PlatformUserDirectoryResponse = Type.Object(
  {
    data: Type.Array(
      Type.Object(
        {
          ...identity,
          platformMembership: Type.Object(
            { status: membershipStatus },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ),
    meta: Type.Object(
      {
        nextCursor: Type.Union([Type.String(), Type.Null()]),
        hasMore: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PlatformUserDetailResponse = Type.Object(
  {
    data: Type.Object(
      {
        ...identity,
        updatedAt: date,
        platformMembership: Type.Object(
          {
            id,
            status: membershipStatus,
            createdAt: date,
            updatedAt: date,
            suspendedAt: Type.Optional(date),
            endedAt: Type.Optional(date),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const PlatformUserEmptyQuery = Type.Object({}, { additionalProperties: false });
export { ErrorResponse };
