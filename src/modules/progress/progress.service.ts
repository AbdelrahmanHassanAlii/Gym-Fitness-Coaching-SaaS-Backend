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
import type {
  WorkspaceMembershipRepository,
  WorkspaceRepository,
} from '../workspaces/workspace.repository';
import type { WorkspaceMembershipDocument } from '../workspaces/workspace.types';
import type { ProgressRepository } from './progress.repository';
import type {
  AdherenceConfigDocument,
  AdherenceMetricKey,
  CoachingNoteDocument,
  DailyMetricValues,
  DailyTrackingEntryDocument,
  MeasurementEntryDocument,
  MeasurementSource,
  MetricDefinitionDocument,
  MetricValueType,
  NoteVisibility,
  TraineeHealthProfileDocument,
} from './progress.types';
import { AdherenceMetricKeys } from './progress.types';

type PageQuery = {
  cursor?: string;
  limit?: number;
  includeArchived?: boolean;
  metricDefinitionId?: string;
};

type MetricInput = {
  scope?: 'GYM' | 'PRIVATE';
  key?: string;
  name: string;
  valueType: MetricValueType;
  unit: string;
  category: string;
};

type MetricPatchInput = {
  expectedVersion: number;
  key?: string;
  name?: string;
  category?: string;
};

type MeasurementInput = {
  metricDefinitionId: string;
  value: number;
  measuredAt: string;
  source: MeasurementSource;
  notes?: string;
};

type MeasurementPatchInput = Partial<Omit<MeasurementInput, 'metricDefinitionId'>> & {
  expectedVersion: number;
};

type HealthInput = {
  expectedVersion?: number;
  injuries?: string[];
  physicalLimitations?: string[];
  foodAllergies?: string[];
  medications?: string[];
  medicalNotes?: string;
  emergencyNotes?: string;
};

type NoteInput = {
  category: string;
  visibility?: NoteVisibility;
  content: string;
  sensitive?: boolean;
};

type NotePatchInput = Partial<NoteInput> & { expectedVersion: number };

type AdherenceConfigInput = {
  expectedVersion?: number;
  enabledMetrics: AdherenceMetricKey[];
};

type DailyTrackingInput = {
  expectedVersion?: number;
  values: DailyMetricValues;
  reason?: string;
};

