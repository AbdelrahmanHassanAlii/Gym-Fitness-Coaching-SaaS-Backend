import { Type } from '@sinclair/typebox';
import { ErrorResponse, SuccessResponse } from '../auth/auth.schemas';

const Effect = Type.Union([Type.Literal('ALLOW'), Type.Literal('DENY')]);
const ScopeType = Type.Union([
  Type.Literal('SELF'),
  Type.Literal('ASSIGNED_TRAINEES'),
  Type.Literal('SPECIFIC_TRAINEES'),
  Type.Literal('BRANCH'),
  Type.Literal('MULTIPLE_BRANCHES'),
  Type.Literal('WORKSPACE'),
]);

export const WorkspaceProfileParams = Type.Object({
  workspaceId: Type.String(),
  profileId: Type.String(),
});

export const WorkspaceMembershipParams = Type.Object({
  workspaceId: Type.String(),
  membershipId: Type.String(),
});

export const PlatformProfileParams = Type.Object({
  profileId: Type.String(),
});

export const PlatformMembershipParams = Type.Object({
  membershipId: Type.String(),
});

export const PermissionProfileEntry = Type.Object(
  {
    permission: Type.String({ minLength: 1 }),
    effect: Effect,
  },
  { additionalProperties: false },
);

export const CreatePermissionProfileBody = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    roleKey: Type.Optional(Type.String({ minLength: 1 })),
    permissions: Type.Array(PermissionProfileEntry),
  },
  { additionalProperties: false },
);

export const UpdatePermissionProfileBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    name: Type.Optional(Type.String({ minLength: 1 })),
    permissions: Type.Optional(Type.Array(PermissionProfileEntry)),
  },
  { additionalProperties: false },
);

export const ArchivePermissionProfileBody = Type.Object(
  {
    expectedVersion: Type.Number(),
  },
  { additionalProperties: false },
);

export const ReplacePermissionProfilesBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    profileIds: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const AccessGrantInput = Type.Object(
  {
    permission: Type.String({ minLength: 1 }),
    effect: Effect,
    scope: Type.Object(
      {
        type: ScopeType,
        resourceIds: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: false },
    ),
    expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false },
);

export const ReplaceAccessGrantsBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    grants: Type.Array(AccessGrantInput),
  },
  { additionalProperties: false },
);

export { ErrorResponse, SuccessResponse };
