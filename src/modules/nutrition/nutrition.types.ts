import type { ObjectId } from 'mongodb';

export const FoodScopes = ['SYSTEM', 'GYM', 'PRIVATE'] as const;
export type FoodScope = (typeof FoodScopes)[number];

export const FoodUnits = ['GRAM', 'MILLILITER', 'UNIT', 'SERVING'] as const;
export type FoodUnit = (typeof FoodUnits)[number];

export const FoodStatuses = ['ACTIVE', 'ARCHIVED'] as const;
export type FoodStatus = (typeof FoodStatuses)[number];

export const NutritionPlanStatuses = [
  'DRAFT',
  'ACTIVE',
  'REPLACED',
  'COMPLETED',
  'ARCHIVED',
] as const;
export type NutritionPlanStatus = (typeof NutritionPlanStatuses)[number];

export interface FoodNames {
  ar?: string;
  en?: string;
}

export interface FoodDocument {
  _id: ObjectId;
  scope: FoodScope;
  workspaceId?: ObjectId | null;
  ownerMembershipId?: ObjectId | null;
  names: FoodNames;
  normalizedNames: string[];
  baseAmount: number;
  baseUnit: FoodUnit;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  status: FoodStatus;
  version: number;
  nutritionUseRevision?: number;
  archivedAt?: Date;
  createdBy: ObjectId;
  updatedBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface NutritionTargets {
  targetCalories?: number;
  targetProteinG?: number;
  targetCarbsG?: number;
  targetFatG?: number;
  waterTargetMl?: number;
}

export interface CalculatedMacros {
  calculatedCalories: number;
  calculatedProteinG: number;
  calculatedCarbsG: number;
  calculatedFatG: number;
}

export interface NutritionFoodSnapshot extends CalculatedMacros {
  foodId: ObjectId;
  foodNameSnapshot: string;
  foodScopeSnapshot: FoodScope;
  foodWorkspaceIdSnapshot?: ObjectId | null;
  baseAmountSnapshot: number;
  baseUnitSnapshot: FoodUnit;
  caloriesSnapshot: number;
  proteinGSnapshot: number;
  carbsGSnapshot: number;
  fatGSnapshot: number;
  selectedAmount: number;
  selectedUnit: FoodUnit;
}

export interface NutritionAlternativeOption {
  optionKey: string;
  order: number;
  items: NutritionFoodSnapshot[];
}

export interface NutritionAlternativeGroup {
  groupKey: string;
  order: number;
  selectionRule: 'CHOOSE_ONE';
  options: NutritionAlternativeOption[];
}

export interface NutritionMeal {
  mealKey: string;
  order: number;
  name: string;
  type: 'REGULAR' | 'FLEXIBLE' | 'CHEAT';
  items: NutritionFoodSnapshot[];
  alternativeGroups: NutritionAlternativeGroup[];
  notes?: string;
}

export interface NutritionSupplement {
  supplementKey: string;
  order: number;
  name: string;
  amount?: number;
  unit?: string;
  timing?: string;
  notes?: string;
}

export interface NutritionPlanDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  name: string;
  status: NutritionPlanStatus;
  responsibleMembershipId: ObjectId;
  currentRevisionId: ObjectId;
  startedAt?: Date;
  endedAt?: Date;
  completedAt?: Date;
  archivedAt?: Date;
  replacedByPlanId?: ObjectId;
  version: number;
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface NutritionPlanRevisionDocument extends NutritionTargets, CalculatedMacros {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  nutritionPlanId: ObjectId;
  revision: number;
  meals: NutritionMeal[];
  supplements: NutritionSupplement[];
  notes?: string;
  createdBy: ObjectId;
  createdAt: Date;
}
