import { Type } from '@sinclair/typebox';
import { ErrorResponse, SuccessResponse } from '../auth/auth.schemas';

const WorkspaceType = Type.Union([Type.Literal('GYM'), Type.Literal('INDEPENDENT_TRAINER')]);
const Language = Type.Union([Type.Literal('ar'), Type.Literal('en')]);
const WorkspaceStatus = Type.Union([
  Type.Literal('PENDING_ACTIVATION'),
  Type.Literal('ACTIVE'),
  Type.Literal('RESTRICTED'),
  Type.Literal('SUSPENDED'),
  Type.Literal('ARCHIVED'),
]);
const PlatformMembershipStatus = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('SUSPENDED'),
  Type.Literal('ENDED'),
]);
const Role = Type.Union([
  Type.Literal('GYM_OWNER'),
  Type.Literal('GYM_MANAGER'),
  Type.Literal('TRAINER'),
  Type.Literal('ASSISTANT_TRAINER'),
  Type.Literal('NUTRITIONIST'),
  Type.Literal('TRAINEE'),
]);

export const IdParams = Type.Object({
  workspaceId: Type.String(),
});

export const PlatformMembershipParams = Type.Object({
  platformMembershipId: Type.String(),
});

export const EmptyQuery = Type.Object({}, { additionalProperties: false });

export const PlatformWorkspaceDirectoryQuery = Type.Object(
  {
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
    q: Type.Optional(
      Type.String({
        description: 'Workspace-name prefix; maximum 64 normalized Unicode code points.',
      }),
    ),
    status: Type.Optional(WorkspaceStatus),
  },
  { additionalProperties: false },
);

export const PlatformWorkspaceDetailParams = Type.Object(
  { workspaceId: Type.String({ pattern: '^[0-9a-f]{24}$' }) },
  { additionalProperties: false },
);

export const PlatformWorkspaceDetailResponse = Type.Object(
  {
    data: Type.Object(
      {
        id: Type.String({ pattern: '^[0-9a-f]{24}$' }),
        name: Type.String({ minLength: 1 }),
        type: WorkspaceType,
        status: WorkspaceStatus,
        timezone: Type.String({ minLength: 1 }),
        defaultLanguage: Language,
        country: Type.Optional(Type.String()),
        city: Type.Optional(Type.String()),
        governorate: Type.Optional(Type.String()),
        createdAt: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const PlatformWorkspaceDirectoryRow = Type.Object(
  {
    id: Type.String({ pattern: '^[0-9a-f]{24}$' }),
    name: Type.String({ minLength: 1 }),
    status: WorkspaceStatus,
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);

export const PlatformWorkspaceDirectoryResponse = Type.Object(
  {
    data: Type.Array(PlatformWorkspaceDirectoryRow),
    meta: Type.Object(
      {
        nextCursor: Type.Union([Type.String({ pattern: '^[0-9a-f]{24}$' }), Type.Null()]),
        hasMore: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PlatformContextResponse = Type.Object(
  {
    data: Type.Object(
      {
        context: Type.Literal('PLATFORM'),
        accessContext: Type.Literal('USER'),
        membership: Type.Object(
          {
            id: Type.String(),
            status: PlatformMembershipStatus,
            accessVersion: Type.Integer({ minimum: 0 }),
            updatedAt: Type.String({ format: 'date-time' }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const MembershipParams = Type.Object({
  workspaceId: Type.String(),
  membershipId: Type.String(),
});

export const BranchParams = Type.Object({
  workspaceId: Type.String(),
  branchId: Type.String(),
});

export const MembershipBranchParams = Type.Object({
  workspaceId: Type.String(),
  membershipId: Type.String(),
  branchId: Type.String(),
});

export const InvitationParams = Type.Object({
  workspaceId: Type.String(),
  invitationId: Type.String(),
});

export const CreateWorkspaceBody = Type.Object(
  {
    type: WorkspaceType,
    name: Type.String({ minLength: 1 }),
    ownerUserId: Type.String(),
    timezone: Type.String({ minLength: 1 }),
    defaultLanguage: Language,
    country: Type.Optional(Type.String()),
    city: Type.Optional(Type.String()),
    governorate: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const UpdateMeBody = Type.Object(
  {
    firstName: Type.Optional(Type.String({ minLength: 1 })),
    lastName: Type.Optional(Type.String({ minLength: 1 })),
    preferredLanguage: Type.Optional(Language),
    timezone: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const UpdateWorkspaceBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1 })),
    timezone: Type.Optional(Type.String({ minLength: 1 })),
    defaultLanguage: Type.Optional(Language),
    city: Type.Optional(Type.String()),
    governorate: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const CreatePlatformMembershipBody = Type.Object({
  userId: Type.String(),
});

export const CreateBranchBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  code: Type.Optional(Type.String({ minLength: 1 })),
  timezone: Type.Optional(Type.String({ minLength: 1 })),
  address: Type.Optional(Type.String()),
  city: Type.Optional(Type.String()),
  governorate: Type.Optional(Type.String()),
});

export const UpdateBranchBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1 })),
    code: Type.Optional(Type.String({ minLength: 1 })),
    timezone: Type.Optional(Type.String({ minLength: 1 })),
    address: Type.Optional(Type.String()),
    city: Type.Optional(Type.String()),
    governorate: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const InviteStaffBody = Type.Object({
  email: Type.Optional(Type.String()),
  phone: Type.Optional(Type.String()),
  roles: Type.Array(Role, { minItems: 1 }),
  branchIds: Type.Optional(Type.Array(Type.String())),
  expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
});

export const AcceptInvitationBody = Type.Object({
  token: Type.String({ minLength: 1 }),
});

export { ErrorResponse, SuccessResponse };
