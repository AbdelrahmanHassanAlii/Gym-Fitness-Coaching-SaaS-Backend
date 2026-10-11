import { type Collection, type Document, ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { UserDocument } from '../identity/identity.types';
import type { PlatformMembershipDocument } from '../platform/platform.types';
import type {
  PlatformUserAccount,
  PlatformUserMembership,
  PlatformUserPageQuery,
  PlatformUserRecord,
} from './platform-user.types';

export const platformUserAccountProjection = {
  _id: 1,
  firstName: 1,
  lastName: 1,
  email: 1,
  status: 1,
  createdAt: 1,
  updatedAt: 1,
};
export const platformUserMembershipProjection = {
  _id: 1,
  userId: 1,
  status: 1,
  createdAt: 1,
  updatedAt: 1,
  suspendedAt: 1,
  endedAt: 1,
};

// Sort before lookup; limit AFTER unwind so dangling accounts never consume a page slot.
export function platformUserDirectoryPipeline(query: PlatformUserPageQuery): Document[] {
  return [
    {
      $match: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.afterId ? { _id: { $lt: query.afterId } } : {}),
      },
    },
    { $sort: { _id: -1 } },
    { $project: platformUserMembershipProjection },
    {
      $lookup: {
        from: 'users',
        localField: 'userId',
        foreignField: '_id',
        pipeline: [{ $project: platformUserAccountProjection }],
        as: 'user',
      },
    },
    { $unwind: '$user' },
    { $limit: query.limit + 1 },
  ];
}

export function platformUserDirectoryIndex(query: PlatformUserPageQuery): string {
  return query.status ? 'platform_memberships_status_id' : '_id_';
}

// Read adapter over the existing canonical collections; no independent persistence.
export class PlatformUserRepository {
  private readonly users: Collection<UserDocument>;
  private readonly memberships: Collection<PlatformMembershipDocument>;

  constructor(database: Database) {
    this.users = database.db.collection<UserDocument>('users');
    this.memberships = database.db.collection<PlatformMembershipDocument>('platform_memberships');
  }

  async list(query: PlatformUserPageQuery): Promise<PlatformUserRecord[]> {
    return await this.memberships
      .aggregate<PlatformUserRecord>(platformUserDirectoryPipeline(query), {
        hint: platformUserDirectoryIndex(query),
      })
      .toArray();
  }

  async findAccount(search: ObjectId | string): Promise<PlatformUserAccount | null> {
    const byId = search instanceof ObjectId;
    return await this.users.findOne<PlatformUserAccount>(
      byId ? { _id: search } : { normalizedEmail: { $eq: search, $type: 'string' } },
      {
        projection: platformUserAccountProjection,
        hint: byId ? '_id_' : 'users_normalized_email_unique',
      },
    );
  }

  async findMembership(
    userId: ObjectId,
    query?: PlatformUserPageQuery,
  ): Promise<PlatformUserMembership | null> {
    return await this.memberships.findOne<PlatformUserMembership>(
      {
        userId,
        ...(query?.status ? { status: query.status } : {}),
        ...(query?.afterId ? { _id: { $lt: query.afterId } } : {}),
      },
      { projection: platformUserMembershipProjection, hint: 'platform_memberships_user_unique' },
    );
  }
}
