import { type Collection, type Filter, ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type {
  CreateLeadInput,
  LeadDocument,
  LeadStatus,
  UpdateLeadMetadataInput,
} from './lead.types';

export interface LeadListInput {
  status?: LeadStatus;
  customerInterest?: LeadDocument['customerInterest'];
  limit: number;
  cursor?: Date;
}

export class LeadRepository {
  private readonly leads: Collection<LeadDocument>;

  constructor(database: Database) {
    this.leads = database.db.collection<LeadDocument>('leads');
  }

  async create(input: CreateLeadInput, tx?: TransactionContext): Promise<LeadDocument> {
    const now = input.now ?? new Date();
    const lead: LeadDocument = {
      _id: new ObjectId(),
      customerInterest: input.customerInterest,
      phone: input.phone,
      normalizedPhone: input.normalizedPhone,
      email: input.email,
      normalizedEmail: input.normalizedEmail,
      status: 'NEW',
      createdAt: now,
      updatedAt: now,
      version: 0,
      ...compact({
        name: input.name,
        gymName: input.gymName,
        contactPerson: input.contactPerson,
        governorate: input.governorate,
        city: input.city,
        estimatedTrainees: input.estimatedTrainees,
        estimatedStaff: input.estimatedStaff,
        numberOfBranches: input.numberOfBranches,
        billingInterest: input.billingInterest,
        referralCode: input.referralCode,
        source: input.source,
        notes: input.notes,
      }),
    };

    await this.leads.insertOne(lead, tx ? { session: tx.session } : undefined);
    return lead;
  }

  async list(input: LeadListInput): Promise<LeadDocument[]> {
    const filter: Filter<LeadDocument> = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.customerInterest ? { customerInterest: input.customerInterest } : {}),
      ...(input.cursor ? { createdAt: { $lt: input.cursor } } : {}),
    };
    return await this.leads
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(input.limit)
      .toArray();
  }

  async findById(leadId: ObjectId, tx?: TransactionContext): Promise<LeadDocument | null> {
    return await this.leads.findOne({ _id: leadId }, tx ? { session: tx.session } : undefined);
  }

  async findPossibleDuplicates(
    input: { normalizedEmail: string; normalizedPhone: string; excludeLeadId?: ObjectId },
    tx?: TransactionContext,
  ): Promise<LeadDocument[]> {
    return await this.leads
      .find(
        {
          ...(input.excludeLeadId ? { _id: { $ne: input.excludeLeadId } } : {}),
          $or: [
            { normalizedEmail: input.normalizedEmail },
            { normalizedPhone: input.normalizedPhone },
          ],
        },
        tx ? { session: tx.session } : undefined,
      )
      .limit(25)
      .toArray();
  }

  async updateMetadata(
    leadId: ObjectId,
    expectedVersion: number,
    input: UpdateLeadMetadataInput,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<LeadDocument> {
    const result = await this.leads.findOneAndUpdate(
      {
        _id: leadId,
        version: expectedVersion,
        status: { $nin: ['CONVERTED', 'DUPLICATE'] },
      },
      {
        $set: { ...compact(input as Record<string, unknown>), updatedAt: now },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('LEAD_VERSION_CONFLICT');
    return result;
  }

  async transitionStatus(
    leadId: ObjectId,
    expectedVersion: number,
    from: LeadStatus[],
    to: LeadStatus,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<LeadDocument> {
    const result = await this.leads.findOneAndUpdate(
      { _id: leadId, version: expectedVersion, status: { $in: from } },
      { $set: { status: to, updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('LEAD_INVALID_TRANSITION');
    return result;
  }

  async correctDuplicate(
    leadId: ObjectId,
    expectedVersion: number,
    targetStatus: Exclude<LeadStatus, 'DUPLICATE'>,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<LeadDocument> {
    const result = await this.leads.findOneAndUpdate(
      {
        _id: leadId,
        version: expectedVersion,
        status: 'DUPLICATE',
        duplicatePreviousStatus: targetStatus,
      },
      {
        $set: { status: targetStatus, updatedAt: now },
        $unset: {
          duplicatePreviousStatus: '',
          duplicateMarkedAt: '',
          duplicateMarkedBy: '',
          mergedIntoLeadId: '',
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('LEAD_DUPLICATE_CORRECTION_INVALID');
    return result;
  }

  async markDuplicate(
    leadId: ObjectId,
    expectedVersion: number,
    actorId: ObjectId,
    input: { mergedIntoLeadId?: ObjectId; now?: Date } = {},
    tx?: TransactionContext,
  ): Promise<LeadDocument> {
    const now = input.now ?? new Date();
    const before = await this.leads.findOne(
      {
        _id: leadId,
        version: expectedVersion,
        status: { $nin: ['CONVERTED', 'DUPLICATE'] },
      },
      tx ? { session: tx.session } : undefined,
    );
    if (!before) throw conflict('LEAD_DUPLICATE_MARK_INVALID');

    const result = await this.leads.findOneAndUpdate(
      {
        _id: leadId,
        version: expectedVersion,
        status: before.status,
      },
      {
        $set: {
          status: 'DUPLICATE',
          duplicatePreviousStatus: before.status as Exclude<LeadStatus, 'DUPLICATE'>,
          duplicateMarkedAt: now,
          duplicateMarkedBy: actorId,
          updatedAt: now,
          ...(input.mergedIntoLeadId ? { mergedIntoLeadId: input.mergedIntoLeadId } : {}),
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('LEAD_DUPLICATE_MARK_INVALID');
    return result;
  }

  async guardMergeTarget(
    leadId: ObjectId,
    expectedVersion: number,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<LeadDocument> {
    const result = await this.leads.findOneAndUpdate(
      {
        _id: leadId,
        version: expectedVersion,
        status: { $ne: 'DUPLICATE' },
      },
      { $set: { updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('LEAD_MERGE_TARGET_VERSION_CONFLICT');
    return result;
  }

  async convert(
    leadId: ObjectId,
    expectedVersion: number,
    actorId: ObjectId,
    workspaceId: ObjectId,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<LeadDocument> {
    const result = await this.leads.findOneAndUpdate(
      {
        _id: leadId,
        version: expectedVersion,
        status: { $in: ['NEW', 'CONTACTED', 'QUALIFIED'] },
      },
      {
        $set: {
          status: 'CONVERTED',
          convertedWorkspaceId: workspaceId,
          convertedBy: actorId,
          convertedAt: now,
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) throw conflict('LEAD_CONVERSION_INVALID');
    return result;
  }

  async assertVersion(
    leadId: ObjectId,
    expectedVersion: number,
    tx?: TransactionContext,
  ): Promise<LeadDocument> {
    const lead = await this.leads.findOne(
      { _id: leadId, version: expectedVersion },
      tx ? { session: tx.session } : undefined,
    );
    if (!lead) throw conflict('LEAD_VERSION_CONFLICT');
    return lead;
  }
}

function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function conflict(code: string): AppError {
  return new AppError({
    code,
    httpStatus: 409,
    message: 'The lead command could not be applied.',
  });
}
