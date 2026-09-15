import { Type } from '@sinclair/typebox';

const Id = Type.String({ minLength: 24, maxLength: 24 });
const ExpectedVersion = Type.Integer({ minimum: 0 });

export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
});

export const ListNotificationsQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  unread: Type.Optional(Type.Boolean()),
});

export const NotificationParams = Type.Object({
  notificationId: Id,
});

export const PushDeviceParams = Type.Object({
  deviceId: Id,
});

const Channels = Type.Object(
  {
    email: Type.Optional(Type.Boolean()),
    push: Type.Optional(Type.Boolean()),
    inApp: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PreferencePutBody = Type.Object(
  {
    expectedVersion: ExpectedVersion,
    channels: Type.Optional(Channels),
    eventPreferences: Type.Optional(Type.Record(Type.String(), Channels)),
  },
  { additionalProperties: false },
);

export const PushDeviceRegisterBody = Type.Object(
  {
    platform: Type.Union([Type.Literal('IOS'), Type.Literal('ANDROID'), Type.Literal('WEB')]),
    provider: Type.String({ minLength: 1, maxLength: 80 }),
    token: Type.String({ minLength: 1, maxLength: 4096 }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  },
  { additionalProperties: false },
);
