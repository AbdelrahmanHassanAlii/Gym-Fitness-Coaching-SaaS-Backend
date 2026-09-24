# V1 Frontend API Integration Guide

Issue: V1-FE-03 / GitHub #8

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Backend root inspected: `apps/backend`

## Source Of Truth

The locked Stage 18 backend implementation is authoritative over generated
OpenAPI, previous summaries, and this guide. Route files, schemas, services,
repositories, access-control code, tests, migrations, and V1 documentation win
when they disagree with generated artifacts.

This guide is the primary V1 frontend integration guide. It summarizes API
behavior for frontend engineers without exposing unnecessary internal database
details. Specialized follow-up issues own deeper contracts for feature mapping,
errors, pagination, time/timezone, files, notifications, and support access.

## Evidence Used

- `docs/v1/backend-module-inventory.md`
- `docs/v1/module-business-flows.md`
- `docs/v1/cross-module-workflows.md`
- `docs/v1/state-machine-status-reference.md`
- `docs/v1/permission-access-matrix.md`
- `docs/v1/openapi-export-verification.md`
- `docs/v1/openapi-curation-gap-report.md`
- `src/api/build-app.ts`
- `src/api/health.routes.ts`
- `src/modules/**/**.routes.ts`
- `src/modules/**/**.schemas.ts`
- `src/core/idempotency/idempotency.service.ts`
- `src/core/access-control/access-control.service.ts`
- `src/modules/support-access/support-access.service.ts`

## Contract Warnings

- The root `docs/apidog/openapi.json` artifact was stale when V1-FE-01 ran. It
  had 188 operations; fresh export from the locked backend had 233 operations.
- OpenAPI is useful for method/path/schema inventory after regeneration, but it
  is not sufficient for auth, support sessions, idempotency, permissions,
  pagination semantics, or error UX.
- `Idempotency-Key` in OpenAPI is heuristic. Use route/service evidence in this
  guide.
- `x-support-session-id` is not represented in generated OpenAPI. Use the
  support sections in this guide and V1-FE-10.
- `relationshipId` is the coaching relationship id. It is not the trainee user id.

## Base Contract

| Concern | V1 frontend contract |
| --- | --- |
| Base path | All product routes are under `/api/v1`, except health checks `/healthz` and `/readyz`. |
| Content type | JSON request bodies should use `Content-Type: application/json`. |
| Auth header | Authenticated routes use `Authorization: Bearer <accessToken>`. |
| Refresh cookie | Web refresh flow can use the refresh cookie set by auth routes. Mobile/native clients can send refresh token in the refresh body. |
| Idempotency header | Use `Idempotency-Key` only for commands documented as idempotent. Do not infer from OpenAPI alone. |
| Support header | Use `x-support-session-id` only inside an active support session. |
| Response envelope | Most routes return `{ data: ... }`; list routes often return `{ data: [...], meta: ... }`. Some auth routes return token DTOs directly inside `data`. |
| Error envelope | Errors are centralized `AppError` responses with a stable `code`, HTTP status, and message. V1-FE-05 owns the full frontend UX catalog. |
| Versioning | Mutations that include `expectedVersion` perform compare-and-swap checks against the current aggregate version/revision/accessVersion. |

## Authentication Flow

### Public Auth Routes

These routes are public by route schema and do not require `Authorization`:

| Method | Path | Purpose | Body | Response |
| --- | --- | --- | --- | --- |
| `POST` | `/api/v1/auth/register` | Register a user. | `RegisterBody` | token or verification/restricted-session result depending implementation state. |
| `POST` | `/api/v1/auth/login` | Password login. | `LoginBody` | token response or MFA challenge. |
| `POST` | `/api/v1/auth/mfa/login/verify` | Complete MFA login challenge. | `MfaLoginVerifyBody` | auth token response. |
| `POST` | `/api/v1/auth/refresh` | Rotate/refresh session. | `RefreshBody` or refresh cookie | auth token response. |
| `POST` | `/api/v1/auth/logout` | Revoke current refresh/session context. | none | success. |
| `POST` | `/api/v1/auth/email/verify` | Verify email. | `VerifyBody` | success. |
| `POST` | `/api/v1/auth/phone/verify` | Verify phone. | `VerifyBody` | success. |
| `POST` | `/api/v1/auth/verification/resend` | Resend verification. | `ResendVerificationBody` | success/rate-limit behavior. |
| `POST` | `/api/v1/auth/password/forgot` | Start password reset. | `ForgotPasswordBody` | success/rate-limit behavior. |
| `POST` | `/api/v1/auth/password/reset` | Complete password reset. | `ResetPasswordBody` | success or conflict/invalid token. |

