import { createHash } from 'node:crypto';
import { type Collection, type Filter, MongoServerError, ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type {
  ExternalNotificationChannel,
  NotificationDeliveryDocument,
  NotificationDeliveryStatus,
  NotificationDocument,
  NotificationPreferencesDocument,
  PushDeviceDocument,
} from './notification.types';

export class NotificationRepository {
  private readonly notifications: Collection<NotificationDocument>;
  private readonly preferences: Collection<NotificationPreferencesDocument>;
  private readonly deliveries: Collection<NotificationDeliveryDocument>;
  private readonly devices: Collection<PushDeviceDocument>;

  constructor(database: Database) {
    this.notifications = database.db.collection<NotificationDocument>('notifications');
    this.preferences = database.db.collection<NotificationPreferencesDocument>(
      'notification_preferences',
    );
    this.deliveries =
      database.db.collection<NotificationDeliveryDocument>('notification_deliveries');
    this.devices = database.db.collection<PushDeviceDocument>('push_devices');
  }

  async insertNotification(
    notification: NotificationDocument,
    tx?: TransactionContext,
  ): Promise<{ inserted: boolean; notification: NotificationDocument | null }> {
    try {
      await this.notifications.insertOne(notification, opts(tx));
      return { inserted: true, notification };
    } catch (error) {
      if (isDuplicate(error)) {
        return {
          inserted: false,
          notification: await this.notifications.findOne(
            { dedupeKey: notification.dedupeKey },
            opts(tx),
          ),
        };
      }
      throw error;
    }
  }

  async insertDelivery(
    delivery: NotificationDeliveryDocument,
    tx?: TransactionContext,
  ): Promise<{ inserted: boolean; delivery: NotificationDeliveryDocument | null }> {
    try {
      await this.deliveries.insertOne(delivery, opts(tx));
      return { inserted: true, delivery };
    } catch (error) {
      if (isDuplicate(error)) {
        return {
          inserted: false,
          delivery: await this.deliveries.findOne(
            { logicalDeliveryKey: delivery.logicalDeliveryKey },
            opts(tx),
          ),
        };
      }
      throw error;
    }
  }

  async listForUser(input: {
    userId: ObjectId;
    limit: number;
    cursor?: { createdAt: Date; id: ObjectId };
    unreadOnly?: boolean;
  }) {
    return await this.notifications
      .find({
        recipientUserId: input.userId,
        ...(input.unreadOnly ? { readAt: { $exists: false } } : {}),
        ...(input.cursor
          ? {
              $or: [
                { createdAt: { $lt: input.cursor.createdAt } },
                { createdAt: input.cursor.createdAt, _id: { $lt: input.cursor.id } },
              ],
            }
          : {}),
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(input.limit)
      .toArray();
  }

  async markRead(userId: ObjectId, notificationId: ObjectId, now: Date, tx?: TransactionContext) {
    const result = await this.notifications.findOneAndUpdate(
      { _id: notificationId, recipientUserId: userId, readAt: { $exists: false } },
      { $set: { readAt: now, updatedAt: now } },
      { returnDocument: 'after', ...opts(tx) },
    );
    if (!result) {
      const existing = await this.notifications.findOne(
        { _id: notificationId, recipientUserId: userId },
        opts(tx),
      );
      if (existing) return existing;
    }
    if (!result) {
      throw new AppError({
        code: 'NOTIFICATION_NOT_FOUND',
        httpStatus: 404,
        message: 'Notification not found.',
      });
    }
    return result;
  }

  async markAllRead(userId: ObjectId, cutoffAt: Date, tx?: TransactionContext) {
    const result = await this.notifications.updateMany(
      { recipientUserId: userId, readAt: { $exists: false }, createdAt: { $lte: cutoffAt } },
      { $set: { readAt: cutoffAt, updatedAt: cutoffAt } },
      opts(tx),
    );
    return result.modifiedCount;
  }

  async getPreferences(userId: ObjectId, tx?: TransactionContext) {
    return await this.preferences.findOne({ userId }, opts(tx));
  }

  async upsertPreferences(input: {
    userId: ObjectId;
    expectedVersion: number;
    channels: NotificationPreferencesDocument['channels'];
    eventPreferences: NotificationPreferencesDocument['eventPreferences'];
    now: Date;
    tx: TransactionContext;
  }) {
    const existing = await this.preferences.findOne({ userId: input.userId }, opts(input.tx));
    if (!existing && input.expectedVersion !== 0) {
      throw conflict('NOTIFICATION_PREFERENCES_VERSION_CONFLICT');
    }
    if (existing && existing.version !== input.expectedVersion) {
      throw conflict('NOTIFICATION_PREFERENCES_VERSION_CONFLICT');
    }
    const result = await this.preferences.findOneAndUpdate(
      { userId: input.userId, ...(existing ? { version: input.expectedVersion } : {}) },
      {
        $set: {
          channels: input.channels,
          eventPreferences: input.eventPreferences,
          updatedAt: input.now,
        },
        $setOnInsert: { _id: new ObjectId(), userId: input.userId, createdAt: input.now },
        $inc: { version: 1 },
      },
      { upsert: true, returnDocument: 'after', session: input.tx.session },
    );
    if (!result) throw conflict('NOTIFICATION_PREFERENCES_VERSION_CONFLICT');
    return result;
  }

  async registerPushDevice(input: {
    userId: ObjectId;
    platform: PushDeviceDocument['platform'];
    provider: string;
    token: string;
    label?: string;
    now: Date;
  }) {
    const tokenFingerprint = fingerprint(input.token);
    const staleDevices = await this.devices
      .find({ tokenFingerprint, userId: { $ne: input.userId }, status: 'ACTIVE' })
      .toArray();
    await this.devices.updateMany(
      { tokenFingerprint, userId: { $ne: input.userId }, status: 'ACTIVE' },
      { $set: { status: 'REVOKED', revokedAt: input.now, updatedAt: input.now } },
    );
    for (const staleDevice of staleDevices) {
      await this.cancelDeliveriesForPushDevice(
        staleDevice._id,
        'PUSH_DEVICE_TOKEN_REASSIGNED',
        input.now,
      );
    }
    const result = await this.devices.findOneAndUpdate(
      { userId: input.userId, tokenFingerprint },
      {
        $set: {
          platform: input.platform,
          provider: input.provider,
          token: input.token,
          tokenFingerprint,
          status: 'ACTIVE',
          lastSeenAt: input.now,
          updatedAt: input.now,
          ...(input.label ? { label: input.label } : {}),
        },
        $setOnInsert: { _id: new ObjectId(), userId: input.userId, createdAt: input.now },
        $unset: { revokedAt: '' },
      },
      { upsert: true, returnDocument: 'after' },
    );
    if (!result) throw conflict('PUSH_DEVICE_REGISTRATION_CONFLICT');
    return result;
  }

  async listActivePushDevices(userId: ObjectId, tx?: TransactionContext) {
    return await this.devices.find({ userId, status: 'ACTIVE' }, opts(tx)).toArray();
  }

  async revokePushDevice(userId: ObjectId, deviceId: ObjectId, now: Date) {
    const result = await this.devices.findOneAndUpdate(
      { _id: deviceId, userId },
      { $set: { status: 'REVOKED', revokedAt: now, updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (!result) {
      throw new AppError({
        code: 'PUSH_DEVICE_NOT_FOUND',
        httpStatus: 404,
        message: 'Push device not found.',
      });
    }
    await this.cancelDeliveriesForPushDevice(deviceId, 'PUSH_DEVICE_REVOKED', now);
    return result;
  }

  async revokePushDeviceById(deviceId: ObjectId, now: Date) {
    await this.devices.updateOne(
      { _id: deviceId },
      { $set: { status: 'REVOKED', revokedAt: now, updatedAt: now } },
    );
    await this.cancelDeliveriesForPushDevice(deviceId, 'PUSH_DEVICE_INVALID', now);
  }

  async findPushDevice(deviceId: ObjectId) {
    return await this.devices.findOne({ _id: deviceId, status: 'ACTIVE' });
  }

  async claimNextDelivery(input: {
    workerId: string;
    now: Date;
    claimMs: number;
    channels?: ExternalNotificationChannel[];
  }) {
    const eligibleStatus: NotificationDeliveryStatus[] = ['PENDING', 'RETRYING'];
    return await this.deliveries.findOneAndUpdate(
      {
        status: { $in: eligibleStatus },
        ...(input.channels ? { channel: { $in: input.channels } } : {}),
        $and: [
          {
            $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: input.now } }],
          },
          {
            $or: [{ claimedUntil: { $exists: false } }, { claimedUntil: { $lte: input.now } }],
          },
        ],
      },
      {
        $set: {
          claimedBy: input.workerId,
          claimedUntil: new Date(input.now.getTime() + input.claimMs),
          lastAttemptAt: input.now,
          updatedAt: input.now,
        },
        $inc: { version: 1 },
      },
      { sort: { nextAttemptAt: 1, createdAt: 1, _id: 1 }, returnDocument: 'after' },
    );
  }

  async markDeliverySent(input: {
    delivery: NotificationDeliveryDocument;
    providerMessageId?: string;
    now: Date;
  }) {
    const claimedBy = input.delivery.claimedBy;
    if (!claimedBy) return;
    await this.deliveries.updateOne(
      { _id: input.delivery._id, claimedBy },
      {
        $set: {
          status: 'SENT',
          attemptCount: input.delivery.attemptCount + 1,
          updatedAt: input.now,
          ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}),
        },
        $unset: { claimedBy: '', claimedUntil: '', nextAttemptAt: '', lastError: '' },
        $inc: { version: 1 },
      },
    );
  }

  async markDeliveryRetry(input: {
    delivery: NotificationDeliveryDocument;
    code: string;
    message: string;
    retryable: boolean;
    maxAttempts: number;
    nextAttemptAt: Date;
    now: Date;
  }) {
    const claimedBy = input.delivery.claimedBy;
    if (!claimedBy) return;
    const attempts = input.delivery.attemptCount + 1;
    const terminal = attempts >= input.maxAttempts || !input.retryable;
    await this.deliveries.updateOne(
      { _id: input.delivery._id, claimedBy },
      {
        $set: {
          status: terminal ? 'FAILED' : 'RETRYING',
          attemptCount: attempts,
          updatedAt: input.now,
          lastError: {
            code: input.code.slice(0, 120),
            message: input.message.slice(0, 500),
            retryable: input.retryable,
          },
          ...(terminal
            ? { failedReason: input.code.slice(0, 120) }
            : { nextAttemptAt: input.nextAttemptAt }),
        },
        $unset: { claimedBy: '', claimedUntil: '' },
        $inc: { version: 1 },
      },
    );
  }

  async cancelDelivery(
    delivery: NotificationDeliveryDocument,
    reason: string,
    now: Date,
  ): Promise<void> {
    const claimedBy = delivery.claimedBy;
    if (!claimedBy) return;
    await this.deliveries.updateOne(
      { _id: delivery._id, claimedBy },
      {
        $set: { status: 'CANCELLED', cancelledReason: reason, updatedAt: now },
        $unset: { claimedBy: '', claimedUntil: '', nextAttemptAt: '' },
        $inc: { version: 1 },
      },
    );
  }

  async count(filter: Filter<NotificationDocument> = {}) {
    return await this.notifications.countDocuments(filter);
  }

  private async cancelDeliveriesForPushDevice(deviceId: ObjectId, reason: string, now: Date) {
    await this.deliveries.updateMany(
      {
        'destinationSnapshot.pushDeviceId': deviceId,
        status: { $in: ['PENDING', 'RETRYING'] },
      },
      { $set: { status: 'CANCELLED', cancelledReason: reason, updatedAt: now } },
    );
  }
}

export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function opts(tx?: TransactionContext) {
  return tx ? { session: tx.session } : undefined;
}

function isDuplicate(error: unknown): error is MongoServerError {
  return error instanceof MongoServerError && error.code === 11000;
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The notification state has changed.' });
}
