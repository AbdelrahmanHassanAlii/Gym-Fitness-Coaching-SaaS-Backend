# V1 Support Access Frontend Guide

Issue: V1-FE-10 / GitHub #15

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Backend root inspected: `apps/backend`

## Source Of Truth

The locked Stage 18 backend implementation is authoritative over generated
OpenAPI, previous summaries, and this document. Route files, schemas, services,
access-control code, tests, migrations, and existing V1 docs win when they
disagree with generated artifacts.

This guide is frontend-facing. It documents the implemented V1 support access
contract only. It does not change support-access services, route hooks,
permissions, schemas, audits, migrations, tests, OpenAPI, or runtime behavior.

## Evidence Used

- `src/api/build-app.ts`
- `src/core/access-control/access-control.service.ts`
- `src/core/request-context/request-context.ts`
- `src/modules/support-access/support-access.routes.ts`
- `src/modules/support-access/support-access.schemas.ts`
- `src/modules/support-access/support-access.service.ts`
- `src/modules/support-access/support-access.repository.ts`
- `src/modules/support-access/support-access.types.ts`
- `src/modules/support-access/support-access.jobs.ts`
- `src/modules/permissions/permission.registry.ts`
- `src/modules/files/file.service.ts`
- `src/modules/progress/progress.service.ts`
- `src/modules/checkins/checkin.service.ts`
- `src/modules/exports/export.service.ts`
- `src/modules/retention/retention.service.ts`
- `src/modules/analytics/analytics.service.ts`
- `src/migrations/021-stage16-support-access.ts`
- `test/stage16-support-access.test.ts`
- `test/stage13-files-documents.test.ts`
- `test/stage15-audit.test.ts`
- `docs/v1/frontend-api-integration-guide.md`
- `docs/v1/frontend-feature-api-map.md`
- `docs/v1/permission-access-matrix.md`

## Contract Summary

Support access lets an authorized platform support actor open a controlled
support session and then call selected workspace APIs by sending
`x-support-session-id`.

There are two runtime context modes:

| Context mode | Frontend meaning | Backend authorization behavior |
| --- | --- | --- |
| `WORKSPACE_SUPPORT` | Platform support actor reads a target workspace without impersonating a tenant member. | Runtime workspace access is read-only and whitelisted. Query-access list/dashboard paths that require an effective membership can deny with `SUPPORT_WORKSPACE_DENIED`. |
| `USER_CONTEXT` | Platform support actor operates through a specific active workspace membership for a target user. | Backend evaluates the effective membership's normal workspace permissions and then applies support runtime checks and support-sensitive gates. |

The support actor remains the real actor. `USER_CONTEXT` does not turn the
platform support user into the tenant user; audit events preserve the real
platform actor and the effective tenant context separately.

OpenAPI does not represent the `x-support-session-id` behavioral contract. The
frontend must use this guide and implementation-backed route evidence.

## Hook Order And Headers

`buildApp` registers support context after authentication and before module
routes:

1. Request context is created.
2. Authentication fills user/session context.
3. The support pre-handler resolves `x-support-session-id` if present.
4. Route guards and services run with the resolved support context.

Header:

```http
x-support-session-id: 64f0000000000000000000aa
```

Header behavior:

- Header names are case-insensitive at HTTP level; tests use
  `X-Support-Session-Id`.
- If the header is missing, the request runs as a normal authenticated request.
- If the header is an array or trims to an empty value, the support resolver
  ignores it.
- If the header is a single non-empty value, the resolver treats it as a support
  session id.
- Invalid object-id text fails with a support error before the source route
  mutates state.
- Runtime validates the same real actor and the same parent auth session that
  started the support session. A refreshed token is acceptable only if it still
  represents that actor/session context as implemented by auth.
- The parent auth session must still be active, unrestricted, and MFA-satisfied.
- Runtime IP must match the session source IP.

Frontend rule: send `x-support-session-id` only while an active support session
is intentionally selected. Stop sending it immediately after end, revoke, expiry,
logout, session refresh failure, or any support-session denial.

