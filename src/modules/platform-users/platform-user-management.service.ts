import { ObjectId } from 'mongodb';
import type { AuditWriter } from '../../core/audit/audit.writer';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import type { OutboxWriter } from '../../core/events/outbox.writer';
import type { RequestContext } from '../../core/request-context/request-context';
import type { UserDocument } from '../identity/identity.types';
import { Permissions } from '../permissions/permission.registry';
import type { PlatformMembershipRepository } from '../platform/platform.repository';
import type {
  PlatformMembershipDocument,
  PlatformMembershipStatus,
} from '../platform/platform.types';
import { managementError, type PlatformAuthorityGuard } from '../platform/platform-authority.guard';

export type LifecycleCommand = 'suspend' | 'reactivate' | 'end';
export const lifecycleTransitions: Record<
  LifecycleCommand,
  { from: PlatformMembershipStatus[]; to: PlatformMembershipStatus; event: string }
> = {
  suspend: { from: ['ACTIVE'], to: 'SUSPENDED', event: 'PlatformMembershipSuspended' },
  reactivate: {
    from: ['SUSPENDED', 'ENDED'],
    to: 'ACTIVE',
    event: 'PlatformMembershipReactivated',
  },
  end: { from: ['ACTIVE', 'SUSPENDED'], to: 'ENDED', event: 'PlatformMembershipEnded' },
};

export class PlatformUserManagementService {
  constructor(
    private readonly database: Database,
    private readonly memberships: PlatformMembershipRepository,
    private readonly guard: PlatformAuthorityGuard,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async authorize(ctx: RequestContext, tx?: TransactionContext) {
    await this.guard.authorize(ctx, Permissions.PlatformMembershipsManage, tx);
  }

  private async target(userId: string, tx?: TransactionContext) {
    if (!/^[0-9a-f]{24}$/.test(userId)) throw managementError('USER_NOT_FOUND', 404);
    const id = new ObjectId(userId);
    const account = await this.database.db
      .collection<UserDocument>('users')
      .findOne({ _id: id }, tx ? { session: tx.session } : {});
    const membership = await this.memberships.findByUserId(id, tx);
    if (!account || !membership) throw managementError('USER_NOT_FOUND', 404);
    return { account, membership };
  }

  async state(ctx: RequestContext, userId: string) {
    await this.authorize(ctx);
    return managementState((await this.target(userId)).membership);
  }

  async transition(
    ctx: RequestContext,
    userId: string,
    command: LifecycleCommand,
    expectedVersion: number,
    tx: TransactionContext,
  ) {
    await this.guard.serialize(tx);
    await this.authorize(ctx, tx);
    const { account, membership } = await this.target(userId, tx);
    if (userId === ctx.userId)
      throw managementError('PLATFORM_MEMBERSHIP_SELF_MUTATION_FORBIDDEN', 403);
    if (membership.version !== expectedVersion)
      throw managementError('PLATFORM_MEMBERSHIP_VERSION_CONFLICT', 409);
    const transition = lifecycleTransitions[command];
    if (!transition.from.includes(membership.status))
      throw managementError('PLATFORM_MEMBERSHIP_TRANSITION_INVALID', 409);
    if (command === 'reactivate' && account.status !== 'ACTIVE')
      throw managementError('PLATFORM_MEMBERSHIP_TARGET_ACCOUNT_INACTIVE', 409);
    const updated = await this.memberships.transition(
      membership._id,
      transition.from,
      transition.to,
      new Date(),
      tx,
      expectedVersion,
    );
    const metadata = {
      targetMembershipId: membership._id.toHexString(),
      targetUserId: userId,
      previousStatus: membership.status,
      status: updated.status,
      previousVersion: membership.version,
      version: updated.version,
      command,
    };
    await this.audit.write(
      {
        eventType: transition.event,
        actor: {
          userId: new ObjectId(ctx.userId),
          platformMembershipId: new ObjectId(ctx.platformMembershipId),
        },
        entity: { type: 'platform_membership', id: membership._id },
        action: command,
        before: { status: membership.status, version: membership.version },
        after: metadata,
        correlationId: ctx.correlationId,
        ipAddress: ctx.ipAddress,
        ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
      },
      tx,
    );
    await this.outbox.write(
      {
        eventType: transition.event,
        aggregateType: 'platform_membership',
        aggregateId: membership._id,
        payload: { userId, ...metadata },
        correlationId: ctx.correlationId,
      },
      tx,
    );
    return managementState(updated);
  }
}

export function managementState(membership: PlatformMembershipDocument) {
  if (!Number.isSafeInteger(membership.version) || membership.version < 0)
    throw managementError('INTERNAL_ERROR', 500);
  return {
    userId: membership.userId.toHexString(),
    platformMembership: {
      id: membership._id.toHexString(),
      status: membership.status,
      version: membership.version,
      suspendedAt: membership.suspendedAt?.toISOString() ?? null,
      endedAt: membership.endedAt?.toISOString() ?? null,
    },
  };
}
