import { ObjectId } from 'mongodb';
import type { AccessControlService } from '../../core/access-control/access-control.service';
import type { AuditWriter } from '../../core/audit/audit.writer';
import type { TransactionContext, UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { OutboxWriter } from '../../core/events/outbox.writer';
import type { RequestContext } from '../../core/request-context/request-context';
import { Permissions } from '../permissions/permission.registry';
import type { EntitlementService } from '../subscriptions/subscription.service';
import type { CoachingRelationshipRepository } from '../trainees/trainee.repository';
import type { CoachingRelationshipDocument } from '../trainees/trainee.types';
import type { WorkspaceMembershipRepository } from '../workspaces/workspace.repository';
import type { WorkspaceMembershipDocument } from '../workspaces/workspace.types';
import type { NutritionRepository } from './nutrition.repository';
import type {
  CalculatedMacros,
  FoodDocument,
  FoodNames,
  FoodScope,
  FoodUnit,
  NutritionFoodSnapshot,
  NutritionMeal,
  NutritionPlanDocument,
  NutritionPlanRevisionDocument,
  NutritionSupplement,
  NutritionTargets,
} from './nutrition.types';

type FoodInput = {
  scope?: 'GYM' | 'PRIVATE';
  names: FoodNames;
  baseAmount: number;
  baseUnit: FoodUnit;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
};

type PlatformFoodInput = Omit<FoodInput, 'scope'>;

type FoodPatchInput = Partial<PlatformFoodInput> & { expectedVersion: number };

type PlanFoodItemInput = {
  foodId: string;
  selectedAmount: number;
  selectedUnit: FoodUnit;
  calculatedCalories?: number;
  calculatedProteinG?: number;
  calculatedCarbsG?: number;
  calculatedFatG?: number;
};

type AlternativeOptionInput = { optionKey?: string; order: number; items: PlanFoodItemInput[] };
type AlternativeGroupInput = {
  groupKey?: string;
  order: number;
  selectionRule?: 'CHOOSE_ONE';
  options: AlternativeOptionInput[];
};

type MealInput = {
  mealKey?: string;
  order: number;
  name: string;
  type?: 'REGULAR' | 'FLEXIBLE' | 'CHEAT';
  items?: PlanFoodItemInput[];
  alternativeGroups?: AlternativeGroupInput[];
  notes?: string;
};

type SupplementInput = {
  supplementKey?: string;
  order: number;
  name: string;
  amount?: number;
  unit?: string;
  timing?: string;
  notes?: string;
};

type RevisionInput = NutritionTargets & {
  meals: MealInput[];
  supplements?: SupplementInput[];
  notes?: string;
};

type CreatePlanInput = RevisionInput & {
  name: string;
  responsibleMembershipId?: string;
};

export interface NutritionRelationshipLifecyclePort {
  closeActiveNutritionPlanForRelationshipEnd(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ): Promise<void>;
}

export class NutritionApplicationService implements NutritionRelationshipLifecyclePort {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly nutrition: NutritionRepository,
    private readonly relationships: CoachingRelationshipRepository,
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly accessControl: AccessControlService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async listFoods(ctx: RequestContext, workspaceId: string, query: PageQuery) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.authorizeWorkspace(ctx, id, Permissions.FoodsRead);
    await this.entitlements.assert(id, 'READ');
    const membership = await this.actorMembership(ctx, id);
    const foodQuery = {
      workspaceId: id,
      ownerMembershipId: membership._id,
      ...(query.includeArchived !== undefined ? { includeArchived: query.includeArchived } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.cursor ? { afterId: objectId(query.cursor, 'CURSOR_INVALID') } : {}),
    };
    return page(await this.nutrition.listFoods(foodQuery), safeFood);
  }

  async createFood(ctx: RequestContext, workspaceId: string, input: FoodInput) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const scope = input.scope ?? 'GYM';
    if (scope !== 'GYM' && scope !== 'PRIVATE') throw invalid('FOOD_SCOPE_INVALID');
    const decision = await this.authorizeWorkspace(ctx, id, Permissions.FoodsCreate);
    await this.entitlements.assert(id, 'WRITE', 'nutrition');
    const membership = await this.actorMembership(ctx, id);
    assertWorkspaceFoodMutationScope(scope, membership, decision.source);
    const now = new Date();
    const food = buildFood(
      input,
      scope,
      id,
      scope === 'PRIVATE' ? membership._id : undefined,
      actorId(ctx),
      now,
    );
    return await this.unitOfWork.withTransaction(async (tx) => {
      const created = await this.nutrition.createFood(food, tx);
      await this.writeAudit(ctx, id, 'FoodCreated', created._id, 'create', tx);
      return { food: safeFood(created) };
    });
  }

  async listPlatformFoods(ctx: RequestContext, query: PageQuery) {
    await this.accessControl.authorize(ctx, {
      context: 'PLATFORM',
      permission: Permissions.SystemFoodsRead,
    });
    const foodQuery = {
      ...(query.includeArchived !== undefined ? { includeArchived: query.includeArchived } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.cursor ? { afterId: objectId(query.cursor, 'CURSOR_INVALID') } : {}),
    };
    return page(await this.nutrition.listFoods(foodQuery), safeFood);
  }

  async createPlatformFood(ctx: RequestContext, input: PlatformFoodInput) {
    await this.accessControl.authorize(ctx, {
      context: 'PLATFORM',
      permission: Permissions.SystemFoodsCreate,
    });
    const now = new Date();
    const food = buildFood(input, 'SYSTEM', null, undefined, actorId(ctx), now);
    return await this.unitOfWork.withTransaction(async (tx) => {
      const created = await this.nutrition.createFood(food, tx);
      await this.writeAudit(ctx, undefined, 'SystemFoodCreated', created._id, 'create', tx);
      return { food: safeFood(created) };
    });
  }

  async updateFood(
    ctx: RequestContext,
    workspaceId: string | undefined,
    foodId: string,
    input: FoodPatchInput,
    platform = false,
  ) {
    const id = platform ? undefined : objectId(workspaceId ?? '', 'WORKSPACE_NOT_FOUND');
    if (platform) {
      await this.accessControl.authorize(ctx, {
        context: 'PLATFORM',
        permission: Permissions.SystemFoodsUpdate,
      });
    } else {
      await this.authorizeWorkspace(ctx, id as ObjectId, Permissions.FoodsUpdate);
      await this.entitlements.assert(id as ObjectId, 'WRITE', 'nutrition');
    }
    const membership = id ? await this.actorMembership(ctx, id) : undefined;
    const patch = foodPatch(input, actorId(ctx), new Date());
    return await this.unitOfWork.withTransaction(async (tx) => {
      const food = await this.requireMutableFood(
        objectId(foodId, 'FOOD_NOT_FOUND'),
        id,
        membership,
        platform,
        tx,
      );
      const updated = await this.nutrition.updateFood(
        food._id,
        food.scope,
        food.workspaceId ?? null,
        food.ownerMembershipId ?? undefined,
        input.expectedVersion,
        patch,
        tx,
      );
      await this.writeAudit(
        ctx,
        id,
        platform ? 'SystemFoodUpdated' : 'FoodUpdated',
        updated._id,
        'update',
        tx,
      );
      return { food: safeFood(updated) };
    });
  }

  async archiveFood(
    ctx: RequestContext,
    workspaceId: string | undefined,
    foodId: string,
    input: { expectedVersion: number },
    platform = false,
  ) {
    const id = platform ? undefined : objectId(workspaceId ?? '', 'WORKSPACE_NOT_FOUND');
    if (platform) {
      await this.accessControl.authorize(ctx, {
        context: 'PLATFORM',
        permission: Permissions.SystemFoodsArchive,
      });
    } else {
      await this.authorizeWorkspace(ctx, id as ObjectId, Permissions.FoodsArchive);
      await this.entitlements.assert(id as ObjectId, 'WRITE', 'nutrition');
    }
    const membership = id ? await this.actorMembership(ctx, id) : undefined;
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const food = await this.requireMutableFood(
        objectId(foodId, 'FOOD_NOT_FOUND'),
        id,
        membership,
        platform,
        tx,
      );
      const archived = await this.nutrition.archiveFood(
        food._id,
        food.scope,
        food.workspaceId ?? null,
        food.ownerMembershipId ?? undefined,
        input.expectedVersion,
        now,
        tx,
      );
      await this.writeAudit(
        ctx,
        id,
        platform ? 'SystemFoodArchived' : 'FoodArchived',
        archived._id,
        'archive',
        tx,
      );
      return { food: safeFood(archived) };
    });
  }

  async listPlans(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    query: PageQuery,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.NutritionPlansRead,
      'read',
    );
    await this.entitlements.assert(ids.workspaceId, 'READ');
    return page(
      await this.nutrition.listPlans(
        ids.workspaceId,
        ids.relationship._id,
        query.limit,
        optionalObjectId(query.cursor, 'CURSOR_INVALID'),
      ),
      safePlan,
    );
  }

  async getPlan(ctx: RequestContext, workspaceId: string, relationshipId: string, planId: string) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.NutritionPlansRead,
      'read',
    );
    await this.entitlements.assert(ids.workspaceId, 'READ');
    const plan = await this.requirePlan(ids.workspaceId, ids.relationship._id, planId);
    const revision = await this.nutrition.findRevision(
      ids.workspaceId,
      ids.relationship._id,
      plan._id,
      plan.currentRevisionId,
    );
    return { plan: safePlan(plan), revision: revision ? safeRevision(revision) : null };
  }

  async createPlan(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: CreatePlanInput,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.NutritionPlansCreate,
      'mutate',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'nutrition');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const relationship = await this.relationships.guardNutritionLifecycleOpen(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const responsible = await this.resolveResponsible(
        ctx,
        ids.workspaceId,
        relationship,
        input.responsibleMembershipId,
        tx,
      );
      const revision = await this.buildRevision(
        ctx,
        ids.workspaceId,
        relationship._id,
        new ObjectId(),
        1,
        input,
        tx,
        now,
      );
      const plan: NutritionPlanDocument = {
        _id: revision.nutritionPlanId,
        workspaceId: ids.workspaceId,
        relationshipId: relationship._id,
        name: input.name.trim(),
        status: 'DRAFT',
        responsibleMembershipId: responsible._id,
        currentRevisionId: revision._id,
        version: 0,
        createdBy: actorId(ctx),
        createdAt: now,
        updatedAt: now,
      };
      const created = await this.nutrition.createPlan(plan, revision, tx);
      await this.writeAudit(ctx, ids.workspaceId, 'NutritionPlanCreated', plan._id, 'create', tx);
      return { plan: safePlan(created.plan), revision: safeRevision(created.revision) };
    });
  }

  async createRevision(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    planId: string,
    input: RevisionInput & { expectedVersion: number },
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.NutritionPlansUpdate,
      'mutate',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'nutrition');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const relationship = await this.relationships.guardNutritionLifecycleOpen(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const plan = await this.requirePlan(ids.workspaceId, relationship._id, planId, tx);
      if (!['DRAFT', 'ACTIVE'].includes(plan.status))
        throw conflict('NUTRITION_PLAN_STATUS_INVALID');
      await this.assertResponsibleStillEligible(
        ids.workspaceId,
        relationship,
        plan.responsibleMembershipId,
        tx,
      );
      const latest = await this.nutrition.latestRevision(plan._id, tx);
      const revision = await this.buildRevision(
        ctx,
        ids.workspaceId,
        relationship._id,
        plan._id,
        (latest?.revision ?? 0) + 1,
        input,
        tx,
        now,
      );
      const result = await this.nutrition.createRevision(
        plan,
        input.expectedVersion,
        ['DRAFT', 'ACTIVE'],
        revision,
        now,
        tx,
      );
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        'NutritionPlanUpdated',
        plan._id,
        'create_revision',
        tx,
      );
      if (plan.status === 'ACTIVE') {
        await this.writeOutbox(
          ctx,
          ids.workspaceId,
          'NutritionPlanUpdated',
          'nutrition_plan',
          plan._id,
          {
            relationshipId: relationship._id.toHexString(),
            nutritionPlanId: plan._id.toHexString(),
            nutritionPlanRevisionId: revision._id.toHexString(),
            revision: revision.revision,
          },
          tx,
        );
      }
      return { plan: safePlan(result.plan), revision: safeRevision(result.revision) };
    });
  }

  async activatePlan(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    planId: string,
    input: { expectedVersion: number },
    tx?: TransactionContext,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.NutritionPlansActivate,
      'mutate',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'nutrition');
    const preExistingActive = await this.nutrition.findActivePlan(
      ids.workspaceId,
      ids.relationship._id,
    );
    const now = new Date();
    return await this.withTransaction(tx, async (tx) => {
      const relationship = await this.relationships.guardNutritionLifecycleOpen(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const plan = await this.requirePlan(ids.workspaceId, relationship._id, planId, tx);
      if (plan.status !== 'DRAFT') throw conflict('NUTRITION_PLAN_STATUS_INVALID');
      if (plan.version !== input.expectedVersion) throw conflict('NUTRITION_PLAN_VERSION_CONFLICT');
      await this.assertResponsibleStillEligible(
        ids.workspaceId,
        relationship,
        plan.responsibleMembershipId,
        tx,
      );
      const revision = await this.requireCurrentRevision(
        ids.workspaceId,
        relationship._id,
        plan,
        tx,
      );
      await this.guardRevisionFoods(ids.workspaceId, actorMembershipId(ctx), revision, tx);
      const existing = await this.nutrition.findActivePlan(ids.workspaceId, relationship._id, tx);
      if (existing) {
        const activeWasCreatedByCompetingDraft =
          existing.startedAt && existing.startedAt.getTime() > plan.createdAt.getTime();
        if (
          !preExistingActive ||
          !existing._id.equals(preExistingActive._id) ||
          activeWasCreatedByCompetingDraft
        ) {
          throw conflict('ACTIVE_NUTRITION_PLAN_CONFLICT');
        }
        await this.nutrition.replaceActivePlan(existing, plan._id, now, tx);
        await this.writeAudit(
          ctx,
          ids.workspaceId,
          'NutritionPlanReplaced',
          existing._id,
          'replace',
          tx,
        );
      }
      const activated = await this.nutrition.activatePlan({
        workspaceId: ids.workspaceId,
        relationshipId: relationship._id,
        planId: plan._id,
        expectedVersion: input.expectedVersion,
        now,
        tx,
      });
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        'NutritionPlanActivated',
        activated._id,
        'activate',
        tx,
      );
      await this.writeOutbox(
        ctx,
        ids.workspaceId,
        'NutritionPlanActivated',
        'nutrition_plan',
        activated._id,
        {
          relationshipId: relationship._id.toHexString(),
          nutritionPlanId: activated._id.toHexString(),
          nutritionPlanRevisionId: activated.currentRevisionId.toHexString(),
          ...(existing ? { replacedNutritionPlanId: existing._id.toHexString() } : {}),
        },
        tx,
      );
      return { plan: safePlan(activated) };
    });
  }

  async completePlan(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    planId: string,
    input: { expectedVersion: number },
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.NutritionPlansComplete,
      'mutate',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'nutrition');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      await this.relationships.guardNutritionLifecycleOpen(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const completed = await this.nutrition.completePlan(
        ids.workspaceId,
        ids.relationship._id,
        objectId(planId, 'NUTRITION_PLAN_NOT_FOUND'),
        input.expectedVersion,
        now,
        tx,
      );
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        'NutritionPlanCompleted',
        completed._id,
        'complete',
        tx,
      );
      return { plan: safePlan(completed) };
    });
  }

  async archivePlan(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    planId: string,
    input: { expectedVersion: number },
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.NutritionPlansArchive,
      'mutate',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'nutrition');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      await this.relationships.guardNutritionLifecycleOpen(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const archived = await this.nutrition.archivePlan(
        ids.workspaceId,
        ids.relationship._id,
        objectId(planId, 'NUTRITION_PLAN_NOT_FOUND'),
        input.expectedVersion,
        now,
        tx,
      );
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        'NutritionPlanArchived',
        archived._id,
        'archive',
        tx,
      );
      return { plan: safePlan(archived) };
    });
  }

  async closeActiveNutritionPlanForRelationshipEnd(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ) {
    const closed = await this.nutrition.closeActivePlanForRelationshipEnd(
      workspaceId,
      relationshipId,
      now,
      tx,
    );
    if (!closed) return;
    await this.writeAudit(
      ctx,
      workspaceId,
      'NutritionPlanCompleted',
      closed._id,
      'relationship_end',
      tx,
    );
  }

  private async authorizedRelationship(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    permission: string,
    action: 'read' | 'mutate',
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relationship = await this.relationships.findByIdInWorkspace(
      id,
      objectId(relationshipId, 'RELATIONSHIP_NOT_FOUND'),
    );
    if (!relationship) throw notFound('RELATIONSHIP_NOT_FOUND');
    await this.assertRelationshipAccess(ctx, id, relationship, permission, action);
    return { workspaceId: id, relationship };
  }

  private async assertRelationshipAccess(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationship: CoachingRelationshipDocument,
    permission: string,
    action: 'read' | 'mutate',
  ) {
    await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId,
      permission,
      scope: { type: 'WORKSPACE' },
    });
    const membership = await this.actorMembership(ctx, workspaceId);
    if (membership.roles.includes('GYM_OWNER')) return;
    if (membership.roles.includes('GYM_MANAGER')) return;
    if (isTraineeSelf(ctx, relationship)) {
      if (action === 'read') return;
      throw forbidden();
    }
    const assignments = await this.relationships.listActiveAssignments(relationship._id);
    const assigned = assignments.some(
      (assignment) =>
        assignment.staffMembershipId.equals(membership._id) &&
        (assignment.assignmentType === 'NUTRITIONIST' ||
          assignment.assignmentType === 'PRIMARY_TRAINER'),
    );
    if (assigned) return;
    throw forbidden();
  }

  private async resolveResponsible(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationship: CoachingRelationshipDocument,
    responsibleMembershipId: string | undefined,
    tx: TransactionContext,
  ) {
    const actor = await this.actorMembership(ctx, workspaceId, tx);
    const target = responsibleMembershipId
      ? objectId(responsibleMembershipId, 'NUTRITION_RESPONSIBLE_MEMBERSHIP_INVALID')
      : actor._id;
    const membership = await this.memberships.findByIdInWorkspace(workspaceId, target, tx);
    if (membership?.status !== 'ACTIVE') throw conflict('NUTRITION_RESPONSIBLE_MEMBERSHIP_INVALID');
    await this.assertResponsibleStillEligible(workspaceId, relationship, membership._id, tx);
    return membership;
  }

  private async assertResponsibleStillEligible(
    workspaceId: ObjectId,
    relationship: CoachingRelationshipDocument,
    membershipId: ObjectId,
    tx: TransactionContext,
  ) {
    const membership = await this.memberships.findByIdInWorkspace(workspaceId, membershipId, tx);
    if (membership?.status !== 'ACTIVE') throw conflict('NUTRITION_RESPONSIBLE_MEMBERSHIP_INVALID');
    const assignments = await this.relationships.listActiveAssignments(relationship._id, tx);
    const assigned = assignments.some(
      (assignment) =>
        assignment.staffMembershipId.equals(membershipId) &&
        ['NUTRITIONIST', 'PRIMARY_TRAINER'].includes(assignment.assignmentType),
    );
    if (
      !assigned &&
      !membership.roles.includes('GYM_OWNER') &&
      !membership.roles.includes('GYM_MANAGER')
    ) {
      throw conflict('NUTRITION_RESPONSIBLE_MEMBERSHIP_INVALID');
    }
  }

  private async buildRevision(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    planId: ObjectId,
    revisionNumber: number,
    input: RevisionInput,
    tx: TransactionContext,
    now: Date,
  ): Promise<NutritionPlanRevisionDocument> {
    const ownerMembershipId = actorMembershipId(ctx);
    const foodIds = foodIdsFromInput(input);
    const guardedFoods = await this.nutrition.guardFoodsForUse(
      foodIds,
      workspaceId,
      ownerMembershipId,
      tx,
    );
    const foodMap = new Map(guardedFoods.map((food) => [food._id.toHexString(), food]));
    const meals = input.meals.map((meal) => buildMeal(meal, foodMap));
    const totals = totalsFromMeals(meals);
    return {
      _id: new ObjectId(),
      workspaceId,
      relationshipId,
      nutritionPlanId: planId,
      revision: revisionNumber,
      ...targets(input),
      ...totals,
      meals,
      supplements: (input.supplements ?? []).map(buildSupplement),
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      createdBy: actorId(ctx),
      createdAt: now,
    };
  }

  private async guardRevisionFoods(
    workspaceId: ObjectId,
    ownerMembershipId: ObjectId,
    revision: NutritionPlanRevisionDocument,
    tx: TransactionContext,
  ) {
    await this.nutrition.guardFoodsForUse(
      revisionFoodIds(revision),
      workspaceId,
      ownerMembershipId,
      tx,
    );
  }

  private async requirePlan(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    planId: string,
    tx?: TransactionContext,
  ) {
    const plan = await this.nutrition.findPlan(
      workspaceId,
      relationshipId,
      objectId(planId, 'NUTRITION_PLAN_NOT_FOUND'),
      tx,
    );
    if (!plan) throw notFound('NUTRITION_PLAN_NOT_FOUND');
    return plan;
  }

  private async requireCurrentRevision(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    plan: NutritionPlanDocument,
    tx: TransactionContext,
  ) {
    const revision = await this.nutrition.findRevision(
      workspaceId,
      relationshipId,
      plan._id,
      plan.currentRevisionId,
      tx,
    );
    if (!revision) throw conflict('NUTRITION_PLAN_REVISION_CONFLICT');
    return revision;
  }

  private async actorMembership(
    ctx: RequestContext,
    workspaceId: ObjectId,
    tx?: TransactionContext,
  ) {
    const membership = await this.memberships.findByUserInWorkspace(workspaceId, actorId(ctx), tx);
    if (membership?.status !== 'ACTIVE') throw forbidden();
    ctx.workspaceMembershipId = membership._id.toHexString();
    return membership;
  }

  private async authorizeWorkspace(ctx: RequestContext, workspaceId: ObjectId, permission: string) {
    return await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId,
      permission,
      scope: { type: 'WORKSPACE' },
    });
  }

  private async requireMutableFood(
    foodId: ObjectId,
    workspaceId: ObjectId | undefined,
    membership: WorkspaceMembershipDocument | undefined,
    platform: boolean,
    tx: TransactionContext,
  ) {
    const food = await this.nutrition.findFood(foodId, tx);
    if (food?.status !== 'ACTIVE') throw notFound('FOOD_NOT_FOUND');
    if (platform) {
      if (food.scope !== 'SYSTEM' || food.workspaceId !== null) throw notFound('FOOD_NOT_FOUND');
      return food;
    }
    if (!workspaceId || !membership) throw notFound('FOOD_NOT_FOUND');
    if (food.scope === 'GYM' && food.workspaceId?.equals(workspaceId)) return food;
    if (
      food.scope === 'PRIVATE' &&
      food.workspaceId?.equals(workspaceId) &&
      food.ownerMembershipId?.equals(membership._id)
    ) {
      return food;
    }
    throw notFound('FOOD_NOT_FOUND');
  }

  private async withTransaction<T>(
    tx: TransactionContext | undefined,
    operation: (tx: TransactionContext) => Promise<T>,
  ) {
    if (tx) return await operation(tx);
    return await this.unitOfWork.withTransaction(operation);
  }

  private async writeAudit(
    ctx: RequestContext,
    workspaceId: ObjectId | undefined,
    eventType: string,
    entityId: ObjectId,
    action: string,
    tx: TransactionContext,
  ) {
    await this.audit.write(
      {
        eventType,
        ...(workspaceId ? { workspaceId } : {}),
        actor: {
          userId: actorId(ctx),
          ...(ctx.workspaceMembershipId && ObjectId.isValid(ctx.workspaceMembershipId)
            ? { workspaceMembershipId: new ObjectId(ctx.workspaceMembershipId) }
            : {}),
        },
        entity: { type: eventType, id: entityId },
        action,
        ipAddress: ctx.ipAddress,
        ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }

  private async writeOutbox(
    ctx: RequestContext,
    workspaceId: ObjectId,
    eventType: string,
    aggregateType: string,
    aggregateId: ObjectId,
    payload: Record<string, unknown>,
    tx: TransactionContext,
  ) {
    await this.outbox.write(
      {
        eventType,
        aggregateType,
        aggregateId,
        workspaceId,
        payload,
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }
}

interface PageQuery {
  cursor?: string;
  limit?: number;
  includeArchived?: boolean;
}

function buildFood(
  input: PlatformFoodInput,
  scope: FoodScope,
  workspaceId: ObjectId | null,
  ownerMembershipId: ObjectId | undefined,
  actor: ObjectId,
  now: Date,
): FoodDocument {
  assertFoodInput(input);
  return {
    _id: new ObjectId(),
    scope,
    workspaceId,
    ...(ownerMembershipId ? { ownerMembershipId } : {}),
    names: compactNames(input.names),
    normalizedNames: normalizedNames(input.names),
    baseAmount: normalize2(input.baseAmount),
    baseUnit: input.baseUnit,
    calories: normalize2(input.calories),
    proteinG: normalize2(input.proteinG),
    carbsG: normalize2(input.carbsG),
    fatG: normalize2(input.fatG),
    status: 'ACTIVE',
    version: 0,
    nutritionUseRevision: 0,
    createdBy: actor,
    updatedBy: actor,
    createdAt: now,
    updatedAt: now,
  };
}

function foodPatch(input: FoodPatchInput, actor: ObjectId, now: Date): Partial<FoodDocument> {
  const patch: Partial<FoodDocument> = { updatedBy: actor, updatedAt: now };
  if (input.names) {
    const names = compactNames(input.names);
    patch.names = names;
    patch.normalizedNames = normalizedNames(names);
  }
  if (input.baseAmount !== undefined) patch.baseAmount = positive(input.baseAmount, 'baseAmount');
  if (input.baseUnit !== undefined) patch.baseUnit = input.baseUnit;
  if (input.calories !== undefined) patch.calories = nonNegative(input.calories, 'calories');
  if (input.proteinG !== undefined) patch.proteinG = nonNegative(input.proteinG, 'proteinG');
  if (input.carbsG !== undefined) patch.carbsG = nonNegative(input.carbsG, 'carbsG');
  if (input.fatG !== undefined) patch.fatG = nonNegative(input.fatG, 'fatG');
  return patch;
}

function buildMeal(input: MealInput, foods: Map<string, FoodDocument>): NutritionMeal {
  const items = (input.items ?? []).map((item) => snapshotItem(item, foods));
  return {
    mealKey: input.mealKey?.trim() || new ObjectId().toHexString(),
    order: input.order,
    name: input.name.trim(),
    type: input.type ?? 'REGULAR',
    items,
    alternativeGroups: (input.alternativeGroups ?? []).map((group) => ({
      groupKey: group.groupKey?.trim() || new ObjectId().toHexString(),
      order: group.order,
      selectionRule: 'CHOOSE_ONE',
      options: group.options.map((option) => ({
        optionKey: option.optionKey?.trim() || new ObjectId().toHexString(),
        order: option.order,
        items: option.items.map((item) => snapshotItem(item, foods)),
      })),
    })),
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
  };
}

function snapshotItem(
  input: PlanFoodItemInput,
  foods: Map<string, FoodDocument>,
): NutritionFoodSnapshot {
  const food = foods.get(input.foodId);
  if (!food) throw conflict('FOOD_ARCHIVED');
  const amount = positive(input.selectedAmount, 'selectedAmount');
  if (input.selectedUnit !== food.baseUnit) throw invalid('FOOD_UNIT_MISMATCH');
  const ratio = amount / food.baseAmount;
  return {
    foodId: food._id,
    foodNameSnapshot: food.names.en ?? food.names.ar ?? '',
    foodScopeSnapshot: food.scope,
    ...(food.workspaceId ? { foodWorkspaceIdSnapshot: food.workspaceId } : {}),
    baseAmountSnapshot: food.baseAmount,
    baseUnitSnapshot: food.baseUnit,
    caloriesSnapshot: food.calories,
    proteinGSnapshot: food.proteinG,
    carbsGSnapshot: food.carbsG,
    fatGSnapshot: food.fatG,
    selectedAmount: normalize2(amount),
    selectedUnit: input.selectedUnit,
    calculatedCalories: normalize2(food.calories * ratio),
    calculatedProteinG: normalize2(food.proteinG * ratio),
    calculatedCarbsG: normalize2(food.carbsG * ratio),
    calculatedFatG: normalize2(food.fatG * ratio),
  };
}

function totalsFromMeals(meals: NutritionMeal[]): CalculatedMacros {
  const items = meals.flatMap((meal) => meal.items);
  return {
    calculatedCalories: normalize2(sum(items.map((item) => item.calculatedCalories))),
    calculatedProteinG: normalize2(sum(items.map((item) => item.calculatedProteinG))),
    calculatedCarbsG: normalize2(sum(items.map((item) => item.calculatedCarbsG))),
    calculatedFatG: normalize2(sum(items.map((item) => item.calculatedFatG))),
  };
}

function buildSupplement(input: SupplementInput): NutritionSupplement {
  return {
    supplementKey: input.supplementKey?.trim() || new ObjectId().toHexString(),
    order: input.order,
    name: input.name.trim(),
    ...(input.amount !== undefined ? { amount: positive(input.amount, 'amount') } : {}),
    ...(input.unit?.trim() ? { unit: input.unit.trim() } : {}),
    ...(input.timing?.trim() ? { timing: input.timing.trim() } : {}),
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
  };
}

function targets(input: NutritionTargets): NutritionTargets {
  return {
    ...(input.targetCalories !== undefined
      ? { targetCalories: positive(input.targetCalories, 'targetCalories') }
      : {}),
    ...(input.targetProteinG !== undefined
      ? { targetProteinG: positive(input.targetProteinG, 'targetProteinG') }
      : {}),
    ...(input.targetCarbsG !== undefined
      ? { targetCarbsG: positive(input.targetCarbsG, 'targetCarbsG') }
      : {}),
    ...(input.targetFatG !== undefined
      ? { targetFatG: positive(input.targetFatG, 'targetFatG') }
      : {}),
    ...(input.waterTargetMl !== undefined
      ? { waterTargetMl: positive(input.waterTargetMl, 'waterTargetMl') }
      : {}),
  };
}

function foodIdsFromInput(input: RevisionInput) {
  return input.meals.flatMap((meal) => [
    ...(meal.items ?? []).map((item) => objectId(item.foodId, 'FOOD_NOT_FOUND')),
    ...(meal.alternativeGroups ?? []).flatMap((group) =>
      group.options.flatMap((option) =>
        option.items.map((item) => objectId(item.foodId, 'FOOD_NOT_FOUND')),
      ),
    ),
  ]);
}

function revisionFoodIds(revision: NutritionPlanRevisionDocument) {
  return revision.meals.flatMap((meal) => [
    ...meal.items.map((item) => item.foodId),
    ...meal.alternativeGroups.flatMap((group) =>
      group.options.flatMap((option) => option.items.map((item) => item.foodId)),
    ),
  ]);
}

function assertFoodInput(input: PlatformFoodInput) {
  compactNames(input.names);
  positive(input.baseAmount, 'baseAmount');
  nonNegative(input.calories, 'calories');
  nonNegative(input.proteinG, 'proteinG');
  nonNegative(input.carbsG, 'carbsG');
  nonNegative(input.fatG, 'fatG');
}

function compactNames(names: FoodNames): FoodNames {
  const compact = {
    ...(names.ar?.trim() ? { ar: names.ar.trim() } : {}),
    ...(names.en?.trim() ? { en: names.en.trim() } : {}),
  };
  if (!compact.ar && !compact.en) throw invalid('FOOD_NAME_REQUIRED');
  return compact;
}

function normalizedNames(names: FoodNames) {
  return [
    ...new Set(
      Object.values(compactNames(names))
        .map((name) => name.toLowerCase().trim())
        .filter(Boolean),
    ),
  ];
}

function safeFood(food: FoodDocument) {
  return {
    id: food._id.toHexString(),
    scope: food.scope,
    ...(food.workspaceId ? { workspaceId: food.workspaceId.toHexString() } : {}),
    names: food.names,
    baseAmount: food.baseAmount,
    baseUnit: food.baseUnit,
    calories: food.calories,
    proteinG: food.proteinG,
    carbsG: food.carbsG,
    fatG: food.fatG,
    status: food.status,
    version: food.version,
  };
}

function safePlan(plan: NutritionPlanDocument) {
  return {
    id: plan._id.toHexString(),
    workspaceId: plan.workspaceId.toHexString(),
    relationshipId: plan.relationshipId.toHexString(),
    name: plan.name,
    status: plan.status,
    responsibleMembershipId: plan.responsibleMembershipId.toHexString(),
    currentRevisionId: plan.currentRevisionId.toHexString(),
    startedAt: plan.startedAt,
    endedAt: plan.endedAt,
    version: plan.version,
  };
}

function safeRevision(revision: NutritionPlanRevisionDocument) {
  return {
    id: revision._id.toHexString(),
    nutritionPlanId: revision.nutritionPlanId.toHexString(),
    revision: revision.revision,
    targetCalories: revision.targetCalories,
    targetProteinG: revision.targetProteinG,
    targetCarbsG: revision.targetCarbsG,
    targetFatG: revision.targetFatG,
    waterTargetMl: revision.waterTargetMl,
    calculatedCalories: revision.calculatedCalories,
    calculatedProteinG: revision.calculatedProteinG,
    calculatedCarbsG: revision.calculatedCarbsG,
    calculatedFatG: revision.calculatedFatG,
    meals: revision.meals.map((meal) => ({
      ...meal,
      items: meal.items.map(safeSnapshot),
      alternativeGroups: meal.alternativeGroups.map((group) => ({
        ...group,
        options: group.options.map((option) => ({
          ...option,
          items: option.items.map(safeSnapshot),
        })),
      })),
    })),
    supplements: revision.supplements,
    notes: revision.notes,
  };
}

function safeSnapshot(item: NutritionFoodSnapshot) {
  return {
    ...item,
    foodId: item.foodId.toHexString(),
    foodWorkspaceIdSnapshot: item.foodWorkspaceIdSnapshot?.toHexString(),
  };
}

function page<T extends { _id: ObjectId }, R>(items: T[], map: (item: T) => R) {
  return { data: items.map(map), nextCursor: items.at(-1)?._id.toHexString() };
}

function actorId(ctx: RequestContext) {
  if (!ctx.userId || !ObjectId.isValid(ctx.userId)) throw forbidden();
  return new ObjectId(ctx.userId);
}

function actorMembershipId(ctx: RequestContext) {
  if (!ctx.workspaceMembershipId || !ObjectId.isValid(ctx.workspaceMembershipId)) throw forbidden();
  return new ObjectId(ctx.workspaceMembershipId);
}

function isTraineeSelf(ctx: RequestContext, relationship: CoachingRelationshipDocument) {
  return Boolean(ctx.userId && relationship.traineeUserId.equals(new ObjectId(ctx.userId)));
}

function objectId(value: string, code: string) {
  if (!ObjectId.isValid(value)) throw notFound(code);
  return new ObjectId(value);
}

function optionalObjectId(value: string | undefined, code: string) {
  return value ? objectId(value, code) : undefined;
}

function positive(value: number, _field: string) {
  if (!Number.isFinite(value) || value <= 0) throw invalid('NUTRITION_VALUE_INVALID');
  return normalize2(value);
}

function nonNegative(value: number, _field: string) {
  if (!Number.isFinite(value) || value < 0) throw invalid('NUTRITION_VALUE_INVALID');
  return normalize2(value);
}

function normalize2(value: number) {
  return Math.round(value * 100) / 100;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function assertWorkspaceFoodMutationScope(
  scope: 'GYM' | 'PRIVATE',
  membership: WorkspaceMembershipDocument,
  decisionSource: 'EXPLICIT_GRANT' | 'PROFILE' | 'NONE',
) {
  if (scope === 'PRIVATE') return;
  if (membership.roles.includes('GYM_OWNER') || membership.roles.includes('GYM_MANAGER')) return;
  if (decisionSource === 'EXPLICIT_GRANT') return;
  throw forbidden();
}

function invalid(code: string) {
  return new AppError({ code, httpStatus: 422, message: 'The nutrition request is invalid.' });
}

function conflict(code: string) {
  return new AppError({ code, httpStatus: 409, message: 'The nutrition state has changed.' });
}

function notFound(code: string) {
  return new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
}

function forbidden() {
  return new AppError({
    code: 'PERMISSION_DENIED',
    httpStatus: 403,
    message: 'Permission denied.',
  });
}
