import type { ObjectId } from 'mongodb';

export type SupportTargetType = 'GYM' | 'INDEPENDENT_TRAINER' | 'STAFF' | 'TRAINEE';
export type SupportContextType = 'USER_CONTEXT' | 'WORKSPACE_SUPPORT';
export type SupportSessionType = 'READ_ONLY' | 'WRITE_SUPPORT';
export type SupportAccessDecision = 'APPROVED' | 'DENIED';
export type SupportSessionStatus =
  | 'ACTIVE'
  | 'ENDED'
  | 'EXPIRED'
  | 'REVOKED'
  | 'SECURITY_TERMINATED';

export interface PortalAccessPolicyDocument {
  _id: ObjectId;
  platformMembershipId: ObjectId;
  allowedTargetTypes: SupportTargetType[];
  allowedWorkspaceIds?: ObjectId[];
  allowedIpRanges?: string[];
  allowedSessionTypes: SupportSessionType[];
  maxSessionDurationMinutes: number;
  notificationRequired: boolean;
  allowSensitiveData: boolean;
  allowSensitiveFileDownload: boolean;
  validFrom?: Date;
  validUntil?: Date;
  enabled: boolean;
  revision: number;
  createdBy: ObjectId;
  createdAt: Date;
  updatedBy?: ObjectId;
  updatedAt?: Date;
  archivedAt?: Date;
}

export interface SupportAccessRequestDocument {
  _id: ObjectId;
  requestedByPlatformMembershipId: ObjectId;
  realActorUserId: ObjectId;
  targetType: SupportTargetType;
  targetWorkspaceId?: ObjectId;
  targetUserId?: ObjectId;
  effectiveMembershipId?: ObjectId;
  contextType: SupportContextType;
  requestedSessionType: SupportSessionType;
  requestedDurationMinutes: number;
  requestedSensitiveAccess: boolean;
  requestedSensitiveFileDownload: boolean;
  reason: string;
  reference?: string;
  sourceIp: string;
  matchedPolicyId?: ObjectId;
  policyRevision?: number;
  policySnapshot?: Record<string, unknown>;
  decision: SupportAccessDecision;
  denialReason?: string;
  notificationRequired: boolean;
  createdAt: Date;
}

export interface SupportSessionDocument {
  _id: ObjectId;
  requestId: ObjectId;
  policyId: ObjectId;
  policyRevision: number;
  realActorUserId: ObjectId;
  realActorPlatformMembershipId: ObjectId;
  parentAuthSessionId: ObjectId;
  targetWorkspaceId?: ObjectId;
  targetUserId?: ObjectId;
  effectiveMembershipId?: ObjectId;
  contextType: SupportContextType;
  sessionType: SupportSessionType;
  sourceIp: string;
  reason: string;
  reference?: string;
  notificationRequired: boolean;
  allowSensitiveData: boolean;
  allowSensitiveFileDownload: boolean;
  startedAt: Date;
  expiresAt: Date;
  endedAt?: Date;
  revokedAt?: Date;
  status: SupportSessionStatus;
  terminationReason?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResolvedSupportContext {
  session: SupportSessionDocument;
  policy: PortalAccessPolicyDocument;
}
