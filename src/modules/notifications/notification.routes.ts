import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { AppContainer } from '../../bootstrap/app-container';
import { requireAuth } from '../auth/auth.middleware';
import {
  ErrorResponse,
  ListNotificationsQuery,
  NotificationParams,
  PreferencePutBody,
  PushDeviceParams,
  PushDeviceRegisterBody,
} from './notification.schemas';

export async function registerNotificationRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  app.get<{ Querystring: Static<typeof ListNotificationsQuery> }>(
    '/api/v1/me/notifications',
    options({ querystring: ListNotificationsQuery }),
    async (request) => await container.notifications.list(request.ctx, request.query),
  );

  app.post<{ Params: Static<typeof NotificationParams> }>(
    '/api/v1/me/notifications/:notificationId/read',
    options({ params: NotificationParams }),
    async (request) =>
      await container.notifications.markRead(request.ctx, request.params.notificationId),
  );

  app.post(
    '/api/v1/me/notifications/read-all',
    options({}),
    async (request) => await container.notifications.markAllRead(request.ctx),
  );

  app.get(
    '/api/v1/me/notification-preferences',
    options({}),
    async (request) => await container.notifications.getPreferences(request.ctx),
  );

  app.put<{ Body: Static<typeof PreferencePutBody> }>(
    '/api/v1/me/notification-preferences',
    options({ body: PreferencePutBody }),
    async (request) => await container.notifications.putPreferences(request.ctx, request.body),
  );

  app.post<{ Body: Static<typeof PushDeviceRegisterBody> }>(
    '/api/v1/me/push-devices',
    options({ body: PushDeviceRegisterBody }),
    async (request, reply) => {
      const result = await container.notifications.registerPushDevice(request.ctx, request.body);
      return reply.status(201).send(result);
    },
  );

  app.delete<{ Params: Static<typeof PushDeviceParams> }>(
    '/api/v1/me/push-devices/:deviceId',
    options({ params: PushDeviceParams }),
    async (request) =>
      await container.notifications.revokePushDevice(request.ctx, request.params.deviceId),
  );
}

function options(schema: Record<string, unknown>) {
  return {
    preHandler: [requireAuth()],
    schema: {
      tags: ['Me', 'Notifications'],
      ...schema,
      response: {
        200: {},
        201: {},
        401: ErrorResponse,
        404: ErrorResponse,
        409: ErrorResponse,
        422: ErrorResponse,
      },
    },
  };
}
