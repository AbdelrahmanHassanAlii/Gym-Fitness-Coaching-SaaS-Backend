import { loadConfig } from '../config/config';
import { Database } from '../core/database/database';
import { migrations } from '../migrations';
import { MigrationRunner } from '../migrations/migration-runner';

const config = loadConfig();
const database = await Database.connect(config);

try {
  const runner = new MigrationRunner(database.db, migrations);
  const status = await runner.status();
  for (const migration of status) {
    console.log(`${migration.applied ? '[x]' : '[ ]'} ${migration.id} - ${migration.description}`);
  }
} finally {
  await database.close();
}
