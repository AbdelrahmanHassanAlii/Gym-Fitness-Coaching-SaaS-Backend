import { type Collection, MongoServerError } from 'mongodb';
import type { Database } from '../database/database';

interface JobLeaseDocument {
  key: string;
  ownerId: string;
  lockedUntil: Date;
  updatedAt: Date;
}

export class JobLeaseManager {
  private readonly collection: Collection<JobLeaseDocument>;

  constructor(database: Database) {
    this.collection = database.db.collection<JobLeaseDocument>('job_leases');
  }

  async tryAcquire(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + ttlMs);

    const updated = await this.collection.findOneAndUpdate(
      {
        key,
        $or: [{ lockedUntil: { $lte: now } }, { ownerId }],
      },
      {
        $set: { ownerId, lockedUntil, updatedAt: now },
      },
      { returnDocument: 'after' },
    );

    if (updated) return true;

    try {
      await this.collection.insertOne({ key, ownerId, lockedUntil, updatedAt: now });
      return true;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) return false;
      throw error;
    }
  }

  async release(key: string, ownerId: string): Promise<void> {
    await this.collection.updateOne(
      { key, ownerId },
      { $set: { lockedUntil: new Date(0), updatedAt: new Date() } },
    );
  }
}
