import { type Db, ObjectId } from 'mongodb';
import { evaluateAccessDecision } from '../../core/access-control/access-control.service';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { RequestContext } from '../../core/request-context/request-context';
import type { AuthSessionDocument } from '../auth/auth.types';
import type { UserDocument } from '../identity/identity.types';
import { Permissions } from '../permissions/permission.registry';
import type {
  AccessGrantDocument,
  PermissionProfileDocument,
} from '../permissions/permission.types';
import type { PlatformMembershipDocument } from './platform.types';

export const PLATFORM_AUTHORITY_GUARD_ID = 'management-authority';
export const PLATFORM_AUTHORITY_SCAN_LIMIT = 10_000;
export const managementPermissions = [
  Permissions.PlatformMembershipsManage,
  Permissions.PlatformPermissionsManage,
] as const;

export function managementError(
  code: string,
  httpStatus: number,
  details?: Record<string, unknown>,
) {
  return new AppError({
    code,
    httpStatus,
    message: 'Platform management request denied.',
    ...(details ? { details } : {}),
  });
}

export function rejectManagementSupport(ctx: RequestContext): void {
  if (ctx.supportSessionId) throw managementError('SUPPORT_ACCESS_FORBIDDEN', 403);
}

export class PlatformAuthorityGuard {
  constructor(private readonly database: Database) {}

  async serialize(tx: TransactionContext): Promise<void> {
    if (!tx.beforeCommit) throw managementError('PLATFORM_AUTHORITY_TRANSACTION_REQUIRED', 500);
    if (tx.beforeCommit.has(PLATFORM_AUTHORITY_GUARD_ID)) return;
    // First write establishes a shared conflict point. MongoDB retries with a fresh snapshot.
    await this.database.db
      .collection<{ _id: string; revision: number }>('platform_authority_guards')
      .updateOne(
        { _id: PLATFORM_AUTHORITY_GUARD_ID },
        { $inc: { revision: 1 } },
        { upsert: true, session: tx.session },
      );
    tx.beforeCommit.set(PLATFORM_AUTHORITY_GUARD_ID, () =>
      assertPlatformRecoveryAuthority(this.database.db, tx),
    );
  }

  async authorize(ctx: RequestContext, permission: string, tx?: TransactionContext): Promise<void> {
    if (!ctx.userId || !ctx.authSessionId) throw managementError('AUTH_REQUIRED', 401);
    if (ctx.restrictedUntilVerified) throw managementError('AUTH_SESSION_RESTRICTED', 403);
    if (!ctx.mfaSatisfied) throw managementError('TWO_FACTOR_REQUIRED', 403);
    rejectManagementSupport(ctx);
    const options = tx ? { session: tx.session } : {};
    const db = this.database.db;
    const userId = new ObjectId(ctx.userId);
    const user = await db.collection<UserDocument>('users').findOne({ _id: userId }, options);
    const session = await db.collection<AuthSessionDocument>('auth_sessions').findOne(
      {
        _id: new ObjectId(ctx.authSessionId),
        userId,
        status: 'ACTIVE',
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      },
      options,
    );
    if (user?.status !== 'ACTIVE' || !session) throw managementError('AUTH_REQUIRED', 401);
    if (session.restrictedUntilVerified) throw managementError('AUTH_SESSION_RESTRICTED', 403);
    if (!session.mfaSatisfiedAt) throw managementError('TWO_FACTOR_REQUIRED', 403);
    const membership = await db
      .collection<PlatformMembershipDocument>('platform_memberships')
      .findOne({ userId }, options);
    if (!membership) throw managementError('PLATFORM_MEMBERSHIP_REQUIRED', 403);
    if (membership.status !== 'ACTIVE') throw managementError('PLATFORM_MEMBERSHIP_INACTIVE', 403);
    assertBounded(membership.permissionProfileIds.length);
    const profiles = await db
      .collection<PermissionProfileDocument>('permission_profiles')
      .find(
        { _id: { $in: membership.permissionProfileIds }, context: 'PLATFORM', status: 'ACTIVE' },
        options,
      )
      .limit(PLATFORM_AUTHORITY_SCAN_LIMIT + 1)
      .toArray();
    const grants = await db
      .collection<AccessGrantDocument>('access_grants')
      .find(
        { subjectId: membership._id, subjectType: 'PLATFORM_MEMBERSHIP', context: 'PLATFORM' },
        options,
      )
      .limit(PLATFORM_AUTHORITY_SCAN_LIMIT + 1)
      .toArray();
    assertBounded(
      profiles.length,
      grants.length,
      profiles.reduce((n, p) => n + p.permissions.length, 0),
      grants.reduce((n, g) => n + (g.scope.resourceIds?.length ?? 0), 0),
    );
    if (
      !evaluateAccessDecision(
        { context: 'PLATFORM', permission, scope: { type: 'WORKSPACE' } },
        profiles,
        grants,
        new Date(),
      ).allowed
    )
      throw managementError('PERMISSION_DENIED', 403);
    ctx.platformMembershipId = membership._id.toHexString();
  }
}

