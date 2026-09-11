import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Db, ObjectId } from 'mongodb';
import type { AppContainer } from '../src/bootstrap/app-container';
import { createAppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';
import { migrations } from '../src/migrations';
import { migration015Stage10Nutrition } from '../src/migrations/015-stage10-nutrition';
import { MigrationRunner } from '../src/migrations/migration-runner';
import {
  Permissions,
  systemPermissionProfiles,
} from '../src/modules/permissions/permission.registry';

describe('Stage 10 migration 015', () => {
  test('creates nutrition collections, indexes, and permission seeds without Stage 11 collections', async () => {
    const calls: Array<{ collection: string; indexes: unknown[] }> = [];
    const updates: Array<{ collection: string; filter: unknown; update: unknown }> = [];
    const db = {
      collection(name: string) {
        return {
          async createIndexes(indexes: unknown[]) {
            calls.push({ collection: name, indexes });
          },
          async findOne() {
            return { _id: new ObjectId() };
          },
          async updateOne(filter: unknown, update: unknown) {
            updates.push({ collection: name, filter, update });
          },
          find() {
            return {
              async toArray() {
                return [{ _id: new ObjectId() }];
              },
            };
          },
        };
      },
    };

    await migration015Stage10Nutrition.up(db as never);

    expect(indexes(calls, 'foods')).toContainEqual(
      expect.objectContaining({
        name: 'foods_active_normalized_name_unique',
        unique: true,
        partialFilterExpression: { status: 'ACTIVE' },
      }),
    );
    expect(indexes(calls, 'nutrition_plans')).toContainEqual(
      expect.objectContaining({
        name: 'nutrition_plans_one_active_per_relationship',
        unique: true,
        partialFilterExpression: { status: 'ACTIVE' },
      }),
    );
    expect(indexes(calls, 'nutrition_plan_revisions')).toContainEqual(
      expect.objectContaining({
        name: 'nutrition_plan_revisions_plan_revision_unique',
        unique: true,
      }),
    );
    expect(indexes(calls, 'measurements')).toBeUndefined();
    expect(indexes(calls, 'daily_nutrition_logs')).toBeUndefined();
    expect(indexes(calls, 'nutrition_templates')).toBeUndefined();
    expect(JSON.stringify(updates)).toContain('foods.read');
    expect(JSON.stringify(updates)).toContain('system_foods.archive');
    expect(JSON.stringify(updates)).toContain('nutrition.plans.activate');
  });

  test('runs clean 001-015, upgrade 001-014 to 015, and reruns idempotently', async () => {
    const clean = await createAppContainer(
      integrationConfig(`stage10_clean_${new ObjectId().toHexString()}`),
    );
    const upgrade = await createAppContainer(
      integrationConfig(`stage10_upgrade_${new ObjectId().toHexString()}`),
    );
    try {
      await new MigrationRunner(clean.database.db, migrations).migrate();
      await assertStage10DbShape(clean.database.db);

      const through14 = migrations.filter((migration) => migration.id !== '015-stage10-nutrition');
      await new MigrationRunner(upgrade.database.db, through14).migrate();
      expect(
        await upgrade.database.db
          .collection('db_migrations')
          .countDocuments({ migrationId: '014-stage9-workout-execution' }),
      ).toBe(1);
      expect(await upgrade.database.db.listCollections({ name: 'foods' }).hasNext()).toBe(false);
      await new MigrationRunner(upgrade.database.db, migrations).migrate();
      await new MigrationRunner(upgrade.database.db, migrations).migrate();
      await assertStage10DbShape(upgrade.database.db);
    } finally {
      await clean.database.db.dropDatabase();
      await clean.database.close();
      await upgrade.database.db.dropDatabase();
      await upgrade.database.close();
    }
  }, 30_000);
});

describe('Stage 10 nutrition integration', () => {
  let container: AppContainer;
  let db: Db;

  beforeAll(async () => {
    container = await createAppContainer(
      integrationConfig(`stage10_${new ObjectId().toHexString()}`),
    );
    db = container.database.db;
    await new MigrationRunner(db, migrations).migrate();
  }, 30_000);

  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (container) await container.database.close();
  }, 30_000);

  test('SYSTEM, GYM and PRIVATE foods obey scope, duplicate, archive, and raw-id access rules', async () => {
    const seed = await seedGym(container);
    const other = await seedGym(container);
    const platform = await seedPlatformAdmin(container);
    const nutritionist = await seedNutritionist(container, seed);
    const otherNutritionist = await seedNutritionist(container, seed);

    const system = await container.nutrition.createPlatformFood(platform.ctx, foodInput('Rice'));
    await expect(
      container.nutrition.createPlatformFood(platform.ctx, foodInput(' rice ')),
    ).rejects.toMatchObject({ code: 'FOOD_NAME_CONFLICT' });
    await container.nutrition.archiveFood(
      platform.ctx,
      undefined,
      system.food.id,
      { expectedVersion: system.food.version },
      true,
    );
    await expect(
      container.nutrition.createPlatformFood(platform.ctx, foodInput('Rice')),
    ).resolves.toMatchObject({ food: { status: 'ACTIVE', scope: 'SYSTEM' } });

    const gym = await container.nutrition.createFood(seed.ownerCtx, seed.workspaceId, {
      ...foodInput('Oats'),
      scope: 'GYM',
    });
    expect(gym.food.scope).toBe('GYM');
    await expect(
      container.nutrition.createFood(seed.ownerCtx, seed.workspaceId, {
        ...foodInput('  oats '),
        scope: 'GYM',
      }),
    ).rejects.toMatchObject({ code: 'FOOD_NAME_CONFLICT' });
    await expect(
      container.nutrition.createFood(other.ownerCtx, other.workspaceId, {
        ...foodInput('Oats'),
        scope: 'GYM',
      }),
    ).resolves.toMatchObject({ food: { scope: 'GYM' } });

    const privateFood = await container.nutrition.createFood(nutritionist.ctx, seed.workspaceId, {
      ...foodInput('Private Shake'),
      scope: 'PRIVATE',
    });
    await expect(
      container.nutrition.createFood(nutritionist.ctx, seed.workspaceId, {
        ...foodInput('private shake'),
        scope: 'PRIVATE',
      }),
    ).rejects.toMatchObject({ code: 'FOOD_NAME_CONFLICT' });
    await expect(
      container.nutrition.createFood(otherNutritionist.ctx, seed.workspaceId, {
        ...foodInput('Private Shake'),
        scope: 'PRIVATE',
      }),
    ).resolves.toMatchObject({ food: { scope: 'PRIVATE' } });
    await expect(
      container.nutrition.createFood(seed.ownerCtx, seed.workspaceId, {
        ...foodInput('Cross Field', { ar: 'same-key' }),
        scope: 'GYM',
      }),
    ).resolves.toMatchObject({ food: { status: 'ACTIVE' } });
    await expect(
      container.nutrition.createFood(seed.ownerCtx, seed.workspaceId, {
        ...foodInput('same-key'),
        scope: 'GYM',
      }),
    ).rejects.toMatchObject({ code: 'FOOD_NAME_CONFLICT' });
    await expect(
      container.nutrition.createFood(nutritionist.ctx, seed.workspaceId, {
        ...foodInput('Shared Default Blocked'),
        scope: 'GYM',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      createSimplePlan(container, seed, seed.ownerCtx, [privateFood.food.id]),
    ).rejects.toMatchObject({ code: 'FOOD_ARCHIVED' });
  });

  test('macro calculation is server-authoritative, unit-safe, rounded, and excludes alternatives', async () => {
    const seed = await seedGym(container);
    const food = await container.nutrition.createFood(seed.ownerCtx, seed.workspaceId, {
      ...foodInput('Macro Rice'),
      baseAmount: 100,
      baseUnit: 'GRAM',
      calories: 200,
      proteinG: 10,
      carbsG: 20,
      fatG: 5,
      scope: 'GYM',
    });
    const alt = await container.nutrition.createFood(seed.ownerCtx, seed.workspaceId, {
      ...foodInput('Alternative Milk'),
      baseAmount: 250,
      baseUnit: 'MILLILITER',
      calories: 123.333,
      proteinG: 8.333,
      carbsG: 11.111,
      fatG: 2.555,
      scope: 'GYM',
    });

    await expect(
      createSimplePlan(container, seed, seed.ownerCtx, [food.food.id], {
        selectedUnit: 'MILLILITER',
      }),
    ).rejects.toMatchObject({ code: 'FOOD_UNIT_MISMATCH' });

    const plan = await createSimplePlan(container, seed, seed.ownerCtx, [food.food.id], {
      selectedAmount: 150,
      fakeCalculatedCalories: 9999,
      alternativeFoodId: alt.food.id,
    });
    expect(plan.revision.meals[0]?.items[0]).toMatchObject({
      selectedAmount: 150,
      selectedUnit: 'GRAM',
      calculatedCalories: 300,
      calculatedProteinG: 15,
      calculatedCarbsG: 30,
      calculatedFatG: 7.5,
    });
    expect(plan.revision.calculatedCalories).toBe(300);
    expect(plan.revision.meals[0]?.alternativeGroups[0]?.options[0]?.items[0]).toMatchObject({
      selectedUnit: 'MILLILITER',
      selectedAmount: 500,
      calculatedCalories: 246.66,
      calculatedProteinG: 16.66,
    });
    expect(plan.revision.waterTargetMl).toBe(2500);

    const unit = await container.nutrition.createFood(seed.ownerCtx, seed.workspaceId, {
      ...foodInput('Egg Unit'),
      baseAmount: 1,
      baseUnit: 'UNIT',
      calories: 71,
      proteinG: 6.25,
      carbsG: 0.4,
      fatG: 5,
      scope: 'GYM',
    });
    const serving = await container.nutrition.createFood(seed.ownerCtx, seed.workspaceId, {
      ...foodInput('Protein Serving'),
      baseAmount: 1,
      baseUnit: 'SERVING',
      calories: 101,
      proteinG: 20,
      carbsG: 3,
      fatG: 1,
      scope: 'GYM',
    });
    const unitPlan = await createSimplePlan(container, seed, seed.ownerCtx, [unit.food.id], {
      selectedUnit: 'UNIT',
      selectedAmount: 2,
    });
    const servingPlan = await createSimplePlan(container, seed, seed.ownerCtx, [serving.food.id], {
      selectedUnit: 'SERVING',
      selectedAmount: 1.5,
    });
    expect(unitPlan.revision.calculatedCalories).toBe(142);
    expect(servingPlan.revision.calculatedCalories).toBe(151.5);
  });

  test('food snapshots are immutable and new revisions snapshot current Food state through the use guard', async () => {
    const seed = await seedGym(container);
    const food = await container.nutrition.createFood(seed.ownerCtx, seed.workspaceId, {
      ...foodInput('Snapshot Chicken'),
      scope: 'GYM',
      calories: 100,
    });
    const plan = await createSimplePlan(container, seed, seed.ownerCtx, [food.food.id]);
    await container.nutrition.updateFood(seed.ownerCtx, seed.workspaceId, food.food.id, {
      expectedVersion: food.food.version,
      names: { en: 'Snapshot Chicken Updated' },
      calories: 120,
    });
    const old = await container.nutrition.getPlan(
      seed.ownerCtx,
      seed.workspaceId,
      seed.relationshipId,
      plan.plan.id,
    );
    expect(old.revision?.meals[0]?.items[0]).toMatchObject({
      foodNameSnapshot: 'Snapshot Chicken',
      caloriesSnapshot: 100,
    });
    const next = await container.nutrition.createRevision(
      seed.ownerCtx,
      seed.workspaceId,
      seed.relationshipId,
      plan.plan.id,
      { ...revisionInput([food.food.id]), expectedVersion: plan.plan.version },
    );
    expect(next.revision.meals[0]?.items[0]).toMatchObject({
      foodNameSnapshot: 'Snapshot Chicken Updated',
      caloriesSnapshot: 120,
    });
    const usedFood = await db.collection('foods').findOne({ _id: new ObjectId(food.food.id) });
    expect(usedFood?.version).toBe(1);
    expect(usedFood?.nutritionUseRevision).toBeGreaterThanOrEqual(2);
  });

  test('activation, replacement, idempotency, archived food revalidation, and ACTIVE edits are transactional', async () => {
    const seed = await seedGym(container);
    const food = await ownerFood(container, seed, 'Activation Food');
    const first = await createSimplePlan(container, seed, seed.ownerCtx, [food.food.id], {
      name: 'First',
    });
    const activation = await activateIdempotently(
      container,
      seed,
      first.plan.id,
      first.plan.version,
      'same-key',
    );
    expect(activation.body.plan.status).toBe('ACTIVE');
    const replay = await activateIdempotently(
      container,
      seed,
      first.plan.id,
      first.plan.version,
      'same-key',
    );
    expect(replay.replayed).toBe(true);
    await expect(
      activateIdempotently(container, seed, first.plan.id, first.plan.version, 'same-key', {
        expectedVersion: first.plan.version + 1,
      }),
    ).rejects.toHaveProperty('code', 'IDEMPOTENCY_KEY_REUSED');

    const second = await createSimplePlan(container, seed, seed.ownerCtx, [food.food.id], {
      name: 'Second',
    });
    const replaced = await activateIdempotently(
      container,
      seed,
      second.plan.id,
      second.plan.version,
      'second-key',
    );
    expect(replaced.body.plan.status).toBe('ACTIVE');
    expect(
      await db.collection('nutrition_plans').findOne({ _id: new ObjectId(first.plan.id) }),
    ).toMatchObject({ status: 'REPLACED' });

    const activeRevision = await container.nutrition.createRevision(
      seed.ownerCtx,
      seed.workspaceId,
      seed.relationshipId,
      second.plan.id,
      { ...revisionInput([food.food.id], { notes: 'active update' }), expectedVersion: 1 },
    );
    expect(activeRevision.plan.status).toBe('ACTIVE');
    expect(
      await db.collection('outbox_events').countDocuments({ eventType: 'NutritionPlanUpdated' }),
    ).toBe(1);

    const draft = await createSimplePlan(container, seed, seed.ownerCtx, [food.food.id], {
      name: 'Archived Food Draft',
    });
    await container.nutrition.archiveFood(seed.ownerCtx, seed.workspaceId, food.food.id, {
      expectedVersion: (await db.collection('foods').findOne({ _id: new ObjectId(food.food.id) }))
        ?.version,
    });
    await expect(
      activateIdempotently(container, seed, draft.plan.id, draft.plan.version, 'archived-food'),
    ).rejects.toMatchObject({ code: 'FOOD_ARCHIVED' });
    expect(
      await db.collection('nutrition_plans').findOne({ _id: new ObjectId(draft.plan.id) }),
    ).toMatchObject({ status: 'DRAFT' });
    expect(
      await db.collection('nutrition_plans').findOne({ _id: new ObjectId(second.plan.id) }),
    ).toMatchObject({ status: 'ACTIVE' });
  });

  test('concurrency protections cover foods, revisions, activation, relationship END, create, complete and public guard versions', async () => {
    const seed = await seedGym(container);
    const food = await ownerFood(container, seed, 'Concurrent Food');
    const duplicate = await Promise.allSettled([
      container.nutrition.createFood(seed.ownerCtx, seed.workspaceId, {
        ...foodInput('Race Food'),
        scope: 'GYM',
      }),
      container.nutrition.createFood(seed.ownerCtx, seed.workspaceId, {
        ...foodInput('race food'),
        scope: 'GYM',
      }),
    ]);
    expect(duplicate.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await db.collection('foods').countDocuments({
        workspaceId: seed.workspaceObjectId,
        normalizedNames: 'race food',
        status: 'ACTIVE',
      }),
    ).toBe(1);

    const plan = await createSimplePlan(container, seed, seed.ownerCtx, [food.food.id]);
    const relationshipBefore = await db
      .collection('coaching_relationships')
      .findOne({ _id: seed.relationshipObjectId });
    const foodBefore = await db.collection('foods').findOne({ _id: new ObjectId(food.food.id) });
    const revisionRace = await Promise.allSettled([
      container.nutrition.createRevision(
        seed.ownerCtx,
        seed.workspaceId,
        seed.relationshipId,
        plan.plan.id,
        { ...revisionInput([food.food.id], { notes: 'a' }), expectedVersion: plan.plan.version },
      ),
      container.nutrition.createRevision(
        seed.ownerCtx,
        seed.workspaceId,
        seed.relationshipId,
        plan.plan.id,
        { ...revisionInput([food.food.id], { notes: 'b' }), expectedVersion: plan.plan.version },
      ),
    ]);
    expect(revisionRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const relationshipAfter = await db
      .collection('coaching_relationships')
      .findOne({ _id: seed.relationshipObjectId });
    const foodAfter = await db.collection('foods').findOne({ _id: new ObjectId(food.food.id) });
    expect(relationshipAfter?.version).toBe(relationshipBefore?.version);
    expect(foodAfter?.version).toBe(foodBefore?.version);

    const patchSeed = await seedGym(container);
    const patchFood = await ownerFood(container, patchSeed, 'Food Patch Race');
    const patchPlan = await createSimplePlan(container, patchSeed, patchSeed.ownerCtx, [
      patchFood.food.id,
    ]);
    const patchRace = await Promise.allSettled([
      container.nutrition.updateFood(patchSeed.ownerCtx, patchSeed.workspaceId, patchFood.food.id, {
        expectedVersion: patchFood.food.version,
        calories: 20,
      }),
      container.nutrition.createRevision(
        patchSeed.ownerCtx,
        patchSeed.workspaceId,
        patchSeed.relationshipId,
        patchPlan.plan.id,
        { ...revisionInput([patchFood.food.id]), expectedVersion: patchPlan.plan.version },
      ),
    ]);
    expect(patchRace.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const patchedLatest = await db
      .collection('nutrition_plan_revisions')
      .find({ nutritionPlanId: new ObjectId(patchPlan.plan.id) })
      .sort({ revision: -1 })
      .limit(1)
      .next();
    expect([10, 20]).toContain(patchedLatest?.meals[0]?.items[0]?.caloriesSnapshot);

    const archiveSeed = await seedGym(container);
    const archiveFood = await ownerFood(container, archiveSeed, 'Food Archive Race');
    const archivePlan = await createSimplePlan(container, archiveSeed, archiveSeed.ownerCtx, [
      archiveFood.food.id,
    ]);
    const archiveRace = await Promise.allSettled([
      container.nutrition.archiveFood(
        archiveSeed.ownerCtx,
        archiveSeed.workspaceId,
        archiveFood.food.id,
        { expectedVersion: archiveFood.food.version },
      ),
      container.nutrition.createRevision(
        archiveSeed.ownerCtx,
        archiveSeed.workspaceId,
        archiveSeed.relationshipId,
        archivePlan.plan.id,
        { ...revisionInput([archiveFood.food.id]), expectedVersion: archivePlan.plan.version },
      ),
    ]);
    expect(
      archiveRace.filter((result) => result.status === 'fulfilled').length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      await db.collection('nutrition_plan_revisions').countDocuments({
        nutritionPlanId: new ObjectId(archivePlan.plan.id),
      }),
    ).toBeLessThanOrEqual(2);

    const revisionArchiveSeed = await seedGym(container);
    const revisionArchiveFood = await ownerFood(
      container,
      revisionArchiveSeed,
      'Revision Archive Race',
    );
    const revisionArchivePlan = await createSimplePlan(
      container,
      revisionArchiveSeed,
      revisionArchiveSeed.ownerCtx,
      [revisionArchiveFood.food.id],
    );
    const revisionArchive = await Promise.allSettled([
      container.nutrition.createRevision(
        revisionArchiveSeed.ownerCtx,
        revisionArchiveSeed.workspaceId,
        revisionArchiveSeed.relationshipId,
        revisionArchivePlan.plan.id,
        {
          ...revisionInput([revisionArchiveFood.food.id]),
          expectedVersion: revisionArchivePlan.plan.version,
        },
      ),
      container.nutrition.archivePlan(
        revisionArchiveSeed.ownerCtx,
        revisionArchiveSeed.workspaceId,
        revisionArchiveSeed.relationshipId,
        revisionArchivePlan.plan.id,
        { expectedVersion: revisionArchivePlan.plan.version },
      ),
    ]);
    expect(revisionArchive.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejectedCodes(revisionArchive)).toEqual(
      expect.arrayContaining(['NUTRITION_PLAN_STATUS_INVALID']),
    );

    const revisionCompleteSeed = await seedGym(container);
    const revisionCompleteFood = await ownerFood(
      container,
      revisionCompleteSeed,
      'Revision Complete Race',
    );
    const revisionCompletePlan = await createSimplePlan(
      container,
      revisionCompleteSeed,
      revisionCompleteSeed.ownerCtx,
      [revisionCompleteFood.food.id],
    );
    const activeForRevisionComplete = await activateIdempotently(
      container,
      revisionCompleteSeed,
      revisionCompletePlan.plan.id,
      revisionCompletePlan.plan.version,
      'revision-complete-active',
    );
    const revisionComplete = await Promise.allSettled([
      container.nutrition.createRevision(
        revisionCompleteSeed.ownerCtx,
        revisionCompleteSeed.workspaceId,
        revisionCompleteSeed.relationshipId,
        revisionCompletePlan.plan.id,
        {
          ...revisionInput([revisionCompleteFood.food.id]),
          expectedVersion: activeForRevisionComplete.body.plan.version,
        },
      ),
      container.nutrition.completePlan(
        revisionCompleteSeed.ownerCtx,
        revisionCompleteSeed.workspaceId,
        revisionCompleteSeed.relationshipId,
        revisionCompletePlan.plan.id,
        { expectedVersion: activeForRevisionComplete.body.plan.version },
      ),
    ]);
    expect(revisionComplete.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejectedCodes(revisionComplete)).toEqual(
      expect.arrayContaining(['NUTRITION_PLAN_STATUS_INVALID']),
    );

    const actSeed = await seedGym(container);
    const actFood = await ownerFood(container, actSeed, 'Activation Race Food');
    const a = await createSimplePlan(container, actSeed, actSeed.ownerCtx, [actFood.food.id], {
      name: 'A',
    });
    const b = await createSimplePlan(container, actSeed, actSeed.ownerCtx, [actFood.food.id], {
      name: 'B',
    });
    const originalFindActive = container.nutritionRepo.findActivePlan.bind(container.nutritionRepo);
    let preTransactionReads = 0;
    container.nutritionRepo.findActivePlan = (async (
      ...args: Parameters<typeof originalFindActive>
    ) => {
      if (!args[2] && preTransactionReads < 2) {
        preTransactionReads += 1;
        return null;
      }
      return await originalFindActive(...args);
    }) as typeof container.nutritionRepo.findActivePlan;
    const activationRace = await Promise.allSettled([
      activateIdempotently(container, actSeed, a.plan.id, a.plan.version, 'activate-a'),
      activateIdempotently(container, actSeed, b.plan.id, b.plan.version, 'activate-b'),
    ]);
    container.nutritionRepo.findActivePlan = originalFindActive;
    expect(activationRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await db.collection('nutrition_plans').countDocuments({
        workspaceId: actSeed.workspaceObjectId,
        relationshipId: actSeed.relationshipObjectId,
        status: 'ACTIVE',
      }),
    ).toBe(1);
    expect(
      await db.collection('nutrition_plans').countDocuments({
        workspaceId: actSeed.workspaceObjectId,
        relationshipId: actSeed.relationshipObjectId,
        status: 'DRAFT',
      }),
    ).toBe(1);

    const endSeed = await seedGym(container);
    const endFood = await ownerFood(container, endSeed, 'End Race Food');
    const endPlan = await createSimplePlan(container, endSeed, endSeed.ownerCtx, [endFood.food.id]);
    const endRelationship = await db
      .collection('coaching_relationships')
      .findOne({ _id: endSeed.relationshipObjectId });
    const endRace = await Promise.allSettled([
      activateIdempotently(container, endSeed, endPlan.plan.id, endPlan.plan.version, 'end-race'),
      container.trainees.endRelationship(
        endSeed.ownerCtx,
        endSeed.workspaceId,
        endSeed.relationshipId,
        {
          expectedVersion: endRelationship?.version ?? -1,
          reason: 'finished',
        },
      ),
    ]);
    expect(endRace.filter((result) => result.status === 'fulfilled').length).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      await db.collection('nutrition_plans').countDocuments({
        relationshipId: endSeed.relationshipObjectId,
        status: 'ACTIVE',
      }),
    ).toBe(0);
    expect(
      await db.collection('coaching_relationships').findOne({ _id: endSeed.relationshipObjectId }),
    ).toMatchObject({ status: 'ENDED' });

    const createEndSeed = await seedGym(container);
    const createEndFood = await ownerFood(container, createEndSeed, 'Create End Food');
    const createRelationship = await db
      .collection('coaching_relationships')
      .findOne({ _id: createEndSeed.relationshipObjectId });
    const createEnd = await Promise.allSettled([
      createSimplePlan(container, createEndSeed, createEndSeed.ownerCtx, [createEndFood.food.id]),
      container.trainees.endRelationship(
        createEndSeed.ownerCtx,
        createEndSeed.workspaceId,
        createEndSeed.relationshipId,
        { expectedVersion: createRelationship?.version ?? -1, reason: 'finished' },
      ),
    ]);
    expect(
      createEnd.filter((result) => result.status === 'fulfilled').length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      await db.collection('nutrition_plans').countDocuments({
        relationshipId: createEndSeed.relationshipObjectId,
        status: 'ACTIVE',
      }),
    ).toBe(0);

    const completeEndSeed = await seedGym(container);
    const completeFood = await ownerFood(container, completeEndSeed, 'Complete End Food');
    const completePlan = await createSimplePlan(
      container,
      completeEndSeed,
      completeEndSeed.ownerCtx,
      [completeFood.food.id],
    );
    const active = await activateIdempotently(
      container,
      completeEndSeed,
      completePlan.plan.id,
      completePlan.plan.version,
      'complete-active',
    );
    const completeRelationship = await db
      .collection('coaching_relationships')
      .findOne({ _id: completeEndSeed.relationshipObjectId });
    await Promise.allSettled([
      container.nutrition.completePlan(
        completeEndSeed.ownerCtx,
        completeEndSeed.workspaceId,
        completeEndSeed.relationshipId,
        completePlan.plan.id,
        { expectedVersion: active.body.plan.version },
      ),
      container.trainees.endRelationship(
        completeEndSeed.ownerCtx,
        completeEndSeed.workspaceId,
        completeEndSeed.relationshipId,
        { expectedVersion: completeRelationship?.version ?? -1, reason: 'finished' },
      ),
    ]);
    expect(
      await db.collection('nutrition_plans').countDocuments({
        relationshipId: completeEndSeed.relationshipObjectId,
        status: 'ACTIVE',
      }),
    ).toBe(0);
  }, 30_000);

  test('NEEDS_REASSIGNMENT keeps assigned Nutritionist operational while former primary and trainee stay limited', async () => {
    const seed = await seedGym(container);
    const nutritionist = await seedNutritionist(container, seed);
    await container.trainees.removePrimary(seed.ownerCtx, seed.workspaceId, seed.relationshipId, {
      expectedVersion: seed.relationshipVersion,
      reason: 'left',
    });
    const food = await container.nutrition.createFood(nutritionist.ctx, seed.workspaceId, {
      ...foodInput('Needs Food'),
      scope: 'PRIVATE',
    });
    const plan = await createSimplePlan(container, seed, nutritionist.ctx, [food.food.id]);
    const revised = await container.nutrition.createRevision(
      nutritionist.ctx,
      seed.workspaceId,
      seed.relationshipId,
      plan.plan.id,
      { ...revisionInput([food.food.id]), expectedVersion: plan.plan.version },
    );
    const activated = await activateIdempotently(
      container,
      seed,
      plan.plan.id,
      revised.plan.version,
      'needs-activate',
      undefined,
      nutritionist.ctx,
    );
    const completed = await container.nutrition.completePlan(
      nutritionist.ctx,
      seed.workspaceId,
      seed.relationshipId,
      plan.plan.id,
      { expectedVersion: activated.body.plan.version },
    );
    expect(completed.plan.status).toBe('COMPLETED');
    await expect(
      createSimplePlan(container, seed, seed.trainerCtx, [food.food.id]),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(
      await container.nutrition.listPlans(
        seed.traineeCtx,
        seed.workspaceId,
        seed.relationshipId,
        {},
      ),
    ).toMatchObject({ data: [expect.objectContaining({ id: plan.plan.id })] });
    await expect(
      createSimplePlan(container, seed, seed.traineeCtx, [food.food.id]),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  test('authorization, DENY precedence, entitlements, and platform/system separation are enforced', async () => {
    const seed = await seedGym(container);
    const nutritionist = await seedNutritionist(container, seed);
    const other = await seedRelationshipWithPrimary(container, seed);
    const platform = await seedPlatformAdmin(container);
    const food = await ownerFood(container, seed, 'Auth Food');

    await expect(
      createSimplePlan(container, seed, seed.assistantCtx, [food.food.id]),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      createSimplePlan(container, seed, nutritionist.ctx, [food.food.id]),
    ).resolves.toMatchObject({ plan: { status: 'DRAFT' } });
    await expect(
      container.nutrition.listPlans(seed.traineeCtx, seed.workspaceId, other.relationshipId, {}),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await writeGrant(db, {
      workspaceId: seed.workspaceObjectId,
      subjectId: new ObjectId(seed.traineeMembershipId),
      permission: Permissions.NutritionPlansRead,
      effect: 'DENY',
    });
    await expect(
      container.nutrition.listPlans(seed.traineeCtx, seed.workspaceId, seed.relationshipId, {}),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      container.nutrition.createPlatformFood(
        { ...seed.ownerCtx, mfaSatisfied: true },
        foodInput('No Platform'),
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_MEMBERSHIP_REQUIRED' });
    await expect(
      container.nutrition.createPlatformFood(platform.ctx, foodInput('System Only')),
    ).resolves.toMatchObject({ food: { scope: 'SYSTEM' } });

    await db
      .collection('subscription_terms')
      .updateOne({ workspaceId: seed.workspaceObjectId }, { $set: { enabledFeatures: [] } });
    await expect(
      createSimplePlan(container, seed, nutritionist.ctx, [food.food.id]),
    ).rejects.toHaveProperty('code', 'FEATURE_NOT_AVAILABLE');
    await expect(
      container.nutrition.listPlans(seed.ownerCtx, seed.workspaceId, seed.relationshipId, {}),
    ).resolves.toHaveProperty('data');
    await db
      .collection('subscriptions')
      .updateOne({ workspaceId: seed.workspaceObjectId }, { $set: { lifecycleStatus: 'FROZEN' } });
    await db
      .collection('subscription_terms')
      .updateOne(
        { workspaceId: seed.workspaceObjectId },
        { $set: { enabledFeatures: ['training', 'nutrition'] } },
      );
    await expect(
      createSimplePlan(container, seed, nutritionist.ctx, [food.food.id]),
    ).rejects.toHaveProperty('code', 'SUBSCRIPTION_FROZEN');
    await expect(
      container.nutrition.listPlans(seed.ownerCtx, seed.workspaceId, seed.relationshipId, {}),
    ).resolves.toHaveProperty('data');
  });

  test('failure injection rolls back plan create, activation, active revision, and relationship END lifecycle closure', async () => {
    const createSeed = await seedGym(container);
    const food = await ownerFood(container, createSeed, 'Failure Food');
    const originalCreateRevision = container.nutritionRepo.createPlan.bind(container.nutritionRepo);
    container.nutritionRepo.createPlan = (async () => {
      throw new Error('revision insert failed');
    }) as typeof container.nutritionRepo.createPlan;
    await expect(
      createSimplePlan(container, createSeed, createSeed.ownerCtx, [food.food.id]),
    ).rejects.toThrow('revision insert failed');
    container.nutritionRepo.createPlan = originalCreateRevision;
    expect(
      await db.collection('nutrition_plans').countDocuments({
        relationshipId: createSeed.relationshipObjectId,
      }),
    ).toBe(0);

    const activationSeed = await seedGym(container);
    const activationFood = await ownerFood(container, activationSeed, 'Activation Failure Food');
    const plan = await createSimplePlan(container, activationSeed, activationSeed.ownerCtx, [
      activationFood.food.id,
    ]);
    const originalOutbox = container.outbox.write.bind(container.outbox);
    const activatedEventsBeforeFailure = await db
      .collection('outbox_events')
      .countDocuments({ eventType: 'NutritionPlanActivated' });
    container.outbox.write = (async () => {
      throw new Error('outbox failed');
    }) as typeof container.outbox.write;
    await expect(
      activateIdempotently(
        container,
        activationSeed,
        plan.plan.id,
        plan.plan.version,
        'fail-outbox',
      ),
    ).rejects.toThrow('outbox failed');
    container.outbox.write = originalOutbox;
    expect(
      await db.collection('nutrition_plans').findOne({ _id: new ObjectId(plan.plan.id) }),
    ).toMatchObject({ status: 'DRAFT' });
    expect(
      await db.collection('outbox_events').countDocuments({ eventType: 'NutritionPlanActivated' }),
    ).toBe(activatedEventsBeforeFailure);

    const active = await activateIdempotently(
      container,
      activationSeed,
      plan.plan.id,
      plan.plan.version,
      'activation-after-failure',
    );
    container.outbox.write = (async () => {
      throw new Error('active update outbox failed');
    }) as typeof container.outbox.write;
    await expect(
      container.nutrition.createRevision(
        activationSeed.ownerCtx,
        activationSeed.workspaceId,
        activationSeed.relationshipId,
        plan.plan.id,
        { ...revisionInput([activationFood.food.id]), expectedVersion: active.body.plan.version },
      ),
    ).rejects.toThrow('active update outbox failed');
    container.outbox.write = originalOutbox;
    expect(
      await db.collection('nutrition_plan_revisions').countDocuments({
        nutritionPlanId: new ObjectId(plan.plan.id),
      }),
    ).toBe(1);

    const endSeed = await seedGym(container);
    const endFood = await ownerFood(container, endSeed, 'End Failure Food');
    const endPlan = await createSimplePlan(container, endSeed, endSeed.ownerCtx, [endFood.food.id]);
    await activateIdempotently(
      container,
      endSeed,
      endPlan.plan.id,
      endPlan.plan.version,
      'end-fail',
    );
    const originalAssignments =
      container.coachingRelationships.closeActiveAssignmentsForRelationship.bind(
        container.coachingRelationships,
      );
    container.coachingRelationships.closeActiveAssignmentsForRelationship = (async () => {
      throw new Error('relationship finalization failed');
    }) as typeof container.coachingRelationships.closeActiveAssignmentsForRelationship;
    await expect(
      container.trainees.endRelationship(
        endSeed.ownerCtx,
        endSeed.workspaceId,
        endSeed.relationshipId,
        {
          expectedVersion: endSeed.relationshipVersion,
          reason: 'finished',
        },
      ),
    ).rejects.toThrow('relationship finalization failed');
    container.coachingRelationships.closeActiveAssignmentsForRelationship = originalAssignments;
    expect(
      await db.collection('coaching_relationships').findOne({ _id: endSeed.relationshipObjectId }),
    ).toMatchObject({ status: 'ACTIVE' });
    expect(
      await db.collection('nutrition_plans').findOne({ _id: new ObjectId(endPlan.plan.id) }),
    ).toMatchObject({ status: 'ACTIVE' });
  }, 30_000);
});

function indexes(calls: Array<{ collection: string; indexes: unknown[] }>, collection: string) {
  return calls.find((call) => call.collection === collection)?.indexes;
}

async function assertStage10DbShape(db: Db) {
  for (const name of ['foods', 'nutrition_plans', 'nutrition_plan_revisions']) {
    expect(await db.listCollections({ name }).hasNext()).toBe(true);
  }
  for (const name of [
    'nutrition_templates',
    'daily_nutrition_logs',
    'water_intake',
    'measurements',
    'progress_photos',
  ]) {
    expect(await db.listCollections({ name }).hasNext()).toBe(false);
  }
  expect((await db.collection('foods').indexes()).map((index) => index.name)).toEqual(
    expect.arrayContaining([
      'foods_active_normalized_name_unique',
      'foods_scope_status',
      'foods_workspace_scope_status',
      'foods_private_owner_lookup',
    ]),
  );
  expect((await db.collection('nutrition_plans').indexes()).map((index) => index.name)).toEqual(
    expect.arrayContaining([
      'nutrition_plans_relationship_status',
      'nutrition_plans_relationship_history',
      'nutrition_plans_one_active_per_relationship',
    ]),
  );
  expect(
    (await db.collection('nutrition_plan_revisions').indexes()).map((index) => index.name),
  ).toEqual(
    expect.arrayContaining([
      'nutrition_plan_revisions_plan_revision_unique',
      'nutrition_plan_revisions_plan_order',
    ]),
  );
  expect(
    await db
      .collection('permission_definitions')
      .countDocuments({ key: 'nutrition.plans.activate', state: 'ACTIVE' }),
  ).toBe(1);
}

async function seedGym(container: AppContainer) {
  const db = container.database.db;
  const owner = await seedUser(db, `owner-${new ObjectId().toHexString()}@example.com`);
  const trainer = await seedUser(db, `trainer-${new ObjectId().toHexString()}@example.com`);
  const trainee = await seedUser(db, `trainee-${new ObjectId().toHexString()}@example.com`);
  const assistant = await seedUser(db, `assistant-${new ObjectId().toHexString()}@example.com`);
  const workspace = await container.workspaceRepo.create({
    type: 'GYM',
    name: 'Stage 10 Gym',
    ownerUserId: owner._id,
    timezone: 'Africa/Cairo',
    defaultLanguage: 'en',
  });
  await seedCommercial(db, workspace._id, ['training', 'nutrition']);
  const branch = await container.branches.create({
    workspaceId: workspace._id,
    name: 'Main',
    timezone: 'Africa/Cairo',
  });
  const ownerMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: owner._id,
    roles: ['GYM_OWNER'],
  });
  const trainerMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: trainer._id,
    roles: ['TRAINER'],
  });
  const assistantMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: assistant._id,
    roles: ['ASSISTANT_TRAINER'],
  });
  const traineeMembership = await container.workspaceMemberships.createActive({
    workspaceId: workspace._id,
    userId: trainee._id,
    roles: ['TRAINEE'],
  });
  await assignSystemProfile(container, workspace._id, ownerMembership._id, 'GYM_OWNER');
  await assignSystemProfile(container, workspace._id, trainerMembership._id, 'TRAINER');
  await assignSystemProfile(container, workspace._id, assistantMembership._id, 'ASSISTANT_TRAINER');
  await assignSystemProfile(container, workspace._id, traineeMembership._id, 'TRAINEE');
  await container.membershipBranchAssignments.createActive(
    workspace._id,
    trainerMembership._id,
    branch._id,
  );
  await container.membershipBranchAssignments.createActive(
    workspace._id,
    assistantMembership._id,
    branch._id,
  );
  const relationship = await container.coachingRelationships.createActive({
    workspaceId: workspace._id,
    traineeUserId: trainee._id,
    traineeMembershipId: traineeMembership._id,
    homeBranchId: branch._id,
    activatedBy: owner._id,
  });
  const primary = await container.coachingRelationships.createAssignment({
    workspaceId: workspace._id,
    relationshipId: relationship._id,
    staffMembershipId: trainerMembership._id,
    assignmentType: 'PRIMARY_TRAINER',
    assignedBy: owner._id,
  });
  const assistantAssignment = await container.coachingRelationships.createAssignment({
    workspaceId: workspace._id,
    relationshipId: relationship._id,
    staffMembershipId: assistantMembership._id,
    assignmentType: 'ASSISTANT_TRAINER',
    assignedBy: owner._id,
  });
  void assistantAssignment;
  const active = await container.coachingRelationships.setPrimaryPointer(
    relationship._id,
    workspace._id,
    relationship.version,
    ['ACTIVE'],
    primary._id,
  );
  return {
    workspaceId: workspace._id.toHexString(),
    workspaceObjectId: workspace._id,
    branchId: branch._id.toHexString(),
    relationshipId: active._id.toHexString(),
    relationshipObjectId: active._id,
    relationshipVersion: active.version,
    ownerMembershipId: ownerMembership._id.toHexString(),
    trainerMembershipId: trainerMembership._id.toHexString(),
    assistantMembershipId: assistantMembership._id.toHexString(),
    traineeMembershipId: traineeMembership._id.toHexString(),
    ownerCtx: ctx(owner._id, ownerMembership._id),
    trainerCtx: ctx(trainer._id, trainerMembership._id),
    traineeCtx: ctx(trainee._id, traineeMembership._id),
    assistantCtx: ctx(assistant._id, assistantMembership._id),
  };
}

async function seedRelationshipWithPrimary(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
) {
  const trainerUser = await seedUser(
    container.database.db,
    `trainer-${new ObjectId().toHexString()}@example.com`,
  );
  const trainerMembership = await container.workspaceMemberships.createActive({
    workspaceId: seed.workspaceObjectId,
    userId: trainerUser._id,
    roles: ['TRAINER'],
  });
  await assignSystemProfile(container, seed.workspaceObjectId, trainerMembership._id, 'TRAINER');
  const trainee = await seedUser(
    container.database.db,
    `trainee-${new ObjectId().toHexString()}@example.com`,
  );
  const traineeMembership = await container.workspaceMemberships.createActive({
    workspaceId: seed.workspaceObjectId,
    userId: trainee._id,
    roles: ['TRAINEE'],
  });
  await assignSystemProfile(container, seed.workspaceObjectId, traineeMembership._id, 'TRAINEE');
  const relationship = await container.coachingRelationships.createActive({
    workspaceId: seed.workspaceObjectId,
    traineeUserId: trainee._id,
    traineeMembershipId: traineeMembership._id,
    homeBranchId: new ObjectId(seed.branchId),
    activatedBy: new ObjectId(seed.ownerCtx.userId),
  });
  const primary = await container.coachingRelationships.createAssignment({
    workspaceId: seed.workspaceObjectId,
    relationshipId: relationship._id,
    staffMembershipId: trainerMembership._id,
    assignmentType: 'PRIMARY_TRAINER',
    assignedBy: new ObjectId(seed.ownerCtx.userId),
  });
  const active = await container.coachingRelationships.setPrimaryPointer(
    relationship._id,
    seed.workspaceObjectId,
    relationship.version,
    ['ACTIVE'],
    primary._id,
  );
  return {
    relationshipId: active._id.toHexString(),
    relationshipObjectId: active._id,
  };
}

async function seedNutritionist(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
) {
  const user = await seedUser(
    container.database.db,
    `nutritionist-${new ObjectId().toHexString()}@example.com`,
  );
  const membership = await container.workspaceMemberships.createActive({
    workspaceId: seed.workspaceObjectId,
    userId: user._id,
    roles: ['NUTRITIONIST'],
  });
  await assignSystemProfile(container, seed.workspaceObjectId, membership._id, 'NUTRITIONIST');
  await container.coachingRelationships.createAssignment({
    workspaceId: seed.workspaceObjectId,
    relationshipId: seed.relationshipObjectId,
    staffMembershipId: membership._id,
    assignmentType: 'NUTRITIONIST',
    assignedBy: new ObjectId(seed.ownerCtx.userId),
  });
  return { ctx: ctx(user._id, membership._id), membership };
}

async function seedPlatformAdmin(container: AppContainer) {
  const user = await seedUser(
    container.database.db,
    `platform-${new ObjectId().toHexString()}@example.com`,
  );
  const membership = await container.platformMemberships.createActive(user._id);
  const seed = systemPermissionProfiles.find(
    (profile) => profile.context === 'PLATFORM' && profile.roleKey === 'PLATFORM_SUPER_ADMIN',
  );
  if (!seed) throw new Error('missing platform profile seed');
  const profile =
    (await container.permissionProfiles.findSystemDefault({
      context: 'PLATFORM',
      roleKey: 'PLATFORM_SUPER_ADMIN',
    })) ??
    (await container.permissionProfiles.create({
      context: 'PLATFORM',
      roleKey: 'PLATFORM_SUPER_ADMIN',
      name: seed.name,
      permissions: seed.permissions,
      isSystemDefault: true,
    }));
  await container.platformMemberships.replacePermissionProfiles(membership._id, 0, [profile._id]);
  return { ctx: { ...ctx(user._id), mfaSatisfied: true } };
}

async function ownerFood(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  name: string,
) {
  return await container.nutrition.createFood(seed.ownerCtx, seed.workspaceId, {
    ...foodInput(name),
    scope: 'GYM',
  });
}

async function createSimplePlan(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  actorCtx: ReturnType<typeof ctx>,
  foodIds: string[],
  options: {
    name?: string;
    selectedAmount?: number;
    selectedUnit?: 'GRAM' | 'MILLILITER' | 'UNIT' | 'SERVING';
    fakeCalculatedCalories?: number;
    alternativeFoodId?: string;
  } = {},
) {
  return await container.nutrition.createPlan(actorCtx, seed.workspaceId, seed.relationshipId, {
    name: options.name ?? `Plan ${new ObjectId().toHexString()}`,
    ...revisionInput(foodIds, options),
  });
}

function revisionInput(
  foodIds: string[],
  options: {
    selectedAmount?: number;
    selectedUnit?: 'GRAM' | 'MILLILITER' | 'UNIT' | 'SERVING';
    fakeCalculatedCalories?: number;
    alternativeFoodId?: string;
    notes?: string;
  } = {},
) {
  return {
    targetCalories: 2100,
    targetProteinG: 160,
    targetCarbsG: 220,
    targetFatG: 70,
    waterTargetMl: 2500,
    notes: options.notes ?? 'prescription',
    meals: [
      {
        order: 1,
        name: 'Meal 1',
        items: foodIds.map((foodId, index) => ({
          foodId,
          selectedAmount: options.selectedAmount ?? 1,
          selectedUnit: options.selectedUnit ?? (index === 0 ? 'GRAM' : 'SERVING'),
          ...(options.fakeCalculatedCalories
            ? { calculatedCalories: options.fakeCalculatedCalories }
            : {}),
        })),
        alternativeGroups: options.alternativeFoodId
          ? [
              {
                order: 1,
                options: [
                  {
                    order: 1,
                    items: [
                      {
                        foodId: options.alternativeFoodId,
                        selectedAmount: 500,
                        selectedUnit: 'MILLILITER' as const,
                      },
                    ],
                  },
                ],
              },
            ]
          : [],
      },
    ],
    supplements: [{ order: 1, name: 'Creatine', amount: 5, unit: 'g', timing: 'daily' }],
  };
}

function foodInput(name: string, names: { ar?: string } = {}) {
  return {
    names: { en: name, ...names },
    baseAmount: 1,
    baseUnit: 'GRAM' as const,
    calories: 10,
    proteinG: 1,
    carbsG: 1,
    fatG: 1,
  };
}

async function activateIdempotently(
  container: AppContainer,
  seed: Awaited<ReturnType<typeof seedGym>>,
  planId: string,
  expectedVersion: number,
  key: string,
  bodyOverride?: { expectedVersion: number },
  actorCtx: ReturnType<typeof ctx> = seed.ownerCtx,
) {
  const body = bodyOverride ?? { expectedVersion };
  return await container.idempotency.runInTransaction(actorCtx, {
    routeKey:
      'POST /workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans/:planId/activate',
    key,
    fingerprint: {
      params: { workspaceId: seed.workspaceId, relationshipId: seed.relationshipId, planId },
      body,
    },
    unitOfWork: container.unitOfWork,
    operation: async (tx) => ({
      body: await container.nutrition.activatePlan(
        actorCtx,
        seed.workspaceId,
        seed.relationshipId,
        planId,
        body,
        tx,
      ),
    }),
  });
}

async function assignSystemProfile(
  container: AppContainer,
  workspaceId: ObjectId,
  membershipId: ObjectId,
  roleKey: string,
) {
  const seed = systemPermissionProfiles.find(
    (profile) => profile.context === 'WORKSPACE' && profile.roleKey === roleKey,
  );
  if (!seed) throw new Error(`missing system profile seed: ${roleKey}`);
  const profile =
    (await container.permissionProfiles.findSystemDefault({
      context: 'WORKSPACE',
      workspaceId,
      roleKey,
    })) ??
    (await container.permissionProfiles.create({
      context: 'WORKSPACE',
      workspaceId,
      roleKey,
      name: seed.name,
      permissions: seed.permissions,
      isSystemDefault: true,
    }));
  const membership = await container.workspaceMemberships.findByIdInWorkspace(
    workspaceId,
    membershipId,
  );
  if (!membership) throw new Error('membership missing');
  await container.workspaceMemberships.updateRoleAndProfileContributions(
    workspaceId,
    membershipId,
    membership.accessVersion ?? 0,
    { roles: membership.roles, permissionProfileIds: [profile._id] },
  );
}

async function seedUser(db: Db, email: string) {
  const now = new Date();
  const user = {
    _id: new ObjectId(),
    email,
    normalizedEmail: email,
    passwordHash: 'hash',
    emailVerifiedAt: now,
    firstName: 'Stage',
    lastName: 'Ten',
    preferredLanguage: 'en',
    timezone: 'Africa/Cairo',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };
  await db.collection('users').insertOne(user);
  return user;
}

async function seedCommercial(db: Db, workspaceId: ObjectId, enabledFeatures: string[]) {
  const now = new Date();
  const subscriptionId = new ObjectId();
  const termsId = new ObjectId();
  await db.collection('subscriptions').insertOne({
    _id: subscriptionId,
    workspaceId,
    lifecycleStatus: 'ACTIVE',
    currentTermsId: termsId,
    version: 0,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('subscription_terms').insertOne({
    _id: termsId,
    subscriptionId,
    workspaceId,
    billingPeriod: 'MONTHLY',
    limits: { activeTrainees: 50, activeStaff: 50, storageBytes: 1_000_000 },
    enabledFeatures,
    effectiveFrom: now,
    source: 'PURCHASE',
    createdBy: new ObjectId(),
    createdAt: now,
  });
  await db.collection('workspace_usage').insertOne({
    _id: new ObjectId(),
    workspaceId,
    activeTrainees: 1,
    activeStaff: 0,
    storageBytes: 0,
    reservedStorageBytes: 0,
    revision: 0,
    calculatedAt: now,
    updatedAt: now,
  });
}

async function writeGrant(
  db: Db,
  input: {
    workspaceId: ObjectId;
    subjectId: ObjectId;
    permission: string;
    effect: 'ALLOW' | 'DENY';
  },
) {
  await db.collection('access_grants').insertOne({
    _id: new ObjectId(),
    context: 'WORKSPACE',
    workspaceId: input.workspaceId,
    subjectType: 'WORKSPACE_MEMBERSHIP',
    subjectId: input.subjectId,
    permission: input.permission,
    effect: input.effect,
    scope: { type: 'WORKSPACE' },
    createdBy: input.subjectId,
    createdAt: new Date(),
  });
}

function rejectedCodes(results: PromiseSettledResult<unknown>[]) {
  return results.flatMap((result) =>
    result.status === 'rejected' &&
    result.reason &&
    typeof result.reason === 'object' &&
    'code' in result.reason
      ? [String(result.reason.code)]
      : [],
  );
}

function ctx(userId: ObjectId, membershipId?: ObjectId) {
  return {
    correlationId: new ObjectId().toHexString(),
    userId: userId.toHexString(),
    authSessionId: new ObjectId().toHexString(),
    ...(membershipId ? { workspaceMembershipId: membershipId.toHexString() } : {}),
    ipAddress: '127.0.0.1',
    locale: 'en',
    timezone: 'Africa/Cairo',
  };
}

function integrationConfig(dbName: string): AppConfig {
  return {
    env: 'test',
    app: {
      host: '0.0.0.0',
      port: 3000,
      docsEnabled: false,
      trustProxy: false,
      allowedOrigins: [],
    },
    mongo: { uri: mongoUri(), dbName, connectTimeoutMs: 500 },
    logging: { level: 'silent' },
    auth: {
      jwtActiveKeyId: 'test',
      jwtPrivateKey: 'unused',
      jwtPublicKeys: {},
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      webRefreshCookieSameSite: 'LAX',
      otpHmacSecret: 'secret',
      totpEncryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      loginIdentifierIpWindowMs: 15 * 60 * 1000,
      loginIdentifierIpMaxAttempts: 5,
      loginIdentifierIpBlockMs: 15 * 60 * 1000,
      loginIpWindowMs: 15 * 60 * 1000,
      loginIpMaxAttempts: 30,
      challengeTtlSeconds: 600,
      challengeMaxAttempts: 5,
      challengeResendCooldownSeconds: 60,
      challengeMaxSendsPerHour: 5,
      mfaChallengeTtlSeconds: 300,
      mfaChallengeMaxAttempts: 5,
      recoveryCodeCount: 10,
      passwordResetIdentifierMaxPerHour: 3,
      passwordResetIpMaxPerHour: 10,
    },
    worker: {
      id: 'test',
      outboxPollIntervalMs: 1000,
      outboxLockMs: 30_000,
      outboxMaxAttempts: 8,
      jobLeaseMs: 30_000,
    },
    subscriptions: { trialExpiryAction: 'FROZEN', paidGraceDays: 0, frozenToExpiredDays: 30 },
    support: { defaultSessionMinutes: 30, maxSessionMinutes: 60 },
  };
}

function mongoUri() {
  return (
    process.env.MONGODB_URI ??
    'mongodb://localhost:27017/gym_platform?replicaSet=rs0&directConnection=true'
  );
}
