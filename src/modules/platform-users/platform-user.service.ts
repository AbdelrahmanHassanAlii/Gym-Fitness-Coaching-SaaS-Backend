import { ObjectId } from 'mongodb';
import type { AccessControlService } from '../../core/access-control/access-control.service';
import { AppError } from '../../core/errors/app-error';
import type { RequestContext } from '../../core/request-context/request-context';
import { normalizeEmail } from '../auth/auth.normalization';
import { Permissions } from '../permissions/permission.registry';
import type { PlatformUserRepository } from './platform-user.repository';
import type {
  PlatformUserDetail,
  PlatformUserQuery,
  PlatformUserRecord,
  PlatformUserRow,
} from './platform-user.types';

export function rejectPlatformUserSupport(ctx: RequestContext): void {
  if (ctx.supportSessionId)
    throw new AppError({
      code: 'SUPPORT_ACCESS_FORBIDDEN',
      httpStatus: 403,
      message: 'Support context cannot access Platform users.',
    });
}

export class PlatformUserApplicationService {
  constructor(
    private readonly repository: PlatformUserRepository,
    private readonly accessControl: AccessControlService,
  ) {}

  private async authorize(ctx: RequestContext): Promise<void> {
    rejectPlatformUserSupport(ctx);
    if (ctx.restrictedUntilVerified)
      throw new AppError({
        code: 'AUTH_SESSION_RESTRICTED',
        httpStatus: 403,
        message: 'Verify a login identifier first.',
      });
    await this.accessControl.authorize(ctx, {
      context: 'PLATFORM',
      permission: Permissions.PlatformMembershipsRead,
      scope: { type: 'WORKSPACE' },
    });
  }

  async directory(ctx: RequestContext, query: PlatformUserQuery) {
    await this.authorize(ctx);
    const limit = query.limit ?? 50;
    const afterId = query.cursor === undefined ? undefined : cursorId(query.cursor);
    const search = searchIdentifier(query.q);
    const pageQuery = {
      limit,
      ...(afterId ? { afterId } : {}),
      ...(query.platformMembershipStatus ? { status: query.platformMembershipStatus } : {}),
    };
    let fetched: PlatformUserRecord[];
    if (search !== undefined) {
      const user = await this.repository.findAccount(search);
      const membership = user ? await this.repository.findMembership(user._id, pageQuery) : null;
      fetched = user && membership ? [{ ...membership, user }] : [];
    } else {
      fetched = await this.repository.list(pageQuery);
    }
    const hasMore = fetched.length > limit;
    const page = fetched.slice(0, limit);
    return {
      data: page.map(directoryRow),
      meta: {
        nextCursor: hasMore ? (page.at(-1)?._id.toHexString() ?? null) : null,
        hasMore,
      },
    };
  }

  async detail(ctx: RequestContext, userId: string): Promise<PlatformUserDetail> {
    await this.authorize(ctx);
    if (!/^[0-9a-f]{24}$/.test(userId)) throw userNotFound();
    const user = await this.repository.findAccount(new ObjectId(userId));
    const membership = user ? await this.repository.findMembership(user._id) : null;
    if (!user || !membership) throw userNotFound();
    return {
      ...accountIdentity(user),
      updatedAt: user.updatedAt.toISOString(),
      platformMembership: {
        id: membership._id.toHexString(),
        status: membership.status,
        createdAt: membership.createdAt.toISOString(),
        updatedAt: membership.updatedAt.toISOString(),
        ...(membership.suspendedAt ? { suspendedAt: membership.suspendedAt.toISOString() } : {}),
        ...(membership.endedAt ? { endedAt: membership.endedAt.toISOString() } : {}),
      },
    };
  }
}

function accountIdentity(user: PlatformUserRecord['user']) {
  const displayName = `${user.firstName} ${user.lastName}`.trim();
  return {
    id: user._id.toHexString(),
    ...(displayName ? { displayName } : {}),
    ...(user.email !== undefined ? { email: user.email } : {}),
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}
function directoryRow(record: PlatformUserRecord): PlatformUserRow {
  return { ...accountIdentity(record.user), platformMembership: { status: record.status } };
}
function cursorId(value: string): ObjectId {
  if (!/^[0-9a-f]{24}$/.test(value))
    throw new AppError({
      code: 'CURSOR_INVALID',
      httpStatus: 422,
      message: 'Invalid Platform user directory cursor.',
    });
  return new ObjectId(value);
}
function searchIdentifier(q: string | undefined): ObjectId | string | undefined {
  const value = q?.trim();
  if (!value) return undefined;
  if (/^[0-9a-fA-F]{24}$/.test(value)) return new ObjectId(value);
  try {
    return normalizeEmail(value);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'AUTH_IDENTIFIER_INVALID') throw error;
    throw new AppError({
      code: 'PLATFORM_USER_SEARCH_INVALID',
      httpStatus: 422,
      message: 'Search requires an exact full email or user ObjectId.',
      expose: true,
    });
  }
}
function userNotFound(): AppError {
  return new AppError({ code: 'USER_NOT_FOUND', httpStatus: 404, message: 'User not found.' });
}
