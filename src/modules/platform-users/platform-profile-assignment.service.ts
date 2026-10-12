import { ObjectId } from 'mongodb';
import type { AuditWriter } from '../../core/audit/audit.writer';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import type { OutboxWriter } from '../../core/events/outbox.writer';
import type { RequestContext } from '../../core/request-context/request-context';
import type { UserDocument } from '../identity/identity.types';
import type { PermissionProfileDocument } from '../permissions/permission.types';
import type { PlatformMembershipDocument } from '../platform/platform.types';
import {
  assertAssignedMembershipRevisionCapacity,
  managementError,
  type PlatformAuthorityGuard,
} from '../platform/platform-authority.guard';
import { authorityBound, PlatformDelegation } from '../platform/platform-delegation';

export function canonicalProfiles(ids: string[]) {
  return ids.map((id) => id.toLowerCase()).sort();
}

export class PlatformProfileAssignmentService {
  constructor(
    private readonly database: Database,
    private readonly guard: PlatformAuthorityGuard,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async authorize(ctx: RequestContext, tx?: TransactionContext) {
    await this.guard.authorize(ctx, 'platform_permissions.manage', tx);
  }

  private async target(userId: string, tx?: TransactionContext) {
    if (!/^[0-9a-f]{24}$/.test(userId)) throw managementError('USER_NOT_FOUND', 404);
    const options = tx ? { session: tx.session } : {};
    const account = await this.database.db
      .collection<UserDocument>('users')
      .findOne({ _id: new ObjectId(userId) }, options);
    const membership = await this.database.db
      .collection<PlatformMembershipDocument>('platform_memberships')
      .findOne({ userId: new ObjectId(userId) }, options);
    if (!account || !membership) throw managementError('USER_NOT_FOUND', 404);
    return { account, membership };
  }

  async state(ctx: RequestContext, userId: string) {
    await this.authorize(ctx);
    return this.dto((await this.target(userId)).membership);
  }

  private async dto(member: PlatformMembershipDocument, tx?: TransactionContext) {
    authorityBound(member.permissionProfileIds.length);
    if (!Number.isSafeInteger(member.version) || member.version < 0)
      throw managementError('INTERNAL_ERROR', 500);
    const profiles = await this.database.db
      .collection<PermissionProfileDocument>('permission_profiles')
      .find(
        { _id: { $in: member.permissionProfileIds }, context: 'PLATFORM' },
        { projection: { name: 1, status: 1 }, ...(tx ? { session: tx.session } : {}) },
      )
      .limit(10_001)
      .toArray();
    const byId = new Map(profiles.map((p) => [p._id.toHexString(), p]));
    return {
      userId: member.userId.toHexString(),
      platformMembership: {
        id: member._id.toHexString(),
        status: member.status,
        version: member.version,
      },
      permissionProfiles: canonicalProfiles(
        member.permissionProfileIds.map((id) => id.toHexString()),
      ).map((id) => {
        const profile = byId.get(id);
        return profile && ['ACTIVE', 'ARCHIVED'].includes(profile.status)
          ? { id, name: profile.name, status: profile.status }
          : { id, name: null, status: 'UNAVAILABLE' as const };
      }),
    };
  }

  async selector(ctx: RequestContext, limit = 50, cursor?: string) {
    await this.authorize(ctx);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw managementError('VALIDATION_FAILED', 400);
    let after: { name: string; id: string } | undefined;
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (
          typeof parsed.name !== 'string' ||
          typeof parsed.id !== 'string' ||
          !/^[0-9a-f]{24}$/.test(parsed.id) ||
          Object.keys(parsed).length !== 2
        )
          throw new Error('cursor');
        after = parsed;
      } catch {
        throw managementError('VALIDATION_FAILED', 400);
      }
    }
    // Migration 005 enforces unique ACTIVE Platform names, so name alone is a
    // deterministic cursor/sort and uses the existing context/name index directly.
    const rows = await this.database.db
      .collection<PermissionProfileDocument>('permission_profiles')
      .find(
        { context: 'PLATFORM', status: 'ACTIVE', ...(after ? { name: { $gt: after.name } } : {}) },
        { projection: { name: 1 } },
      )
      .sort({ name: 1 })
      .limit(limit + 1)
      .toArray();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      permissionProfiles: page.map((p) => ({ id: p._id.toHexString(), name: p.name })),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ name: last.name, id: last._id.toHexString() })).toString(
              'base64url',
            )
          : null,
    };
  }

  async replace(
    ctx: RequestContext,
    userId: string,
    input: { expectedVersion: number; profileIds: string[] },
    tx: TransactionContext,
    counter: 'version' | 'accessVersion' = 'version',
  ) {
    await this.guard.serialize(tx);
    await this.authorize(ctx, tx);
    const { account, membership } = await this.target(userId, tx);
    if (membership.userId.toHexString() === ctx.userId)
      throw managementError('PLATFORM_PERMISSION_SELF_MUTATION_FORBIDDEN', 403);
    const conflict =
      counter === 'version'
        ? 'PLATFORM_MEMBERSHIP_VERSION_CONFLICT'
        : 'PLATFORM_MEMBERSHIP_ACCESS_VERSION_CONFLICT';
    if ((membership[counter] ?? 0) !== input.expectedVersion) throw managementError(conflict, 409);
    if (membership.status !== 'ACTIVE')
      throw managementError('PLATFORM_PERMISSION_TARGET_MEMBERSHIP_INACTIVE', 409);
    if (account.status !== 'ACTIVE')
      throw managementError('PLATFORM_MEMBERSHIP_TARGET_ACCOUNT_INACTIVE', 409);
    authorityBound(input.profileIds.length, membership.permissionProfileIds.length);
    const ids = canonicalProfiles(input.profileIds);
    if (new Set(ids).size !== ids.length)
      throw managementError('PERMISSION_PROFILE_DUPLICATE', 409);
    if (ids.some((id) => !/^[0-9a-f]{24}$/.test(id)))
      throw managementError('PERMISSION_PROFILE_NOT_FOUND', 404);
    const profileIds = ids.map((id) => new ObjectId(id));
    const profiles = await this.database.db
      .collection<PermissionProfileDocument>('permission_profiles')
      .find(
        { _id: { $in: profileIds }, context: 'PLATFORM', status: 'ACTIVE' },
        { session: tx.session },
      )
      .limit(10_001)
      .toArray();
    if (profiles.length !== ids.length) throw managementError('PERMISSION_PROFILE_NOT_FOUND', 404);
    const delegation = new PlatformDelegation(this.database.db, tx);
    const actor = await delegation.actor(ctx);
    const now = new Date();
    delegation.proposed(actor, profiles, now);
    const previous = [
      ...new Set(canonicalProfiles(membership.permissionProfileIds.map((id) => id.toHexString()))),
    ];
    if (JSON.stringify(previous) === JSON.stringify(ids))
      return { dto: await this.dto(membership, tx), membership };
    const before = await delegation.inputs(membership);
    delegation.increase(actor, before, { profiles, grants: before.grants }, now);
    if (
      !Number.isSafeInteger(membership.version) ||
      membership.version >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(membership.accessVersion ?? 0) ||
      (membership.accessVersion ?? 0) >= Number.MAX_SAFE_INTEGER
    )
      throw managementError(conflict, 409);
    const updated = await this.database.db
      .collection<PlatformMembershipDocument>('platform_memberships')
      .findOneAndUpdate(
        { _id: membership._id, status: 'ACTIVE', [counter]: input.expectedVersion },
        {
          $set: { permissionProfileIds: profileIds, updatedAt: now },
          $inc: { version: 1, accessVersion: 1 },
        },
        { session: tx.session, returnDocument: 'after' },
      );
    if (!updated) throw managementError(conflict, 409);
    const metadata = {
      userId,
      membershipId: membership._id.toHexString(),
      previousProfileIds: previous,
      profileIds: ids,
      addedIds: ids.filter((id) => !previous.includes(id)),
      removedIds: previous.filter((id) => !ids.includes(id)),
      previousVersion: membership.version,
      version: updated.version,
      command: ctx.correlationId,
    };
    await this.audit.write(
      {
        eventType: 'MembershipPermissionProfilesReplaced',
        actor: {
          userId: new ObjectId(ctx.userId),
          platformMembershipId: new ObjectId(ctx.platformMembershipId),
        },
        entity: { type: 'platform_membership', id: membership._id },
        action: 'replace',
        after: metadata,
        ipAddress: ctx.ipAddress,
        correlationId: ctx.correlationId,
        ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
      },
      tx,
    );
    await this.outbox.write(
      {
        eventType: 'MembershipPermissionProfilesReplaced',
        aggregateType: 'platform_membership',
        aggregateId: membership._id,
        payload: { context: 'PLATFORM', aggregateId: membership._id.toHexString(), ...metadata },
        correlationId: ctx.correlationId,
      },
      tx,
    );
    return { dto: await this.dto(updated, tx), membership: updated };
  }

  async legacy(
    ctx: RequestContext,
    membershipId: string,
    input: { expectedVersion: number; profileIds: string[] },
    tx: TransactionContext,
  ) {
    await this.guard.serialize(tx);
    await this.authorize(ctx, tx);
    if (!ObjectId.isValid(membershipId))
      throw managementError('PLATFORM_MEMBERSHIP_NOT_FOUND', 404);
    const member = await this.database.db
      .collection<PlatformMembershipDocument>('platform_memberships')
      .findOne({ _id: new ObjectId(membershipId) }, { session: tx.session });
    if (!member) throw managementError('PLATFORM_MEMBERSHIP_NOT_FOUND', 404);
    const { membership } = await this.replace(
      ctx,
      member.userId.toHexString(),
      input,
      tx,
      'accessVersion',
    );
    return {
      membershipId,
      profileIds: membership.permissionProfileIds.map((id) => id.toHexString()),
      accessVersion: membership.accessVersion ?? 0,
    };
  }

  async profileChange(
    ctx: RequestContext,
    previous: PermissionProfileDocument,
    next: PermissionProfileDocument,
    tx: TransactionContext,
  ) {
    // Detect fanout overflow with the indexed minimized read before loading authority inputs.
    await assertAssignedMembershipRevisionCapacity(this.database.db, previous._id, tx);
    const delegation = new PlatformDelegation(this.database.db, tx);
    const actor = await delegation.actor(ctx);
    const now = new Date();
    if (next.status === 'ACTIVE') delegation.proposed(actor, [next], now);
    const members = this.database.db
      .collection<PlatformMembershipDocument>('platform_memberships')
      .find({ permissionProfileIds: previous._id }, { session: tx.session })
      .limit(10_001)
      .batchSize(100);
    let count = 0;
    let references = 0;
    try {
      for await (const member of members) {
        references += member.permissionProfileIds.length;
        authorityBound(++count, references);
        const before = await delegation.inputs(member);
        const profiles = before.profiles.filter((p) => !p._id.equals(previous._id));
        if (next.status === 'ACTIVE') profiles.push(next);
        delegation.increase(actor, before, { profiles, grants: before.grants }, now);
      }
    } finally {
      await members.close();
    }
  }
}
