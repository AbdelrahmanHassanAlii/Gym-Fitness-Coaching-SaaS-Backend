import { loadConfig } from '../config/config';
import { Database } from '../core/database/database';
import { migrations } from '../migrations';
import { MigrationRunner } from '../migrations/migration-runner';

const config = loadConfig();
const database = await Database.connect(config);

try {
  const runner = new MigrationRunner(database.db, migrations);
  await runner.migrate();
  console.log('Database migrations complete.');
} finally {
  await database.close();
}
