import type { AppContainer } from '../../bootstrap/app-container';

export class ExportJobRunner {
  constructor(private readonly container: AppContainer) {}

  async runDueJobs(): Promise<void> {
    await this.withLease('exports.generate', async () => {
      await this.container.exports.generateDue();
    });
    await this.withLease('exports.expire', async () => {
      await this.container.exports.expireDue();
    });
  }

  private async withLease(key: string, operation: () => Promise<void>): Promise<void> {
    const ownerId = this.container.config.worker.id;
    const acquired = await this.container.jobLeases.tryAcquire(
      key,
      ownerId,
      this.container.config.worker.jobLeaseMs,
    );
    if (!acquired) return;
    try {
      await operation();
    } finally {
      await this.container.jobLeases.release(key, ownerId);
    }
  }
}
