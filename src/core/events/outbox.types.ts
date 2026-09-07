import type { ObjectId } from 'mongodb';

export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED';

export interface OutboxEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: ObjectId | string;
  workspaceId?: ObjectId;
  payload: Record<string, unknown>;
  correlationId: string;
  occurredAt?: Date;
}

export interface OutboxEventDocument extends OutboxEventInput {
  _id?: ObjectId;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt?: Date;
  lockedBy?: string;
  lockedUntil?: Date;
  lastError?: string;
  occurredAt: Date;
  processedAt?: Date;
}
