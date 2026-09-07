import { createAppContainer } from '../bootstrap/app-container';
import { loadConfig } from '../config/config';
import { buildApp } from './build-app';

const config = loadConfig();
const container = await createAppContainer(config);
const app = await buildApp(container);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info({ signal }, 'API shutdown started');

  try {
    await app.close();
    await container.database.close();
    app.log.info('API shutdown complete');
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'API shutdown failed');
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.app.host, port: config.app.port });
  app.log.info({ port: config.app.port, env: config.env }, 'Gym Platform API started');
} catch (error) {
  app.log.fatal({ err: error }, 'Unable to start API');
  await container.database.close();
  process.exit(1);
}
