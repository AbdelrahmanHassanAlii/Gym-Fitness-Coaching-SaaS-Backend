import { createAppContainer } from '../bootstrap/app-container';
import { loadConfig } from '../config/config';
import { OutboxProcessor } from '../core/events/outbox.processor';
import { createLogger } from '../core/logging/logger';
import { CheckInJobRunner } from '../modules/checkins/checkin.jobs';
import { SubscriptionJobRunner } from '../modules/subscriptions/subscription.jobs';
import { registerTraineeOutboxHandlers } from '../modules/trainees/trainee.outbox-handlers';

const config = loadConfig();
const logger = createLogger(config).child({ process: 'worker', workerId: config.worker.id });
const container = await createAppContainer(config);
const outbox = new OutboxProcessor(container.database, config, logger);
registerTraineeOutboxHandlers(outbox, container.trainees);
const subscriptionJobs = new SubscriptionJobRunner(container);
const checkInJobs = new CheckInJobRunner(container, config.worker.id);

let shuttingDown = false;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  logger.info('Gym Platform worker started');

  while (!shuttingDown) {
    try {
      const processed = await outbox.processOne();
      await subscriptionJobs.runDueJobs();
      await checkInJobs.runDueJobs();
      if (!processed && !shuttingDown) {
        await sleep(config.worker.outboxPollIntervalMs);
      }
    } catch (error) {
      logger.error({ err: error }, 'Worker loop error');
      if (!shuttingDown) {
        await sleep(config.worker.outboxPollIntervalMs);
      }
    }
  }
}

function requestShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Worker shutdown requested; current operation will finish first');
}

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

try {
  await run();
  await container.database.close();
  logger.info('Worker shutdown complete');
} catch (error) {
  logger.fatal({ err: error }, 'Worker terminated unexpectedly');
  await container.database.close().catch(() => undefined);
  process.exit(1);
}
