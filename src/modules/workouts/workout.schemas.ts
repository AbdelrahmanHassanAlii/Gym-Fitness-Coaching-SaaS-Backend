import { Type } from '@sinclair/typebox';

export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    correlationId: Type.Optional(Type.String()),
    details: Type.Optional(Type.Unknown()),
  }),
});

export const RelationshipParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
});

export const WorkoutParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
  workoutId: Type.String(),
});

export const ProgressParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
  programId: Type.String(),
});

export const ListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const ExpectedVersionBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 0 }),
});

const ActualSet = Type.Object({
  setKey: Type.String({ minLength: 1 }),
  weight: Type.Optional(Type.Number({ minimum: 0 })),
  reps: Type.Optional(Type.Integer({ minimum: 0 })),
  durationSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  distance: Type.Optional(Type.Number({ minimum: 0 })),
  rpe: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
  rir: Type.Optional(Type.Number({ minimum: 0 })),
  completed: Type.Boolean(),
  notes: Type.Optional(Type.String()),
});

const ActualExercise = Type.Object({
  workoutExerciseKey: Type.String({ minLength: 1 }),
  sets: Type.Array(ActualSet),
});

export const WorkoutPatchBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 0 }),
  exercises: Type.Array(ActualExercise),
  notes: Type.Optional(Type.String()),
  clientMutationId: Type.Optional(Type.String()),
});

export const WorkoutCorrectionBody = Type.Intersect([
  WorkoutPatchBody,
  Type.Object({ reason: Type.String({ minLength: 1 }) }),
]);

export const AbandonBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 0 }),
  reason: Type.Optional(Type.String()),
});

export const ProgressCommandBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 0 }),
  reason: Type.Optional(Type.String()),
});
