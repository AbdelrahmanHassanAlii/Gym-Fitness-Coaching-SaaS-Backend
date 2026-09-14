import type { AppContainer } from '../../bootstrap/app-container';

export class FileJobRunner {
  constructor(private readonly container: AppContainer) {}

  async runDueJobs(): Promise<void> {
    await this.withLease('expire-upload-intents', async () => {
      await this.container.files.expireUploadIntents();
    });
    await this.withLease('purge-files', async () => {
      await this.container.files.purgeFiles();
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
