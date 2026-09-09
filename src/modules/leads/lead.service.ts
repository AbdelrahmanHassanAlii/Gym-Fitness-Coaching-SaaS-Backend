import { ObjectId } from 'mongodb';
import type { AccessControlService } from '../../core/access-control/access-control.service';
import type { AuditWriter } from '../../core/audit/audit.writer';
import type { CredentialDigests } from '../../core/auth/credential-digests';
import type { PasswordHasher } from '../../core/auth/password-hasher';
import { normalizePhoneToE164 } from '../../core/auth/phone-normalizer';
import type { TransactionContext, UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { OutboxWriter } from '../../core/events/outbox.writer';
import type { RequestContext } from '../../core/request-context/request-context';
import { normalizeEmail } from '../auth/auth.normalization';
import type { AuthApplicationService, AuthRequestMetadata } from '../auth/auth.service';
import type { IdentityRepository } from '../identity/identity.repository';
import { Permissions, systemPermissionProfiles } from '../permissions/permission.registry';
import type { PermissionProfileRepository } from '../permissions/permission.repository';
import type { SubscriptionApplicationService } from '../subscriptions/subscription.service';
import type {
  InvitationRepository,
  WorkspaceMembershipRepository,
  WorkspaceRepository,
} from '../workspaces/workspace.repository';
import type { WorkspaceApplicationService } from '../workspaces/workspace.service';
import type { InvitationDocument, WorkspaceMembershipRole } from '../workspaces/workspace.types';
import type { LeadRepository } from './lead.repository';
import type {
  ConvertLeadInput,
  LeadDocument,
  LeadStatus,
  UpdateLeadMetadataInput,
} from './lead.types';

const transitions: Record<LeadStatus, LeadStatus[]> = {
  NEW: ['CONTACTED', 'QUALIFIED', 'ON_HOLD', 'LOST', 'DUPLICATE'],
  CONTACTED: ['QUALIFIED', 'ON_HOLD', 'LOST'],
  QUALIFIED: ['ON_HOLD', 'LOST'],
  ON_HOLD: ['CONTACTED', 'QUALIFIED', 'LOST'],
  CONVERTED: [],
  LOST: [],
  DUPLICATE: [],
};

const conversionSources: LeadStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED'];

export class LeadApplicationService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly leads: LeadRepository,
    private readonly identity: IdentityRepository,
    private readonly workspacesRepo: WorkspaceRepository,
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly invitations: InvitationRepository,
    private readonly permissionProfiles: PermissionProfileRepository,
    private readonly workspaceService: WorkspaceApplicationService,
    private readonly subscriptions: SubscriptionApplicationService,
    private readonly accessControl: AccessControlService,
    private readonly auth: AuthApplicationService,
    private readonly credentialDigests: CredentialDigests,
    private readonly passwordHasher: PasswordHasher,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async createPublicLead(ctx: RequestContext, input: PublicLeadInput) {
    const identifiers = normalizeLeadIdentifiers(input.email, input.phone);
    const now = new Date();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const lead = await this.leads.create({ ...input, ...identifiers, now }, tx);
      const duplicates = await this.leads.findPossibleDuplicates(
        { ...identifiers, excludeLeadId: lead._id },
        tx,
      );
      await this.writeOutbox(ctx, 'LeadCreated', 'lead', lead._id, { leadId: lead._id }, tx);
      if (duplicates.length > 0) {
        await this.writeOutbox(
          ctx,
          'PossibleDuplicateLeadDetected',
          'lead',
          lead._id,
          { leadId: lead._id.toHexString(), duplicateCount: duplicates.length },
          tx,
        );
      }
      return safeLead(lead);
    });
  }

  async listLeads(input: {
    status?: LeadStatus;
    customerInterest?: LeadDocument['customerInterest'];
    cursor?: string;
    limit?: number;
  }) {
    const limit = Math.min(input.limit ?? 25, 100);
    const rows = await this.leads.list({
      ...(input.status ? { status: input.status } : {}),
      ...(input.customerInterest ? { customerInterest: input.customerInterest } : {}),
      ...(input.cursor ? { cursor: new Date(input.cursor) } : {}),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(safeLead),
      meta: {
        nextCursor: rows.length > limit && last ? last.createdAt.toISOString() : null,
        hasMore: rows.length > limit,
      },
    };
  }

  async getLead(leadId: string) {
    const lead = await this.requireLead(objectId(leadId, 'LEAD_NOT_FOUND'));
    return safeLead(lead);
  }

  async updateLead(ctx: RequestContext, leadId: string, input: UpdateLeadInput) {
    const id = objectId(leadId, 'LEAD_NOT_FOUND');
    return await this.unitOfWork.withTransaction(async (tx) => {
      const before = await this.requireLead(id, tx);
      const { expectedVersion, ...metadata } = input;
      const updated = await this.leads.updateMetadata(
        id,
        expectedVersion,
        metadata,
        new Date(),
        tx,
      );
      await this.writeAudit(ctx, 'LeadUpdated', updated._id, 'update', before, updated, tx);
      await this.writeOutbox(ctx, 'LeadUpdated', 'lead', updated._id, { leadId: leadId }, tx);
      return safeLead(updated);
    });
  }

  async changeStatus(ctx: RequestContext, leadId: string, input: StatusInput) {
    if (input.targetStatus === 'CONVERTED') {
      throw conflict('LEAD_CONVERTED_REQUIRES_CONVERT_COMMAND');
    }
    const id = objectId(leadId, 'LEAD_NOT_FOUND');
    return await this.unitOfWork.withTransaction(async (tx) => {
      const before = await this.requireLead(id, tx);
      if (before.status === 'DUPLICATE') {
        await this.accessControl.authorize(ctx, {
          context: 'PLATFORM',
          permission: Permissions.LeadsMarkDuplicate,
        });
        if (
          !before.duplicatePreviousStatus ||
          input.targetStatus !== before.duplicatePreviousStatus
        ) {
          throw conflict('LEAD_DUPLICATE_CORRECTION_INVALID');
        }
        const corrected = await this.leads.correctDuplicate(
          id,
          input.expectedVersion,
          input.targetStatus as Exclude<LeadStatus, 'DUPLICATE'>,
          new Date(),
          tx,
        );
        await this.writeAudit(
          ctx,
          'LeadDuplicateCorrected',
          corrected._id,
          'status',
          before,
          corrected,
          tx,
        );
        await this.writeOutbox(ctx, 'LeadStatusChanged', 'lead', corrected._id, { leadId }, tx);
        return safeLead(corrected);
      }
      if (!transitions[before.status].includes(input.targetStatus)) {
        throw conflict('LEAD_INVALID_TRANSITION');
      }
      const updated = await this.leads.transitionStatus(
        id,
        input.expectedVersion,
        [before.status],
        input.targetStatus,
        new Date(),
        tx,
      );
      await this.writeAudit(ctx, 'LeadStatusChanged', updated._id, 'status', before, updated, tx);
      await this.writeOutbox(ctx, 'LeadStatusChanged', 'lead', updated._id, { leadId }, tx);
      return safeLead(updated);
    });
  }

  async markDuplicate(
    ctx: RequestContext,
    leadId: string,
    input: DuplicateInput,
    tx: TransactionContext,
  ) {
    const id = objectId(leadId, 'LEAD_NOT_FOUND');
    const before = await this.requireLead(id, tx);
    const updated = await this.leads.markDuplicate(
      id,
      input.expectedVersion,
      actorObjectId(ctx),
      { now: new Date() },
      tx,
    );
    await this.writeAudit(
      ctx,
      'LeadMarkedDuplicate',
      updated._id,
      'mark_duplicate',
      before,
      updated,
      tx,
    );
    await this.writeOutbox(ctx, 'LeadStatusChanged', 'lead', updated._id, { leadId }, tx);
    return safeLead(updated);
  }

  async merge(ctx: RequestContext, leadId: string, input: MergeInput, tx: TransactionContext) {
    const sourceId = objectId(leadId, 'LEAD_NOT_FOUND');
    const targetId = objectId(input.targetLeadId, 'LEAD_NOT_FOUND');
    if (sourceId.equals(targetId)) throw conflict('LEAD_MERGE_SELF_INVALID');
    const source = await this.requireLead(sourceId, tx);
    await this.leads.guardMergeTarget(targetId, input.targetExpectedVersion, new Date(), tx);
    if (source.status === 'CONVERTED' || source.status === 'DUPLICATE') {
      throw conflict('LEAD_MERGE_SOURCE_INVALID');
    }
    const updated = await this.leads.markDuplicate(
      sourceId,
      input.expectedVersion,
      actorObjectId(ctx),
      { mergedIntoLeadId: targetId, now: new Date() },
      tx,
    );
    await this.writeAudit(ctx, 'LeadMerged', updated._id, 'merge', source, updated, tx);
    await this.writeOutbox(
      ctx,
      'LeadStatusChanged',
      'lead',
      updated._id,
      {
        sourceLeadId: leadId,
        targetLeadId: input.targetLeadId,
      },
      tx,
    );
    return safeLead(updated);
  }

  async convert(
    ctx: RequestContext,
    leadId: string,
    input: ConvertLeadInput,
    tx: TransactionContext,
  ) {
    await this.requireCommercialAccessForOverrides(ctx, input);
    const id = objectId(leadId, 'LEAD_NOT_FOUND');
    const before = await this.requireLead(id, tx);
    if (!conversionSources.includes(before.status)) throw conflict('LEAD_CONVERSION_INVALID');
    const now = new Date();
    const owner = await this.resolveOwnerIdentity(before, input, now, tx);
    const workspace = await this.workspacesRepo.create(
      {
        type: input.workspaceType,
        name: input.workspace.name,
        ownerUserId: owner._id,
        timezone: input.workspace.timezone,
        defaultLanguage: input.workspace.defaultLanguage ?? 'en',
        ...(input.workspace.country ? { country: input.workspace.country } : {}),
        ...(input.workspace.city ? { city: input.workspace.city } : {}),
        ...(input.workspace.governorate ? { governorate: input.workspace.governorate } : {}),
        createdFromLeadId: before._id,
        status: 'PENDING_ACTIVATION',
        now,
      },
      tx,
    );
    const ownerRole: WorkspaceMembershipRole =
      input.workspaceType === 'GYM' ? 'GYM_OWNER' : 'TRAINER';
    const ownerProfile = await this.ensureWorkspaceSystemProfile(workspace._id, ownerRole, now, tx);
    const membership = await this.memberships.createInvited(
      {
        workspaceId: workspace._id,
        userId: owner._id,
        roles: [ownerRole],
        permissionProfileIds: ownerProfile ? [ownerProfile._id] : [],
        now,
      },
      tx,
    );
    const token = this.credentialDigests.randomSecret(32);
    const invitation = await this.invitations.create(
      {
        _id: new ObjectId(),
        workspaceId: workspace._id,
        type: 'OWNER_ACTIVATION',
        ...(owner.email ? { email: owner.email } : {}),
        ...(owner.normalizedEmail ? { normalizedEmail: owner.normalizedEmail } : {}),
        ...(owner.phone ? { phone: owner.phone } : {}),
        ...(owner.normalizedPhone ? { normalizedPhone: owner.normalizedPhone } : {}),
        intendedRoles: [ownerRole],
        branchIds: [],
        invitedBy: actorObjectId(ctx),
        tokenDigest: this.credentialDigests.hashHighEntropySecret(token),
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
      },
      tx,
    );

    let subscription: unknown;
    if (input.subscription.startMode === 'TRIAL') {
      subscription = await this.subscriptions.startTrial(
        ctx,
        workspace._id.toHexString(),
        {
          expectedVersion: 0,
          planVersionId: input.subscription.planVersionId,
          billingPeriod: input.subscription.billingPeriod,
          effectiveFrom: input.subscription.effectiveFrom ?? now.toISOString(),
        },
        tx,
      );
    } else {
      subscription = await this.subscriptions.createPendingActivationIntent(
        ctx,
        workspace._id,
        input.subscription,
        tx,
      );
    }
    const converted = await this.leads.convert(
      id,
      input.expectedVersion,
      actorObjectId(ctx),
      workspace._id,
      now,
      tx,
    );
    await this.writeAudit(ctx, 'LeadConverted', converted._id, 'convert', before, converted, tx);
    await this.writeOutbox(
      ctx,
      'LeadConverted',
      'lead',
      converted._id,
      {
        leadId,
        workspaceId: workspace._id.toHexString(),
      },
      tx,
    );
    await this.writeOutbox(
      ctx,
      'OwnerActivationRequired',
      'invitation',
      invitation._id,
      {
        workspaceId: workspace._id.toHexString(),
        ownerUserId: owner._id.toHexString(),
      },
      tx,
    );
    return {
      workspace: safeWorkspace(workspace),
      subscription,
      ownerInvitation: { id: invitation._id.toHexString(), token },
      lead: safeLead(converted),
      membership: { id: membership._id.toHexString(), status: membership.status },
    };
  }

  async reissueOwnerActivation(ctx: RequestContext, leadId: string) {
    const id = objectId(leadId, 'LEAD_NOT_FOUND');
    return await this.unitOfWork.withTransaction(async (tx) => {
      const now = new Date();
      const lead = await this.requireLead(id, tx);
      if (lead.status !== 'CONVERTED' || !lead.convertedWorkspaceId) {
        throw conflict('OWNER_ACTIVATION_REISSUE_INVALID');
      }
      const workspace = await this.workspacesRepo.findById(lead.convertedWorkspaceId, tx);
      if (workspace?.status !== 'PENDING_ACTIVATION') {
        throw conflict('OWNER_ACTIVATION_REISSUE_INVALID');
      }
      const user = await this.identity.findById(workspace.ownerUserId, tx);
      if (user?.status !== 'PENDING_ACTIVATION') {
        throw conflict('OWNER_ACTIVATION_REISSUE_INVALID');
      }
      const membership = await this.memberships.findByUserInWorkspace(
        workspace._id,
        workspace.ownerUserId,
        tx,
      );
      if (membership?.status !== 'INVITED') {
        throw conflict('OWNER_ACTIVATION_REISSUE_INVALID');
      }
      const invitation = await this.invitations.findPendingOwnerActivationByWorkspace(
        workspace._id,
        now,
        tx,
      );
      if (
        !invitation?.workspaceId?.equals(workspace._id) ||
        !invitation.intendedRoles.some((role) => membership.roles.includes(role)) ||
        !invitationMatchesOwner(invitation, user)
      ) {
        throw conflict('OWNER_ACTIVATION_REISSUE_INVALID');
      }
      const token = this.credentialDigests.randomSecret(32);
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const rotated = await this.invitations.rotatePendingOwnerActivationToken(
        invitation._id,
        workspace._id,
        invitation.tokenDigest,
        this.credentialDigests.hashHighEntropySecret(token),
        expiresAt,
        now,
        tx,
      );
      await this.audit.write(
        {
          eventType: 'OwnerActivationReissued',
          actor: auditActor(ctx),
          entity: { type: 'invitation', id: rotated._id },
          action: 'reissue_owner_activation',
          before: safeInvitationForAudit(invitation),
          after: safeInvitationForAudit(rotated),
          ipAddress: ctx.ipAddress,
          ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
          correlationId: ctx.correlationId,
        },
        tx,
      );
      await this.writeOutbox(
        ctx,
        'OwnerActivationRequired',
        'invitation',
        rotated._id,
        {
          leadId,
          workspaceId: workspace._id.toHexString(),
          ownerUserId: workspace.ownerUserId.toHexString(),
          invitationId: rotated._id.toHexString(),
          expiresAt: rotated.expiresAt.toISOString(),
          reissuedAt: now.toISOString(),
        },
        tx,
      );
      return {
        invitationId: rotated._id.toHexString(),
        token,
        expiresAt: rotated.expiresAt.toISOString(),
        ownerActivationRequired: true,
      };
    });
  }

  async completeOwnerActivation(
    ctx: RequestContext,
    input: { token: string; verification: { challengeId: string; code: string }; password: string },
    metadata: AuthRequestMetadata,
    tx: TransactionContext,
  ) {
    const now = new Date();
    const digest = this.credentialDigests.hashHighEntropySecret(input.token);
    const invitation = await this.invitations.findPendingByDigest(digest, now, tx);
    if (!invitation?.workspaceId || invitation.type !== 'OWNER_ACTIVATION')
      throw invalidInvitation();
    const workspace = await this.workspacesRepo.findById(invitation.workspaceId, tx);
    if (!workspace) throw invalidInvitation();
    const user = await this.identity.findById(workspace.ownerUserId, tx);
    if (user?.status !== 'PENDING_ACTIVATION') throw invalidInvitation();
    const expectedPurpose = invitation.normalizedEmail
      ? 'EMAIL_VERIFICATION'
      : 'PHONE_VERIFICATION';
    const identifier = invitation.normalizedEmail
      ? { normalizedEmail: invitation.normalizedEmail }
      : { normalizedPhone: required(invitation.normalizedPhone) };
    await this.auth.verifyIdentifierChallengeForActivation({
      purpose: expectedPurpose,
      challengeId: objectId(input.verification.challengeId, 'AUTH_CHALLENGE_INVALID'),
      code: input.verification.code,
      userId: user._id,
      identifier,
      metadata,
      tx,
    });
    const passwordHash = await this.passwordHasher.hash(input.password);
    await this.identity.activatePending(user._id, passwordHash, now, tx);
    const activationCtx = { ...ctx, userId: user._id.toHexString() };
    const membership = await this.workspaceService.completeOwnerActivation(
      activationCtx,
      invitation,
      user._id,
      tx,
    );
    return {
      success: true,
      workspaceId: workspace._id.toHexString(),
      membershipId: membership._id.toHexString(),
    };
  }

  private async resolveOwnerIdentity(
    lead: LeadDocument,
    input: ConvertLeadInput,
    now: Date,
    tx: TransactionContext,
  ) {
    const normalizedEmail = input.owner.email
      ? normalizeEmail(input.owner.email)
      : lead.normalizedEmail;
    const normalizedPhone = input.owner.phone
      ? normalizePhoneToE164(input.owner.phone)
      : lead.normalizedPhone;
    const [emailUser, phoneUser] = await Promise.all([
      this.identity.findByNormalizedEmail(normalizedEmail, tx),
      this.identity.findByNormalizedPhone(normalizedPhone, tx),
    ]);
    if (emailUser && phoneUser && !emailUser._id.equals(phoneUser._id)) {
      throw conflict('AUTH_IDENTIFIER_CONFLICT');
    }
    const existing = emailUser ?? phoneUser;
    if (existing) {
      if (existing.status !== 'ACTIVE') throw conflict('OWNER_IDENTITY_INVALID');
      return existing;
    }
    return await this.identity.createPendingActivation(
      {
        email: input.owner.email ?? lead.email,
        normalizedEmail,
        phone: input.owner.phone ?? lead.phone,
        normalizedPhone,
        firstName:
          input.owner.firstName ?? lead.contactPerson ?? lead.name ?? lead.gymName ?? 'Owner',
        lastName: input.owner.lastName ?? 'Activation',
        preferredLanguage: input.owner.preferredLanguage ?? 'en',
        timezone: input.owner.timezone ?? input.workspace.timezone,
        now,
      },
      tx,
    );
  }

  private async requireCommercialAccessForOverrides(ctx: RequestContext, input: ConvertLeadInput) {
    if (input.subscription.startMode === 'PENDING_ACTIVATION' && input.subscription.effectiveFrom) {
      throw new AppError({
        code: 'SUBSCRIPTION_EFFECTIVE_FROM_UNSUPPORTED',
        httpStatus: 422,
        message: 'Pending activation conversions start at owner activation time.',
      });
    }
    if (
      !input.subscription.limits &&
      !input.subscription.enabledFeatures &&
      !input.subscription.effectiveFrom
    )
      return;
    await this.accessControl.authorize(ctx, {
      context: 'PLATFORM',
      permission: Permissions.SubscriptionsChangeTerms,
    });
  }

  private async ensureWorkspaceSystemProfile(
    workspaceId: ObjectId,
    roleKey: WorkspaceMembershipRole,
    now: Date,
    tx: TransactionContext,
  ) {
    const existing = await this.permissionProfiles.findSystemDefault(
      { context: 'WORKSPACE', workspaceId, roleKey },
      tx,
    );
    if (existing) return existing;
    const seed = systemPermissionProfiles.find(
      (profile) => profile.context === 'WORKSPACE' && profile.roleKey === roleKey,
    );
    if (!seed) return null;
    return await this.permissionProfiles.create(
      {
        context: 'WORKSPACE',
        workspaceId,
        roleKey,
        name: seed.name,
        permissions: seed.permissions,
        isSystemDefault: true,
        now,
      },
      tx,
    );
  }

  private async requireLead(leadId: ObjectId, tx?: TransactionContext) {
    const lead = await this.leads.findById(leadId, tx);
    if (!lead) throw notFound('LEAD_NOT_FOUND');
    return lead;
  }

  private async writeAudit(
    ctx: RequestContext,
    eventType: string,
    entityId: ObjectId,
    action: string,
    before: LeadDocument,
    after: LeadDocument,
    tx: TransactionContext,
  ) {
    await this.audit.write(
      {
        eventType,
        actor: auditActor(ctx),
        entity: { type: 'lead', id: entityId },
        action,
        before: safeLead(before),
        after: safeLead(after),
        ipAddress: ctx.ipAddress,
        ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }

  private async writeOutbox(
    ctx: RequestContext,
    eventType: string,
    aggregateType: string,
    aggregateId: ObjectId,
    payload: Record<string, unknown>,
    tx: TransactionContext,
  ) {
    await this.outbox.write(
      { eventType, aggregateType, aggregateId, payload, correlationId: ctx.correlationId },
      tx,
    );
  }
}

type PublicLeadInput = Omit<
  Parameters<LeadRepository['create']>[0],
  'normalizedEmail' | 'normalizedPhone'
>;
type UpdateLeadInput = UpdateLeadMetadataInput & { expectedVersion: number };
type StatusInput = { expectedVersion: number; targetStatus: LeadStatus; reason?: string };
type DuplicateInput = { expectedVersion: number; reason?: string };
type MergeInput = DuplicateInput & { targetLeadId: string; targetExpectedVersion: number };

function safeLead(lead: LeadDocument) {
  return {
    id: lead._id.toHexString(),
    customerInterest: lead.customerInterest,
    name: lead.name,
    gymName: lead.gymName,
    contactPerson: lead.contactPerson,
    phone: lead.phone,
    email: lead.email,
    governorate: lead.governorate,
    city: lead.city,
    estimatedTrainees: lead.estimatedTrainees,
    estimatedStaff: lead.estimatedStaff,
    numberOfBranches: lead.numberOfBranches,
    billingInterest: lead.billingInterest,
    referralCode: lead.referralCode,
    source: lead.source,
    notes: lead.notes,
    status: lead.status,
    convertedWorkspaceId: lead.convertedWorkspaceId?.toHexString(),
    convertedBy: lead.convertedBy?.toHexString(),
    convertedAt: lead.convertedAt?.toISOString(),
    duplicatePreviousStatus: lead.duplicatePreviousStatus,
    duplicateMarkedAt: lead.duplicateMarkedAt?.toISOString(),
    duplicateMarkedBy: lead.duplicateMarkedBy?.toHexString(),
    mergedIntoLeadId: lead.mergedIntoLeadId?.toHexString(),
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
    version: lead.version,
  };
}

function safeWorkspace(workspace: {
  _id: ObjectId;
  type: string;
  name: string;
  ownerUserId: ObjectId;
  status: string;
}) {
  return {
    id: workspace._id.toHexString(),
    type: workspace.type,
    name: workspace.name,
    ownerUserId: workspace.ownerUserId.toHexString(),
    status: workspace.status,
  };
}

function safeInvitationForAudit(invitation: InvitationDocument) {
  return {
    id: invitation._id.toHexString(),
    workspaceId: invitation.workspaceId?.toHexString(),
    type: invitation.type,
    status: invitation.status,
    expiresAt: invitation.expiresAt.toISOString(),
    updatedAt: invitation.updatedAt.toISOString(),
  };
}

function invitationMatchesOwner(
  invitation: InvitationDocument,
  owner: {
    normalizedEmail?: string;
    normalizedPhone?: string;
  },
) {
  if (invitation.normalizedEmail) return invitation.normalizedEmail === owner.normalizedEmail;
  if (invitation.normalizedPhone) return invitation.normalizedPhone === owner.normalizedPhone;
  return false;
}

function normalizeLeadIdentifiers(email: string, phone: string) {
  return { normalizedEmail: normalizeEmail(email), normalizedPhone: normalizePhoneToE164(phone) };
}

function auditActor(ctx: RequestContext) {
  return {
    ...(ctx.userId && ObjectId.isValid(ctx.userId) ? { userId: new ObjectId(ctx.userId) } : {}),
    ...(ctx.platformMembershipId && ObjectId.isValid(ctx.platformMembershipId)
      ? { platformMembershipId: new ObjectId(ctx.platformMembershipId) }
      : {}),
  };
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

function objectId(value: string, code: string): ObjectId {
  if (!ObjectId.isValid(value)) throw notFound(code);
  return new ObjectId(value);
}

function required(value: string | undefined): string {
  if (!value) throw invalidInvitation();
  return value;
}

function notFound(code: string): AppError {
  return new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
}

function conflict(code: string): AppError {
  return new AppError({ code, httpStatus: 409, message: 'The lead command could not be applied.' });
}

function invalidInvitation(): AppError {
  return new AppError({
    code: 'INVITATION_INVALID',
    httpStatus: 401,
    message: 'The invitation is invalid or expired.',
  });
}
