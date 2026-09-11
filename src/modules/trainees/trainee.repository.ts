import { type Collection, MongoServerError, ObjectId, type UpdateFilter } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type {
  CoachingRelationshipDocument,
  CoachingRelationshipStatus,
  TraineeReferralCodeDocument,
  TraineeStaffAssignmentDocument,
  TraineeStaffAssignmentType,
} from './trainee.types';

const countedStatuses: CoachingRelationshipStatus[] = ['ACTIVE', 'NEEDS_REASSIGNMENT'];

export class CoachingRelationshipRepository {
  private readonly relationships: Collection<CoachingRelationshipDocument>;
  private readonly assignments: Collection<TraineeStaffAssignmentDocument>;
  private readonly referralCodes: Collection<TraineeReferralCodeDocument>;

  constructor(database: Database) {
    this.relationships =
      database.db.collection<CoachingRelationshipDocument>('coaching_relationships');
    this.assignments = database.db.collection<TraineeStaffAssignmentDocument>(
      'trainee_staff_assignments',
    );
    this.referralCodes = database.db.collection<TraineeReferralCodeDocument>('referral_codes');
  }

  async list(
    workspaceId: ObjectId,
    filters: { status?: CoachingRelationshipStatus; traineeUserId?: ObjectId } = {},
  ): Promise<CoachingRelationshipDocument[]> {
    return await this.relationships
      .find({
        workspaceId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.traineeUserId ? { traineeUserId: filters.traineeUserId } : {}),
      })
      .sort({ updatedAt: -1 })
      .limit(100)
      .toArray();
  }

  async findByIdInWorkspace(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    tx?: TransactionContext,
  ): Promise<CoachingRelationshipDocument | null> {
    return await this.relationships.findOne(
      { _id: relationshipId, workspaceId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async findByWorkspaceAndUser(
    workspaceId: ObjectId,
    traineeUserId: ObjectId,
    tx?: TransactionContext,
  ): Promise<CoachingRelationshipDocument | null> {
    return await this.relationships.findOne(
      { workspaceId, traineeUserId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async createPending(
    input: {
      workspaceId: ObjectId;
      traineeUserId: ObjectId;
      homeBranchId?: ObjectId;
      proposedPrimaryTrainerMembershipId?: ObjectId;
      requestedBy: ObjectId;
      now?: Date;
    },
    tx?: TransactionContext,
  ): Promise<CoachingRelationshipDocument> {
    const now = input.now ?? new Date();
    const relationship: CoachingRelationshipDocument = {
      _id: new ObjectId(),
      workspaceId: input.workspaceId,
      traineeUserId: input.traineeUserId,
      status: 'PENDING',
      ...(input.homeBranchId ? { homeBranchId: input.homeBranchId } : {}),
      ...(input.proposedPrimaryTrainerMembershipId
        ? { proposedPrimaryTrainerMembershipId: input.proposedPrimaryTrainerMembershipId }
        : {}),
      engagementPeriods: [],
      version: 0,
      requestedBy: input.requestedBy,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.relationships.insertOne(relationship, tx ? { session: tx.session } : undefined);
      return relationship;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw conflict('COACHING_RELATIONSHIP_EXISTS');
      }
      throw error;
    }
  }

  async createActive(
    input: {
      workspaceId: ObjectId;
      traineeUserId: ObjectId;
      traineeMembershipId: ObjectId;
      homeBranchId?: ObjectId;
      activatedBy: ObjectId;
      now?: Date;
    },
    tx?: TransactionContext,
  ): Promise<CoachingRelationshipDocument> {
    const now = input.now ?? new Date();
    const relationship: CoachingRelationshipDocument = {
      _id: new ObjectId(),
      workspaceId: input.workspaceId,
      traineeUserId: input.traineeUserId,
      traineeMembershipId: input.traineeMembershipId,
      status: 'ACTIVE',
      ...(input.homeBranchId ? { homeBranchId: input.homeBranchId } : {}),
      engagementPeriods: [{ startedAt: now }],
      version: 0,
      activatedBy: input.activatedBy,
      activatedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.relationships.insertOne(relationship, tx ? { session: tx.session } : undefined);
      return relationship;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw conflict('COACHING_RELATIONSHIP_EXISTS');
      }
      throw error;
    }
  }

  async transition(
    relationshipId: ObjectId,
    workspaceId: ObjectId,
    expectedVersion: number,
    from: CoachingRelationshipStatus[],
    to: CoachingRelationshipStatus,
    patch: Partial<CoachingRelationshipDocument>,
    options: { openEngagement?: boolean; closeEngagement?: boolean } = {},
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<CoachingRelationshipDocument> {
    const update: UpdateFilter<CoachingRelationshipDocument> = {
      $set: { ...patch, status: to, updatedAt: now },
      $inc: { version: 1 },
      ...(options.openEngagement ? { $push: { engagementPeriods: { startedAt: now } } } : {}),
    };
    if (options.closeEngagement) {
      update.$set = { ...update.$set, 'engagementPeriods.$[activePeriod].endedAt': now };
    }
    const result = await this.relationships.findOneAndUpdate(
      {
        _id: relationshipId,
        workspaceId,
        version: expectedVersion,
        status: { $in: from },
        ...(options.closeEngagement
          ? { engagementPeriods: { $elemMatch: { endedAt: { $exists: false } } } }
          : {}),
        ...(options.openEngagement
          ? { engagementPeriods: { $not: { $elemMatch: { endedAt: { $exists: false } } } } }
          : {}),
      },
      update,
      {
        returnDocument: 'after',
        ...(options.closeEngagement
          ? { arrayFilters: [{ 'activePeriod.endedAt': { $exists: false } }] }
          : {}),
        ...(tx ? { session: tx.session } : {}),
      },
    );
    if (!result) throw conflict('COACHING_RELATIONSHIP_VERSION_CONFLICT');
    return result;
  }

  async setPrimaryPointer(
    relationshipId: ObjectId,
    workspaceId: ObjectId,
    expectedVersion: number,
    status: CoachingRelationshipStatus[],
    assignmentId: ObjectId | undefined,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<CoachingRelationshipDocument> {
    const update: UpdateFilter<CoachingRelationshipDocument> = {
      $set: assignmentId
        ? { currentPrimaryTrainerAssignmentId: assignmentId, status: 'ACTIVE', updatedAt: now }
        : { status: 'ACTIVE', updatedAt: now },
      $inc: { version: 1 },
      ...(assignmentId ? {} : { $unset: { currentPrimaryTrainerAssignmentId: '' } }),
    };
    const result = await this.relationships.findOneAndUpdate(
      { _id: relationshipId, workspaceId, version: expectedVersion, status: { $in: status } },
      update,
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('COACHING_RELATIONSHIP_VERSION_CONFLICT');
    return result;
  }

  async changeHomeBranch(
    relationshipId: ObjectId,
    workspaceId: ObjectId,
    expectedVersion: number,
    homeBranchId: ObjectId,
    primaryAssignmentId: ObjectId | undefined,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<CoachingRelationshipDocument> {
    const result = await this.relationships.findOneAndUpdate(
      {
        _id: relationshipId,
        workspaceId,
        version: expectedVersion,
        status: { $in: ['ACTIVE', 'NEEDS_REASSIGNMENT'] },
      },
      {
        $set: {
          homeBranchId,
          ...(primaryAssignmentId
            ? { currentPrimaryTrainerAssignmentId: primaryAssignmentId }
            : {}),
          status: 'ACTIVE',
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('COACHING_RELATIONSHIP_VERSION_CONFLICT');
    return result;
  }

  async markNeedsReassignment(
    relationshipId: ObjectId,
    workspaceId: ObjectId,
    expectedVersion: number,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<CoachingRelationshipDocument> {
    const result = await this.relationships.findOneAndUpdate(
      { _id: relationshipId, workspaceId, version: expectedVersion, status: 'ACTIVE' },
      {
        $set: { status: 'NEEDS_REASSIGNMENT', updatedAt: now },
        $unset: { currentPrimaryTrainerAssignmentId: '' },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('COACHING_RELATIONSHIP_VERSION_CONFLICT');
    return result;
  }

  async bumpVersion(
    relationshipId: ObjectId,
    workspaceId: ObjectId,
    expectedVersion: number,
    statuses: CoachingRelationshipStatus[],
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<CoachingRelationshipDocument> {
    const result = await this.relationships.findOneAndUpdate(
      { _id: relationshipId, workspaceId, version: expectedVersion, status: { $in: statuses } },
      { $set: { updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('COACHING_RELATIONSHIP_VERSION_CONFLICT');
    return result;
  }

  async guardTrainingLifecycleActive(
    relationshipId: ObjectId,
    workspaceId: ObjectId,
    tx: TransactionContext,
  ): Promise<CoachingRelationshipDocument> {
    const result = await this.relationships.findOneAndUpdate(
      { _id: relationshipId, workspaceId, status: 'ACTIVE' },
      { $inc: { trainingLifecycleRevision: 1 } },
      { returnDocument: 'after', session: tx.session },
    );
    if (!result) throw conflict('COACHING_RELATIONSHIP_STATUS_INVALID');
    return result;
  }

  async guardWorkoutLifecycleActive(
    relationshipId: ObjectId,
    workspaceId: ObjectId,
    tx: TransactionContext,
  ): Promise<CoachingRelationshipDocument> {
    const result = await this.relationships.findOneAndUpdate(
      { _id: relationshipId, workspaceId, status: 'ACTIVE' },
      { $inc: { workoutLifecycleRevision: 1 } },
      { returnDocument: 'after', session: tx.session },
    );
    if (!result) throw conflict('RELATIONSHIP_NOT_ACTIVE');
    return result;
  }

  async guardWorkoutLifecycleOpen(
    relationshipId: ObjectId,
    workspaceId: ObjectId,
    tx: TransactionContext,
  ): Promise<CoachingRelationshipDocument> {
    const result = await this.relationships.findOneAndUpdate(
      { _id: relationshipId, workspaceId, status: { $in: ['ACTIVE', 'NEEDS_REASSIGNMENT'] } },
      { $inc: { workoutLifecycleRevision: 1 } },
      { returnDocument: 'after', session: tx.session },
    );
    if (!result) throw conflict('RELATIONSHIP_NOT_ACTIVE');
    return result;
  }

  async guardNutritionLifecycleOpen(
    relationshipId: ObjectId,
    workspaceId: ObjectId,
    tx: TransactionContext,
  ): Promise<CoachingRelationshipDocument> {
    const result = await this.relationships.findOneAndUpdate(
      { _id: relationshipId, workspaceId, status: { $in: ['ACTIVE', 'NEEDS_REASSIGNMENT'] } },
      { $inc: { nutritionLifecycleRevision: 1 } },
      { returnDocument: 'after', session: tx.session },
    );
    if (!result) throw conflict('RELATIONSHIP_NOT_NUTRITION_OPEN');
    return result;
  }

  async countActiveForUsage(workspaceId: ObjectId): Promise<number> {
    return await this.relationships.countDocuments({
      workspaceId,
      status: { $in: countedStatuses },
    });
  }

  async createAssignment(
    input: {
      workspaceId: ObjectId;
      relationshipId: ObjectId;
      staffMembershipId: ObjectId;
      assignmentType: TraineeStaffAssignmentType;
      assignedBy: ObjectId;
      reason?: string;
      now?: Date;
    },
    tx?: TransactionContext,
  ): Promise<TraineeStaffAssignmentDocument> {
    const now = input.now ?? new Date();
    const assignment: TraineeStaffAssignmentDocument = {
      _id: new ObjectId(),
      workspaceId: input.workspaceId,
      relationshipId: input.relationshipId,
      staffMembershipId: input.staffMembershipId,
      assignmentType: input.assignmentType,
      active: true,
      startedAt: now,
      assignedBy: input.assignedBy,
      ...(input.reason ? { reason: input.reason } : {}),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.assignments.insertOne(assignment, tx ? { session: tx.session } : undefined);
      return assignment;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw conflict('TRAINEE_ASSIGNMENT_EXISTS');
      }
      throw error;
    }
  }

  async findActivePrimary(
    relationshipId: ObjectId,
    tx?: TransactionContext,
  ): Promise<TraineeStaffAssignmentDocument | null> {
    return await this.assignments.findOne(
      { relationshipId, assignmentType: 'PRIMARY_TRAINER', active: true },
      tx ? { session: tx.session } : undefined,
    );
  }

  async findActiveAssignment(
    relationshipId: ObjectId,
    staffMembershipId: ObjectId,
    assignmentType: TraineeStaffAssignmentType,
    tx?: TransactionContext,
  ): Promise<TraineeStaffAssignmentDocument | null> {
    return await this.assignments.findOne(
      { relationshipId, staffMembershipId, assignmentType, active: true },
      tx ? { session: tx.session } : undefined,
    );
  }

  async listActiveAssignments(
    relationshipId: ObjectId,
    tx?: TransactionContext,
  ): Promise<TraineeStaffAssignmentDocument[]> {
    return await this.assignments
      .find({ relationshipId, active: true }, tx ? { session: tx.session } : undefined)
      .toArray();
  }

  async listActivePrimaryAssignmentsForStaff(
    workspaceId: ObjectId,
    staffMembershipId: ObjectId,
    options: { afterId?: ObjectId; limit?: number } = {},
  ): Promise<TraineeStaffAssignmentDocument[]> {
    return await this.assignments
      .find({
        workspaceId,
        staffMembershipId,
        assignmentType: 'PRIMARY_TRAINER',
        active: true,
        ...(options.afterId ? { _id: { $gt: options.afterId } } : {}),
      })
      .sort({ _id: 1 })
      .limit(options.limit ?? 50)
      .toArray();
  }

  async findActivePrimaryById(
    assignmentId: ObjectId,
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    tx?: TransactionContext,
  ): Promise<TraineeStaffAssignmentDocument | null> {
    return await this.assignments.findOne(
      {
        _id: assignmentId,
        workspaceId,
        relationshipId,
        assignmentType: 'PRIMARY_TRAINER',
        active: true,
      },
      tx ? { session: tx.session } : undefined,
    );
  }

  async closeAssignment(
    assignmentId: ObjectId,
    endedBy: ObjectId,
    reason: string | undefined,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<boolean> {
    const result = await this.assignments.updateOne(
      { _id: assignmentId, active: true },
      {
        $set: {
          active: false,
          endedAt: now,
          endedBy,
          ...(reason ? { reason } : {}),
          updatedAt: now,
        },
      },
      tx ? { session: tx.session } : undefined,
    );
    return result.modifiedCount === 1;
  }

  async closeActiveAssignmentsForRelationship(
    relationshipId: ObjectId,
    endedBy: ObjectId,
    reason: string | undefined,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<number> {
    const result = await this.assignments.updateMany(
      { relationshipId, active: true },
      {
        $set: {
          active: false,
          endedAt: now,
          endedBy,
          ...(reason ? { reason } : {}),
          updatedAt: now,
        },
      },
      tx ? { session: tx.session } : undefined,
    );
    return result.modifiedCount;
  }

  async findReferralCode(
    code: string,
    now = new Date(),
  ): Promise<TraineeReferralCodeDocument | null> {
    return await this.referralCodes.findOne({
      code,
      active: true,
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
    });
  }
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The coaching relationship changed.' });
}
