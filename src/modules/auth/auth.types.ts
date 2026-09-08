import type { ObjectId } from 'mongodb';
import type {
  AuthClientType,
  AuthenticationMethod,
  RefreshTokenTransport,
} from '../../core/auth/auth.types';

export const AuthSessionStatuses = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const;
export type AuthSessionStatus = (typeof AuthSessionStatuses)[number];

export const RefreshTokenStatuses = ['CURRENT', 'CONSUMED', 'REVOKED'] as const;
export type RefreshTokenStatus = (typeof RefreshTokenStatuses)[number];

export const AuthChallengePurposes = [
  'EMAIL_VERIFICATION',
  'PHONE_VERIFICATION',
  'PASSWORD_RESET',
  'MFA_LOGIN',
  'TOTP_SETUP',
  'MFA_STEP_UP',
] as const;
export type AuthChallengePurpose = (typeof AuthChallengePurposes)[number];

export const MfaMethodTypes = ['TOTP'] as const;
export type MfaMethodType = (typeof MfaMethodTypes)[number];

export const MfaMethodStatuses = ['PENDING', 'ACTIVE', 'DISABLED'] as const;
export type MfaMethodStatus = (typeof MfaMethodStatuses)[number];

export const AuthRateLimitScopes = [
  'LOGIN_IDENTIFIER_IP',
  'LOGIN_IP',
  'PASSWORD_RESET_IDENTIFIER',
  'PASSWORD_RESET_IP',
  'OTP_IDENTIFIER_SEND',
  'MFA_CHALLENGE_CREATE',
  'MFA_VERIFY',
] as const;
export type AuthRateLimitScope = (typeof AuthRateLimitScopes)[number];

export interface AuthSessionDocument {
  _id: ObjectId;
  userId: ObjectId;
  status: AuthSessionStatus;
  clientType: AuthClientType;
  refreshTokenTransport: RefreshTokenTransport;
  deviceId?: string;
  deviceName?: string;
  platform?: string;
  userAgent?: string;
  ipAddress: string;
  authenticationMethods: AuthenticationMethod[];
  mfaSatisfiedAt?: Date;
  restrictedUntilVerified: boolean;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  revokeReason?: string;
}

export interface AuthRefreshTokenDocument {
  _id: ObjectId;
  publicId: string;
  sessionId: ObjectId;
  userId: ObjectId;
  secretHash: string;
  status: RefreshTokenStatus;
  createdAt: Date;
  expiresAt: Date;
  consumedAt?: Date;
  replacedByTokenId?: ObjectId;
  revokedAt?: Date;
}

export interface AuthChallengeDocument {
  _id: ObjectId;
  purpose: AuthChallengePurpose;
  userId?: ObjectId | undefined;
  normalizedEmail?: string | undefined;
  normalizedPhone?: string | undefined;
  clientType?: AuthClientType | undefined;
  authenticationMethods?: AuthenticationMethod[] | undefined;
  challengeDigest: string;
  digestContext: string;
  expiresAt: Date;
  consumedAt?: Date;
  attemptCount: number;
  maxAttempts: number;
  resendCount: number;
  lastSentAt?: Date | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  createdAt: Date;
}

export interface RecoveryCodeDigest {
  codeHash: string;
  createdAt: Date;
  consumedAt?: Date;
}

export interface AuthMfaMethodDocument {
  _id: ObjectId;
  userId: ObjectId;
  type: MfaMethodType;
  status: MfaMethodStatus;
  encryptedSecret?: string;
  recoveryCodes: RecoveryCodeDigest[];
  activatedAt?: Date;
  disabledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthRateLimitDocument {
  _id: ObjectId;
  scope: AuthRateLimitScope;
  key: string;
  count: number;
  windowStartedAt: Date;
  expiresAt: Date;
  blockedUntil?: Date;
  updatedAt: Date;
}

export interface AuthSecurityEventDocument {
  _id?: ObjectId;
  type: string;
  userId?: ObjectId | undefined;
  sessionId?: ObjectId | undefined;
  result: 'SUCCESS' | 'FAILURE' | 'DENIED' | 'INFO';
  reasonCode?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  clientType?: AuthClientType | undefined;
  occurredAt: Date;
  metadata?: Record<string, unknown> | undefined;
}
