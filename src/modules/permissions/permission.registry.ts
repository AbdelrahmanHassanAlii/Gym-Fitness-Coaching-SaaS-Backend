import type { PermissionContext, PermissionEffect, PermissionScopeType } from './permission.types';

export interface PermissionDefinition {
  key: string;
  category: string;
  module: string;
  displayName: string;
  description: string;
  allowedScopes: PermissionScopeType[];
  allowedContexts: PermissionContext[];
  system: boolean;
}

const workspaceScopes: PermissionScopeType[] = [
  'SELF',
  'ASSIGNED_TRAINEES',
  'SPECIFIC_TRAINEES',
  'BRANCH',
  'MULTIPLE_BRANCHES',
  'WORKSPACE',
];

export const Permissions = {
  PlatformMembershipsRead: 'platform_users.read',
  PlatformMembershipsManage: 'platform_users.manage',
  PlatformPermissionsManage: 'platform_permissions.manage',
  PlatformWorkspacesManage: 'platform_workspaces.manage',
  PlansRead: 'plans.read',
  PlansCreate: 'plans.create',
  PlansUpdate: 'plans.update',
  PlansArchive: 'plans.archive',
  PlansVersionsCreate: 'plans.versions.create',
  SubscriptionsRead: 'subscriptions.read',
  SubscriptionsStartTrial: 'subscriptions.start_trial',
  SubscriptionsChangePlan: 'subscriptions.change_plan',
  SubscriptionsChangeTerms: 'subscriptions.change_terms',
  SubscriptionsFreeze: 'subscriptions.freeze',
  SubscriptionsReactivate: 'subscriptions.reactivate',
  SubscriptionsCancel: 'subscriptions.cancel',
  PaymentsRead: 'payments.read',
  PaymentsApprove: 'payments.approve',
  PaymentsReject: 'payments.reject',
  WorkspacesRead: 'workspace.read',
  WorkspacesManage: 'workspace.manage',
  WorkspacesUpdate: 'workspace.update',
  BillingSubscriptionRead: 'billing.subscription.read',
  BillingUsageRead: 'billing.usage.read',
  BillingPaymentsRead: 'billing.payments.read',
  BillingPaymentsCreate: 'billing.payments.create',
  BranchesRead: 'branches.read',
  BranchesManage: 'branches.manage',
  BranchesCreate: 'branches.create',
  BranchesUpdate: 'branches.update',
  BranchesArchive: 'branches.archive',
  StaffRead: 'staff.read',
  StaffManage: 'staff.manage',
  StaffInvite: 'staff.invite',
  StaffInvitesRevoke: 'staff.invites.revoke',
  StaffBranchesManage: 'staff.branches.manage',
  StaffPermissionsManage: 'staff.permissions.manage',
  TraineesRead: 'trainees.read',
  ProgramsRead: 'programs.read',
  ProgramsUpdate: 'programs.update',
  NutritionPlansRead: 'nutrition.plans.read',
  NutritionPlansUpdate: 'nutrition.plans.update',
  DocumentsRead: 'documents.read',
  MedicalDocumentsRead: 'medical_documents.read',
  LeadsRead: 'leads.read',
  LeadsUpdate: 'leads.update',
  LeadsConvert: 'leads.convert',
  LeadsMarkDuplicate: 'leads.mark_duplicate',
  LeadsMerge: 'leads.merge',
  SupportSessionsStart: 'support.sessions.start',
  SystemExercisesRead: 'system_exercises.read',
  SystemExercisesCreate: 'system_exercises.create',
  SystemExercisesUpdate: 'system_exercises.update',
} as const;

export type PermissionKey = (typeof Permissions)[keyof typeof Permissions];

