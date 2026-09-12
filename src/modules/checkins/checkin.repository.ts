import type { Collection, MongoServerError, ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type {
  CheckInAssignmentDocument,
  CheckInInstanceDocument,
  CheckInInstanceStatus,
  CheckInTemplateDocument,
  CheckInTemplateRevisionDocument,
} from './checkin.types';

export class CheckInRepository {
  private readonly templates: Collection<CheckInTemplateDocument>;
  private readonly revisions: Collection<CheckInTemplateRevisionDocument>;
  private readonly assignments: Collection<CheckInAssignmentDocument>;
  private readonly instances: Collection<CheckInInstanceDocument>;

  constructor(database: Database) {
    this.templates = database.db.collection<CheckInTemplateDocument>('checkin_templates');
    this.revisions = database.db.collection<CheckInTemplateRevisionDocument>(
      'checkin_template_revisions',
    );
    this.assignments = database.db.collection<CheckInAssignmentDocument>('checkin_assignments');
    this.instances = database.db.collection<CheckInInstanceDocument>('checkin_instances');
  }

  async listTemplates(input: {
    workspaceId: ObjectId;
    includeArchived?: boolean;
    limit?: number;
    afterId?: ObjectId;
  }) {
    return await this.templates
      .find({
        workspaceId: input.workspaceId,
        ...(input.includeArchived ? {} : { status: 'ACTIVE' }),
        ...(input.afterId ? { _id: { $gt: input.afterId } } : {}),
      })
      .sort({ _id: 1 })
      .limit(input.limit ?? 50)
      .toArray();
  }

  async createTemplate(
    template: CheckInTemplateDocument,
    revision: CheckInTemplateRevisionDocument,
    tx: TransactionContext,
  ) {
    try {
      await this.templates.insertOne(template, { session: tx.session });
      await this.revisions.insertOne(revision, { session: tx.session });
      return { template, revision };
    } catch (error) {
      if (isDuplicate(error)) throw conflict('CHECKIN_TEMPLATE_CONFLICT');
      throw error;
    }
  }

  async findTemplate(workspaceId: ObjectId, templateId: ObjectId, tx?: TransactionContext) {
    return await this.templates.findOne({ _id: templateId, workspaceId }, opts(tx));
  }

  async guardTemplateForUse(workspaceId: ObjectId, templateId: ObjectId, tx: TransactionContext) {
    const result = await this.templates.findOneAndUpdate(
      { _id: templateId, workspaceId, status: 'ACTIVE' },
      { $inc: { templateUseRevision: 1 } },
      { returnDocument: 'after', session: tx.session },
    );
    if (!result) throw conflict('CHECKIN_TEMPLATE_ARCHIVED');
    return result;
  }

  async latestRevision(templateId: ObjectId, tx: TransactionContext) {
    return await this.revisions.findOne(
      { templateId },
      { sort: { revision: -1 }, session: tx.session },
    );
  }

  async createRevision(input: {
    template: CheckInTemplateDocument;
    expectedVersion: number;
    revision: CheckInTemplateRevisionDocument;
    now: Date;
    tx: TransactionContext;
  }) {
    try {
      await this.revisions.insertOne(input.revision, { session: input.tx.session });
      const template = await this.templates.findOneAndUpdate(
        {
          _id: input.template._id,
          workspaceId: input.template.workspaceId,
          status: 'ACTIVE',
          version: input.expectedVersion,
        },
        {
          $set: {
            currentRevisionId: input.revision._id,
            updatedAt: input.now,
            updatedBy: input.revision.createdBy,
          },
          $inc: { version: 1 },
        },
        { returnDocument: 'after', session: input.tx.session },
      );
      if (!template) throw conflict('CHECKIN_TEMPLATE_VERSION_CONFLICT');
      return { template, revision: input.revision };
    } catch (error) {
      if (isDuplicate(error)) throw conflict('CHECKIN_TEMPLATE_REVISION_CONFLICT');
      throw error;
    }
  }

  async countActiveAssignmentsForTemplate(
    workspaceId: ObjectId,
    templateId: ObjectId,
    tx: TransactionContext,
  ) {
    return await this.assignments.countDocuments(
      { workspaceId, templateId, active: true },
      { session: tx.session },
    );
  }

  async archiveTemplate(input: {
    workspaceId: ObjectId;
    templateId: ObjectId;
    expectedVersion: number;
    actor: ObjectId;
    now: Date;
    tx: TransactionContext;
  }) {
    const template = await this.templates.findOneAndUpdate(
      {
        _id: input.templateId,
        workspaceId: input.workspaceId,
        status: 'ACTIVE',
        version: input.expectedVersion,
      },
      {
        $set: {
          status: 'ARCHIVED',
          archivedAt: input.now,
          updatedAt: input.now,
          updatedBy: input.actor,
        },
        $inc: { version: 1, templateUseRevision: 1 },
      },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!template) throw conflict('CHECKIN_TEMPLATE_VERSION_CONFLICT');
    return template;
  }

  async findRevisionById(templateRevisionId: ObjectId, tx?: TransactionContext) {
    return await this.revisions.findOne({ _id: templateRevisionId }, opts(tx));
  }

  async createAssignment(assignment: CheckInAssignmentDocument, tx: TransactionContext) {
    try {
      await this.assignments.insertOne(assignment, { session: tx.session });
      return assignment;
    } catch (error) {
      if (isDuplicate(error)) throw conflict('CHECKIN_ASSIGNMENT_CONFLICT');
      throw error;
    }
  }

  async listAssignments(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    includeInactive?: boolean;
    limit?: number;
    afterId?: ObjectId;
  }) {
    return await this.assignments
      .find({
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        ...(input.includeInactive ? {} : { active: true }),
        ...(input.afterId ? { _id: { $gt: input.afterId } } : {}),
      })
      .sort({ _id: 1 })
      .limit(input.limit ?? 50)
      .toArray();
  }

  async findAssignment(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    assignmentId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.assignments.findOne(
      { _id: assignmentId, workspaceId, relationshipId },
      opts(tx),
    );
  }

  async guardAssignmentForGeneration(assignmentId: ObjectId, tx: TransactionContext) {
    const result = await this.assignments.findOneAndUpdate(
      { _id: assignmentId, active: true },
      { $inc: { assignmentUseRevision: 1 } },
      { returnDocument: 'after', session: tx.session },
    );
    return result;
  }

  async updateAssignment(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    assignmentId: ObjectId;
    expectedVersion: number;
    patch: Partial<CheckInAssignmentDocument>;
    tx: TransactionContext;
  }) {
    const result = await this.assignments.findOneAndUpdate(
      {
        _id: input.assignmentId,
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        active: true,
        version: input.expectedVersion,
      },
      { $set: input.patch, $inc: { version: 1, assignmentUseRevision: 1 } },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!result) throw conflict('CHECKIN_ASSIGNMENT_VERSION_CONFLICT');
    return result;
  }

  async endAssignment(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    assignmentId: ObjectId;
    expectedVersion: number;
    actor: ObjectId;
    reason?: string;
    now: Date;
    tx: TransactionContext;
  }) {
    const result = await this.assignments.findOneAndUpdate(
      {
        _id: input.assignmentId,
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        active: true,
        version: input.expectedVersion,
      },
      {
        $set: {
          active: false,
          endedAt: input.now,
          endedBy: input.actor,
          updatedAt: input.now,
          updatedBy: input.actor,
          ...(input.reason ? { endReason: input.reason } : {}),
        },
        $inc: { version: 1, assignmentUseRevision: 1 },
      },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!result) throw conflict('CHECKIN_ASSIGNMENT_INACTIVE');
    return result;
  }

  async listGenerationCandidates(now: Date, limit: number) {
    return await this.assignments
      .find({ active: true, startedAt: { $lte: now } })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
  }

  async latestInstanceForAssignment(assignmentId: ObjectId, tx: TransactionContext) {
    return await this.instances.findOne(
      { assignmentId },
      { sort: { periodStartAt: -1, _id: -1 }, session: tx.session },
    );
  }

  async createInstance(instance: CheckInInstanceDocument, tx: TransactionContext) {
    try {
      await this.instances.insertOne(instance, { session: tx.session });
      return instance;
    } catch (error) {
      if (isDuplicate(error)) return null;
      throw error;
    }
  }

  async listInstances(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    limit?: number;
    cursor?: { dueAt: Date; id: ObjectId };
  }) {
    return await this.instances
      .find({
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        ...(input.cursor
          ? {
              $or: [
                { dueAt: { $lt: input.cursor.dueAt } },
                { dueAt: input.cursor.dueAt, _id: { $lt: input.cursor.id } },
              ],
            }
          : {}),
      })
      .sort({ dueAt: -1, _id: -1 })
      .limit(input.limit ?? 50)
      .toArray();
  }

  async findInstance(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    instanceId: ObjectId,
    tx?: TransactionContext,
  ) {
    return await this.instances.findOne({ _id: instanceId, workspaceId, relationshipId }, opts(tx));
  }

  async dueUpcoming(now: Date, limit: number) {
    return await this.instances
      .find({ status: 'UPCOMING', opensAt: { $lte: now } })
      .sort({ opensAt: 1, _id: 1 })
      .limit(limit)
      .toArray();
  }

  async promoteDue(instance: CheckInInstanceDocument, now: Date, tx: TransactionContext) {
    const result = await this.instances.findOneAndUpdate(
      { _id: instance._id, status: 'UPCOMING', version: instance.version },
      { $set: { status: 'DUE', updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after', session: tx.session },
    );
    return result;
  }

  async overdueDue(now: Date, limit: number) {
    return await this.instances
      .find({ status: 'DUE', dueAt: { $lte: now } })
      .sort({ dueAt: 1, _id: 1 })
      .limit(limit)
      .toArray();
  }

  async markOverdue(instance: CheckInInstanceDocument, now: Date, tx: TransactionContext) {
    const result = await this.instances.findOneAndUpdate(
      { _id: instance._id, status: 'DUE', version: instance.version },
      { $set: { status: 'OVERDUE', updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after', session: tx.session },
    );
    return result;
  }

  async submitInstance(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    instanceId: ObjectId;
    expectedVersion: number;
    responses: CheckInInstanceDocument['responses'];
    now: Date;
    tx: TransactionContext;
  }) {
    const result = await this.instances.findOneAndUpdate(
      {
        _id: input.instanceId,
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        status: { $in: ['DUE', 'OVERDUE'] },
        version: input.expectedVersion,
      },
      {
        $set: {
          responses: input.responses,
          status: 'SUBMITTED',
          submittedAt: input.now,
          updatedAt: input.now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!result) throw conflict('CHECKIN_NOT_SUBMITTABLE');
    return result;
  }

  async reviewInstance(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    instanceId: ObjectId;
    expectedVersion: number;
    feedback: CheckInInstanceDocument['trainerFeedback'];
    now: Date;
    tx: TransactionContext;
  }) {
    const result = await this.instances.findOneAndUpdate(
      {
        _id: input.instanceId,
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        status: 'SUBMITTED',
        version: input.expectedVersion,
      },
      {
        $set: {
          trainerFeedback: input.feedback as NonNullable<
            CheckInInstanceDocument['trainerFeedback']
          >,
          status: 'REVIEWED',
          reviewedAt: input.now,
          updatedAt: input.now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session: input.tx.session },
    );
    if (!result) throw conflict('CHECKIN_NOT_REVIEWABLE');
    return result;
  }

  async endActiveAssignmentsForRelationship(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    actor?: ObjectId;
    reason: string;
    now: Date;
    tx: TransactionContext;
  }) {
    await this.assignments.updateMany(
      { workspaceId: input.workspaceId, relationshipId: input.relationshipId, active: true },
      {
        $set: {
          active: false,
          endedAt: input.now,
          updatedAt: input.now,
          ...(input.actor ? { endedBy: input.actor, updatedBy: input.actor } : {}),
          endReason: input.reason,
        },
        $inc: { version: 1, assignmentUseRevision: 1 },
      },
      { session: input.tx.session },
    );
  }

  async skipOpenInstancesForRelationship(input: {
    workspaceId: ObjectId;
    relationshipId: ObjectId;
    actor?: ObjectId;
    reason: 'RELATIONSHIP_ENDED';
    now: Date;
    tx: TransactionContext;
  }) {
    await this.instances.updateMany(
      {
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        status: { $in: ['UPCOMING', 'DUE', 'OVERDUE'] as CheckInInstanceStatus[] },
      },
      {
        $set: {
          status: 'SKIPPED',
          updatedAt: input.now,
          skipMetadata: {
            reason: input.reason,
            skippedAt: input.now,
            ...(input.actor ? { skippedBy: input.actor } : {}),
          },
        },
        $inc: { version: 1 },
      },
      { session: input.tx.session },
    );
  }
}

function opts(tx?: TransactionContext) {
  return tx ? { session: tx.session } : undefined;
}

function isDuplicate(error: unknown): error is MongoServerError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The check-in state has changed.' });
}
