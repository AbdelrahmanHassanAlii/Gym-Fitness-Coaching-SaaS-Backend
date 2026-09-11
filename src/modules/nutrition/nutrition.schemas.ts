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
export const FoodParams = Type.Object({ workspaceId: Type.String(), foodId: Type.String() });
export const PlatformFoodParams = Type.Object({ foodId: Type.String() });
export const RelationshipParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
});
export const NutritionPlanParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
  planId: Type.String(),
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

const FoodUnit = Type.Union([
  Type.Literal('GRAM'),
  Type.Literal('MILLILITER'),
  Type.Literal('UNIT'),
  Type.Literal('SERVING'),
]);

export const FoodBody = Type.Object({
  scope: Type.Optional(Type.Union([Type.Literal('GYM'), Type.Literal('PRIVATE')])),
  names: Names,
  baseAmount: Type.Number({ exclusiveMinimum: 0 }),
  baseUnit: FoodUnit,
  calories: Type.Number({ minimum: 0 }),
  proteinG: Type.Number({ minimum: 0 }),
  carbsG: Type.Number({ minimum: 0 }),
  fatG: Type.Number({ minimum: 0 }),
});

export const PlatformFoodBody = Type.Omit(FoodBody, ['scope']);

export const FoodPatchBody = Type.Intersect([
  Type.Partial(PlatformFoodBody),
  Type.Object({ expectedVersion: Type.Integer({ minimum: 0 }) }),
]);

export const ExpectedVersionBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 0 }),
});

const FoodItem = Type.Object({
  foodId: Type.String(),
  selectedAmount: Type.Number({ exclusiveMinimum: 0 }),
  selectedUnit: FoodUnit,
  calculatedCalories: Type.Optional(Type.Number()),
  calculatedProteinG: Type.Optional(Type.Number()),
  calculatedCarbsG: Type.Optional(Type.Number()),
  calculatedFatG: Type.Optional(Type.Number()),
});

const AlternativeOption = Type.Object({
  optionKey: Type.Optional(Type.String()),
  order: Type.Integer({ minimum: 1 }),
  items: Type.Array(FoodItem),
});

const AlternativeGroup = Type.Object({
  groupKey: Type.Optional(Type.String()),
  order: Type.Integer({ minimum: 1 }),
  selectionRule: Type.Optional(Type.Literal('CHOOSE_ONE')),
  options: Type.Array(AlternativeOption),
});

const Meal = Type.Object({
  mealKey: Type.Optional(Type.String()),
  order: Type.Integer({ minimum: 1 }),
  name: Type.String({ minLength: 1 }),
  type: Type.Optional(
    Type.Union([Type.Literal('REGULAR'), Type.Literal('FLEXIBLE'), Type.Literal('CHEAT')]),
  ),
  items: Type.Optional(Type.Array(FoodItem)),
  alternativeGroups: Type.Optional(Type.Array(AlternativeGroup)),
  notes: Type.Optional(Type.String()),
});

const Supplement = Type.Object({
  supplementKey: Type.Optional(Type.String()),
  order: Type.Integer({ minimum: 1 }),
  name: Type.String({ minLength: 1 }),
  amount: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  unit: Type.Optional(Type.String()),
  timing: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

export const RevisionContent = Type.Object({
  targetCalories: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  targetProteinG: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  targetCarbsG: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  targetFatG: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  waterTargetMl: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  meals: Type.Array(Meal, { minItems: 1 }),
  supplements: Type.Optional(Type.Array(Supplement)),
  notes: Type.Optional(Type.String()),
});

export const CreateNutritionPlanBody = Type.Intersect([
  Type.Object({
    name: Type.String({ minLength: 1 }),
    responsibleMembershipId: Type.Optional(Type.String()),
  }),
  RevisionContent,
]);

export const CreateNutritionPlanRevisionBody = Type.Intersect([
  Type.Object({ expectedVersion: Type.Integer({ minimum: 0 }) }),
  RevisionContent,
]);

export const ActivateNutritionPlanBody = ExpectedVersionBody;
