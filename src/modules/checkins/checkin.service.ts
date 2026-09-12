import { ObjectId } from 'mongodb';
import type { AccessControlService } from '../../core/access-control/access-control.service';
import type { AuditWriter } from '../../core/audit/audit.writer';
import type { TransactionContext, UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { OutboxWriter } from '../../core/events/outbox.writer';
import type { RequestContext } from '../../core/request-context/request-context';
import { Permissions } from '../permissions/permission.registry';
import type { EntitlementService } from '../subscriptions/subscription.service';
import type { CoachingRelationshipRepository } from '../trainees/trainee.repository';
import type { CoachingRelationshipDocument } from '../trainees/trainee.types';
import type { WorkspaceMembershipRepository } from '../workspaces/workspace.repository';
import type { CheckInRepository } from './checkin.repository';
import type {
  CheckInAssignmentDocument,
  CheckInFieldType,
  CheckInInstanceDocument,
  CheckInResponse,
  CheckInTemplateDocument,
  CheckInTemplateField,
  CheckInTemplateRevisionDocument,
} from './checkin.types';

type FieldInput = {
  fieldKey: string;
  type: string;
  label: string;
  required: boolean;
  validation?: Record<string, unknown>;
};

type CreateTemplateInput = { name: string; fields: FieldInput[] };
type RevisionInput = { expectedVersion: number; fields: FieldInput[] };
type AssignmentInput = {
  templateId: string;
  recurrence: { frequency: 'WEEKLY'; dayOfWeek?: number; timezone: string };
  startedAt?: string;
};
type AssignmentPatchInput = {
  expectedVersion: number;
  recurrence?: { frequency: 'WEEKLY'; dayOfWeek?: number; timezone: string };
};
type ExpectedVersionInput = { expectedVersion: number; reason?: string };
type SubmitInput = { expectedVersion: number; responses: CheckInResponse[] };
type ReviewInput = { expectedVersion: number; trainerFeedback: { comment: string } };

const supportedFieldTypes = new Set<string>(['NUMBER', 'TEXT', 'LONG_TEXT', 'RATING', 'BOOLEAN']);
const unsupportedFieldTypes = new Set<string>(['PHOTO', 'MEASUREMENT']);
const generationAssignmentBatchSize = 25;
const generationPerAssignmentLimit = 8;
const transitionBatchSize = 50;

export interface CheckInRelationshipLifecyclePort {
  closeCheckInsForRelationshipEnd(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ): Promise<void>;
}

export class CheckInApplicationService implements CheckInRelationshipLifecyclePort {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly checkins: CheckInRepository,
    private readonly relationships: CoachingRelationshipRepository,
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly accessControl: AccessControlService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async listTemplates(ctx: RequestContext, workspaceId: string, query: PageQuery) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.authorizeWorkspace(ctx, id, Permissions.CheckInTemplatesRead);
    await this.entitlements.assert(id, 'READ');
    return page(
      await this.checkins.listTemplates({
        workspaceId: id,
        ...defined('includeArchived', query.includeArchived),
        ...defined('limit', query.limit),
        ...defined('afterId', optionalObjectId(query.cursor, 'CURSOR_INVALID')),
      }),
      safeTemplate,
    );
  }

  async createTemplate(
    ctx: RequestContext,
    workspaceId: string,
    input: CreateTemplateInput,
    tx?: TransactionContext,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.authorizeWorkspace(ctx, id, Permissions.CheckInTemplatesCreate);
    await this.entitlements.assert(id, 'WRITE', 'checkins');
    const membership = await this.actorMembership(ctx, id);
    const now = new Date();
    const revisionId = new ObjectId();
    const template: CheckInTemplateDocument = {
      _id: new ObjectId(),
      workspaceId: id,
      ownerMembershipId: membership._id,
      name: text(input.name, 120, 'CHECKIN_TEMPLATE_NAME_INVALID'),
      normalizedName: text(input.name, 120, 'CHECKIN_TEMPLATE_NAME_INVALID').toLowerCase(),
      currentRevisionId: revisionId,
      status: 'ACTIVE',
      version: 0,
      templateUseRevision: 0,
      createdBy: actorId(ctx),
      updatedBy: actorId(ctx),
      createdAt: now,
      updatedAt: now,
    };
    const revision = buildRevision(ctx, id, template._id, revisionId, 1, input.fields, now);
    return await this.withTransaction(tx, async (tx) => {
      const created = await this.checkins.createTemplate(template, revision, tx);
      await this.writeAudit(ctx, id, 'CheckInTemplateCreated', template._id, 'create', tx);
      return { template: safeTemplate(created.template), revision: safeRevision(created.revision) };
    });
  }

  async getTemplate(ctx: RequestContext, workspaceId: string, templateId: string) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.authorizeWorkspace(ctx, id, Permissions.CheckInTemplatesRead);
    await this.entitlements.assert(id, 'READ');
    const template = await this.requireTemplate(id, templateId);
    const revision = await this.checkins.findRevisionById(template.currentRevisionId);
    return { template: safeTemplate(template), revision: revision ? safeRevision(revision) : null };
  }

  async createRevision(
    ctx: RequestContext,
    workspaceId: string,
    templateId: string,
    input: RevisionInput,
    tx?: TransactionContext,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.authorizeWorkspace(ctx, id, Permissions.CheckInTemplatesUpdate);
    await this.entitlements.assert(id, 'WRITE', 'checkins');
    const now = new Date();
    return await this.withTransaction(tx, async (tx) => {
      const template = await this.checkins.guardTemplateForUse(
        id,
        objectId(templateId, 'CHECKIN_TEMPLATE_NOT_FOUND'),
        tx,
      );
      if (template.version !== input.expectedVersion)
        throw conflict('CHECKIN_TEMPLATE_VERSION_CONFLICT');
      const latest = await this.checkins.latestRevision(template._id, tx);
      const revision = buildRevision(
        ctx,
        id,
        template._id,
        new ObjectId(),
        (latest?.revision ?? 0) + 1,
        input.fields,
        now,
      );
      const updated = await this.checkins.createRevision({
        template,
        expectedVersion: input.expectedVersion,
        revision,
        now,
        tx,
      });
      await this.writeAudit(
        ctx,
        id,
        'CheckInTemplateRevisionCreated',
        template._id,
        'create_revision',
        tx,
      );
      return { template: safeTemplate(updated.template), revision: safeRevision(updated.revision) };
    });
  }

  async archiveTemplate(
    ctx: RequestContext,
    workspaceId: string,
    templateId: string,
    input: ExpectedVersionInput,
    tx?: TransactionContext,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.authorizeWorkspace(ctx, id, Permissions.CheckInTemplatesArchive);
    await this.entitlements.assert(id, 'WRITE', 'checkins');
    const now = new Date();
    return await this.withTransaction(tx, async (tx) => {
      const guarded = await this.checkins.guardTemplateForUse(
        id,
        objectId(templateId, 'CHECKIN_TEMPLATE_NOT_FOUND'),
        tx,
      );
      if (guarded.version !== input.expectedVersion)
        throw conflict('CHECKIN_TEMPLATE_VERSION_CONFLICT');
      if ((await this.checkins.countActiveAssignmentsForTemplate(id, guarded._id, tx)) > 0) {
        throw conflict('CHECKIN_TEMPLATE_IN_USE');
      }
      const template = await this.checkins.archiveTemplate({
        workspaceId: id,
        templateId: guarded._id,
        expectedVersion: input.expectedVersion,
        actor: actorId(ctx),
        now,
        tx,
      });
      await this.writeAudit(ctx, id, 'CheckInTemplateArchived', template._id, 'archive', tx);
      return { template: safeTemplate(template) };
    });
  }

  async listAssignments(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    query: PageQuery,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.CheckInAssignmentsRead,
      'read',
    );
    await this.entitlements.assert(ids.workspaceId, 'READ');
    return page(
      await this.checkins.listAssignments({
        workspaceId: ids.workspaceId,
        relationshipId: ids.relationship._id,
        ...defined('includeInactive', query.includeArchived),
        ...defined('limit', query.limit),
        ...defined('afterId', optionalObjectId(query.cursor, 'CURSOR_INVALID')),
      }),
      safeAssignment,
    );
  }

  async createAssignment(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: AssignmentInput,
    tx?: TransactionContext,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.CheckInsAssign,
      'mutate',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'checkins');
    const now = new Date();
    const startedAt = input.startedAt
      ? date(input.startedAt, 'CHECKIN_ASSIGNMENT_START_INVALID')
      : now;
    return await this.withTransaction(tx, async (tx) => {
      const relationship = await this.relationships.guardCheckInLifecycleOpen(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      if (relationship.status !== 'ACTIVE') throw conflict('CHECKIN_RELATIONSHIP_NOT_ELIGIBLE');
      const template = await this.checkins.guardTemplateForUse(
        ids.workspaceId,
        objectId(input.templateId, 'CHECKIN_TEMPLATE_NOT_FOUND'),
        tx,
      );
      const assignment: CheckInAssignmentDocument = {
        _id: new ObjectId(),
        workspaceId: ids.workspaceId,
        relationshipId: relationship._id,
        templateId: template._id,
        recurrence: normalizeRecurrence(input.recurrence, startedAt),
        active: true,
        version: 0,
        assignmentUseRevision: 0,
        startedAt,
        createdBy: actorId(ctx),
        updatedBy: actorId(ctx),
        createdAt: now,
        updatedAt: now,
      };
      const created = await this.checkins.createAssignment(assignment, tx);
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        'CheckInAssignmentCreated',
        created._id,
        'create',
        tx,
      );
      return { assignment: safeAssignment(created) };
    });
  }

  async updateAssignment(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    assignmentId: string,
    input: AssignmentPatchInput,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.CheckInAssignmentsUpdate,
      'mutate',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'checkins');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      await this.relationships.guardCheckInLifecycleOpen(ids.relationship._id, ids.workspaceId, tx);
      const current = await this.requireAssignment(
        ids.workspaceId,
        ids.relationship._id,
        assignmentId,
        tx,
      );
      const patch: Partial<CheckInAssignmentDocument> = {
        updatedAt: now,
        updatedBy: actorId(ctx),
        ...(input.recurrence
          ? { recurrence: normalizeRecurrence(input.recurrence, current.startedAt) }
          : {}),
      };
      const updated = await this.checkins.updateAssignment({
        workspaceId: ids.workspaceId,
        relationshipId: ids.relationship._id,
        assignmentId: current._id,
        expectedVersion: input.expectedVersion,
        patch,
        tx,
      });
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        'CheckInAssignmentUpdated',
        updated._id,
        'update',
        tx,
      );
      return { assignment: safeAssignment(updated) };
    });
  }

  async endAssignment(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    assignmentId: string,
    input: ExpectedVersionInput,
    tx?: TransactionContext,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.CheckInAssignmentsEnd,
      'mutate',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'checkins');
    const now = new Date();
    return await this.withTransaction(tx, async (tx) => {
      await this.relationships.guardCheckInLifecycleOpen(ids.relationship._id, ids.workspaceId, tx);
      const ended = await this.checkins.endAssignment({
        workspaceId: ids.workspaceId,
        relationshipId: ids.relationship._id,
        assignmentId: objectId(assignmentId, 'CHECKIN_ASSIGNMENT_NOT_FOUND'),
        expectedVersion: input.expectedVersion,
        actor: actorId(ctx),
        ...defined('reason', input.reason?.trim()),
        now,
        tx,
      });
      await this.writeAudit(ctx, ids.workspaceId, 'CheckInAssignmentEnded', ended._id, 'end', tx);
      return { assignment: safeAssignment(ended) };
    });
  }

  async listInstances(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    query: PageQuery,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.CheckInsRead,
      'read',
    );
    await this.entitlements.assert(ids.workspaceId, 'READ');
    return page(
      await this.checkins.listInstances({
        workspaceId: ids.workspaceId,
        relationshipId: ids.relationship._id,
        ...defined('limit', query.limit),
        ...defined('cursor', query.cursor ? decodeInstanceCursor(query.cursor) : undefined),
      }),
      safeInstance,
      instanceCursor,
    );
  }

  async getInstance(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    checkinId: string,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.CheckInsRead,
      'read',
    );
    await this.entitlements.assert(ids.workspaceId, 'READ');
    const instance = await this.requireInstance(ids.workspaceId, ids.relationship._id, checkinId);
    return { checkin: safeInstance(instance) };
  }

  async submit(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    checkinId: string,
    input: SubmitInput,
    tx?: TransactionContext,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.CheckInsSubmit,
      'read',
    );
    if (!isTraineeSelf(ctx, ids.relationship)) throw forbidden();
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'checkins');
    const now = new Date();
    return await this.withTransaction(tx, async (tx) => {
      await this.relationships.guardCheckInLifecycleOpen(ids.relationship._id, ids.workspaceId, tx);
      const instance = await this.requireInstance(
        ids.workspaceId,
        ids.relationship._id,
        checkinId,
        tx,
      );
      if (instance.status === 'SUBMITTED' || instance.status === 'REVIEWED') {
        throw conflict('CHECKIN_ALREADY_SUBMITTED');
      }
      if (instance.status !== 'DUE' && instance.status !== 'OVERDUE') {
        throw conflict('CHECKIN_NOT_SUBMITTABLE');
      }
      if (instance.version !== input.expectedVersion)
        throw conflict('CHECKIN_INSTANCE_VERSION_CONFLICT');
      const revision = await this.requireRevision(instance.templateRevisionId, tx);
      const responses = validateResponses(input.responses, revision.fields);
      const submitted = await this.checkins.submitInstance({
        workspaceId: ids.workspaceId,
        relationshipId: ids.relationship._id,
        instanceId: instance._id,
        expectedVersion: input.expectedVersion,
        responses,
        now,
        tx,
      });
      await this.writeAudit(ctx, ids.workspaceId, 'CheckInSubmitted', submitted._id, 'submit', tx);
      await this.writeOutbox(ctx, ids.workspaceId, 'CheckInSubmitted', submitted, tx);
      return { checkin: safeInstance(submitted) };
    });
  }

  async review(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    checkinId: string,
    input: ReviewInput,
    tx?: TransactionContext,
  ) {
    const ids = await this.authorizedRelationship(
      ctx,
      workspaceId,
      relationshipId,
      Permissions.CheckInsReview,
      'mutate',
    );
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'checkins');
    const membership = await this.actorMembership(ctx, ids.workspaceId);
    if (isTraineeSelf(ctx, ids.relationship)) throw forbidden();
    const now = new Date();
    return await this.withTransaction(tx, async (tx) => {
      await this.relationships.guardCheckInLifecycleOpen(ids.relationship._id, ids.workspaceId, tx);
      const instance = await this.requireInstance(
        ids.workspaceId,
        ids.relationship._id,
        checkinId,
        tx,
      );
      if (instance.status === 'REVIEWED') throw conflict('CHECKIN_ALREADY_REVIEWED');
      if (instance.status !== 'SUBMITTED') throw conflict('CHECKIN_NOT_REVIEWABLE');
      if (instance.version !== input.expectedVersion)
        throw conflict('CHECKIN_INSTANCE_VERSION_CONFLICT');
      const reviewed = await this.checkins.reviewInstance({
        workspaceId: ids.workspaceId,
        relationshipId: ids.relationship._id,
        instanceId: instance._id,
        expectedVersion: input.expectedVersion,
        feedback: {
          comment: text(input.trainerFeedback.comment, 2000, 'CHECKIN_FEEDBACK_INVALID'),
          reviewedByMembershipId: membership._id,
        },
        now,
        tx,
      });
      await this.writeAudit(ctx, ids.workspaceId, 'CheckInReviewed', reviewed._id, 'review', tx);
      await this.writeOutbox(ctx, ids.workspaceId, 'CheckInReviewed', reviewed, tx);
      return { checkin: safeInstance(reviewed) };
    });
  }

  async generateDueInstances(now = new Date()) {
    const assignments = await this.checkins.listGenerationCandidates(
      now,
      generationAssignmentBatchSize,
    );
    let generated = 0;
    for (const assignment of assignments) {
      generated += await this.generateForAssignment(assignment._id, now);
    }
    generated += await this.promoteUpcoming(now);
    return { generated };
  }

  async markOverdue(now = new Date()) {
    const candidates = await this.checkins.overdueDue(now, transitionBatchSize);
    let marked = 0;
    for (const candidate of candidates) {
      await this.unitOfWork.withTransaction(async (tx) => {
        const relationship = await this.relationships.guardCheckInLifecycleOpen(
          candidate.relationshipId,
          candidate.workspaceId,
          tx,
        );
        if (relationship.status === 'ENDED') return;
        const updated = await this.checkins.markOverdue(candidate, now, tx);
        if (!updated) return;
        await this.writeAudit(
          systemCtx(),
          updated.workspaceId,
          'CheckInOverdue',
          updated._id,
          'overdue',
          tx,
        );
        await this.writeOutbox(systemCtx(), updated.workspaceId, 'CheckInOverdue', updated, tx);
        marked++;
      });
    }
    return { marked };
  }

  async closeCheckInsForRelationshipEnd(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ): Promise<void> {
    await this.relationships.guardCheckInLifecycleOpen(relationshipId, workspaceId, tx);
    await this.checkins.endActiveAssignmentsForRelationship({
      workspaceId,
      relationshipId,
      ...defined(
        'actor',
        ctx.userId && ObjectId.isValid(ctx.userId) ? new ObjectId(ctx.userId) : undefined,
      ),
      reason: 'RELATIONSHIP_ENDED',
      now,
      tx,
    });
    await this.checkins.skipOpenInstancesForRelationship({
      workspaceId,
      relationshipId,
      ...defined(
        'actor',
        ctx.userId && ObjectId.isValid(ctx.userId) ? new ObjectId(ctx.userId) : undefined,
      ),
      reason: 'RELATIONSHIP_ENDED',
      now,
      tx,
    });
    await this.writeAudit(
      ctx,
      workspaceId,
      'CheckInsSkippedForRelationshipEnd',
      relationshipId,
      'skip_open',
      tx,
    );
  }

  private async generateForAssignment(assignmentId: ObjectId, now: Date) {
    let count = 0;
    for (let i = 0; i < generationPerAssignmentLimit; i++) {
      const created = await this.unitOfWork.withTransaction(async (tx) => {
        const assignment = await this.checkins.guardAssignmentForGeneration(assignmentId, tx);
        if (!assignment) return false;
        const relationship = await this.relationships.guardCheckInLifecycleOpen(
          assignment.relationshipId,
          assignment.workspaceId,
          tx,
        );
        if (relationship.status === 'ENDED') return false;
        const template = await this.checkins.guardTemplateForUse(
          assignment.workspaceId,
          assignment.templateId,
          tx,
        );
        const latest = await this.checkins.latestInstanceForAssignment(assignment._id, tx);
        const periods = eligiblePeriods(assignment, latest?.periodStartAt, now);
        const next = periods[0];
        if (!next) return false;
        const instance: CheckInInstanceDocument = {
          _id: new ObjectId(),
          workspaceId: assignment.workspaceId,
          relationshipId: assignment.relationshipId,
          assignmentId: assignment._id,
          templateId: assignment.templateId,
          templateRevisionId: template.currentRevisionId,
          ...next,
          status: now < next.opensAt ? 'UPCOMING' : now >= next.dueAt ? 'OVERDUE' : 'DUE',
          responses: [],
          version: 0,
          createdAt: now,
          updatedAt: now,
        };
        const inserted = await this.checkins.createInstance(instance, tx);
        if (!inserted) return false;
        await this.writeAudit(
          systemCtx(),
          assignment.workspaceId,
          'CheckInGenerated',
          inserted._id,
          'generate',
          tx,
        );
        if (inserted.status === 'DUE')
          await this.writeOutbox(systemCtx(), assignment.workspaceId, 'CheckInDue', inserted, tx);
        if (inserted.status === 'OVERDUE')
          await this.writeOutbox(
            systemCtx(),
            assignment.workspaceId,
            'CheckInOverdue',
            inserted,
            tx,
          );
        return true;
      });
      if (!created) break;
      count++;
    }
    return count;
  }

  private async withTransaction<T>(
    tx: TransactionContext | undefined,
    operation: (tx: TransactionContext) => Promise<T>,
  ) {
    if (tx) return await operation(tx);
    return await this.unitOfWork.withTransaction(operation);
  }

  private async promoteUpcoming(now: Date) {
    const candidates = await this.checkins.dueUpcoming(now, transitionBatchSize);
    let promoted = 0;
    for (const candidate of candidates) {
      await this.unitOfWork.withTransaction(async (tx) => {
        await this.relationships.guardCheckInLifecycleOpen(
          candidate.relationshipId,
          candidate.workspaceId,
          tx,
        );
        const updated = await this.checkins.promoteDue(candidate, now, tx);
        if (!updated) return;
        await this.writeAudit(
          systemCtx(),
          updated.workspaceId,
          'CheckInDue',
          updated._id,
          'due',
          tx,
        );
        await this.writeOutbox(systemCtx(), updated.workspaceId, 'CheckInDue', updated, tx);
        promoted++;
      });
    }
    return promoted;
  }

  private async authorizedRelationship(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    permission: string,
    action: 'read' | 'mutate',
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relationship = await this.relationships.findByIdInWorkspace(
      id,
      objectId(relationshipId, 'RELATIONSHIP_NOT_FOUND'),
    );
    if (!relationship) throw notFound('RELATIONSHIP_NOT_FOUND');
    await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId: id,
      permission,
      scope: { type: 'WORKSPACE' },
    });
    const membership = await this.actorMembership(ctx, id);
    if (isTraineeSelf(ctx, relationship)) {
      if (action === 'read') return { workspaceId: id, relationship };
      throw forbidden();
    }
    if (membership.roles.includes('TRAINEE')) throw forbidden();
    const assignments = await this.relationships.listActiveAssignments(relationship._id);
    const assigned = assignments.some(
      (assignment) =>
        assignment.staffMembershipId.equals(membership._id) &&
        ['PRIMARY_TRAINER', 'ASSISTANT_TRAINER', 'NUTRITIONIST'].includes(
          assignment.assignmentType,
        ),
    );
    if (assigned) return { workspaceId: id, relationship };
    if (membership.roles.includes('GYM_OWNER') || membership.roles.includes('GYM_MANAGER'))
      return { workspaceId: id, relationship };
    throw forbidden();
  }

  private async actorMembership(
    ctx: RequestContext,
    workspaceId: ObjectId,
    tx?: TransactionContext,
  ) {
    const membership = await this.memberships.findByUserInWorkspace(workspaceId, actorId(ctx), tx);
    if (membership?.status !== 'ACTIVE') throw forbidden();
    ctx.workspaceMembershipId = membership._id.toHexString();
    return membership;
  }

  private async authorizeWorkspace(ctx: RequestContext, workspaceId: ObjectId, permission: string) {
    return await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId,
      permission,
      scope: { type: 'WORKSPACE' },
    });
  }

  private async requireTemplate(
    workspaceId: ObjectId,
    templateId: string,
    tx?: TransactionContext,
  ) {
    const template = await this.checkins.findTemplate(
      workspaceId,
      objectId(templateId, 'CHECKIN_TEMPLATE_NOT_FOUND'),
      tx,
    );
    if (!template) throw notFound('CHECKIN_TEMPLATE_NOT_FOUND');
    return template;
  }

  private async requireAssignment(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    assignmentId: string,
    tx?: TransactionContext,
  ) {
    const assignment = await this.checkins.findAssignment(
      workspaceId,
      relationshipId,
      objectId(assignmentId, 'CHECKIN_ASSIGNMENT_NOT_FOUND'),
      tx,
    );
    if (!assignment) throw notFound('CHECKIN_ASSIGNMENT_NOT_FOUND');
    return assignment;
  }

  private async requireInstance(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    checkinId: string,
    tx?: TransactionContext,
  ) {
    const instance = await this.checkins.findInstance(
      workspaceId,
      relationshipId,
      objectId(checkinId, 'CHECKIN_INSTANCE_NOT_FOUND'),
      tx,
    );
    if (!instance) throw notFound('CHECKIN_INSTANCE_NOT_FOUND');
    return instance;
  }

  private async requireRevision(templateRevisionId: ObjectId, tx: TransactionContext) {
    const revision = await this.checkins.findRevisionById(templateRevisionId, tx);
    if (!revision) throw conflict('CHECKIN_TEMPLATE_REVISION_CONFLICT');
    return revision;
  }

  private async writeAudit(
    ctx: RequestContext,
    workspaceId: ObjectId,
    eventType: string,
    entityId: ObjectId,
    action: string,
    tx: TransactionContext,
  ) {
    await this.audit.write(
      {
        eventType,
        workspaceId,
        actor: {
          ...(ctx.userId && ObjectId.isValid(ctx.userId)
            ? { userId: new ObjectId(ctx.userId) }
            : {}),
          ...(ctx.workspaceMembershipId && ObjectId.isValid(ctx.workspaceMembershipId)
            ? { workspaceMembershipId: new ObjectId(ctx.workspaceMembershipId) }
            : {}),
        },
        entity: { type: eventType, id: entityId },
        action,
        ipAddress: ctx.ipAddress,
        ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }

  private async writeOutbox(
    ctx: RequestContext,
    workspaceId: ObjectId,
    eventType: string,
    instance: CheckInInstanceDocument,
    tx: TransactionContext,
  ) {
    await this.outbox.write(
      {
        eventType,
        aggregateType: 'checkin_instance',
        aggregateId: instance._id,
        workspaceId,
        payload: {
          relationshipId: instance.relationshipId.toHexString(),
          assignmentId: instance.assignmentId.toHexString(),
          checkinId: instance._id.toHexString(),
          templateId: instance.templateId.toHexString(),
          templateRevisionId: instance.templateRevisionId.toHexString(),
          status: instance.status,
          periodKey: instance.periodKey,
          dueAt: instance.dueAt.toISOString(),
        },
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }
}

function buildRevision(
  ctx: RequestContext,
  workspaceId: ObjectId,
  templateId: ObjectId,
  revisionId: ObjectId,
  revision: number,
  fields: FieldInput[],
  now: Date,
): CheckInTemplateRevisionDocument {
  return {
    _id: revisionId,
    workspaceId,
    templateId,
    revision,
    fields: validateFields(fields),
    createdBy: actorId(ctx),
    createdAt: now,
  };
}

function validateFields(fields: FieldInput[]): CheckInTemplateField[] {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 50) {
    throw invalid('CHECKIN_FIELDS_INVALID');
  }
  const keys = new Set<string>();
  return fields.map((field) => {
    const key = text(field.fieldKey, 80, 'CHECKIN_FIELD_KEY_INVALID');
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw invalid('CHECKIN_FIELD_KEY_INVALID');
    if (keys.has(key)) throw invalid('CHECKIN_FIELD_KEY_DUPLICATE');
    keys.add(key);
    if (unsupportedFieldTypes.has(field.type)) throw invalid('CHECKIN_FIELD_TYPE_NOT_SUPPORTED');
    if (!supportedFieldTypes.has(field.type)) throw invalid('CHECKIN_FIELD_TYPE_NOT_SUPPORTED');
    return {
      fieldKey: key,
      type: field.type as CheckInFieldType,
      label: text(field.label, 200, 'CHECKIN_FIELD_LABEL_INVALID'),
      required: Boolean(field.required),
      ...(field.validation
        ? { validation: validateFieldValidation(field.type, field.validation) }
        : {}),
    };
  });
}

function validateFieldValidation(type: string, validation: Record<string, unknown>) {
  const allowed =
    type === 'NUMBER' || type === 'RATING'
      ? new Set(['min', 'max'])
      : type === 'TEXT' || type === 'LONG_TEXT'
        ? new Set(['minLength', 'maxLength'])
        : new Set<string>();
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(validation)) {
    if (!allowed.has(key) || typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalid('CHECKIN_FIELD_VALIDATION_UNSUPPORTED');
    }
    out[key] = value;
  }
  if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
    throw invalid('CHECKIN_FIELD_VALIDATION_INVALID');
  }
  if (out.minLength !== undefined && out.maxLength !== undefined && out.minLength > out.maxLength) {
    throw invalid('CHECKIN_FIELD_VALIDATION_INVALID');
  }
  return out;
}

