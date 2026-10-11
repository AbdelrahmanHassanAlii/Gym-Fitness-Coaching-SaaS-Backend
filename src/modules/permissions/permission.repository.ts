import { type Collection, MongoServerError, ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext, UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import {
  assertAssignedMembershipRevisionCapacity,
  type PlatformAuthorityGuard,
} from '../platform/platform-authority.guard';
import type {
  AccessGrantDocument,
  AccessGrantSubjectType,
  PermissionContext,
  PermissionDefinitionDocument,
  PermissionEffect,
  PermissionProfileDocument,
  PermissionProfileEntry,
  PermissionScope,
} from './permission.types';

export class PermissionDefinitionRepository {
  private readonly definitions: Collection<PermissionDefinitionDocument>;

  constructor(database: Database) {
    this.definitions =
      database.db.collection<PermissionDefinitionDocument>('permission_definitions');
  }

  async listActive(): Promise<PermissionDefinitionDocument[]> {
    return await this.definitions.find({ state: 'ACTIVE' }).sort({ key: 1 }).toArray();
  }

  async findActiveByKey(
    key: string,
    tx?: TransactionContext,
  ): Promise<PermissionDefinitionDocument | null> {
    return await this.definitions.findOne(
      { key, state: 'ACTIVE' },
      tx ? { session: tx.session } : undefined,
    );
  }
}

export class PermissionProfileRepository {
  private readonly profiles: Collection<PermissionProfileDocument>;

  constructor(
    private readonly database: Database,
    private readonly unitOfWork?: UnitOfWork,
    private readonly authorityGuard?: PlatformAuthorityGuard,
  ) {
    this.profiles = database.db.collection<PermissionProfileDocument>('permission_profiles');
  }

  async listWorkspace(workspaceId: ObjectId): Promise<PermissionProfileDocument[]> {
    return await this.profiles
      .find({ context: 'WORKSPACE', workspaceId, status: 'ACTIVE' })
      .sort({ name: 1 })
      .toArray();
  }

  private async protectedProfileWrite<T>(
    profileId: ObjectId,
    tx: TransactionContext | undefined,
    operation: (tx?: TransactionContext) => Promise<T>,
  ): Promise<T> {
    if (!this.authorityGuard) return await operation(tx);
    if (!tx) {
      if (!this.unitOfWork) throw new Error('Platform profile writes require UnitOfWork.');
      return await this.unitOfWork.withTransaction((next) =>
        this.protectedProfileWrite(profileId, next, operation),
      );
    }
    const profile = await this.findById(profileId, tx);
    if (profile?.context === 'PLATFORM') await this.authorityGuard.serialize(tx);
    return await operation(tx);
  }

  async update(
    profileId: ObjectId,
    expectedVersion: number,
    input: { name?: string; permissions?: PermissionProfileEntry[]; now?: Date },
    tx?: TransactionContext,
  ) {
    return await this.protectedProfileWrite(profileId, tx, async (next) => {
      const previous = await this.findById(profileId, next);
      const result = await this.updateWithinTransaction(profileId, expectedVersion, input, next);
      if (
        this.authorityGuard &&
        result.context === 'PLATFORM' &&
        input.permissions &&
        JSON.stringify(
          previous?.permissions.map((entry) => `${entry.permission}|${entry.effect}`).sort(),
        ) !==
          JSON.stringify(
            input.permissions.map((entry) => `${entry.permission}|${entry.effect}`).sort(),
          )
      )
        await this.bumpAssignedMemberships(profileId, input.now ?? new Date(), next);
      return result;
    });
  }

  async archive(
    profileId: ObjectId,
    expectedVersion: number,
    now = new Date(),
    tx?: TransactionContext,
  ) {
    return await this.protectedProfileWrite(profileId, tx, async (next) => {
      const result = await this.archiveWithinTransaction(profileId, expectedVersion, now, next);
      if (this.authorityGuard && result.context === 'PLATFORM')
        await this.bumpAssignedMemberships(profileId, now, next);
      return result;
    });
  }

  private async bumpAssignedMemberships(profileId: ObjectId, now: Date, tx?: TransactionContext) {
    const memberships = this.database.db.collection('platform_memberships');
    await assertAssignedMembershipRevisionCapacity(this.database.db, profileId, tx);
    await memberships.updateMany(
      { permissionProfileIds: profileId },
      { $set: { updatedAt: now }, $inc: { accessVersion: 1, version: 1 } },
      tx ? { session: tx.session } : {},
    );
  }

  async listPlatform(): Promise<PermissionProfileDocument[]> {
    return await this.profiles
      .find({ context: 'PLATFORM', status: 'ACTIVE' })
      .sort({ name: 1 })
      .toArray();
  }

  async findById(
    profileId: ObjectId,
    tx?: TransactionContext,
  ): Promise<PermissionProfileDocument | null> {
    return await this.profiles.findOne(
      { _id: profileId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async findManyByIds(
    profileIds: ObjectId[],
    tx?: TransactionContext,
  ): Promise<PermissionProfileDocument[]> {
    if (profileIds.length === 0) return [];
    return await this.profiles
      .find({ _id: { $in: profileIds } }, tx ? { session: tx.session } : undefined)
      .toArray();
  }

  async findSystemDefault(
    input: { context: PermissionContext; roleKey: string; workspaceId?: ObjectId },
    tx?: TransactionContext,
  ): Promise<PermissionProfileDocument | null> {
    return await this.profiles.findOne(
      {
        context: input.context,
        roleKey: input.roleKey,
        isSystemDefault: true,
        status: 'ACTIVE',
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      },
      tx ? { session: tx.session } : undefined,
    );
  }

  async create(
    input: {
      context: PermissionContext;
      workspaceId?: ObjectId;
      name: string;
      roleKey?: string;
      permissions: PermissionProfileEntry[];
      isSystemDefault?: boolean;
      now?: Date;
    },
    tx?: TransactionContext,
  ): Promise<PermissionProfileDocument> {
    const now = input.now ?? new Date();
    const profile: PermissionProfileDocument = {
      _id: new ObjectId(),
      context: input.context,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      name: input.name,
      ...(input.roleKey ? { roleKey: input.roleKey } : {}),
      permissions: input.permissions,
      isSystemDefault: input.isSystemDefault ?? false,
      status: 'ACTIVE',
      version: 0,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.profiles.insertOne(profile, tx ? { session: tx.session } : undefined);
      return profile;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw duplicateProfile();
      }
      throw error;
    }
  }

  private async updateWithinTransaction(
    profileId: ObjectId,
    expectedVersion: number,
    input: { name?: string; permissions?: PermissionProfileEntry[]; now?: Date },
    tx?: TransactionContext,
  ): Promise<PermissionProfileDocument> {
    const now = input.now ?? new Date();
    const result = await this.profiles.findOneAndUpdate(
      { _id: profileId, status: 'ACTIVE', isSystemDefault: false, version: expectedVersion },
      {
        $set: compact({ name: input.name, permissions: input.permissions, updatedAt: now }),
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) {
      throw new AppError({
        code: 'PERMISSION_PROFILE_VERSION_CONFLICT',
        httpStatus: 409,
        message: 'The permission profile has changed or cannot be edited.',
      });
    }
    return result;
  }

  private async archiveWithinTransaction(
    profileId: ObjectId,
    expectedVersion: number,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<PermissionProfileDocument> {
    const result = await this.profiles.findOneAndUpdate(
      { _id: profileId, status: 'ACTIVE', isSystemDefault: false, version: expectedVersion },
      {
        $set: { status: 'ARCHIVED', archivedAt: now, updatedAt: now },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) {
      throw new AppError({
        code: 'PERMISSION_PROFILE_ARCHIVE_INVALID',
        httpStatus: 409,
        message: 'The permission profile cannot be archived.',
      });
    }
    return result;
  }
}

export class AccessGrantRepository {
  private readonly grants: Collection<AccessGrantDocument>;

  constructor(
    private readonly database: Database,
    private readonly unitOfWork?: UnitOfWork,
    private readonly authorityGuard?: PlatformAuthorityGuard,
  ) {
    this.grants = database.db.collection<AccessGrantDocument>('access_grants');
  }

  async listCurrent(
    subjectType: AccessGrantSubjectType,
    subjectId: ObjectId,
    context: PermissionContext,
    workspaceId?: ObjectId,
    tx?: TransactionContext,
  ): Promise<AccessGrantDocument[]> {
    return await this.grants
      .find(
        {
          subjectType,
          subjectId,
          context,
          ...(workspaceId ? { workspaceId } : {}),
        },
        tx ? { session: tx.session } : undefined,
      )
      .toArray();
  }

  async replaceCurrent(
    subjectType: AccessGrantSubjectType,
    subjectId: ObjectId,
    context: PermissionContext,
    workspaceId: ObjectId | undefined,
    grants: Array<{
      permission: string;
      effect: PermissionEffect;
      scope: PermissionScope;
      expiresAt?: Date;
    }>,
    createdBy: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<AccessGrantDocument[]> {
    if (context === 'PLATFORM' && this.authorityGuard) {
      if (!tx) {
        if (!this.unitOfWork) throw new Error('Platform grant writes require UnitOfWork.');
        return await this.unitOfWork.withTransaction((next) =>
          this.replaceCurrent(
            subjectType,
            subjectId,
            context,
            workspaceId,
            grants,
            createdBy,
            now,
            next,
          ),
        );
      }
      await this.authorityGuard.serialize(tx);
      if (!tx.platformAccessRevisionSubjects?.has(subjectId.toHexString())) {
        const member = await this.database.db
          .collection('platform_memberships')
          .findOneAndUpdate(
            { _id: subjectId, status: 'ACTIVE' },
            { $set: { updatedAt: now }, $inc: { version: 1, accessVersion: 1 } },
            { session: tx.session, returnDocument: 'after' },
          );
        if (!member || !Number.isSafeInteger(member.version) || member.version < 0)
          throw new AppError({
            code: 'PLATFORM_MEMBERSHIP_ACCESS_VERSION_CONFLICT',
            httpStatus: 409,
            message: 'Platform access state changed.',
          });
        tx.platformAccessRevisionSubjects ??= new Set();
        tx.platformAccessRevisionSubjects.add(subjectId.toHexString());
      }
    }
    await this.grants.deleteMany(
      { subjectType, subjectId, context, ...(workspaceId ? { workspaceId } : {}) },
      tx ? { session: tx.session } : undefined,
    );
    const documents = grants.map((grant) => ({
      _id: new ObjectId(),
      context,
      ...(workspaceId ? { workspaceId } : {}),
      subjectType,
      subjectId,
      permission: grant.permission,
      effect: grant.effect,
      scope: grant.scope,
      createdBy,
      createdAt: now,
      ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
    }));
    if (documents.length > 0) {
      await this.grants.insertMany(documents, tx ? { session: tx.session } : undefined);
    }
    return documents;
  }
}

function duplicateProfile(): AppError {
  return new AppError({
    code: 'PERMISSION_PROFILE_DUPLICATE',
    httpStatus: 409,
    message: 'A permission profile with this name already exists in this context.',
  });
}

function compact<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
