import { type Db, MongoClient, ServerApiVersion } from 'mongodb';
import type { AppConfig } from '../../config/config.types';

export class Database {
  readonly client: MongoClient;
  readonly db: Db;

  private constructor(client: MongoClient, db: Db) {
    this.client = client;
    this.db = db;
  }

  static async connect(config: AppConfig): Promise<Database> {
    const client = new MongoClient(config.mongo.uri, {
      connectTimeoutMS: config.mongo.connectTimeoutMs,
      serverApi: {
        version: ServerApiVersion.v1,
        strict: false,
        deprecationErrors: true,
      },
      appName: 'gym-platform-backend',
    });

    await client.connect();
    const db = client.db(config.mongo.dbName);
    await db.command({ ping: 1 });

    return new Database(client, db);
  }

  async ping(): Promise<boolean> {
    const result = await this.db.command({ ping: 1 });
    return result.ok === 1;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