function validateResponses(input: CheckInResponse[], fields: CheckInTemplateField[]) {
  if (!Array.isArray(input)) throw invalid('CHECKIN_INVALID_RESPONSES');
  const fieldMap = new Map(fields.map((field) => [field.fieldKey, field]));
  const responses = new Map<string, CheckInResponse>();
  for (const response of input) {
    const field = fieldMap.get(response.fieldKey);
    if (!field || responses.has(response.fieldKey)) throw invalid('CHECKIN_INVALID_RESPONSES');
    responses.set(response.fieldKey, {
      fieldKey: response.fieldKey,
      value: validateValue(field, response.value),
    });
  }
  for (const field of fields) {
    if (field.required && !responses.has(field.fieldKey))
      throw invalid('CHECKIN_INVALID_RESPONSES');
  }
  return [...responses.values()];
}

function validateValue(field: CheckInTemplateField, value: unknown) {
  if (value === null || value === undefined) {
    if (field.required) throw invalid('CHECKIN_INVALID_RESPONSES');
    return null;
  }
  if (field.type === 'BOOLEAN') {
    if (typeof value !== 'boolean') throw invalid('CHECKIN_INVALID_RESPONSES');
    return value;
  }
  if (field.type === 'NUMBER' || field.type === 'RATING') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw invalid('CHECKIN_INVALID_RESPONSES');
    if (field.validation?.min !== undefined && value < field.validation.min)
      throw invalid('CHECKIN_INVALID_RESPONSES');
    if (field.validation?.max !== undefined && value > field.validation.max)
      throw invalid('CHECKIN_INVALID_RESPONSES');
    return value;
  }
  if (typeof value !== 'string') throw invalid('CHECKIN_INVALID_RESPONSES');
  const limit = field.type === 'LONG_TEXT' ? 5000 : 500;
  if (value.length > limit) throw invalid('CHECKIN_INVALID_RESPONSES');
  if (field.validation?.minLength !== undefined && value.length < field.validation.minLength)
    throw invalid('CHECKIN_INVALID_RESPONSES');
  if (field.validation?.maxLength !== undefined && value.length > field.validation.maxLength)
    throw invalid('CHECKIN_INVALID_RESPONSES');
  return value;
}

