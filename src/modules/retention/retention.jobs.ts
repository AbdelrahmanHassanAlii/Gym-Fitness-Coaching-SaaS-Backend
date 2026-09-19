import type { AppContainer } from '../../bootstrap/app-container';

export class RetentionJobRunner {
  constructor(private readonly container: AppContainer) {}

  async sendWarnings(): Promise<number> {
    return await this.withLease('retention.send-warnings', () =>
      this.container.retention.sendWarnings(),
    );
  }

  async createDeletionRequests(): Promise<number> {
    return await this.withLease('retention.create-deletion-requests', () =>
      this.container.retention.createDeletionRequests(),
    );
  }

  async reviewPostponed(): Promise<number> {
    return await this.withLease('retention.review-postponed', () =>
      this.container.retention.reviewPostponed(),
    );
  }

  async processDeletions(workerId = process.pid.toString()): Promise<number> {
    return await this.withLease('retention.process-deletions', () =>
      this.container.retention.processDeletions(workerId),
    );
  }

  async runDueJobs(): Promise<void> {
    await this.sendWarnings();
    await this.createDeletionRequests();
    await this.reviewPostponed();
    await this.processDeletions();
  }

  private async withLease(key: string, operation: () => Promise<number>): Promise<number> {
    const ownerId = this.container.config.worker.id;
    const acquired = await this.container.jobLeases.tryAcquire(
      key,
      ownerId,
      this.container.config.worker.jobLeaseMs,
    );
    if (!acquired) return 0;
    try {
      return await operation();
    } finally {
      await this.container.jobLeases.release(key, ownerId);
    }
  }
}
