import type { ObjectId } from 'mongodb';

export const RetentionWarningOffsetsDays = [30, 7, 1] as const;
export type RetentionWarningOffsetDays = (typeof RetentionWarningOffsetsDays)[number];

export const WorkspaceDeletionStatuses = [
  'PENDING_APPROVAL',
  'POSTPONED',
  'CANCELLED',
  'APPROVED',
  'PROCESSING',
  'FAILED',
  'COMPLETED',
] as const;
export type WorkspaceDeletionStatus = (typeof WorkspaceDeletionStatuses)[number];

export const DeletionCheckpointStepIds = [
  'TERMINATE_ACTIVE_EXPORTS',
  'DETERMINE_RETAINED_EVIDENCE',
  'REMOVE_CUSTOMER_ACCESS',
  'STAGE13_MARK_FILES',
  'DELETE_TENANT_DATA',
  'VERIFY_NO_LIVE_WORKSPACE_DATA',
  'FINALIZE_TOMBSTONE',
] as const;
export type DeletionCheckpointStepId = (typeof DeletionCheckpointStepIds)[number];

export const DeletionCheckpointStates = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'] as const;
export type DeletionCheckpointState = (typeof DeletionCheckpointStates)[number];

export interface RetentionWarningMarkerDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  subscriptionId: ObjectId;
  expiredAt: Date;
  eligibilityAt: Date;
  warningOffsetDays: number;
  status: 'EMITTED';
  outboxEventType?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeletionActorMetadata {
  type: 'PLATFORM' | 'SYSTEM';
  userId?: ObjectId;
  platformMembershipId?: ObjectId;
  reason?: string;
}

export interface DeletionFailureMetadata {
  code: string;
  message: string;
  failedAt: Date;
  retryable: boolean;
}

export interface DeletionCheckpoint {
  stepId: DeletionCheckpointStepId;
  state: DeletionCheckpointState;
  cursorId?: ObjectId;
  affectedCount: number;
  attemptCount: number;
  startedAt?: Date;
  completedAt?: Date;
  lastError?: {
    code: string;
    message: string;
    at: Date;
  };
}

export interface WorkspaceDeletionRequestDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  subscriptionId: ObjectId;
  subscriptionVersionAtEligibility: number;
  eligibilityBasis: {
    expiredAt: Date;
    eligibilityAt: Date;
  };
  status: WorkspaceDeletionStatus;
  createdActor: DeletionActorMetadata;
  createdAt: Date;
  reviewAfter?: Date;
  postponedAt?: Date;
  postponedBy?: DeletionActorMetadata;
  postponeReason?: string;
  approvedAt?: Date;
  approvedBy?: DeletionActorMetadata;
  approvalReason?: string;
  cancelledAt?: Date;
  cancelledBy?: DeletionActorMetadata;
  cancellationReason?: string;
  processingStartedAt?: Date;
  processingClaimedByWorkerId?: string;
  processingLeaseExpiresAt?: Date;
  processingAttemptCount: number;
  failure?: DeletionFailureMetadata;
  checkpoints: DeletionCheckpoint[];
  currentStep?: DeletionCheckpointStepId;
  retainedPaymentProofFileIds: ObjectId[];
  completedAt?: Date;
  liveDataDeletedAt?: Date;
  backupExpiryAt?: Date;
  workspaceSnapshot: {
    name: string;
    type: string;
  };
  version: number;
  updatedAt: Date;
}