### Authenticated Auth Routes

| Method | Path | Purpose | Body | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/api/v1/auth/mfa` | Read MFA status. | none | MFA status DTO. |
| `POST` | `/api/v1/auth/mfa/totp/setup` | Start TOTP setup. | none | secret/setup DTO. |
| `POST` | `/api/v1/auth/mfa/totp/confirm` | Confirm TOTP setup. | `TotpConfirmBody` | updated MFA state. |
| `POST` | `/api/v1/auth/mfa/step-up` | Start step-up challenge. | none | challenge DTO. |
| `POST` | `/api/v1/auth/mfa/step-up/verify` | Verify step-up challenge. | `MfaStepUpVerifyBody` | step-up success/session update. |
| `POST` | `/api/v1/auth/mfa/recovery-codes/regenerate` | Regenerate recovery codes. | `MfaRecoveryCodesRegenerateBody` | recovery codes. |
| `POST` | `/api/v1/auth/mfa/disable` | Disable MFA. | `MfaDisableBody` | updated MFA state. |

Frontend behavior:

1. Store access token in memory or a platform-secure client store.
2. For browser clients, preserve refresh cookie behavior where configured.
3. On `AUTH_REQUIRED` or 401, refresh once if the session has a refresh token.
4. On `TWO_FACTOR_REQUIRED`, launch MFA/step-up flow.
5. On restricted session, only call routes that explicitly allow restricted auth.

Restricted-session details beyond these rules are partially auth-flow specific.
UNVERIFIED — REQUIRES FOLLOW-UP: exact frontend screen copy for every restricted
session case belongs in V1-FE-05 or product UX.

## Current User And Workspace Selection

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/me` | Bearer | Current user/profile/session summary. |
| `PATCH` | `/api/v1/me` | Bearer | Update current user fields. |
| `GET` | `/api/v1/me/workspaces` | Bearer | Workspaces available to current user. |

Frontend sequence:

1. Authenticate.
2. Call `GET /api/v1/me`.
3. Call `GET /api/v1/me/workspaces`.
4. Let the user select a workspace from accessible workspaces.
5. Use `workspaceId` in workspace-scoped route paths.

Workspace routes require active workspace and active membership. Inactive
workspaces return `WORKSPACE_INACTIVE`. Missing/inactive memberships return
`WORKSPACE_MEMBERSHIP_REQUIRED` or a permission denial.

Permission discovery:

- Use `GET /api/v1/workspaces/:workspaceId/memberships/:membershipId/effective-access`
  when the signed-in actor has `staff.permissions.manage`.
- Otherwise, treat allowed UI actions as role/profile dependent and handle 403
  denials gracefully.
- Do not infer access from role name alone.

## Headers

| Header | Required when | Notes |
| --- | --- | --- |
| `Authorization: Bearer <token>` | All authenticated routes. | Global OpenAPI security is not enough to identify public exceptions. |
| `Content-Type: application/json` | JSON bodies. | All route body schemas are JSON. |
| `Idempotency-Key` | Idempotent command routes only. | Required by idempotency service when route uses it. |
| `x-support-session-id` | Support session context only. | Not in generated OpenAPI; resolved globally before route access. |

## Idempotency

When a route uses `container.idempotency.runInTransaction` or
`runInTransactionForActor`, the frontend must send `Idempotency-Key`.

Idempotency behavior:

- Missing key returns an idempotency required error.
- Reusing the same key with the same fingerprint can replay the stored response.
- Reusing the same key with a different request returns a mismatch error.
- A previous failed idempotent attempt requires a new key.
- Use a unique key per user action. Reuse only for retrying the exact same
  request after network uncertainty.

Known idempotent command groups include:

- workspace/staff invitation acceptance
- lead conversion, duplicate marking, merge, and owner activation flows
- commercial commands such as manual payment create, plan/version create, trial,
  plan changes, subscription transitions, payment approval/rejection
- trainee relationship lifecycle and assignment commands where route wrappers
  call the idempotency service
- training program activation and selected program/workout commands
- workout start/complete/abandon/correct/day skip/day defer
- nutrition plan activation and selected nutrition commands
- measurement create and selected progress commands
- check-in template revision, assignment, submit, review commands
- file upload intent/confirm/delete/restore/document upload/delete commands
- export request creation
- support access request/session/policy commands that call idempotency wrappers
- retention/deletion lifecycle commands that explicitly require idempotency

UNVERIFIED — REQUIRES FOLLOW-UP: V1-FE-03 does not enumerate every idempotent
route at per-endpoint granularity. V1-FE-05 or a route-by-route appendix should
derive the final list directly from route wrappers before frontend codegen.

## `expectedVersion`

Use `expectedVersion` when the request body schema includes it. It protects
mutations with a compare-and-swap check against the current document
`version`, `revision`, or membership `accessVersion`.

Frontend behavior:

1. Read the entity.
2. Store its version/revision/accessVersion.
3. Send that value as `expectedVersion` in the mutation body.
4. On version conflict, refetch the entity and ask the user to reapply changes.
5. Do not blindly retry a version conflict with the same body.

OpenAPI shows the field on many routes but does not explain which aggregate owns
the version. Use module docs and state reference for transition-specific meaning.

## Scope Rules

| Scope concern | Frontend rule |
| --- | --- |
| Workspace | Workspace id is a path parameter for workspace-scoped APIs. |
| Branch | Branch ids are branch resources, not just filters; managers can be narrowed to active assigned branches. |
| Relationship | `relationshipId` is the coaching relationship id. Keep it distinct from trainee user id. |
| Assigned trainee | Trainer, assistant trainer, and nutritionist visibility can derive from active assignments. |
| SELF | Trainee SELF means the trainee's own coaching relationship. |
| Support | Support session can act as read-only workspace support or as an effective tenant user. |

## Pagination

Common list query fields:

- `cursor`
- `limit`
- domain filters such as status, date range, unread, branch, category, or
  relationship-specific filters

Common list response:

```json
{
  "data": [],
  "meta": {
    "nextCursor": null,
    "hasMore": false
  }
}
```

Cursor semantics vary by module:

- ObjectId-style cursors for some library/list routes.
- Date/id cursors for audit, progress measurements/photos, notifications, and
  some analytics.
- Category-bound cursors for analytics attention/activity categories.

Do not decode cursors in the frontend. Treat cursors as opaque strings and keep
them bound to the same filters that produced them. V1-FE-06 owns the unified
cursor contract.

## Date, Time, And Timezone

Frontend summary:

- Timestamp fields are returned as ISO strings.
- Date-only local-day fields are used for daily tracking/check-ins/adherence.
- Analytics and dashboards depend on workspace-local time boundaries.
- Use `[from,to)` semantics when the API exposes range filters.
- Do not assume UTC calendar days are workspace calendar days.

UNVERIFIED — REQUIRES FOLLOW-UP: The complete DST/week/month bucket contract is
owned by V1-FE-07. This guide records the integration warning only.

## Empty, Forbidden, And Permission-Change States

| Situation | Frontend behavior |
| --- | --- |
| Empty list with 200 | Render empty state. Do not treat as permission denial. |
| 403 permission denial | Hide or disable action after reporting; refresh effective access if applicable. |
| Scope denial | Keep user in context and explain unavailable branch/relationship if UX has enough context. |
| Permission profile changed | Refetch current workspace/member/effective access and invalidate cached actions. |
| Inactive workspace | Stop workspace flows and show workspace unavailable. |
| Frozen/restricted subscription | Reads may still work; writes can fail with subscription/entitlement/quota errors. |
| Version conflict | Refetch and prompt user to reapply. |