## Route Inventory

All support management routes require a platform authenticated actor.

| Method | Path | Purpose | Idempotency | Concurrency |
| --- | --- | --- | --- | --- |
| `GET` | `/api/v1/platform/support/policies` | List support policies. | No. | None. |
| `POST` | `/api/v1/platform/support/policies` | Create support policy. | No route wrapper. | None. |
| `GET` | `/api/v1/platform/support/policies/:policyId` | Read support policy. | No. | None. |
| `PATCH` | `/api/v1/platform/support/policies/:policyId` | Replace/update support policy body. | No route wrapper. | `expectedVersion` is optional in schema; route defaults omitted value to `0`. |
| `POST` | `/api/v1/platform/support/policies/:policyId/disable` | Disable policy and revoke active sessions for that policy. | No route wrapper. | Requires `expectedVersion`. |
| `POST` | `/api/v1/platform/support/policies/:policyId/archive` | Archive policy and revoke active sessions for that policy. | No route wrapper. | Requires `expectedVersion`. |
| `POST` | `/api/v1/platform/support/access-requests` | Evaluate and start a support session, or persist a denied request. | Required by route wrapper. | None beyond idempotency. |
| `GET` | `/api/v1/platform/support/sessions` | List recent support sessions. | No. | None. |
| `GET` | `/api/v1/platform/support/sessions/:sessionId` | Read support session. | No. | None. |
| `POST` | `/api/v1/platform/support/sessions/:sessionId/end` | End own active session. | No route wrapper. | Requires `expectedVersion`. |
| `POST` | `/api/v1/platform/support/sessions/:sessionId/revoke` | Revoke active session. | No route wrapper. | Requires `expectedVersion`. |

`POST /api/v1/platform/support/access-requests` must send `Idempotency-Key`.
Other support management commands do not use the generic idempotency wrapper in
the locked implementation.

List routes are not cursor-paginated. `listSessions` returns up to 100 sessions
sorted by newest `startedAt`, then id.

## Permissions

Platform support permissions:

| Permission | Used for |
| --- | --- |
| `support.policies.read` | List/read policies. |
| `support.policies.create` | Create policies. |
| `support.policies.update` | Update policies. |
| `support.policies.disable` | Disable policies. |
| `support.policies.archive` | Archive policies. |
| `support.sessions.read` | List/read sessions. |
| `support.sessions.start` | Start sessions and revalidate runtime session use. |
| `support.sessions.end_own` | End the support actor's own active session. |
| `support.sessions.revoke` | Revoke active sessions. |
| `support.sensitive.read` | Extra platform gate for sensitive data through support context. |
| `support.sensitive_files.read` | Extra platform gate for sensitive file download through support context. |

Policy creation/update also enforces allowance ceilings:

- A support admin who creates or updates a policy with `allowSensitiveData: true`
  must have `support.sensitive.read`.
- A support admin who creates or updates a policy with
  `allowSensitiveFileDownload: true` must have `support.sensitive_files.read`.
- A platform support actor cannot create or update a policy granting access to
  their own platform membership; this fails with `SUPPORT_POLICY_SELF_GRANT_DENIED`.

## Policy DTO

Policy response shape:

```json
{
  "data": {
    "id": "policyId",
    "platformMembershipId": "platformMembershipId",
    "allowedTargetTypes": ["GYM"],
    "allowedWorkspaceIds": ["workspaceId"],
    "allowedIpRanges": ["127.0.0.1"],
    "allowedSessionTypes": ["READ_ONLY"],
    "maxSessionDurationMinutes": 30,
    "notificationRequired": true,
    "allowSensitiveData": false,
    "allowSensitiveFileDownload": false,
    "validFrom": "2026-01-01T00:00:00.000Z",
    "validUntil": "2026-01-02T00:00:00.000Z",
    "enabled": true,
    "revision": 0,
    "archivedAt": null,
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": null
  }
}
```

