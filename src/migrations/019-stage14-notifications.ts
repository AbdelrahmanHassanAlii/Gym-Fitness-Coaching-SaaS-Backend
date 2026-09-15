import type { Migration } from './migration.types';

export const migration019Stage14Notifications: Migration = {
  id: '019-stage14-notifications',
  description: 'Create Stage 14 notifications, preferences, deliveries, and push-device indexes',
  async up(db) {
    await db.collection('notifications').createIndexes([
      {
        key: { recipientUserId: 1, createdAt: -1, _id: -1 },
        name: 'notifications_recipient_cursor',
      },
      {
        key: { recipientUserId: 1, readAt: 1, createdAt: -1 },
        name: 'notifications_recipient_unread',
      },
      {
        key: { dedupeKey: 1 },
        unique: true,
        name: 'notifications_dedupe_unique',
      },
      {
        key: { sourceEventId: 1, recipientUserId: 1, notificationType: 1 },
        unique: true,
        name: 'notifications_source_recipient_type_unique',
      },
    ]);

    await db.collection('notification_preferences').createIndexes([
      {
        key: { userId: 1 },
        unique: true,
        name: 'notification_preferences_user_unique',
      },
    ]);

    await db.collection('notification_deliveries').createIndexes([
      {
        key: { logicalDeliveryKey: 1 },
        unique: true,
        name: 'notification_deliveries_logical_key_unique',
      },
      {
        key: { status: 1, nextAttemptAt: 1, claimedUntil: 1, createdAt: 1, _id: 1 },
        name: 'notification_deliveries_worker_due',
      },
      {
        key: { sourceEventId: 1, channel: 1, recipientUserId: 1 },
        name: 'notification_deliveries_source_lookup',
      },
      {
        key: { 'destinationSnapshot.pushDeviceId': 1, status: 1 },
        name: 'notification_deliveries_push_device_status',
      },
    ]);

    await db.collection('push_devices').createIndexes([
      {
        key: { userId: 1, tokenFingerprint: 1 },
        unique: true,
        name: 'push_devices_user_token_unique',
      },
      {
        key: { tokenFingerprint: 1 },
        name: 'push_devices_token_fingerprint',
      },
      {
        key: { userId: 1, status: 1, updatedAt: -1 },
        name: 'push_devices_user_active',
      },
    ]);
  },
};
