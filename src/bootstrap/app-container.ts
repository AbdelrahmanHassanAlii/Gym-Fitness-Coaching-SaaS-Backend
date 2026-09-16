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
import { type EmailProvider, LoggingEmailProvider } from '../core/messaging/email.provider';
import { LoggingPushProvider, type PushProvider } from '../core/messaging/push.provider';
import { S3CompatibleStorageProvider } from '../core/storage/s3-storage.provider';
import type { StorageProvider } from '../core/storage/storage.provider';
import { AuditRepository } from '../modules/audit/audit.repository';
import { AuditApplicationService } from '../modules/audit/audit.service';
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
import { CheckInRepository } from '../modules/checkins/checkin.repository';
import { CheckInApplicationService } from '../modules/checkins/checkin.service';
import { FileRepository } from '../modules/files/file.repository';
import { FileApplicationService } from '../modules/files/file.service';
import { IdentityRepository } from '../modules/identity/identity.repository';
import { LeadRepository } from '../modules/leads/lead.repository';
import { LeadApplicationService } from '../modules/leads/lead.service';
import { NotificationRepository } from '../modules/notifications/notification.repository';
import { NotificationApplicationService } from '../modules/notifications/notification.service';
import { NutritionRepository } from '../modules/nutrition/nutrition.repository';
import { NutritionApplicationService } from '../modules/nutrition/nutrition.service';
import {
  AccessGrantRepository,
  PermissionDefinitionRepository,
  PermissionProfileRepository,
} from '../modules/permissions/permission.repository';
import { PermissionApplicationService } from '../modules/permissions/permission.service';
import { PlatformMembershipRepository } from '../modules/platform/platform.repository';
import { ProgressRepository } from '../modules/progress/progress.repository';
import { ProgressApplicationService } from '../modules/progress/progress.service';
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
import { CoachingRelationshipRepository } from '../modules/trainees/trainee.repository';
import { TraineeApplicationService } from '../modules/trainees/trainee.service';
import { TrainingRepository } from '../modules/training/training.repository';
import { TrainingApplicationService } from '../modules/training/training.service';
import { WorkoutRepository } from '../modules/workouts/workout.repository';
import { WorkoutApplicationService } from '../modules/workouts/workout.service';
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
  storage: StorageProvider;
  emailProvider: EmailProvider;
  pushProvider: PushProvider;
  identity: IdentityRepository;
  authSessions: AuthSessionRepository;
  authChallenges: AuthChallengeRepository;
  authMfaMethods: AuthMfaMethodRepository;
  authRateLimits: AuthRateLimitRepository;
  authSecurityEvents: AuthSecurityEventWriter;
  auditRepo: AuditRepository;
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
  leadsRepo: LeadRepository;
  nutritionRepo: NutritionRepository;
  progressRepo: ProgressRepository;
  checkInRepo: CheckInRepository;
  filesRepo: FileRepository;
  notificationsRepo: NotificationRepository;
  coachingRelationships: CoachingRelationshipRepository;
  trainingRepo: TrainingRepository;
  workoutsRepo: WorkoutRepository;
  credentialDigests: CredentialDigests;
  passwordHasher: PasswordHasher;
  jwt: JwtService;
  totp: TotpService;
  refreshTokens: RefreshTokenService;
  mfa: MfaService;
  auth: AuthApplicationService;
  auditService: AuditApplicationService;
  workspaces: WorkspaceApplicationService;
  permissions: PermissionApplicationService;
  entitlements: EntitlementService;
  subscriptions: SubscriptionApplicationService;
  leads: LeadApplicationService;
  nutrition: NutritionApplicationService;
  progress: ProgressApplicationService;
  checkins: CheckInApplicationService;
  files: FileApplicationService;
  notifications: NotificationApplicationService;
  trainees: TraineeApplicationService;
  training: TrainingApplicationService;
  workouts: WorkoutApplicationService;
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
  const auditRepo = new AuditRepository(database);
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
  const leadsRepo = new LeadRepository(database);
  const nutritionRepo = new NutritionRepository(database);
  const progressRepo = new ProgressRepository(database);
  const checkInRepo = new CheckInRepository(database);
  const filesRepo = new FileRepository(database);
  const notificationsRepo = new NotificationRepository(database);
  const coachingRelationships = new CoachingRelationshipRepository(database);
  const trainingRepo = new TrainingRepository(database);
  const workoutsRepo = new WorkoutRepository(database);
  const accessControl = new AccessControlService(
    platformMemberships,
    workspaceRepo,
    branches,
    workspaceMemberships,
    membershipBranchAssignments,
    permissionProfiles,
    accessGrants,
  );
  const storageConfig = config.storage ?? {
    provider: 's3' as const,
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    privateBucket: 'gym-private',
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
  };
  const storage = new S3CompatibleStorageProvider({
    endpoint: storageConfig.endpoint,
    region: storageConfig.region,
    bucket: storageConfig.privateBucket,
    accessKey: storageConfig.accessKey,
    secretKey: storageConfig.secretKey,
  });
  const emailProvider = new LoggingEmailProvider();
  const pushProvider = new LoggingPushProvider();

  const entitlements = new EntitlementService(subscriptionsRepo, workspaceUsage);
  const subscriptions = new SubscriptionApplicationService(
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
    coachingRelationships,
  );
  const workspaces = new WorkspaceApplicationService(
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
    entitlements,
    subscriptions,
  );
  const auth = new AuthApplicationService(
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
  );
  const leads = new LeadApplicationService(
    unitOfWork,
    leadsRepo,
    identity,
    workspaceRepo,
    workspaceMemberships,
    invitations,
    permissionProfiles,
    workspaces,
    subscriptions,
    accessControl,
    auth,
    credentialDigests,
    passwordHasher,
    audit,
    outbox,
  );
  const training = new TrainingApplicationService(
    unitOfWork,
    trainingRepo,
    coachingRelationships,
    workspaceMemberships,
    accessControl,
    entitlements,
    audit,
    outbox,
  );
  const workouts = new WorkoutApplicationService(
    unitOfWork,
    workoutsRepo,
    trainingRepo,
    coachingRelationships,
    workspaceMemberships,
    accessControl,
    entitlements,
    audit,
    outbox,
  );
  training.setWorkoutLifecyclePort(workouts);
  const nutrition = new NutritionApplicationService(
    unitOfWork,
    nutritionRepo,
    coachingRelationships,
    workspaceMemberships,
    accessControl,
    entitlements,
    audit,
    outbox,
  );
  const progress = new ProgressApplicationService(
    unitOfWork,
    progressRepo,
    coachingRelationships,
    workspaceRepo,
    workspaceMemberships,
    accessControl,
    entitlements,
    audit,
    outbox,
  );
  const checkins = new CheckInApplicationService(
    unitOfWork,
    checkInRepo,
    coachingRelationships,
    workspaceMemberships,
    accessControl,
    entitlements,
    audit,
    outbox,
  );
  const files = new FileApplicationService(
    unitOfWork,
    filesRepo,
    coachingRelationships,
    workspaceMemberships,
    accessControl,
    entitlements,
    workspaceUsage,
    storage,
    audit,
    outbox,
  );
  const notifications = new NotificationApplicationService(
    config,
    database,
    unitOfWork,
    notificationsRepo,
    identity,
    workspaceRepo,
    workspaceMemberships,
    coachingRelationships,
    checkInRepo,
    audit,
    emailProvider,
    pushProvider,
  );
  const trainees = new TraineeApplicationService(
    unitOfWork,
    coachingRelationships,
    identity,
    workspaceRepo,
    workspaceMemberships,
    branches,
    membershipBranchAssignments,
    invitations,
    permissionProfiles,
    accessControl,
    entitlements,
    workspaceUsage,
    credentialDigests,
    audit,
    outbox,
    training,
    nutrition,
    checkins,
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
    storage,
    emailProvider,
    pushProvider,
    identity,
    authSessions,
    authChallenges,
    authMfaMethods,
    authRateLimits,
    authSecurityEvents,
    auditRepo,
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
    leadsRepo,
    nutritionRepo,
    progressRepo,
    checkInRepo,
    filesRepo,
    notificationsRepo,
    coachingRelationships,
    trainingRepo,
    workoutsRepo,
    credentialDigests,
    passwordHasher,
    jwt,
    totp,
    refreshTokens,
    mfa: new MfaService(unitOfWork, authMfaMethods, authSecurityEvents, credentialDigests),
    auth,
    auditService: new AuditApplicationService(auditRepo, accessControl),
    workspaces,
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
    entitlements,
    subscriptions,
    leads,
    nutrition,
    progress,
    checkins,
    files,
    notifications,
    trainees,
    training,
    workouts,
  };
}
