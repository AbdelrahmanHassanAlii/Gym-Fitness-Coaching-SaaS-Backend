import { ObjectId } from 'mongodb';
import type { OutboxProcessor } from '../../core/events/outbox.processor';

/** Informational membership lifecycle facts; runtime authorization needs no asynchronous side effect. */
export function registerPlatformLifecycleOutboxHandlers(processor: OutboxProcessor): void {
  for (const eventType of [
    'PlatformMembershipSuspended',
    'PlatformMembershipReactivated',
    'PlatformMembershipEnded',
  ]) {
    processor.register(
      eventType,
      async (event) => {
        const validId = (value: unknown) =>
          typeof value === 'string' && /^[0-9a-f]{24}$/.test(value);
        if (
          event.eventType !== eventType ||
          event.aggregateType !== 'platform_membership' ||
          !(event.aggregateId instanceof ObjectId || validId(event.aggregateId)) ||
          typeof event.payload !== 'object' ||
          event.payload === null ||
          Array.isArray(event.payload) ||
          !validId(event.payload.userId)
        )
          throw new Error('Invalid informational Platform lifecycle event.');
      },
      { handlerKey: 'platform.lifecycle.informational-acknowledgment' },
    );
  }
}
