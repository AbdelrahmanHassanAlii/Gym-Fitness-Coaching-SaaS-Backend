import type { OutboxProcessor } from '../../core/events/outbox.processor';
import { registeredEventTypes } from './notification.registry';
import type { NotificationApplicationService } from './notification.service';

export function registerNotificationOutboxHandlers(
  processor: OutboxProcessor,
  notifications: NotificationApplicationService,
): void {
  for (const eventType of registeredEventTypes()) {
    processor.register(eventType, async (event) => {
      await notifications.handleOutboxEvent(event);
    });
  }
}
