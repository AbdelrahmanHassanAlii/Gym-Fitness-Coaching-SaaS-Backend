import type { Collection, Filter, ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { AuditCursor, AuditEventDocument, AuditListFilters } from './audit.types';

export class AuditRepository {
  private readonly events: Collection<AuditEventDocument>;

  constructor(database: Database) {
    this.events = database.db.collection<AuditEventDocument>('audit_events');
  }

  async list(input: {
    workspaceId?: ObjectId;
    filters: AuditListFilters;
    cursor?: AuditCursor;
    limit: number;
  }): Promise<AuditEventDocument[]> {
    return await this.events
      .find(this.filter(input.workspaceId, input.filters, input.cursor))
      .sort({ occurredAt: -1, _id: -1 })
      .limit(input.limit)
      .toArray();
  }

  private filter(
    workspaceId: ObjectId | undefined,
    filters: AuditListFilters,
    cursor: AuditCursor | undefined,
  ): Filter<AuditEventDocument> {
    return {
      ...(workspaceId ? { workspaceId } : {}),
      ...(filters.workspaceId ? { workspaceId: filters.workspaceId } : {}),
      ...(filters.eventType ? { eventType: filters.eventType } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.actorUserId ? { 'actor.userId': filters.actorUserId } : {}),
      ...(filters.entityType ? { 'entity.type': filters.entityType } : {}),
      ...(filters.entityId ? { 'entity.id': filters.entityId } : {}),
      ...(filters.correlationId ? { correlationId: filters.correlationId } : {}),
      ...dateRange(filters),
      ...(cursor
        ? {
            $or: [
              { occurredAt: { $lt: cursor.occurredAt } },
              { occurredAt: cursor.occurredAt, _id: { $lt: cursor.id } },
            ],
          }
        : {}),
    };
  }
}

function dateRange(filters: AuditListFilters): Filter<AuditEventDocument> {
  if (!filters.from && !filters.to) return {};
  return {
    occurredAt: {
      ...(filters.from ? { $gte: filters.from } : {}),
      ...(filters.to ? { $lte: filters.to } : {}),
    },
  };
}
