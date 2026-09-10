import { ObjectId } from 'mongodb';
import type { AccessControlService } from '../../core/access-control/access-control.service';
import type { AuthorizationDecision } from '../../core/access-control/access-control.types';
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
  WorkoutProgramLifecyclePort,
  WorkoutRelationshipLifecyclePort,
} from '../workouts/workout.service';
import type { WorkspaceMembershipRepository } from '../workspaces/workspace.repository';
import type { WorkspaceMembershipDocument } from '../workspaces/workspace.types';
import type { TrainingRepository } from './training.repository';
import type {
  ExerciseDocument,
  ExercisePrescription,
  ProgramDay,
  ProgramDocument,
  ProgramRevisionDocument,
  ProgramTemplateDocument,
  TrainingScope,
} from './training.types';

type ExerciseInput = {
  scope?: 'GYM' | 'PRIVATE';
  names: { ar?: string; en?: string };
  primaryMuscles?: string[];
  secondaryMuscles?: string[];
  equipment?: string[];
  exerciseType: string;
  difficulty?: string;
  instructions?: string;
  imageFileId?: string;
  videoFileId?: string;
  externalVideoUrl?: string;
};

type DayInput = {
  dayKey?: string;
  sequence: number;
  name: string;
  type: ProgramDay['type'];
  exercises?: Array<{
    prescriptionId?: string;
    exerciseId: string;
    order: number;
    setStructure: string;
    targetSets: number;
    repRange?: { min?: number; max?: number };
    targetWeight?: number;
    restSeconds?: number;
    tempo?: string;
    rpe?: number;
    rir?: number;
    groupId?: string;
    groupType?: string;
    notes?: string;
  }>;
};

type PrescriptionInput = NonNullable<DayInput['exercises']>[number];

export interface TrainingRelationshipLifecyclePort {
  closeActiveProgramForRelationshipEnd(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ): Promise<void>;
}

export class TrainingApplicationService implements TrainingRelationshipLifecyclePort {
  private workoutLifecycle?: WorkoutProgramLifecyclePort & WorkoutRelationshipLifecyclePort;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly training: TrainingRepository,
    private readonly relationships: CoachingRelationshipRepository,
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly accessControl: AccessControlService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  setWorkoutLifecyclePort(port: WorkoutProgramLifecyclePort & WorkoutRelationshipLifecyclePort) {
    this.workoutLifecycle = port;
  }