Policy request body:

```json
{
  "platformMembershipId": "platformMembershipId",
  "allowedTargetTypes": ["GYM"],
  "allowedWorkspaceIds": ["workspaceId"],
  "allowedIpRanges": ["127.0.0.1", "127.0.0.0/24", "::1"],
  "allowedSessionTypes": ["READ_ONLY"],
  "maxSessionDurationMinutes": 30,
  "notificationRequired": true,
  "allowSensitiveData": false,
  "allowSensitiveFileDownload": false,
  "validFrom": "2026-01-01T00:00:00.000Z",
  "validUntil": "2026-01-02T00:00:00.000Z",
  "enabled": true
}
```

Allowed values:

| Field | Values/rules |
| --- | --- |
| `allowedTargetTypes` | `GYM`, `INDEPENDENT_TRAINER`, `STAFF`, `TRAINEE`; array must not be empty. |
| `allowedSessionTypes` | `READ_ONLY`, `WRITE_SUPPORT`; array must not be empty. |
| `maxSessionDurationMinutes` | 1 through 60. |
| `allowedIpRanges` | Exact IPv4, IPv4 CIDR, and exact IPv6 are supported. IPv6 CIDR is rejected. |
| `allowedWorkspaceIds` | Optional workspace allowlist. If present, start requests must target one of these workspaces. |
| `validFrom` / `validUntil` | Optional date-time strings; `validFrom >= validUntil` is invalid. |

Policy lifecycle behavior:

- Created policies start at `revision: 0`.
- Update/disable/archive use compare-and-swap against `revision`.
- Disable sets `enabled: false`.
- Archive sets `enabled: false` and `archivedAt`.
- Update, disable, and archive revoke active sessions under that policy in the
  same transaction.
- Audit and outbox failures roll back policy/session lifecycle mutations.

## Start Support Session

Request:

```http
POST /api/v1/platform/support/access-requests
Authorization: Bearer <platform-support-token>
Content-Type: application/json
Idempotency-Key: <unique-command-key>

{
  "targetType": "GYM",
  "targetWorkspaceId": "workspaceId",
  "targetUserId": "targetUserId",
  "effectiveMembershipId": "workspaceMembershipId",
  "contextType": "USER_CONTEXT",
  "sessionType": "READ_ONLY",
  "requestedDurationMinutes": 30,
  "requestedSensitiveAccess": true,
  "requestedSensitiveFileDownload": false,
  "reason": "Investigating customer support ticket SUP-123",
  "reference": "SUP-123"
}
```

Start-session behavior:

- Requires `support.sessions.start`.
- Requires an unrestricted, MFA-satisfied parent auth session.
- Trims `reason`; trimmed length must be at least 3.
- `requestedSensitiveAccess` and `requestedSensitiveFileDownload` default to
  false.
- The request is compared against candidate policies for the actor's platform
  membership.
- Successful approval persists a support access request and an active support
  session.
- Denied policy decisions persist a denied support access request and return
  HTTP 403 with `accessRequestId`.
- Pre-decision failures such as missing permission, Stage 4 `DENY`, invalid
  reason, invalid ids, or missing idempotency key do not persist a support access
  request.
- Audit/outbox failures roll back approved session creation and denied request
  evidence.

Approved response:

```json
{
  "data": {
    "decision": "APPROVED",
    "supportSession": {
      "id": "supportSessionId",
      "requestId": "supportAccessRequestId",
      "policyId": "policyId",
      "realActorPlatformMembershipId": "platformMembershipId",
      "targetType": "GYM",
      "targetWorkspaceId": "workspaceId",
      "targetUserId": "targetUserId",
      "effectiveMembershipId": "workspaceMembershipId",
      "contextType": "USER_CONTEXT",
      "sessionType": "READ_ONLY",
      "startedAt": "2026-01-01T00:00:00.000Z",
      "expiresAt": "2026-01-01T00:30:00.000Z",
      "endedAt": null,
      "revokedAt": null,
      "status": "ACTIVE",
      "terminationReason": null,
      "version": 0
    }
  }
}
```

