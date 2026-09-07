import type { Collection, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/config.types';
import type { Database } from '../database/database';
import type { OutboxEventDocument } from './outbox.types';

export type OutboxHandler = (event: OutboxEventDocument) => Promise<void>;

export class OutboxProcessor {
  private readonly collection: Collection<OutboxEventDocument>;
  private readonly handlers = new Map<string, OutboxHandler>();

  constructor(
    database: Database,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.collection = database.db.collection<OutboxEventDocument>('outbox_events');
  }

  register(eventType: string, handler: OutboxHandler): void {
    if (this.handlers.has(eventType)) {
      throw new Error(`Outbox handler already registered for ${eventType}`);
    }
    this.handlers.set(eventType, handler);
  }

  async processOne(): Promise<boolean> {
    const now = new Date();
    const _lockUntil = new Date(now.getTime() + this.config.worker.outboxLockMs);

    const event = await this.collection.findOneAndUpdate(
      {
        status: { $in: ['PENDING', 'PROCESSING'] },
        $and: [
          {
            $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }],
          },
          {
            $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lte: now } }],
          },
        ],
      },
      {
        $set: {
          status: 'PROCESSING',
          lockedBy: this.config.worker.id,
          lockedUntil: _lockUntil,
        },
      },
      {
        sort: { occurredAt: 1 },
        returnDocument: 'after',
      },
    );

    if (!event) return false;

    const handler = this.handlers.get(event.eventType);
    if (!handler) {
      await this.markFailed(
        event._id!,
        event.attempts,
        `No handler registered for ${event.eventType}`,
      );
      return true;
    }

    try {
      await handler(event);
      await this.collection.updateOne(
        { _id: event._id, lockedBy: this.config.worker.id },
        {
          $set: {
            status: 'PROCESSED',
            processedAt: new Date(),
          },
          $unset: {
            lockedBy: '',
            lockedUntil: '',
            nextAttemptAt: '',
            lastError: '',
          },
        },
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown outbox handler error';
      this.logger.error(
        { err: error, eventId: event._id, eventType: event.eventType },
        'Outbox handler failed',
      );
      await this.markFailed(event._id!, event.attempts, message);
      return true;
    }
  }

  private async markFailed(id: ObjectId, previousAttempts: number, message: string): Promise<void> {
    const attempts = previousAttempts + 1;
    const terminal = attempts >= this.config.worker.outboxMaxAttempts;
    const delayMs = Math.min(60 * 60 * 1_000, 1_000 * 2 ** Math.min(attempts, 12));

    await this.collection.updateOne(
      { _id: id, lockedBy: this.config.worker.id },
      {
        $set: {
          status: terminal ? 'FAILED' : 'PENDING',
          attempts,
          lastError: message.slice(0, 2_000),
          ...(terminal ? {} : { nextAttemptAt: new Date(Date.now() + delayMs) }),
        },
        $unset: {
          lockedBy: '',
          lockedUntil: '',
        },
      },
    );
  }
}