## API Groups

The following tables cover every registered `/api/v1` API group from the locked
implementation. Request and response schemas are summarized for integration; use
fresh OpenAPI export for raw shape details, but use this guide for behavior.

### Health

| Method/path | Auth | Body | Response | Notes |
| --- | --- | --- | --- | --- |
| `GET /healthz` | none | none | health status | Liveness. |
| `GET /readyz` | none | none | readiness status | Calls container/database readiness. |

### Auth

Covered above in Authentication Flow. Response bodies include token, challenge,
success, MFA status, setup, and recovery-code DTOs. Errors include auth required,
invalid credentials, MFA required, restricted session, rate limits, verification
conflicts, and password reset conflicts.

### Me, Notifications, And Push Devices

| Method/path | Auth | Body/query | Response | Notes |
| --- | --- | --- | --- | --- |
| `GET /api/v1/me` | Bearer | none | current user/session DTO | First call after auth. |
| `PATCH /api/v1/me` | Bearer | update-me body | updated user DTO | Not generally idempotent. |
| `GET /api/v1/me/workspaces` | Bearer | none | accessible workspace list | Drives workspace picker. |
| `GET /api/v1/me/notifications` | Bearer | `cursor`, `limit`, `unread` | notification page | User-scoped. |
| `POST /api/v1/me/notifications/:notificationId/read` | Bearer | none | updated notification | Mark read. |
| `POST /api/v1/me/notifications/read-all` | Bearer | none | success/count | Mark all read. |
| `GET /api/v1/me/notification-preferences` | Bearer | none | preference DTO | Notification settings. |
| `PUT /api/v1/me/notification-preferences` | Bearer | preference body with `expectedVersion` | preference DTO | CAS applies. |
| `POST /api/v1/me/push-devices` | Bearer | push device registration | device DTO | Registers push endpoint/token. |
| `DELETE /api/v1/me/push-devices/:deviceId` | Bearer | none | success | Removes device. |

### Platform, Users, Workspaces, Branches, Staff

| Method/path family | Auth | Permission | Body/query | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| `POST /api/v1/platform/workspaces` | Bearer | `platform_workspaces.manage` | create workspace body | workspace DTO | Platform context. |
| `GET /api/v1/platform/memberships` | Bearer | `platform_users.read` | optional list filters | memberships | Platform users. |
| `POST /api/v1/platform/memberships` | Bearer | `platform_users.manage` | create platform membership | membership DTO | Platform admin. |
| `POST /api/v1/platform/memberships/:platformMembershipId/{suspend,reactivate,end}` | Bearer | `platform_users.manage` | none | membership DTO | Loop-registered commands. |
| `GET /api/v1/workspaces/:workspaceId` | Bearer | `workspace.read` | path id | workspace DTO | Active membership required. |
| `PATCH /api/v1/workspaces/:workspaceId` | Bearer | `workspace.update` | update body | workspace DTO | Workspace update. |
| `GET /api/v1/workspaces/:workspaceId/branches` | Bearer | `branches.read` | optional filters | branches | Branch scope can apply. |
| `GET/PATCH/POST archive /api/v1/workspaces/:workspaceId/branches/:branchId` | Bearer | `branches.read/update/archive` | path/body | branch DTO | Active branch constraints. |
| `POST /api/v1/workspaces/:workspaceId/branches` | Bearer | `branches.create` | create branch | branch DTO | Branch create. |
| `GET /api/v1/workspaces/:workspaceId/memberships` | Bearer | `staff.read` | list filters | staff memberships | Staff list. |
| `GET /api/v1/workspaces/:workspaceId/memberships/:membershipId` | Bearer | `staff.read` | path ids | membership DTO | Staff detail. |
| `POST /api/v1/workspaces/:workspaceId/memberships/:membershipId/{suspend,reactivate,end}` | Bearer | `staff.manage` | none | membership DTO | Workspace staff lifecycle. |
| `POST /api/v1/workspaces/:workspaceId/staff/invitations` | Bearer | `staff.invite` | invite body | invitation DTO | Quota/entitlement can deny. |
| `POST /api/v1/invitations/accept` | Bearer | invitation token/context | accept body | membership/session result | Uses idempotency wrapper. |
| `POST /api/v1/workspaces/:workspaceId/invitations/:invitationId/revoke` | Bearer | `staff.invites.revoke` | none | invitation DTO | Revoke staff invite. |
| `GET/POST/DELETE /api/v1/workspaces/:workspaceId/memberships/:membershipId/branches/:branchId` | Bearer | `staff.branches.manage` | path ids | assignment DTO/success | Branch assignment management. |