Denied response:

```json
{
  "error": {
    "code": "POLICY_NOT_FOUND",
    "message": "Support access denied."
  },
  "accessRequestId": "supportAccessRequestId"
}
```

Known persisted denial codes from policy evaluation include:

- `TARGET_WORKSPACE_NOT_FOUND`
- `TARGET_USER_CONTEXT_INVALID`
- `POLICY_NOT_FOUND`
- `POLICY_DISABLED`
- `POLICY_NOT_YET_VALID`
- `POLICY_EXPIRED`
- `TARGET_NOT_ALLOWED`
- `SESSION_TYPE_NOT_ALLOWED`
- `DURATION_NOT_ALLOWED`
- `SENSITIVE_ACCESS_NOT_ALLOWED`
- `SENSITIVE_FILE_ACCESS_NOT_ALLOWED`
- `WORKSPACE_NOT_ALLOWED`
- `IP_NOT_ALLOWED`

## USER_CONTEXT

Use `USER_CONTEXT` when the support actor should access the workspace through a
specific tenant user's active workspace membership.

Required start fields:

- `targetWorkspaceId`
- `targetUserId`
- `effectiveMembershipId`
- `contextType: "USER_CONTEXT"`

Start-time checks:

- The effective membership must belong to `targetWorkspaceId`.
- The effective membership's `userId` must equal `targetUserId`.
- The effective membership must be `ACTIVE`.

Runtime behavior:

- The support resolver sets `ctx.supportSessionId`,
  `ctx.platformMembershipId`, `ctx.workspaceId`, `ctx.effectiveUserId`, and
  `ctx.effectiveMembershipId`.
- Workspace authorization uses the effective membership's normal workspace
  profiles/grants.
- Normal workspace `DENY`, branch scope, relationship scope, lifecycle,
  entitlement, quota, `expectedVersion`, and service validations still apply.
- Sensitive support gates apply in addition to the effective membership's
  permissions.
- Runtime revalidates the target user and effective membership; mismatches or
  inactive membership fail closed and can security-terminate the support session.

Frontend guidance:

- Display the real support actor and effective tenant context distinctly.
- Do not treat the support user as the tenant user for audit or ownership.
- Stop using the support session when the backend returns
  `TARGET_USER_CONTEXT_INVALID`, `SUPPORT_EFFECTIVE_MEMBERSHIP_REQUIRED`, or a
  terminal support-session error.

## WORKSPACE_SUPPORT

Use `WORKSPACE_SUPPORT` when the support actor should inspect a workspace without
an effective tenant membership.

Runtime behavior:

- The support resolver sets `ctx.supportSessionId`,
  `ctx.platformMembershipId`, and `ctx.workspaceId`.
- Workspace access is limited to a read-only permission whitelist:
  - permissions ending with `.read`
  - permissions ending with `.download`
  - `files.download`
  - `billing.subscription.read`
  - `billing.usage.read`
  - `billing.payments.read`
- Non-read operations fail before source mutation.
- Query-access paths that require an effective membership can fail with
  `SUPPORT_WORKSPACE_DENIED`.

Session-type behavior:

- `READ_ONLY` sessions allow `GET`, `HEAD`, and the specific file download-url
  route described below.
- `WRITE_SUPPORT` is implemented as a session type but still denies ordinary
  business writes unless they are runtime whitelisted. A non-whitelisted write
  fails with `SUPPORT_WRITE_NOT_WHITELISTED`.
- A `READ_ONLY` session attempting a non-read operation fails with
  `SUPPORT_READ_ONLY`.

The only non-GET operation allowed by the runtime read-only operation check is:

```http
POST /api/v1/workspaces/:workspaceId/files/:fileId/download-url
```

This route can still require file/document permissions, sensitive-file support
gates, and audit success before returning a signed URL.

## Runtime Session Validation

Every downstream request with `x-support-session-id` revalidates:

