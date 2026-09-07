export type NodeEnvironment = 'development' | 'test' | 'production';

export interface AppConfig {
  env: NodeEnvironment;
  app: {
    host: string;
    port: number;
    docsEnabled: boolean;
    trustProxy: boolean;
    allowedOrigins: string[];
  };
  mongo: {
    uri: string;
    dbName: string;
    connectTimeoutMs: number;
  };
  logging: {
    level: string;
  };
  auth: {
    jwtActiveKeyId: string;
    jwtPrivateKey: string;
    jwtPublicKeys: Record<string, string>;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    otpHmacSecret: string;
    totpEncryptionKey: string;
    loginIdentifierIpWindowMs: number;
    loginIdentifierIpMaxAttempts: number;
    loginIdentifierIpBlockMs: number;
    loginIpWindowMs: number;
    loginIpMaxAttempts: number;
    challengeTtlSeconds: number;
    challengeMaxAttempts: number;
    challengeResendCooldownSeconds: number;
    challengeMaxSendsPerHour: number;
    passwordResetIdentifierMaxPerHour: number;
    passwordResetIpMaxPerHour: number;
  };
  worker: {
    id: string;
    outboxPollIntervalMs: number;
    outboxLockMs: number;
    outboxMaxAttempts: number;
    jobLeaseMs: number;
  };
  support: {
    defaultSessionMinutes: number;
    maxSessionMinutes: number;
  };
}