### Permissions

| Method/path family | Auth | Permission | Body/query | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| `GET /api/v1/permissions` | Bearer | authenticated | none | permission definitions | Does not require manage permission. |
| Workspace permission profile CRUD under `/workspaces/:workspaceId/permission-profiles` | Bearer | `staff.permissions.manage` | profile bodies, `expectedVersion` for update/archive | profile DTOs | Manage workspace profiles. |
| Workspace membership profile/access replacement under `/workspaces/:workspaceId/memberships/:membershipId/...` | Bearer | `staff.permissions.manage` | profile ids or grants plus `expectedVersion` | access DTO | CAS uses accessVersion. |
| Platform permission profile CRUD under `/platform/permission-profiles` | Bearer | `platform_permissions.manage` | profile bodies, `expectedVersion` | profile DTOs | Platform profiles. |
| Platform membership profile/access replacement under `/platform/memberships/:membershipId/...` | Bearer | `platform_permissions.manage` | profile ids or grants plus `expectedVersion` | access DTO | Platform access. |

Do not use this module alone to infer whether the current user can act. Use
effective access where permitted and handle 403 denials.

### Commercial: Subscriptions, Plans, Payments, Entitlements

| Method/path family | Auth | Permission | Body/query | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| Workspace billing read routes under `/workspaces/:workspaceId/billing/...` | Bearer | `billing.subscription.read`, `billing.usage.read`, `billing.payments.read` | path/list params | billing DTOs | Workspace context. |
| `POST /api/v1/workspaces/:workspaceId/billing/payments` | Bearer | `billing.payments.create` | payment body | payment DTO | Idempotent; subscription/payment validation applies. |
| Platform plan routes under `/platform/subscription-plans` | Bearer | `plans.*` | create/update/archive/version bodies | plan/version DTOs | Platform admin. |
| Platform subscription routes under `/platform/workspaces/:workspaceId/subscription/...` | Bearer | `subscriptions.*` | `expectedVersion`, plan/version/terms bodies | subscription DTO | Trial, upgrade, downgrade, freeze, reactivate, cancel. |
| Platform payments under `/platform/payments` | Bearer | `payments.*` | approval/rejection bodies | payment DTOs | Payment approval/rejection idempotent. |

Quota/entitlement failures are not permission failures. Frontend should show plan
or workspace billing guidance when errors indicate quota, feature unavailable,
subscription frozen, or entitlement denial.

### Leads And Owner Activation

| Method/path | Auth | Body/query | Response | Notes |
| --- | --- | --- | --- | --- |
| `POST /api/v1/leads` | public | public lead body | lead DTO | Public lead creation. |
| `GET /api/v1/platform/leads` | Bearer platform | lead filters/cursor | lead page | `leads.read`. |
| `GET /api/v1/platform/leads/:leadId` | Bearer platform | path id | lead DTO | `leads.read`. |
| `PATCH /api/v1/platform/leads/:leadId` | Bearer platform | update body with `expectedVersion` | lead DTO | `leads.update`. |
| `POST /api/v1/platform/leads/:leadId/status` | Bearer platform | status body with `expectedVersion` | lead DTO | Lifecycle update. |
| `POST /api/v1/platform/leads/:leadId/convert` | Bearer platform | conversion body with `expectedVersion` | conversion DTO | Creates workspace/owner/subscription intent. |
| `POST /api/v1/platform/leads/:leadId/mark-duplicate` | Bearer platform | duplicate body with `expectedVersion` | lead DTO | Idempotent. |
| `POST /api/v1/platform/leads/:leadId/merge` | Bearer platform | merge body with `expectedVersion` | lead DTO | Idempotent. |
| `POST /api/v1/owner-activations/complete` | public token | activation body | owner/workspace/session result | Public token-scoped activation. |

