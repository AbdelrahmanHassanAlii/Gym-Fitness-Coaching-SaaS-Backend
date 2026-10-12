import type { FastifyInstance } from 'fastify';
import type { AppContainer } from '../../bootstrap/app-container';
import { AppError } from '../../core/errors/app-error';
import { requireAuth } from '../auth/auth.middleware';
import { Permissions } from '../permissions/permission.registry';
import { authorizeSupportActor } from './support-web.authorization';
import {
  SupportContextErrors,
  SupportContextHeaders,
  SupportContextQuery,
  SupportContextResponse,
} from './support-web.schemas';

const currentContextPath = '/api/v1/me/support-context';
const managementPermissions = new Map([
  ['GET /api/v1/platform/support/policies', Permissions.SupportPoliciesRead],
  ['POST /api/v1/platform/support/policies', Permissions.SupportPoliciesCreate],
  ['GET /api/v1/platform/support/policies/:policyId', Permissions.SupportPoliciesRead],
  ['PATCH /api/v1/platform/support/policies/:policyId', Permissions.SupportPoliciesUpdate],
  ['POST /api/v1/platform/support/policies/:policyId/disable', Permissions.SupportPoliciesDisable],
  ['POST /api/v1/platform/support/policies/:policyId/archive', Permissions.SupportPoliciesArchive],
  ['POST /api/v1/platform/support/access-requests', Permissions.SupportSessionsStart],
  ['GET /api/v1/platform/support/sessions', Permissions.SupportSessionsRead],
  ['GET /api/v1/platform/support/sessions/:sessionId', Permissions.SupportSessionsRead],
  ['POST /api/v1/platform/support/sessions/:sessionId/end', Permissions.SupportSessionsEndOwn],
  ['POST /api/v1/platform/support/sessions/:sessionId/revoke', Permissions.SupportSessionsRevoke],
]);

function isSupportPath(url: string): boolean {
  const path = url.split('?')[0];
  return path === currentContextPath || path?.startsWith('/api/v1/platform/support/') === true;
}

/** Register before authentication/runtime hooks so errors also receive no-store. */
export async function registerSupportWebBoundary(app: FastifyInstance, container: AppContainer) {
  app.addHook('onSend', async (request, reply, payload) => {
    if (isSupportPath(request.routeOptions.url ?? '') || isSupportPath(request.url))
      reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  app.addHook('onRequest', async (request, reply) => {
    const routePath = request.routeOptions.url ?? '';
    if (!isSupportPath(routePath) && !isSupportPath(request.url)) return;
    reply.header('Cache-Control', 'private, no-store');
    if (routePath !== currentContextPath && request.headers['x-support-session-id'] !== undefined) {
      throw new AppError({
        code: 'SUPPORT_ACCESS_FORBIDDEN',
        httpStatus: 403,
        message: 'Support context cannot administer support access.',
      });
    }
  });
  app.addHook('preHandler', async (request) => {
    const route = request.routeOptions.url;
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const permission = managementPermissions.get(`${method} ${route}`);
    if (permission) {
      // Runs on every invocation, including completed idempotency replays.
      await authorizeSupportActor(container, request.ctx, permission);
    } else if (route === currentContextPath) {
      await authorizeSupportActor(container, request.ctx, Permissions.SupportSessionsStart, true);
    }
  });
  app.addHook('preSerialization', async (request, reply, payload) => {
    if (
      request.routeOptions.url === '/api/v1/platform/support/access-requests' &&
      (reply.statusCode === 201 ||
        (typeof payload === 'object' && payload !== null && 'accessRequestId' in payload))
    ) {
      // Reauthorize after stored-result retrieval as well as before dispatch.
      await authorizeSupportActor(container, request.ctx, Permissions.SupportSessionsStart);
    }
    return payload;
  });
}

export async function registerSupportWebContextRoute(
  app: FastifyInstance,
  container: AppContainer,
) {
  app.get(
    currentContextPath,
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['Support'],
        description:
          'Validates the header-selected support context for its real actor and parent auth session. Requires current support.sessions.start, ACTIVE account/membership, unrestricted MFA auth. No session-read, workspace-management or native membership permission is required. Start/replay acknowledgement is historical; validate here before entry. Private, no-store. Errors: 400 VALIDATION_FAILED; 401 AUTH_REQUIRED; 403 AUTH_SESSION_RESTRICTED, TWO_FACTOR_REQUIRED, PLATFORM_MEMBERSHIP_REQUIRED, PLATFORM_MEMBERSHIP_INACTIVE, PERMISSION_DENIED, SUPPORT_SESSION_INVALID, SUPPORT_POLICY_NOT_FOUND, SUPPORT_SESSION_ACTOR_MISMATCH, SUPPORT_SESSION_PARENT_MISMATCH, SUPPORT_SESSION_PARENT_INVALID, SUPPORT_SESSION_NOT_ACTIVE, SUPPORT_SESSION_EXPIRED, SUPPORT_SESSION_IP_MISMATCH, SUPPORT_SESSION_WORKSPACE_MISMATCH, POLICY_DISABLED, POLICY_NOT_YET_VALID, POLICY_EXPIRED, TARGET_NOT_ALLOWED, SESSION_TYPE_NOT_ALLOWED, DURATION_NOT_ALLOWED, SENSITIVE_ACCESS_NOT_ALLOWED, SENSITIVE_FILE_ACCESS_NOT_ALLOWED, WORKSPACE_NOT_ALLOWED, IP_NOT_ALLOWED, TARGET_USER_CONTEXT_INVALID, SUPPORT_WORKSPACE_DENIED; 500 INTERNAL_ERROR.',
        headers: SupportContextHeaders,
        querystring: SupportContextQuery,
        response: { 200: SupportContextResponse, ...SupportContextErrors },
      },
    },
    async (request) => {
      const header = request.headers['x-support-session-id'];
      if (typeof header !== 'string') {
        throw new AppError({
          code: 'SUPPORT_SESSION_INVALID',
          httpStatus: 403,
          message: 'Support session required.',
        });
      }
      // Reuse Stage 16 at the response boundary; never infer usability from an admin DTO.
      const { session } = await container.supportAccess.resolveForRequest(request.ctx, header, {
        method: request.method,
        url: request.url,
        params: request.params,
      });
      const workspace = session.targetWorkspaceId
        ? await container.workspaceRepo.findById(session.targetWorkspaceId)
        : null;
      if (!workspace) {
        throw new AppError({
          code: 'SUPPORT_WORKSPACE_DENIED',
          httpStatus: 403,
          message: 'Workspace-bound support is required.',
        });
      }
      return {
        data: {
          supportSession: {
            id: session._id.toHexString(),
            status: 'ACTIVE' as const,
            version: session.version,
            contextType: session.contextType,
            sessionType: session.sessionType,
            startedAt: session.startedAt.toISOString(),
            expiresAt: session.expiresAt.toISOString(),
            policyRevision: session.policyRevision,
          },
          workspace: {
            id: workspace._id.toHexString(),
            name: workspace.name,
            type: workspace.type,
            status: workspace.status,
            timezone: workspace.timezone,
            defaultLanguage: workspace.defaultLanguage,
          },
        },
      };
    },
  );
}
