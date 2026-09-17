import { isIP } from 'node:net';
import { ObjectId } from 'mongodb';
import type { AccessControlService } from '../../core/access-control/access-control.service';
import type { AuditWriter } from '../../core/audit/audit.writer';
import type { TransactionContext, UnitOfWork } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type { OutboxWriter } from '../../core/events/outbox.writer';
import type { JobLeaseManager } from '../../core/jobs/job-lease.manager';
import type { RequestContext } from '../../core/request-context/request-context';
import type { AuthSessionRepository } from '../auth/auth.repositories';
import { Permissions } from '../permissions/permission.registry';
import type { PlatformMembershipRepository } from '../platform/platform.repository';
import type {
  WorkspaceMembershipRepository,
  WorkspaceRepository,
} from '../workspaces/workspace.repository';
import type { SupportAccessRepository } from './support-access.repository';
import type {
  PortalAccessPolicyDocument,
  ResolvedSupportContext,
  SupportAccessRequestDocument,
  SupportContextType,
  SupportSessionDocument,
  SupportSessionType,
  SupportTargetType,
} from './support-access.types';

interface PolicyInput {
  platformMembershipId: string;
  allowedTargetTypes: SupportTargetType[];
  allowedWorkspaceIds?: string[];
  allowedIpRanges?: string[];
  allowedSessionTypes: SupportSessionType[];
  maxSessionDurationMinutes: number;
  notificationRequired: boolean;
  allowSensitiveData: boolean;
  allowSensitiveFileDownload: boolean;
  validFrom?: string;
  validUntil?: string;
  enabled?: boolean;
}

interface StartInput {
  targetType: SupportTargetType;
  targetWorkspaceId?: string;
  targetUserId?: string;
  effectiveMembershipId?: string;
  contextType: SupportContextType;
  sessionType: SupportSessionType;
  requestedDurationMinutes: number;
  requestedSensitiveAccess?: boolean;
  requestedSensitiveFileDownload?: boolean;
  reason: string;
  reference?: string;
}

interface ExpectedVersionInput {
  expectedVersion: number;
}

const defaultDurationMinutes = 30;
const systemMaximumDurationMinutes = 60;

