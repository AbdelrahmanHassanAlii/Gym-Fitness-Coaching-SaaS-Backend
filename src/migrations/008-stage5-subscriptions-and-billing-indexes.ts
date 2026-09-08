import type { Migration } from './migration.types';

export const migration008Stage5SubscriptionsAndBillingIndexes: Migration = {
  id: '008-stage5-subscriptions-and-billing-indexes',
  description: 'Create Stage 5 subscription, billing and usage indexes',
  async up(db) {
    await db.collection('subscription_plans').createIndexes([
      { key: { key: 1 }, unique: true, name: 'subscription_plans_key_unique' },
      { key: { active: 1, customerType: 1 }, name: 'subscription_plans_active_customer_type' },
    ]);

    await db.collection('subscription_plan_versions').createIndexes([
      {
        key: { planId: 1, version: 1 },
        unique: true,
        name: 'subscription_plan_versions_plan_version_unique',
      },
      { key: { planId: 1, effectiveFrom: -1 }, name: 'subscription_plan_versions_plan_effective' },
    ]);

    await db.collection('subscriptions').createIndexes([
      { key: { workspaceId: 1 }, unique: true, name: 'subscriptions_workspace_unique' },
      { key: { lifecycleStatus: 1, expiresAt: 1 }, name: 'subscriptions_lifecycle_expires' },
      { key: { lifecycleStatus: 1, graceEndsAt: 1 }, name: 'subscriptions_lifecycle_grace' },
      { key: { lifecycleStatus: 1, frozenAt: 1 }, name: 'subscriptions_lifecycle_frozen' },
    ]);

    await db.collection('subscription_terms').createIndexes([
      {
        key: { subscriptionId: 1, effectiveFrom: -1 },
        name: 'subscription_terms_subscription_effective',
      },
      {
        key: { workspaceId: 1, effectiveFrom: -1 },
        name: 'subscription_terms_workspace_effective',
      },
      { key: { planVersionId: 1 }, name: 'subscription_terms_plan_version' },
    ]);

    await db
      .collection('workspace_usage')
      .createIndexes([
        { key: { workspaceId: 1 }, unique: true, name: 'workspace_usage_workspace_unique' },
      ]);

    await db.collection('manual_payments').createIndexes([
      {
        key: { workspaceId: 1, status: 1, createdAt: -1 },
        name: 'manual_payments_workspace_status',
      },
      { key: { status: 1, createdAt: -1 }, name: 'manual_payments_status_created' },
      { key: { subscriptionId: 1, createdAt: -1 }, name: 'manual_payments_subscription_created' },
    ]);
  },
};