- session id format and existence;
- support session is `ACTIVE`;
- support session has not passed `expiresAt`;
- current bearer actor matches the session's real actor;
- current auth session matches the session's parent auth session;
- parent auth session is active, unrestricted, and MFA-satisfied;
- platform actor still has `support.sessions.start`;
- policy still exists and still permits the session input;
- runtime IP still matches the source IP captured at session start;
- path `workspaceId` matches the session target workspace when both are present;
- `USER_CONTEXT` target user/effective membership remain fresh and active;
- operation is read-only/whitelisted for support runtime.

Some runtime security failures transition the session to
`SECURITY_TERMINATED` and write `SupportSessionSecurityTerminated` audit plus a
`SupportSessionRevoked` outbox event. Tests cover parent auth mismatch, policy
denial after start, IP changes, target/effective membership tampering, and
inactive effective memberships as fail-closed cases.

## Sensitive Support Gates

Support context has two layers for sensitive data:

1. Access-control platform permission gate.
2. Session allowance gate.

Sensitive platform permission mapping:

| Workspace permission / operation | Required platform permission |
| --- | --- |
| `medical_documents.download` | `support.sensitive.read` plus `support.sensitive_files.read` for support-sensitive file download paths. |
| `medical_documents.read` | `support.sensitive.read` |
| `health.read` | `support.sensitive.read` |
| `checkins.read` | `support.sensitive.read` |
| `progress_photos.read` | `support.sensitive.read` |
| `dashboard.trainer.read` | `support.sensitive.read` |
| `dashboard.gym.read` | `support.sensitive.read` |
| `dashboard.relationship.read` | `support.sensitive.read` |
| `analytics.progress.read` | `support.sensitive.read` |
| `analytics.nutrition.read` | `support.sensitive.read` |
| `analytics.adherence.read` | `support.sensitive.read` |

Session allowance flags:

| Flag | Required for |
| --- | --- |
| `allowSensitiveData` | Sensitive data reads through support context. |
| `allowSensitiveFileDownload` | Sensitive file download through support context; also requires `allowSensitiveData`. |

Denial codes:

- `SUPPORT_SENSITIVE_DENIED`
- `SUPPORT_SENSITIVE_FILE_DENIED`

Sensitive reads can also fail with 500 if the required sensitive-access audit
evidence cannot be written. Tests verify health/profile, check-in, and sensitive
file download paths fail closed when audit writing fails; sensitive file download
does not return a signed URL in that case.

## Session Lifecycle

Session statuses:

| Status | Meaning | Frontend behavior |
| --- | --- | --- |
| `ACTIVE` | Runtime header can be used until expiry and while validations pass. | Support mode may remain enabled. |
| `ENDED` | Real support actor ended their own active session. | Stop sending support header. |
| `EXPIRED` | Background job expired a due active session. | Stop support mode and ask for a new session if needed. |
| `REVOKED` | Authorized platform actor revoked the session, or policy invalidation revoked it. | Stop support mode immediately. |
| `SECURITY_TERMINATED` | Runtime security revalidation failed and the session was terminated. | Stop support mode, refresh session list/detail, and show access no longer valid. |

End own session:

```http
POST /api/v1/platform/support/sessions/:sessionId/end
Authorization: Bearer <platform-support-token>
Content-Type: application/json

{ "expectedVersion": 0 }
```

Revoke session:

```http
POST /api/v1/platform/support/sessions/:sessionId/revoke
Authorization: Bearer <platform-support-token>
Content-Type: application/json

{ "expectedVersion": 0 }
```

Lifecycle behavior:

- `end` requires `support.sessions.end_own` and ownership by the real actor's
  platform membership.
- `revoke` requires `support.sessions.revoke`.
- Both transition only from `ACTIVE`.
- Both use `expectedVersion` and return
  `SUPPORT_SESSION_VERSION_CONFLICT` for stale or terminal state races.
- End/revoke write audit and outbox events in the same transaction; audit/outbox
  failures roll back the terminal transition.
