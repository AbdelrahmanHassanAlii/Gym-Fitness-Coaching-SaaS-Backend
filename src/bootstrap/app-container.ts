import type { AppConfig } from '../config/config.types';
import { AuditWriter } from '../core/audit/audit.writer';
import { Database } from '../core/database/database';
import { UnitOfWork } from '../core/database/unit-of-work';
import { OutboxWriter } from '../core/events/outbox.writer';
import { JobLeaseManager } from '../core/jobs/job-lease.manager';

export interface AppContainer {
  config: AppConfig;
  database: Database;
  unitOfWork: UnitOfWork;
  audit: AuditWriter;
  outbox: OutboxWriter;
  jobLeases: JobLeaseManager;
}

export async function createAppContainer(config: AppConfig): Promise<AppContainer> {
  const database = await Database.connect(config);

  return {
    config,
    database,
    unitOfWork: new UnitOfWork(database),
    audit: new AuditWriter(database),
    outbox: new OutboxWriter(database),
    jobLeases: new JobLeaseManager(database),
  };
}