function normalizeRecurrence(
  recurrence: { frequency: 'WEEKLY'; dayOfWeek?: number; timezone: string },
  startedAt: Date,
) {
  if (recurrence.frequency !== 'WEEKLY') throw invalid('CHECKIN_RECURRENCE_INVALID');
  const timezone = iana(recurrence.timezone);
  const dayOfWeek = recurrence.dayOfWeek ?? localIsoWeekday(startedAt, timezone);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
    throw invalid('CHECKIN_DAY_OF_WEEK_INVALID');
  }
  return { frequency: 'WEEKLY' as const, dayOfWeek, timezone };
}

function eligiblePeriods(
  assignment: CheckInAssignmentDocument,
  latestPeriodStartAt: Date | undefined,
  now: Date,
) {
  const first = latestPeriodStartAt
    ? addLocalDays(latestPeriodStartAt, 7, assignment.recurrence.timezone)
    : periodStartFor(assignment.startedAt, assignment.recurrence.timezone);
  const out = [];
  let cursor = first;
  for (let i = 0; i < generationPerAssignmentLimit; i++) {
    const snapshot = periodSnapshot(
      cursor,
      assignment.recurrence.dayOfWeek,
      assignment.recurrence.timezone,
    );
    if (!latestPeriodStartAt && snapshot.dueAt < assignment.startedAt) {
      cursor = addLocalDays(cursor, 7, assignment.recurrence.timezone);
      continue;
    }
    if (snapshot.opensAt.getTime() > now.getTime() + 7 * 24 * 60 * 60 * 1000) break;
    out.push(snapshot);
    if (snapshot.periodStartAt > now) break;
    cursor = addLocalDays(cursor, 7, assignment.recurrence.timezone);
  }
  return out;
}

