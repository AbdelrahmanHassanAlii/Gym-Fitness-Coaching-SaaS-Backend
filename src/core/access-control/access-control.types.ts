import type { ObjectId } from 'mongodb';
import type {
  PermissionContext,
  PermissionScope,
  PermissionScopeType,
} from '../../modules/permissions/permission.types';

export interface AuthorizationRequirement {
  context: PermissionContext;
  permission: string;
  scope?: {
    type: PermissionScopeType;
    resourceIdParam?: string;
    requiresAssignment?: boolean;
  };
  mfaRequired?: boolean;
}

export interface AuthorizationRequest {
  context: PermissionContext;
  permission: string;
  workspaceId?: ObjectId;
  scope?: PermissionScope;
  mfaSatisfied?: boolean;
}

export interface AuthorizationDecision {
  allowed: boolean;
  permission: string;
  context: PermissionContext;
  scope?: PermissionScope;
  source: 'EXPLICIT_GRANT' | 'PROFILE' | 'NONE';
  effect: 'ALLOW' | 'DENY';
  reasons: string[];
}

export interface WorkspaceQueryAccessRequest {
  permission: string;
  workspaceId: ObjectId;
  relationshipId?: ObjectId;
  branchId?: ObjectId;
  mfaSatisfied?: boolean;
  maxSpecificTrainees?: number;
  maxBranches?: number;
}

export interface WorkspaceQueryAccess {
  allowed: boolean;
  permission: string;
  workspaceId: ObjectId;
  membershipId: ObjectId;
  userId: ObjectId;
  roles: string[];
  workspaceAllowed: boolean;
  assignedTrainees: boolean;
  self: boolean;
  includeBranchIds: ObjectId[];
  excludeBranchIds: ObjectId[];
  includeRelationshipIds: ObjectId[];
  excludeRelationshipIds: ObjectId[];
  requestedBranchId?: ObjectId;
  requestedRelationshipId?: ObjectId;
  pureWorkspaceWide: boolean;
  reasons: string[];
}
