import { Type } from '@sinclair/typebox';
import { WorkspaceStatuses, WorkspaceTypes } from '../workspaces/workspace.types';

const ErrorResponse = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({ minLength: 1, maxLength: 128 }),
        message: Type.String({ maxLength: 1000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const Id = Type.String({ pattern: '^[0-9a-f]{24}$', minLength: 24, maxLength: 24 });
const Version = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Instant = Type.String({ format: 'date-time', maxLength: 40 });

export const SupportContextHeaders = Type.Object({ 'x-support-session-id': Id });
export const SupportContextQuery = Type.Object({}, { additionalProperties: false });
export const SupportContextResponse = Type.Object(
  {
    data: Type.Object(
      {
        supportSession: Type.Object(
          {
            id: Id,
            status: Type.Literal('ACTIVE'),
            version: Version,
            contextType: Type.Union([
              Type.Literal('WORKSPACE_SUPPORT'),
              Type.Literal('USER_CONTEXT'),
            ]),
            sessionType: Type.Union([Type.Literal('READ_ONLY'), Type.Literal('WRITE_SUPPORT')]),
            startedAt: Instant,
            expiresAt: Instant,
            policyRevision: Version,
          },
          { additionalProperties: false },
        ),
        workspace: Type.Object(
          {
            id: Id,
            name: Type.String({ minLength: 1, maxLength: 160 }),
            type: Type.Union(WorkspaceTypes.map((value) => Type.Literal(value))),
            status: Type.Union(WorkspaceStatuses.map((value) => Type.Literal(value))),
            timezone: Type.String({ minLength: 1, maxLength: 80 }),
            defaultLanguage: Type.Union([Type.Literal('ar'), Type.Literal('en')]),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SupportContextErrors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  422: ErrorResponse,
  500: ErrorResponse,
};