- A race between end and revoke yields one successful terminal transition and
  one 409 conflict.

Expiry:

- `SupportAccessJobRunner.expireSessions()` calls the leased
  `support.expire-sessions` job.
- The job expires active sessions with `expiresAt <= now`.
- It writes `SupportSessionExpired` audit and outbox events.
- Audit/outbox failures leave the session active so the job can retry.
- Future and already-terminal sessions are not expired.

## Audit And Notifications

Support lifecycle operations write audit events:

- `PortalAccessPolicyCreated`
- `PortalAccessPolicyChanged`
- `SupportAccessRequestDenied`
- `SupportSessionStarted`
- `SupportSessionEnded`
- `SupportSessionRevoked`
- `SupportSessionExpired`
- `SupportSessionSecurityTerminated`

Support session audit includes:

- real actor user id;
- real platform membership id;
- support session id;
- effective support context;
- target workspace/user/effective membership where present;
- reason/reference where stored;
- request IP, user agent, and correlation id.

Support lifecycle operations also write outbox events for notification/eventual
processing. The notification registry sends support session notifications to
owners when `notificationRequired` is true. A support event with
`notificationRequired: false` suppresses those owner notifications.

Sensitive downstream reads can write sensitive-access audit evidence with both
real support actor and effective tenant context. If that audit fails, selected
sensitive routes fail closed.

## Unsupported Or Forbidden Support Contexts

Support context is not a universal override.

Implemented forbidden cases:

- Workspace export service forbids support context with `EXPORT_SUPPORT_FORBIDDEN`.
- Retention/deletion service forbids support context with
  `SUPPORT_ACCESS_FORBIDDEN`.
- Non-whitelisted writes are denied before source mutation.
- Wrong workspace path is denied with `SUPPORT_SESSION_WORKSPACE_MISMATCH`.
- `WORKSPACE_SUPPORT` on query-access paths that need an effective membership
  can deny with `SUPPORT_WORKSPACE_DENIED`.

Frontend guidance:

- Hide export/retention support-mode actions.
- Treat support mode as a diagnostic read mode, not as a general admin bypass.
- Use normal tenant/admin sessions for non-support workflows.

## Error Catalog

