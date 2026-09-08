export interface RequestContext {
  correlationId: string;
  userId?: string;
  authSessionId?: string;
  authenticationMethods?: string[];
  mfaSatisfied?: boolean;
  restrictedUntilVerified?: boolean;
  platformMembershipId?: string;
  workspaceId?: string;
  workspaceMembershipId?: string;
  supportSessionId?: string;
  effectiveUserId?: string;
  effectiveMembershipId?: string;
  ipAddress: string;
  userAgent?: string;
  locale: string;
  timezone: string;
}
