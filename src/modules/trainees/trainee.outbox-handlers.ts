import { ObjectId } from 'mongodb';
import type { OutboxProcessor } from '../../core/events/outbox.processor';
import type { OutboxEventDocument } from '../../core/events/outbox.types';
import type { TraineeApplicationService } from './trainee.service';

export function registerTraineeOutboxHandlers(
  processor: OutboxProcessor,
  trainees: TraineeApplicationService,
): void {
  processor.register('StaffMembershipEnded', async (event) => {
    const membershipId = aggregateId(event);
    if (!event.workspaceId || !membershipId) return;
    await trainees.reconcilePrimaryEligibility(event.workspaceId, membershipId, 'staff-ended');
  });

  processor.register('MembershipBranchAssignmentEnded', async (event) => {
    const membershipId = payloadObjectId(event, 'membershipId');
    if (!event.workspaceId || !membershipId) return;
    await trainees.reconcilePrimaryEligibility(
      event.workspaceId,
      membershipId,
      'branch-eligibility-ended',
    );
  });

  processor.register('MembershipPermissionProfilesReplaced', async (event) => {
    const membershipId = aggregateId(event);
    if (!event.workspaceId || !membershipId) return;
    await trainees.reconcilePrimaryEligibility(
      event.workspaceId,
      membershipId,
      'staff-capability-changed',
    );
  });
}

function aggregateId(event: OutboxEventDocument): ObjectId | null {
  return typeof event.aggregateId === 'string' && ObjectId.isValid(event.aggregateId)
    ? new ObjectId(event.aggregateId)
    : event.aggregateId instanceof ObjectId
      ? event.aggregateId
      : null;
}

function payloadObjectId(event: OutboxEventDocument, field: string): ObjectId | null {
  const value = event.payload[field];
  return typeof value === 'string' && ObjectId.isValid(value) ? new ObjectId(value) : null;
}