export class SupportAccessApplicationService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly support: SupportAccessRepository,
    private readonly platformMemberships: PlatformMembershipRepository,
    private readonly authSessions: AuthSessionRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly workspaceMemberships: WorkspaceMembershipRepository,
    private readonly accessControl: AccessControlService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listPolicies(ctx: RequestContext) {
    await this.authorizePlatform(ctx, Permissions.SupportPoliciesRead);
    return { data: (await this.support.listPolicies()).map(safePolicy) };
  }

  async getPolicy(ctx: RequestContext, policyId: string) {
    await this.authorizePlatform(ctx, Permissions.SupportPoliciesRead);
    const policy = await this.support.findPolicyById(
      objectId(policyId, 'SUPPORT_POLICY_NOT_FOUND'),
    );
    if (!policy) throw notFound('SUPPORT_POLICY_NOT_FOUND');
    return { data: safePolicy(policy) };
  }

  async createPolicy(ctx: RequestContext, input: PolicyInput) {
    await this.authorizePlatform(ctx, Permissions.SupportPoliciesCreate);
    await this.authorizePolicyAllowances(ctx, input);
    const actorPlatformMembershipId = platformMembershipId(ctx);
    const targetPlatformMembershipId = objectId(
      input.platformMembershipId,
      'PLATFORM_MEMBERSHIP_NOT_FOUND',
    );
    if (actorPlatformMembershipId.equals(targetPlatformMembershipId)) {
      throw forbidden('SUPPORT_POLICY_SELF_GRANT_DENIED');
    }
    const target = await this.platformMemberships.findById(targetPlatformMembershipId);
    if (target?.status !== 'ACTIVE') throw notFound('PLATFORM_MEMBERSHIP_NOT_FOUND');

    const now = this.now();
    const policy: PortalAccessPolicyDocument = {
      _id: new ObjectId(),
      platformMembershipId: targetPlatformMembershipId,
      allowedTargetTypes: distinct(input.allowedTargetTypes),
      ...(input.allowedWorkspaceIds
        ? {
            allowedWorkspaceIds: input.allowedWorkspaceIds.map((id) =>
              objectId(id, 'WORKSPACE_NOT_FOUND'),
            ),
          }
        : {}),
      ...(input.allowedIpRanges ? { allowedIpRanges: distinct(input.allowedIpRanges) } : {}),
      allowedSessionTypes: distinct(input.allowedSessionTypes),
      maxSessionDurationMinutes: duration(input.maxSessionDurationMinutes),
      notificationRequired: input.notificationRequired,
      allowSensitiveData: input.allowSensitiveData,
      allowSensitiveFileDownload: input.allowSensitiveFileDownload,
      ...(input.validFrom
        ? { validFrom: date(input.validFrom, 'SUPPORT_POLICY_VALID_FROM_INVALID') }
        : {}),
      ...(input.validUntil
        ? { validUntil: date(input.validUntil, 'SUPPORT_POLICY_VALID_UNTIL_INVALID') }
        : {}),
      enabled: input.enabled ?? true,
      revision: 0,
      createdBy: actorPlatformMembershipId,
      createdAt: now,
    };
    validatePolicy(policy, now);
    return await this.unitOfWork.withTransaction(async (tx) => {
      const created = await this.support.createPolicy(policy, tx);
      await this.writeAudit(
        ctx,
        'PortalAccessPolicyCreated',
        'portal_access_policy',
        created._id,
        'create',
        tx,
        {
          after: safePolicySnapshot(created),
        },
      );
      await this.outbox.write(
        {
          eventType: 'PortalAccessPolicyCreated',
          aggregateType: 'portal_access_policy',
          aggregateId: created._id,
          payload: { policyId: created._id.toHexString() },
          correlationId: ctx.correlationId,
        },
        tx,
      );
      return { data: safePolicy(created) };
    });
  }

  async updatePolicy(
    ctx: RequestContext,
    policyId: string,
    input: PolicyInput & ExpectedVersionInput,
  ) {
    await this.authorizePlatform(ctx, Permissions.SupportPoliciesUpdate);
    await this.authorizePolicyAllowances(ctx, input);
    const id = objectId(policyId, 'SUPPORT_POLICY_NOT_FOUND');
    const actorPlatformMembershipId = platformMembershipId(ctx);
    if (
      actorPlatformMembershipId.equals(
        objectId(input.platformMembershipId, 'PLATFORM_MEMBERSHIP_NOT_FOUND'),
      )
    ) {
      throw forbidden('SUPPORT_POLICY_SELF_GRANT_DENIED');
    }
    const now = this.now();
    const patch: Partial<PortalAccessPolicyDocument> = {
      platformMembershipId: objectId(input.platformMembershipId, 'PLATFORM_MEMBERSHIP_NOT_FOUND'),
      allowedTargetTypes: distinct(input.allowedTargetTypes),
      allowedSessionTypes: distinct(input.allowedSessionTypes),
      maxSessionDurationMinutes: duration(input.maxSessionDurationMinutes),
      notificationRequired: input.notificationRequired,
      allowSensitiveData: input.allowSensitiveData,
      allowSensitiveFileDownload: input.allowSensitiveFileDownload,
      enabled: input.enabled ?? true,
      updatedBy: actorPlatformMembershipId,
      updatedAt: now,
    };
    if (input.allowedWorkspaceIds) {
      patch.allowedWorkspaceIds = input.allowedWorkspaceIds.map((item) =>
        objectId(item, 'WORKSPACE_NOT_FOUND'),
      );
    }
    if (input.allowedIpRanges) patch.allowedIpRanges = distinct(input.allowedIpRanges);
    if (input.validFrom)
      patch.validFrom = date(input.validFrom, 'SUPPORT_POLICY_VALID_FROM_INVALID');
    if (input.validUntil)
      patch.validUntil = date(input.validUntil, 'SUPPORT_POLICY_VALID_UNTIL_INVALID');
    validatePolicy(
      {
        allowedTargetTypes: patch.allowedTargetTypes,
        allowedSessionTypes: patch.allowedSessionTypes,
        maxSessionDurationMinutes: patch.maxSessionDurationMinutes,
        allowedIpRanges: patch.allowedIpRanges,
        validFrom: patch.validFrom,
        validUntil: patch.validUntil,
      } as PortalAccessPolicyDocument,
      now,
    );
    return await this.unitOfWork.withTransaction(async (tx) => {
      const updated = await this.support.updatePolicy(id, input.expectedVersion, patch, tx);
      await this.revokeInvalidatedSessions(ctx, updated, now, tx, 'POLICY_CHANGED');
      await this.writeAudit(
        ctx,
        'PortalAccessPolicyChanged',
        'portal_access_policy',
        updated._id,
        'update',
        tx,
        {
          after: safePolicySnapshot(updated),
        },
      );
      await this.outbox.write(
        {
          eventType: 'PortalAccessPolicyChanged',
          aggregateType: 'portal_access_policy',
          aggregateId: updated._id,
          payload: { policyId: updated._id.toHexString() },
          correlationId: ctx.correlationId,
        },
        tx,
      );
      return { data: safePolicy(updated) };
    });
  }

  async disablePolicy(ctx: RequestContext, policyId: string, input: ExpectedVersionInput) {
    await this.authorizePlatform(ctx, Permissions.SupportPoliciesDisable);
    return await this.disableOrArchivePolicy(ctx, policyId, input.expectedVersion, 'disable');
  }

  async archivePolicy(ctx: RequestContext, policyId: string, input: ExpectedVersionInput) {
    await this.authorizePlatform(ctx, Permissions.SupportPoliciesArchive);
    return await this.disableOrArchivePolicy(ctx, policyId, input.expectedVersion, 'archive');
  }

  async startSession(ctx: RequestContext, input: StartInput, tx: TransactionContext) {
    await this.authorizePlatform(ctx, Permissions.SupportSessionsStart);
    const now = this.now();
    const realActorUserId = userId(ctx);
    const actorPlatformMembershipId = platformMembershipId(ctx);
    const parentAuthSessionId = authSessionId(ctx);
    validateParentContext(ctx);
    const normalized = normalizeStartInput(input);
    const decision = await this.evaluateStart(ctx, actorPlatformMembershipId, normalized, now);
    const requestId = new ObjectId();
    const request: SupportAccessRequestDocument = {
      _id: requestId,
      requestedByPlatformMembershipId: actorPlatformMembershipId,
      realActorUserId,
      targetType: normalized.targetType,
      ...(normalized.targetWorkspaceId ? { targetWorkspaceId: normalized.targetWorkspaceId } : {}),
      ...(normalized.targetUserId ? { targetUserId: normalized.targetUserId } : {}),
      ...(normalized.effectiveMembershipId
        ? { effectiveMembershipId: normalized.effectiveMembershipId }
        : {}),
      contextType: normalized.contextType,
      requestedSessionType: normalized.sessionType,
      requestedDurationMinutes: normalized.requestedDurationMinutes,
      requestedSensitiveAccess: normalized.requestedSensitiveAccess,
      requestedSensitiveFileDownload: normalized.requestedSensitiveFileDownload,
      reason: normalized.reason,
      ...(normalized.reference ? { reference: normalized.reference } : {}),
      sourceIp: ctx.ipAddress,
      ...(decision.policy
        ? {
            matchedPolicyId: decision.policy._id,
            policyRevision: decision.policy.revision,
            policySnapshot: safePolicySnapshot(decision.policy),
          }
        : {}),
      decision: decision.approved ? 'APPROVED' : 'DENIED',
      ...(decision.denialReason ? { denialReason: decision.denialReason } : {}),
      notificationRequired: decision.policy?.notificationRequired ?? false,
      createdAt: now,
    };
    await this.support.insertRequest(request, tx);
    if (!decision.approved || !decision.policy) {
      await this.writeAudit(
        ctx,
        'SupportAccessRequestDenied',
        'support_access_request',
        request._id,
        'deny',
        tx,
        {
          after: {
            denialReason: request.denialReason,
            targetWorkspaceId: request.targetWorkspaceId?.toHexString(),
          },
          reason: normalized.reason,
        },
      );
      return {
        statusCode: 403,
        body: {
          error: {
            code: request.denialReason ?? 'SUPPORT_ACCESS_DENIED',
            message: 'Support access denied.',
          },
          accessRequestId: request._id.toHexString(),
        },
        resourceId: request._id.toHexString(),
      };
    }
    const session: SupportSessionDocument = {
      _id: new ObjectId(),
      requestId: request._id,
      policyId: decision.policy._id,
      policyRevision: decision.policy.revision,
      realActorUserId,
      realActorPlatformMembershipId: actorPlatformMembershipId,
      parentAuthSessionId,
      targetType: normalized.targetType,
      ...(normalized.targetWorkspaceId ? { targetWorkspaceId: normalized.targetWorkspaceId } : {}),
      ...(normalized.targetUserId ? { targetUserId: normalized.targetUserId } : {}),
      ...(normalized.effectiveMembershipId
        ? { effectiveMembershipId: normalized.effectiveMembershipId }
        : {}),
      contextType: normalized.contextType,
      sessionType: normalized.sessionType,
      sourceIp: ctx.ipAddress,
      reason: normalized.reason,
      ...(normalized.reference ? { reference: normalized.reference } : {}),
      notificationRequired: decision.policy.notificationRequired,
      allowSensitiveData: normalized.requestedSensitiveAccess,
      allowSensitiveFileDownload: normalized.requestedSensitiveFileDownload,
      startedAt: now,
      expiresAt: new Date(now.getTime() + normalized.requestedDurationMinutes * 60 * 1000),
      status: 'ACTIVE',
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.support.insertSession(session, tx);
    await this.writeAudit(
      ctx,
      'SupportSessionStarted',
      'support_session',
      session._id,
      'start',
      tx,
      {
        supportSessionId: session._id,
        effectiveContext: effectiveContext(session),
        after: safeSessionSnapshot(session),
        reason: normalized.reason,
      },
    );
    await this.writeSessionEvent(ctx, 'SupportSessionStarted', session, tx);
    return {
      statusCode: 201,
      body: { data: { decision: 'APPROVED' as const, supportSession: safeSession(session) } },
      resourceId: session._id.toHexString(),
    };
  }

  async listSessions(ctx: RequestContext) {
    await this.authorizePlatform(ctx, Permissions.SupportSessionsRead);
    return { data: (await this.support.listSessions()).map(safeSession) };
  }

  async getSession(ctx: RequestContext, sessionId: string) {
    await this.authorizePlatform(ctx, Permissions.SupportSessionsRead);
    const session = await this.support.findSessionById(
      objectId(sessionId, 'SUPPORT_SESSION_NOT_FOUND'),
    );
    if (!session) throw notFound('SUPPORT_SESSION_NOT_FOUND');
    return { data: safeSession(session) };
  }

  async endOwnSession(ctx: RequestContext, sessionId: string, input: ExpectedVersionInput) {
    await this.authorizePlatform(ctx, Permissions.SupportSessionsEndOwn);
    const id = objectId(sessionId, 'SUPPORT_SESSION_NOT_FOUND');
    const existing = await this.support.findSessionById(id);
    if (!existing) throw notFound('SUPPORT_SESSION_NOT_FOUND');
    if (!existing.realActorPlatformMembershipId.equals(platformMembershipId(ctx))) {
      throw forbidden('SUPPORT_SESSION_OWNERSHIP_REQUIRED');
    }
    return await this.transitionSession(ctx, existing, input.expectedVersion, 'ENDED', 'end');
  }

  async revokeSession(ctx: RequestContext, sessionId: string, input: ExpectedVersionInput) {
    await this.authorizePlatform(ctx, Permissions.SupportSessionsRevoke);
    const existing = await this.support.findSessionById(
      objectId(sessionId, 'SUPPORT_SESSION_NOT_FOUND'),
    );
    if (!existing) throw notFound('SUPPORT_SESSION_NOT_FOUND');
    return await this.transitionSession(ctx, existing, input.expectedVersion, 'REVOKED', 'revoke');
  }

  async resolveForRequest(
    ctx: RequestContext,
    sessionId: string,
    request: { method: string; url: string; params?: unknown },
  ): Promise<ResolvedSupportContext> {
    const session = await this.support.findSessionById(
      objectId(sessionId, 'SUPPORT_SESSION_NOT_FOUND'),
    );
    if (!session) throw forbidden('SUPPORT_SESSION_INVALID');
    const policy = await this.support.findPolicyById(session.policyId);
    if (!policy) throw forbidden('SUPPORT_POLICY_NOT_FOUND');
    await this.assertRuntimeSecurity(ctx, session, policy, request);
    ctx.supportSessionId = session._id.toHexString();
    ctx.platformMembershipId = session.realActorPlatformMembershipId.toHexString();
    if (session.targetWorkspaceId) ctx.workspaceId = session.targetWorkspaceId.toHexString();
    if (session.targetUserId) ctx.effectiveUserId = session.targetUserId.toHexString();
    if (session.effectiveMembershipId)
      ctx.effectiveMembershipId = session.effectiveMembershipId.toHexString();
    return { session, policy };
  }

  async requireSensitive(ctx: RequestContext, kind: 'DATA' | 'FILE'): Promise<void> {
    if (!ctx.supportSessionId) return;
    await this.authorizePlatform(ctx, Permissions.SupportSensitiveRead);
    const session = await this.support.findSessionById(
      objectId(ctx.supportSessionId, 'SUPPORT_SESSION_INVALID'),
    );
    if (!session?.allowSensitiveData) throw forbidden('SUPPORT_SENSITIVE_DENIED');
    if (kind === 'FILE') {
      await this.authorizePlatform(ctx, Permissions.SupportSensitiveFilesRead);
      if (!session.allowSensitiveFileDownload) throw forbidden('SUPPORT_SENSITIVE_FILE_DENIED');
    }
  }

  async expireDue(jobLeases: JobLeaseManager, limit = 50): Promise<number> {
    const acquired = await jobLeases.tryAcquire(
      'support.expire-sessions',
      'support-expiry',
      30_000,
    );
    if (!acquired) return 0;
    let count = 0;
    try {
      const now = this.now();
      for (const session of await this.support.listExpiredActive(now, limit)) {
        await this.unitOfWork.withTransaction(async (tx) => {
          const expired = await this.support.expireActive(session._id, now, tx);
          if (!expired) return;
          await this.audit.write(
            auditEventFromSession(expired, 'SupportSessionExpired', 'expire', ctxForSystem()),
            tx,
          );
          await this.writeSessionEvent(ctxForSystem(), 'SupportSessionExpired', expired, tx);
          count += 1;
        });
      }
    } finally {
      await jobLeases.release('support.expire-sessions', 'support-expiry');
    }
    return count;
  }

  private async authorizePlatform(ctx: RequestContext, permission: string): Promise<void> {
    await this.accessControl.authorize(ctx, {
      context: 'PLATFORM',
      permission,
      scope: { type: 'WORKSPACE' },
    });
  }

  private async authorizePolicyAllowances(ctx: RequestContext, input: PolicyInput): Promise<void> {
    if (input.allowSensitiveData) {
      await this.authorizePlatform(ctx, Permissions.SupportSensitiveRead);
    }
    if (input.allowSensitiveFileDownload) {
      await this.authorizePlatform(ctx, Permissions.SupportSensitiveFilesRead);
    }
  }

  private async evaluateStart(
    ctx: RequestContext,
    platformMembershipId: ObjectId,
    input: NormalizedStartInput,
    now: Date,
  ): Promise<{ approved: boolean; policy?: PortalAccessPolicyDocument; denialReason?: string }> {
    if (input.targetWorkspaceId && !(await this.workspaces.findById(input.targetWorkspaceId))) {
      return { approved: false, denialReason: 'TARGET_WORKSPACE_NOT_FOUND' };
    }
    if (input.contextType === 'USER_CONTEXT') {
      if (!input.targetUserId || !input.effectiveMembershipId || !input.targetWorkspaceId) {
        return { approved: false, denialReason: 'TARGET_USER_CONTEXT_INVALID' };
      }
      const membership = await this.workspaceMemberships.findByIdInWorkspace(
        input.targetWorkspaceId,
        input.effectiveMembershipId,
      );
      if (!membership?.userId.equals(input.targetUserId) || membership.status !== 'ACTIVE') {
        return { approved: false, denialReason: 'TARGET_USER_CONTEXT_INVALID' };
      }
    }
    for (const policy of await this.support.findCandidatePolicies(platformMembershipId)) {
      const denial = policyDenial(policy, input, ctx.ipAddress, now);
      if (!denial) return { approved: true, policy };
    }
    return { approved: false, denialReason: 'POLICY_NOT_FOUND' };
  }

  private async assertRuntimeSecurity(
    ctx: RequestContext,
    session: SupportSessionDocument,
    policy: PortalAccessPolicyDocument,
    request: { method: string; url: string; params?: unknown },
  ): Promise<void> {
    validateParentContext(ctx);
    if (!session.realActorUserId.equals(userId(ctx)))
      throw forbidden('SUPPORT_SESSION_ACTOR_MISMATCH');
    if (!session.parentAuthSessionId.equals(authSessionId(ctx))) {
      await this.securityTerminate(ctx, session, 'PARENT_AUTH_MISMATCH');
      throw forbidden('SUPPORT_SESSION_PARENT_MISMATCH');
    }
    const parent = await this.authSessions.findActive(session.parentAuthSessionId);
    if (!parent || parent.restrictedUntilVerified || !parent.mfaSatisfiedAt) {
      await this.securityTerminate(ctx, session, 'PARENT_AUTH_INVALID');
      throw forbidden('SUPPORT_SESSION_PARENT_INVALID');
    }
    await this.authorizePlatform(ctx, Permissions.SupportSessionsStart);
    const now = this.now();
    if (session.status !== 'ACTIVE') throw forbidden('SUPPORT_SESSION_NOT_ACTIVE');
    if (session.expiresAt <= now) throw forbidden('SUPPORT_SESSION_EXPIRED');
    const denial = policyDenial(policy, inputFromSession(session), ctx.ipAddress, now);
    if (denial) {
      await this.securityTerminate(ctx, session, denial);
      throw forbidden(denial);
    }
    if (session.sourceIp !== ctx.ipAddress) {
      await this.securityTerminate(ctx, session, 'IP_CHANGED');
      throw forbidden('SUPPORT_SESSION_IP_MISMATCH');
    }
    if (session.contextType === 'USER_CONTEXT') {
      if (!session.targetWorkspaceId || !session.targetUserId || !session.effectiveMembershipId) {
        await this.securityTerminate(ctx, session, 'TARGET_USER_CONTEXT_INVALID');
        throw forbidden('TARGET_USER_CONTEXT_INVALID');
      }
      const membership = await this.workspaceMemberships.findByIdInWorkspace(
        session.targetWorkspaceId,
        session.effectiveMembershipId,
      );
      if (!membership?.userId.equals(session.targetUserId) || membership.status !== 'ACTIVE') {
        await this.securityTerminate(ctx, session, 'TARGET_USER_CONTEXT_INVALID');
        throw forbidden('TARGET_USER_CONTEXT_INVALID');
      }
    }
    const params = (request.params ?? {}) as { workspaceId?: string };
    if (
      params.workspaceId &&
      session.targetWorkspaceId &&
      params.workspaceId !== session.targetWorkspaceId.toHexString()
    ) {
      throw forbidden('SUPPORT_SESSION_WORKSPACE_MISMATCH');
    }
    if (!supportReadOnlyOperation(request)) {
      throw forbidden(
        session.sessionType === 'READ_ONLY' ? 'SUPPORT_READ_ONLY' : 'SUPPORT_WRITE_NOT_WHITELISTED',
      );
    }
    if (supportSensitiveDataOperation(request) && !session.allowSensitiveData) {
      throw forbidden('SUPPORT_SENSITIVE_DENIED');
    }
    void request.url;
  }

  private async securityTerminate(
    ctx: RequestContext,
    session: SupportSessionDocument,
    reason: string,
  ) {
    if (session.status !== 'ACTIVE') return;
    const now = this.now();
    try {
      await this.unitOfWork.withTransaction(async (tx) => {
        const terminated = await this.support.transitionSession(
          session._id,
          session.version,
          ['ACTIVE'],
          'SECURITY_TERMINATED',
          { endedAt: now, terminationReason: reason, now },
          tx,
        );
        await this.audit.write(
          auditEventFromSession(terminated, 'SupportSessionSecurityTerminated', 'terminate', ctx),
          tx,
        );
        await this.writeSessionEvent(ctx, 'SupportSessionRevoked', terminated, tx);
      });
    } catch {
      // The request still fails closed; a concurrent terminal transition is acceptable.
    }
  }

  private async transitionSession(
    ctx: RequestContext,
    existing: SupportSessionDocument,
    expectedVersion: number,
    status: 'ENDED' | 'REVOKED',
    action: 'end' | 'revoke',
  ) {
    const now = this.now();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const transitioned = await this.support.transitionSession(
        existing._id,
        expectedVersion,
        ['ACTIVE'],
        status,
        {
          ...(status === 'ENDED' ? { endedAt: now } : { revokedAt: now }),
          terminationReason: status,
          now,
        },
        tx,
      );
      await this.audit.write(
        auditEventFromSession(
          transitioned,
          status === 'ENDED' ? 'SupportSessionEnded' : 'SupportSessionRevoked',
          action,
          ctx,
        ),
        tx,
      );
      await this.writeSessionEvent(
        ctx,
        status === 'ENDED' ? 'SupportSessionEnded' : 'SupportSessionRevoked',
        transitioned,
        tx,
      );
      return { data: safeSession(transitioned) };
    });
  }

  private async disableOrArchivePolicy(
    ctx: RequestContext,
    policyId: string,
    expectedVersion: number,
    action: 'disable' | 'archive',
  ) {
    const id = objectId(policyId, 'SUPPORT_POLICY_NOT_FOUND');
    const now = this.now();
    return await this.unitOfWork.withTransaction(async (tx) => {
      const policy =
        action === 'disable'
          ? await this.support.disablePolicy(
              id,
              expectedVersion,
              { updatedBy: platformMembershipId(ctx), updatedAt: now },
              tx,
            )
          : await this.support.archivePolicy(
              id,
              expectedVersion,
              { updatedBy: platformMembershipId(ctx), updatedAt: now, archivedAt: now },
              tx,
            );
      await this.revokeInvalidatedSessions(
        ctx,
        policy,
        now,
        tx,
        action === 'disable' ? 'POLICY_DISABLED' : 'POLICY_ARCHIVED',
      );
      await this.writeAudit(
        ctx,
        'PortalAccessPolicyChanged',
        'portal_access_policy',
        policy._id,
        action,
        tx,
        {
          after: safePolicySnapshot(policy),
        },
      );
      await this.outbox.write(
        {
          eventType: 'PortalAccessPolicyChanged',
          aggregateType: 'portal_access_policy',
          aggregateId: policy._id,
          payload: { policyId: policy._id.toHexString(), action },
          correlationId: ctx.correlationId,
        },
        tx,
      );
      return { data: safePolicy(policy) };
    });
  }

  private async revokeInvalidatedSessions(
    ctx: RequestContext,
    policy: PortalAccessPolicyDocument,
    now: Date,
    tx: TransactionContext,
    reason: string,
  ) {
    const revoked = await this.support.revokeActiveByPolicy(policy._id, now, reason, tx);
    for (const session of revoked) {
      await this.audit.write(
        auditEventFromSession(session, 'SupportSessionRevoked', 'revoke', ctx),
        tx,
      );
      await this.writeSessionEvent(ctx, 'SupportSessionRevoked', session, tx);
    }
  }

  private async writeAudit(
    ctx: RequestContext,
    eventType: string,
    entityType: string,
    entityId: ObjectId,
    action: string,
    tx: TransactionContext | undefined,
    details: {
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
      reason?: string;
      supportSessionId?: ObjectId;
      effectiveContext?: Record<string, unknown>;
    } = {},
  ) {
    await this.audit.write(
      {
        eventType,
        actor: {
          userId: userId(ctx),
          platformMembershipId: platformMembershipId(ctx),
        },
        entity: { type: entityType, id: entityId },
        action,
        ...details,
        ipAddress: ctx.ipAddress,
        ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }

  private async writeSessionEvent(
    ctx: RequestContext,
    eventType: string,
    session: SupportSessionDocument,
    tx: TransactionContext | undefined,
  ) {
    await this.outbox.write(
      {
        eventType,
        aggregateType: 'support_session',
        aggregateId: session._id,
        ...(session.targetWorkspaceId ? { workspaceId: session.targetWorkspaceId } : {}),
        payload: {
          supportSessionId: session._id.toHexString(),
          targetWorkspaceId: session.targetWorkspaceId?.toHexString(),
          notificationRequired: session.notificationRequired,
        },
        correlationId: ctx.correlationId,
      },
      tx,
    );
  }
}

interface NormalizedStartInput {
  targetType: SupportTargetType;
  targetWorkspaceId?: ObjectId;
  targetUserId?: ObjectId;
  effectiveMembershipId?: ObjectId;
  contextType: SupportContextType;
  sessionType: SupportSessionType;
  requestedDurationMinutes: number;
  requestedSensitiveAccess: boolean;
  requestedSensitiveFileDownload: boolean;
  reason: string;
  reference?: string;
}

function normalizeStartInput(input: StartInput): NormalizedStartInput {
  const reason = input.reason.trim();
  if (reason.length < 3) throw invalid('SUPPORT_REASON_REQUIRED');
  return {
    targetType: input.targetType,
    ...(input.targetWorkspaceId
      ? { targetWorkspaceId: objectId(input.targetWorkspaceId, 'WORKSPACE_NOT_FOUND') }
      : {}),
    ...(input.targetUserId
      ? { targetUserId: objectId(input.targetUserId, 'TARGET_USER_NOT_FOUND') }
      : {}),
    ...(input.effectiveMembershipId
      ? {
          effectiveMembershipId: objectId(
            input.effectiveMembershipId,
            'WORKSPACE_MEMBERSHIP_NOT_FOUND',
          ),
        }
      : {}),
    contextType: input.contextType,
    sessionType: input.sessionType,
    requestedDurationMinutes: input.requestedDurationMinutes || defaultDurationMinutes,
    requestedSensitiveAccess: Boolean(input.requestedSensitiveAccess),
    requestedSensitiveFileDownload: Boolean(input.requestedSensitiveFileDownload),
    reason,
    ...(input.reference?.trim() ? { reference: input.reference.trim() } : {}),
  };
}

function policyDenial(
  policy: PortalAccessPolicyDocument,
  input: NormalizedStartInput,
  ipAddress: string,
  now: Date,
): string | null {
  if (!policy.enabled || policy.archivedAt) return 'POLICY_DISABLED';
  if (policy.validFrom && policy.validFrom > now) return 'POLICY_NOT_YET_VALID';
  if (policy.validUntil && policy.validUntil <= now) return 'POLICY_EXPIRED';
  if (!policy.allowedTargetTypes.includes(input.targetType)) return 'TARGET_NOT_ALLOWED';
  if (!policy.allowedSessionTypes.includes(input.sessionType)) return 'SESSION_TYPE_NOT_ALLOWED';
  if (input.requestedDurationMinutes > policy.maxSessionDurationMinutes)
    return 'DURATION_NOT_ALLOWED';
  if (input.requestedDurationMinutes > systemMaximumDurationMinutes) return 'DURATION_NOT_ALLOWED';
  if (input.requestedSensitiveAccess && !policy.allowSensitiveData)
    return 'SENSITIVE_ACCESS_NOT_ALLOWED';
  if (input.requestedSensitiveFileDownload && !policy.allowSensitiveFileDownload) {
    return 'SENSITIVE_FILE_ACCESS_NOT_ALLOWED';
  }
  if (
    policy.allowedWorkspaceIds?.length &&
    (!input.targetWorkspaceId ||
      !policy.allowedWorkspaceIds.some((workspaceId) =>
        workspaceId.equals(input.targetWorkspaceId),
      ))
  ) {
    return 'WORKSPACE_NOT_ALLOWED';
  }
  if (
    policy.allowedIpRanges?.length &&
    !policy.allowedIpRanges.some((range) => ipMatches(ipAddress, range))
  ) {
    return 'IP_NOT_ALLOWED';
  }
  return null;
}

function inputFromSession(session: SupportSessionDocument): NormalizedStartInput {
  return {
    targetType: session.targetType ?? (session.targetUserId ? 'STAFF' : 'GYM'),
    ...(session.targetWorkspaceId ? { targetWorkspaceId: session.targetWorkspaceId } : {}),
    ...(session.targetUserId ? { targetUserId: session.targetUserId } : {}),
    ...(session.effectiveMembershipId
      ? { effectiveMembershipId: session.effectiveMembershipId }
      : {}),
    contextType: session.contextType,
    sessionType: session.sessionType,
    requestedDurationMinutes: Math.ceil(
      (session.expiresAt.getTime() - session.startedAt.getTime()) / 60_000,
    ),
    requestedSensitiveAccess: session.allowSensitiveData,
    requestedSensitiveFileDownload: session.allowSensitiveFileDownload,
    reason: session.reason,
    ...(session.reference ? { reference: session.reference } : {}),
  };
}

function validatePolicy(policy: PortalAccessPolicyDocument, now: Date) {
  if (policy.allowedTargetTypes.length === 0) throw invalid('SUPPORT_POLICY_TARGETS_REQUIRED');
  if (policy.allowedSessionTypes.length === 0)
    throw invalid('SUPPORT_POLICY_SESSION_TYPES_REQUIRED');
  if (policy.validFrom && policy.validUntil && policy.validFrom >= policy.validUntil) {
    throw invalid('SUPPORT_POLICY_VALIDITY_INVALID');
  }
  if (policy.maxSessionDurationMinutes > systemMaximumDurationMinutes) {
    throw invalid('SUPPORT_POLICY_DURATION_INVALID');
  }
  for (const range of policy.allowedIpRanges ?? []) {
    if (!validIpRange(range)) throw invalid('SUPPORT_POLICY_IP_RANGE_INVALID');
  }
  void now;
}

function duration(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > systemMaximumDurationMinutes) {
    throw invalid('SUPPORT_POLICY_DURATION_INVALID');
  }
  return value;
}

