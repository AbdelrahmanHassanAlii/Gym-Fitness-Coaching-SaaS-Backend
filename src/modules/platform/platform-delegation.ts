import { type Db, ObjectId } from 'mongodb';
import { evaluateAccessDecision } from '../../core/access-control/access-control.service';
import type { TransactionContext } from '../../core/database/unit-of-work';
import type { RequestContext } from '../../core/request-context/request-context';
import { permissionDefinitions } from '../permissions/permission.registry';
import type {
  AccessGrantDocument,
  PermissionProfileDocument,
  PermissionScope,
} from '../permissions/permission.types';
import type { PlatformMembershipDocument } from './platform.types';
import { managementError, PLATFORM_AUTHORITY_SCAN_LIMIT } from './platform-authority.guard';

export function authorityBound(...counts: number[]) {
  if (counts.some((n) => n > PLATFORM_AUTHORITY_SCAN_LIMIT))
    throw managementError('PLATFORM_AUTHORITY_EVALUATION_LIMIT_EXCEEDED', 409);
}

export interface PlatformAuthorityInputs {
  profiles: PermissionProfileDocument[];
  grants: AccessGrantDocument[];
}

/** A budget is shared by the complete command, including every affected member. */
export class PlatformDelegation {
  private work = 0;
  constructor(
    private readonly db: Db,
    private readonly tx: TransactionContext,
  ) {}

  async inputs(member: PlatformMembershipDocument): Promise<PlatformAuthorityInputs> {
    authorityBound(member.permissionProfileIds.length);
    const profiles = await this.db
      .collection<PermissionProfileDocument>('permission_profiles')
      .find(
        { _id: { $in: member.permissionProfileIds }, context: 'PLATFORM', status: 'ACTIVE' },
        { session: this.tx.session },
      )
      .limit(PLATFORM_AUTHORITY_SCAN_LIMIT + 1)
      .toArray();
    const grants = await this.db
      .collection<AccessGrantDocument>('access_grants')
      .find(
        { subjectId: member._id, subjectType: 'PLATFORM_MEMBERSHIP', context: 'PLATFORM' },
        { session: this.tx.session },
      )
      .limit(PLATFORM_AUTHORITY_SCAN_LIMIT + 1)
      .toArray();
    this.boundInputs({ profiles, grants });
    return { profiles, grants };
  }

  async actor(ctx: RequestContext) {
    const member = await this.db
      .collection<PlatformMembershipDocument>('platform_memberships')
      .findOne(
        { userId: new ObjectId(ctx.userId), status: 'ACTIVE' },
        { session: this.tx.session },
      );
    if (!member) throw managementError('PLATFORM_MEMBERSHIP_INACTIVE', 403);
    return this.inputs(member);
  }

  private boundInputs(input: PlatformAuthorityInputs) {
    const entries = input.profiles.reduce((n, p) => n + p.permissions.length, 0);
    const resources = input.grants.reduce((n, g) => n + (g.scope.resourceIds?.length ?? 0), 0);
    authorityBound(input.profiles.length, input.grants.length, entries, resources);
    this.work += 1 + input.profiles.length + input.grants.length + entries + resources;
    if (this.work > 1_000_000)
      throw managementError('PLATFORM_AUTHORITY_EVALUATION_LIMIT_EXCEEDED', 409);
  }

  private allowed(
    input: PlatformAuthorityInputs,
    permission: string,
    scope: PermissionScope,
    at: Date,
    durable = false,
  ) {
    this.work +=
      1 + input.grants.length + input.profiles.reduce((n, p) => n + p.permissions.length, 0);
    if (this.work > 1_000_000)
      throw managementError('PLATFORM_AUTHORITY_EVALUATION_LIMIT_EXCEEDED', 409);
    return evaluateAccessDecision(
      { context: 'PLATFORM', permission, scope },
      input.profiles,
      durable ? input.grants.filter((g) => g.effect !== 'ALLOW' || !g.expiresAt) : input.grants,
      at,
    ).allowed;
  }

