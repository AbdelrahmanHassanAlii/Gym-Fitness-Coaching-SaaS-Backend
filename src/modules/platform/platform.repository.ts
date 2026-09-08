import { type Collection, MongoServerError, ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { PlatformMembershipDocument } from './platform.types';

export class PlatformMembershipRepository {
  private readonly memberships: Collection<PlatformMembershipDocument>;

  constructor(database: Database) {
    this.memberships = database.db.collection<PlatformMembershipDocument>('platform_memberships');
  }

  async createActive(
    userId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<PlatformMembershipDocument> {
    const membership: PlatformMembershipDocument = {
      _id: new ObjectId(),
      userId,
      status: 'ACTIVE',
      permissionProfileIds: [],
      accessVersion: 0,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.memberships.insertOne(membership, tx ? { session: tx.session } : undefined);
      return membership;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new AppError({
          code: 'PLATFORM_MEMBERSHIP_EXISTS',
          httpStatus: 409,
          message: 'The user already has a Platform membership.',
        });
      }
      throw error;
    }
  }

  async findByUserId(
    userId: ObjectId,
    tx?: TransactionContext,
  ): Promise<PlatformMembershipDocument | null> {
    return await this.memberships.findOne({ userId }, tx ? { session: tx.session } : undefined);
  }

  async findActiveByUserId(
    userId: ObjectId,
    tx?: TransactionContext,
  ): Promise<PlatformMembershipDocument | null> {
    return await this.memberships.findOne(
      { userId, status: 'ACTIVE' },
      tx ? { session: tx.session } : undefined,
    );
  }

  async findById(
    membershipId: ObjectId,
    tx?: TransactionContext,
  ): Promise<PlatformMembershipDocument | null> {
    return await this.memberships.findOne(
      { _id: membershipId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async list(): Promise<PlatformMembershipDocument[]> {
    return await this.memberships.find({}).sort({ createdAt: -1 }).toArray();
  }

  async transition(
    membershipId: ObjectId,
    from: Array<'ACTIVE' | 'SUSPENDED' | 'ENDED'>,
    to: 'ACTIVE' | 'SUSPENDED' | 'ENDED',
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<PlatformMembershipDocument> {
    const result = await this.memberships.findOneAndUpdate(
      { _id: membershipId, status: { $in: from } },
      {
        $set: {
          status: to,
          updatedAt: now,
          ...(to === 'SUSPENDED' ? { suspendedAt: now } : {}),
          ...(to === 'ENDED' ? { endedAt: now } : {}),
        },
        ...(to === 'ACTIVE' ? { $unset: { suspendedAt: '', endedAt: '' } } : {}),
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );

    if (!result) {
      throw new AppError({
        code: 'PLATFORM_MEMBERSHIP_TRANSITION_INVALID',
        httpStatus: 409,
        message: 'The Platform membership cannot make the requested transition.',
      });
    }

    return result;
  }

  async replacePermissionProfiles(
    membershipId: ObjectId,
    expectedVersion: number,
    permissionProfileIds: ObjectId[],
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<PlatformMembershipDocument> {
    const result = await this.memberships.findOneAndUpdate(
      { _id: membershipId, status: 'ACTIVE', accessVersion: expectedVersion },
      {
        $set: { permissionProfileIds, updatedAt: now },
        $inc: { accessVersion: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );

    if (!result) {
      throw new AppError({
        code: 'PLATFORM_MEMBERSHIP_ACCESS_VERSION_CONFLICT',
        httpStatus: 409,
        message: 'The Platform membership permission profile set has changed.',
      });
    }

    return result;
  }

  async bumpAccessVersion(
    membershipId: ObjectId,
    expectedVersion: number,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<PlatformMembershipDocument> {
    const result = await this.memberships.findOneAndUpdate(
      { _id: membershipId, status: 'ACTIVE', accessVersion: expectedVersion },
      { $set: { updatedAt: now }, $inc: { accessVersion: 1 } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );

    if (!result) {
      throw new AppError({
        code: 'PLATFORM_MEMBERSHIP_ACCESS_VERSION_CONFLICT',
        httpStatus: 409,
        message: 'The Platform membership access state has changed.',
      });
    }

    return result;
  }
}
