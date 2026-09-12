import type { AppContainer } from '../../bootstrap/app-container';

export class CheckInJobRunner {
  constructor(private readonly container: AppContainer) {}

  async runDueJobs(): Promise<void> {
    if (
      await this.container.jobLeases.tryAcquire(
        'generate-checkins',
        this.container.config.worker.id,
        this.container.config.worker.jobLeaseMs,
      )
    ) {
      try {
        await this.container.checkins.generateDueInstances();
      } finally {
        await this.container.jobLeases.release(
          'generate-checkins',
          this.container.config.worker.id,
        );
      }
    }
    if (
      await this.container.jobLeases.tryAcquire(
        'mark-checkins-overdue',
        this.container.config.worker.id,
        this.container.config.worker.jobLeaseMs,
      )
    ) {
      try {
        await this.container.checkins.markOverdue();
      } finally {
        await this.container.jobLeases.release(
          'mark-checkins-overdue',
          this.container.config.worker.id,
        );
      }
    }
  }
}
