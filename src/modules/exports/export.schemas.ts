import { Type } from '@sinclair/typebox';

const Id = Type.String({ minLength: 1 });

export const WorkspaceParams = Type.Object({ workspaceId: Id });
export const ExportParams = Type.Object({ workspaceId: Id, exportId: Id });
export const ListQuery = Type.Object(
  {
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    details: Type.Optional(Type.Unknown()),
    correlationId: Type.Optional(Type.String()),
  }),
});
