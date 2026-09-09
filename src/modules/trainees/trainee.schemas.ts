import { Type } from '@sinclair/typebox';
import { ErrorResponse, SuccessResponse } from '../auth/auth.schemas';

export const RelationshipStatusSchema = Type.Union([
  Type.Literal('PENDING'),
  Type.Literal('ACTIVE'),
  Type.Literal('NEEDS_REASSIGNMENT'),
  Type.Literal('ENDED'),
  Type.Literal('ARCHIVED'),
]);

export const WorkspaceParams = Type.Object({ workspaceId: Type.String() });
export const RelationshipParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
});
export const StaffAssignmentParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
  membershipId: Type.String(),
});
export const InvitationParams = Type.Object({
  workspaceId: Type.String(),
  invitationId: Type.String(),
});
export const ReferralParams = Type.Object({ code: Type.String() });
export const RelationshipQuery = Type.Object({
  status: Type.Optional(RelationshipStatusSchema),
});

export const InviteTraineeBody = Type.Object(
  {
    email: Type.Optional(Type.String()),
    phone: Type.Optional(Type.String()),
    homeBranchId: Type.Optional(Type.String()),
    primaryTrainerMembershipId: Type.Optional(Type.String()),
    expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false },
);

export const ReferralJoinBody = Type.Object(
  { homeBranchId: Type.Optional(Type.String()) },
  { additionalProperties: false },
);

export const ExpectedVersionBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AcceptRelationshipBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    primaryTrainerMembershipId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ReactivateRelationshipBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    homeBranchId: Type.Optional(Type.String()),
    primaryTrainerMembershipId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const HomeBranchBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    homeBranchId: Type.String(),
    primaryTrainerMembershipId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const PrimaryTrainerBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    primaryTrainerMembershipId: Type.String(),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const StaffAssignmentBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    staffMembershipId: Type.String(),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const MigrationBody = Type.Object(
  {
    sourceWorkspaceId: Type.String(),
    destinationWorkspaceId: Type.String(),
    sourceRelationshipId: Type.String(),
    destinationHomeBranchId: Type.String(),
    destinationPrimaryTrainerMembershipId: Type.String(),
    expectedSourceVersion: Type.Number(),
    expectedDestinationVersion: Type.Optional(Type.Number()),
    endSourceRelationship: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export { ErrorResponse, SuccessResponse };
