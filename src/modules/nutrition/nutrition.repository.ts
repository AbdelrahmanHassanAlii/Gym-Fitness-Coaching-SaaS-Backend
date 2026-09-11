import type { Collection, Filter, MongoServerError, ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type {
  FoodDocument,
  FoodScope,
  NutritionPlanDocument,
  NutritionPlanRevisionDocument,
  NutritionPlanStatus,
} from './nutrition.types';

export class NutritionRepository {
  private readonly foods: Collection<FoodDocument>;
  private readonly plans: Collection<NutritionPlanDocument>;
  private readonly revisions: Collection<NutritionPlanRevisionDocument>;

  constructor(database: Database) {
    this.foods = database.db.collection<FoodDocument>('foods');
    this.plans = database.db.collection<NutritionPlanDocument>('nutrition_plans');
    this.revisions = database.db.collection<NutritionPlanRevisionDocument>(
      'nutrition_plan_revisions',
    );
  }

  async listFoods(input: {
    workspaceId?: ObjectId;
    ownerMembershipId?: ObjectId;
    includeArchived?: boolean;
    limit?: number;
    afterId?: ObjectId;
  }) {
    return await this.foods
      .find({
        ...(input.includeArchived ? {} : { status: 'ACTIVE' }),
        ...(input.afterId ? { _id: { $gt: input.afterId } } : {}),
        $or: [
          { scope: 'SYSTEM', workspaceId: null },
          ...(input.workspaceId
            ? [
                { scope: 'GYM' as const, workspaceId: input.workspaceId },
                ...(input.ownerMembershipId
                  ? [
                      {
                        scope: 'PRIVATE' as const,
                        workspaceId: input.workspaceId,
                        ownerMembershipId: input.ownerMembershipId,
                      },
                    ]
                  : []),
              ]
            : []),
        ],
      })
      .sort({ _id: 1 })
      .limit(input.limit ?? 50)
      .toArray();
  }

  async createFood(food: FoodDocument, tx?: TransactionContext) {
    try {
      await this.foods.insertOne(food, options(tx));
      return food;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('FOOD_NAME_CONFLICT');
      throw error;
    }
  }

  async findFood(foodId: ObjectId, tx?: TransactionContext) {
    return await this.foods.findOne({ _id: foodId }, options(tx));
  }

  async updateFood(
    foodId: ObjectId,
    scope: FoodScope,
    workspaceId: ObjectId | null,
    ownerMembershipId: ObjectId | undefined,
    expectedVersion: number,
    patch: Partial<FoodDocument>,
    tx?: TransactionContext,
  ) {
    try {
      const filter: Filter<FoodDocument> = {
        _id: foodId,
        scope,
        workspaceId,
        status: 'ACTIVE' as const,
        version: expectedVersion,
        ...(scope === 'PRIVATE' && ownerMembershipId ? { ownerMembershipId } : {}),
      };
      const result = await this.foods.findOneAndUpdate(
        filter,
        { $set: patch, $inc: { version: 1 } },
        { returnDocument: 'after', ...options(tx) },
      );
      if (!result) throw conflict('FOOD_VERSION_CONFLICT');
      return result;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('FOOD_NAME_CONFLICT');
      throw error;
    }
  }

  async archiveFood(
    foodId: ObjectId,
    scope: FoodScope,
    workspaceId: ObjectId | null,
    ownerMembershipId: ObjectId | undefined,
    expectedVersion: number,
    now: Date,
    tx?: TransactionContext,
  ) {
    const filter: Filter<FoodDocument> = {
      _id: foodId,
      scope,
      workspaceId,
      status: 'ACTIVE' as const,
      version: expectedVersion,
      ...(scope === 'PRIVATE' && ownerMembershipId ? { ownerMembershipId } : {}),
    };
    const result = await this.foods.findOneAndUpdate(
      filter,
      { $set: { status: 'ARCHIVED', archivedAt: now, updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result) throw conflict('FOOD_VERSION_CONFLICT');
    return result;
  }

  async guardFoodsForUse(
    foodIds: ObjectId[],
    workspaceId: ObjectId,
    ownerMembershipId: ObjectId,
    tx: TransactionContext,
  ) {
    const uniqueIds = [...new Map(foodIds.map((id) => [id.toHexString(), id])).values()];
    const foods: FoodDocument[] = [];
    for (const foodId of uniqueIds) {
      const food = await this.foods.findOneAndUpdate(
        {
          _id: foodId,
          status: 'ACTIVE',
          $or: [
            { scope: 'SYSTEM', workspaceId: null },
            { scope: 'GYM', workspaceId },
            { scope: 'PRIVATE', workspaceId, ownerMembershipId },
          ],
        },
        { $inc: { nutritionUseRevision: 1 } },
        { returnDocument: 'after', ...options(tx) },
      );
      if (!food) throw conflict('FOOD_ARCHIVED');
      foods.push(food);
    }
    return foods;
  }

  async createPlan(
    plan: NutritionPlanDocument,
    revision: NutritionPlanRevisionDocument,
    tx: TransactionContext,
  ) {
    await this.plans.insertOne(plan, options(tx));
    await this.revisions.insertOne(revision, options(tx));
    return { plan, revision };
  }

  async listPlans(workspaceId: ObjectId, relationshipId: ObjectId, limit = 50, afterId?: ObjectId) {
    return await this.plans
      .find({ workspaceId, relationshipId, ...(afterId ? { _id: { $gt: afterId } } : {}) })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
  }

  async findPlan(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    planId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.plans.findOne({ _id: planId, workspaceId, relationshipId }, options(tx));
  }

  async findActivePlan(workspaceId: ObjectId, relationshipId: ObjectId, tx?: TransactionContext) {
    return await this.plans.findOne({ workspaceId, relationshipId, status: 'ACTIVE' }, options(tx));
  }

  async findRevision(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    planId: ObjectId,
    revisionId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.revisions.findOne(
      { _id: revisionId, workspaceId, relationshipId, nutritionPlanId: planId },
      options(tx),
    );
  }

  async latestRevision(planId: ObjectId, tx?: TransactionContext) {
    return await this.revisions.findOne(
      { nutritionPlanId: planId },
      { sort: { revision: -1 }, ...options(tx) },
    );
  }

  async createRevision(
    plan: NutritionPlanDocument,
    expectedVersion: number,
    allowedStatuses: NutritionPlanStatus[],
    revision: NutritionPlanRevisionDocument,
    now: Date,
    tx: TransactionContext,
  ) {
    try {
      await this.revisions.insertOne(revision, options(tx));
      const updated = await this.plans.findOneAndUpdate(
        {
          _id: plan._id,
          workspaceId: plan.workspaceId,
          relationshipId: plan.relationshipId,
          status: { $in: allowedStatuses },
          version: expectedVersion,
        },
        { $set: { currentRevisionId: revision._id, updatedAt: now }, $inc: { version: 1 } },
        { returnDocument: 'after', ...options(tx) },
      );
      if (!updated) throw conflict('NUTRITION_PLAN_VERSION_CONFLICT');
      return { plan: updated, revision };
    } catch (error) {
      if (isDuplicate(error)) throw conflict('NUTRITION_PLAN_REVISION_CONFLICT');
      throw error;
    }
  }

  async activatePlan(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    planId: ObjectId;
    expectedVersion: number;
    now: Date;
    tx: TransactionContext;
  }) {
    try {
      const result = await this.plans.findOneAndUpdate(
        {
          _id: input.planId,
          workspaceId: input.workspaceId,
          relationshipId: input.relationshipId,
          status: 'DRAFT',
          version: input.expectedVersion,
        },
        {
          $set: { status: 'ACTIVE', startedAt: input.now, updatedAt: input.now },
          $inc: { version: 1 },
        },
        { returnDocument: 'after', ...options(input.tx) },
      );
      if (!result) throw conflict('NUTRITION_PLAN_VERSION_CONFLICT');
      return result;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('ACTIVE_NUTRITION_PLAN_CONFLICT');
      throw error;
    }
  }

  async replaceActivePlan(
    plan: NutritionPlanDocument,
    replacementPlanId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ) {
    const result = await this.plans.findOneAndUpdate(
      {
        _id: plan._id,
        workspaceId: plan.workspaceId,
        relationshipId: plan.relationshipId,
        status: 'ACTIVE',
      },
      {
        $set: {
          status: 'REPLACED',
          endedAt: now,
          replacedByPlanId: replacementPlanId,
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result) throw conflict('ACTIVE_NUTRITION_PLAN_CONFLICT');
    return result;
  }

  async completePlan(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    planId: ObjectId,
    expectedVersion: number,
    now: Date,
    tx: TransactionContext,
  ) {
    const result = await this.plans.findOneAndUpdate(
      { _id: planId, workspaceId, relationshipId, status: 'ACTIVE', version: expectedVersion },
      {
        $set: { status: 'COMPLETED', endedAt: now, completedAt: now, updatedAt: now },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result) throw conflict('NUTRITION_PLAN_STATUS_INVALID');
    return result;
  }

  async closeActivePlanForRelationshipEnd(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ) {
    return await this.plans.findOneAndUpdate(
      { workspaceId, relationshipId, status: 'ACTIVE' },
      {
        $set: { status: 'COMPLETED', endedAt: now, completedAt: now, updatedAt: now },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...options(tx) },
    );
  }

  async archivePlan(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    planId: ObjectId,
    expectedVersion: number,
    now: Date,
    tx: TransactionContext,
  ) {
    const result = await this.plans.findOneAndUpdate(
      {
        _id: planId,
        workspaceId,
        relationshipId,
        status: { $in: ['DRAFT', 'REPLACED', 'COMPLETED'] },
        version: expectedVersion,
      },
      { $set: { status: 'ARCHIVED', archivedAt: now, updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after', ...options(tx) },
    );
    if (!result) throw conflict('NUTRITION_PLAN_STATUS_INVALID');
    return result;
  }
}

function options(tx?: TransactionContext) {
  return tx ? { session: tx.session } : undefined;
}

function isDuplicate(error: unknown): error is MongoServerError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The nutrition state has changed.' });
}
