import type { AppConfig } from '../config/config.types';
import { AccessControlService } from '../core/access-control/access-control.service';
import { AuditWriter } from '../core/audit/audit.writer';
import { CredentialDigests } from '../core/auth/credential-digests';
import { JwtService } from '../core/auth/jwt.service';
import { PasswordHasher } from '../core/auth/password-hasher';
import { TotpService } from '../core/auth/totp.service';
import { Database } from '../core/database/database';
import { UnitOfWork } from '../core/database/unit-of-work';
import { OutboxWriter } from '../core/events/outbox.writer';
import { IdempotencyService } from '../core/idempotency/idempotency.service';
import { JobLeaseManager } from '../core/jobs/job-lease.manager';
import {
  AuthChallengeRepository,
  AuthMfaMethodRepository,
  AuthRateLimitRepository,
  AuthSecurityEventWriter,
  AuthSessionRepository,
} from '../modules/auth/auth.repositories';
import { AuthApplicationService } from '../modules/auth/auth.service';
import { MfaService } from '../modules/auth/mfa.service';
import { RefreshTokenService } from '../modules/auth/refresh-token.service';
import { IdentityRepository } from '../modules/identity/identity.repository';
import {
  AccessGrantRepository,
  PermissionDefinitionRepository,
  PermissionProfileRepository,
} from '../modules/permissions/permission.repository';
import { PermissionApplicationService } from '../modules/permissions/permission.service';
import { PlatformMembershipRepository } from '../modules/platform/platform.repository';
import {
  ManualPaymentRepository,
  SubscriptionPlanRepository,
  SubscriptionRepository,
  WorkspaceUsageRepository,
} from '../modules/subscriptions/subscription.repository';
import {
  EntitlementService,
  SubscriptionApplicationService,
} from '../modules/subscriptions/subscription.service';
import {
  BranchRepository,
  InvitationRepository,
  MembershipBranchAssignmentRepository,
  WorkspaceMembershipRepository,
  WorkspaceRepository,
} from '../modules/workspaces/workspace.repository';
import { WorkspaceApplicationService } from '../modules/workspaces/workspace.service';

export interface AppContainer {
  config: AppConfig;
  database: Database;
  unitOfWork: UnitOfWork;
  audit: AuditWriter;
  outbox: OutboxWriter;
  accessControl: AccessControlService;
  idempotency: IdempotencyService;
  jobLeases: JobLeaseManager;
  identity: IdentityRepository;
  authSessions: AuthSessionRepository;
  authChallenges: AuthChallengeRepository;
  authMfaMethods: AuthMfaMethodRepository;
  authRateLimits: AuthRateLimitRepository;
  authSecurityEvents: AuthSecurityEventWriter;
  platformMemberships: PlatformMembershipRepository;
  permissionDefinitions: PermissionDefinitionRepository;
  permissionProfiles: PermissionProfileRepository;
  accessGrants: AccessGrantRepository;
  workspaceRepo: WorkspaceRepository;
  workspaceMemberships: WorkspaceMembershipRepository;
  branches: BranchRepository;
  membershipBranchAssignments: MembershipBranchAssignmentRepository;
  invitations: InvitationRepository;
  subscriptionPlans: SubscriptionPlanRepository;
  subscriptionsRepo: SubscriptionRepository;
  workspaceUsage: WorkspaceUsageRepository;
  manualPayments: ManualPaymentRepository;
  credentialDigests: CredentialDigests;
  passwordHasher: PasswordHasher;
  jwt: JwtService;
  totp: TotpService;
  refreshTokens: RefreshTokenService;
  mfa: MfaService;
  auth: AuthApplicationService;
  workspaces: WorkspaceApplicationService;
  permissions: PermissionApplicationService;
  entitlements: EntitlementService;
  subscriptions: SubscriptionApplicationService;
}