function validIpRange(range: string): boolean {
  const [ip, prefix] = range.split('/');
  const family = ip ? isIP(ip) : 0;
  if (!family) return false;
  if (prefix === undefined) return true;
  if (family === 6) return false;
  const bits = Number(prefix);
  return Number.isInteger(bits) && bits >= 0 && bits <= 32;
}

function supportReadOnlyOperation(request: { method: string; url: string }): boolean {
  if (['GET', 'HEAD'].includes(request.method)) return true;
  if (request.method !== 'POST') return false;
  return /^\/api\/v1\/workspaces\/[0-9a-f]{24}\/files\/[0-9a-f]{24}\/download-url(?:\?.*)?$/i.test(
    request.url,
  );
}

function supportSensitiveDataOperation(request: { method: string; url: string }): boolean {
  if (request.method !== 'GET') return false;
  return /^\/api\/v1\/workspaces\/[0-9a-f]{24}\/relationships\/[0-9a-f]{24}\/(?:progress-photos|health-profile|checkins(?:\/[0-9a-f]{24})?)(?:\?.*)?$/i.test(
    request.url,
  );
}

function ipMatches(ip: string, range: string): boolean {
  const [base, prefix] = range.split('/');
  if (!base || !isIP(ip) || !isIP(base)) return false;
  if (prefix === undefined) return ip === base;
  if (isIP(ip) !== 4 || isIP(base) !== 4) return false;
  const bits = Number(prefix);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function ipv4ToInt(value: string): number {
  return value.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function auditEventFromSession(
  session: SupportSessionDocument,
  eventType: string,
  action: string,
  ctx: RequestContext,
) {
  return {
    eventType,
    ...(session.targetWorkspaceId ? { workspaceId: session.targetWorkspaceId } : {}),
    actor: {
      ...(ctx.userId ? { userId: new ObjectId(ctx.userId) } : { userId: session.realActorUserId }),
      ...(ctx.platformMembershipId
        ? { platformMembershipId: new ObjectId(ctx.platformMembershipId) }
        : { platformMembershipId: session.realActorPlatformMembershipId }),
    },
    effectiveContext: effectiveContext(session),
    supportSessionId: session._id,
    entity: { type: 'support_session', id: session._id },
    action,
    after: safeSessionSnapshot(session),
    reason: session.reason,
    ipAddress: ctx.ipAddress,
    ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
    correlationId: ctx.correlationId,
  };
}

function safePolicy(policy: PortalAccessPolicyDocument) {
  return {
    id: policy._id.toHexString(),
    platformMembershipId: policy.platformMembershipId.toHexString(),
    allowedTargetTypes: policy.allowedTargetTypes,
    allowedWorkspaceIds: policy.allowedWorkspaceIds?.map((id) => id.toHexString()) ?? [],
    allowedIpRanges: policy.allowedIpRanges ?? [],
    allowedSessionTypes: policy.allowedSessionTypes,
    maxSessionDurationMinutes: policy.maxSessionDurationMinutes,
    notificationRequired: policy.notificationRequired,
    allowSensitiveData: policy.allowSensitiveData,
    allowSensitiveFileDownload: policy.allowSensitiveFileDownload,
    validFrom: policy.validFrom?.toISOString(),
    validUntil: policy.validUntil?.toISOString(),
    enabled: policy.enabled,
    revision: policy.revision,
    archivedAt: policy.archivedAt?.toISOString(),
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt?.toISOString(),
  };
}

function safePolicySnapshot(policy: PortalAccessPolicyDocument): Record<string, unknown> {
  return safePolicy(policy);
}

function safeSession(session: SupportSessionDocument) {
  return {
    id: session._id.toHexString(),
    requestId: session.requestId.toHexString(),
    policyId: session.policyId.toHexString(),
    realActorPlatformMembershipId: session.realActorPlatformMembershipId.toHexString(),
    targetType: session.targetType,
    targetWorkspaceId: session.targetWorkspaceId?.toHexString(),
    targetUserId: session.targetUserId?.toHexString(),
    effectiveMembershipId: session.effectiveMembershipId?.toHexString(),
    contextType: session.contextType,
    sessionType: session.sessionType,
    startedAt: session.startedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    endedAt: session.endedAt?.toISOString(),
    revokedAt: session.revokedAt?.toISOString(),
    status: session.status,
    terminationReason: session.terminationReason,
    version: session.version,
  };
}

function safeSessionSnapshot(session: SupportSessionDocument): Record<string, unknown> {
  return {
    ...safeSession(session),
    notificationRequired: session.notificationRequired,
    reason: session.reason,
    reference: session.reference,
  };
}

function effectiveContext(session: SupportSessionDocument) {
  return {
    contextType: session.contextType,
    targetType: session.targetType,
    targetWorkspaceId: session.targetWorkspaceId?.toHexString(),
    targetUserId: session.targetUserId?.toHexString(),
    effectiveMembershipId: session.effectiveMembershipId?.toHexString(),
    sessionType: session.sessionType,
  };
}

function validateParentContext(ctx: RequestContext) {
  if (!ctx.userId || !ctx.authSessionId) throw authRequired();
  if (ctx.restrictedUntilVerified) throw forbidden('AUTH_SESSION_RESTRICTED');
  if (!ctx.mfaSatisfied) throw forbidden('TWO_FACTOR_REQUIRED');
}

function userId(ctx: RequestContext): ObjectId {
  if (!ctx.userId) throw authRequired();
  return new ObjectId(ctx.userId);
}

function authSessionId(ctx: RequestContext): ObjectId {
  if (!ctx.authSessionId) throw authRequired();
  return new ObjectId(ctx.authSessionId);
}

function platformMembershipId(ctx: RequestContext): ObjectId {
  if (!ctx.platformMembershipId) throw forbidden('PLATFORM_MEMBERSHIP_REQUIRED');
  return new ObjectId(ctx.platformMembershipId);
}

function objectId(value: string, code: string): ObjectId {
  if (!ObjectId.isValid(value)) throw invalid(code);
  return new ObjectId(value);
}

function date(value: string, code: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw invalid(code);
  return parsed;
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function ctxForSystem(): RequestContext {
  return {
    correlationId: 'support-expiry-job',
    ipAddress: 'system',
    locale: 'en',
    timezone: 'Africa/Cairo',
  };
}

function authRequired(): AppError {
  return new AppError({
    code: 'AUTH_REQUIRED',
    httpStatus: 401,
    message: 'Authentication is required.',
  });
}

function forbidden(code: string): AppError {
  return new AppError({ code, httpStatus: 403, message: 'Support access denied.' });
}

function notFound(code: string): AppError {
  return new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
}

function invalid(code: string): AppError {
  return new AppError({ code, httpStatus: 422, message: 'The support access request is invalid.' });
}
