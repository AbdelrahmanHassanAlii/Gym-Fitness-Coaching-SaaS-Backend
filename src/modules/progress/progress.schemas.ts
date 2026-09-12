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
export const MetricDefinitionParams = Type.Object({
  workspaceId: Type.String(),
  metricDefinitionId: Type.String(),
});
export const RelationshipParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
});
export const MeasurementParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
  measurementId: Type.String(),
});
export const NoteParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
  noteId: Type.String(),
});
export const DailyTrackingParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
  localDate: Type.String(),
});

export const ListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  includeArchived: Type.Optional(Type.Boolean()),
  metricDefinitionId: Type.Optional(Type.String()),
});

const MetricValueType = Type.Union([Type.Literal('NUMBER'), Type.Literal('INTEGER')]);
const MetricScope = Type.Union([Type.Literal('GYM'), Type.Literal('PRIVATE')]);
const MeasurementSource = Type.Union([
  Type.Literal('TRAINEE'),
  Type.Literal('TRAINER'),
  Type.Literal('INBODY'),
  Type.Literal('OTHER'),
]);
const NoteVisibility = Type.Union([Type.Literal('PRIVATE'), Type.Literal('SHARED_WITH_TRAINEE')]);
const AdherenceMetric = Type.Union([
  Type.Literal('WORKOUT'),
  Type.Literal('NUTRITION'),
  Type.Literal('WATER'),
  Type.Literal('STEPS'),
  Type.Literal('SLEEP'),
  Type.Literal('BODY_WEIGHT'),
  Type.Literal('MOOD'),
  Type.Literal('ENERGY'),
]);

export const ExpectedVersionBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 0 }),
});

export const MetricDefinitionBody = Type.Object({
  scope: Type.Optional(MetricScope),
  key: Type.Optional(Type.String({ minLength: 1 })),
  name: Type.String({ minLength: 1 }),
  valueType: MetricValueType,
  unit: Type.String({ minLength: 1 }),
  category: Type.String({ minLength: 1 }),
});

export const MetricDefinitionPatchBody = Type.Intersect([
  Type.Object({ expectedVersion: Type.Integer({ minimum: 0 }) }),
  Type.Partial(
    Type.Object({
      key: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1 }),
      category: Type.String({ minLength: 1 }),
    }),
  ),
]);

export const MeasurementBody = Type.Object({
  metricDefinitionId: Type.String(),
  value: Type.Number(),
  measuredAt: Type.String(),
  source: MeasurementSource,
  notes: Type.Optional(Type.String()),
});

export const MeasurementPatchBody = Type.Intersect([
  Type.Object({ expectedVersion: Type.Integer({ minimum: 0 }) }),
  Type.Partial(
    Type.Object({
      value: Type.Number(),
      measuredAt: Type.String(),
      source: MeasurementSource,
      notes: Type.String(),
    }),
  ),
]);

export const HealthProfileBody = Type.Object({
  expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
  injuries: Type.Optional(Type.Array(Type.String())),
  physicalLimitations: Type.Optional(Type.Array(Type.String())),
  foodAllergies: Type.Optional(Type.Array(Type.String())),
  medications: Type.Optional(Type.Array(Type.String())),
  medicalNotes: Type.Optional(Type.String()),
  emergencyNotes: Type.Optional(Type.String()),
});

export const NoteBody = Type.Object({
  category: Type.String({ minLength: 1 }),
  visibility: Type.Optional(NoteVisibility),
  content: Type.String({ minLength: 1 }),
  sensitive: Type.Optional(Type.Boolean()),
});

export const NotePatchBody = Type.Intersect([
  Type.Object({ expectedVersion: Type.Integer({ minimum: 0 }) }),
  Type.Partial(NoteBody),
]);

export const AdherenceConfigBody = Type.Object({
  expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
  enabledMetrics: Type.Array(AdherenceMetric),
});

const DailyValues = Type.Partial(
  Type.Object({
    WORKOUT: Type.Object({ completed: Type.Boolean() }),
    NUTRITION: Type.Object({ adherencePercent: Type.Number({ minimum: 0, maximum: 100 }) }),
    WATER: Type.Object({ ml: Type.Number({ minimum: 0 }) }),
    STEPS: Type.Object({ count: Type.Integer({ minimum: 0 }) }),
    SLEEP: Type.Object({ minutes: Type.Integer({ minimum: 0 }) }),
    BODY_WEIGHT: Type.Object({ kg: Type.Number({ exclusiveMinimum: 0 }) }),
    MOOD: Type.Object({ score: Type.Integer({ minimum: 1, maximum: 5 }) }),
    ENERGY: Type.Object({ score: Type.Integer({ minimum: 1, maximum: 5 }) }),
  }),
);

export const DailyTrackingBody = Type.Object({
  expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
  values: DailyValues,
  reason: Type.Optional(Type.String()),
});