| Code | HTTP | When it occurs | Frontend behavior |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | Missing/invalid authenticated user/session. | Reauthenticate. |
| `TWO_FACTOR_REQUIRED` | 403 | Platform auth session has not satisfied MFA. | Complete MFA before support access. |
| `AUTH_SESSION_RESTRICTED` | 403 | Parent session is restricted/unverified. | Finish account verification. |
| `PLATFORM_MEMBERSHIP_REQUIRED` | 403 | Actor lacks active platform membership. | Hide support console. |
| `SUPPORT_POLICY_SELF_GRANT_DENIED` | 403 | Policy attempts to grant actor access to their own platform membership. | Choose a different support actor target. |
| `SUPPORT_POLICY_NOT_FOUND` | 404 or 403 | Policy detail id is missing/not found, or runtime session policy is gone. | Refetch policy/session state and stop support mode if runtime. |
| `SUPPORT_POLICY_VERSION_CONFLICT` | 409 | Policy `revision` changed or policy is archived/missing for mutation. | Refetch policy and reapply changes. |
| `SUPPORT_SESSION_NOT_FOUND` | 404 | Session detail/end/revoke id is missing or not found. | Refresh session list. |
| `SUPPORT_SESSION_OWNERSHIP_REQUIRED` | 403 | Actor tries to end a session owned by another platform membership. | Use revoke flow if actor has permission, otherwise hide action. |
| `SUPPORT_SESSION_VERSION_CONFLICT` | 409 | Session `version` changed or no longer active for transition. | Refetch session. |
| `SUPPORT_REASON_REQUIRED` | 422 | Trimmed reason is shorter than 3 characters. | Require a support reason. |
| `SUPPORT_POLICY_TARGETS_REQUIRED` | 422 | Policy target type list is empty. | Add at least one target type. |
| `SUPPORT_POLICY_SESSION_TYPES_REQUIRED` | 422 | Policy session type list is empty. | Add at least one session type. |
| `SUPPORT_POLICY_VALIDITY_INVALID` | 422 | `validFrom >= validUntil`. | Correct date range. |
| `SUPPORT_POLICY_DURATION_INVALID` | 422 | Policy duration outside supported range. | Use 1-60 minutes. |
| `SUPPORT_POLICY_IP_RANGE_INVALID` | 422 | Invalid exact IP/CIDR. | Use exact IPv4, IPv4 CIDR, or exact IPv6. |
| `TARGET_WORKSPACE_NOT_FOUND` | 403 | Start target workspace is missing. | Refresh target selection. |
| `TARGET_USER_CONTEXT_INVALID` | 403 | `USER_CONTEXT` target user/effective membership is missing, mismatched, inactive, or stale. | Stop support mode and refresh target user/membership. |
| `POLICY_NOT_FOUND` | 403 | No enabled candidate policy permits the request. | Show policy denial; do not retry unchanged. |
| `POLICY_DISABLED` | 403 | Runtime policy became disabled/archived. | Stop support mode. |
| `POLICY_NOT_YET_VALID` | 403 | Policy validity window has not started. | Retry after validity begins. |
| `POLICY_EXPIRED` | 403 | Policy validity window ended. | Request policy update/new session. |
| `TARGET_NOT_ALLOWED` | 403 | Target type not allowed by policy. | Choose an allowed target. |
| `SESSION_TYPE_NOT_ALLOWED` | 403 | Session type not allowed by policy. | Choose an allowed session type. |
| `DURATION_NOT_ALLOWED` | 403 | Requested duration exceeds policy/system limit. | Reduce duration. |
| `SENSITIVE_ACCESS_NOT_ALLOWED` | 403 | Requested sensitive data exceeds policy. | Start without sensitive access or request policy change. |
| `SENSITIVE_FILE_ACCESS_NOT_ALLOWED` | 403 | Requested sensitive file access exceeds policy. | Start without sensitive file access or request policy change. |
| `WORKSPACE_NOT_ALLOWED` | 403 | Workspace not in policy allowlist. | Choose allowed workspace. |
| `IP_NOT_ALLOWED` | 403 | Source IP not permitted by policy. | Use permitted network or update policy. |
| `SUPPORT_SESSION_INVALID` | 403 | Runtime session id is missing/not found. | Stop support mode and refetch session. |
| `SUPPORT_SESSION_ACTOR_MISMATCH` | 403 | Bearer actor differs from real session actor. | Stop support mode. |
| `SUPPORT_SESSION_PARENT_MISMATCH` | 403 | Auth session differs from parent session. | Start a new support session. |
| `SUPPORT_SESSION_PARENT_INVALID` | 403 | Parent auth session is inactive/restricted/no MFA. | Reauthenticate/MFA and start a new support session. |
| `SUPPORT_SESSION_NOT_ACTIVE` | 403 | Session is terminal. | Stop support mode. |
| `SUPPORT_SESSION_EXPIRED` | 403 | Session passed expiry. | Start a new support session. |
| `SUPPORT_SESSION_IP_MISMATCH` | 403 | Runtime IP changed from session start. | Start a new session from current network if policy allows. |
| `SUPPORT_SESSION_WORKSPACE_MISMATCH` | 403 | Path workspace does not match session target workspace. | Stop request; select matching workspace. |
| `SUPPORT_READ_ONLY` | 403 | Read-only session attempted a non-read operation. | Disable mutation UI in support mode. |
| `SUPPORT_WRITE_NOT_WHITELISTED` | 403 | Non-whitelisted write attempted in support mode. | Disable mutation UI in support mode. |
| `SUPPORT_WORKSPACE_DENIED` | 403 | Workspace support mode lacks effective membership for the requested access path or workspace mismatch. | Use `USER_CONTEXT` when effective tenant scope is required. |
| `SUPPORT_EFFECTIVE_MEMBERSHIP_REQUIRED` | 403 | Support `USER_CONTEXT` effective membership is missing/inactive. | Stop support mode and refresh target membership. |
| `SUPPORT_SENSITIVE_DENIED` | 403 | Sensitive data gate denied. | Hide sensitive data or start a sensitive-allowed session. |
| `SUPPORT_SENSITIVE_FILE_DENIED` | 403 | Sensitive file gate denied. | Hide sensitive download or start a sensitive-file-allowed session. |
| `EXPORT_SUPPORT_FORBIDDEN` | 403 | Export service called with support context. | Hide export actions in support mode. |
| `SUPPORT_ACCESS_FORBIDDEN` | 403 | Retention/deletion service called with support context. | Hide retention/deletion actions in support mode. |

