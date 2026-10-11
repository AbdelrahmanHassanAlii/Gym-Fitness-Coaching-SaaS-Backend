import { type Collection, MongoServerError, ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext, UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { PlatformMembershipDocument } from './platform.types';
import {
  assertAssignedMembershipRevisionCapacity,
  type PlatformAuthorityGuard,
} from './platform-authority.guard';

export class PlatformMembershipRepository {
  private readonly memberships: Collection<PlatformMembershipDocument>;

  constructor(
    private readonly database: Database,
    private readonly unitOfWork?: UnitOfWork,
    private readonly authorityGuard?: PlatformAuthorityGuard,
  ) {
    this.memberships = database.db.collection<PlatformMembershipDocument>('platform_memberships');
  }

  private async protectedWrite<T>(
    tx: TransactionContext | undefined,
    operation: (tx?: TransactionContext) => Promise<T>,
  ): Promise<T> {
    if (!this.authorityGuard) return await operation(tx);
    if (!tx) {
      if (!this.unitOfWork) throw new Error('Platform authority writes require UnitOfWork.');
      return await this.unitOfWork.withTransaction((next) => this.protectedWrite(next, operation));
    }
    await this.authorityGuard.serialize(tx);
    const result = await operation(tx);
    if (
      typeof result === 'object' &&
      result !== null &&
      'version' in result &&
      (!Number.isSafeInteger(result.version) || Number(result.version) < 0)
    )
      throw new AppError({
        code: 'PLATFORM_MEMBERSHIP_VERSION_CONFLICT',
        httpStatus: 409,
        message: 'Platform membership revision exhausted.',
      });
    return result;
  }

  async transition(
    id: ObjectId,
    from: Array<'ACTIVE' | 'SUSPENDED' | 'ENDED'>,
    to: 'ACTIVE' | 'SUSPENDED' | 'ENDED',
    now = new Date(),
    tx?: TransactionContext,
    expectedVersion?: number,
  ) {
    return await this.protectedWrite(tx, (next) =>
      this.transitionWithinTransaction(id, from, to, now, next, expectedVersion),
    );
  }

  async replacePermissionProfiles(
    id: ObjectId,
    expectedVersion: number,
    profileIds: ObjectId[],
    now = new Date(),
    tx?: TransactionContext,
  ) {
    return await this.protectedWrite(tx, (next) =>
      this.replacePermissionProfilesWithinTransaction(id, expectedVersion, profileIds, now, next),
    );
  }

  async bumpAccessVersion(
    id: ObjectId,
    expectedVersion: number,
    now = new Date(),
    tx?: TransactionContext,
  ) {
    return await this.protectedWrite(tx, async (next) => {
      const result = await this.bumpAccessVersionWithinTransaction(id, expectedVersion, now, next);
      if (next) {
        next.platformAccessRevisionSubjects ??= new Set();
        next.platformAccessRevisionSubjects.add(id.toHexString());
      }
      return result;
    });
  }

  async bumpAccessVersionForAssignedProfile(
    id: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ) {
    return await this.protectedWrite(tx, (next) =>
      this.bumpAccessVersionForAssignedProfileWithinTransaction(id, now, next),
    );
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
      version: 0,
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

  private async transitionWithinTransaction(
    membershipId: ObjectId,
    from: Array<'ACTIVE' | 'SUSPENDED' | 'ENDED'>,
    to: 'ACTIVE' | 'SUSPENDED' | 'ENDED',
    now = new Date(),
    tx?: TransactionContext,
    expectedVersion?: number,
  ): Promise<PlatformMembershipDocument> {
    const result = await this.memberships.findOneAndUpdate(
      {
        _id: membershipId,
        status: { $in: from },
        ...(expectedVersion === undefined ? {} : { version: expectedVersion }),
      },
      {
        $set: {
          status: to,
          updatedAt: now,
          ...(to === 'SUSPENDED' ? { suspendedAt: now } : {}),
          ...(to === 'ENDED' ? { endedAt: now } : {}),
        },
        $inc: { accessVersion: 1, version: 1 },
        ...(to === 'ACTIVE' ? { $unset: { suspendedAt: '', endedAt: '' } } : {}),
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );

    if (!result) {
      throw new AppError({
        code:
          expectedVersion === undefined
            ? 'PLATFORM_MEMBERSHIP_TRANSITION_INVALID'
            : 'PLATFORM_MEMBERSHIP_VERSION_CONFLICT',
        httpStatus: 409,
        message: 'The Platform membership cannot make the requested transition.',
      });
    }

    return result;
  }

  private async replacePermissionProfilesWithinTransaction(
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
        $inc: { accessVersion: 1, version: 1 },
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

  private async bumpAccessVersionWithinTransaction(
    membershipId: ObjectId,
    expectedVersion: number,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<PlatformMembershipDocument> {
    const result = await this.memberships.findOneAndUpdate(
      { _id: membershipId, status: 'ACTIVE', accessVersion: expectedVersion },
      { $set: { updatedAt: now }, $inc: { accessVersion: 1, version: 1 } },
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

  private async bumpAccessVersionForAssignedProfileWithinTransaction(
    profileId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<number> {
    if (this.authorityGuard)
      await assertAssignedMembershipRevisionCapacity(this.database.db, profileId, tx);
    const result = await this.memberships.updateMany(
      { permissionProfileIds: profileId },
      { $set: { updatedAt: now }, $inc: { accessVersion: 1, version: 1 } },
      tx ? { session: tx.session } : undefined,
    );
    return result.modifiedCount;
  }
}
