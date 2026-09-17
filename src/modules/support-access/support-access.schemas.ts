import { Type } from '@sinclair/typebox';

const Id = Type.String({ minLength: 24, maxLength: 24 });

export const ErrorResponse = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String() }),
});

const TargetType = Type.Union([
  Type.Literal('GYM'),
  Type.Literal('INDEPENDENT_TRAINER'),
  Type.Literal('STAFF'),
  Type.Literal('TRAINEE'),
]);

const SessionType = Type.Union([Type.Literal('READ_ONLY'), Type.Literal('WRITE_SUPPORT')]);
const ContextType = Type.Union([Type.Literal('USER_CONTEXT'), Type.Literal('WORKSPACE_SUPPORT')]);

export const PolicyParams = Type.Object({ policyId: Id });
export const SessionParams = Type.Object({ sessionId: Id });

export const ExpectedVersionBody = Type.Object(
  { expectedVersion: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const PortalAccessPolicyBody = Type.Object(
  {
    platformMembershipId: Id,
    allowedTargetTypes: Type.Array(TargetType, { minItems: 1 }),
    allowedWorkspaceIds: Type.Optional(Type.Array(Id)),
    allowedIpRanges: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }))),
    allowedSessionTypes: Type.Array(SessionType, { minItems: 1 }),
    maxSessionDurationMinutes: Type.Integer({ minimum: 1, maximum: 60 }),
    notificationRequired: Type.Boolean(),
    allowSensitiveData: Type.Boolean(),
    allowSensitiveFileDownload: Type.Boolean(),
    validFrom: Type.Optional(Type.String({ format: 'date-time' })),
    validUntil: Type.Optional(Type.String({ format: 'date-time' })),
    enabled: Type.Optional(Type.Boolean()),
    expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const SupportAccessRequestBody = Type.Object(
  {
    targetType: TargetType,
    targetWorkspaceId: Type.Optional(Id),
    targetUserId: Type.Optional(Id),
    effectiveMembershipId: Type.Optional(Id),
    contextType: ContextType,
    sessionType: SessionType,
    requestedDurationMinutes: Type.Integer({ minimum: 1, maximum: 60 }),
    requestedSensitiveAccess: Type.Optional(Type.Boolean()),
    requestedSensitiveFileDownload: Type.Optional(Type.Boolean()),
    reason: Type.String({ minLength: 3, maxLength: 500 }),
    reference: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  },
  { additionalProperties: false },
);
