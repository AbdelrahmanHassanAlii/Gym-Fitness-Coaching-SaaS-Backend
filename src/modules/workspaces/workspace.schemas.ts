import { Type } from '@sinclair/typebox';
import { ErrorResponse, SuccessResponse } from '../auth/auth.schemas';

const WorkspaceType = Type.Union([Type.Literal('GYM'), Type.Literal('INDEPENDENT_TRAINER')]);
const Language = Type.Union([Type.Literal('ar'), Type.Literal('en')]);
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

export const CreateWorkspaceBody = Type.Object({
  type: WorkspaceType,
  name: Type.String({ minLength: 1 }),
  ownerUserId: Type.String(),
  timezone: Type.String({ minLength: 1 }),
  defaultLanguage: Language,
  country: Type.Optional(Type.String()),
  city: Type.Optional(Type.String()),
  governorate: Type.Optional(Type.String()),
});

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