function periodSnapshot(periodStartAt: Date, dayOfWeek: number, timezone: string) {
  const periodEndAt = addLocalDays(periodStartAt, 7, timezone);
  const dueAt = addLocalDays(periodStartAt, dayOfWeek, timezone);
  return {
    periodKey: isoWeekKey(periodStartAt, timezone),
    periodStartAt,
    periodEndAt,
    opensAt: periodStartAt,
    dueAt,
    timezone,
    dayOfWeek,
  };
}

function periodStartFor(date: Date, timezone: string) {
  const parts = localParts(date, timezone);
  const localMidnight = utcFromLocal(timezone, parts.year, parts.month, parts.day);
  return addLocalDays(localMidnight, 1 - localIsoWeekday(date, timezone), timezone);
}

function addLocalDays(date: Date, days: number, timezone: string) {
  const parts = localParts(date, timezone);
  return utcFromLocal(timezone, parts.year, parts.month, parts.day + days);
}

function isoWeekKey(periodStartAt: Date, timezone: string) {
  const parts = localParts(addLocalDays(periodStartAt, 3, timezone), timezone);
  const jan4 = utcFromLocal(timezone, parts.year, 1, 4);
  const firstMonday = periodStartFor(jan4, timezone);
  const start = localParts(periodStartAt, timezone);
  const first = localParts(firstMonday, timezone);
  const week =
    Math.floor(
      (Date.UTC(start.year, start.month - 1, start.day) -
        Date.UTC(first.year, first.month - 1, first.day)) /
        (7 * 24 * 60 * 60 * 1000),
    ) + 1;
  return `${parts.year}-W${String(week).padStart(2, '0')}`;
}

