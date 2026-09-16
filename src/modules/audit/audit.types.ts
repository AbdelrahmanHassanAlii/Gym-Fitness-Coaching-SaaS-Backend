import type { ObjectId } from 'mongodb';
import type { AuditActor } from '../../core/audit/audit.types';

export interface AuditEventDocument {
  _id: ObjectId;
  eventType: string;
  workspaceId?: ObjectId;
  actor: AuditActor;
  effectiveContext?: Record<string, unknown>;
  supportSessionId?: ObjectId;
  sensitive?: boolean;
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
  occurredAt: Date;
}

export interface AuditListFilters {
  eventType?: string;
  action?: string;
  actorUserId?: ObjectId;
  entityType?: string;
  entityId?: ObjectId | string;
  correlationId?: string;
  from?: Date;
  to?: Date;
  workspaceId?: ObjectId;
}

export interface AuditCursor {
  occurredAt: Date;
  id: ObjectId;
}
