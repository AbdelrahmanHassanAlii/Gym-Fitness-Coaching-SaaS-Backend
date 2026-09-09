import { type Collection, MongoServerError, ObjectId, type UpdateFilter } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type {
  BranchDocument,
  InvitationDocument,
  MembershipBranchAssignmentDocument,
  WorkspaceDocument,
  WorkspaceMembershipDocument,
  WorkspaceMembershipRole,
  WorkspaceStatus,
  WorkspaceType,
} from './workspace.types';

export class WorkspaceRepository {
  private readonly workspaces: Collection<WorkspaceDocument>;

  constructor(database: Database) {
    this.workspaces = database.db.collection<WorkspaceDocument>('workspaces');
  }

  async create(
    input: {
      type: WorkspaceType;
      name: string;
      ownerUserId: ObjectId;
      timezone: string;
      defaultLanguage: 'ar' | 'en';
      country?: string;
      city?: string;
      governorate?: string;
      createdFromLeadId?: ObjectId;
      status?: WorkspaceStatus;
      now?: Date;
    },
    tx?: TransactionContext,
  ): Promise<WorkspaceDocument> {
    const now = input.now ?? new Date();
    const workspace: WorkspaceDocument = {
      _id: new ObjectId(),
      type: input.type,
      name: input.name,
      ownerUserId: input.ownerUserId,
      status: input.status ?? 'ACTIVE',
      timezone: input.timezone,
      defaultLanguage: input.defaultLanguage,
      createdAt: now,
      updatedAt: now,
      ...(input.country ? { country: input.country } : {}),
      ...(input.city ? { city: input.city } : {}),
      ...(input.governorate ? { governorate: input.governorate } : {}),
      ...(input.createdFromLeadId ? { createdFromLeadId: input.createdFromLeadId } : {}),
    };
    await this.workspaces.insertOne(workspace, tx ? { session: tx.session } : undefined);
    return workspace;
  }

  async findById(
    workspaceId: ObjectId,
    tx?: TransactionContext,
  ): Promise<WorkspaceDocument | null> {
    return await this.workspaces.findOne(
      { _id: workspaceId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async listIds(): Promise<ObjectId[]> {
    const workspaces = await this.workspaces.find({}, { projection: { _id: 1 } }).toArray();
    return workspaces.map((workspace) => workspace._id);
  }

  async update(
    workspaceId: ObjectId,
    input: {
      name?: string;
      timezone?: string;
      defaultLanguage?: 'ar' | 'en';
      city?: string;
      governorate?: string;
      now?: Date;
    },
    tx?: TransactionContext,
  ): Promise<WorkspaceDocument> {
    const now = input.now ?? new Date();
    const set = compact({
      name: input.name,
      timezone: input.timezone,
      defaultLanguage: input.defaultLanguage,
      city: input.city,
      governorate: input.governorate,
      updatedAt: now,
    });
    const result = await this.workspaces.findOneAndUpdate(
      { _id: workspaceId },
      { $set: set },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw notFound('WORKSPACE_NOT_FOUND', 'Workspace not found.');
    return result;
  }

  async activatePending(
    workspaceId: ObjectId,
    ownerUserId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<WorkspaceDocument> {
    const result = await this.workspaces.findOneAndUpdate(
      { _id: workspaceId, ownerUserId, status: 'PENDING_ACTIVATION' },
      { $set: { status: 'ACTIVE', updatedAt: now } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) {
      throw new AppError({
        code: 'WORKSPACE_ACTIVATION_INVALID',
        httpStatus: 409,
        message: 'The workspace cannot be activated.',
      });
    }
    return result;
  }
}

export class WorkspaceMembershipRepository {
  private readonly memberships: Collection<WorkspaceMembershipDocument>;

  constructor(database: Database) {
    this.memberships = database.db.collection<WorkspaceMembershipDocument>('workspace_memberships');
  }

  async createActive(
    input: {
      workspaceId: ObjectId;
      userId: ObjectId;
      roles: WorkspaceMembershipRole[];
      now?: Date;
    },
    tx?: TransactionContext,
  ): Promise<WorkspaceMembershipDocument> {
    const now = input.now ?? new Date();
    const membership: WorkspaceMembershipDocument = {
      _id: new ObjectId(),
      workspaceId: input.workspaceId,
      userId: input.userId,
      roles: input.roles,
      status: 'ACTIVE',
      joinedAt: now,
      engagementPeriods: [{ startedAt: now }],
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
          code: 'WORKSPACE_MEMBERSHIP_EXISTS',
          httpStatus: 409,
          message: 'The user already has a membership in this workspace.',
        });
      }
      throw error;
    }
  }

  async createInvited(
    input: {
      workspaceId: ObjectId;
      userId: ObjectId;
      roles: WorkspaceMembershipRole[];
      permissionProfileIds?: ObjectId[];
      now?: Date;
    },
    tx?: TransactionContext,
  ): Promise<WorkspaceMembershipDocument> {
    const now = input.now ?? new Date();
    const membership: WorkspaceMembershipDocument = {
      _id: new ObjectId(),
      workspaceId: input.workspaceId,
      userId: input.userId,
      roles: input.roles,
      status: 'INVITED',
      joinedAt: now,
      engagementPeriods: [],
      permissionProfileIds: input.permissionProfileIds ?? [],
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
          code: 'WORKSPACE_MEMBERSHIP_EXISTS',
          httpStatus: 409,
          message: 'The user already has a membership in this workspace.',
        });
      }
      throw error;
    }
  }

