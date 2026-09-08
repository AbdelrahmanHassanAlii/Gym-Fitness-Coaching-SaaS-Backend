import { createHash } from 'node:crypto';
import { type Collection, MongoServerError } from 'mongodb';
import type { Database } from '../database/database';
import type { TransactionContext, UnitOfWork } from '../database/unit-of-work';
import { AppError } from '../errors/app-error';
import type { RequestContext } from '../request-context/request-context';

type IdempotencyState = 'PROCESSING' | 'COMPLETED' | 'FAILED';

interface IdempotencyRecordDocument {
  actorId: string;
  routeKey: string;
  key: string;
  requestHash: string;
  state: IdempotencyState;
  responseStatus?: number;
  responseBody?: unknown;
  resourceId?: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface IdempotencyResult<T> {
  statusCode: number;
  body: T;
  replayed: boolean;
}

export class IdempotencyService {
  private readonly records: Collection<IdempotencyRecordDocument>;
  private readonly processingStaleMs = 5 * 60 * 1000;

  constructor(database: Database) {
    this.records = database.db.collection<IdempotencyRecordDocument>('idempotency_records');
  }

  async run<T>(
    ctx: RequestContext,
    input: {
      key: string | undefined;
      routeKey: string;
      fingerprint: unknown;
      ttlMs?: number;
      operation: () => Promise<{ statusCode?: number; body: T; resourceId?: string }>;
    },
  ): Promise<IdempotencyResult<T>> {
    const record = this.buildRecord(ctx, input);

    const owned = await this.reserveOrRecover(record);
    if (!owned) return await this.resolveExisting<T>(record);

    try {
      const result = await input.operation();
      await this.complete(record, result.statusCode ?? 200, result.body, result.resourceId);
      return { statusCode: result.statusCode ?? 200, body: result.body, replayed: false };
    } catch (error) {
      await this.markFailed(record).catch(() => undefined);
      throw error;
    }
  }

  async runInTransaction<T>(
    ctx: RequestContext,
    input: {
      key: string | undefined;
      routeKey: string;
      fingerprint: unknown;
      unitOfWork: UnitOfWork;
      ttlMs?: number;
      operation: (
        tx: TransactionContext,
      ) => Promise<{ statusCode?: number; body: T; resourceId?: string }>;
    },
  ): Promise<IdempotencyResult<T>> {
    const record = this.buildRecord(ctx, input);

    const owned = await this.reserveOrRecover(record);
    if (!owned) return await this.resolveExisting<T>(record);

    try {
      const result = await input.unitOfWork.withTransaction(async (tx) => {
        const operationResult = await input.operation(tx);
        await this.completeWithinTransaction(
          record,
          operationResult.statusCode ?? 200,
          operationResult.body,
          tx,
          operationResult.resourceId,
        );
        return operationResult;
      });
      return { statusCode: result.statusCode ?? 200, body: result.body, replayed: false };
    } catch (error) {
      await this.markFailed(record).catch(() => undefined);
      throw error;
    }
  }

  async runInTransactionForActor<T>(
    actorId: string,
    input: {
      key: string | undefined;
      routeKey: string;
      fingerprint: unknown;
      unitOfWork: UnitOfWork;
      ttlMs?: number;
      operation: (
        tx: TransactionContext,
      ) => Promise<{ statusCode?: number; body: T; resourceId?: string }>;
    },
  ): Promise<IdempotencyResult<T>> {
    const record = this.buildRecordForActor(actorId, input);

    const owned = await this.reserveOrRecover(record);
    if (!owned) return await this.resolveExisting<T>(record);

    try {
      const result = await input.unitOfWork.withTransaction(async (tx) => {
        const operationResult = await input.operation(tx);
        await this.completeWithinTransaction(
          record,
          operationResult.statusCode ?? 200,
          operationResult.body,
          tx,
          operationResult.resourceId,
        );
        return operationResult;
      });
      return { statusCode: result.statusCode ?? 200, body: result.body, replayed: false };
    } catch (error) {
      await this.markFailed(record).catch(() => undefined);
      throw error;
    }
  }

  async completeWithinTransaction(
    identity: { actorId: string; routeKey: string; key: string; requestHash?: string },
    responseStatus: number,
    responseBody: unknown,
    tx: TransactionContext,
    resourceId?: string,
  ): Promise<void> {
    const result = await this.records.updateOne(
      {
        actorId: identity.actorId,
        routeKey: identity.routeKey,
        key: identity.key,
        state: 'PROCESSING',
        ...(identity.requestHash ? { requestHash: identity.requestHash } : {}),
      },
      {
        $set: {
          state: 'COMPLETED',
          responseStatus,
          responseBody,
          ...(resourceId ? { resourceId } : {}),
          updatedAt: new Date(),
        },
      },
      { session: tx.session },
    );
    if (result.modifiedCount !== 1) {
      throw new AppError({
        code: 'IDEMPOTENCY_COMPLETION_CONFLICT',
        httpStatus: 409,
        message: 'The idempotency command state changed before completion.',
      });
    }
  }

  private buildRecord(
    ctx: RequestContext,
    input: { key: string | undefined; routeKey: string; fingerprint: unknown; ttlMs?: number },
  ): IdempotencyRecordDocument {
    if (!input.key?.trim()) {
      throw new AppError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        httpStatus: 400,
        message: 'Idempotency-Key is required for this command.',
      });
    }
    if (!ctx.userId) {
      throw new AppError({
        code: 'AUTH_REQUIRED',
        httpStatus: 401,
        message: 'Authentication is required.',
      });
    }