export class ProgressApplicationService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly progress: ProgressRepository,
    private readonly relationships: CoachingRelationshipRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly accessControl: AccessControlService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async listMetricDefinitions(ctx: RequestContext, workspaceId: string, query: PageQuery) {
    const ids = await this.workspaceAccess(ctx, workspaceId, Permissions.MetricDefinitionsRead);
    await this.entitlements.assert(ids.workspaceId, 'READ');
    return page(
      await this.progress.listMetricDefinitions({
        workspaceId: ids.workspaceId,
        ownerMembershipId: ids.membership._id,
        ...(query.includeArchived !== undefined ? { includeArchived: query.includeArchived } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor ? { afterId: objectId(query.cursor, 'CURSOR_INVALID') } : {}),
      }),
      safeMetricDefinition,
    );
  }

  async createMetricDefinition(ctx: RequestContext, workspaceId: string, input: MetricInput) {
    const ids = await this.workspaceAccess(ctx, workspaceId, Permissions.MetricDefinitionsCreate);
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'progress');
    const scope = input.scope ?? 'GYM';
    if (scope !== 'GYM' && scope !== 'PRIVATE') throw invalid('METRIC_DEFINITION_SCOPE_INVALID');
    if (scope === 'GYM' && !adminOrExplicit(ids.membership, ids.decision.source)) {
      throw forbidden();
    }
    const now = new Date();
    const metric = buildMetric(
      input,
      scope,
      ids.workspaceId,
      ids.membership._id,
      actorId(ctx),
      now,
    );
    return await this.unitOfWork.withTransaction(async (tx) => {
      const created = await this.progress.createMetricDefinition(metric, tx);
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        'MetricDefinitionCreated',
        created._id,
        'create',
        tx,
      );
      return { metricDefinition: safeMetricDefinition(created) };
    });
  }

  async updateMetricDefinition(
    ctx: RequestContext,
    workspaceId: string,
    metricDefinitionId: string,
    input: MetricPatchInput,
  ) {
    const ids = await this.workspaceAccess(ctx, workspaceId, Permissions.MetricDefinitionsUpdate);
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'progress');
    const metricId = objectId(metricDefinitionId, 'METRIC_DEFINITION_NOT_FOUND');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const metric = await this.requireMutableMetric(metricId, ids.workspaceId, ids.membership, tx);
      if (metric.scope === 'GYM' && !adminOrExplicit(ids.membership, ids.decision.source)) {
        throw forbidden();
      }
      const updated = await this.progress.updateMetricDefinition({
        metricDefinitionId: metric._id,
        scope: metric.scope,
        workspaceId: metric.workspaceId ?? null,
        ...(metric.ownerMembershipId ? { ownerMembershipId: metric.ownerMembershipId } : {}),
        expectedVersion: input.expectedVersion,
        patch: metricPatch(input, actorId(ctx), now),
        tx,
      });
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        'MetricDefinitionUpdated',
        updated._id,
        'update',
        tx,
      );
      return { metricDefinition: safeMetricDefinition(updated) };
    });
  }

  async archiveMetricDefinition(
    ctx: RequestContext,
    workspaceId: string,
    metricDefinitionId: string,
    input: { expectedVersion: number },
  ) {
    const ids = await this.workspaceAccess(ctx, workspaceId, Permissions.MetricDefinitionsArchive);
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'progress');
    const metricId = objectId(metricDefinitionId, 'METRIC_DEFINITION_NOT_FOUND');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const metric = await this.requireMutableMetric(metricId, ids.workspaceId, ids.membership, tx);
      if (metric.scope === 'GYM' && !adminOrExplicit(ids.membership, ids.decision.source)) {
        throw forbidden();
      }
      const archived = await this.progress.archiveMetricDefinition({
        metricDefinitionId: metric._id,
        scope: metric.scope,
        workspaceId: metric.workspaceId ?? null,
        ...(metric.ownerMembershipId ? { ownerMembershipId: metric.ownerMembershipId } : {}),
        expectedVersion: input.expectedVersion,
        actor: actorId(ctx),
        now,
        tx,
      });
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        'MetricDefinitionArchived',
        archived._id,
        'archive',
        tx,
      );
      return { metricDefinition: safeMetricDefinition(archived) };
    });
  }

  async listMeasurements(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    query: PageQuery,
  ) {
    const ids = await this.relationshipAccess(ctx, workspaceId, relationshipId, {
      permission: Permissions.MeasurementsRead,
      self: true,
      assignmentTypes: ['PRIMARY_TRAINER', 'ASSISTANT_TRAINER'],
      allowWorkspaceAdmin: true,
    });
    await this.entitlements.assert(ids.workspaceId, 'READ');
    return pageByDate(
      await this.progress.listMeasurements({
        workspaceId: ids.workspaceId,
        relationshipId: ids.relationship._id,
        ...(query.metricDefinitionId
          ? {
              metricDefinitionId: objectId(query.metricDefinitionId, 'METRIC_DEFINITION_NOT_FOUND'),
            }
          : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor ? { cursor: decodeMeasuredAtCursor(query.cursor) } : {}),
      }),
      safeMeasurement,
      'measuredAt',
    );
  }

  async createMeasurement(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: MeasurementInput,
    tx: TransactionContext,
  ) {
    const ids = await this.relationshipAccess(ctx, workspaceId, relationshipId, {
      permission: Permissions.MeasurementsCreate,
      self: true,
      assignmentTypes: ['PRIMARY_TRAINER'],
    });
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'progress', tx);
    const now = new Date();
    validateMeasurementSource(input.source, isTraineeSelf(ctx, ids.relationship));
    const relationship = await this.relationships.guardProgressLifecycleOpen(
      ids.relationship._id,
      ids.workspaceId,
      tx,
    );
    const metric = await this.requireMetricUsable(
      objectId(input.metricDefinitionId, 'METRIC_DEFINITION_NOT_FOUND'),
      ids.workspaceId,
      ids.membership,
      tx,
    );
    const measurement: MeasurementEntryDocument = {
      _id: new ObjectId(),
      workspaceId: ids.workspaceId,
      relationshipId: relationship._id,
      metricDefinitionId: metric._id,
      value: measurementValue(input.value, metric),
      measuredAt: date(input.measuredAt, 'MEASUREMENT_VALUE_INVALID'),
      source: input.source,
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      recordedBy: actorId(ctx),
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.progress.createMeasurement(measurement, tx);
    await this.writeAudit(ctx, ids.workspaceId, 'MeasurementRecorded', created._id, 'create', tx);
    await this.writeOutbox(
      ctx,
      ids.workspaceId,
      'MeasurementRecorded',
      'measurement_entry',
      created._id,
      {
        relationshipId: relationship._id.toHexString(),
        measurementEntryId: created._id.toHexString(),
        metricDefinitionId: metric._id.toHexString(),
        measuredAt: created.measuredAt.toISOString(),
      },
      tx,
    );
    return { measurement: safeMeasurement(created) };
  }

  async updateMeasurement(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    measurementId: string,
    input: MeasurementPatchInput,
  ) {
    const ids = await this.relationshipAccess(ctx, workspaceId, relationshipId, {
      permission: Permissions.MeasurementsUpdate,
      self: true,
      assignmentTypes: ['PRIMARY_TRAINER'],
    });
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'progress');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const relationship = await this.relationships.guardProgressLifecycleOpen(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const existing = await this.progress.findMeasurement(
        ids.workspaceId,
        relationship._id,
        objectId(measurementId, 'MEASUREMENT_NOT_FOUND'),
        tx,
      );
      if (!existing) throw notFound('MEASUREMENT_NOT_FOUND');
      const metric = await this.progress.findMetricDefinition(existing.metricDefinitionId, tx);
      if (!metric) throw notFound('METRIC_DEFINITION_NOT_FOUND');
      if (input.source) validateMeasurementSource(input.source, isTraineeSelf(ctx, relationship));
      const patch: Partial<MeasurementEntryDocument> = {
        ...(input.value !== undefined ? { value: measurementValue(input.value, metric) } : {}),
        ...(input.measuredAt
          ? { measuredAt: date(input.measuredAt, 'MEASUREMENT_VALUE_INVALID') }
          : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
        updatedAt: now,
      };
      const updated = await this.progress.updateMeasurement({
        workspaceId: ids.workspaceId,
        relationshipId: relationship._id,
        measurementId: existing._id,
        expectedVersion: input.expectedVersion,
        patch,
        tx,
      });
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        'MeasurementCorrected',
        updated._id,
        'correct',
        tx,
        {
          before: safeMeasurement(existing),
          after: safeMeasurement(updated),
        },
      );
      return { measurement: safeMeasurement(updated) };
    });
  }

  async listProgressPhotos(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    query: PageQuery,
  ) {
    const ids = await this.relationshipReadMaybePhoto(ctx, workspaceId, relationshipId);
    await this.entitlements.assert(ids.workspaceId, 'READ');
    const traineeSelf = isTraineeSelf(ctx, ids.relationship);
    return pageByDate(
      await this.progress.listProgressPhotos({
        workspaceId: ids.workspaceId,
        relationshipId: ids.relationship._id,
        traineeSelf,
        staffVisible: ids.staffVisible,
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor ? { cursor: decodeCapturedAtCursor(query.cursor) } : {}),
      }),
      safePhoto,
      'capturedAt',
    );
  }

  async getHealthProfile(ctx: RequestContext, workspaceId: string, relationshipId: string) {
    const ids = await this.relationshipReadMaybeHealth(ctx, workspaceId, relationshipId);
    await this.entitlements.assert(ids.workspaceId, 'READ');
    const profile = await this.progress.findHealthProfile(ids.workspaceId, ids.relationship._id);
    if (!profile) return { healthProfile: null };
    return {
      healthProfile: ids.fullHealth ? safeHealth(profile) : safeFoodAllergies(profile),
    };
  }

  async putHealthProfile(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: HealthInput,
  ) {
    const ids = await this.relationshipAccess(ctx, workspaceId, relationshipId, {
      permission: Permissions.HealthUpdate,
      self: true,
      assignmentTypes: [],
    });
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'progress');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const relationship = await this.relationships.guardProgressLifecycleOpen(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const existing = await this.progress.findHealthProfile(ids.workspaceId, relationship._id, tx);
      if (existing && input.expectedVersion === undefined) {
        throw conflict('HEALTH_PROFILE_VERSION_CONFLICT');
      }
      const body = healthBody(input, actorId(ctx), now);
      const result = existing
        ? await this.progress.updateHealthProfile({
            workspaceId: ids.workspaceId,
            relationshipId: relationship._id,
            expectedVersion: input.expectedVersion ?? -1,
            patch: body,
            tx,
          })
        : await this.progress.createHealthProfile(
            {
              _id: new ObjectId(),
              workspaceId: ids.workspaceId,
              relationshipId: relationship._id,
              ...body,
              version: 0,
              createdAt: now,
            },
            tx,
          );
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        existing ? 'HealthProfileUpdated' : 'HealthProfileCreated',
        result._id,
        existing ? 'update' : 'create',
        tx,
        {
          ...(existing ? { before: safeHealth(existing) } : {}),
          after: safeHealth(result),
        },
      );
      return { healthProfile: safeHealth(result) };
    });
  }

  async listNotes(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    query: PageQuery,
  ) {
    const ids = await this.relationshipReadMaybeNotes(ctx, workspaceId, relationshipId);
    await this.entitlements.assert(ids.workspaceId, 'READ');
    return page(
      await this.progress.listNotes({
        workspaceId: ids.workspaceId,
        relationshipId: ids.relationship._id,
        ...('authorMembershipId' in ids && ids.authorMembershipId
          ? { authorMembershipId: ids.authorMembershipId }
          : {}),
        traineeSelf: ids.traineeSelf,
        staffShared: ids.staffShared,
        ...(query.includeArchived !== undefined ? { includeArchived: query.includeArchived } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor ? { afterId: objectId(query.cursor, 'CURSOR_INVALID') } : {}),
      }),
      safeNote,
    );
  }

  async createNote(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: NoteInput,
  ) {
    const ids = await this.relationshipAccess(ctx, workspaceId, relationshipId, {
      permission: Permissions.NotesCreate,
      self: false,
      assignmentTypes: ['PRIMARY_TRAINER'],
    });
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'progress');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const relationship = await this.relationships.guardProgressLifecycleOpen(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const note: CoachingNoteDocument = {
        _id: new ObjectId(),
        workspaceId: ids.workspaceId,
        relationshipId: relationship._id,
        authorMembershipId: ids.membership._id,
        category: text(input.category, 'NOTE_CATEGORY_REQUIRED'),
        visibility: input.visibility ?? 'PRIVATE',
        content: text(input.content, 'NOTE_CONTENT_REQUIRED'),
        sensitive: input.sensitive ?? false,
        status: 'ACTIVE',
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
      const created = await this.progress.createNote(note, tx);
      await this.writeAudit(ctx, ids.workspaceId, 'CoachingNoteCreated', created._id, 'create', tx);
      return { note: safeNote(created) };
    });
  }

  async updateNote(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    noteId: string,
    input: NotePatchInput,
  ) {
    const ids = await this.relationshipAccess(ctx, workspaceId, relationshipId, {
      permission: Permissions.NotesUpdate,
      self: false,
      assignmentTypes: ['PRIMARY_TRAINER'],
    });
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'progress');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const relationship = await this.relationships.guardProgressLifecycleOpen(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const existing = await this.progress.findNote(
        ids.workspaceId,
        relationship._id,
        objectId(noteId, 'NOTE_NOT_FOUND'),
        tx,
      );
      if (!existing) throw notFound('NOTE_NOT_FOUND');
      if (!existing.authorMembershipId.equals(ids.membership._id)) throw forbidden();
      if (existing.visibility === 'SHARED_WITH_TRAINEE' && input.visibility === 'PRIVATE') {
        throw conflict('NOTE_VISIBILITY_FORBIDDEN');
      }
      const patch = notePatch(input, now);
      const updated = await this.progress.updateNote({
        workspaceId: ids.workspaceId,
        relationshipId: relationship._id,
        noteId: existing._id,
        authorMembershipId: ids.membership._id,
        expectedVersion: input.expectedVersion,
        patch,
        tx,
      });
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        'CoachingNoteUpdated',
        updated._id,
        'update',
        tx,
        {
          before: safeNote(existing),
          after: safeNote(updated),
        },
      );
      return { note: safeNote(updated) };
    });
  }

  async archiveNote(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    noteId: string,
    input: { expectedVersion: number },
  ) {
    const ids = await this.relationshipAccess(ctx, workspaceId, relationshipId, {
      permission: Permissions.NotesArchive,
      self: false,
      assignmentTypes: ['PRIMARY_TRAINER'],
    });
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'progress');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const relationship = await this.relationships.guardProgressLifecycleOpen(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const archived = await this.progress.archiveNote({
        workspaceId: ids.workspaceId,
        relationshipId: relationship._id,
        noteId: objectId(noteId, 'NOTE_NOT_FOUND'),
        authorMembershipId: ids.membership._id,
        expectedVersion: input.expectedVersion,
        now,
        tx,
      });
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        'CoachingNoteArchived',
        archived._id,
        'archive',
        tx,
      );
      return { note: safeNote(archived) };
    });
  }

  async getAdherenceConfig(ctx: RequestContext, workspaceId: string, relationshipId: string) {
    const ids = await this.relationshipAccess(ctx, workspaceId, relationshipId, {
      permission: Permissions.AdherenceRead,
      self: true,
      assignmentTypes: ['PRIMARY_TRAINER', 'ASSISTANT_TRAINER', 'NUTRITIONIST'],
      allowWorkspaceAdmin: true,
    });
    await this.entitlements.assert(ids.workspaceId, 'READ');
    const config = await this.progress.findAdherenceConfig(ids.workspaceId, ids.relationship._id);
    return { adherenceConfig: config ? safeAdherenceConfig(config) : null };
  }

  async putAdherenceConfig(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: AdherenceConfigInput,
  ) {
    const ids = await this.relationshipAccess(ctx, workspaceId, relationshipId, {
      permission: Permissions.AdherenceConfigure,
      self: false,
      assignmentTypes: ['PRIMARY_TRAINER'],
      allowWorkspaceAdmin: true,
    });
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'progress');
    const enabledMetrics = uniqueMetrics(input.enabledMetrics);
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const relationship = await this.relationships.guardProgressLifecycleOpen(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const existing = await this.progress.findAdherenceConfig(
        ids.workspaceId,
        relationship._id,
        tx,
      );
      if (existing && input.expectedVersion === undefined) {
        throw conflict('ADHERENCE_CONFIG_VERSION_CONFLICT');
      }
      const patch = { enabledMetrics, updatedBy: actorId(ctx), updatedAt: now };
      const result = existing
        ? await this.progress.updateAdherenceConfig({
            workspaceId: ids.workspaceId,
            relationshipId: relationship._id,
            expectedVersion: input.expectedVersion ?? -1,
            patch,
            tx,
          })
        : await this.progress.createAdherenceConfig(
            {
              _id: new ObjectId(),
              workspaceId: ids.workspaceId,
              relationshipId: relationship._id,
              ...patch,
              version: 0,
              createdAt: now,
            },
            tx,
          );
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        existing ? 'AdherenceConfigUpdated' : 'AdherenceConfigCreated',
        result._id,
        existing ? 'update' : 'create',
        tx,
      );
      return { adherenceConfig: safeAdherenceConfig(result) };
    });
  }

  async getDailyTracking(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    localDate: string,
  ) {
    const ids = await this.relationshipAccess(ctx, workspaceId, relationshipId, {
      permission: Permissions.AdherenceRead,
      self: true,
      assignmentTypes: ['PRIMARY_TRAINER', 'ASSISTANT_TRAINER', 'NUTRITIONIST'],
      allowWorkspaceAdmin: true,
    });
    await this.entitlements.assert(ids.workspaceId, 'READ');
    assertLocalDate(localDate);
    const entry = await this.progress.findDailyTracking(
      ids.workspaceId,
      ids.relationship._id,
      localDate,
    );
    return { dailyTrackingEntry: entry ? safeDailyTracking(entry) : null };
  }

  async putDailyTracking(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    localDate: string,
    input: DailyTrackingInput,
  ) {
    assertLocalDate(localDate);
    const readIds = await this.loadRelationship(ctx, workspaceId, relationshipId);
    const self = isTraineeSelf(ctx, readIds.relationship);
    const workspace = await this.workspaces.findById(readIds.workspaceId);
    if (!workspace) throw notFound('WORKSPACE_NOT_FOUND');
    const today = localDateInTimezone(new Date(), workspace.timezone);
    const yesterday = previousLocalDate(today);
    const traineeWindow = localDate === today || localDate === yesterday;
    if (self && !traineeWindow) throw conflict('DAILY_TRACKING_EDIT_WINDOW_EXPIRED');
    const ids = await this.relationshipAccess(ctx, workspaceId, relationshipId, {
      permission:
        !self && !traineeWindow ? Permissions.AdherenceCorrect : Permissions.AdherenceUpdate,
      self: true,
      assignmentTypes: ['PRIMARY_TRAINER'],
    });
    await this.entitlements.assert(ids.workspaceId, 'WRITE', 'progress');
    if (!self && !traineeWindow) {
      if (!input.reason?.trim()) throw invalid('DAILY_TRACKING_CORRECTION_REASON_REQUIRED');
    }
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const relationship = await this.relationships.guardProgressLifecycleOpen(
        ids.relationship._id,
        ids.workspaceId,
        tx,
      );
      const config = await this.progress.findAdherenceConfig(ids.workspaceId, relationship._id, tx);
      const values = dailyValues(input.values, new Set(config?.enabledMetrics ?? []));
      const existing = await this.progress.findDailyTracking(
        ids.workspaceId,
        relationship._id,
        localDate,
        tx,
      );
      if (existing && input.expectedVersion === undefined) {
        throw conflict('DAILY_TRACKING_VERSION_CONFLICT');
      }
      const patch = {
        values,
        timezoneAtEntry: workspace.timezone,
        updatedBy: actorId(ctx),
        updatedAt: now,
      };
      const result = existing
        ? await this.progress.updateDailyTracking({
            workspaceId: ids.workspaceId,
            relationshipId: relationship._id,
            localDate,
            expectedVersion: input.expectedVersion ?? -1,
            patch,
            tx,
          })
        : await this.progress.createDailyTracking(
            {
              _id: new ObjectId(),
              workspaceId: ids.workspaceId,
              relationshipId: relationship._id,
              localDate,
              ...patch,
              version: 0,
              createdAt: now,
            },
            tx,
          );
      await this.writeAudit(
        ctx,
        ids.workspaceId,
        existing ? 'DailyTrackingUpdated' : 'DailyTrackingCreated',
        result._id,
        self || traineeWindow ? 'update' : 'correct',
        tx,
        {
          ...(input.reason ? { reason: input.reason } : {}),
          ...(existing ? { before: safeDailyTracking(existing) } : {}),
          after: safeDailyTracking(result),
        },
      );
      return { dailyTrackingEntry: safeDailyTracking(result) };
    });
  }

  private async workspaceAccess(ctx: RequestContext, workspaceId: string, permission: string) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const decision = await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId: id,
      permission,
      scope: { type: 'WORKSPACE' },
    });
    const membership = await this.actorMembership(ctx, id);
    return { workspaceId: id, membership, decision };
  }

  private async loadRelationship(ctx: RequestContext, workspaceId: string, relationshipId: string) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relationship = await this.relationships.findByIdInWorkspace(
      id,
      objectId(relationshipId, 'RELATIONSHIP_NOT_FOUND'),
    );
    if (!relationship) throw notFound('RELATIONSHIP_NOT_FOUND');
    const membership = await this.actorMembership(ctx, id);
    return { workspaceId: id, relationship, membership };
  }

  private async relationshipAccess(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    options: {
      permission: string;
      self: boolean;
      assignmentTypes: Array<'PRIMARY_TRAINER' | 'ASSISTANT_TRAINER' | 'NUTRITIONIST'>;
      allowWorkspaceAdmin?: boolean;
    },
  ) {
    const ids = await this.loadRelationship(ctx, workspaceId, relationshipId);
    const decision = await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId: ids.workspaceId,
      permission: options.permission,
      scope: { type: 'WORKSPACE' },
    });
    if (options.allowWorkspaceAdmin && admin(ids.membership)) return { ...ids, decision };
    if (options.self && isTraineeSelf(ctx, ids.relationship)) return { ...ids, decision };
    const assignments = await this.relationships.listActiveAssignments(ids.relationship._id);
    const assigned = assignments.some(
      (assignment) =>
        assignment.staffMembershipId.equals(ids.membership._id) &&
        options.assignmentTypes.includes(assignment.assignmentType) &&
        (assignment.assignmentType !== 'PRIMARY_TRAINER' ||
          ids.relationship.currentPrimaryTrainerAssignmentId?.equals(assignment._id)),
    );
    if (assigned) return { ...ids, decision };
    const anyAssigned = assignments.some((assignment) =>
      assignment.staffMembershipId.equals(ids.membership._id),
    );
    if (decision.source === 'EXPLICIT_GRANT' && staff(ids.membership) && anyAssigned) {
      return { ...ids, decision };
    }
    throw forbidden();
  }

  private async relationshipReadMaybeHealth(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
  ) {
    const ids = await this.loadRelationship(ctx, workspaceId, relationshipId);
    if (isTraineeSelf(ctx, ids.relationship)) {
      await this.accessControl.authorize(ctx, {
        context: 'WORKSPACE',
        workspaceId: ids.workspaceId,
        permission: Permissions.HealthRead,
        scope: { type: 'WORKSPACE' },
      });
      return { ...ids, fullHealth: true };
    }
    try {
      await this.relationshipAccess(ctx, workspaceId, relationshipId, {
        permission: Permissions.HealthRead,
        self: false,
        assignmentTypes: ['PRIMARY_TRAINER'],
      });
      return { ...ids, fullHealth: true };
    } catch (error) {
      if (!isAuthorizationError(error)) throw error;
    }
    await this.relationshipAccess(ctx, workspaceId, relationshipId, {
      permission: Permissions.HealthFoodAllergiesRead,
      self: false,
      assignmentTypes: ['NUTRITIONIST'],
    });
    return { ...ids, fullHealth: false };
  }

  private async relationshipReadMaybePhoto(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
  ) {
    const ids = await this.loadRelationship(ctx, workspaceId, relationshipId);
    if (isTraineeSelf(ctx, ids.relationship)) {
      await this.accessControl.authorize(ctx, {
        context: 'WORKSPACE',
        workspaceId: ids.workspaceId,
        permission: Permissions.ProgressPhotosRead,
        scope: { type: 'WORKSPACE' },
      });
      return { ...ids, staffVisible: false };
    }
    await this.relationshipAccess(ctx, workspaceId, relationshipId, {
      permission: Permissions.ProgressPhotosRead,
      self: false,
      assignmentTypes: ['PRIMARY_TRAINER', 'ASSISTANT_TRAINER'],
    });
    return { ...ids, staffVisible: true };
  }

  private async relationshipReadMaybeNotes(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
  ) {
    const ids = await this.loadRelationship(ctx, workspaceId, relationshipId);
    if (isTraineeSelf(ctx, ids.relationship)) {
      await this.accessControl.authorize(ctx, {
        context: 'WORKSPACE',
        workspaceId: ids.workspaceId,
        permission: Permissions.NotesRead,
        scope: { type: 'WORKSPACE' },
      });
      return { ...ids, traineeSelf: true, staffShared: false };
    }
    await this.relationshipAccess(ctx, workspaceId, relationshipId, {
      permission: Permissions.NotesRead,
      self: false,
      assignmentTypes: ['PRIMARY_TRAINER'],
    });
    return {
      ...ids,
      authorMembershipId: ids.membership._id,
      traineeSelf: false,
      staffShared: true,
    };
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

  private async requireMutableMetric(
    metricDefinitionId: ObjectId,
    workspaceId: ObjectId,
    membership: WorkspaceMembershipDocument,
    tx: TransactionContext,
  ) {
    const metric = await this.progress.findMetricDefinition(metricDefinitionId, tx);
    if (metric?.status !== 'ACTIVE') throw notFound('METRIC_DEFINITION_NOT_FOUND');
    if (metric.scope === 'SYSTEM') throw forbidden();
    if (metric.scope === 'GYM' && metric.workspaceId?.equals(workspaceId)) return metric;
    if (
      metric.scope === 'PRIVATE' &&
      metric.workspaceId?.equals(workspaceId) &&
      metric.ownerMembershipId?.equals(membership._id)
    ) {
      return metric;
    }
    throw notFound('METRIC_DEFINITION_NOT_FOUND');
  }

  private async requireMetricUsable(
    metricDefinitionId: ObjectId,
    workspaceId: ObjectId,
    membership: WorkspaceMembershipDocument,
    tx: TransactionContext,
  ) {
    const metric = await this.progress.findMetricDefinition(metricDefinitionId, tx);
    if (!metric) throw notFound('METRIC_DEFINITION_NOT_FOUND');
    if (metric.status !== 'ACTIVE') throw conflict('METRIC_DEFINITION_ARCHIVED');
    const usable =
      metric.scope === 'SYSTEM' ||
      (metric.scope === 'GYM' && metric.workspaceId?.equals(workspaceId)) ||
      (metric.scope === 'PRIVATE' &&
        metric.workspaceId?.equals(workspaceId) &&
        metric.ownerMembershipId?.equals(membership._id));
    if (!usable) {
      throw notFound('METRIC_DEFINITION_NOT_FOUND');
    }
    const guarded = await this.progress.guardMetricForMeasurementUse({
      metricDefinitionId,
      workspaceId,
      ownerMembershipId: membership._id,
      tx,
    });
    if (!guarded) throw conflict('METRIC_DEFINITION_ARCHIVED');
    return guarded;
  }

  private async writeAudit(
    ctx: RequestContext,
    workspaceId: ObjectId,
    eventType: string,
    entityId: ObjectId,
    action: string,
    tx: TransactionContext,
    details?: {
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
      reason?: string;
    },
  ) {
    await this.audit.write(
      {
        eventType,
        workspaceId,
        actor: {
          userId: actorId(ctx),
          ...(ctx.workspaceMembershipId
            ? { workspaceMembershipId: new ObjectId(ctx.workspaceMembershipId) }
            : {}),
        },
        entity: { type: eventType, id: entityId },
        action,
        ...(details?.before ? { before: details.before } : {}),
        ...(details?.after ? { after: details.after } : {}),
        ...(details?.reason ? { reason: details.reason } : {}),
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
    aggregateType: string,
    aggregateId: ObjectId,
    payload: Record<string, unknown>,
    tx: TransactionContext,
  ) {
    await this.outbox.write(
      {
        eventType,
        aggregateType,
        aggregateId,
        workspaceId,
        payload,
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }
}

function buildMetric(
  input: MetricInput,
  scope: 'GYM' | 'PRIVATE',
  workspaceId: ObjectId,
  ownerMembershipId: ObjectId,
  actor: ObjectId,
  now: Date,
): MetricDefinitionDocument {
  const key = input.key?.trim();
  return {
    _id: new ObjectId(),
    scope,
    workspaceId,
    ...(scope === 'PRIVATE' ? { ownerMembershipId } : {}),
    ...(key ? { key, normalizedKey: normalizeKey(key) } : {}),
    name: text(input.name, 'METRIC_DEFINITION_NAME_REQUIRED'),
    normalizedName: normalizeName(input.name),
    valueType: input.valueType,
    unit: text(input.unit, 'METRIC_DEFINITION_UNIT_REQUIRED').toUpperCase(),
    category: text(input.category, 'METRIC_DEFINITION_CATEGORY_REQUIRED'),
    status: 'ACTIVE',
    version: 0,
    createdBy: actor,
    updatedBy: actor,
    createdAt: now,
    updatedAt: now,
  };
}

function metricPatch(input: MetricPatchInput, actor: ObjectId, now: Date) {
  return {
    ...(input.key?.trim() ? { key: input.key.trim(), normalizedKey: normalizeKey(input.key) } : {}),
    ...(input.name !== undefined
      ? {
          name: text(input.name, 'METRIC_DEFINITION_NAME_REQUIRED'),
          normalizedName: normalizeName(input.name),
        }
      : {}),
    ...(input.category !== undefined
      ? { category: text(input.category, 'METRIC_DEFINITION_CATEGORY_REQUIRED') }
      : {}),
    updatedBy: actor,
    updatedAt: now,
  };
}

function healthBody(input: HealthInput, actor: ObjectId, now: Date) {
  return {
    injuries: strings(input.injuries),
    physicalLimitations: strings(input.physicalLimitations),
    foodAllergies: strings(input.foodAllergies),
    medications: strings(input.medications),
    ...(input.medicalNotes?.trim() ? { medicalNotes: input.medicalNotes.trim() } : {}),
    ...(input.emergencyNotes?.trim() ? { emergencyNotes: input.emergencyNotes.trim() } : {}),
    updatedBy: actor,
    updatedAt: now,
  };
}

function notePatch(input: NotePatchInput, now: Date): Partial<CoachingNoteDocument> {
  return {
    ...(input.category !== undefined
      ? { category: text(input.category, 'NOTE_CATEGORY_REQUIRED') }
      : {}),
    ...(input.content !== undefined
      ? { content: text(input.content, 'NOTE_CONTENT_REQUIRED') }
      : {}),
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    ...(input.sensitive !== undefined ? { sensitive: input.sensitive } : {}),
    updatedAt: now,
  };
}

function measurementValue(value: number, metric: MetricDefinitionDocument) {
  if (!Number.isFinite(value)) throw invalid('MEASUREMENT_VALUE_INVALID');
  if (metric.valueType === 'INTEGER' && !Number.isInteger(value)) {
    throw invalid('MEASUREMENT_VALUE_INVALID');
  }
  return value;
}

function validateMeasurementSource(source: MeasurementSource, traineeSelf: boolean) {
  if (traineeSelf && source !== 'TRAINEE') throw invalid('MEASUREMENT_SOURCE_INVALID');
  if (!traineeSelf && source === 'TRAINEE') throw invalid('MEASUREMENT_SOURCE_INVALID');
}

function dailyValues(values: DailyMetricValues, enabled: Set<AdherenceMetricKey>) {
  const clean: DailyMetricValues = {};
  for (const key of Object.keys(values) as AdherenceMetricKey[]) {
    if (!AdherenceMetricKeys.includes(key) || !enabled.has(key)) {
      throw conflict('DAILY_TRACKING_METRIC_DISABLED');
    }
    if (key === 'WORKOUT') {
      const value = values.WORKOUT;
      if (!value) throw invalid('MEASUREMENT_VALUE_INVALID');
      clean.WORKOUT = { completed: boolean(value.completed) };
    }
    if (key === 'NUTRITION') {
      const value = values.NUTRITION;
      if (!value) throw invalid('MEASUREMENT_VALUE_INVALID');
      clean.NUTRITION = { adherencePercent: rangeNumber(value.adherencePercent, 0, 100) };
    }
    if (key === 'WATER') {
      const value = values.WATER;
      if (!value) throw invalid('MEASUREMENT_VALUE_INVALID');
      clean.WATER = { ml: minNumber(value.ml, 0, true) };
    }
    if (key === 'STEPS') {
      const value = values.STEPS;
      if (!value) throw invalid('MEASUREMENT_VALUE_INVALID');
      clean.STEPS = { count: minInteger(value.count, 0) };
    }
    if (key === 'SLEEP') {
      const value = values.SLEEP;
      if (!value) throw invalid('MEASUREMENT_VALUE_INVALID');
      clean.SLEEP = { minutes: minInteger(value.minutes, 0) };
    }
    if (key === 'BODY_WEIGHT') {
      const value = values.BODY_WEIGHT;
      if (!value) throw invalid('MEASUREMENT_VALUE_INVALID');
      clean.BODY_WEIGHT = { kg: minNumber(value.kg, 0, false) };
    }
    if (key === 'MOOD') {
      const value = values.MOOD;
      if (!value) throw invalid('MEASUREMENT_VALUE_INVALID');
      clean.MOOD = { score: rangeInteger(value.score, 1, 5) };
    }
    if (key === 'ENERGY') {
      const value = values.ENERGY;
      if (!value) throw invalid('MEASUREMENT_VALUE_INVALID');
      clean.ENERGY = { score: rangeInteger(value.score, 1, 5) };
    }
  }
  return clean;
}

function uniqueMetrics(values: AdherenceMetricKey[]) {
  const unique = [...new Set(values)];
  if (unique.some((value) => !AdherenceMetricKeys.includes(value))) {
    throw invalid('DAILY_TRACKING_METRIC_DISABLED');
  }
  return unique;
}

function safeMetricDefinition(metric: MetricDefinitionDocument) {
  return {
    id: metric._id.toHexString(),
    scope: metric.scope,
    ...(metric.workspaceId ? { workspaceId: metric.workspaceId.toHexString() } : {}),
    ...(metric.ownerMembershipId
      ? { ownerMembershipId: metric.ownerMembershipId.toHexString() }
      : {}),
    key: metric.key,
    name: metric.name,
    valueType: metric.valueType,
    unit: metric.unit,
    category: metric.category,
    status: metric.status,
    version: metric.version,
  };
}

function safeMeasurement(measurement: MeasurementEntryDocument) {
  return {
    id: measurement._id.toHexString(),
    metricDefinitionId: measurement.metricDefinitionId.toHexString(),
    value: measurement.value,
    measuredAt: measurement.measuredAt,
    source: measurement.source,
    notes: measurement.notes,
    version: measurement.version,
  };
}

function safePhoto(photo: {
  _id: ObjectId;
  capturedAt: Date;
  weightAtCaptureKg?: number;
  visibility: string;
  photos: Array<{ type: string; fileId: ObjectId }>;
  version: number;
}) {
  return {
    id: photo._id.toHexString(),
    capturedAt: photo.capturedAt,
    weightAtCaptureKg: photo.weightAtCaptureKg,
    visibility: photo.visibility,
    photos: photo.photos.map((item) => ({ type: item.type, fileId: item.fileId.toHexString() })),
    version: photo.version,
  };
}

function safeHealth(profile: TraineeHealthProfileDocument) {
  return {
    id: profile._id.toHexString(),
    injuries: profile.injuries,
    physicalLimitations: profile.physicalLimitations,
    foodAllergies: profile.foodAllergies,
    medications: profile.medications,
    medicalNotes: profile.medicalNotes,
    emergencyNotes: profile.emergencyNotes,
    version: profile.version,
  };
}

function safeFoodAllergies(profile: TraineeHealthProfileDocument) {
  return {
    id: profile._id.toHexString(),
    foodAllergies: profile.foodAllergies,
    version: profile.version,
  };
}

function safeNote(note: CoachingNoteDocument) {
  return {
    id: note._id.toHexString(),
    category: note.category,
    visibility: note.visibility,
    content: note.content,
    sensitive: note.sensitive,
    status: note.status,
    version: note.version,
  };
}

function safeAdherenceConfig(config: AdherenceConfigDocument) {
  return {
    id: config._id.toHexString(),
    enabledMetrics: config.enabledMetrics,
    version: config.version,
  };
}

function safeDailyTracking(entry: DailyTrackingEntryDocument) {
  return {
    id: entry._id.toHexString(),
    localDate: entry.localDate,
    timezoneAtEntry: entry.timezoneAtEntry,
    values: entry.values,
    version: entry.version,
  };
}

function page<T extends { _id: ObjectId }, R>(items: T[], map: (item: T) => R) {
  return { data: items.map(map), nextCursor: items.at(-1)?._id.toHexString() };
}

function pageByDate<T extends { _id: ObjectId }, R>(
  items: T[],
  map: (item: T) => R,
  dateField: keyof T,
) {
  const last = items.at(-1);
  const dateValue = last?.[dateField];
  return {
    data: items.map(map),
    nextCursor:
      last && dateValue instanceof Date
        ? `${dateValue.toISOString()}_${last._id.toHexString()}`
        : undefined,
  };
}

function decodeMeasuredAtCursor(cursor: string) {
  const [iso, id] = cursor.split('_');
  if (!iso || !id || !ObjectId.isValid(id)) throw invalid('CURSOR_INVALID');
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) throw invalid('CURSOR_INVALID');
  return { measuredAt: parsed, id: new ObjectId(id) };
}

function decodeCapturedAtCursor(cursor: string) {
  const [iso, id] = cursor.split('_');
  if (!iso || !id || !ObjectId.isValid(id)) throw invalid('CURSOR_INVALID');
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) throw invalid('CURSOR_INVALID');
  return { capturedAt: parsed, id: new ObjectId(id) };
}

function localDateInTimezone(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function previousLocalDate(localDate: string) {
  const [year = 0, month = 1, day = 1] = localDate.split('-').map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  return previous.toISOString().slice(0, 10);
}

function assertLocalDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid('DAILY_TRACKING_DATE_INVALID');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw invalid('DAILY_TRACKING_DATE_INVALID');
  }
}

function date(value: string, code: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw invalid(code);
  return parsed;
}

function text(value: string, code: string) {
  const trimmed = value.trim();
  if (!trimmed) throw invalid(code);
  return trimmed;
}

function strings(values: string[] | undefined) {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function boolean(value: unknown) {
  if (typeof value !== 'boolean') throw invalid('MEASUREMENT_VALUE_INVALID');
  return value;
}

function rangeNumber(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw invalid('MEASUREMENT_VALUE_INVALID');
  }
  return value;
}

function minNumber(value: unknown, min: number, inclusive: boolean) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (inclusive ? value < min : value <= min)
  ) {
    throw invalid('MEASUREMENT_VALUE_INVALID');
  }
  return value;
}