  async activateInvitedOwner(
    workspaceId: ObjectId,
    userId: ObjectId,
    roles: WorkspaceMembershipRole[],
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<WorkspaceMembershipDocument> {
    const result = await this.memberships.findOneAndUpdate(
      {
        workspaceId,
        userId,
        status: 'INVITED',
        engagementPeriods: { $not: { $elemMatch: { endedAt: { $exists: false } } } },
      },
      {
        $set: { status: 'ACTIVE', roles, joinedAt: now, updatedAt: now },
        $push: { engagementPeriods: { startedAt: now } },
        $inc: { accessVersion: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) {
      throw new AppError({
        code: 'OWNER_ACTIVATION_MEMBERSHIP_INVALID',
        httpStatus: 409,
        message: 'The owner membership cannot be activated.',
      });
    }
    return result;
  }

  async listActiveByUser(userId: ObjectId): Promise<WorkspaceMembershipDocument[]> {
    return await this.memberships.find({ userId, status: 'ACTIVE' }).toArray();
  }

  async listByWorkspace(workspaceId: ObjectId): Promise<WorkspaceMembershipDocument[]> {
    return await this.memberships.find({ workspaceId }).sort({ joinedAt: -1 }).toArray();
  }

  async findByIdInWorkspace(
    workspaceId: ObjectId,
    membershipId: ObjectId,
    tx?: TransactionContext,
  ): Promise<WorkspaceMembershipDocument | null> {
    return await this.memberships.findOne(
      { _id: membershipId, workspaceId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async findByUserInWorkspace(
    workspaceId: ObjectId,
    userId: ObjectId,
    tx?: TransactionContext,
  ): Promise<WorkspaceMembershipDocument | null> {
    return await this.memberships.findOne(
      { workspaceId, userId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async reactivate(
    workspaceId: ObjectId,
    membershipId: ObjectId,
    roles: WorkspaceMembershipRole[],
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<WorkspaceMembershipDocument> {
    const result = await this.memberships.findOneAndUpdate(
      {
        _id: membershipId,
        workspaceId,
        status: { $in: ['SUSPENDED', 'ENDED'] },
        engagementPeriods: { $not: { $elemMatch: { endedAt: { $exists: false } } } },
      },
      {
        $set: { status: 'ACTIVE', roles, updatedAt: now },
        $unset: { endedAt: '' },
        $push: { engagementPeriods: { startedAt: now } },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) {
      throw new AppError({
        code: 'WORKSPACE_MEMBERSHIP_REACTIVATION_INVALID',
        httpStatus: 409,
        message: 'The workspace membership cannot be reactivated.',
      });
    }
    return result;
  }

  async transition(
    workspaceId: ObjectId,
    membershipId: ObjectId,
    from: Array<'ACTIVE' | 'SUSPENDED' | 'ENDED'>,
    to: 'ACTIVE' | 'SUSPENDED' | 'ENDED',
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<WorkspaceMembershipDocument> {
    const closesOpenPeriod = to === 'SUSPENDED' || to === 'ENDED';
    const opensNewPeriod = to === 'ACTIVE';
    const sourceRequiresOpenPeriod = from.includes('ACTIVE');
    const update: UpdateFilter<WorkspaceMembershipDocument> = closesOpenPeriod
      ? {
          $set: {
            status: to,
            ...(to === 'ENDED' ? { endedAt: now } : {}),
            updatedAt: now,
            'engagementPeriods.$[activePeriod].endedAt': now,
          },
        }
      : {
          $set: { status: to, updatedAt: now },
          $unset: { endedAt: '' },
          $push: { engagementPeriods: { startedAt: now } },
        };
    const result = await this.memberships.findOneAndUpdate(
      {
        _id: membershipId,
        workspaceId,
        status: { $in: from },
        ...(sourceRequiresOpenPeriod
          ? { engagementPeriods: { $elemMatch: { endedAt: { $exists: false } } } }
          : {}),
        ...(opensNewPeriod
          ? { engagementPeriods: { $not: { $elemMatch: { endedAt: { $exists: false } } } } }
          : {}),
      },
      update,
      {
        returnDocument: 'after',
        ...(closesOpenPeriod
          ? { arrayFilters: [{ 'activePeriod.endedAt': { $exists: false } }] }
          : {}),
        ...(tx ? { session: tx.session } : {}),
      },
    );
    if (!result) {
      throw new AppError({
        code: 'WORKSPACE_MEMBERSHIP_TRANSITION_INVALID',
        httpStatus: 409,
        message: 'The workspace membership cannot make the requested transition.',
      });
    }
    return result;
  }

  async replacePermissionProfiles(
    workspaceId: ObjectId,
    membershipId: ObjectId,
    expectedVersion: number,
    permissionProfileIds: ObjectId[],
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<WorkspaceMembershipDocument> {
    const result = await this.memberships.findOneAndUpdate(
      { _id: membershipId, workspaceId, status: 'ACTIVE', accessVersion: expectedVersion },
      {
        $set: { permissionProfileIds, updatedAt: now },
        $inc: { accessVersion: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );

    if (!result) {
      throw new AppError({
        code: 'WORKSPACE_MEMBERSHIP_ACCESS_VERSION_CONFLICT',
        httpStatus: 409,
        message: 'The workspace membership permission profile set has changed.',
      });
    }

    return result;
  }

  async bumpAccessVersion(
    workspaceId: ObjectId,
    membershipId: ObjectId,
    expectedVersion: number,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<WorkspaceMembershipDocument> {
    const result = await this.memberships.findOneAndUpdate(
      { _id: membershipId, workspaceId, status: 'ACTIVE', accessVersion: expectedVersion },
      { $set: { updatedAt: now }, $inc: { accessVersion: 1 } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );

    if (!result) {
      throw new AppError({
        code: 'WORKSPACE_MEMBERSHIP_ACCESS_VERSION_CONFLICT',
        httpStatus: 409,
        message: 'The workspace membership access state has changed.',
      });
    }

    return result;
  }

  async updateRoleAndProfileContributions(
    workspaceId: ObjectId,
    membershipId: ObjectId,
    expectedAccessVersion: number,
    input: {
      roles: WorkspaceMembershipRole[];
      permissionProfileIds: ObjectId[];
      now?: Date;
    },
    tx?: TransactionContext,
  ): Promise<WorkspaceMembershipDocument> {
    const now = input.now ?? new Date();
    const result = await this.memberships.findOneAndUpdate(
      { _id: membershipId, workspaceId, status: 'ACTIVE', accessVersion: expectedAccessVersion },
      {
        $set: {
          roles: input.roles,
          permissionProfileIds: input.permissionProfileIds,
          updatedAt: now,
        },
        $inc: { accessVersion: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );

    if (!result) {
      throw new AppError({
        code: 'WORKSPACE_MEMBERSHIP_ACCESS_VERSION_CONFLICT',
        httpStatus: 409,
        message: 'The workspace membership access state has changed.',
      });
    }

    return result;
  }
}

export class BranchRepository {
  private readonly branches: Collection<BranchDocument>;

  constructor(database: Database) {
    this.branches = database.db.collection<BranchDocument>('branches');
  }

  async create(
    input: {
      workspaceId: ObjectId;
      name: string;
      code?: string;
      timezone: string;
      address?: string;
      city?: string;
      governorate?: string;
      now?: Date;
    },
    tx?: TransactionContext,
  ): Promise<BranchDocument> {
    const now = input.now ?? new Date();
    const branch: BranchDocument = {
      _id: new ObjectId(),
      workspaceId: input.workspaceId,
      name: input.name,
      timezone: input.timezone,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
      ...(input.code ? { code: input.code } : {}),
      ...(input.address ? { address: input.address } : {}),
      ...(input.city ? { city: input.city } : {}),
      ...(input.governorate ? { governorate: input.governorate } : {}),
    };

    try {
      await this.branches.insertOne(branch, tx ? { session: tx.session } : undefined);
      return branch;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new AppError({
          code: 'BRANCH_CODE_CONFLICT',
          httpStatus: 409,
          message: 'The branch code is already used in this workspace.',
        });
      }
      throw error;
    }
  }

  async listByWorkspace(workspaceId: ObjectId): Promise<BranchDocument[]> {
    return await this.branches.find({ workspaceId }).sort({ createdAt: -1 }).toArray();
  }

  async findByIdInWorkspace(
    workspaceId: ObjectId,
    branchId: ObjectId,
    tx?: TransactionContext,
  ): Promise<BranchDocument | null> {
    return await this.branches.findOne(
      { _id: branchId, workspaceId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async listByIdsInWorkspace(
    workspaceId: ObjectId,
    branchIds: ObjectId[],
    tx?: TransactionContext,
  ): Promise<BranchDocument[]> {
    if (branchIds.length === 0) return [];
    return await this.branches
      .find({ _id: { $in: branchIds }, workspaceId }, tx ? { session: tx.session } : undefined)
      .toArray();
  }

  async update(
    workspaceId: ObjectId,
    branchId: ObjectId,
    input: {
      name?: string;
      code?: string;
      timezone?: string;
      address?: string;
      city?: string;
      governorate?: string;
      now?: Date;
    },
    tx?: TransactionContext,
  ): Promise<BranchDocument> {
    const now = input.now ?? new Date();
    try {
      const result = await this.branches.findOneAndUpdate(
        { _id: branchId, workspaceId },
        {
          $set: compact({
            name: input.name,
            code: input.code,
            timezone: input.timezone,
            address: input.address,
            city: input.city,
            governorate: input.governorate,
            updatedAt: now,
          }),
        },
        { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
      );
      if (!result) throw notFound('BRANCH_NOT_FOUND', 'Branch not found.');
      return result;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new AppError({
          code: 'BRANCH_CODE_CONFLICT',
          httpStatus: 409,
          message: 'The branch code is already used in this workspace.',
        });
      }
      throw error;
    }
  }

  async archive(
    workspaceId: ObjectId,
    branchId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<BranchDocument> {
    const result = await this.branches.findOneAndUpdate(
      { _id: branchId, workspaceId, status: 'ACTIVE' },
      { $set: { status: 'ARCHIVED', archivedAt: now, updatedAt: now } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) {
      throw new AppError({
        code: 'BRANCH_ARCHIVE_INVALID',
        httpStatus: 409,
        message: 'The branch cannot be archived.',
      });
    }
    return result;
  }
}

export class MembershipBranchAssignmentRepository {
  private readonly assignments: Collection<MembershipBranchAssignmentDocument>;

  constructor(database: Database) {
    this.assignments = database.db.collection<MembershipBranchAssignmentDocument>(
      'membership_branch_assignments',
    );
  }

  async createActive(
    workspaceId: ObjectId,
    membershipId: ObjectId,
    branchId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<MembershipBranchAssignmentDocument> {
    const assignment: MembershipBranchAssignmentDocument = {
      _id: new ObjectId(),
      workspaceId,
      membershipId,
      branchId,
      active: true,
      startedAt: now,
      createdAt: now,
    };

    try {
      await this.assignments.insertOne(assignment, tx ? { session: tx.session } : undefined);
      return assignment;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new AppError({
          code: 'BRANCH_ASSIGNMENT_EXISTS',
          httpStatus: 409,
          message: 'The membership already has an active assignment to this branch.',
        });
      }
      throw error;
    }
  }

  async listActive(
    workspaceId: ObjectId,
    membershipId: ObjectId,
    tx?: TransactionContext,
  ): Promise<MembershipBranchAssignmentDocument[]> {
    return await this.assignments
      .find({ workspaceId, membershipId, active: true }, tx ? { session: tx.session } : undefined)
      .toArray();
  }

  async endActive(
    workspaceId: ObjectId,
    membershipId: ObjectId,
    branchId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<boolean> {
    const result = await this.assignments.updateOne(
      { workspaceId, membershipId, branchId, active: true },
      { $set: { active: false, endedAt: now } },
      tx ? { session: tx.session } : undefined,
    );
    return result.modifiedCount === 1;
  }
}

export class InvitationRepository {
  private readonly invitations: Collection<InvitationDocument>;

  constructor(database: Database) {
    this.invitations = database.db.collection<InvitationDocument>('invitations');
  }

  async create(
    invitation: InvitationDocument,
    tx?: TransactionContext,
  ): Promise<InvitationDocument> {
    try {
      await this.invitations.insertOne(invitation, tx ? { session: tx.session } : undefined);
      return invitation;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new AppError({
          code: 'INVITATION_CONFLICT',
          httpStatus: 409,
          message: 'An active invitation already exists for this workspace and identifier.',
        });
      }
      throw error;
    }
  }

  async supersedePendingForIdentifier(
    workspaceId: ObjectId,
    identifier: { normalizedEmail?: string; normalizedPhone?: string },
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<void> {
    await this.invitations.updateMany(
      {
        workspaceId,
        status: 'PENDING',
        ...(identifier.normalizedEmail
          ? { normalizedEmail: identifier.normalizedEmail }
          : { normalizedPhone: requiredIdentifier(identifier.normalizedPhone) }),
      },
      { $set: { status: 'SUPERSEDED', supersededAt: now, updatedAt: now } },
      tx ? { session: tx.session } : undefined,
    );
  }

  async findPendingByDigest(
    tokenDigest: string,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<InvitationDocument | null> {
    return await this.invitations.findOne(
      { tokenDigest, status: 'PENDING', expiresAt: { $gt: now } },
      tx ? { session: tx.session } : undefined,
    );
  }

  async findPendingOwnerActivationByWorkspace(
    workspaceId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<InvitationDocument | null> {
    return await this.invitations.findOne(
      {
        workspaceId,
        type: 'OWNER_ACTIVATION',
        status: 'PENDING',
        expiresAt: { $gt: now },
      },
      tx ? { session: tx.session } : undefined,
    );
  }

  async findPendingByIdInWorkspace(
    workspaceId: ObjectId,
    invitationId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<InvitationDocument | null> {
    return await this.invitations.findOne(
      { _id: invitationId, workspaceId, status: 'PENDING', expiresAt: { $gt: now } },
      tx ? { session: tx.session } : undefined,
    );
  }

  async rotatePendingOwnerActivationToken(
    invitationId: ObjectId,
    workspaceId: ObjectId,
    currentTokenDigest: string,
    newTokenDigest: string,
    expiresAt: Date,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<InvitationDocument> {
    const result = await this.invitations.findOneAndUpdate(
      {
        _id: invitationId,
        workspaceId,
        type: 'OWNER_ACTIVATION',
        status: 'PENDING',
        tokenDigest: currentTokenDigest,
        expiresAt: { $gt: now },
      },
      { $set: { tokenDigest: newTokenDigest, expiresAt, updatedAt: now } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw invalidInvitation();
    return result;
  }

  async rotatePendingTraineeInvitationToken(
    invitationId: ObjectId,
    workspaceId: ObjectId,
    currentTokenDigest: string,
    newTokenDigest: string,
    expiresAt: Date,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<InvitationDocument> {
    const result = await this.invitations.findOneAndUpdate(
      {
        _id: invitationId,
        workspaceId,
        type: 'TRAINEE_INVITATION',
        status: 'PENDING',
        tokenDigest: currentTokenDigest,
        expiresAt: { $gt: now },
      },
      { $set: { tokenDigest: newTokenDigest, expiresAt, updatedAt: now } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw invalidInvitation();
    return result;
  }

  async acceptPending(
    invitationId: ObjectId,
    userId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<boolean> {
    const result = await this.invitations.updateOne(
      { _id: invitationId, status: 'PENDING', expiresAt: { $gt: now } },
      { $set: { status: 'ACCEPTED', acceptedByUserId: userId, acceptedAt: now, updatedAt: now } },
      tx ? { session: tx.session } : undefined,
    );
    return result.modifiedCount === 1;
  }

  async revokePending(
    workspaceId: ObjectId,
    invitationId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<InvitationDocument> {
    const result = await this.invitations.findOneAndUpdate(
      { _id: invitationId, workspaceId, status: 'PENDING' },
      { $set: { status: 'REVOKED', revokedAt: now, updatedAt: now } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) {
      throw new AppError({
        code: 'INVITATION_REVOKE_INVALID',
        httpStatus: 409,
        message: 'The invitation cannot be revoked.',
      });
    }
    return result;
  }
}

function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function notFound(code: string, message: string): AppError {
  return new AppError({ code, httpStatus: 404, message });
}

function invalidInvitation(): AppError {
  return new AppError({
    code: 'INVITATION_INVALID',
    httpStatus: 401,
    message: 'The invitation is invalid or expired.',
  });
}

function requiredIdentifier(value: string | undefined): string {
  if (!value) {
    throw new AppError({
      code: 'INVITATION_IDENTIFIER_REQUIRED',
      httpStatus: 422,
      message: 'Invite an email or phone identifier.',
    });
  }
  return value;
}
