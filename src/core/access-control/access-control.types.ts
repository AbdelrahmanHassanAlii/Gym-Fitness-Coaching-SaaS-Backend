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
