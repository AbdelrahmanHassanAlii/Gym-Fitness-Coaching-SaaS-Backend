import type { AppContainer } from '../../bootstrap/app-container';

export class SubscriptionJobRunner {
  constructor(private readonly container: AppContainer) {}

  async runDueJobs(): Promise<void> {
    await this.runLeased('stage5-expire-trials', async () => {
      await this.container.subscriptions.expireTrials();
    });
    await this.runLeased('stage5-advance-subscriptions', async () => {
      await this.container.subscriptions.advanceLifecycle();
    });
    await this.runLeased('stage5-reconcile-workspace-usage', async () => {
      await this.container.subscriptions.reconcileWorkspaceUsage();
    });
  }

  private async runLeased(key: string, operation: () => Promise<void>): Promise<void> {
    const acquired = await this.container.jobLeases.tryAcquire(
      key,
      this.container.config.worker.id,
      this.container.config.worker.jobLeaseMs,
    );
    if (!acquired) return;
    try {
      await operation();
    } finally {
      await this.container.jobLeases.release(key, this.container.config.worker.id);
    }
  }
}