## Frontend Sequences

### Start Workspace Support Read

1. Platform support user authenticates and satisfies MFA.
2. Frontend lists/chooses eligible workspace target.
3. `POST /platform/support/access-requests` with `WORKSPACE_SUPPORT`,
   `READ_ONLY`, reason, reference, target workspace, and `Idempotency-Key`.
4. On 201, store `supportSession.id`, `version`, `expiresAt`, and context.
5. Send `x-support-session-id` on eligible read routes.
6. Stop sending the header when the session becomes terminal or a runtime
   support error occurs.

### Start User Context Support Read

1. Resolve the target user and active workspace membership id.
2. Start a support access request with `contextType: "USER_CONTEXT"`,
   `targetUserId`, and `effectiveMembershipId`.
3. On 201, call downstream workspace routes with `x-support-session-id`.
4. Render UI based on the effective tenant membership's normal permissions plus
   support-sensitive denial handling.
5. If membership or target freshness fails at runtime, backend denies and can
   security-terminate the session.

### Sensitive File Download In Support Mode

1. Start `USER_CONTEXT` or otherwise eligible session with
   `requestedSensitiveAccess: true` and
   `requestedSensitiveFileDownload: true`.
2. Ensure the platform actor has both `support.sensitive.read` and
   `support.sensitive_files.read`.
3. Call `POST /api/v1/workspaces/:workspaceId/files/:fileId/download-url`
   with `x-support-session-id`.
4. If audit succeeds, use the returned URL immediately.
5. If denied or audit fails, do not expect or display a signed URL.

### End Own Session

1. Read current session `version`.
2. `POST /platform/support/sessions/:sessionId/end` with `expectedVersion`.
3. On success, remove support session state from frontend request context.
4. On 409, refetch session; it may already be terminal.

## Non-Public/Internal Details

Frontend must not depend on:

- Mongo collection names or indexes.
- Internal policy/session snapshots.
- Worker lease key `support.expire-sessions`.
- Raw audit event storage.
- Outbox handler internals.
- Internal support access request records beyond the public `accessRequestId`
  returned on denied start.
- Security-termination internals beyond the public session status and errors.

## Known Follow-Ups

UNVERIFIED — REQUIRES FOLLOW-UP: `WRITE_SUPPORT` is a registered support session
type, but runtime business writes are still denied unless a request is read-only
or the specific file download-url POST. Any product expectation that
`WRITE_SUPPORT` enables controlled mutations requires a future implementation
issue.

UNVERIFIED — REQUIRES FOLLOW-UP: V1 exposes support policy/session list routes
without cursor pagination and session list is capped at 100. A larger support
operations console may need future pagination/filtering API work.

## Locked-Stage Protection

- No Stage 2-18 implementation was modified.
- No support-access routes, schemas, services, repositories, access-control code,
  permissions, audits, migrations, tests, OpenAPI artifacts, configuration,
  generated artifacts, or runtime behavior were changed.
- This guide documents existing behavior only, including OpenAPI gaps,
  `WRITE_SUPPORT` limitations, and support-sensitive fail-closed paths.
