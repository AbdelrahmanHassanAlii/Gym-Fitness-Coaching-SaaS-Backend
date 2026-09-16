import { Buffer } from 'node:buffer';
import { ObjectId } from 'mongodb';
import type { AccessControlService } from '../../core/access-control/access-control.service';
import { AppError } from '../../core/errors/app-error';
import type { RequestContext } from '../../core/request-context/request-context';
import { Permissions } from '../permissions/permission.registry';
import type { AuditRepository } from './audit.repository';
import type { AuditCursor, AuditEventDocument, AuditListFilters } from './audit.types';

export interface AuditQuery {
  cursor?: string;
  limit?: number;
  eventType?: string;
  action?: string;
  actorUserId?: string;
  entityType?: string;
  entityId?: string;
  correlationId?: string;
  from?: string;
  to?: string;
  workspaceId?: string;
}

export class AuditApplicationService {
  constructor(
    private readonly audits: AuditRepository,
    private readonly accessControl: AccessControlService,
  ) {}

  async listWorkspace(ctx: RequestContext, workspaceId: string, query: AuditQuery) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const filters = parseFilters(query, false);
    const canReadSensitive = await this.canReadSensitive(ctx, 'WORKSPACE', id);
    return this.page(
      await this.audits.list({
        workspaceId: id,
        filters,
        limit: pageLimit(query.limit) + 1,
        ...(query.cursor ? { cursor: decodeCursor(query.cursor) } : {}),
      }),
      pageLimit(query.limit),
      canReadSensitive,
    );
  }

  async listPlatform(ctx: RequestContext, query: AuditQuery) {
    const filters = parseFilters(query, true);
    const canReadSensitive = await this.canReadSensitive(ctx, 'PLATFORM');
    return this.page(
      await this.audits.list({
        filters,
        limit: pageLimit(query.limit) + 1,
        ...(query.cursor ? { cursor: decodeCursor(query.cursor) } : {}),
      }),
      pageLimit(query.limit),
      canReadSensitive,
    );
  }

  private async canReadSensitive(
    ctx: RequestContext,
    context: 'PLATFORM' | 'WORKSPACE',
    workspaceId?: ObjectId,
  ): Promise<boolean> {
    return await this.accessControl.canDelegate(ctx, {
      context,
      permission: Permissions.AuditSensitiveRead,
      ...(workspaceId ? { workspaceId } : {}),
      scope: { type: 'WORKSPACE' },
    });
  }

  private page(rows: AuditEventDocument[], limit: number, includeSensitive: boolean) {
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map((event) => toDto(event, includeSensitive)),
      meta: {
        nextCursor: rows.length > limit && last ? encodeCursor(last.occurredAt, last._id) : null,
        hasMore: rows.length > limit,
      },
    };
  }
}

function parseFilters(query: AuditQuery, allowWorkspaceFilter: boolean): AuditListFilters {
  const from = query.from ? date(query.from, 'AUDIT_FROM_INVALID') : undefined;
  const to = query.to ? date(query.to, 'AUDIT_TO_INVALID') : undefined;
  if (from && to && from > to) {
    throw invalid('AUDIT_DATE_RANGE_INVALID', 'from must be before or equal to to.');
  }
  return {
    ...(query.eventType ? { eventType: query.eventType } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.actorUserId
      ? { actorUserId: objectId(query.actorUserId, 'ACTOR_USER_INVALID') }
      : {}),
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.entityId ? { entityId: parseEntityId(query.entityId) } : {}),
    ...(query.correlationId ? { correlationId: query.correlationId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(allowWorkspaceFilter && query.workspaceId
      ? { workspaceId: objectId(query.workspaceId, 'WORKSPACE_FILTER_INVALID') }
      : {}),
  };
}

function toDto(event: AuditEventDocument, includeSensitive: boolean) {
  const sensitiveHidden = Boolean(event.sensitive && !includeSensitive);
  return {
    id: event._id.toHexString(),
    eventType: event.eventType,
    ...(event.workspaceId ? { workspaceId: event.workspaceId.toHexString() } : {}),
    actor: stringifyActor(event.actor),
    ...(event.effectiveContext ? { effectiveContext: event.effectiveContext } : {}),
    ...(event.supportSessionId ? { supportSessionId: event.supportSessionId.toHexString() } : {}),
    sensitive: Boolean(event.sensitive),
    entity: {
      type: event.entity.type,
      id: event.entity.id instanceof ObjectId ? event.entity.id.toHexString() : event.entity.id,
    },
    action: event.action,
    ...(sensitiveHidden
      ? { sensitiveDetailsRedacted: true }
      : {
          ...(event.before ? { before: event.before } : {}),
          ...(event.after ? { after: event.after } : {}),
          ...(event.diff ? { diff: event.diff } : {}),
          ...(event.reason ? { reason: event.reason } : {}),
        }),
    ...(event.ipAddress ? { ipAddress: event.ipAddress } : {}),
    ...(event.userAgent ? { userAgent: event.userAgent } : {}),
    correlationId: event.correlationId,
    occurredAt: event.occurredAt.toISOString(),
  };
}

function stringifyActor(actor: AuditEventDocument['actor']) {
  return {
    ...(actor.userId ? { userId: actor.userId.toHexString() } : {}),
    ...(actor.platformMembershipId
      ? { platformMembershipId: actor.platformMembershipId.toHexString() }
      : {}),
    ...(actor.workspaceMembershipId
      ? { workspaceMembershipId: actor.workspaceMembershipId.toHexString() }
      : {}),
  };
}

function encodeCursor(occurredAt: Date, id: ObjectId): string {
  return Buffer.from(
    JSON.stringify({ occurredAt: occurredAt.toISOString(), id: id.toHexString() }),
  ).toString('base64url');
}

function decodeCursor(cursor: string): AuditCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      occurredAt?: string;
      id?: string;
    };
    if (!parsed.occurredAt || !parsed.id) throw new Error('invalid');
    return {
      occurredAt: date(parsed.occurredAt, 'CURSOR_INVALID'),
      id: objectId(parsed.id, 'CURSOR_INVALID'),
    };
  } catch {
    throw invalid('CURSOR_INVALID', 'The audit cursor is invalid.');
  }
}

function pageLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 50, 1), 100);
}

function parseEntityId(value: string): ObjectId | string {
  return ObjectId.isValid(value) ? new ObjectId(value) : value;
}

function objectId(value: string, code: string): ObjectId {
  if (!ObjectId.isValid(value)) throw invalid(code, 'The identifier is invalid.');
  return new ObjectId(value);
}

function date(value: string, code: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw invalid(code, 'The timestamp must be an ISO UTC instant.');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw invalid(code, 'The timestamp is invalid.');
  return parsed;
}

function invalid(code: string, message: string): AppError {
  return new AppError({ code, httpStatus: 422, message });
}
