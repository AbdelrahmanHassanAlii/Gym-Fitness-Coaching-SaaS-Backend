import type { ObjectId } from 'mongodb';

export const NotificationChannels = ['IN_APP', 'EMAIL', 'PUSH'] as const;
export type NotificationChannel = (typeof NotificationChannels)[number];
export type ExternalNotificationChannel = Exclude<NotificationChannel, 'IN_APP'>;

export const NotificationDeliveryStatuses = [
  'PENDING',
  'RETRYING',
  'SENT',
  'FAILED',
  'CANCELLED',
] as const;
export type NotificationDeliveryStatus = (typeof NotificationDeliveryStatuses)[number];

export type NotificationCategory =
  | 'TRAINING'
  | 'WORKOUT'
  | 'NUTRITION'
  | 'CHECK_IN'
  | 'DOCUMENT'
  | 'RELATIONSHIP'
  | 'SECURITY'
  | 'SUBSCRIPTION';

export interface NotificationDocument {
  _id: ObjectId;
  recipientUserId: ObjectId;
  workspaceId?: ObjectId;
  eventType: string;
  notificationType: string;
  category: NotificationCategory;
  title: string;
  body: string;
  payload?: Record<string, string>;
  readAt?: Date;
  sourceEventId: ObjectId;
  sourceType: string;
  sourceId: string;
  dedupeKey: string;
  templateKey: string;
  templateVersion: number;
  locale: 'ar' | 'en';
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationPreferencesDocument {
  _id: ObjectId;
  userId: ObjectId;
  channels: {
    email: boolean;
    push: boolean;
    inApp: boolean;
  };
  eventPreferences: Record<string, { email?: boolean; push?: boolean; inApp?: boolean }>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationDeliveryDocument {
  _id: ObjectId;
  notificationId?: ObjectId;
  sourceEventId: ObjectId;
  recipientUserId?: ObjectId;
  channel: ExternalNotificationChannel;
  status: NotificationDeliveryStatus;
  attemptCount: number;
  nextAttemptAt?: Date;
  lastAttemptAt?: Date;
  lastError?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  destinationSnapshot: {
    kind: 'USER_EMAIL' | 'PUSH_DEVICE';
    fingerprint: string;
    email?: string;
    pushDeviceId?: ObjectId;
  };
  logicalDeliveryKey: string;
  providerIdempotencyKey?: string;
  providerSupportsIdempotency: boolean;
  providerMessageId?: string;
  claimedBy?: string;
  claimedUntil?: Date;
  cancelledReason?: string;
  failedReason?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PushDeviceDocument {
  _id: ObjectId;
  userId: ObjectId;
  platform: 'IOS' | 'ANDROID' | 'WEB';
  provider: string;
  token: string;
  tokenFingerprint: string;
  status: 'ACTIVE' | 'REVOKED';
  label?: string;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;
  revokedAt?: Date;
}