function localIsoWeekday(date: Date, timezone: string) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(
    date,
  );
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[weekday as 'Mon'] ?? 1;
}

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const hour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
    second: get('second'),
  };
}

function utcFromLocal(timezone: string, year: number, month: number, day: number) {
  let guess = new Date(Date.UTC(year, month - 1, day));
  for (let i = 0; i < 4; i++) {
    const parts = localParts(guess, timezone);
    const delta =
      Date.UTC(year, month - 1, day) -
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    if (delta === 0) return guess;
    guess = new Date(guess.getTime() + delta);
  }
  return guess;
}

function iana(timezone: string) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw invalid('CHECKIN_TIMEZONE_INVALID');
  }
}

function safeTemplate(template: CheckInTemplateDocument) {
  return {
    id: template._id.toHexString(),
    workspaceId: template.workspaceId.toHexString(),
    ownerMembershipId: template.ownerMembershipId.toHexString(),
    name: template.name,
    currentRevisionId: template.currentRevisionId.toHexString(),
    status: template.status,
    version: template.version,
  };
}

function safeRevision(revision: CheckInTemplateRevisionDocument) {
  return {
    id: revision._id.toHexString(),
    templateId: revision.templateId.toHexString(),
    revision: revision.revision,
    fields: revision.fields,
  };
}

