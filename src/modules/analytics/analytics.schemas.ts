import { Type } from '@sinclair/typebox';

export const WorkspaceParams = Type.Object({ workspaceId: Type.String() });
export const RelationshipParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
});

export const DashboardQuery = Type.Object(
  {
    attentionCategory: Type.Optional(Type.String()),
    attentionCursor: Type.Optional(Type.String()),
    attentionLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    branchId: Type.Optional(Type.String()),
    branchCursor: Type.Optional(Type.String()),
    branchLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    activityCategory: Type.Optional(Type.String()),
    activityCursor: Type.Optional(Type.String()),
    activityLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
);

export const TrainerDashboardQuery = Type.Object(
  {
    attentionCategory: Type.Optional(Type.String()),
    attentionCursor: Type.Optional(Type.String()),
    attentionLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    activityCategory: Type.Optional(Type.String()),
    activityCursor: Type.Optional(Type.String()),
    activityLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
);

export const AnalyticsQuery = Type.Object(
  {
    from: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    granularity: Type.Optional(Type.String()),
    metricDefinitionId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ProgressAnalyticsQuery = Type.Object(
  {
    from: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    granularity: Type.Optional(Type.String()),
    metricDefinitionId: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    correlationId: Type.Optional(Type.String()),
  }),
});
