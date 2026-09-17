import type { AppContainer } from '../../bootstrap/app-container';

export class SupportAccessJobRunner {
  constructor(private readonly container: AppContainer) {}

  async expireSessions(): Promise<number> {
    return await this.container.supportAccess.expireDue(this.container.jobLeases);
  }
}
