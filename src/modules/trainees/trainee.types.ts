import type { ObjectId } from 'mongodb';

export const CoachingRelationshipStatuses = [
  'PENDING',
  'ACTIVE',
  'NEEDS_REASSIGNMENT',
  'ENDED',
  'ARCHIVED',
] as const;
export type CoachingRelationshipStatus = (typeof CoachingRelationshipStatuses)[number];

export const TraineeStaffAssignmentTypes = [
  'PRIMARY_TRAINER',
  'ASSISTANT_TRAINER',
  'NUTRITIONIST',
] as const;
export type TraineeStaffAssignmentType = (typeof TraineeStaffAssignmentTypes)[number];

export interface CoachingEngagementPeriod {
  startedAt: Date;
  endedAt?: Date;
}

export interface CoachingRelationshipDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  traineeUserId: ObjectId;
  traineeMembershipId?: ObjectId;
  status: CoachingRelationshipStatus;
  homeBranchId?: ObjectId;
  proposedPrimaryTrainerMembershipId?: ObjectId;
  currentPrimaryTrainerAssignmentId?: ObjectId;
  engagementPeriods: CoachingEngagementPeriod[];
  version: number;
  requestedBy?: ObjectId;
  requestedAt?: Date;
  activatedBy?: ObjectId;
  activatedAt?: Date;
  endedBy?: ObjectId;
  endedAt?: Date;
  endReason?: string;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TraineeStaffAssignmentDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  staffMembershipId: ObjectId;
  assignmentType: TraineeStaffAssignmentType;
  active: boolean;
  startedAt: Date;
  endedAt?: Date;
  assignedBy: ObjectId;
  endedBy?: ObjectId;
  reason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TraineeReferralCodeDocument {
  _id: ObjectId;
  code: string;
  ownerWorkspaceId: ObjectId;
  ownerUserId?: ObjectId;
  active: boolean;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
