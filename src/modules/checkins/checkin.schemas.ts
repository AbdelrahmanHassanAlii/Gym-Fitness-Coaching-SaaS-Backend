import { Type } from '@sinclair/typebox';

const Id = Type.String({ minLength: 24, maxLength: 24 });
const ExpectedVersion = Type.Integer({ minimum: 0 });

export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
});

export const WorkspaceParams = Type.Object({ workspaceId: Id });
export const RelationshipParams = Type.Object({ workspaceId: Id, relationshipId: Id });
export const TemplateParams = Type.Object({ workspaceId: Id, templateId: Id });
export const AssignmentParams = Type.Object({
  workspaceId: Id,
  relationshipId: Id,
  assignmentId: Id,
});
export const CheckInParams = Type.Object({
  workspaceId: Id,
  relationshipId: Id,
  checkinId: Id,
});

export const ListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  includeArchived: Type.Optional(Type.Boolean()),
});

const FieldValidation = Type.Object(
  {
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
    minLength: Type.Optional(Type.Integer({ minimum: 0 })),
    maxLength: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const Field = Type.Object({
  fieldKey: Type.String({ minLength: 1, maxLength: 80 }),
  type: Type.String(),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  required: Type.Boolean(),
  validation: Type.Optional(FieldValidation),
});

export const TemplateCreateBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  fields: Type.Array(Field, { minItems: 1, maxItems: 50 }),
});

export const TemplateRevisionBody = Type.Object({
  expectedVersion: ExpectedVersion,
  fields: Type.Array(Field, { minItems: 1, maxItems: 50 }),
});

export const ExpectedVersionBody = Type.Object({
  expectedVersion: ExpectedVersion,
  reason: Type.Optional(Type.String({ maxLength: 500 })),
});

const Recurrence = Type.Object({
  frequency: Type.Literal('WEEKLY'),
  dayOfWeek: Type.Optional(Type.Integer({ minimum: 1, maximum: 7 })),
  timezone: Type.String({ minLength: 1, maxLength: 80 }),
});

export const AssignmentCreateBody = Type.Object({
  templateId: Id,
  recurrence: Recurrence,
  startedAt: Type.Optional(Type.String()),
});

export const AssignmentPatchBody = Type.Object({
  expectedVersion: ExpectedVersion,
  recurrence: Type.Optional(Recurrence),
});

const ResponseValue = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

export const SubmitBody = Type.Object({
  expectedVersion: ExpectedVersion,
  responses: Type.Array(
    Type.Object({
      fieldKey: Type.String({ minLength: 1, maxLength: 80 }),
      value: ResponseValue,
    }),
    { maxItems: 50 },
  ),
});

export const ReviewBody = Type.Object({
  expectedVersion: ExpectedVersion,
  trainerFeedback: Type.Object({
    comment: Type.String({ minLength: 1, maxLength: 2000 }),
  }),
});