  private scopes(permission: string, inputs: PlatformAuthorityInputs[]): PermissionScope[] {
    const definition = permissionDefinitions.find(
      (d) => d.key === permission && d.allowedContexts.includes('PLATFORM'),
    );
    if (!definition) throw managementError('DELEGATION_DENIED', 403);
    const ids = new Map<string, ObjectId>();
    for (const input of inputs)
      for (const grant of input.grants)
        if (grant.permission === permission)
          for (const id of grant.scope.resourceIds ?? []) ids.set(id.toHexString(), id);
    authorityBound(ids.size);
    // A fresh atom represents the remainder of the unbounded resource domain. Every
    // explicitly mentioned atom is checked too, so narrow DENYs cannot hide in a broad ALLOW.
    let remainder = new ObjectId();
    while (ids.has(remainder.toHexString())) remainder = new ObjectId();
    const scopes = definition.allowedScopes.flatMap((type): PermissionScope[] => {
      if (!['BRANCH', 'MULTIPLE_BRANCHES', 'SPECIFIC_TRAINEES'].includes(type)) return [{ type }];
      const sets = new Map<string, ObjectId[]>();
      for (const input of inputs)
        for (const grant of input.grants) {
          if (
            grant.permission !== permission ||
            grant.scope.type !== type ||
            !grant.scope.resourceIds?.length
          )
            continue;
          const resources = [
            ...new Map(grant.scope.resourceIds.map((id) => [id.toHexString(), id])).values(),
          ].sort((a, b) => a.toHexString().localeCompare(b.toHexString()));
          sets.set(resources.map((id) => id.toHexString()).join(','), resources);
        }
      // scopeApplies tests whether the whole request is a subset of a grant, not
      // whether its individual atoms are covered by different grants. Full grant
      // sets witness DENY regions: a target grant covering such a set covers all
      // its subsets; otherwise the full set exposes the changed profile baseline.
      // The remainder also requires actor authority beyond any finite grant set.
      return [...ids.values(), remainder]
        .map((id) => ({ type, resourceIds: [id] }))
        .concat([...sets.values()].map((resources) => ({ type, resourceIds: resources })));
    });
    authorityBound(scopes.length);
    return scopes;
  }

  proposed(actor: PlatformAuthorityInputs, profiles: PermissionProfileDocument[], now: Date) {
    this.boundInputs({ profiles, grants: [] });
    for (const profile of profiles)
      for (const entry of profile.permissions)
        for (const scope of this.scopes(entry.permission, [actor]))
          if (!this.allowed(actor, entry.permission, scope, now))
            throw managementError('DELEGATION_DENIED', 403);
  }

  increase(
    actor: PlatformAuthorityInputs,
    before: PlatformAuthorityInputs,
    after: PlatformAuthorityInputs,
    now: Date,
  ) {
    for (const input of [actor, before, after]) this.boundInputs(input);
    const permissions = new Set(
      [...before.profiles, ...after.profiles].flatMap((p) =>
        p.permissions.map((e) => e.permission),
      ),
    );
    authorityBound(permissions.size);
    const boundaries = new Set<number>([now.getTime()]);
    for (const grant of [...before.grants, ...actor.grants])
      if (grant.expiresAt && grant.expiresAt > now) boundaries.add(grant.expiresAt.getTime());
    authorityBound(boundaries.size);
    for (const permission of permissions)
      for (const scope of this.scopes(permission, [actor, before, after]))
        for (const boundary of boundaries) {
          const at = new Date(boundary);
          if (
            !this.allowed(before, permission, scope, at) &&
            this.allowed(after, permission, scope, at) &&
            (!this.allowed(actor, permission, scope, now, true) ||
              !this.allowed(actor, permission, scope, at, true))
          )
            throw managementError('DELEGATION_DENIED', 403);
        }
  }
}