export async function createAppContainer(config: AppConfig): Promise<AppContainer> {
  const database = await Database.connect(config);
  const credentialDigests = new CredentialDigests(config);

  const unitOfWork = new UnitOfWork(database);
  const identity = new IdentityRepository(database);
  const authSessions = new AuthSessionRepository(database);
  const authChallenges = new AuthChallengeRepository(database);
  const authMfaMethods = new AuthMfaMethodRepository(database);
  const authRateLimits = new AuthRateLimitRepository(database);
  const authSecurityEvents = new AuthSecurityEventWriter(database);
  const platformMemberships = new PlatformMembershipRepository(database);
  const permissionDefinitions = new PermissionDefinitionRepository(database);
  const permissionProfiles = new PermissionProfileRepository(database);
  const accessGrants = new AccessGrantRepository(database);
  const workspaceRepo = new WorkspaceRepository(database);
  const workspaceMemberships = new WorkspaceMembershipRepository(database);
  const branches = new BranchRepository(database);
  const membershipBranchAssignments = new MembershipBranchAssignmentRepository(database);
  const invitations = new InvitationRepository(database);
  const passwordHasher = new PasswordHasher();
  const jwt = new JwtService(config);
  const totp = new TotpService(config);
  const refreshTokens = new RefreshTokenService(database, credentialDigests);
  const audit = new AuditWriter(database);
  const outbox = new OutboxWriter(database);
  const idempotency = new IdempotencyService(database);
  const subscriptionPlans = new SubscriptionPlanRepository(database);
  const subscriptionsRepo = new SubscriptionRepository(database);
  const workspaceUsage = new WorkspaceUsageRepository(database);
  const manualPayments = new ManualPaymentRepository(database);
  const accessControl = new AccessControlService(
    platformMemberships,
    workspaceRepo,
    branches,
    workspaceMemberships,
    membershipBranchAssignments,
    permissionProfiles,
    accessGrants,
  );

  return {
    config,
    database,
    unitOfWork,
    audit,
    outbox,
    accessControl,
    idempotency,
    jobLeases: new JobLeaseManager(database),
    identity,
    authSessions,
    authChallenges,
    authMfaMethods,
    authRateLimits,
    authSecurityEvents,
    platformMemberships,
    permissionDefinitions,
    permissionProfiles,
    accessGrants,
    workspaceRepo,
    workspaceMemberships,
    branches,
    membershipBranchAssignments,
    invitations,
    subscriptionPlans,
    subscriptionsRepo,
    workspaceUsage,
    manualPayments,
    credentialDigests,
    passwordHasher,
    jwt,
    totp,
    refreshTokens,
    mfa: new MfaService(unitOfWork, authMfaMethods, authSecurityEvents, credentialDigests),
    auth: new AuthApplicationService(
      config,
      unitOfWork,
      identity,
      authSessions,
      authChallenges,
      authMfaMethods,
      authRateLimits,
      authSecurityEvents,
      passwordHasher,
      credentialDigests,
      jwt,
      totp,
      refreshTokens,
    ),
    workspaces: new WorkspaceApplicationService(
      unitOfWork,
      identity,
      platformMemberships,
      workspaceRepo,
      workspaceMemberships,
      branches,
      membershipBranchAssignments,
      invitations,
      credentialDigests,
      audit,
      outbox,
    ),
    permissions: new PermissionApplicationService(
      unitOfWork,
      permissionDefinitions,
      permissionProfiles,
      accessGrants,
      accessControl,
      platformMemberships,
      workspaceRepo,
      branches,
      workspaceMemberships,
      audit,
      outbox,
    ),
    entitlements: new EntitlementService(subscriptionsRepo, workspaceUsage),
    subscriptions: new SubscriptionApplicationService(
      config,
      unitOfWork,
      subscriptionPlans,
      subscriptionsRepo,
      workspaceUsage,
      manualPayments,
      workspaceRepo,
      workspaceMemberships,
      audit,
      outbox,
    ),
  };
}
