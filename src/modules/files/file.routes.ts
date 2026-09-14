import type { Static } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContainer } from '../../bootstrap/app-container';
import { idempotencyKey } from '../../core/idempotency/idempotency.service';
import type { RequestContext } from '../../core/request-context/request-context';
import { requireAuth } from '../auth/auth.middleware';
import {
  ConfirmUploadBody,
  CreateDocumentBody,
  DocumentParams,
  ErrorResponse,
  ExpectedVersionBody,
  FileParams,
  ListQuery,
  RelationshipParams,
  UploadIntentBody,
  UploadIntentParams,
  WorkspaceParams,
} from './file.schemas';

export async function registerFileRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.post<{ Params: Static<typeof WorkspaceParams>; Body: Static<typeof UploadIntentBody> }>(
    '/api/v1/workspaces/:workspaceId/files/upload-intents',
    routeOptions({ params: WorkspaceParams, body: UploadIntentBody }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request.ctx,
        idempotencyKey(request.headers),
        'POST /workspaces/:workspaceId/files/upload-intents',
        request.body,
        (tx) =>
          container.files.createUploadIntent(
            request.ctx,
            request.params.workspaceId,
            request.body,
            tx,
          ),
      ),
  );

  app.post<{
    Params: Static<typeof UploadIntentParams>;
    Body: Static<typeof ConfirmUploadBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/files/upload-intents/:uploadIntentId/confirm',
    routeOptions({ params: UploadIntentParams, body: ConfirmUploadBody }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request.ctx,
        idempotencyKey(request.headers),
        'POST /workspaces/:workspaceId/files/upload-intents/:uploadIntentId/confirm',
        { ...request.params, ...request.body },
        (tx) =>
          container.files.confirmUpload(
            request.ctx,
            request.params.workspaceId,
            request.params.uploadIntentId,
            request.body,
            tx,
          ),
      ),
  );

  app.post<{ Params: Static<typeof FileParams> }>(
    '/api/v1/workspaces/:workspaceId/files/:fileId/download-url',
    routeOptions({ params: FileParams }),
    async (request) => ({
      data: await container.files.createDownloadUrl(
        request.ctx,
        request.params.workspaceId,
        request.params.fileId,
      ),
    }),
  );

  app.delete<{ Params: Static<typeof FileParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/workspaces/:workspaceId/files/:fileId',
    routeOptions({ params: FileParams, body: ExpectedVersionBody }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request.ctx,
        idempotencyKey(request.headers),
        'DELETE /workspaces/:workspaceId/files/:fileId',
        { ...request.params, ...request.body },
        (tx) =>
          container.files.deleteFile(
            request.ctx,
            request.params.workspaceId,
            request.params.fileId,
            request.body,
            tx,
          ),
      ),
  );

  app.post<{ Params: Static<typeof FileParams>; Body: Static<typeof ExpectedVersionBody> }>(
    '/api/v1/workspaces/:workspaceId/files/:fileId/restore',
    routeOptions({ params: FileParams, body: ExpectedVersionBody }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request.ctx,
        idempotencyKey(request.headers),
        'POST /workspaces/:workspaceId/files/:fileId/restore',
        { ...request.params, ...request.body },
        (tx) =>
          container.files.restoreFile(
            request.ctx,
            request.params.workspaceId,
            request.params.fileId,
            request.body,
            tx,
          ),
      ),
  );

  app.get<{ Params: Static<typeof RelationshipParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents',
    routeOptions({ params: RelationshipParams, querystring: ListQuery }),
    async (request) =>
      await container.files.listDocuments(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.query,
      ),
  );

  app.post<{
    Params: Static<typeof RelationshipParams>;
    Body: Static<typeof CreateDocumentBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents',
    routeOptions({ params: RelationshipParams, body: CreateDocumentBody }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request.ctx,
        idempotencyKey(request.headers),
        'POST /workspaces/:workspaceId/relationships/:relationshipId/documents',
        { ...request.params, ...request.body },
        (tx) =>
          container.files.createDocument(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            request.body,
            tx,
          ),
      ),
  );

  app.get<{ Params: Static<typeof DocumentParams> }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents/:documentId',
    routeOptions({ params: DocumentParams }),
    async (request) => ({
      data: await container.files.getDocument(
        request.ctx,
        request.params.workspaceId,
        request.params.relationshipId,
        request.params.documentId,
      ),
    }),
  );

  app.delete<{
    Params: Static<typeof DocumentParams>;
    Body: Static<typeof ExpectedVersionBody>;
  }>(
    '/api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents/:documentId',
    routeOptions({ params: DocumentParams, body: ExpectedVersionBody }),
    async (request, reply) =>
      await idempotent(
        reply,
        container,
        request.ctx,
        idempotencyKey(request.headers),
        'DELETE /workspaces/:workspaceId/relationships/:relationshipId/documents/:documentId',
        { ...request.params, ...request.body },
        (tx) =>
          container.files.deleteDocument(
            request.ctx,
            request.params.workspaceId,
            request.params.relationshipId,
            request.params.documentId,
            request.body,
            tx,
          ),
      ),
  );
}

function routeOptions(schema: Record<string, unknown>) {
  return {
    preHandler: [requireAuth()],
    schema: {
      ...schema,
      response: { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
      tags: ['Files'],
    },
  };
}

async function idempotent<T>(
  reply: FastifyReply,
  container: AppContainer,
  ctx: RequestContext,
  key: string | undefined,
  routeKey: string,
  fingerprint: unknown,
  operation: (
    tx: Parameters<AppContainer['unitOfWork']['withTransaction']>[0] extends (
      tx: infer TTx,
    ) => unknown
      ? TTx
      : never,
  ) => Promise<T>,
) {
  const result = await container.idempotency.runInTransaction(ctx, {
    key,
    routeKey,
    fingerprint,
    unitOfWork: container.unitOfWork,
    operation: async (tx) => ({ body: { data: await operation(tx) } }),
  });
  return reply.status(result.statusCode).send(result.body);
}
