export const AuthClientTypes = ['WEB', 'MOBILE', 'API'] as const;
export type AuthClientType = (typeof AuthClientTypes)[number];

export const RefreshTokenTransports = ['COOKIE', 'JSON'] as const;
export type RefreshTokenTransport = (typeof RefreshTokenTransports)[number];

export const AuthenticationMethods = ['pwd', 'totp', 'recovery_code'] as const;
export type AuthenticationMethod = (typeof AuthenticationMethods)[number];

export interface AuthSecurityMetadata {
  ipAddress: string;
  userAgent?: string | undefined;
  clientType?: AuthClientType | undefined;
  transport?: RefreshTokenTransport | undefined;
}
