import type { ObjectId } from 'mongodb';

export const PermissionContexts = ['PLATFORM', 'WORKSPACE'] as const;
export type PermissionContext = (typeof PermissionContexts)[number];

export const PermissionEffects = ['ALLOW', 'DENY'] as const;
export type PermissionEffect = (typeof PermissionEffects)[number];

export const PermissionScopeTypes = [
  'SELF',
  'ASSIGNED_TRAINEES',
  'SPECIFIC_TRAINEES',
  'BRANCH',
  'MULTIPLE_BRANCHES',
  'WORKSPACE',
] as const;
export type PermissionScopeType = (typeof PermissionScopeTypes)[number];

export const PermissionDefinitionStates = ['ACTIVE', 'DEPRECATED'] as const;
export type PermissionDefinitionState = (typeof PermissionDefinitionStates)[number];

export const PermissionProfileStatuses = ['ACTIVE', 'ARCHIVED'] as const;
export type PermissionProfileStatus = (typeof PermissionProfileStatuses)[number];

export const AccessGrantSubjectTypes = ['PLATFORM_MEMBERSHIP', 'WORKSPACE_MEMBERSHIP'] as const;
export type AccessGrantSubjectType = (typeof AccessGrantSubjectTypes)[number];

export interface PermissionScope {
  type: PermissionScopeType;
  resourceIds?: ObjectId[];
}

export interface PermissionDefinitionDocument {
  _id: ObjectId;
  key: string;
  category: string;
  module: string;
  displayName: string;
  description: string;
  allowedScopes: PermissionScopeType[];
  allowedContexts: PermissionContext[];
  system: boolean;
  state: PermissionDefinitionState;
  createdAt: Date;
  updatedAt: Date;
  deprecatedAt?: Date;
}

export interface PermissionProfileEntry {
  permission: string;
  effect: PermissionEffect;
}

export interface PermissionProfileDocument {
  _id: ObjectId;
  context: PermissionContext;
  workspaceId?: ObjectId;
  name: string;
  roleKey?: string;
  permissions: PermissionProfileEntry[];
  isSystemDefault: boolean;
  status: PermissionProfileStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
}

export interface AccessGrantDocument {
  _id: ObjectId;
  context: PermissionContext;
  workspaceId?: ObjectId;
  subjectType: AccessGrantSubjectType;
  subjectId: ObjectId;
  permission: string;
  effect: PermissionEffect;
  scope: PermissionScope;
  createdBy: ObjectId;
  createdAt: Date;
  expiresAt?: Date;
}
