import { ObjectId } from 'mongodb';
import type { AppConfig } from '../../config/config.types';
import type { AuditWriter } from '../../core/audit/audit.writer';
import type { Database } from '../../core/database/database';
import type { UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { OutboxEventDocument } from '../../core/events/outbox.types';
import type { JobLeaseManager } from '../../core/jobs/job-lease.manager';
import { type EmailProvider, MessagingProviderError } from '../../core/messaging/email.provider';
import type { PushProvider } from '../../core/messaging/push.provider';
import type { RequestContext } from '../../core/request-context/request-context';
import type { CheckInRepository } from '../checkins/checkin.repository';
import type { IdentityRepository } from '../identity/identity.repository';
import type { CoachingRelationshipRepository } from '../trainees/trainee.repository';
import type {
  WorkspaceMembershipRepository,
  WorkspaceRepository,
} from '../workspaces/workspace.repository';
import { entriesForEvent, type NotificationRegistryEntry } from './notification.registry';
import { fingerprint, type NotificationRepository } from './notification.repository';
import { normalizeLocale, templateFor } from './notification.templates';
import type {
  ExternalNotificationChannel,
  NotificationDeliveryDocument,
  NotificationDocument,
  NotificationPreferencesDocument,
} from './notification.types';

const defaultPreferences = {
  channels: { email: true, push: true, inApp: true },
  eventPreferences: {},
};

export class NotificationApplicationService {
  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly unitOfWork: UnitOfWork,
    private readonly notifications: NotificationRepository,
    private readonly identity: IdentityRepository,
    private readonly workspaceRepo: WorkspaceRepository,
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly relationships: CoachingRelationshipRepository,
    private readonly checkins: CheckInRepository,
    private readonly audit: AuditWriter,
    private readonly emailProvider: EmailProvider,
    private readonly pushProvider: PushProvider,
  ) {}

  async list(ctx: RequestContext, query: { limit?: number; cursor?: string; unread?: boolean }) {
    const userId = userObjectId(ctx);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const rows = await this.notifications.listForUser({
      userId,
      limit: limit + 1,
      ...(query.cursor ? { cursor: decodeCursor(query.cursor) } : {}),
      ...(query.unread !== undefined ? { unreadOnly: query.unread } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      data: page.map(safeNotification),
      page: {
        nextCursor:
          rows.length > limit && page.length > 0
            ? encodeCursor(last(page).createdAt, last(page)._id)
            : null,
      },
    };
  }

  async markRead(ctx: RequestContext, notificationId: string) {
    const notification = await this.unitOfWork.withTransaction(async (tx) =>
      this.notifications.markRead(
        userObjectId(ctx),
        objectId(notificationId, 'NOTIFICATION_NOT_FOUND'),
        new Date(),
        tx,
      ),
    );
    return { data: safeNotification(notification) };
  }

  async markAllRead(ctx: RequestContext) {
    const cutoffAt = new Date();
    const affectedCount = await this.unitOfWork.withTransaction((tx) =>
      this.notifications.markAllRead(userObjectId(ctx), cutoffAt, tx),
    );
    return { data: { cutoffAt: cutoffAt.toISOString(), affectedCount } };
  }

  async getPreferences(ctx: RequestContext) {
    const stored = await this.notifications.getPreferences(userObjectId(ctx));
    return { data: serializePreferences(effectivePreferences(stored)) };
  }

  async putPreferences(
    ctx: RequestContext,
    input: {
      expectedVersion: number;
      channels?: Partial<NotificationPreferencesDocument['channels']>;
      eventPreferences?: NotificationPreferencesDocument['eventPreferences'];
    },
  ) {
    const userId = userObjectId(ctx);
    const now = new Date();
    const updated = await this.unitOfWork.withTransaction(async (tx) => {
      const current = effectivePreferences(await this.notifications.getPreferences(userId, tx));
      const nextChannels = {
        ...current.channels,
        ...(input.channels ?? {}),
      };
      const nextEventPreferences = input.eventPreferences ?? current.eventPreferences;
      validateEventPreferences(nextEventPreferences);
      const result = await this.notifications.upsertPreferences({
        userId,
        expectedVersion: input.expectedVersion,
        channels: nextChannels,
        eventPreferences: nextEventPreferences,
        now,
        tx,
      });
      await this.audit.write(
        {
          eventType: 'NotificationPreferencesUpdated',
          actor: { userId },
          entity: { type: 'notification_preferences', id: result._id },
          action: 'update',
          ipAddress: ctx.ipAddress,
          ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
          correlationId: ctx.correlationId,
        },
        tx,
      );
      return result;
    });
    return { data: serializePreferences(updated) };
  }

  async registerPushDevice(
    ctx: RequestContext,
    input: { platform: 'IOS' | 'ANDROID' | 'WEB'; provider: string; token: string; label?: string },
  ) {
    const device = await this.notifications.registerPushDevice({
      userId: userObjectId(ctx),
      platform: input.platform,
      provider: input.provider.trim(),
      token: input.token,
      ...(input.label ? { label: input.label } : {}),
      now: new Date(),
    });
    return { data: safePushDevice(device) };
  }

  async revokePushDevice(ctx: RequestContext, deviceId: string) {
    const device = await this.notifications.revokePushDevice(
      userObjectId(ctx),
      objectId(deviceId, 'PUSH_DEVICE_NOT_FOUND'),
      new Date(),
    );
    return { data: safePushDevice(device) };
  }

  async handleOutboxEvent(event: OutboxEventDocument): Promise<void> {
    const entries = entriesForEvent(event.eventType);
    if (entries.length === 0 || !event._id) return;
    for (const entry of entries) {
      if (!(await this.isEventStillMeaningful(event, entry))) continue;
      const recipients = await this.resolveRecipients(event, entry);
      for (const recipientUserId of uniqueObjectIds(recipients)) {
        await this.createForRecipient(event, entry, recipientUserId);
      }
    }
  }

  async processDueDeliveries(jobLeases: JobLeaseManager): Promise<number> {
    const acquired = await jobLeases.tryAcquire(
      'notifications.delivery',
      this.config.worker.id,
      this.config.worker.jobLeaseMs,
    );
    if (!acquired) return 0;
    let processed = 0;
    try {
      const batchSize = notificationConfig(this.config).deliveryBatchSize;
      for (let index = 0; index < batchSize; index += 1) {
        const claimed = await this.notifications.claimNextDelivery({
          workerId: this.config.worker.id,
          now: new Date(),
          claimMs: notificationConfig(this.config).deliveryClaimMs,
        });
        if (!claimed) break;
        await this.processClaimedDelivery(claimed);
        processed += 1;
      }
    } finally {
      await jobLeases.release('notifications.delivery', this.config.worker.id);
    }
    return processed;
  }

  private async createForRecipient(
    event: OutboxEventDocument,
    entry: NotificationRegistryEntry,
    recipientUserId: ObjectId,
  ) {
    if (!event._id) return;
    const user = await this.identity.findById(recipientUserId);
    if (user?.status !== 'ACTIVE') return;
    const workspace = event.workspaceId
      ? await this.workspaceRepo.findById(event.workspaceId)
      : null;
    const locale = normalizeLocale(user.preferredLanguage || workspace?.defaultLanguage);
    const template = templateFor(entry.notificationType);
    const rendered = template.render(locale);
    const now = new Date();
    const dedupeKey = `${event._id.toHexString()}:${recipientUserId.toHexString()}:${entry.notificationType}`;
    const payload = safePayload(event);
    let notification: NotificationDocument | null = null;
    if (entry.channels.includes('IN_APP')) {
      const result = await this.notifications.insertNotification({
        _id: new ObjectId(),
        recipientUserId,
        ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
        eventType: event.eventType,
        notificationType: entry.notificationType,
        category: entry.category,
        title: rendered.title,
        body: rendered.body,
        payload,
        sourceEventId: event._id,
        sourceType: event.aggregateType,
        sourceId: String(event.aggregateId),
        dedupeKey,
        templateKey: template.key,
        templateVersion: template.version,
        locale,
        createdAt: now,
        updatedAt: now,
      });
      notification = result.notification;
    }
    for (const channel of entry.channels) {
      if (channel === 'EMAIL') {
        await this.createEmailDelivery(
          event,
          entry,
          recipientUserId,
          rendered,
          notification,
          user.email,
          now,
        );
      }
      if (channel === 'PUSH') {
        const devices = await this.notifications.listActivePushDevices(recipientUserId);
        for (const device of devices) {
          await this.notifications.insertDelivery({
            _id: new ObjectId(),
            ...(notification?._id ? { notificationId: notification._id } : {}),
            sourceEventId: event._id,
            recipientUserId,
            channel: 'PUSH',
            status: 'PENDING',
            attemptCount: 0,
            destinationSnapshot: {
              kind: 'PUSH_DEVICE',
              fingerprint: device.tokenFingerprint,
              pushDeviceId: device._id,
            },
            logicalDeliveryKey: `${dedupeKey}:PUSH:${device._id.toHexString()}`,
            providerIdempotencyKey: `${dedupeKey}:PUSH:${device._id.toHexString()}`,
            providerSupportsIdempotency: this.pushProvider.supportsIdempotency,
            version: 0,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }
  }

  private async createEmailDelivery(
    event: OutboxEventDocument,
    entry: NotificationRegistryEntry,
    recipientUserId: ObjectId,
    rendered: { title: string; body: string },
    notification: NotificationDocument | null,
    email: string | undefined,
    now: Date,
  ) {
    if (!event._id || !email) return;
    const destination = email.trim().toLowerCase();
    if (!destination) return;
    const dedupeKey = `${event._id.toHexString()}:${recipientUserId.toHexString()}:${entry.notificationType}`;
    await this.notifications.insertDelivery({
      _id: new ObjectId(),
      ...(notification?._id ? { notificationId: notification._id } : {}),
      sourceEventId: event._id,
      recipientUserId,
      channel: 'EMAIL',
      status: 'PENDING',
      attemptCount: 0,
      destinationSnapshot: {
        kind: 'USER_EMAIL',
        fingerprint: fingerprint(destination),
        email: destination,
      },
      logicalDeliveryKey: `${dedupeKey}:EMAIL:${fingerprint(destination)}`,
      providerIdempotencyKey: `${dedupeKey}:EMAIL:${fingerprint(destination)}`,
      providerSupportsIdempotency: this.emailProvider.supportsIdempotency,
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
    void rendered;
  }

  private async processClaimedDelivery(delivery: NotificationDeliveryDocument) {
    const now = new Date();
    const entry = await this.entryForDelivery(delivery);
    if (!entry) {
      await this.notifications.cancelDelivery(delivery, 'REGISTRY_ENTRY_MISSING', now);
      return;
    }
    if (delivery.recipientUserId) {
      const allowed = await this.isDeliveryAllowed(
        delivery.recipientUserId,
        delivery.channel,
        entry,
      );
      if (!allowed) {
        await this.notifications.cancelDelivery(delivery, 'PREFERENCES_DISABLED', now);
        return;
      }
      if (!(await this.isRecipientStillEligible(delivery))) {
        await this.notifications.cancelDelivery(delivery, 'RECIPIENT_NOT_ELIGIBLE', now);
        return;
      }
    }
    try {
      const message = await this.messageForDelivery(delivery);
      if (delivery.channel === 'EMAIL') {
        const email = delivery.destinationSnapshot.email;
        if (!email)
          throw new MessagingProviderError(
            'Missing email destination',
            'EMAIL_DESTINATION_INVALID',
            false,
            true,
          );
        const result = await this.emailProvider.sendEmail({
          to: email,
          subject: message.title,
          text: message.body,
          ...(delivery.providerIdempotencyKey
            ? { idempotencyKey: delivery.providerIdempotencyKey }
            : {}),
        });
        await this.notifications.markDeliverySent({
          delivery,
          ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
          now,
        });
      } else {
        const deviceId = delivery.destinationSnapshot.pushDeviceId;
        if (!deviceId)
          throw new MessagingProviderError(
            'Missing push device',
            'PUSH_DEVICE_MISSING',
            false,
            true,
          );
        const device = await this.notifications.findPushDevice(deviceId);
        if (!device) {
          await this.notifications.cancelDelivery(delivery, 'PUSH_DEVICE_INACTIVE', now);
          return;
        }
        const result = await this.pushProvider.sendPush({
          token: device.token,
          title: message.title,
          body: message.body,
          ...(delivery.providerIdempotencyKey
            ? { idempotencyKey: delivery.providerIdempotencyKey }
            : {}),
        });
        await this.notifications.markDeliverySent({
          delivery,
          ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
          now,
        });
      }
    } catch (error) {
      const providerError =
        error instanceof MessagingProviderError
          ? error
          : new MessagingProviderError('Provider failure', 'PROVIDER_FAILURE', true);
      if (providerError.invalidDestination && delivery.destinationSnapshot.pushDeviceId) {
        await this.notifications.revokePushDeviceById(
          delivery.destinationSnapshot.pushDeviceId,
          now,
        );
      }
      await this.notifications.markDeliveryRetry({
        delivery,
        code: providerError.code,
        message: 'Provider delivery failed.',
        retryable: providerError.retryable && !providerError.invalidDestination,
        maxAttempts: notificationConfig(this.config).deliveryMaxAttempts,
        nextAttemptAt: new Date(now.getTime() + retryDelayMs(delivery.attemptCount + 1)),
        now,
      });
    }
  }

  private async entryForDelivery(delivery: NotificationDeliveryDocument) {
    const source = await this.database.db
      .collection('outbox_events')
      .findOne({ _id: delivery.sourceEventId });
    if (!source) return null;
    return entriesForEvent(String(source.eventType)).find((entry) =>
      entry.channels.includes(delivery.channel),
    );
  }

  private async messageForDelivery(delivery: NotificationDeliveryDocument) {
    if (delivery.notificationId) {
      const notification = await this.database.db
        .collection<NotificationDocument>('notifications')
        .findOne({ _id: delivery.notificationId });
      if (notification) return { title: notification.title, body: notification.body };
    }
    return { title: 'Notification', body: 'You have a notification.' };
  }

  private async isDeliveryAllowed(
    userId: ObjectId,
    channel: ExternalNotificationChannel,
    entry: NotificationRegistryEntry,
  ) {
    if (entry.mandatory) return true;
    const prefs = effectivePreferences(await this.notifications.getPreferences(userId));
    const channelKey = channel === 'EMAIL' ? 'email' : 'push';
    const override = prefs.eventPreferences[entry.notificationType]?.[channelKey];
    return override ?? prefs.channels[channelKey];
  }

  private async isRecipientStillEligible(delivery: NotificationDeliveryDocument) {
    if (!delivery.notificationId || !delivery.recipientUserId) return true;
    const notification = await this.database.db
      .collection<NotificationDocument>('notifications')
      .findOne({ _id: delivery.notificationId });
    if (!notification?.workspaceId) return true;
    const membership = await this.memberships.findByUserInWorkspace(
      notification.workspaceId,
      delivery.recipientUserId,
    );
    if (membership?.status !== 'ACTIVE') return false;
    const relationshipId = notification.payload?.relationshipId;
    if (!relationshipId || !ObjectId.isValid(relationshipId)) return true;
    const relationship = await this.relationships.findByIdInWorkspace(
      notification.workspaceId,
      new ObjectId(relationshipId),
    );
    if (!relationship || !['ACTIVE', 'NEEDS_REASSIGNMENT'].includes(relationship.status)) {
      return false;
    }
    if (relationship.traineeUserId.equals(delivery.recipientUserId)) return true;
    const assignments = await this.relationships.listActiveAssignments(relationship._id);
    return assignments.some((assignment) => assignment.staffMembershipId.equals(membership._id));
  }

  private async isEventStillMeaningful(
    event: OutboxEventDocument,
    entry: NotificationRegistryEntry,
  ) {
    if (entry.stalePolicy !== 'CHECK_IN_STATUS') return true;
    if (!event.workspaceId) return false;
    const relationshipId = payloadObjectId(event, 'relationshipId');
    const checkinId = payloadObjectId(event, 'checkinId');
    if (!relationshipId || !checkinId) return false;
    const instance = await this.checkins.findInstance(event.workspaceId, relationshipId, checkinId);
    if (!instance) return false;
    if (event.eventType === 'CheckInDue') return instance.status === 'DUE';
    if (event.eventType === 'CheckInOverdue') return instance.status === 'OVERDUE';
    return true;
  }

  private async resolveRecipients(event: OutboxEventDocument, entry: NotificationRegistryEntry) {
    const relationshipId = await this.relationshipIdForEvent(event);
    if (
      [
        'CheckInDue',
        'CheckInOverdue',
        'CheckInReviewed',
        'ProgramActivated',
        'ProgramUpdated',
        'NutritionPlanActivated',
        'NutritionPlanUpdated',
      ].includes(event.eventType)
    ) {
      return relationshipId ? await this.traineeRecipient(event.workspaceId, relationshipId) : [];
    }
    if (
      ['CheckInSubmitted', 'DocumentUploaded', 'WorkoutCompleted', 'WorkoutCorrected'].includes(
        event.eventType,
      )
    ) {
      return relationshipId
        ? await this.activeStaffRecipients(event.workspaceId, relationshipId)
        : [];
    }
    if (event.eventType === 'TraineeNeedsReassignment') {
      return event.workspaceId ? await this.ownerManagerRecipients(event.workspaceId) : [];
    }
    if (event.eventType === 'MembershipPermissionProfilesReplaced') {
      const membershipId = aggregateObjectId(event);
      if (!event.workspaceId || !membershipId) return [];
      const membership = await this.memberships.findByIdInWorkspace(
        event.workspaceId,
        membershipId,
      );
      return membership ? [membership.userId] : [];
    }
    if (event.eventType === 'SubscriptionFrozen') {
      return event.workspaceId ? await this.ownerManagerRecipients(event.workspaceId) : [];
    }
    if (
      [
        'SupportSessionStarted',
        'SupportSessionEnded',
        'SupportSessionRevoked',
        'SupportSessionExpired',
      ].includes(event.eventType)
    ) {
      if (event.payload?.notificationRequired === false) return [];
      return event.workspaceId ? await this.ownerRecipients(event.workspaceId) : [];
    }
    void entry;
    return [];
  }

  private async relationshipIdForEvent(event: OutboxEventDocument): Promise<ObjectId | null> {
    const payloadRelationshipId = payloadObjectId(event, 'relationshipId');
    if (payloadRelationshipId) return payloadRelationshipId;
    const aggregateId = aggregateObjectId(event);
    if (!aggregateId) return null;
    const collection =
      event.aggregateType === 'workout_session'
        ? 'workout_sessions'
        : event.aggregateType === 'program'
          ? 'programs'
          : event.aggregateType === 'nutrition_plan'
            ? 'nutrition_plans'
            : null;
    if (!collection) {
      return event.eventType === 'TraineeNeedsReassignment' ? aggregateId : null;
    }
    const aggregate = await this.database.db
      .collection<{ relationshipId?: ObjectId }>(collection)
      .findOne({ _id: aggregateId });
    return aggregate?.relationshipId ?? null;
  }

  private async traineeRecipient(workspaceId: ObjectId | undefined, relationshipId: ObjectId) {
    if (!workspaceId) return [];
    const relationship = await this.relationships.findByIdInWorkspace(workspaceId, relationshipId);
    return relationship && ['ACTIVE', 'NEEDS_REASSIGNMENT'].includes(relationship.status)
      ? [relationship.traineeUserId]
      : [];
  }

  private async activeStaffRecipients(workspaceId: ObjectId | undefined, relationshipId: ObjectId) {
    if (!workspaceId) return [];
    const relationship = await this.relationships.findByIdInWorkspace(workspaceId, relationshipId);
    if (!relationship || !['ACTIVE', 'NEEDS_REASSIGNMENT'].includes(relationship.status)) return [];
    const assignments = await this.relationships.listActiveAssignments(relationshipId);
    const recipients: ObjectId[] = [];
    for (const assignment of assignments) {
      const membership = await this.memberships.findByIdInWorkspace(
        workspaceId,
        assignment.staffMembershipId,
      );
      if (membership?.status === 'ACTIVE') recipients.push(membership.userId);
    }
    return recipients;
  }

  private async ownerManagerRecipients(workspaceId: ObjectId) {
    const memberships = await this.memberships.listByWorkspace(workspaceId);
    return memberships
      .filter(
        (membership) =>
          membership.status === 'ACTIVE' &&
          membership.roles.some((role) => role === 'GYM_OWNER' || role === 'GYM_MANAGER'),
      )
      .map((membership) => membership.userId);
  }

  private async ownerRecipients(workspaceId: ObjectId) {
    const memberships = await this.memberships.listByWorkspace(workspaceId);
    return memberships
      .filter(
        (membership) =>
          membership.status === 'ACTIVE' && membership.roles.some((role) => role === 'GYM_OWNER'),
      )
      .map((membership) => membership.userId);
  }
}

function effectivePreferences(
  stored: NotificationPreferencesDocument | null,
): NotificationPreferencesDocument {
  const now = new Date(0);
  return (
    stored ?? {
      _id: new ObjectId('000000000000000000000000'),
      userId: new ObjectId('000000000000000000000000'),
      channels: defaultPreferences.channels,
      eventPreferences: defaultPreferences.eventPreferences,
      version: 0,
      createdAt: now,
      updatedAt: now,
    }
  );
}

function serializePreferences(preferences: NotificationPreferencesDocument) {
  return {
    channels: preferences.channels,
    eventPreferences: preferences.eventPreferences,
    version: preferences.version,
    updatedAt: preferences.updatedAt.toISOString(),
  };
}

function safeNotification(notification: NotificationDocument) {
  return {
    id: notification._id.toHexString(),
    workspaceId: notification.workspaceId?.toHexString(),
    eventType: notification.eventType,
    notificationType: notification.notificationType,
    category: notification.category,
    title: notification.title,
    body: notification.body,
    payload: notification.payload ?? {},
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
  };
}

function safePushDevice(device: {
  _id: ObjectId;
  platform: string;
  provider: string;
  status: string;
  tokenFingerprint: string;
  lastSeenAt: Date;
  revokedAt?: Date;
}) {
  return {
    id: device._id.toHexString(),
    platform: device.platform,
    provider: device.provider,
    status: device.status,
    tokenFingerprint: device.tokenFingerprint,
    lastSeenAt: device.lastSeenAt.toISOString(),
    revokedAt: device.revokedAt?.toISOString() ?? null,
  };
}

function safePayload(event: OutboxEventDocument): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of ['relationshipId', 'checkinId', 'assignmentId', 'templateId', 'documentId']) {
    const value = event.payload[key];
    if (typeof value === 'string' && ObjectId.isValid(value)) output[key] = value;
  }
  return output;
}

function validateEventPreferences(
  value: Record<string, { email?: boolean; push?: boolean; inApp?: boolean }>,
) {
  for (const [key, config] of Object.entries(value)) {
    if (!/^[A-Z0-9_]+$/.test(key)) {
      throw new AppError({
        code: 'NOTIFICATION_PREFERENCE_UNSUPPORTED',
        httpStatus: 422,
        message: 'Unsupported notification preference.',
      });
    }
    for (const channel of Object.keys(config)) {
      if (!['email', 'push', 'inApp'].includes(channel)) {
        throw new AppError({
          code: 'NOTIFICATION_PREFERENCE_UNSUPPORTED',
          httpStatus: 422,
          message: 'Unsupported notification preference.',
        });
      }
    }
  }
}

function userObjectId(ctx: RequestContext): ObjectId {
  if (!ctx.userId || !ObjectId.isValid(ctx.userId)) {
    throw new AppError({
      code: 'AUTH_REQUIRED',
      httpStatus: 401,
      message: 'Authentication required.',
    });
  }
  return new ObjectId(ctx.userId);
}

function objectId(value: string, code: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
  }
  return new ObjectId(value);
}

function payloadObjectId(event: OutboxEventDocument, field: string): ObjectId | null {
  const value = event.payload[field];
  return typeof value === 'string' && ObjectId.isValid(value) ? new ObjectId(value) : null;
}

function aggregateObjectId(event: OutboxEventDocument): ObjectId | null {
  return event.aggregateId instanceof ObjectId
    ? event.aggregateId
    : typeof event.aggregateId === 'string' && ObjectId.isValid(event.aggregateId)
      ? new ObjectId(event.aggregateId)
      : null;
}

function uniqueObjectIds(values: ObjectId[]): ObjectId[] {
  return [...new Map(values.map((value) => [value.toHexString(), value])).values()];
}

function retryDelayMs(attempt: number): number {
  return (
    [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000][attempt - 1] ?? 6 * 60 * 60_000
  );
}

function notificationConfig(config: AppConfig) {
  return (
    config.notifications ?? {
      deliveryBatchSize: 25,
      deliveryClaimMs: 60_000,
      deliveryMaxAttempts: 5,
    }
  );
}

function last<T>(items: T[]): T {
  const item = items[items.length - 1];
  if (item === undefined) throw new Error('Expected a non-empty page.');
  return item;
}

function encodeCursor(createdAt: Date, id: ObjectId): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id: id.toHexString() }),
  ).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: ObjectId } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      createdAt: string;
      id: string;
    };
    return { createdAt: new Date(parsed.createdAt), id: objectId(parsed.id, 'CURSOR_INVALID') };
  } catch {
    throw new AppError({ code: 'CURSOR_INVALID', httpStatus: 422, message: 'Cursor is invalid.' });
  }
}