function minInteger(value: unknown, min: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw invalid('MEASUREMENT_VALUE_INVALID');
  }
  return value;
}

function rangeInteger(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid('MEASUREMENT_VALUE_INVALID');
  }
  return value;
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

function objectId(value: string, code: string) {
  if (!ObjectId.isValid(value)) throw notFound(code);
  return new ObjectId(value);
}

function actorId(ctx: RequestContext) {
  if (!ctx.userId || !ObjectId.isValid(ctx.userId)) throw forbidden();
  return new ObjectId(ctx.userId);
}

function isTraineeSelf(ctx: RequestContext, relationship: CoachingRelationshipDocument) {
  return Boolean(ctx.userId && relationship.traineeUserId.equals(new ObjectId(ctx.userId)));
}

function admin(membership: WorkspaceMembershipDocument) {
  return membership.roles.includes('GYM_OWNER') || membership.roles.includes('GYM_MANAGER');
}

function adminOrExplicit(
  membership: WorkspaceMembershipDocument,
  decisionSource: 'EXPLICIT_GRANT' | 'PROFILE' | 'NONE',
) {
  return admin(membership) || decisionSource === 'EXPLICIT_GRANT';
}

function staff(membership: WorkspaceMembershipDocument) {
  return membership.roles.some((role) =>
    ['GYM_OWNER', 'GYM_MANAGER', 'TRAINER', 'ASSISTANT_TRAINER', 'NUTRITIONIST'].includes(role),
  );
}

function isAuthorizationError(error: unknown) {
  return (
    error instanceof AppError &&
    ['PERMISSION_DENIED', 'HEALTH_ACCESS_FORBIDDEN', 'WORKSPACE_MEMBERSHIP_REQUIRED'].includes(
      error.code,
    )
  );
}

function invalid(code: string) {
  return new AppError({ code, httpStatus: 422, message: 'The progress request is invalid.' });
}

function conflict(code: string) {
  return new AppError({ code, httpStatus: 409, message: 'The progress state has changed.' });
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