function assertBounded(...counts: number[]) {
  if (counts.some((count) => count > PLATFORM_AUTHORITY_SCAN_LIMIT))
    throw managementError('PLATFORM_AUTHORITY_EVALUATION_LIMIT_EXCEEDED', 409);
}

export async function assertAssignedMembershipRevisionCapacity(
  db: Db,
  profileId: ObjectId,
  tx?: TransactionContext,
) {
  const members = await db
    .collection<PlatformMembershipDocument>('platform_memberships')
    .find(
      { permissionProfileIds: profileId },
      { projection: { version: 1 }, ...(tx ? { session: tx.session } : {}) },
    )
    .limit(PLATFORM_AUTHORITY_SCAN_LIMIT + 1)
    .toArray();
  assertBounded(members.length);
  for (const member of members) {
    const version = member.version ?? 0;
    if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER)
      throw managementError('PLATFORM_MEMBERSHIP_VERSION_CONFLICT', 409);
  }
}

/** Fail closed above bounded input limits. Expiring ALLOW grants never provide durable recovery. */
export async function assertPlatformRecoveryAuthority(
  db: Db,
  tx?: TransactionContext,
): Promise<void> {
  const options = tx ? { session: tx.session } : {};
  const members = await db
    .collection<PlatformMembershipDocument>('platform_memberships')
    .find({ status: 'ACTIVE' }, options)
    .limit(PLATFORM_AUTHORITY_SCAN_LIMIT + 1)
    .toArray();
  assertBounded(members.length);
  assertBounded(members.reduce((count, member) => count + member.permissionProfileIds.length, 0));
  const users = await db
    .collection<UserDocument>('users')
    .find({ _id: { $in: members.map((member) => member.userId) }, status: 'ACTIVE' }, options)
    .limit(PLATFORM_AUTHORITY_SCAN_LIMIT + 1)
    .toArray();
  const profiles = await db
    .collection<PermissionProfileDocument>('permission_profiles')
    .find(
      {
        context: 'PLATFORM',
        status: 'ACTIVE',
        _id: { $in: members.flatMap((member) => member.permissionProfileIds) },
      },
      options,
    )
    .limit(PLATFORM_AUTHORITY_SCAN_LIMIT + 1)
    .toArray();
  const grants = await db
    .collection<AccessGrantDocument>('access_grants')
    .find(
      {
        context: 'PLATFORM',
        subjectType: 'PLATFORM_MEMBERSHIP',
        subjectId: { $in: members.map((member) => member._id) },
        permission: { $in: [...managementPermissions] },
      },
      options,
    )
    .limit(PLATFORM_AUTHORITY_SCAN_LIMIT + 1)
    .toArray();
  assertBounded(users.length, profiles.length, grants.length);
  const activeUsers = new Set(users.map((user) => user._id.toHexString()));
  const profilesById = new Map(profiles.map((profile) => [profile._id.toHexString(), profile]));
  const grantsByMember = new Map<string, AccessGrantDocument[]>();
  for (const grant of grants) {
    const key = grant.subjectId.toHexString();
    const group = grantsByMember.get(key) ?? [];
    group.push(grant);
    grantsByMember.set(key, group);
  }
  const now = new Date();
  for (const permission of managementPermissions) {
    const exists = members.some((member) => {
      if (!activeUsers.has(member.userId.toHexString())) return false;
      const assigned = member.permissionProfileIds.flatMap((id) => {
        const profile = profilesById.get(id.toHexString());
        return profile ? [profile] : [];
      });
      const durable = (grantsByMember.get(member._id.toHexString()) ?? []).filter(
        (grant) => grant.effect !== 'ALLOW' || !grant.expiresAt,
      );
      return evaluateAccessDecision(
        { context: 'PLATFORM', permission, scope: { type: 'WORKSPACE' } },
        assigned,
        durable,
        now,
      ).allowed;
    });
    if (!exists)
      throw managementError('PLATFORM_LAST_MANAGEMENT_AUTHORITY_REQUIRED', 409, { permission });
  }
}
