import type { AppContainer } from '../../bootstrap/app-container';

export class CheckInJobRunner {
  constructor(
    private readonly container: AppContainer,
    private readonly ownerId: string,
  ) {}

  async runDueJobs(): Promise<void> {
    if (await this.container.jobLeases.tryAcquire('generate-checkins', this.ownerId, 30_000)) {
      try {
        await this.container.checkins.generateDueInstances();
      } finally {
        await this.container.jobLeases.release('generate-checkins', this.ownerId);
      }
    }
    if (await this.container.jobLeases.tryAcquire('mark-checkins-overdue', this.ownerId, 30_000)) {
      try {
        await this.container.checkins.markOverdue();
      } finally {
        await this.container.jobLeases.release('mark-checkins-overdue', this.ownerId);
      }
    }
  }
}