function safeAssignment(assignment: CheckInAssignmentDocument) {
  return {
    id: assignment._id.toHexString(),
    workspaceId: assignment.workspaceId.toHexString(),
    relationshipId: assignment.relationshipId.toHexString(),
    templateId: assignment.templateId.toHexString(),
    recurrence: assignment.recurrence,
    active: assignment.active,
    startedAt: assignment.startedAt.toISOString(),
    endedAt: assignment.endedAt?.toISOString(),
    version: assignment.version,
  };
}

function safeInstance(instance: CheckInInstanceDocument) {
  return {
    id: instance._id.toHexString(),
    workspaceId: instance.workspaceId.toHexString(),
    relationshipId: instance.relationshipId.toHexString(),
    assignmentId: instance.assignmentId.toHexString(),
    templateId: instance.templateId.toHexString(),
    templateRevisionId: instance.templateRevisionId.toHexString(),
    periodKey: instance.periodKey,
    periodStartAt: instance.periodStartAt.toISOString(),
    periodEndAt: instance.periodEndAt.toISOString(),
    opensAt: instance.opensAt.toISOString(),
    dueAt: instance.dueAt.toISOString(),
    timezone: instance.timezone,
    dayOfWeek: instance.dayOfWeek,
    status: instance.status,
    submittedAt: instance.submittedAt?.toISOString(),
    reviewedAt: instance.reviewedAt?.toISOString(),
    responses: instance.responses,
    trainerFeedback: instance.trainerFeedback
      ? {
          comment: instance.trainerFeedback.comment,
          reviewedByMembershipId: instance.trainerFeedback.reviewedByMembershipId.toHexString(),
        }
      : undefined,
    skipMetadata: instance.skipMetadata,
    version: instance.version,
  };
}

