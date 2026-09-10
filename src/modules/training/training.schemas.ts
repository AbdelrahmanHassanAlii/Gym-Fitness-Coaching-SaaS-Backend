import { Type } from '@sinclair/typebox';

export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    correlationId: Type.Optional(Type.String()),
    details: Type.Optional(Type.Unknown()),
  }),
});

export const WorkspaceParams = Type.Object({ workspaceId: Type.String() });
export const ExerciseParams = Type.Object({
  workspaceId: Type.String(),
  exerciseId: Type.String(),
});
export const PlatformExerciseParams = Type.Object({ exerciseId: Type.String() });
export const TemplateParams = Type.Object({
  workspaceId: Type.String(),
  templateId: Type.String(),
});
export const RelationshipParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
});
export const ProgramParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
  programId: Type.String(),
});

export const ListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  includeArchived: Type.Optional(Type.Boolean()),
});

const Names = Type.Object({
  ar: Type.Optional(Type.String({ minLength: 1 })),
  en: Type.Optional(Type.String({ minLength: 1 })),
});

export const ExerciseBody = Type.Object({
  scope: Type.Optional(Type.Union([Type.Literal('GYM'), Type.Literal('PRIVATE')])),
  names: Names,
  primaryMuscles: Type.Optional(Type.Array(Type.String())),
  secondaryMuscles: Type.Optional(Type.Array(Type.String())),
  equipment: Type.Optional(Type.Array(Type.String())),
  exerciseType: Type.String({ minLength: 1 }),
  difficulty: Type.Optional(Type.String()),
  instructions: Type.Optional(Type.String()),
  imageFileId: Type.Optional(Type.String()),
  videoFileId: Type.Optional(Type.String()),
  externalVideoUrl: Type.Optional(Type.String()),
});

export const PlatformExerciseBody = Type.Omit(ExerciseBody, ['scope']);

export const ExercisePatchBody = Type.Intersect([
  Type.Partial(Type.Omit(ExerciseBody, ['scope'])),
  Type.Object({ expectedVersion: Type.Integer({ minimum: 0 }) }),
]);

export const ExpectedVersionBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 0 }),
});

const RepRange = Type.Object({
  min: Type.Optional(Type.Number({ minimum: 0 })),
  max: Type.Optional(Type.Number({ minimum: 0 })),
});

const Prescription = Type.Object({
  prescriptionId: Type.Optional(Type.String()),
  exerciseId: Type.String(),
  order: Type.Integer({ minimum: 1 }),
  setStructure: Type.String({ minLength: 1 }),
  targetSets: Type.Integer({ minimum: 0 }),
  repRange: Type.Optional(RepRange),
  targetWeight: Type.Optional(Type.Number({ minimum: 0 })),
  restSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  tempo: Type.Optional(Type.String()),
  rpe: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
  rir: Type.Optional(Type.Number({ minimum: 0 })),
  groupId: Type.Optional(Type.String()),
  groupType: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

const Day = Type.Object({
  dayKey: Type.Optional(Type.String()),
  sequence: Type.Integer({ minimum: 1 }),
  name: Type.String({ minLength: 1 }),
  type: Type.Union([
    Type.Literal('RESISTANCE'),
    Type.Literal('CARDIO'),
    Type.Literal('RECOVERY'),
    Type.Literal('REST'),
    Type.Literal('CUSTOM'),
  ]),
  exercises: Type.Optional(Type.Array(Prescription)),
});

export const RevisionContent = Type.Object({
  days: Type.Array(Day, { minItems: 1 }),
});

export const CreateTemplateBody = Type.Intersect([
  Type.Object({
    scope: Type.Optional(Type.Union([Type.Literal('GYM'), Type.Literal('PRIVATE')])),
    name: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
  }),
  RevisionContent,
]);

export const CreateTemplateRevisionBody = Type.Intersect([
  Type.Object({ expectedVersion: Type.Integer({ minimum: 0 }) }),
  RevisionContent,
]);

export const CreateProgramBody = Type.Object({
  source: Type.Optional(
    Type.Union([
      Type.Object({
        type: Type.Literal('TEMPLATE'),
        templateId: Type.String(),
        templateRevisionId: Type.Optional(Type.String()),
      }),
      Type.Object({
        type: Type.Literal('PROGRAM'),
        programId: Type.String(),
        programRevisionId: Type.Optional(Type.String()),
      }),
      Type.Object({ type: Type.Literal('SCRATCH') }),
    ]),
  ),
  name: Type.String({ minLength: 1 }),
  days: Type.Optional(RevisionContent.properties.days),
});

export const CreateProgramRevisionBody = Type.Intersect([
  Type.Object({ expectedVersion: Type.Integer({ minimum: 0 }) }),
  RevisionContent,
]);

export const ActivateProgramBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 0 }),
  effectiveAt: Type.Optional(Type.String({ format: 'date-time' })),
});
