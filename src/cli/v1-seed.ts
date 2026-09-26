import { loadConfig } from '../config/config';
import { Database } from '../core/database/database';
import { AppError } from '../core/errors/app-error';
import { parseSeedArgs } from '../seeds/v1/seed-config';
import { assertSeedGuards } from '../seeds/v1/seed-guards';
import { runV1Seed } from '../seeds/v1/seed-runner';

let database: Database | undefined;

try {
  const options = parseSeedArgs(Bun.argv.slice(2));
  const config = loadConfig();
  assertSeedGuards(config, options);
  database = await Database.connect(config);

  const result = await runV1Seed({ config, db: database.db, options });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (error instanceof AppError) {
    console.error(`${error.code}: ${error.message}`);
    if (error.details) console.error(JSON.stringify(error.details));
    process.exitCode = 1;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  await database?.close();
}
