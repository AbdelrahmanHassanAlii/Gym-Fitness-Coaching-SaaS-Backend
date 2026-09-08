import type { ObjectId } from 'mongodb';

export const WorkspaceTypes = ['GYM', 'INDEPENDENT_TRAINER'] as const;
export type WorkspaceType = (typeof WorkspaceTypes)[number];

export const WorkspaceStatuses = [
  'PENDING_ACTIVATION',
  'ACTIVE',
  'RESTRICTED',
  'SUSPENDED',
  'ARCHIVED',
] as const;
export type WorkspaceStatus = (typeof WorkspaceStatuses)[number];

export const WorkspaceMembershipRoles = [
  'GYM_OWNER',
  'GYM_MANAGER',
  'TRAINER',
  'ASSISTANT_TRAINER',
  'NUTRITIONIST',
  'TRAINEE',
] as const;
export type WorkspaceMembershipRole = (typeof WorkspaceMembershipRoles)[number];

export const WorkspaceMembershipStatuses = [
  'INVITED',
  'ACTIVE',
  'SUSPENDED',
  'ENDED',
  'ARCHIVED',
] as const;
export type WorkspaceMembershipStatus = (typeof WorkspaceMembershipStatuses)[number];

export const BranchStatuses = ['ACTIVE', 'ARCHIVED'] as const;
export type BranchStatus = (typeof BranchStatuses)[number];

export const InvitationTypes = [
  'OWNER_ACTIVATION',
  'STAFF_INVITATION',
  'TRAINEE_INVITATION',
] as const;
export type InvitationType = (typeof InvitationTypes)[number];

export const InvitationStatuses = [
  'PENDING',
  'ACCEPTED',
  'EXPIRED',
  'REVOKED',
  'SUPERSEDED',
] as const;
export type InvitationStatus = (typeof InvitationStatuses)[number];

export interface WorkspaceDocument {
  _id: ObjectId;
  type: WorkspaceType;
  name: string;
  ownerUserId: ObjectId;
  status: WorkspaceStatus;
  timezone: string;
  defaultLanguage: 'ar' | 'en';
  country?: string;
  city?: string;
  governorate?: string;
  createdFromLeadId?: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceMembershipDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  userId: ObjectId;
  roles: WorkspaceMembershipRole[];
  status: WorkspaceMembershipStatus;
  joinedAt: Date;
  endedAt?: Date;
  engagementPeriods: Array<{ startedAt: Date; endedAt?: Date }>;
  permissionProfileIds: ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

export interface BranchDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  name: string;
  code?: string;
  address?: string;
  city?: string;
  governorate?: string;
  timezone: string;
  status: BranchStatus;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
}

export interface MembershipBranchAssignmentDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  membershipId: ObjectId;
  branchId: ObjectId;
  active: boolean;
  startedAt: Date;
  endedAt?: Date;
  createdAt: Date;
}

export interface InvitationDocument {
  _id: ObjectId;
  workspaceId?: ObjectId;
  type: InvitationType;
  email?: string;
  normalizedEmail?: string;
  phone?: string;
  normalizedPhone?: string;
  intendedRoles: WorkspaceMembershipRole[];
  branchIds: ObjectId[];
  invitedBy: ObjectId;
  tokenDigest: string;
  expiresAt: Date;
  status: InvitationStatus;
  acceptedByUserId?: ObjectId;
  acceptedAt?: Date;
  revokedAt?: Date;
  supersededAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
