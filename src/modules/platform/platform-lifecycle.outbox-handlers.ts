import type { OutboxProcessor } from '../../core/events/outbox.processor';

/** Informational membership lifecycle facts; runtime authorization needs no asynchronous side effect. */
export function registerPlatformLifecycleOutboxHandlers(processor: OutboxProcessor): void {
  for (const eventType of [
    'PlatformMembershipSuspended',
    'PlatformMembershipReactivated',
    'PlatformMembershipEnded',
  ]) {
    processor.register(eventType, async () => undefined, {
      handlerKey: 'platform.lifecycle.informational-acknowledgment',
    });
  }
}
