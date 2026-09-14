import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildApp } from '../src/api/build-app';
import type { AppContainer } from '../src/bootstrap/app-container';
import type { AppConfig } from '../src/config/config.types';

const outputPath = resolve(process.cwd(), '../../docs/apidog/openapi.json');
const variablesPath = resolve(process.cwd(), '../../docs/apidog/global-variables.example.json');

const mutatingMethods = new Set(['post', 'put', 'patch', 'delete']);

const config: AppConfig = {
  env: 'development',
  app: {
    host: '0.0.0.0',
    port: 3000,
    docsEnabled: false,
    trustProxy: false,
    allowedOrigins: [],
  },
  mongo: {
    uri: 'mongodb://localhost:27017/gym_platform',
    dbName: 'gym_platform',
    connectTimeoutMs: 5000,
  },
  logging: {
    level: 'silent',
  },
  auth: {
    jwtActiveKeyId: 'local',
    jwtPrivateKey: '',
    jwtPublicKeys: {},
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
    webRefreshCookieSameSite: 'LAX',
    otpHmacSecret: '',
    totpEncryptionKey: '',
    loginIdentifierIpWindowMs: 900_000,
    loginIdentifierIpMaxAttempts: 5,
    loginIdentifierIpBlockMs: 900_000,
    loginIpWindowMs: 900_000,
    loginIpMaxAttempts: 30,
    challengeTtlSeconds: 600,
    challengeMaxAttempts: 5,
    challengeResendCooldownSeconds: 60,
    challengeMaxSendsPerHour: 5,
    mfaChallengeTtlSeconds: 300,
    mfaChallengeMaxAttempts: 5,
    recoveryCodeCount: 10,
    passwordResetIdentifierMaxPerHour: 3,
    passwordResetIpMaxPerHour: 10,
  },
  worker: {
    id: 'openapi-export',
    outboxPollIntervalMs: 1000,
    outboxLockMs: 30_000,
    outboxMaxAttempts: 8,
    jobLeaseMs: 30_000,
  },
  subscriptions: {
    trialExpiryAction: 'FROZEN',
    paidGraceDays: 0,
    frozenToExpiredDays: 30,
  },
  support: {
    defaultSessionMinutes: 30,
    maxSessionMinutes: 60,
  },
};

const container = {
  config,
  database: {
    ping: async () => true,
    close: async () => undefined,
  },
  jwt: {
    verifyAccessToken: () => ({ sid: '000000000000000000000000', sub: '000000000000000000000000' }),
  },
  authSessions: {
    findActive: async () => undefined,
  },
} as unknown as AppContainer;

const app = await buildApp(container);

try {
  await app.ready();
  const document = app.swagger();
  const openapi = normalizeOpenApi(document as OpenApiDocument);

  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify(openapi, null, 2)}\n`);
  await Bun.write(
    variablesPath,
    `${JSON.stringify(
      {
        baseUrl: 'http://localhost:3000',
        accessToken: '',
        refreshToken: '',
        idempotencyKey: '',
        workspaceId: '',
        branchId: '',
        membershipId: '',
        leadId: '',
        relationshipId: '',
      },
      null,
      2,
    )}\n`,
  );

  const endpointCount = Object.values(openapi.paths).reduce(
    (count, item) =>
      count + Object.keys(item).filter((key) => mutatingMethods.has(key) || key === 'get').length,
    0,
  );

  console.log(`Wrote ${endpointCount} endpoints to ${outputPath}`);
  console.log(`Wrote Apidog variable examples to ${variablesPath}`);
} finally {
  await app.close();
}

interface OpenApiDocument {
  openapi: string;
  info: Record<string, unknown>;
  servers?: unknown[];
  tags?: Array<{ name: string }>;
  components?: {
    parameters?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
    [key: string]: unknown;
  };
  security?: unknown[];
  paths: Record<string, Record<string, OperationObject>>;
  [key: string]: unknown;
}

interface OperationObject {
  tags?: string[];
  security?: unknown[];
  parameters?: unknown[];
  operationId?: string;
  [key: string]: unknown;
}

function normalizeOpenApi(document: OpenApiDocument): OpenApiDocument {
  document.info.title = 'Gym & Fitness Coaching SaaS API';
  document.components ??= {};
  document.components.parameters ??= {};
  document.components.parameters.IdempotencyKeyHeader = {
    name: 'Idempotency-Key',
    in: 'header',
    required: false,
    schema: { type: 'string' },
    description:
      'Use a unique value per command request. Reuse the same value only when retrying the same request.',
  };

  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isOperation(method, operation)) continue;

      operation.tags = operation.tags?.length ? operation.tags : [tagForPath(path)];
      operation.operationId ??= operationId(method, path);

      if (shouldExposeIdempotencyHeader(method, path, operation)) {
        operation.parameters = operation.parameters ?? [];
        if (!hasIdempotencyParameter(operation.parameters)) {
          operation.parameters.push({ $ref: '#/components/parameters/IdempotencyKeyHeader' });
        }
      }
    }
  }

  return document;
}

function isOperation(method: string, value: unknown): value is OperationObject {
  return ['get', 'post', 'put', 'patch', 'delete'].includes(method) && Boolean(value);
}

function shouldExposeIdempotencyHeader(
  method: string,
  path: string,
  operation: OperationObject,
): boolean {
  if (!mutatingMethods.has(method)) return false;
  if (path.startsWith('/api/v1/auth/')) return false;
  if (
    operation.security &&
    operation.security.length === 0 &&
    !path.includes('/owner-activations/')
  ) {
    return false;
  }
  return true;
}

function hasIdempotencyParameter(parameters: unknown[]): boolean {
  return parameters.some((parameter) => {
    if (!parameter || typeof parameter !== 'object') return false;
    const record = parameter as Record<string, unknown>;
    return record.$ref === '#/components/parameters/IdempotencyKeyHeader';
  });
}

function tagForPath(path: string): string {
  if (path.includes('/progress-photos') || path.includes('/health-profile')) return 'Progress';
  if (path.includes('/daily-tracking') || path.includes('/measurements')) return 'Progress';
  if (path.includes('/nutrition') || path.includes('/foods')) return 'Nutrition';
  if (path.includes('/workouts')) return 'Workouts';
  if (path.includes('/program') || path.includes('/exercises')) return 'Training';
  if (path.includes('/check-ins')) return 'Check-Ins';
  if (path.includes('/trainees') || path.includes('/relationships')) return 'Trainees';
  if (path.includes('/payments')) return 'Payments';
  if (path.includes('/subscriptions') || path.includes('/plans')) return 'Subscriptions';
  if (path.includes('/permissions')) return 'Permissions';
  if (path.includes('/leads')) return 'Leads';
  if (path.includes('/workspaces')) return 'Workspaces';
  return 'Platform';
}

function operationId(method: string, path: string): string {
  const pathName = path
    .replace(/^\/api\/v1\//, '')
    .replace(/[{}]/g, '')
    .split('/')
    .filter(Boolean)
    .map((part) =>
      part.replace(/[^a-zA-Z0-9]+(.)/g, (_match, letter: string) => letter.toUpperCase()),
    )
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `${method}${pathName}`;
}
