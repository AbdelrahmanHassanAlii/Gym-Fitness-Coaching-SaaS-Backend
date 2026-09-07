import type { AppConfig } from '../config/config.types';
import { AuditWriter } from '../core/audit/audit.writer';
import { CredentialDigests } from '../core/auth/credential-digests';
import { JwtService } from '../core/auth/jwt.service';
import { PasswordHasher } from '../core/auth/password-hasher';
import { TotpService } from '../core/auth/totp.service';
import { Database } from '../core/database/database';
import { UnitOfWork } from '../core/database/unit-of-work';
import { OutboxWriter } from '../core/events/outbox.writer';
import { JobLeaseManager } from '../core/jobs/job-lease.manager';
import {
  AuthChallengeRepository,
  AuthMfaMethodRepository,
  AuthRateLimitRepository,
  AuthSecurityEventWriter,
  AuthSessionRepository,
} from '../modules/auth/auth.repositories';
import { MfaService } from '../modules/auth/mfa.service';
import { RefreshTokenService } from '../modules/auth/refresh-token.service';
import { IdentityRepository } from '../modules/identity/identity.repository';

export interface AppContainer {
  config: AppConfig;
  database: Database;
  unitOfWork: UnitOfWork;
  audit: AuditWriter;
  outbox: OutboxWriter;
  jobLeases: JobLeaseManager;
  identity: IdentityRepository;
  authSessions: AuthSessionRepository;
  authChallenges: AuthChallengeRepository;
  authMfaMethods: AuthMfaMethodRepository;
  authRateLimits: AuthRateLimitRepository;
  authSecurityEvents: AuthSecurityEventWriter;
  credentialDigests: CredentialDigests;
  passwordHasher: PasswordHasher;
  jwt: JwtService;
  totp: TotpService;
  refreshTokens: RefreshTokenService;
  mfa: MfaService;
}

export async function createAppContainer(config: AppConfig): Promise<AppContainer> {
  const database = await Database.connect(config);
  const credentialDigests = new CredentialDigests(config);

  return {
    config,
    database,
    unitOfWork: new UnitOfWork(database),
    audit: new AuditWriter(database),
    outbox: new OutboxWriter(database),
    jobLeases: new JobLeaseManager(database),
    identity: new IdentityRepository(database),
    authSessions: new AuthSessionRepository(database),
    authChallenges: new AuthChallengeRepository(database),
    authMfaMethods: new AuthMfaMethodRepository(database),
    authRateLimits: new AuthRateLimitRepository(database),
    authSecurityEvents: new AuthSecurityEventWriter(database),
    credentialDigests,
    passwordHasher: new PasswordHasher(),
    jwt: new JwtService(config),
    totp: new TotpService(config),
    refreshTokens: new RefreshTokenService(database, credentialDigests),
    mfa: new MfaService(
      new UnitOfWork(database),
      new AuthMfaMethodRepository(database),
      new AuthSecurityEventWriter(database),
      credentialDigests,
    ),
  };
}
