import type { ObjectId } from 'mongodb';

export interface AuditActor {
  userId?: ObjectId;
  platformMembershipId?: ObjectId;
  workspaceMembershipId?: ObjectId;
}

export interface AuditEventInput {
  eventType: string;
  workspaceId?: ObjectId;
  actor: AuditActor;
  effectiveContext?: Record<string, unknown>;
  supportSessionId?: ObjectId;
  entity: {
    type: string;
    id: ObjectId | string;
  };
  action: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  diff?: Record<string, unknown>;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId: string;
  occurredAt?: Date;
}
