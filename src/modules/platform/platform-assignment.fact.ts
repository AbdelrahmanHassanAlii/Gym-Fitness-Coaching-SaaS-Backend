import { ObjectId } from 'mongodb';
import type { OutboxEventDocument } from '../../core/events/outbox.types';

/** Platform assignment facts are informational for Workspace notification/reconciliation handlers. */
export function isPlatformAssignmentFact(event: OutboxEventDocument): boolean {
  if (event.eventType !== 'MembershipPermissionProfilesReplaced') return false;
  if (event.aggregateType !== 'platform_membership' && event.payload?.context !== 'PLATFORM')
    return false;
  const valid =
    event.aggregateId instanceof ObjectId ||
    (typeof event.aggregateId === 'string' && /^[0-9a-f]{24}$/.test(event.aggregateId));
  const id =
    event.aggregateId instanceof ObjectId ? event.aggregateId.toHexString() : event.aggregateId;
  if (
    !valid ||
    event.aggregateType !== 'platform_membership' ||
    event.workspaceId ||
    event.payload?.context !== 'PLATFORM' ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload) ||
    event.payload.aggregateId !== id ||
    (event.payload.userId !== undefined &&
      (typeof event.payload.userId !== 'string' || !/^[0-9a-f]{24}$/.test(event.payload.userId)))
  )
    throw new Error('Invalid informational Platform assignment fact.');
  return true;
}
