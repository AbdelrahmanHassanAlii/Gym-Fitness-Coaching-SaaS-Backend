import type { AppContainer } from '../../bootstrap/app-container';

export class NotificationJobRunner {
  constructor(private readonly container: AppContainer) {}

  async runDueJobs(): Promise<void> {
    await this.container.notifications.processDueDeliveries(this.container.jobLeases);
  }
}