### Trainee Relationships

| Method/path family | Auth | Permission | Body/query | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/relationships` | Bearer | `trainees.read` | filters, cursor, branch/assignment context | relationship page | Query access scopes apply. |
| `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId` | Bearer | `trainees.read` | path ids | relationship DTO | `relationshipId != trainee userId`. |
| `POST /api/v1/workspaces/:workspaceId/trainees/invitations` | Bearer | `trainees.invite` | invite body | invitation/relationship DTO | Quota/eligibility applies. |
| `POST /api/v1/trainee-invitations/:invitationId/accept` | Bearer | route/service eligibility | accept body | relationship DTO | Idempotent. |
| `POST /api/v1/trainee-referrals/:referralId/join` | Bearer/public-token context | referral join body | relationship DTO | Referral join. |
| Relationship lifecycle commands `/accept`, `/reject`, `/end`, `/reactivate` | Bearer | `trainees.accept/reject/end/reactivate` | `expectedVersion` body | relationship DTO | CAS/lifecycle checks. |
| Assignment commands home branch, primary trainer, assistant trainer, nutritionist | Bearer | `trainees.assignments.*.manage` | assignment bodies with `expectedVersion` | relationship DTO | Staff/branch eligibility. |
| `POST /api/v1/workspaces/:workspaceId/trainee-migrations` | Bearer | migration permissions | migration body | migration result | In/out migration permissions apply. |

### Training

| Method/path family | Auth | Permission | Body/query | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| Workspace exercises `/workspaces/:workspaceId/exercises` | Bearer | `exercises.*` | list/create/update/archive bodies | exercise DTOs/pages | Gym/private exercise behavior. |
| Platform exercises `/platform/exercises` | Bearer platform | `system_exercises.*` | list/create/update/archive bodies | system exercise DTOs | Platform context. |
| Program templates `/workspaces/:workspaceId/program-templates` | Bearer | `program_templates.*` | template bodies, `expectedVersion` | template DTOs/pages | Immutable revisions. |
| Programs `/workspaces/:workspaceId/relationships/:relationshipId/programs` | Bearer | `programs.*` | program create/revise/activate/complete/archive bodies | program DTOs/pages | Relationship scoped. |
| `GET /api/v1/workspaces/:workspaceId/programs/:programId/progress` | Bearer | `programs.read` | path ids | progress DTO | Program progress read. |

Training writes can fail on entitlement, archived/private exercise constraints,
relationship state, expectedVersion conflict, or lifecycle conflict.

### Workouts And PRs

| Method/path family | Auth | Permission | Body/query | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| `POST /relationships/:relationshipId/workouts/start` | Bearer | `workouts.create` | none/body as schema | workout DTO | Idempotent. |
| Current/list workout reads | Bearer | `workouts.read` | cursor/limit | workout DTO/page | Relationship scoped. |
| Workout patch/complete/abandon/correct | Bearer | `workouts.update/complete/abandon/correct` | bodies with `expectedVersion` | workout DTO | CAS/status checks. |
| Program progress skip/defer | Bearer | `workouts.day.skip/defer` | command body with `expectedVersion` | progress DTO | Current day rules. |
| Personal records/PR events | Bearer | `personal_records.read` | list filters | PR page | Read-only frontend list. |

### Nutrition

| Method/path family | Auth | Permission | Body/query | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| Workspace foods `/workspaces/:workspaceId/foods` | Bearer | `foods.*` | list/create/update/archive bodies | food DTOs/pages | Gym/private food behavior. |
| Platform foods `/platform/foods` | Bearer platform | `system_foods.*` | list/create/update/archive bodies | system food DTOs | Platform context. |
| Nutrition plans `/relationships/:relationshipId/nutrition-plans` | Bearer | `nutrition.plans.*` | create/revise/activate/complete/archive bodies | plan DTOs/pages | Relationship scoped. |

Nutrition writes can fail on entitlement, archived food constraints, responsible
member eligibility, relationship state, or expectedVersion conflict.

### Progress, Health, Notes, Adherence

| Method/path family | Auth | Permission | Body/query | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| Metric definitions `/workspaces/:workspaceId/metric-definitions` | Bearer | `metric_definitions.*` | list/create/update/archive bodies | metric DTOs/pages | Workspace scoped. |
| Measurements `/relationships/:relationshipId/measurements` | Bearer | `measurements.*` | list/create/update bodies | measurement DTOs/pages | Some cursors are date/id. |
| Progress photos `/relationships/:relationshipId/progress-photos` | Bearer | `progress_photos.read` | list query | photo metadata page | File download is separate. |
| Health profile `/relationships/:relationshipId/health-profile` | Bearer | `health.read/update` | get/put body | health DTO | Sensitive/support-sensitive. |
| Notes `/relationships/:relationshipId/notes` | Bearer | `notes.*` | list/create/update/archive bodies | note DTOs/pages | Visibility rules apply. |
| Adherence config/tracking `/relationships/:relationshipId/adherence...` | Bearer | `adherence.*` | config/tracking bodies | adherence DTOs | Workspace-local dates. |

Sensitive reads can write audit evidence and can fail closed if sensitive audit
cannot be written.

### Check-ins

| Method/path family | Auth | Permission | Body/query | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| Templates `/workspaces/:workspaceId/check-in-templates` | Bearer | `checkins.templates.*` | list/create/revise/archive bodies | template DTOs/pages | Revision pattern. |
| Assignments `/relationships/:relationshipId/check-in-assignments` | Bearer | `checkins.assignments.*`, `checkins.assign` | list/assign/update/end bodies | assignment DTOs/pages | Relationship scoped. |
| Instances `/relationships/:relationshipId/check-ins` | Bearer | `checkins.read/submit/review` | list/detail/submit/review bodies | instance DTOs/pages | Submit SELF; review staff. |

Check-in reads are sensitive in support context. Submit/review requires
`expectedVersion` and valid lifecycle state.

### Files And Documents

| Method/path family | Auth | Permission | Body/query | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| Upload intents `/workspaces/:workspaceId/files/upload-intents` | Bearer | `documents.upload` or medical/upload-specific service permission | intent/confirm bodies | upload intent/file DTO | Idempotent; object storage step occurs outside API. |
| File download/delete/restore `/files/:fileId/...` | Bearer | `files.download/delete/restore` or medical document mapping | command bodies with `expectedVersion` where required | signed URL/file DTO | Sensitive file support gate applies. |
| Documents `/relationships/:relationshipId/documents` | Bearer | `documents.*`, `medical_documents.*` | list/create/get/delete bodies | document DTOs/pages | Relationship scoped. |

Frontend file lifecycle summary:

1. Create upload intent.
2. Upload object to returned storage URL.
3. Confirm upload intent with checksum/version data.
4. Create or read document metadata.
5. Request download URL when needed.
6. Delete/restore with expectedVersion where schema requires it.

V1-FE-08 owns the complete file contract.

### Exports, Retention, Deletion

| Method/path family | Auth | Permission | Body/query | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| Workspace exports `/workspaces/:workspaceId/exports` | Bearer | `exports.workspace.*` | create/list/detail/download-url | export DTOs/pages | Support context forbidden. |
| Platform deletion requests `/platform/workspace-deletions` | Bearer platform | `deletion.*` | list/detail/approve/postpone/cancel bodies | deletion DTOs/pages | Retention/deletion lifecycle. |

Exports are asynchronous; frontend should poll/list for status and request a
download URL when ready. Deletion lifecycle commands use expectedVersion and can
be restricted by lifecycle state.

### Support Access

| Method/path family | Auth | Permission | Body/query | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| Policies `/platform/support/policies` | Bearer platform | `support.policies.*` | list/create/get/update/disable/archive bodies | policy DTOs | expectedVersion/revision applies. |
| Access request `/platform/support/access-requests` | Bearer platform | `support.sessions.start` | request body | session/request DTO | Starts support context. |
| Sessions `/platform/support/sessions/:sessionId` | Bearer platform | `support.sessions.*` | get/end/revoke bodies | session DTO | expiry/revoke/end states. |

To use support context on other module routes, send `x-support-session-id`.

Support modes:

- `WORKSPACE_SUPPORT`: read-only whitelisted permissions.
- `USER_CONTEXT`: uses effective active workspace membership and support-sensitive
  gates.

V1-FE-10 owns the full support frontend guide.

### Audit

| Method/path | Auth | Permission | Query | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/audit` | Bearer | `audit.workspace.read` | audit filters, cursor, limit | audit event page | Workspace audit. |
| `GET /api/v1/platform/audit` | Bearer platform | `audit.platform.read` | audit filters, cursor, limit | audit event page | Platform audit. |

