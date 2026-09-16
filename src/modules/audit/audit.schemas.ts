import { Type } from '@sinclair/typebox';

const Id = Type.String({ minLength: 24, maxLength: 24 });

export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
});

export const WorkspaceParams = Type.Object({ workspaceId: Id });

export const AuditQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    eventType: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    action: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    actorUserId: Type.Optional(Id),
    entityType: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    entityId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    correlationId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    from: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    workspaceId: Type.Optional(Id),
  },
  { additionalProperties: false },
);

export const WorkspaceAuditQuerySchema = Type.Omit(AuditQuerySchema, ['workspaceId']);
