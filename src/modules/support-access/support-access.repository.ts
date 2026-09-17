import type { Collection, ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type {
  PortalAccessPolicyDocument,
  SupportAccessRequestDocument,
  SupportSessionDocument,
  SupportSessionStatus,
} from './support-access.types';

export class SupportAccessRepository {
  private readonly policies: Collection<PortalAccessPolicyDocument>;
  private readonly requests: Collection<SupportAccessRequestDocument>;
  private readonly sessions: Collection<SupportSessionDocument>;

  constructor(database: Database) {
    this.policies = database.db.collection<PortalAccessPolicyDocument>('portal_access_policies');
    this.requests = database.db.collection<SupportAccessRequestDocument>('support_access_requests');
    this.sessions = database.db.collection<SupportSessionDocument>('support_sessions');
  }

  async listPolicies(): Promise<PortalAccessPolicyDocument[]> {
    return await this.policies.find({}).sort({ createdAt: -1, _id: -1 }).toArray();
  }

  async findPolicyById(
    policyId: ObjectId,
    tx?: TransactionContext,
  ): Promise<PortalAccessPolicyDocument | null> {
    return await this.policies.findOne({ _id: policyId }, tx ? { session: tx.session } : undefined);
  }

  async findCandidatePolicies(
    platformMembershipId: ObjectId,
    tx?: TransactionContext,
  ): Promise<PortalAccessPolicyDocument[]> {
    return await this.policies
      .find(
        { platformMembershipId, enabled: true, archivedAt: { $exists: false } },
        tx ? { session: tx.session } : undefined,
      )
      .sort({ createdAt: -1, _id: -1 })
      .toArray();
  }

  async createPolicy(
    policy: PortalAccessPolicyDocument,
    tx?: TransactionContext,
  ): Promise<PortalAccessPolicyDocument> {
    await this.policies.insertOne(policy, tx ? { session: tx.session } : undefined);
    return policy;
  }

  async updatePolicy(
    policyId: ObjectId,
    expectedVersion: number,
    update: Partial<PortalAccessPolicyDocument>,
    tx?: TransactionContext,
  ): Promise<PortalAccessPolicyDocument> {
    const result = await this.policies.findOneAndUpdate(
      { _id: policyId, revision: expectedVersion, archivedAt: { $exists: false } },
      { $set: update, $inc: { revision: 1 } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('SUPPORT_POLICY_VERSION_CONFLICT');
    return result;
  }

  async disablePolicy(
    policyId: ObjectId,
    expectedVersion: number,
    update: { updatedBy: ObjectId; updatedAt: Date },
    tx?: TransactionContext,
  ): Promise<PortalAccessPolicyDocument> {
    const result = await this.policies.findOneAndUpdate(
      { _id: policyId, revision: expectedVersion, archivedAt: { $exists: false } },
      { $set: { enabled: false, ...update }, $inc: { revision: 1 } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('SUPPORT_POLICY_VERSION_CONFLICT');
    return result;
  }

  async archivePolicy(
    policyId: ObjectId,
    expectedVersion: number,
    update: { updatedBy: ObjectId; updatedAt: Date; archivedAt: Date },
    tx?: TransactionContext,
  ): Promise<PortalAccessPolicyDocument> {
    const result = await this.policies.findOneAndUpdate(
      { _id: policyId, revision: expectedVersion, archivedAt: { $exists: false } },
      { $set: { enabled: false, ...update }, $inc: { revision: 1 } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('SUPPORT_POLICY_VERSION_CONFLICT');
    return result;
  }

  async insertRequest(
    request: SupportAccessRequestDocument,
    tx?: TransactionContext,
  ): Promise<SupportAccessRequestDocument> {
    await this.requests.insertOne(request, tx ? { session: tx.session } : undefined);
    return request;
  }

  async insertSession(
    session: SupportSessionDocument,
    tx?: TransactionContext,
  ): Promise<SupportSessionDocument> {
    await this.sessions.insertOne(session, tx ? { session: tx.session } : undefined);
    return session;
  }

  async findSessionById(
    sessionId: ObjectId,
    tx?: TransactionContext,
  ): Promise<SupportSessionDocument | null> {
    return await this.sessions.findOne(
      { _id: sessionId },
      tx ? { session: tx.session } : undefined,
    );
  }

  async listSessions(): Promise<SupportSessionDocument[]> {
    return await this.sessions.find({}).sort({ startedAt: -1, _id: -1 }).limit(100).toArray();
  }

  async transitionSession(
    sessionId: ObjectId,
    expectedVersion: number,
    from: SupportSessionStatus[],
    status: SupportSessionStatus,
    input: {
      endedAt?: Date;
      revokedAt?: Date;
      terminationReason?: string;
      now: Date;
    },
    tx?: TransactionContext,
  ): Promise<SupportSessionDocument> {
    const result = await this.sessions.findOneAndUpdate(
      { _id: sessionId, status: { $in: from }, version: expectedVersion },
      {
        $set: {
          status,
          updatedAt: input.now,
          ...(input.endedAt ? { endedAt: input.endedAt } : {}),
          ...(input.revokedAt ? { revokedAt: input.revokedAt } : {}),
          ...(input.terminationReason ? { terminationReason: input.terminationReason } : {}),
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('SUPPORT_SESSION_VERSION_CONFLICT');
    return result;
  }

  async revokeActiveByPolicy(
    policyId: ObjectId,
    now: Date,
    reason: string,
    tx?: TransactionContext,
  ): Promise<SupportSessionDocument[]> {
    const active = await this.sessions
      .find({ policyId, status: 'ACTIVE' }, tx ? { session: tx.session } : undefined)
      .toArray();
    for (const session of active) {
      await this.sessions.updateOne(
        { _id: session._id, status: 'ACTIVE' },
        {
          $set: { status: 'REVOKED', revokedAt: now, terminationReason: reason, updatedAt: now },
          $inc: { version: 1 },
        },
        tx ? { session: tx.session } : undefined,
      );
    }
    return active;
  }

  async listExpiredActive(now: Date, limit: number): Promise<SupportSessionDocument[]> {
    return await this.sessions
      .find({ status: 'ACTIVE', expiresAt: { $lte: now } })
      .sort({ expiresAt: 1, _id: 1 })
      .limit(limit)
      .toArray();
  }

  async expireActive(
    sessionId: ObjectId,
    now: Date,
    tx?: TransactionContext,
  ): Promise<SupportSessionDocument | null> {
    return await this.sessions.findOneAndUpdate(
      { _id: sessionId, status: 'ACTIVE', expiresAt: { $lte: now } },
      {
        $set: {
          status: 'EXPIRED',
          endedAt: now,
          terminationReason: 'EXPIRED',
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
  }
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The support access state has changed.' });
}