export const permissionDefinitions: PermissionDefinition[] = [
  platform(Permissions.PlatformMembershipsRead, 'Platform users', 'Read Platform memberships.'),
  platform(Permissions.PlatformMembershipsManage, 'Platform users', 'Manage Platform memberships.'),
  platform(
    Permissions.PlatformPermissionsManage,
    'Platform permissions',
    'Manage Platform permission profiles and grants.',
  ),
  platform(
    Permissions.PlatformWorkspacesManage,
    'Platform workspaces',
    'Create and administer workspaces from the Platform context.',
  ),
  platform(Permissions.PlansRead, 'Plans', 'Read subscription plans.'),
  platform(Permissions.PlansCreate, 'Plans', 'Create subscription plans.'),
  platform(Permissions.PlansUpdate, 'Plans', 'Update subscription plan metadata.'),
  platform(Permissions.PlansArchive, 'Plans', 'Archive subscription plans.'),
  platform(Permissions.PlansVersionsCreate, 'Plans', 'Create subscription plan versions.'),
  platform(Permissions.SubscriptionsRead, 'Subscriptions', 'Read workspace subscriptions.'),
  platform(Permissions.SubscriptionsStartTrial, 'Subscriptions', 'Start workspace trials.'),
  platform(Permissions.SubscriptionsChangePlan, 'Subscriptions', 'Change subscription plan terms.'),
  platform(Permissions.SubscriptionsChangeTerms, 'Subscriptions', 'Change subscription terms.'),
  platform(Permissions.SubscriptionsFreeze, 'Subscriptions', 'Freeze workspace subscriptions.'),
  platform(
    Permissions.SubscriptionsReactivate,
    'Subscriptions',
    'Reactivate workspace subscriptions.',
  ),
  platform(Permissions.SubscriptionsCancel, 'Subscriptions', 'Cancel workspace subscriptions.'),
  platform(Permissions.PaymentsRead, 'Payments', 'Read manual payments.'),
  platform(Permissions.PaymentsApprove, 'Payments', 'Approve manual payments.'),
  platform(Permissions.PaymentsReject, 'Payments', 'Reject manual payments.'),
  workspace(Permissions.WorkspacesRead, 'Workspace', 'Read workspace details.'),
  workspace(Permissions.WorkspacesManage, 'Workspace', 'Manage workspace details.'),
  workspace(Permissions.WorkspacesUpdate, 'Workspace', 'Update workspace details.'),
  workspace(Permissions.BillingSubscriptionRead, 'Billing', 'Read workspace subscription state.'),
  workspace(Permissions.BillingUsageRead, 'Billing', 'Read workspace subscription usage.'),
  workspace(Permissions.BillingPaymentsRead, 'Billing', 'Read workspace manual payments.'),
  workspace(Permissions.BillingPaymentsCreate, 'Billing', 'Create workspace manual payments.'),
  workspace(Permissions.BranchesRead, 'Branches', 'Read branches.'),
  workspace(Permissions.BranchesManage, 'Branches', 'Manage branches.'),
  workspace(Permissions.BranchesCreate, 'Branches', 'Create branches.'),
  workspace(Permissions.BranchesUpdate, 'Branches', 'Update branches.'),
  workspace(Permissions.BranchesArchive, 'Branches', 'Archive branches.'),
  workspace(Permissions.StaffRead, 'Staff', 'Read staff memberships.'),
  workspace(Permissions.StaffManage, 'Staff', 'Manage staff memberships.'),
  workspace(Permissions.StaffInvite, 'Staff', 'Invite staff memberships.'),
  workspace(Permissions.StaffInvitesRevoke, 'Staff', 'Revoke staff invitations.'),
  workspace(Permissions.StaffBranchesManage, 'Staff branches', 'Manage staff branch assignments.'),
  workspace(
    Permissions.StaffPermissionsManage,
    'Staff permissions',
    'Manage workspace permission profiles and grants.',
  ),
  workspace(Permissions.TraineesRead, 'Trainees', 'Read trainees.'),
  workspace(Permissions.ProgramsRead, 'Programs', 'Read training programs.'),
  workspace(Permissions.ProgramsUpdate, 'Programs', 'Update training programs.'),
  workspace(Permissions.NutritionPlansRead, 'Nutrition', 'Read nutrition plans.'),
  workspace(Permissions.NutritionPlansUpdate, 'Nutrition', 'Update nutrition plans.'),
  workspace(Permissions.DocumentsRead, 'Documents', 'Read documents.'),
  workspace(Permissions.MedicalDocumentsRead, 'Medical documents', 'Read medical documents.'),
  platform(Permissions.LeadsRead, 'Leads', 'Read platform leads.'),
  platform(Permissions.LeadsUpdate, 'Leads', 'Update platform leads.'),
  platform(Permissions.LeadsConvert, 'Leads', 'Convert leads into workspaces.'),
  platform(Permissions.LeadsMarkDuplicate, 'Leads', 'Mark duplicate leads.'),
  platform(Permissions.LeadsMerge, 'Leads', 'Merge duplicate leads.'),
  platform(Permissions.SupportSessionsStart, 'Support', 'Start support sessions.'),
  platform(Permissions.SystemExercisesRead, 'System exercises', 'Read system exercises.'),
  platform(Permissions.SystemExercisesCreate, 'System exercises', 'Create system exercises.'),
  platform(Permissions.SystemExercisesUpdate, 'System exercises', 'Update system exercises.'),
];

export const permissionKeys = new Set(permissionDefinitions.map((definition) => definition.key));

export interface SystemPermissionProfileSeed {
  context: PermissionContext;
  name: string;
  roleKey: string;
  permissions: Array<{ permission: PermissionKey; effect: PermissionEffect }>;
}

