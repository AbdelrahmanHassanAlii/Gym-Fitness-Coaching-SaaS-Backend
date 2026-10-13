import type { FastifyInstance } from 'fastify';

const routes = new Set([
  '/api/v1/workspaces/:workspaceId/exports',
  '/api/v1/workspaces/:workspaceId/exports/:exportId',
  '/api/v1/workspaces/:workspaceId/exports/:exportId/download-url',
  '/api/v1/platform/workspace-deletions',
  '/api/v1/platform/workspace-deletions/:deletionId',
  '/api/v1/platform/workspace-deletions/:deletionId/approve',
  '/api/v1/platform/workspace-deletions/:deletionId/postpone',
  '/api/v1/platform/workspace-deletions/:deletionId/cancel',
]);

function isStage17Path(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return (
    /^\/api\/v1\/workspaces\/[^/]+\/exports(?:\/[^/]+(?:\/download-url)?)?$/.test(path) ||
    /^\/api\/v1\/platform\/workspace-deletions(?:\/[^/]+(?:\/(?:approve|postpone|cancel))?)?$/.test(
      path,
    )
  );
}

/** Register before authentication/support processing, including early error responses. */
export async function registerStage17SecurityBoundary(app: FastifyInstance) {
  app.addHook('onSend', async (request, reply, payload) => {
    if (routes.has(request.routeOptions.url ?? '') || isStage17Path(request.url)) {
      reply.header('Cache-Control', 'private, no-store');
    }
    return payload;
  });
}