Sensitive audit details can be redacted unless the actor has sensitive audit
access. Cursor details are owned by V1-FE-06.

### Dashboards And Analytics

| Method/path family | Auth | Permission | Query | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| `GET /workspaces/:workspaceId/dashboard/trainer` | Bearer | `dashboard.trainer.read` | date/range/category cursors | dashboard DTO | Support-sensitive. |
| `GET /workspaces/:workspaceId/dashboard/gym` | Bearer | `dashboard.gym.read` | branch/range/cursors | dashboard DTO | Branch/multi-branch scope. |
| `GET /relationships/:relationshipId/dashboard` | Bearer | `dashboard.relationship.read` | range | dashboard DTO | Relationship scoped/support-sensitive. |
| Relationship analytics training/progress/nutrition/adherence | Bearer | `analytics.*.read` | range, cursor, limit | analytics DTO/page | Relationship scoped. |

Dashboard/analytics frontend notes:

- Empty sections are valid 200 responses.
- Some dashboard categories have independent cursors.
- Workspace-local date ranges matter for buckets.
- Support context can require `support.sensitive.read`.

## Minimal Examples

### Authenticated GET

```http
GET /api/v1/me HTTP/1.1
Authorization: Bearer <accessToken>
```

### Idempotent Command

```http
POST /api/v1/workspaces/64f000000000000000000001/relationships/64f000000000000000000002/workouts/start HTTP/1.1
Authorization: Bearer <accessToken>
Content-Type: application/json
Idempotency-Key: 2fd5dc50-5f0c-49f5-9a9d-7f8978243c64

{}
```