export const systemPermissionProfiles: SystemPermissionProfileSeed[] = [
  {
    context: 'PLATFORM',
    name: 'Platform Super Admin',
    roleKey: 'PLATFORM_SUPER_ADMIN',
    permissions: permissionDefinitions
      .filter((definition) => definition.allowedContexts.includes('PLATFORM'))
      .map((definition) => ({ permission: definition.key as PermissionKey, effect: 'ALLOW' })),
  },
  {
    context: 'PLATFORM',
    name: 'Sales/Lead Admin',
    roleKey: 'SALES_LEAD_ADMIN',
    permissions: [
      Permissions.LeadsRead,
      Permissions.LeadsUpdate,
      Permissions.LeadsConvert,
      Permissions.LeadsMarkDuplicate,
      Permissions.LeadsMerge,
    ].map((permission) => ({ permission, effect: 'ALLOW' })),
  },
  {
    context: 'PLATFORM',
    name: 'Subscription Admin',
    roleKey: 'SUBSCRIPTION_ADMIN',
    permissions: [
      Permissions.PlansRead,
      Permissions.PlansCreate,
      Permissions.PlansUpdate,
      Permissions.PlansArchive,
      Permissions.PlansVersionsCreate,
      Permissions.SubscriptionsRead,
      Permissions.SubscriptionsStartTrial,
      Permissions.SubscriptionsChangePlan,
      Permissions.SubscriptionsChangeTerms,
      Permissions.SubscriptionsFreeze,
      Permissions.SubscriptionsReactivate,
      Permissions.SubscriptionsCancel,
      Permissions.PaymentsRead,
      Permissions.PaymentsApprove,
      Permissions.PaymentsReject,
    ].map((permission) => ({ permission, effect: 'ALLOW' })),
  },
  {
    context: 'WORKSPACE',
    name: 'Gym Owner',
    roleKey: 'GYM_OWNER',
    permissions: [
      Permissions.WorkspacesRead,
      Permissions.WorkspacesManage,
      Permissions.WorkspacesUpdate,
      Permissions.BillingSubscriptionRead,
      Permissions.BillingUsageRead,
      Permissions.BillingPaymentsRead,
      Permissions.BillingPaymentsCreate,
      Permissions.BranchesRead,
      Permissions.BranchesManage,
      Permissions.BranchesCreate,
      Permissions.BranchesUpdate,
      Permissions.BranchesArchive,
      Permissions.StaffRead,
      Permissions.StaffManage,
      Permissions.StaffInvite,
      Permissions.StaffInvitesRevoke,
      Permissions.StaffBranchesManage,
      Permissions.StaffPermissionsManage,
      Permissions.TraineesRead,
      Permissions.ProgramsRead,
      Permissions.ProgramsUpdate,
      Permissions.NutritionPlansRead,
      Permissions.NutritionPlansUpdate,
      Permissions.DocumentsRead,
    ].map((permission) => ({ permission, effect: 'ALLOW' })),
  },
  {
    context: 'WORKSPACE',
    name: 'Trainer',
    roleKey: 'TRAINER',
    permissions: [
      Permissions.TraineesRead,
      Permissions.ProgramsRead,
      Permissions.ProgramsUpdate,
      Permissions.NutritionPlansRead,
      Permissions.NutritionPlansUpdate,
      Permissions.DocumentsRead,
    ].map((permission) => ({ permission, effect: 'ALLOW' })),
  },
  {
    context: 'WORKSPACE',
    name: 'Assistant Trainer',
    roleKey: 'ASSISTANT_TRAINER',
    permissions: [
      Permissions.TraineesRead,
      Permissions.ProgramsRead,
      Permissions.DocumentsRead,
    ].map((permission) => ({ permission, effect: 'ALLOW' })),
  },
  {
    context: 'WORKSPACE',
    name: 'Nutritionist',
    roleKey: 'NUTRITIONIST',
    permissions: [
      Permissions.TraineesRead,
      Permissions.NutritionPlansRead,
      Permissions.NutritionPlansUpdate,
    ].map((permission) => ({ permission, effect: 'ALLOW' })),
  },
];

function platform(
  key: PermissionKey,
  displayName: string,
  description: string,
): PermissionDefinition {
  return {
    key,
    category: key.split('.')[0] ?? key,
    module: 'platform',
    displayName,
    description,
    allowedScopes: ['WORKSPACE'],
    allowedContexts: ['PLATFORM'],
    system: true,
  };
}

function workspace(
  key: PermissionKey,
  displayName: string,
  description: string,
): PermissionDefinition {
  return {
    key,
    category: key.split('.')[0] ?? key,
    module: 'workspace',
    displayName,
    description,
    allowedScopes: workspaceScopes,
    allowedContexts: ['WORKSPACE'],
    system: true,
  };
}