  async listExercises(ctx: RequestContext, workspaceId: string, query: PageQuery) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.authorizeWorkspace(ctx, id, Permissions.ExercisesRead);
    await this.entitlements.assert(id, 'READ');
    const membership = await this.actorMembership(ctx, id);
    return page(
      await this.training.listExercises({
        workspaceId: id,
        ownerMembershipId: membership._id,
        ...optionalPageQuery(query),
      }),
      safeExercise,
    );
  }

  async createExercise(ctx: RequestContext, workspaceId: string, input: ExerciseInput) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.authorizeWorkspace(ctx, id, Permissions.ExercisesCreate);
    await this.entitlements.assert(id, 'WRITE', 'training');
    const membership = await this.actorMembership(ctx, id);
    const now = new Date();
    const scope = input.scope ?? 'GYM';
    if (scope !== 'GYM' && scope !== 'PRIVATE') throw invalid('EXERCISE_SCOPE_INVALID');
    const exercise = buildExercise(scope, id, membership._id, input, now);
    return await this.unitOfWork.withTransaction(async (tx) => {
      const created = await this.training.createExercise(exercise, tx);
      await this.writeAudit(ctx, id, 'ExerciseCreated', created._id, 'create', tx);
      return { exercise: safeExercise(created) };
    });
  }

  async listPlatformExercises(ctx: RequestContext, query: PageQuery) {
    await this.accessControl.authorize(ctx, {
      context: 'PLATFORM',
      permission: Permissions.SystemExercisesRead,
    });
    return page(
      await this.training.listExercises({
        ...optionalPageQuery(query),
      }),
      safeExercise,
    );
  }

  async createPlatformExercise(ctx: RequestContext, input: Omit<ExerciseInput, 'scope'>) {
    await this.accessControl.authorize(ctx, {
      context: 'PLATFORM',
      permission: Permissions.SystemExercisesCreate,
    });
    const now = new Date();
    const exercise = buildExercise('SYSTEM', null, null, input, now);
    return await this.unitOfWork.withTransaction(async (tx) => {
      const created = await this.training.createExercise(exercise, tx);
      await this.writeAudit(ctx, undefined, 'SystemExerciseCreated', created._id, 'create', tx);
      return { exercise: safeExercise(created) };
    });
  }

  async updateExercise(
    ctx: RequestContext,
    workspaceId: string | undefined,
    exerciseId: string,
    input: Partial<ExerciseInput> & { expectedVersion: number },
    platform = false,
  ) {
    if (platform) {
      await this.accessControl.authorize(ctx, {
        context: 'PLATFORM',
        permission: Permissions.SystemExercisesUpdate,
      });
    } else {
      const id = objectId(workspaceId ?? '', 'WORKSPACE_NOT_FOUND');
      await this.authorizeWorkspace(ctx, id, Permissions.ExercisesUpdate);
      await this.entitlements.assert(id, 'WRITE', 'training');
    }
    return await this.unitOfWork.withTransaction(async (tx) => {
      const patch = { ...exercisePatch(input), updatedAt: new Date() };
      const exercise = platform
        ? await this.training.updateExercise(
            objectId(exerciseId, 'EXERCISE_NOT_FOUND'),
            'SYSTEM',
            null,
            input.expectedVersion,
            patch,
            tx,
          )
        : await this.updateWorkspaceExercise(
            ctx,
            workspaceId,
            exerciseId,
            input.expectedVersion,
            patch,
            tx,
          );
      await this.writeAudit(
        ctx,
        platform ? undefined : objectId(workspaceId ?? '', 'WORKSPACE_NOT_FOUND'),
        platform ? 'SystemExerciseUpdated' : 'ExerciseUpdated',
        exercise._id,
        'update',
        tx,
      );
      return { exercise: safeExercise(exercise) };
    });
  }

  async archiveExercise(
    ctx: RequestContext,
    workspaceId: string | undefined,
    exerciseId: string,
    input: { expectedVersion: number },
    platform = false,
  ) {
    if (platform) {
      await this.accessControl.authorize(ctx, {
        context: 'PLATFORM',
        permission: Permissions.SystemExercisesArchive,
      });
    } else {
      const id = objectId(workspaceId ?? '', 'WORKSPACE_NOT_FOUND');
      await this.authorizeWorkspace(ctx, id, Permissions.ExercisesArchive);
      await this.entitlements.assert(id, 'WRITE', 'training');
    }
    return await this.unitOfWork.withTransaction(async (tx) => {
      const patch = { status: 'ARCHIVED' as const, archivedAt: new Date(), updatedAt: new Date() };
      const exercise = platform
        ? await this.training.updateExercise(
            objectId(exerciseId, 'EXERCISE_NOT_FOUND'),
            'SYSTEM',
            null,
            input.expectedVersion,
            patch,
            tx,
          )
        : await this.updateWorkspaceExercise(
            ctx,
            workspaceId,
            exerciseId,
            input.expectedVersion,
            patch,
            tx,
          );
      await this.writeAudit(
        ctx,
        platform ? undefined : objectId(workspaceId ?? '', 'WORKSPACE_NOT_FOUND'),
        platform ? 'SystemExerciseArchived' : 'ExerciseArchived',
        exercise._id,
        'archive',
        tx,
      );
      return { exercise: safeExercise(exercise) };
    });
  }

  async listTemplates(ctx: RequestContext, workspaceId: string, query: PageQuery) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.authorizeWorkspace(ctx, id, Permissions.ProgramTemplatesRead);
    await this.entitlements.assert(id, 'READ');
    const membership = await this.actorMembership(ctx, id);
    return page(
      await this.training.listTemplates({
        workspaceId: id,
        ownerMembershipId: membership._id,
        ...optionalPageQuery(query),
      }),
      safeTemplate,
    );
  }

  async createTemplate(
    ctx: RequestContext,
    workspaceId: string,
    input: { scope?: 'GYM' | 'PRIVATE'; name: string; description?: string; days: DayInput[] },
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.authorizeWorkspace(ctx, id, Permissions.ProgramTemplatesCreate);
    await this.entitlements.assert(id, 'WRITE', 'training');
    const membership = await this.actorMembership(ctx, id);
    const scope = input.scope ?? 'GYM';
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const days = await this.buildDays(id, membership._id, input.days, tx);
      assertTemplateExerciseCompatibility(
        scope,
        days,
        await this.exercisesByDay(id, membership._id, days, tx),
      );
      const templateId = new ObjectId();
      const revisionId = new ObjectId();
      const template: ProgramTemplateDocument = {
        _id: templateId,
        workspaceId: id,
        ownerMembershipId: scope === 'PRIVATE' ? membership._id : null,
        scope,
        name: input.name.trim(),
        ...(input.description ? { description: input.description.trim() } : {}),
        currentRevisionId: revisionId,
        status: 'ACTIVE',
        version: 0,
        createdBy: actorObjectId(ctx),
        createdAt: now,
        updatedAt: now,
      };
      const revision = {
        _id: revisionId,
        workspaceId: id,
        templateId,
        revision: 1,
        days,
        createdBy: actorObjectId(ctx),
        createdAt: now,
      };
      await this.training.createTemplate(template, revision, tx);
      await this.writeAudit(ctx, id, 'ProgramTemplateCreated', template._id, 'create', tx);
      await this.writeOutbox(
        ctx,
        id,
        'ProgramTemplateCreated',
        'program_template',
        template._id,
        tx,
      );
      return { template: safeTemplate(template), revision: safeTemplateRevision(revision) };
    });
  }

  async getTemplate(ctx: RequestContext, workspaceId: string, templateId: string) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.authorizeWorkspace(ctx, id, Permissions.ProgramTemplatesRead);
    await this.entitlements.assert(id, 'READ');
    const membership = await this.actorMembership(ctx, id);
    const template = await this.training.findTemplateAccessible(
      objectId(templateId, 'PROGRAM_TEMPLATE_NOT_FOUND'),
      id,
      membership._id,
    );
    if (!template) throw notFound('PROGRAM_TEMPLATE_NOT_FOUND');
    const revision = await this.training.findTemplateRevision(
      template._id,
      template.currentRevisionId,
      template.workspaceId ?? null,
    );
    return {
      template: safeTemplate(template),
      revision: revision ? safeTemplateRevision(revision) : null,
    };
  }

  async createTemplateRevision(
    ctx: RequestContext,
    workspaceId: string,
    templateId: string,
    input: { expectedVersion: number; days: DayInput[] },
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.authorizeWorkspace(ctx, id, Permissions.ProgramTemplatesUpdate);
    await this.entitlements.assert(id, 'WRITE', 'training');
    const membership = await this.actorMembership(ctx, id);
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const template = await this.requireTemplate(id, membership._id, templateId, tx);
      if (template.status !== 'ACTIVE') throw conflict('PROGRAM_TEMPLATE_ARCHIVED');
      const current = await this.requireTemplateRevision(template, tx);
      const days = await this.buildDays(id, membership._id, input.days, tx);
      assertTemplateExerciseCompatibility(
        template.scope,
        days,
        await this.exercisesByDay(id, membership._id, days, tx),
      );
      const revision = {
        _id: new ObjectId(),
        workspaceId: id,
        templateId: template._id,
        revision: current.revision + 1,
        days,
        createdBy: actorObjectId(ctx),
        createdAt: now,
      };
      const result = await this.training.createTemplateRevision(
        template,
        input.expectedVersion,
        revision,
        now,
        tx,
      );
      await this.writeAudit(ctx, id, 'ProgramTemplateUpdated', template._id, 'create_revision', tx);
      return {
        template: safeTemplate(result.template),
        revision: safeTemplateRevision(result.revision),
      };
    });
  }

  async archiveTemplate(
    ctx: RequestContext,
    workspaceId: string,
    templateId: string,
    input: { expectedVersion: number },
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    await this.authorizeWorkspace(ctx, id, Permissions.ProgramTemplatesArchive);
    await this.entitlements.assert(id, 'WRITE', 'training');
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const template = await this.training.archiveTemplate(
        objectId(templateId, 'PROGRAM_TEMPLATE_NOT_FOUND'),
        id,
        input.expectedVersion,
        now,
        tx,
      );
      await this.writeAudit(ctx, id, 'ProgramTemplateArchived', template._id, 'archive', tx);
      return { template: safeTemplate(template) };
    });
  }

  async listPrograms(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    query: PageQuery,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relationship = await this.requireRelationship(id, relationshipId);
    await this.assertRelationshipProgramAccess(
      ctx,
      id,
      relationship,
      Permissions.ProgramsRead,
      'read',
    );
    await this.entitlements.assert(id, 'READ');
    return page(
      await this.training.listPrograms(
        id,
        relationship._id,
        query.limit ?? 50,
        optionalObjectId(query.cursor, 'CURSOR_INVALID'),
      ),
      safeProgram,
    );
  }

  async getProgram(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    programId: string,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relationship = await this.requireRelationship(id, relationshipId);
    await this.assertRelationshipProgramAccess(
      ctx,
      id,
      relationship,
      Permissions.ProgramsRead,
      'read',
    );
    await this.entitlements.assert(id, 'READ');
    const program = await this.requireProgram(id, relationship._id, programId);
    const revision = await this.requireProgramRevision(program);
    return { program: safeProgram(program), revision: safeProgramRevision(revision) };
  }

  async createProgram(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    input: {
      source?:
        | { type: 'TEMPLATE'; templateId: string; templateRevisionId?: string }
        | { type: 'PROGRAM'; programId: string; programRevisionId?: string }
        | { type: 'SCRATCH' };
      name: string;
      days?: DayInput[];
    },
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relationship = await this.requireRelationship(id, relationshipId);
    await this.assertRelationshipProgramAccess(
      ctx,
      id,
      relationship,
      Permissions.ProgramsCreate,
      'mutate',
    );
    await this.entitlements.assert(id, 'WRITE', 'training');
    const membership = await this.actorMembership(ctx, id);
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const source = input.source ?? { type: 'SCRATCH' as const };
      const content = await this.resolveProgramSource(
        ctx,
        id,
        relationship,
        membership,
        source,
        input.days,
        tx,
      );
      const programId = new ObjectId();
      const revisionId = new ObjectId();
      const program: ProgramDocument = {
        _id: programId,
        workspaceId: id,
        relationshipId: relationship._id,
        name: input.name.trim(),
        ...content.provenance,
        status: 'DRAFT',
        currentRevisionId: revisionId,
        assignedBy: actorObjectId(ctx),
        createdAt: now,
        updatedAt: now,
        version: 0,
      };
      const revision: ProgramRevisionDocument = {
        _id: revisionId,
        workspaceId: id,
        relationshipId: relationship._id,
        programId,
        revision: 1,
        days: content.days,
        createdBy: actorObjectId(ctx),
        createdAt: now,
      };
      await this.training.createProgram(program, revision, tx);
      await this.writeAudit(ctx, id, 'ProgramCreated', program._id, 'create', tx);
      return { program: safeProgram(program), revision: safeProgramRevision(revision) };
    });
  }

  async createProgramRevision(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    programId: string,
    input: { expectedVersion: number; days: DayInput[] },
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relationship = await this.requireRelationship(id, relationshipId);
    await this.assertRelationshipProgramAccess(
      ctx,
      id,
      relationship,
      Permissions.ProgramsUpdate,
      'mutate',
    );
    await this.entitlements.assert(id, 'WRITE', 'training');
    const membership = await this.actorMembership(ctx, id);
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const program = await this.requireProgram(id, relationship._id, programId, tx);
      if (!['DRAFT', 'ACTIVE'].includes(program.status)) throw conflict('PROGRAM_REVISION_INVALID');
      const current = await this.requireProgramRevision(program, tx);
      const days = await this.buildDays(id, membership._id, input.days, tx);
      if (program.status === 'ACTIVE') assertActiveTopologyUnchanged(current.days, days);
      const revision: ProgramRevisionDocument = {
        _id: new ObjectId(),
        workspaceId: id,
        relationshipId: relationship._id,
        programId: program._id,
        revision: current.revision + 1,
        days,
        createdBy: actorObjectId(ctx),
        createdAt: now,
      };
      const result = await this.training.createProgramRevision(
        program,
        input.expectedVersion,
        [program.status],
        revision,
        now,
        tx,
      );
      await this.writeAudit(ctx, id, 'ProgramUpdated', program._id, 'create_revision', tx);
      await this.writeOutbox(ctx, id, 'ProgramUpdated', 'program', program._id, tx);
      return {
        program: safeProgram(result.program),
        revision: safeProgramRevision(result.revision),
      };
    });
  }

  async activateProgram(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    programId: string,
    input: { expectedVersion: number; effectiveAt?: string },
    tx?: TransactionContext,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relationship = await this.requireRelationship(id, relationshipId);
    await this.assertRelationshipProgramAccess(
      ctx,
      id,
      relationship,
      Permissions.ProgramsActivate,
      'mutate',
    );
    await this.entitlements.assert(id, 'WRITE', 'training');
    const membership = await this.actorMembership(ctx, id);
    const preExistingActive = await this.training.findActiveProgram(id, relationship._id);
    const now = input.effectiveAt ? new Date(input.effectiveAt) : new Date();
    return await this.withTransaction(tx, async (tx) => {
      const guarded = await this.relationships.guardTrainingLifecycleActive(
        relationship._id,
        id,
        tx,
      );
      const program = await this.requireProgram(id, guarded._id, programId, tx);
      if (program.status !== 'DRAFT') throw conflict('PROGRAM_ACTIVATION_INVALID');
      if (program.version !== input.expectedVersion) throw conflict('PROGRAM_VERSION_CONFLICT');
      const revision = await this.requireProgramRevision(program, tx);
      assertHasExecutableDay(revision.days);
      await this.assertSnapshotExercisesStillUsable(id, membership._id, revision.days, tx);
      const existing = await this.training.findActiveProgram(id, guarded._id, tx);
      if (existing && !preExistingActive) throw conflict('ACTIVE_PROGRAM_CONFLICT');
      if (existing && preExistingActive && !existing._id.equals(preExistingActive._id)) {
        throw conflict('ACTIVE_PROGRAM_CONFLICT');
      }
      if (existing) {
        await this.workoutLifecycle?.assertNoInProgressForProgramTransition(
          id,
          guarded._id,
          existing._id,
          tx,
        );
        await this.training.replaceActiveProgram(existing, program._id, now, tx);
        await this.writeAudit(ctx, id, 'ProgramReplaced', existing._id, 'replace', tx);
        await this.writeOutbox(ctx, id, 'ProgramReplaced', 'program', existing._id, tx);
      }
      const activated = await this.training.activateProgram({
        workspaceId: id,
        relationshipId: guarded._id,
        programId: program._id,
        expectedVersion: input.expectedVersion,
        now,
        tx,
      });
      const first = firstExecutableSequence(revision.days);
      await this.training.createProgress(
        {
          _id: new ObjectId(),
          workspaceId: id,
          relationshipId: guarded._id,
          programId: program._id,
          programRevisionId: revision._id,
          currentDaySequence: first,
          completedDayCount: 0,
          skippedDayCount: 0,
          version: 0,
          createdAt: now,
          updatedAt: now,
        },
        {
          _id: new ObjectId(),
          workspaceId: id,
          relationshipId: guarded._id,
          programId: program._id,
          programRevisionId: revision._id,
          daySequence: first,
          type: 'INITIALIZED',
          reason: 'PROGRAM_ACTIVATED',
          performedBy: actorObjectId(ctx),
          occurredAt: now,
        },
        tx,
      );
      await this.writeAudit(ctx, id, 'ProgramActivated', activated._id, 'activate', tx);
      await this.writeOutbox(ctx, id, 'ProgramActivated', 'program', activated._id, tx);
      return { program: safeProgram(activated) };
    });
  }

  async completeProgram(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    programId: string,
    input: { expectedVersion: number },
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relationship = await this.requireRelationship(id, relationshipId);
    await this.assertRelationshipProgramAccess(
      ctx,
      id,
      relationship,
      Permissions.ProgramsComplete,
      'mutate',
    );
    await this.entitlements.assert(id, 'WRITE', 'training');
    return await this.unitOfWork.withTransaction(async (tx) => {
      await this.workoutLifecycle?.assertNoInProgressForProgramTransition(
        id,
        relationship._id,
        objectId(programId, 'PROGRAM_NOT_FOUND'),
        tx,
      );
      const program = await this.training.completeProgram(
        id,
        relationship._id,
        objectId(programId, 'PROGRAM_NOT_FOUND'),
        input.expectedVersion,
        new Date(),
        tx,
      );
      await this.writeAudit(ctx, id, 'ProgramCompleted', program._id, 'complete', tx);
      return { program: safeProgram(program) };
    });
  }

  async archiveProgram(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    programId: string,
    input: { expectedVersion: number },
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relationship = await this.requireRelationship(id, relationshipId);
    await this.assertRelationshipProgramAccess(
      ctx,
      id,
      relationship,
      Permissions.ProgramsArchive,
      'mutate',
    );
    await this.entitlements.assert(id, 'WRITE', 'training');
    return await this.unitOfWork.withTransaction(async (tx) => {
      const program = await this.training.archiveProgram(
        id,
        relationship._id,
        objectId(programId, 'PROGRAM_NOT_FOUND'),
        input.expectedVersion,
        new Date(),
        tx,
      );
      await this.writeAudit(ctx, id, 'ProgramArchived', program._id, 'archive', tx);
      return { program: safeProgram(program) };
    });
  }

  async getProgress(
    ctx: RequestContext,
    workspaceId: string,
    relationshipId: string,
    programId: string,
  ) {
    const id = objectId(workspaceId, 'WORKSPACE_NOT_FOUND');
    const relationship = await this.requireRelationship(id, relationshipId);
    await this.assertRelationshipProgramAccess(
      ctx,
      id,
      relationship,
      Permissions.ProgramsRead,
      'read',
    );
    await this.entitlements.assert(id, 'READ');
    const progress = await this.training.findProgress(
      id,
      relationship._id,
      objectId(programId, 'PROGRAM_NOT_FOUND'),
    );
    if (!progress) throw notFound('PROGRAM_PROGRESS_NOT_FOUND');
    return { progress: safeProgress(progress) };
  }

  async closeActiveProgramForRelationshipEnd(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    now: Date,
    tx: TransactionContext,
  ): Promise<void> {
    await this.workoutLifecycle?.abandonInProgressForRelationshipEnd(
      ctx,
      workspaceId,
      relationshipId,
      now,
      tx,
    );
    const program = await this.training.closeActiveProgramForRelationshipEnd(
      workspaceId,
      relationshipId,
      now,
      tx,
    );
    if (!program) return;
    await this.writeAudit(
      ctx,
      workspaceId,
      'ProgramCompleted',
      program._id,
      'relationship_end',
      tx,
    );
  }

  private async resolveProgramSource(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationship: CoachingRelationshipDocument,
    membership: WorkspaceMembershipDocument,
    source: NonNullable<Parameters<TrainingApplicationService['createProgram']>[3]['source']>,
    scratchDays: DayInput[] | undefined,
    tx: TransactionContext,
  ) {
    if (source.type === 'SCRATCH') {
      return {
        days: await this.buildDays(workspaceId, membership._id, scratchDays ?? [], tx),
        provenance: {},
      };
    }
    if (source.type === 'TEMPLATE') {
      const template = await this.requireTemplate(
        workspaceId,
        membership._id,
        source.templateId,
        tx,
      );
      if (template.status !== 'ACTIVE') throw conflict('PROGRAM_TEMPLATE_ARCHIVED');
      const revision = source.templateRevisionId
        ? await this.training.findTemplateRevision(
            template._id,
            objectId(source.templateRevisionId, 'PROGRAM_TEMPLATE_REVISION_NOT_FOUND'),
            template.workspaceId ?? null,
            tx,
          )
        : await this.requireTemplateRevision(template, tx);
      if (!revision) throw notFound('PROGRAM_TEMPLATE_REVISION_NOT_FOUND');
      await this.assertSnapshotExercisesStillUsable(workspaceId, membership._id, revision.days, tx);
      return {
        days: cloneDays(revision.days),
        provenance: { sourceTemplateId: template._id, sourceTemplateRevisionId: revision._id },
      };
    }
    const sourceProgram = await this.training.findProgramInWorkspace(
      workspaceId,
      objectId(source.programId, 'PROGRAM_NOT_FOUND'),
      tx,
    );
    if (!sourceProgram) throw notFound('PROGRAM_NOT_FOUND');
    const sourceRelationship = await this.relationships.findByIdInWorkspace(
      workspaceId,
      sourceProgram.relationshipId,
      tx,
    );
    if (!sourceRelationship) throw notFound('RELATIONSHIP_NOT_FOUND');
    await this.assertRelationshipProgramAccess(
      ctx,
      workspaceId,
      sourceRelationship,
      Permissions.ProgramsRead,
      'read',
    );
    const revision = source.programRevisionId
      ? await this.training.findProgramRevision(
          workspaceId,
          sourceProgram.relationshipId,
          sourceProgram._id,
          objectId(source.programRevisionId, 'PROGRAM_REVISION_NOT_FOUND'),
          tx,
        )
      : await this.requireProgramRevision(sourceProgram, tx);
    if (!revision) throw notFound('PROGRAM_REVISION_NOT_FOUND');
    await this.assertSnapshotExercisesStillUsable(workspaceId, membership._id, revision.days, tx);
    void relationship;
    return {
      days: cloneDays(revision.days),
      provenance: { sourceProgramId: sourceProgram._id, sourceProgramRevisionId: revision._id },
    };
  }

  private async updateWorkspaceExercise(
    ctx: RequestContext,
    workspaceId: string | undefined,
    exerciseId: string,
    expectedVersion: number,
    patch: Partial<ExerciseDocument>,
    tx: TransactionContext,
  ) {
    const id = objectId(workspaceId ?? '', 'WORKSPACE_NOT_FOUND');
    return await this.training.updateWorkspaceExercise(
      objectId(exerciseId, 'EXERCISE_NOT_FOUND'),
      id,
      (await this.actorMembership(ctx, id, tx))._id,
      expectedVersion,
      patch,
      tx,
    );
  }

  private async withTransaction<T>(
    tx: TransactionContext | undefined,
    operation: (tx: TransactionContext) => Promise<T>,
  ) {
    if (tx) return await operation(tx);
    return await this.unitOfWork.withTransaction(operation);
  }

  private async buildDays(
    workspaceId: ObjectId,
    ownerMembershipId: ObjectId,
    input: DayInput[],
    tx: TransactionContext,
  ): Promise<ProgramDay[]> {
    const dayKeys = new Set<string>();
    const sequences = new Set<number>();
    const days: ProgramDay[] = [];
    for (const day of input) {
      const dayKey = (day.dayKey ?? `day-${day.sequence}`).trim();
      if (!dayKey || dayKeys.has(dayKey)) throw invalid('PROGRAM_DAY_KEY_DUPLICATE');
      if (sequences.has(day.sequence)) throw invalid('PROGRAM_DAY_SEQUENCE_DUPLICATE');
      dayKeys.add(dayKey);
      sequences.add(day.sequence);
      const exerciseInputs = [...(day.exercises ?? [])].sort((a, b) => a.order - b.order);
      const orderSet = new Set<number>();
      for (const exercise of exerciseInputs) {
        if (orderSet.has(exercise.order)) throw invalid('PROGRAM_EXERCISE_ORDER_DUPLICATE');
        orderSet.add(exercise.order);
      }
      const exerciseIds = exerciseInputs.map((exercise) =>
        objectId(exercise.exerciseId, 'EXERCISE_NOT_FOUND'),
      );
      const exercises = await this.training.guardExercisesForUse(
        exerciseIds,
        workspaceId,
        ownerMembershipId,
        tx,
      );
      const byId = new Map(exercises.map((exercise) => [exercise._id.toHexString(), exercise]));
      days.push({
        dayKey,
        sequence: day.sequence,
        name: day.name.trim(),
        type: day.type,
        exercises: exerciseInputs.map((exercise) => {
          const library = byId.get(exercise.exerciseId);
          if (!library) throw notFound('EXERCISE_NOT_FOUND');
          return prescriptionFromInput(exercise, library);
        }),
      });
    }
    return days.sort((a, b) => a.sequence - b.sequence);
  }

  private async exercisesByDay(
    workspaceId: ObjectId,
    ownerMembershipId: ObjectId,
    days: ProgramDay[],
    tx: TransactionContext,
  ) {
    const ids = days.flatMap((day) => day.exercises.map((exercise) => exercise.exerciseId));
    const exercises = await this.training.guardExercisesForUse(
      ids,
      workspaceId,
      ownerMembershipId,
      tx,
    );
    return new Map(exercises.map((exercise) => [exercise._id.toHexString(), exercise]));
  }

  private async assertSnapshotExercisesStillUsable(
    workspaceId: ObjectId,
    ownerMembershipId: ObjectId,
    days: ProgramDay[],
    tx: TransactionContext,
  ) {
    const ids = days.flatMap((day) => day.exercises.map((exercise) => exercise.exerciseId));
    let exercises: ExerciseDocument[];
    try {
      exercises = await this.training.guardExercisesForUse(ids, workspaceId, ownerMembershipId, tx);
    } catch (error) {
      if (error instanceof AppError && error.code === 'EXERCISE_NOT_FOUND') {
        throw conflict('PROGRAM_SOURCE_EXERCISE_UNAVAILABLE');
      }
      throw error;
    }
    if (exercises.length !== new Set(ids.map((id) => id.toHexString())).size) {
      throw conflict('PROGRAM_SOURCE_EXERCISE_UNAVAILABLE');
    }
  }

  private async requireRelationship(
    workspaceId: ObjectId,
    relationshipId: string,
    tx?: TransactionContext,
  ) {
    const relationship = await this.relationships.findByIdInWorkspace(
      workspaceId,
      objectId(relationshipId, 'RELATIONSHIP_NOT_FOUND'),
      tx,
    );
    if (!relationship) throw notFound('RELATIONSHIP_NOT_FOUND');
    return relationship;
  }

  private async requireTemplate(
    workspaceId: ObjectId,
    ownerMembershipId: ObjectId,
    templateId: string,
    tx?: TransactionContext,
  ) {
    const template = await this.training.findTemplateAccessible(
      objectId(templateId, 'PROGRAM_TEMPLATE_NOT_FOUND'),
      workspaceId,
      ownerMembershipId,
      tx,
    );
    if (!template) throw notFound('PROGRAM_TEMPLATE_NOT_FOUND');
    return template;
  }

  private async requireTemplateRevision(
    template: ProgramTemplateDocument,
    tx?: TransactionContext,
  ) {
    const revision = await this.training.findTemplateRevision(
      template._id,
      template.currentRevisionId,
      template.workspaceId ?? null,
      tx,
    );
    if (!revision) throw notFound('PROGRAM_TEMPLATE_REVISION_NOT_FOUND');
    return revision;
  }

  private async requireProgram(
    workspaceId: ObjectId,
    relationshipId: ObjectId,
    programId: string,
    tx?: TransactionContext,
  ) {
    const program = await this.training.findProgram(
      workspaceId,
      relationshipId,
      objectId(programId, 'PROGRAM_NOT_FOUND'),
      tx,
    );
    if (!program) throw notFound('PROGRAM_NOT_FOUND');
    return program;
  }

  private async requireProgramRevision(program: ProgramDocument, tx?: TransactionContext) {
    const revision = await this.training.findProgramRevision(
      program.workspaceId,
      program.relationshipId,
      program._id,
      program.currentRevisionId,
      tx,
    );
    if (!revision) throw notFound('PROGRAM_REVISION_NOT_FOUND');
    return revision;
  }

  private async authorizeWorkspace(ctx: RequestContext, workspaceId: ObjectId, permission: string) {
    await this.accessControl.authorize(ctx, {
      context: 'WORKSPACE',
      workspaceId,
      permission,
      scope: { type: 'WORKSPACE' },
    });
  }

  private async assertRelationshipProgramAccess(
    ctx: RequestContext,
    workspaceId: ObjectId,
    relationship: CoachingRelationshipDocument,
    permission: string,
    action: 'read' | 'mutate',
  ) {
    let decision: AuthorizationDecision;
    try {
      decision = await this.accessControl.authorize(ctx, {
        context: 'WORKSPACE',
        workspaceId,
        permission,
        scope: { type: 'WORKSPACE' },
      });
    } catch (error) {
      if (action === 'read' && isTraineeSelf(ctx, relationship)) return;
      throw error;
    }
    const membership = await this.actorMembership(ctx, workspaceId);
    if (membership.roles.includes('GYM_OWNER') || membership.roles.includes('GYM_MANAGER')) return;
    if (action === 'read' && isTraineeSelf(ctx, relationship)) return;
    const assignments = await this.relationships.listActiveAssignments(relationship._id);
    const isPrimary = assignments.some(
      (assignment) =>
        assignment.assignmentType === 'PRIMARY_TRAINER' &&
        assignment.staffMembershipId.equals(membership._id),
    );
    if (isPrimary) return;
    const isAssistant = assignments.some(
      (assignment) =>
        assignment.assignmentType === 'ASSISTANT_TRAINER' &&
        assignment.staffMembershipId.equals(membership._id),
    );
    if (isAssistant && action === 'read') return;
    if (isAssistant && decision.source === 'EXPLICIT_GRANT') return;
    throw forbidden();
  }

  private async actorMembership(
    ctx: RequestContext,
    workspaceId: ObjectId,
    tx?: TransactionContext,
  ) {
    const membership = await this.memberships.findByUserInWorkspace(
      workspaceId,
      actorObjectId(ctx),
      tx,
    );
    if (membership?.status !== 'ACTIVE') throw forbidden();
    ctx.workspaceMembershipId = membership._id.toHexString();
    return membership;
  }

  private async writeAudit(
    ctx: RequestContext,
    workspaceId: ObjectId | undefined,
    eventType: string,
    entityId: ObjectId,
    action: string,
    tx: TransactionContext,
  ) {
    await this.audit.write(
      {
        eventType,
        ...(workspaceId ? { workspaceId } : {}),
        actor: {
          ...(ctx.userId && ObjectId.isValid(ctx.userId)
            ? { userId: new ObjectId(ctx.userId) }
            : {}),
          ...(ctx.workspaceMembershipId && ObjectId.isValid(ctx.workspaceMembershipId)
            ? { workspaceMembershipId: new ObjectId(ctx.workspaceMembershipId) }
            : {}),
          ...(ctx.platformMembershipId && ObjectId.isValid(ctx.platformMembershipId)
            ? { platformMembershipId: new ObjectId(ctx.platformMembershipId) }
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
    workspaceId: ObjectId | undefined,
    eventType: string,
    aggregateType: string,
    aggregateId: ObjectId,
    tx: TransactionContext,
  ) {
    await this.outbox.write(
      {
        eventType,
        aggregateType,
        aggregateId,
        ...(workspaceId ? { workspaceId } : {}),
        payload: { aggregateId: aggregateId.toHexString() },
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }
}

interface PageQuery {
  cursor?: string;
  limit?: number;
  includeArchived?: boolean;
}

function buildExercise(
  scope: TrainingScope,
  workspaceId: ObjectId | null,
  ownerMembershipId: ObjectId | null,
  input: Omit<ExerciseInput, 'scope'>,
  now: Date,
): ExerciseDocument {
  const names = compactNames(input.names);
  return {
    _id: new ObjectId(),
    scope,
    workspaceId: scope === 'SYSTEM' ? null : workspaceId,
    ownerMembershipId: scope === 'PRIVATE' ? ownerMembershipId : null,
    names,
    normalizedNames: normalizedNames(names),
    primaryMuscles: uniqueStrings(input.primaryMuscles ?? []),
    secondaryMuscles: uniqueStrings(input.secondaryMuscles ?? []),
    equipment: uniqueStrings(input.equipment ?? []),
    exerciseType: input.exerciseType.trim(),
    ...(input.difficulty ? { difficulty: input.difficulty.trim() } : {}),
    ...(input.instructions ? { instructions: input.instructions.trim() } : {}),
    ...(input.imageFileId ? { imageFileId: objectId(input.imageFileId, 'FILE_NOT_FOUND') } : {}),
    ...(input.videoFileId ? { videoFileId: objectId(input.videoFileId, 'FILE_NOT_FOUND') } : {}),
    ...(input.externalVideoUrl ? { externalVideoUrl: input.externalVideoUrl.trim() } : {}),
    status: 'ACTIVE',
    version: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function exercisePatch(input: Partial<ExerciseInput>) {
  return {
    ...(input.names
      ? {
          names: compactNames(input.names),
          normalizedNames: normalizedNames(compactNames(input.names)),
        }
      : {}),
    ...(input.primaryMuscles ? { primaryMuscles: uniqueStrings(input.primaryMuscles) } : {}),
    ...(input.secondaryMuscles ? { secondaryMuscles: uniqueStrings(input.secondaryMuscles) } : {}),
    ...(input.equipment ? { equipment: uniqueStrings(input.equipment) } : {}),
    ...(input.exerciseType ? { exerciseType: input.exerciseType.trim() } : {}),
    ...(input.difficulty ? { difficulty: input.difficulty.trim() } : {}),
    ...(input.instructions ? { instructions: input.instructions.trim() } : {}),
    ...(input.imageFileId ? { imageFileId: objectId(input.imageFileId, 'FILE_NOT_FOUND') } : {}),
    ...(input.videoFileId ? { videoFileId: objectId(input.videoFileId, 'FILE_NOT_FOUND') } : {}),
    ...(input.externalVideoUrl ? { externalVideoUrl: input.externalVideoUrl.trim() } : {}),
  };
}

function compactNames(names: { ar?: string; en?: string }) {
  const result = {
    ...(names.ar?.trim() ? { ar: names.ar.trim() } : {}),
    ...(names.en?.trim() ? { en: names.en.trim() } : {}),
  };
  if (!result.ar && !result.en) throw invalid('EXERCISE_NAME_REQUIRED');
  return result;
}

function normalizedNames(names: { ar?: string; en?: string }) {
  return uniqueStrings(
    [names.ar, names.en].filter(Boolean).map((name) => normalizeName(name ?? '')),
  );
}

function normalizeName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function prescriptionFromInput(
  input: PrescriptionInput,
  exercise: ExerciseDocument,
): ExercisePrescription {
  return {
    prescriptionId: input.prescriptionId?.trim() || new ObjectId().toHexString(),
    exerciseId: exercise._id,
    exerciseNameSnapshot: displayName(exercise),
    order: input.order,
    setStructure: input.setStructure.trim(),
    targetSets: input.targetSets,
    ...(input.repRange ? { repRange: input.repRange } : {}),
    ...(input.targetWeight !== undefined ? { targetWeight: input.targetWeight } : {}),
    ...(input.restSeconds !== undefined ? { restSeconds: input.restSeconds } : {}),
    ...(input.tempo ? { tempo: input.tempo.trim() } : {}),
    ...(input.rpe !== undefined ? { rpe: input.rpe } : {}),
    ...(input.rir !== undefined ? { rir: input.rir } : {}),
    ...(input.groupId ? { groupId: input.groupId.trim() } : {}),
    ...(input.groupType ? { groupType: input.groupType.trim() } : {}),
    ...(input.notes ? { notes: input.notes.trim() } : {}),
  };
}

function displayName(exercise: ExerciseDocument) {
  return exercise.names.en ?? exercise.names.ar ?? 'Exercise';
}

function assertTemplateExerciseCompatibility(
  scope: TrainingScope,
  days: ProgramDay[],
  exercises: Map<string, ExerciseDocument>,
) {
  if (scope !== 'GYM') return;
  for (const prescription of days.flatMap((day) => day.exercises)) {
    if (exercises.get(prescription.exerciseId.toHexString())?.scope === 'PRIVATE') {
      throw invalid('PRIVATE_EXERCISE_NOT_ALLOWED_IN_GYM_TEMPLATE');
    }
  }
}

function assertActiveTopologyUnchanged(current: ProgramDay[], next: ProgramDay[]) {
  const currentTopology = current.map((day) => ({
    dayKey: day.dayKey,
    sequence: day.sequence,
    executable: isExecutable(day),
  }));
  const nextTopology = next.map((day) => ({
    dayKey: day.dayKey,
    sequence: day.sequence,
    executable: isExecutable(day),
  }));
  if (JSON.stringify(currentTopology) !== JSON.stringify(nextTopology)) {
    throw invalid('ACTIVE_PROGRAM_TOPOLOGY_CHANGE_UNSUPPORTED');
  }
}

function assertHasExecutableDay(days: ProgramDay[]) {
  if (!days.some(isExecutable)) throw invalid('PROGRAM_EXECUTABLE_DAY_REQUIRED');
}

function firstExecutableSequence(days: ProgramDay[]) {
  const day = days.sort((a, b) => a.sequence - b.sequence).find(isExecutable);
  if (!day) throw invalid('PROGRAM_EXECUTABLE_DAY_REQUIRED');
  return day.sequence;
}

function isExecutable(day: ProgramDay) {
  return day.type !== 'REST' && day.exercises.length > 0;
}

function cloneDays(days: ProgramDay[]): ProgramDay[] {
  return days.map((day) => ({
    ...day,
    exercises: day.exercises.map((exercise) => ({ ...exercise })),
  }));
}

function isTraineeSelf(ctx: RequestContext, relationship: CoachingRelationshipDocument) {
  return Boolean(
    ctx.userId &&
      ObjectId.isValid(ctx.userId) &&
      relationship.traineeUserId.equals(new ObjectId(ctx.userId)),
  );
}

function safeExercise(exercise: ExerciseDocument) {
  return {
    id: exercise._id.toHexString(),
    scope: exercise.scope,
    workspaceId: exercise.workspaceId?.toHexString(),
    ownerMembershipId: exercise.ownerMembershipId?.toHexString(),
    names: exercise.names,
    primaryMuscles: exercise.primaryMuscles,
    secondaryMuscles: exercise.secondaryMuscles,
    equipment: exercise.equipment,
    exerciseType: exercise.exerciseType,
    difficulty: exercise.difficulty,
    instructions: exercise.instructions,
    imageFileId: exercise.imageFileId?.toHexString(),
    videoFileId: exercise.videoFileId?.toHexString(),
    externalVideoUrl: exercise.externalVideoUrl,
    status: exercise.status,
    version: exercise.version,
  };
}

function safeTemplate(template: ProgramTemplateDocument) {
  return {
    id: template._id.toHexString(),
    scope: template.scope,
    workspaceId: template.workspaceId?.toHexString(),
    ownerMembershipId: template.ownerMembershipId?.toHexString(),
    name: template.name,
    description: template.description,
    currentRevisionId: template.currentRevisionId.toHexString(),
    status: template.status,
    version: template.version,
  };
}

function safeTemplateRevision(revision: { _id: ObjectId; revision: number; days: ProgramDay[] }) {
  return {
    id: revision._id.toHexString(),
    revision: revision.revision,
    days: safeDays(revision.days),
  };
}

function safeProgram(program: ProgramDocument) {
  return {
    id: program._id.toHexString(),
    workspaceId: program.workspaceId.toHexString(),
    relationshipId: program.relationshipId.toHexString(),
    name: program.name,
    sourceTemplateId: program.sourceTemplateId?.toHexString(),
    sourceTemplateRevisionId: program.sourceTemplateRevisionId?.toHexString(),
    sourceProgramId: program.sourceProgramId?.toHexString(),
    sourceProgramRevisionId: program.sourceProgramRevisionId?.toHexString(),
    status: program.status,
    startedAt: program.startedAt?.toISOString(),
    endedAt: program.endedAt?.toISOString(),
    currentRevisionId: program.currentRevisionId.toHexString(),
    version: program.version,
  };
}

function safeProgramRevision(revision: ProgramRevisionDocument) {
  return {
    id: revision._id.toHexString(),
    revision: revision.revision,
    days: safeDays(revision.days),
  };
}

function safeDays(days: ProgramDay[]) {
  return days.map((day) => ({
    ...day,
    exercises: day.exercises.map((exercise) => ({
      ...exercise,
      exerciseId: exercise.exerciseId.toHexString(),
    })),
  }));
}

function safeProgress(progress: {
  programId: ObjectId;
  programRevisionId: ObjectId;
  currentDaySequence: number;
  completedDayCount: number;
  skippedDayCount: number;
  version: number;
}) {
  return {
    programId: progress.programId.toHexString(),
    programRevisionId: progress.programRevisionId.toHexString(),
    currentDaySequence: progress.currentDaySequence,
    completedDayCount: progress.completedDayCount,
    skippedDayCount: progress.skippedDayCount,
    version: progress.version,
  };
}

function page<T, R extends { id: string }>(data: T[], mapper: (value: T) => R) {
  const mapped = data.map(mapper);
  return {
    data: mapped,
    meta: {
      nextCursor: mapped.length > 0 ? mapped[mapped.length - 1]?.id : null,
      hasMore: false,
    },
  };
}

function optionalPageQuery(query: PageQuery) {
  const afterId = query.cursor ? optionalObjectId(query.cursor, 'CURSOR_INVALID') : undefined;
  return {
    ...(query.includeArchived !== undefined ? { includeArchived: query.includeArchived } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(afterId ? { afterId } : {}),
  };
}

function objectId(value: string, code: string): ObjectId {
  if (!value || !ObjectId.isValid(value)) throw notFound(code);
  return new ObjectId(value);
}

function optionalObjectId(value: string | undefined, code: string): ObjectId | undefined {
  if (!value) return undefined;
  return objectId(value, code);
}

function actorObjectId(ctx: RequestContext): ObjectId {
  if (!ctx.userId || !ObjectId.isValid(ctx.userId)) {
    throw new AppError({
      code: 'AUTH_REQUIRED',
      httpStatus: 401,
      message: 'Authentication is required.',
    });
  }
  return new ObjectId(ctx.userId);
}

function invalid(code: string): AppError {
  return new AppError({ code, httpStatus: 422, message: 'The training request is invalid.' });
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The training state has changed.' });
}

function notFound(code: string): AppError {
  return new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
}

function forbidden(): AppError {
  return new AppError({
    code: 'PERMISSION_DENIED',
    httpStatus: 403,
    message: 'Permission denied.',
  });
}