    const now = new Date();
    return {
      actorId: ctx.userId,
      routeKey: input.routeKey,
      key: input.key.trim(),
      requestHash: fingerprint(input.fingerprint),
      state: 'PROCESSING',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? 24 * 60 * 60 * 1000)),
    };
  }

  private buildRecordForActor(
    actorId: string,
    input: { key: string | undefined; routeKey: string; fingerprint: unknown; ttlMs?: number },
  ): IdempotencyRecordDocument {
    if (!input.key?.trim()) {
      throw new AppError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        httpStatus: 400,
        message: 'Idempotency-Key is required for this command.',
      });
    }
    if (!actorId.trim()) {
      throw new AppError({
        code: 'IDEMPOTENCY_ACTOR_REQUIRED',
        httpStatus: 401,
        message: 'An idempotency actor is required.',
      });
    }

    const now = new Date();
    return {
      actorId: actorId.trim(),
      routeKey: input.routeKey,
      key: input.key.trim(),
      requestHash: fingerprint(input.fingerprint),
      state: 'PROCESSING',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? 24 * 60 * 60 * 1000)),
    };
  }

  private async reserveOrRecover(record: IdempotencyRecordDocument): Promise<boolean> {
    const reserved = await this.reserve(record);
    if (reserved) return true;
    return (await this.recoverFailed(record)) || (await this.recoverStaleProcessing(record));
  }

  private async reserve(record: IdempotencyRecordDocument): Promise<boolean> {
    try {
      await this.records.insertOne(record);
      return true;
    } catch (error) {
      if (
        (error instanceof MongoServerError && error.code === 11000) ||
        (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)
      ) {
        return false;
      }
      throw error;
    }
  }

  private async resolveExisting<T>(
    record: IdempotencyRecordDocument,
  ): Promise<IdempotencyResult<T>> {
    const existing = await this.records.findOne({
      actorId: record.actorId,
      routeKey: record.routeKey,
      key: record.key,
    });
    if (!existing) {
      throw new AppError({
        code: 'IDEMPOTENCY_CONFLICT',
        httpStatus: 409,
        message: 'The idempotency command state changed. Retry with the same key.',
      });
    }
    if (existing.requestHash !== record.requestHash) {
      throw new AppError({
        code: 'IDEMPOTENCY_KEY_REUSED',
        httpStatus: 409,
        message: 'The Idempotency-Key was already used with a different request.',
      });
    }
    if (existing.state === 'PROCESSING') {
      throw new AppError({
        code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        httpStatus: 409,
        message: 'The original idempotent request is still processing.',
      });
    }
    if (existing.state === 'COMPLETED') {
      return {
        statusCode: existing.responseStatus ?? 200,
        body: existing.responseBody as T,
        replayed: true,
      };
    }
    throw new AppError({
      code: 'IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED',
      httpStatus: 409,
      message: 'The previous idempotent attempt failed. Use a new Idempotency-Key.',
    });
  }

  private async recoverStaleProcessing(record: IdempotencyRecordDocument): Promise<boolean> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - this.processingStaleMs);
    const result = await this.records.updateOne(
      {
        actorId: record.actorId,
        routeKey: record.routeKey,
        key: record.key,
        requestHash: record.requestHash,
        state: 'PROCESSING',
        updatedAt: { $lte: staleBefore },
      },
      {
        $set: {
          updatedAt: now,
          expiresAt: record.expiresAt,
        },
      },
    );
    return result.modifiedCount === 1;
  }

  private async recoverFailed(record: IdempotencyRecordDocument): Promise<boolean> {
    const now = new Date();
    const result = await this.records.updateOne(
      {
        actorId: record.actorId,
        routeKey: record.routeKey,
        key: record.key,
        requestHash: record.requestHash,
        state: 'FAILED',
      },
      {
        $set: {
          state: 'PROCESSING',
          updatedAt: now,
          expiresAt: record.expiresAt,
        },
      },
    );
    return result.modifiedCount === 1;
  }

  private async complete(
    record: IdempotencyRecordDocument,
    responseStatus: number,
    responseBody: unknown,
    resourceId?: string,
  ): Promise<void> {
    await this.records.updateOne(
      { actorId: record.actorId, routeKey: record.routeKey, key: record.key, state: 'PROCESSING' },
      {
        $set: {
          state: 'COMPLETED',
          responseStatus,
          responseBody,
          ...(resourceId ? { resourceId } : {}),
          updatedAt: new Date(),
        },
      },
    );
  }

  private async markFailed(record: IdempotencyRecordDocument): Promise<void> {
    await this.records.updateOne(
      { actorId: record.actorId, routeKey: record.routeKey, key: record.key, state: 'PROCESSING' },
      { $set: { state: 'FAILED', updatedAt: new Date() } },
    );
  }
}

export function idempotencyKey(headers: Record<string, unknown>): string | undefined {
  const value = headers['idempotency-key'];
  return Array.isArray(value) ? value[0] : typeof value === 'string' ? value : undefined;
}

export function fingerprint(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

function stableStringify(input: unknown): string {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(stableStringify).join(',')}]`;
  const object = input as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}