function page<T, R>(items: T[], map: (item: T) => R, cursor?: (item: T) => string) {
  return {
    data: items.map(map),
    nextCursor: items.at(-1) ? (cursor ?? idCursor)(items.at(-1) as never) : undefined,
  };
}

function idCursor(item: { _id: ObjectId }) {
  return item._id.toHexString();
}

function instanceCursor(item: CheckInInstanceDocument) {
  return `${item.dueAt.toISOString()}_${item._id.toHexString()}`;
}

function decodeInstanceCursor(value: string) {
  const [iso, id] = value.split('_');
  return { dueAt: date(iso ?? '', 'CURSOR_INVALID'), id: objectId(id ?? '', 'CURSOR_INVALID') };
}

function text(value: string, max: number, code: string) {
  if (typeof value !== 'string') throw invalid(code);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw invalid(code);
  return trimmed;
}

function date(value: string, code: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw invalid(code);
  return parsed;
}

function isTraineeSelf(ctx: RequestContext, relationship: CoachingRelationshipDocument) {
  return Boolean(
    ctx.userId &&
      ObjectId.isValid(ctx.userId) &&
      relationship.traineeUserId.equals(new ObjectId(ctx.userId)),
  );
}

function actorId(ctx: RequestContext) {
  if (!ctx.userId || !ObjectId.isValid(ctx.userId)) throw forbidden();
  return new ObjectId(ctx.userId);
}

function objectId(value: string, code: string) {
  if (!ObjectId.isValid(value)) throw notFound(code);
  return new ObjectId(value);
}

function optionalObjectId(value: string | undefined, code: string) {
  return value ? objectId(value, code) : undefined;
}

function systemCtx(): RequestContext {
  return { correlationId: 'stage12-worker', ipAddress: 'system', locale: 'en', timezone: 'UTC' };
}

function defined<T, K extends string>(key: K, value: T | undefined): Partial<Record<K, T>> {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]: T });
}

function invalid(code: string) {
  return new AppError({ code, httpStatus: 422, message: 'The check-in request is invalid.' });
}

function conflict(code: string) {
  return new AppError({ code, httpStatus: 409, message: 'The check-in state has changed.' });
}

function notFound(code: string) {
  return new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
}

function forbidden() {
  return new AppError({
    code: 'PERMISSION_DENIED',
    httpStatus: 403,
    message: 'Permission denied.',
  });
}

interface PageQuery {
  cursor?: string;
  limit?: number;
  includeArchived?: boolean;
}