### Versioned Mutation

```json
{
  "expectedVersion": 3,
  "reason": "user requested change"
}
```

### Support Context Read

```http
GET /api/v1/workspaces/64f000000000000000000001/dashboard/gym HTTP/1.1
Authorization: Bearer <platformSupportAccessToken>
x-support-session-id: 64f0000000000000000000aa
```

## Follow-Up Ownership

| Future issue | Owns |
| --- | --- |
| V1-FE-04 | Screen/feature to API sequence mapping. |
| V1-FE-05 | Full frontend error and UX response catalog. |
| V1-FE-06 | Cursor and pagination semantics for every paginated route. |
| V1-FE-07 | Time, date, timezone, DST, and analytics bucket contract. |
| V1-FE-08 | Complete file/document upload/download lifecycle. |
| V1-FE-09 | Notification lifecycle and polling/refresh expectations. |
| V1-FE-10 | Complete support access frontend contract. |

## Locked-Stage Protection

- No Stage 2-18 implementation was modified.
- No routes, schemas, permissions, services, migrations, tests, OpenAPI
  artifacts, or configuration were changed.
- OpenAPI gaps are documented rather than fixed.
- Any unverified product/UX-level behavior is explicitly marked
  `UNVERIFIED — REQUIRES FOLLOW-UP`.
