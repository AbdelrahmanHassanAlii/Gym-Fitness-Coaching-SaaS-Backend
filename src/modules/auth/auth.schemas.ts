import { Type } from '@sinclair/typebox';

const ClientType = Type.Union([Type.Literal('WEB'), Type.Literal('MOBILE'), Type.Literal('API')]);

export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    correlationId: Type.String(),
  }),
});

const SafeUser = Type.Object({
  id: Type.String(),
  firstName: Type.String(),
  lastName: Type.String(),
  email: Type.Optional(Type.String()),
  phone: Type.Optional(Type.String()),
  emailVerified: Type.Boolean(),
  phoneVerified: Type.Boolean(),
});

export const AuthTokenResponse = Type.Object({
  data: Type.Object({
    accessToken: Type.String(),
    refreshToken: Type.Optional(Type.String()),
    user: Type.Optional(SafeUser),
    restrictedUntilVerified: Type.Boolean(),
    debugChallenges: Type.Optional(
      Type.Array(
        Type.Object({
          purpose: Type.String(),
          challengeId: Type.String(),
          code: Type.String(),
        }),
      ),
    ),
  }),
});

export const LoginResponse = Type.Object({
  data: Type.Union([
    AuthTokenResponse.properties.data,
    Type.Object({
      status: Type.Literal('MFA_REQUIRED'),
      mfaChallengeToken: Type.String(),
      availableMethods: Type.Array(
        Type.Union([Type.Literal('TOTP'), Type.Literal('RECOVERY_CODE')]),
      ),
    }),
  ]),
});

export const SuccessResponse = Type.Object({
  data: Type.Object({
    success: Type.Literal(true),
    accessToken: Type.Optional(Type.String()),
    recoveryCodes: Type.Optional(Type.Array(Type.String())),
    debugChallenge: Type.Optional(
      Type.Object({
        challengeId: Type.String(),
        code: Type.String(),
      }),
    ),
    debugReset: Type.Optional(
      Type.Object({
        challengeId: Type.String(),
        code: Type.String(),
      }),
    ),
  }),
});

export const RegisterBody = Type.Object({
  email: Type.Optional(Type.String()),
  phone: Type.Optional(Type.String()),
  password: Type.String({ minLength: 8 }),
  firstName: Type.String({ minLength: 1 }),
  lastName: Type.String({ minLength: 1 }),
  preferredLanguage: Type.Union([Type.Literal('ar'), Type.Literal('en')]),
  clientType: ClientType,
});

export const LoginBody = Type.Object({
  identifier: Type.String({ minLength: 1 }),
  password: Type.String({ minLength: 1 }),
  clientType: ClientType,
});

export const RefreshBody = Type.Object({
  clientType: ClientType,
  refreshToken: Type.Optional(Type.String()),
});

export const VerifyBody = Type.Object({
  challengeId: Type.String(),
  code: Type.String({ minLength: 1 }),
});

export const ResendVerificationBody = Type.Object({
  identifier: Type.String({ minLength: 1 }),
  purpose: Type.Union([Type.Literal('EMAIL_VERIFICATION'), Type.Literal('PHONE_VERIFICATION')]),
});

export const ForgotPasswordBody = Type.Object({
  identifier: Type.String({ minLength: 1 }),
});

export const ResetPasswordBody = Type.Object({
  challengeId: Type.String(),
  code: Type.String({ minLength: 1 }),
  newPassword: Type.String({ minLength: 8 }),
});

const MfaFactorType = Type.Union([Type.Literal('TOTP'), Type.Literal('RECOVERY_CODE')]);

export const MfaLoginVerifyBody = Type.Object({
  mfaChallengeToken: Type.String({ minLength: 1 }),
  factorType: MfaFactorType,
  credential: Type.String({ minLength: 1 }),
});

export const TotpSetupResponse = Type.Object({
  data: Type.Object({
    secret: Type.String(),
    provisioningUri: Type.String(),
  }),
});

export const TotpConfirmBody = Type.Object({
  code: Type.String({ minLength: 1 }),
});

export const MfaStatusResponse = Type.Object({
  data: Type.Object({
    totpEnabled: Type.Boolean(),
    mfaSatisfied: Type.Boolean(),
    recoveryCodesRemaining: Type.Number(),
  }),
});

export const MfaStepUpStartResponse = Type.Object({
  data: Type.Object({
    mfaChallengeToken: Type.String(),
    availableMethods: Type.Array(MfaFactorType),
  }),
});

export const MfaStepUpVerifyBody = MfaLoginVerifyBody;

export const MfaRecoveryCodesRegenerateBody = Type.Object({
  code: Type.String({ minLength: 1 }),
});

export const MfaDisableBody = Type.Object({
  factorType: MfaFactorType,
  credential: Type.String({ minLength: 1 }),
});
