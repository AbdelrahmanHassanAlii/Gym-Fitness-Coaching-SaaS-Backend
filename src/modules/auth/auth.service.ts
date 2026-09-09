import { randomBytes, randomInt } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { AppConfig } from '../../config/config.types';
import type {
  AuthClientType,
  AuthenticationMethod,
  RefreshTokenTransport,
} from '../../core/auth/auth.types';
import type { CredentialDigests } from '../../core/auth/credential-digests';
import type { JwtService } from '../../core/auth/jwt.service';
import type { PasswordHasher } from '../../core/auth/password-hasher';
import { normalizePhoneToE164 } from '../../core/auth/phone-normalizer';
import type { TotpService } from '../../core/auth/totp.service';
import type { TransactionContext, UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { RequestContext } from '../../core/request-context/request-context';
import type { IdentityRepository } from '../identity/identity.repository';
import type { UserDocument } from '../identity/identity.types';
import { normalizeEmail, normalizeLoginIdentifier } from './auth.normalization';
import type {
  AuthChallengeRepository,
  AuthMfaMethodRepository,
  AuthRateLimitRepository,
  AuthSecurityEventWriter,
  AuthSessionRepository,
} from './auth.repositories';
import type {
  AuthChallengeDocument,
  AuthMfaMethodDocument,
  AuthSessionDocument,
} from './auth.types';
import type { RefreshTokenService } from './refresh-token.service';

export interface AuthRequestMetadata {
  ipAddress: string;
  userAgent?: string;
}

export interface SafeAuthUser {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  emailVerified: boolean;
  phoneVerified: boolean;
}

export interface AuthTokensResult {
  accessToken: string;
  refreshToken?: string;
  user: SafeAuthUser;
  restrictedUntilVerified: boolean;
  debugChallenges?: Array<{ purpose: string; challengeId: string; code: string }>;
}

export interface MfaRequiredResult {
  status: 'MFA_REQUIRED';
  mfaChallengeToken: string;
  availableMethods: Array<'TOTP' | 'RECOVERY_CODE'>;
}

export type AuthLoginResult = AuthTokensResult | MfaRequiredResult;

export type AuthTokensResultWithTransport = AuthTokensResult & { clientType: AuthClientType };

export interface GenericSuccess {
  success: true;
}

export class AuthApplicationService {
  constructor(
    private readonly config: AppConfig,
    private readonly unitOfWork: UnitOfWork,
    private readonly identity: IdentityRepository,
    private readonly sessions: AuthSessionRepository,
    private readonly challenges: AuthChallengeRepository,
    private readonly mfaMethods: AuthMfaMethodRepository,
    private readonly rateLimits: AuthRateLimitRepository,
    private readonly securityEvents: AuthSecurityEventWriter,
    private readonly passwordHasher: PasswordHasher,
    private readonly credentialDigests: CredentialDigests,
    private readonly jwt: JwtService,
    private readonly totp: TotpService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  async register(input: {
    email?: string;
    phone?: string;
    password: string;
    firstName: string;
    lastName: string;
    preferredLanguage: string;
    clientType: AuthClientType;
    metadata: AuthRequestMetadata;
  }): Promise<AuthTokensResult> {
    const identifiers = this.normalizeRegistrationIdentifiers(input.email, input.phone);
    const passwordHash = await this.passwordHasher.hash(input.password);
    const now = new Date();
    const expiresAt = this.refreshExpiresAt(now);
    const debugChallenges: AuthTokensResult['debugChallenges'] = [];

    return await this.unitOfWork.withTransaction(async (tx) => {
      const user = await this.identity.create(
        {
          ...identifiers,
          passwordHash,
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          preferredLanguage: input.preferredLanguage,
          timezone: 'Africa/Cairo',
          now,
        },
        tx,
      );

      if (identifiers.normalizedEmail) {
        debugChallenges.push(
          await this.createVerificationChallenge(
            'EMAIL_VERIFICATION',
            user._id,
            { normalizedEmail: identifiers.normalizedEmail },
            input.metadata,
            tx,
          ),
        );
      }

      if (identifiers.normalizedPhone) {
        debugChallenges.push(
          await this.createVerificationChallenge(
            'PHONE_VERIFICATION',
            user._id,
            { normalizedPhone: identifiers.normalizedPhone },
            input.metadata,
            tx,
          ),
        );
      }

      const transport = refreshTransportForClient(input.clientType);
      const session = await this.sessions.create(
        {
          userId: user._id,
          clientType: input.clientType,
          transport,
          authenticationMethods: ['pwd'],
          restrictedUntilVerified: true,
          expiresAt,
          ipAddress: input.metadata.ipAddress,
          ...(input.metadata.userAgent ? { userAgent: input.metadata.userAgent } : {}),
        },
        tx,
      );
      const refreshToken = await this.refreshTokens.issue({
        userId: user._id,
        sessionId: session._id,
        expiresAt,
        tx,
      });

      await this.securityEvents.write(
        {
          type: 'USER_REGISTERED',
          userId: user._id,
          sessionId: session._id,
          result: 'SUCCESS',
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
          clientType: input.clientType,
        },
        tx,
      );
      await this.securityEvents.write(
        {
          type: 'AUTH_SESSION_CREATED',
          userId: user._id,
          sessionId: session._id,
          result: 'SUCCESS',
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
          clientType: input.clientType,
        },
        tx,
      );

      return this.tokensResponse(user, session._id, true, input.clientType, refreshToken.rawToken, {
        debugChallenges,
      });
    });
  }

  async login(input: {
    identifier: string;
    password: string;
    clientType: AuthClientType;
    metadata: AuthRequestMetadata;
  }): Promise<AuthLoginResult> {
    const identifier = this.normalizeLoginIdentifierForPublicFlow(input.identifier);
    const now = new Date();

    await this.enforcePublicIpLimit('LOGIN_IP', input.metadata.ipAddress);

    const user = identifier ? await this.identity.findByLoginIdentifier(identifier) : null;
    const authenticatable = user?.status === 'ACTIVE' && Boolean(user.passwordHash);
    const passwordMatches = authenticatable
      ? await this.passwordHasher.verify(input.password, user.passwordHash)
      : false;

    if (!user || !passwordMatches || user.status !== 'ACTIVE') {
      if (identifier) {
        await this.enforcePublicIpLimit(
          'LOGIN_IDENTIFIER_IP',
          `${identifier.rateLimitKey}|ip:${input.metadata.ipAddress}`,
        );
      }
      await this.securityEvents.write({
        type: 'LOGIN_FAILED',
        ...(user ? { userId: user._id } : {}),
        result: 'FAILURE',
        reasonCode: 'INVALID_CREDENTIALS',
        ipAddress: input.metadata.ipAddress,
        userAgent: input.metadata.userAgent,
        clientType: input.clientType,
      });
      throw invalidCredentials();
    }

    const restrictedUntilVerified = !hasVerifiedIdentifier(user);
    const activeMfa = await this.mfaMethods.findActiveTotp(user._id);
    if (activeMfa) {
      return await this.createMfaLoginChallenge({
        userId: user._id,
        clientType: input.clientType,
        metadata: input.metadata,
      });
    }

    const expiresAt = this.refreshExpiresAt(now);
    const transport = refreshTransportForClient(input.clientType);

    return await this.unitOfWork.withTransaction(async (tx) => {
      const session = await this.sessions.create(
        {
          userId: user._id,
          clientType: input.clientType,
          transport,
          authenticationMethods: ['pwd'],
          restrictedUntilVerified,
          expiresAt,
          ipAddress: input.metadata.ipAddress,
          ...(input.metadata.userAgent ? { userAgent: input.metadata.userAgent } : {}),
          now,
        },
        tx,
      );
      const refreshToken = await this.refreshTokens.issue({
        userId: user._id,
        sessionId: session._id,
        expiresAt,
        tx,
      });
      await this.securityEvents.write(
        {
          type: 'LOGIN_SUCCEEDED',
          userId: user._id,
          sessionId: session._id,
          result: 'SUCCESS',
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
          clientType: input.clientType,
        },
        tx,
      );
      await this.securityEvents.write(
        {
          type: 'AUTH_SESSION_CREATED',
          userId: user._id,
          sessionId: session._id,
          result: 'SUCCESS',
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
          clientType: input.clientType,
        },
        tx,
      );

      return this.tokensResponse(
        user,
        session._id,
        restrictedUntilVerified,
        input.clientType,
        refreshToken.rawToken,
      );
    });
  }

  async refresh(input: {
    refreshToken: string;
    clientType: AuthClientType;
  }): Promise<Pick<AuthTokensResult, 'accessToken' | 'refreshToken' | 'restrictedUntilVerified'>> {
    const rotated = await this.refreshTokens.rotate(input.refreshToken, this.refreshExpiresAt());
    if (!rotated.session) {
      throw new AppError({
        code: 'REFRESH_TOKEN_INVALID',
        httpStatus: 401,
        message: 'The refresh token is invalid.',
      });
    }

    const accessToken = this.jwt.createAccessToken({
      userId: rotated.session.userId.toHexString(),
      authSessionId: rotated.session._id.toHexString(),
      authenticationMethods: rotated.session.authenticationMethods,
    });

    return {
      accessToken,
      restrictedUntilVerified: rotated.session.restrictedUntilVerified,
      refreshToken: rotated.rawToken,
    };
  }

  async completeMfaLogin(input: {
    mfaChallengeToken: string;
    factorType: 'TOTP' | 'RECOVERY_CODE';
    credential: string;
    metadata: AuthRequestMetadata;
  }): Promise<AuthTokensResultWithTransport> {
    const now = new Date();
    const challengeDigest = this.credentialDigests.hashHighEntropySecret(input.mfaChallengeToken);
    const challenge = await this.challenges.incrementAttemptByDigest(
      'MFA_LOGIN',
      challengeDigest,
      now,
    );
    if (!challenge.userId || !challenge.clientType) throw invalidMfaChallenge();

    const mfaMethod = await this.mfaMethods.findActiveTotp(challenge.userId);
    if (!mfaMethod) throw mfaNotConfigured();

    const authenticationMethod = await this.verifyMfaFactor({
      userId: challenge.userId,
      mfaMethod,
      factorType: input.factorType,
      credential: input.credential,
      metadata: input.metadata,
    });

    return await this.unitOfWork.withTransaction(async (tx) => {
      if (input.factorType === 'RECOVERY_CODE') {
        const consumed = await this.mfaMethods.consumeRecoveryCode(
          mfaMethod._id,
          this.credentialDigests.hashHighEntropySecret(input.credential),
          now,
          tx,
        );
        if (!consumed) {
          await this.securityEvents.write(
            {
              type: 'MFA_VERIFICATION_FAILED',
              userId: challenge.userId,
              result: 'FAILURE',
              reasonCode: 'RECOVERY_CODE_INVALID',
              ipAddress: input.metadata.ipAddress,
              userAgent: input.metadata.userAgent,
              clientType: challenge.clientType,
            },
            tx,
          );
          throw invalidMfaCode();
        }
      }

      const consumedChallenge = await this.challenges.consumeVerifiedChallenge(
        challenge._id,
        'MFA_LOGIN',
        now,
        tx,
      );
      if (!consumedChallenge?.userId || !consumedChallenge.clientType) {
        throw invalidMfaChallenge();
      }

      const user = await this.identity.findById(consumedChallenge.userId, tx);
      if (user?.status !== 'ACTIVE') throw invalidMfaChallenge();

      const result = await this.createAuthenticatedSession(
        user,
        consumedChallenge.clientType,
        ['pwd', authenticationMethod],
        !hasVerifiedIdentifier(user),
        input.metadata,
        now,
        tx,
      );

      await this.securityEvents.write(
        {
          type: 'MFA_VERIFICATION_SUCCEEDED',
          userId: user._id,
          sessionId: result.sessionId,
          result: 'SUCCESS',
          reasonCode: input.factorType,
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
          clientType: consumedChallenge.clientType,
        },
        tx,
      );
      if (input.factorType === 'RECOVERY_CODE') {
        await this.securityEvents.write(
          {
            type: 'MFA_RECOVERY_CODE_USED',
            userId: user._id,
            sessionId: result.sessionId,
            result: 'SUCCESS',
            ipAddress: input.metadata.ipAddress,
            userAgent: input.metadata.userAgent,
            clientType: consumedChallenge.clientType,
          },
          tx,
        );
      }

      return { ...result.tokens, clientType: consumedChallenge.clientType };
    });
  }

  async startTotpSetup(input: {
    ctx: RequestContext;
    metadata: AuthRequestMetadata;
  }): Promise<{ secret: string; provisioningUri: string }> {
    const { user, sessionId } = await this.requireVerifiedAuth(input.ctx);
    if (await this.mfaMethods.findActiveTotp(user._id)) {
      throw new AppError({
        code: 'MFA_ALREADY_CONFIGURED',
        httpStatus: 409,
        message: 'MFA is already configured.',
      });
    }

    await this.enforcePublicIpLimit('MFA_CHALLENGE_CREATE', `${user._id.toHexString()}:totp_setup`);
    const secret = this.totp.generateSecret();
    const encryptedSecret = this.totp.encryptSecret(secret);
    await this.unitOfWork.withTransaction(async (tx) => {
      await this.mfaMethods.upsertPendingTotp(user._id, encryptedSecret, [], new Date(), tx);
      await this.securityEvents.write(
        {
          type: 'TOTP_SETUP_STARTED',
          userId: user._id,
          sessionId,
          result: 'SUCCESS',
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
        },
        tx,
      );
    });

    return {
      secret,
      provisioningUri: this.totp.provisioningUri({
        secret,
        accountName: user.normalizedEmail ?? user.normalizedPhone ?? user._id.toHexString(),
      }),
    };
  }

  async confirmTotpSetup(input: {
    code: string;
    ctx: RequestContext;
    metadata: AuthRequestMetadata;
  }): Promise<{ success: true; accessToken: string; recoveryCodes: string[] }> {
    const { user, sessionId } = await this.requireVerifiedAuth(input.ctx);
    const method = await this.mfaMethods.findPendingTotp(user._id);
    if (!method?.encryptedSecret) {
      throw new AppError({
        code: 'MFA_SETUP_REQUIRED',
        httpStatus: 409,
        message: 'MFA setup is required.',
      });
    }

    const secret = this.totp.decryptSecret(method.encryptedSecret);
    await this.enforcePublicIpLimit('MFA_VERIFY', `${user._id.toHexString()}:totp_confirm`);
    if (!this.totp.verifyCode(secret, input.code)) {
      await this.securityEvents.write({
        type: 'MFA_VERIFICATION_FAILED',
        userId: user._id,
        sessionId,
        result: 'FAILURE',
        reasonCode: 'TOTP_INVALID',
        ipAddress: input.metadata.ipAddress,
        userAgent: input.metadata.userAgent,
      });
      throw invalidMfaCode();
    }

    const now = new Date();
    const recoveryCodes = this.generateRecoveryCodes();
    const recoveryCodeDigests = this.createRecoveryCodeDigests(recoveryCodes, now);
    let accessToken = '';
    await this.unitOfWork.withTransaction(async (tx) => {
      const activated = await this.mfaMethods.activateTotpWithRecoveryCodes(
        method._id,
        recoveryCodeDigests,
        now,
        tx,
      );
      if (!activated) throw invalidMfaChallenge();
      await this.sessions.markMfaSatisfied(sessionId, 'totp', now, tx);
      accessToken = this.jwt.createAccessToken({
        userId: user._id.toHexString(),
        authSessionId: sessionId.toHexString(),
        authenticationMethods: ['pwd', 'totp'],
      });
      await this.securityEvents.write(
        {
          type: 'TOTP_ENABLED',
          userId: user._id,
          sessionId,
          result: 'SUCCESS',
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
        },
        tx,
      );
    });

    return { success: true, accessToken, recoveryCodes };
  }

  async mfaStatus(ctx: RequestContext): Promise<{
    totpEnabled: boolean;
    mfaSatisfied: boolean;
    recoveryCodesRemaining: number;
  }> {
    const { user, session } = await this.requireAuth(ctx, { allowRestricted: true });
    return {
      totpEnabled: Boolean(await this.mfaMethods.findActiveTotp(user._id)),
      mfaSatisfied: Boolean(session.mfaSatisfiedAt),
      recoveryCodesRemaining: await this.mfaMethods.countUnusedRecoveryCodes(user._id),
    };
  }

  async startStepUp(input: {
    ctx: RequestContext;
    metadata: AuthRequestMetadata;
  }): Promise<{ mfaChallengeToken: string; availableMethods: Array<'TOTP' | 'RECOVERY_CODE'> }> {
    const { user, session } = await this.requireVerifiedAuth(input.ctx);
    const method = await this.mfaMethods.findActiveTotp(user._id);
    if (!method) throw mfaNotConfigured();

    await this.enforcePublicIpLimit('MFA_CHALLENGE_CREATE', `${session._id.toHexString()}:step_up`);
    const challenge = await this.createOpaqueChallenge({
      purpose: 'MFA_STEP_UP',
      userId: user._id,
      clientType: session.clientType,
      authenticationMethods: session.authenticationMethods,
      metadata: input.metadata,
    });
    await this.securityEvents.write({
      type: 'MFA_STEP_UP_CHALLENGE_CREATED',
      userId: user._id,
      sessionId: session._id,
      result: 'SUCCESS',
      ipAddress: input.metadata.ipAddress,
      userAgent: input.metadata.userAgent,
    });
    return {
      mfaChallengeToken: challenge.token,
      availableMethods: ['TOTP', 'RECOVERY_CODE'],
    };
  }

  async verifyStepUp(input: {
    mfaChallengeToken: string;
    factorType: 'TOTP' | 'RECOVERY_CODE';
    credential: string;
    ctx: RequestContext;
    metadata: AuthRequestMetadata;
  }): Promise<{ success: true; accessToken: string }> {
    const { user, session } = await this.requireVerifiedAuth(input.ctx);
    const now = new Date();
    const challengeDigest = this.credentialDigests.hashHighEntropySecret(input.mfaChallengeToken);
    const challenge = await this.challenges.incrementAttemptByDigest(
      'MFA_STEP_UP',
      challengeDigest,
      now,
    );
    if (!challenge.userId?.equals(user._id)) throw invalidMfaChallenge();

    const method = await this.mfaMethods.findActiveTotp(user._id);
    if (!method) throw mfaNotConfigured();
    await this.enforcePublicIpLimit('MFA_VERIFY', `${session._id.toHexString()}:step_up`);
    const authenticationMethod = await this.verifyMfaFactor({
      userId: user._id,
      sessionId: session._id,
      mfaMethod: method,
      factorType: input.factorType,
      credential: input.credential,
      metadata: input.metadata,
    });

    let accessToken = '';
    await this.unitOfWork.withTransaction(async (tx) => {
      if (input.factorType === 'RECOVERY_CODE') {
        const consumed = await this.mfaMethods.consumeRecoveryCode(
          method._id,
          this.credentialDigests.hashHighEntropySecret(input.credential),
          now,
          tx,
        );
        if (!consumed) {
          await this.securityEvents.write(
            {
              type: 'MFA_STEP_UP_FAILED',
              userId: user._id,
              sessionId: session._id,
              result: 'FAILURE',
              reasonCode: 'RECOVERY_CODE_INVALID',
              ipAddress: input.metadata.ipAddress,
              userAgent: input.metadata.userAgent,
            },
            tx,
          );
          throw invalidMfaCode();
        }
      }
      const consumed = await this.challenges.consumeVerifiedChallenge(
        challenge._id,
        'MFA_STEP_UP',
        now,
        tx,
      );
      if (!consumed) throw invalidMfaChallenge();
      await this.sessions.markMfaSatisfied(session._id, authenticationMethod, now, tx);
      const methods = [...new Set([...session.authenticationMethods, authenticationMethod])];
      accessToken = this.jwt.createAccessToken({
        userId: user._id.toHexString(),
        authSessionId: session._id.toHexString(),
        authenticationMethods: methods,
      });
      await this.securityEvents.write(
        {
          type: 'MFA_STEP_UP_SUCCEEDED',
          userId: user._id,
          sessionId: session._id,
          result: 'SUCCESS',
          reasonCode: input.factorType,
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
        },
        tx,
      );
    });
    return { success: true, accessToken };
  }

  async regenerateRecoveryCodes(input: {
    code: string;
    ctx: RequestContext;
    metadata: AuthRequestMetadata;
  }): Promise<{ success: true; recoveryCodes: string[] }> {
    const { user, session } = await this.requireVerifiedAuth(input.ctx);
    const method = await this.mfaMethods.findActiveTotp(user._id);
    if (!method) throw mfaNotConfigured();
    await this.enforcePublicIpLimit(
      'MFA_VERIFY',
      `${session._id.toHexString()}:recovery_regenerate`,
    );
    if (!this.totp.verifyCode(this.totp.decryptSecret(requiredSecret(method)), input.code)) {
      throw invalidMfaCode();
    }
    const now = new Date();
    const recoveryCodes = this.generateRecoveryCodes();
    await this.unitOfWork.withTransaction(async (tx) => {
      const replaced = await this.mfaMethods.replaceRecoveryCodes(
        method._id,
        this.createRecoveryCodeDigests(recoveryCodes, now),
        now,
        tx,
      );
      if (!replaced) throw mfaNotConfigured();
      await this.securityEvents.write(
        {
          type: 'MFA_RECOVERY_CODES_REGENERATED',
          userId: user._id,
          sessionId: session._id,
          result: 'SUCCESS',
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
        },
        tx,
      );
    });
    return { success: true, recoveryCodes };
  }

  async disableMfa(input: {
    factorType: 'TOTP' | 'RECOVERY_CODE';
    credential: string;
    ctx: RequestContext;
    metadata: AuthRequestMetadata;
  }): Promise<GenericSuccess> {
    const { user, session } = await this.requireVerifiedAuth(input.ctx);
    const method = await this.mfaMethods.findActiveTotp(user._id);
    if (!method) throw mfaNotConfigured();
    await this.enforcePublicIpLimit('MFA_VERIFY', `${session._id.toHexString()}:mfa_disable`);
    await this.verifyMfaFactor({
      userId: user._id,
      sessionId: session._id,
      mfaMethod: method,
      factorType: input.factorType,
      credential: input.credential,
      metadata: input.metadata,
    });

    const now = new Date();
    await this.unitOfWork.withTransaction(async (tx) => {
      if (input.factorType === 'RECOVERY_CODE') {
        const consumed = await this.mfaMethods.consumeRecoveryCode(
          method._id,
          this.credentialDigests.hashHighEntropySecret(input.credential),
          now,
          tx,
        );
        if (!consumed) throw invalidMfaCode();
      }
      await this.mfaMethods.disable(user._id, now, tx);
      await this.challenges.invalidateActiveUserChallenges('MFA_LOGIN', user._id, now, tx);
      await this.challenges.invalidateActiveUserChallenges('MFA_STEP_UP', user._id, now, tx);
      await this.sessions.revokeAllUserSessions(user._id, 'MFA_DISABLED', now, tx);
      await this.securityEvents.write(
        {
          type: 'MFA_DISABLED',
          userId: user._id,
          sessionId: session._id,
          result: 'SUCCESS',
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
        },
        tx,
      );
      await this.securityEvents.write(
        {
          type: 'AUTH_SESSIONS_REVOKED',
          userId: user._id,
          sessionId: session._id,
          result: 'SUCCESS',
          reasonCode: 'MFA_DISABLED',
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
        },
        tx,
      );
    });
    return { success: true };
  }

  async logout(ctx: RequestContext): Promise<GenericSuccess> {
    if (!ctx.authSessionId) return { success: true };
    const sessionId = objectId(ctx.authSessionId, 'AUTH_REQUIRED');
    const now = new Date();
    await this.unitOfWork.withTransaction(async (tx) => {
      const session = await this.sessions.findById(sessionId, tx);
      if (session) {
        await this.sessions.revokeSession(sessionId, 'LOGOUT', now, tx);
        await this.securityEvents.write(
          {
            type: 'LOGOUT',
            userId: session.userId,
            sessionId,
            result: 'SUCCESS',
          },
          tx,
        );
      }
    });
    return { success: true };
  }

  async verify(input: {
    purpose: 'EMAIL_VERIFICATION' | 'PHONE_VERIFICATION';
    challengeId: string;
    code: string;
    ctx: RequestContext;
    metadata: AuthRequestMetadata;
  }): Promise<{ success: true; accessToken?: string }> {
    const challengeId = objectId(input.challengeId, 'AUTH_CHALLENGE_INVALID');
    const now = new Date();
    const attempted = await this.challenges.incrementAttempt(challengeId, now);
    const presentedDigest = this.digestForChallenge(attempted, input.code);

    if (!this.credentialDigests.matches(attempted.challengeDigest, presentedDigest)) {
      await this.securityEvents.write({
        type: 'VERIFICATION_ATTEMPT',
        userId: attempted.userId,
        result: 'FAILURE',
        reasonCode: 'CODE_MISMATCH',
        ipAddress: input.metadata.ipAddress,
        userAgent: input.metadata.userAgent,
      });
      throw new AppError({
        code: 'AUTH_CHALLENGE_INVALID',
        httpStatus: 401,
        message: 'The verification challenge is invalid or expired.',
      });
    }

    let accessToken: string | undefined;
    await this.unitOfWork.withTransaction(async (tx) => {
      const consumed = await this.challenges.consumeVerifiedChallenge(
        challengeId,
        input.purpose,
        now,
        tx,
      );
      if (!consumed?.userId) {
        throw new AppError({
          code: 'AUTH_CHALLENGE_INVALID',
          httpStatus: 401,
          message: 'The verification challenge is invalid or expired.',
        });
      }

      const verified = await this.identity.markIdentifierVerified(
        consumed.userId,
        {
          ...(consumed.normalizedEmail ? { normalizedEmail: consumed.normalizedEmail } : {}),
          ...(consumed.normalizedPhone ? { normalizedPhone: consumed.normalizedPhone } : {}),
        },
        now,
        tx,
      );
      if (!verified) {
        throw new AppError({
          code: 'AUTH_CHALLENGE_INVALID',
          httpStatus: 401,
          message: 'The verification challenge is invalid or expired.',
        });
      }

      if (input.ctx.authSessionId && input.ctx.userId === consumed.userId.toHexString()) {
        const sessionId = objectId(input.ctx.authSessionId, 'AUTH_REQUIRED');
        await this.sessions.markVerifiedRestrictionResolved(sessionId, now, tx);
        const session = await this.sessions.findById(sessionId, tx);
        if (session) {
          accessToken = this.jwt.createAccessToken({
            userId: session.userId.toHexString(),
            authSessionId: session._id.toHexString(),
            authenticationMethods: session.authenticationMethods,
          });
        }
      }

      await this.securityEvents.write(
        {
          type: 'VERIFICATION_COMPLETED',
          userId: consumed.userId,
          result: 'SUCCESS',
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
        },
        tx,
      );
    });

    return { success: true, ...(accessToken ? { accessToken } : {}) };
  }

  async verifyIdentifierChallengeForActivation(input: {
    purpose: 'EMAIL_VERIFICATION' | 'PHONE_VERIFICATION';
    challengeId: ObjectId;
    code: string;
    userId: ObjectId;
    identifier: { normalizedEmail?: string; normalizedPhone?: string };
    metadata: AuthRequestMetadata;
    tx: TransactionContext;
  }): Promise<void> {
    const now = new Date();
    const attempted = await this.challenges.incrementAttempt(input.challengeId, now, input.tx);
    const presentedDigest = this.digestForChallenge(attempted, input.code);
    const expectedEmail =
      input.purpose === 'EMAIL_VERIFICATION' &&
      attempted.normalizedEmail &&
      input.identifier.normalizedEmail === attempted.normalizedEmail;
    const expectedPhone =
      input.purpose === 'PHONE_VERIFICATION' &&
      attempted.normalizedPhone &&
      input.identifier.normalizedPhone === attempted.normalizedPhone;
    const boundToSubject = attempted.userId?.equals(input.userId) === true;

    if (
      attempted.purpose !== input.purpose ||
      !boundToSubject ||
      (!expectedEmail && !expectedPhone) ||
      !this.credentialDigests.matches(attempted.challengeDigest, presentedDigest)
    ) {
      await this.securityEvents.write({
        type: 'OWNER_ACTIVATION_VERIFICATION_ATTEMPT',
        userId: attempted.userId,
        result: 'FAILURE',
        reasonCode: 'CODE_MISMATCH',
        ipAddress: input.metadata.ipAddress,
        userAgent: input.metadata.userAgent,
      });
      throw new AppError({
        code: 'AUTH_CHALLENGE_INVALID',
        httpStatus: 401,
        message: 'The verification challenge is invalid or expired.',
      });
    }

    const consumed = await this.challenges.consumeVerifiedChallenge(
      input.challengeId,
      input.purpose,
      now,
      input.tx,
    );
    if (!consumed?.userId?.equals(input.userId)) {
      throw new AppError({
        code: 'AUTH_CHALLENGE_INVALID',
        httpStatus: 401,
        message: 'The verification challenge is invalid or expired.',
      });
    }
    const verified = await this.identity.markIdentifierVerified(
      input.userId,
      input.identifier,
      now,
      input.tx,
    );
    if (!verified) {
      throw new AppError({
        code: 'AUTH_CHALLENGE_INVALID',
        httpStatus: 401,
        message: 'The verification challenge is invalid or expired.',
      });
    }
    await this.securityEvents.write(
      {
        type: 'OWNER_ACTIVATION_VERIFICATION_COMPLETED',
        userId: input.userId,
        result: 'SUCCESS',
        ipAddress: input.metadata.ipAddress,
        userAgent: input.metadata.userAgent,
      },
      input.tx,
    );
  }

  async resendVerification(input: {
    identifier: string;
    purpose: 'EMAIL_VERIFICATION' | 'PHONE_VERIFICATION';
    metadata: AuthRequestMetadata;
  }): Promise<GenericSuccess & { debugChallenge?: { challengeId: string; code: string } }> {
    const identifier = this.normalizeLoginIdentifierForPublicFlow(input.identifier);
    if (!identifier) return { success: true };

    const now = new Date();
    await this.enforcePublicIpLimit('OTP_IDENTIFIER_SEND', identifier.rateLimitKey);
    const latest = await this.challenges.findLatestActive(input.purpose, identifier, now);
    if (latest?.lastSentAt) {
      const retryAt =
        latest.lastSentAt.getTime() + this.config.auth.challengeResendCooldownSeconds * 1000;
      if (retryAt > now.getTime()) {
        throw new AppError({
          code: 'AUTH_RATE_LIMITED',
          httpStatus: 429,
          message: 'Too many authentication attempts. Try again later.',
        });
      }
    }

    const user = await this.identity.findByLoginIdentifier(identifier);
    if (!user) return { success: true };

    let debugChallenge: { challengeId: string; code: string } | undefined;
    await this.unitOfWork.withTransaction(async (tx) => {
      await this.challenges.invalidateActiveChallenges(input.purpose, identifier, now, tx);
      const created = await this.createVerificationChallenge(
        input.purpose,
        user._id,
        identifier,
        input.metadata,
        tx,
      );
      debugChallenge = { challengeId: created.challengeId, code: created.code };
      await this.securityEvents.write(
        {
          type: 'VERIFICATION_RESENT',
          userId: user._id,
          result: 'SUCCESS',
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
        },
        tx,
      );
    });

    return {
      success: true,
      ...(this.config.env === 'production' || !debugChallenge ? {} : { debugChallenge }),
    };
  }

  async forgotPassword(input: {
    identifier: string;
    metadata: AuthRequestMetadata;
  }): Promise<GenericSuccess & { debugReset?: { challengeId: string; code: string } }> {
    const identifier = this.normalizeLoginIdentifierForPublicFlow(input.identifier);
    await this.enforcePublicIpLimit('PASSWORD_RESET_IP', input.metadata.ipAddress);
    if (!identifier) return { success: true };
    await this.enforcePublicIpLimit('PASSWORD_RESET_IDENTIFIER', identifier.rateLimitKey);

    const user = await this.identity.findByLoginIdentifier(identifier);
    if (user?.status !== 'ACTIVE') {
      await this.securityEvents.write({
        type: 'PASSWORD_RESET_REQUESTED',
        result: 'INFO',
        reasonCode: 'IDENTIFIER_NOT_ELIGIBLE',
        ipAddress: input.metadata.ipAddress,
        userAgent: input.metadata.userAgent,
      });
      return { success: true };
    }

    let debugReset: { challengeId: string; code: string } | undefined;
    await this.unitOfWork.withTransaction(async (tx) => {
      await this.challenges.invalidateActivePasswordResetChallenges(user._id, new Date(), tx);
      const code = this.credentialDigests.randomSecret(32);
      const context = `PASSWORD_RESET:${user._id.toHexString()}`;
      const challenge = await this.challenges.create(
        {
          purpose: 'PASSWORD_RESET',
          userId: user._id,
          ...identifier,
          challengeDigest: this.credentialDigests.hashHighEntropySecret(code),
          digestContext: context,
          expiresAt: challengeExpiresAt(this.config),
          maxAttempts: this.config.auth.challengeMaxAttempts,
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
        },
        tx,
      );
      debugReset = { challengeId: challenge._id.toHexString(), code };
      await this.securityEvents.write(
        {
          type: 'PASSWORD_RESET_REQUESTED',
          userId: user._id,
          result: 'SUCCESS',
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
        },
        tx,
      );
    });

    return {
      success: true,
      ...(this.config.env === 'production' || !debugReset ? {} : { debugReset }),
    };
  }

  async resetPassword(input: {
    challengeId: string;
    code: string;
    newPassword: string;
    metadata: AuthRequestMetadata;
  }): Promise<GenericSuccess> {
    const challengeId = objectId(input.challengeId, 'AUTH_RESET_TOKEN_INVALID');
    const now = new Date();
    const attempted = await this.challenges.incrementAttempt(challengeId, now);
    if (attempted.purpose !== 'PASSWORD_RESET') {
      throw invalidResetToken();
    }
    const digest = this.credentialDigests.hashHighEntropySecret(input.code);
    if (!this.credentialDigests.matches(attempted.challengeDigest, digest) || !attempted.userId) {
      await this.securityEvents.write({
        type: 'PASSWORD_RESET_FAILED',
        userId: attempted.userId,
        result: 'FAILURE',
        reasonCode: 'TOKEN_MISMATCH',
        ipAddress: input.metadata.ipAddress,
        userAgent: input.metadata.userAgent,
      });
      throw invalidResetToken();
    }

    const passwordHash = await this.passwordHasher.hash(input.newPassword);
    await this.unitOfWork.withTransaction(async (tx) => {
      const consumed = await this.challenges.consumeVerifiedChallenge(
        challengeId,
        'PASSWORD_RESET',
        now,
        tx,
      );
      if (!consumed?.userId) throw invalidResetToken();
      await this.challenges.invalidateActivePasswordResetChallenges(consumed.userId, now, tx);
      await this.identity.updatePasswordHash(consumed.userId, passwordHash, now, tx);
      await this.sessions.revokeAllUserSessions(consumed.userId, 'PASSWORD_RESET', now, tx);
      await this.securityEvents.write(
        {
          type: 'PASSWORD_RESET_COMPLETED',
          userId: consumed.userId,
          result: 'SUCCESS',
          ipAddress: input.metadata.ipAddress,
          userAgent: input.metadata.userAgent,
        },
        tx,
      );
    });

    return { success: true };
  }

  private normalizeRegistrationIdentifiers(email?: string, phone?: string) {
    const normalizedEmail = email ? normalizeEmail(email) : undefined;
    const normalizedPhone = phone ? normalizePhoneToE164(phone) : undefined;
    if (!normalizedEmail && !normalizedPhone) {
      throw new AppError({
        code: 'AUTH_IDENTIFIER_REQUIRED',
        httpStatus: 422,
        message: 'At least one email or phone login identifier is required.',
      });
    }
    return {
      ...(email ? { email: email.trim() } : {}),
      ...(normalizedEmail ? { normalizedEmail } : {}),
      ...(phone ? { phone: phone.trim() } : {}),
      ...(normalizedPhone ? { normalizedPhone } : {}),
    };
  }

  private normalizeLoginIdentifierForPublicFlow(identifier: string) {
    try {
      return normalizeLoginIdentifier(identifier);
    } catch {
      return null;
    }
  }

  private async createVerificationChallenge(
    purpose: 'EMAIL_VERIFICATION' | 'PHONE_VERIFICATION',
    userId: ObjectId,
    identifier: { normalizedEmail?: string; normalizedPhone?: string; rateLimitKey?: string },
    metadata: AuthRequestMetadata,
    tx: TransactionContext,
  ): Promise<{ purpose: string; challengeId: string; code: string }> {
    const isPhone = purpose === 'PHONE_VERIFICATION';
    const code = isPhone
      ? String(randomInt(100000, 1000000))
      : this.credentialDigests.randomSecret(32);
    const context = `${purpose}:${userId.toHexString()}:${identifier.normalizedEmail ?? identifier.normalizedPhone}`;
    const challengeDigest = isPhone
      ? this.credentialDigests.hmacLowEntropySecret(code, context)
      : this.credentialDigests.hashHighEntropySecret(code);
    const challenge = await this.challenges.create(
      {
        purpose,
        userId,
        ...(identifier.normalizedEmail ? { normalizedEmail: identifier.normalizedEmail } : {}),
        ...(identifier.normalizedPhone ? { normalizedPhone: identifier.normalizedPhone } : {}),
        challengeDigest,
        digestContext: context,
        expiresAt: challengeExpiresAt(this.config),
        maxAttempts: this.config.auth.challengeMaxAttempts,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
      },
      tx,
    );
    return { purpose, challengeId: challenge._id.toHexString(), code };
  }

  private async createMfaLoginChallenge(input: {
    userId: ObjectId;
    clientType: AuthClientType;
    metadata: AuthRequestMetadata;
  }): Promise<MfaRequiredResult> {
    await this.enforcePublicIpLimit(
      'MFA_CHALLENGE_CREATE',
      `${input.userId.toHexString()}:mfa_login`,
    );
    const challenge = await this.createOpaqueChallenge({
      purpose: 'MFA_LOGIN',
      userId: input.userId,
      clientType: input.clientType,
      authenticationMethods: ['pwd'],
      metadata: input.metadata,
    });
    await this.securityEvents.write({
      type: 'MFA_LOGIN_CHALLENGE_CREATED',
      userId: input.userId,
      result: 'SUCCESS',
      ipAddress: input.metadata.ipAddress,
      userAgent: input.metadata.userAgent,
      clientType: input.clientType,
    });
    return {
      status: 'MFA_REQUIRED',
      mfaChallengeToken: challenge.token,
      availableMethods: ['TOTP', 'RECOVERY_CODE'],
    };
  }

  private async createOpaqueChallenge(input: {
    purpose: 'MFA_LOGIN' | 'MFA_STEP_UP';
    userId: ObjectId;
    clientType: AuthClientType;
    authenticationMethods: AuthenticationMethod[];
    metadata: AuthRequestMetadata;
    tx?: TransactionContext;
  }): Promise<{ token: string; challenge: AuthChallengeDocument }> {
    const token = this.credentialDigests.randomSecret(32);
    const challenge = await this.challenges.create(
      {
        purpose: input.purpose,
        userId: input.userId,
        clientType: input.clientType,
        authenticationMethods: input.authenticationMethods,
        challengeDigest: this.credentialDigests.hashHighEntropySecret(token),
        digestContext: `${input.purpose}:${input.userId.toHexString()}`,
        expiresAt: mfaChallengeExpiresAt(this.config),
        maxAttempts: this.config.auth.mfaChallengeMaxAttempts,
        ipAddress: input.metadata.ipAddress,
        userAgent: input.metadata.userAgent,
      },
      input.tx,
    );
    return { token, challenge };
  }

  private async createAuthenticatedSession(
    user: UserDocument,
    clientType: AuthClientType,
    authenticationMethods: AuthenticationMethod[],
    restrictedUntilVerified: boolean,
    metadata: AuthRequestMetadata,
    now: Date,
    tx: TransactionContext,
  ): Promise<{ sessionId: ObjectId; tokens: AuthTokensResult }> {
    const expiresAt = this.refreshExpiresAt(now);
    const session = await this.sessions.create(
      {
        userId: user._id,
        clientType,
        transport: refreshTransportForClient(clientType),
        authenticationMethods,
        restrictedUntilVerified,
        expiresAt,
        ipAddress: metadata.ipAddress,
        ...(metadata.userAgent ? { userAgent: metadata.userAgent } : {}),
        ...(hasMfaMethod(authenticationMethods) ? { mfaSatisfiedAt: now } : {}),
        now,
      },
      tx,
    );
    const refreshToken = await this.refreshTokens.issue({
      userId: user._id,
      sessionId: session._id,
      expiresAt,
      tx,
    });
    await this.securityEvents.write(
      {
        type: 'AUTH_SESSION_CREATED',
        userId: user._id,
        sessionId: session._id,
        result: 'SUCCESS',
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        clientType,
      },
      tx,
    );
    return {
      sessionId: session._id,
      tokens: this.tokensResponse(
        user,
        session._id,
        restrictedUntilVerified,
        clientType,
        refreshToken.rawToken,
        { authenticationMethods },
      ),
    };
  }

  private async verifyMfaFactor(input: {
    userId: ObjectId;
    sessionId?: ObjectId;
    mfaMethod: AuthMfaMethodDocument;
    factorType: 'TOTP' | 'RECOVERY_CODE';
    credential: string;
    metadata: AuthRequestMetadata;
  }): Promise<AuthenticationMethod> {
    if (input.factorType === 'RECOVERY_CODE') {
      return 'recovery_code';
    }

    if (!input.mfaMethod.encryptedSecret) throw mfaNotConfigured();
    const valid = this.totp.verifyCode(
      this.totp.decryptSecret(input.mfaMethod.encryptedSecret),
      input.credential,
    );
    if (!valid) {
      await this.securityEvents.write({
        type: 'MFA_VERIFICATION_FAILED',
        userId: input.userId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        result: 'FAILURE',
        reasonCode: 'TOTP_INVALID',
        ipAddress: input.metadata.ipAddress,
        userAgent: input.metadata.userAgent,
      });
      throw invalidMfaCode();
    }
    return 'totp';
  }

  private generateRecoveryCodes(): string[] {
    return Array.from({ length: this.config.auth.recoveryCodeCount }, () =>
      randomBytes(10).toString('base64url').toUpperCase(),
    );
  }

  private createRecoveryCodeDigests(rawCodes: string[], now = new Date()) {
    return rawCodes.map((code) => ({
      codeHash: this.credentialDigests.hashHighEntropySecret(code),
      createdAt: now,
    }));
  }

  private async requireAuth(
    ctx: RequestContext,
    options: { allowRestricted?: boolean } = {},
  ): Promise<{ user: UserDocument; session: AuthSessionDocument }> {
    if (!ctx.userId || !ctx.authSessionId) {
      throw authRequired();
    }
    const userId = objectId(ctx.userId, 'AUTH_REQUIRED');
    const sessionId = objectId(ctx.authSessionId, 'AUTH_REQUIRED');
    const [user, session] = await Promise.all([
      this.identity.findById(userId),
      this.sessions.findActive(sessionId),
    ]);
    if (!user || !session?.userId.equals(user._id)) throw authRequired();
    if (session.restrictedUntilVerified && !options.allowRestricted) {
      throw new AppError({
        code: 'AUTH_SESSION_RESTRICTED',
        httpStatus: 403,
        message: 'The account must verify a login identifier before continuing.',
      });
    }
    return { user, session };
  }

  private async requireVerifiedAuth(
    ctx: RequestContext,
  ): Promise<{ user: UserDocument; session: AuthSessionDocument; sessionId: ObjectId }> {
    const { user, session } = await this.requireAuth(ctx);
    return { user, session, sessionId: session._id };
  }

  private digestForChallenge(challenge: AuthChallengeDocument, presented: string): string {
    if (challenge.purpose === 'PHONE_VERIFICATION') {
      return this.credentialDigests.hmacLowEntropySecret(presented, challenge.digestContext);
    }
    return this.credentialDigests.hashHighEntropySecret(presented);
  }

  private async enforcePublicIpLimit(
    scope:
      | 'LOGIN_IP'
      | 'LOGIN_IDENTIFIER_IP'
      | 'PASSWORD_RESET_IDENTIFIER'
      | 'PASSWORD_RESET_IP'
      | 'OTP_IDENTIFIER_SEND'
      | 'MFA_CHALLENGE_CREATE'
      | 'MFA_VERIFY',
    key: string,
  ): Promise<void> {
    const config = this.config.auth;
    const policy = {
      LOGIN_IP: { windowMs: config.loginIpWindowMs, maxAttempts: config.loginIpMaxAttempts },
      LOGIN_IDENTIFIER_IP: {
        windowMs: config.loginIdentifierIpWindowMs,
        maxAttempts: config.loginIdentifierIpMaxAttempts,
        blockMs: config.loginIdentifierIpBlockMs,
      },
      PASSWORD_RESET_IDENTIFIER: {
        windowMs: 60 * 60 * 1000,
        maxAttempts: config.passwordResetIdentifierMaxPerHour,
      },
      PASSWORD_RESET_IP: {
        windowMs: 60 * 60 * 1000,
        maxAttempts: config.passwordResetIpMaxPerHour,
      },
      OTP_IDENTIFIER_SEND: {
        windowMs: 60 * 60 * 1000,
        maxAttempts: config.challengeMaxSendsPerHour,
      },
      MFA_CHALLENGE_CREATE: {
        windowMs: 60 * 60 * 1000,
        maxAttempts: config.challengeMaxSendsPerHour,
      },
      MFA_VERIFY: {
        windowMs: 60 * 60 * 1000,
        maxAttempts: config.mfaChallengeMaxAttempts,
      },
    }[scope];
    const bucket = await this.rateLimits.incrementBucket({ scope, key, ...policy });
    if (
      bucket.count > policy.maxAttempts ||
      (bucket.blockedUntil && bucket.blockedUntil > new Date())
    ) {
      throw new AppError({
        code: 'AUTH_RATE_LIMITED',
        httpStatus: 429,
        message: 'Too many authentication attempts. Try again later.',
      });
    }
  }

  private refreshExpiresAt(now = new Date()): Date {
    return new Date(now.getTime() + this.config.auth.refreshTokenTtlSeconds * 1000);
  }

  private tokensResponse(
    user: UserDocument,
    sessionId: ObjectId,
    restrictedUntilVerified: boolean,
    _clientType: AuthClientType,
    rawRefreshToken: string,
    extras: Pick<AuthTokensResult, 'debugChallenges'> & {
      authenticationMethods?: AuthenticationMethod[];
    } = {},
  ): AuthTokensResult {
    return {
      accessToken: this.jwt.createAccessToken({
        userId: user._id.toHexString(),
        authSessionId: sessionId.toHexString(),
        authenticationMethods: extras.authenticationMethods ?? ['pwd'],
      }),
      user: safeUser(user),
      restrictedUntilVerified,
      refreshToken: rawRefreshToken,
      ...(this.config.env === 'production' ? {} : extras),
    };
  }
}

export function refreshTransportForClient(clientType: AuthClientType): RefreshTokenTransport {
  return clientType === 'WEB' ? 'COOKIE' : 'JSON';
}

function safeUser(user: UserDocument): SafeAuthUser {
  return {
    id: user._id.toHexString(),
    firstName: user.firstName,
    lastName: user.lastName,
    emailVerified: Boolean(user.emailVerifiedAt),
    phoneVerified: Boolean(user.phoneVerifiedAt),
    ...(user.email ? { email: user.email } : {}),
    ...(user.phone ? { phone: user.phone } : {}),
  };
}

function hasVerifiedIdentifier(user: UserDocument): boolean {
  return Boolean(user.emailVerifiedAt || user.phoneVerifiedAt);
}

function challengeExpiresAt(config: AppConfig): Date {
  return new Date(Date.now() + config.auth.challengeTtlSeconds * 1000);
}

function mfaChallengeExpiresAt(config: AppConfig): Date {
  return new Date(Date.now() + config.auth.mfaChallengeTtlSeconds * 1000);
}

function hasMfaMethod(methods: AuthenticationMethod[]): boolean {
  return methods.includes('totp') || methods.includes('recovery_code');
}

function objectId(value: string, errorCode: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw new AppError({
      code: errorCode,
      httpStatus: 401,
      message: 'The authentication request is invalid.',
    });
  }
  return new ObjectId(value);
}

function invalidCredentials(): AppError {
  return new AppError({
    code: 'INVALID_CREDENTIALS',
    httpStatus: 401,
    message: 'The supplied credentials are invalid.',
  });
}

function invalidResetToken(): AppError {
  return new AppError({
    code: 'AUTH_RESET_TOKEN_INVALID',
    httpStatus: 401,
    message: 'The password reset token is invalid or expired.',
  });
}

function authRequired(): AppError {
  return new AppError({
    code: 'AUTH_REQUIRED',
    httpStatus: 401,
    message: 'Authentication is required.',
  });
}

function invalidMfaChallenge(): AppError {
  return new AppError({
    code: 'MFA_CHALLENGE_INVALID',
    httpStatus: 401,
    message: 'The MFA challenge is invalid or expired.',
  });
}

function invalidMfaCode(): AppError {
  return new AppError({
    code: 'MFA_CODE_INVALID',
    httpStatus: 401,
    message: 'The MFA code is invalid.',
  });
}

function mfaNotConfigured(): AppError {
  return new AppError({
    code: 'MFA_NOT_CONFIGURED',
    httpStatus: 409,
    message: 'MFA is not configured.',
  });
}

function requiredSecret(method: AuthMfaMethodDocument): string {
  if (!method.encryptedSecret) throw mfaNotConfigured();
  return method.encryptedSecret;
}
