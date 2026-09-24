# V1 Frontend Error and UX Response Catalog

Issue: V1-FE-05 / GitHub #10

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Backend root inspected: `apps/backend`

## Source Of Truth

The locked Stage 18 backend implementation is authoritative over generated
OpenAPI, previous summaries, and this catalog. Route files, schemas, services,
repositories, access-control code, tests, migrations, and existing V1 docs win
when they disagree with generated artifacts.

This document is frontend-facing. It describes how the frontend should classify
and respond to backend errors. It does not change error codes, schemas, handlers,
routes, services, permissions, migrations, tests, or runtime behavior.

## Evidence Used

- `src/core/errors/app-error.ts`
- `src/core/errors/error-handler.ts`
- `src/core/idempotency/idempotency.service.ts`
- `src/modules/auth/auth.middleware.ts`
- `src/modules/auth/auth.service.ts`
- `src/core/access-control/access-control.service.ts`
- `src/modules/support-access/support-access.service.ts`
- `src/modules/subscriptions/subscription.service.ts`
- `src/modules/subscriptions/subscription.repository.ts`
- representative module service/repository error helpers under `src/modules/**`
- `docs/v1/frontend-api-integration-guide.md`
- `docs/v1/frontend-feature-api-map.md`
- `docs/v1/permission-access-matrix.md`

## Error Shape

All `AppError` responses use the centralized shape:

```json
{
  "error": {
    "code": "SOME_CODE",
    "message": "Human readable message",
    "details": {},
    "correlationId": "request-correlation-id"
  }
}
```

`details` is optional. The frontend should always log or attach
`correlationId` to support/error reports. Do not parse `message` for logic; use
`code` and HTTP status.

Fastify schema validation errors are serialized as:

| Code | HTTP | When it occurs | Meaning | Frontend behavior | Retry | User action |
| --- | --- | --- | --- | --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Request params, query, or body fail route schema validation. | Client submitted an invalid shape or type. | Highlight invalid form/request fields when details are usable; otherwise show generic invalid request. | No, until request is corrected. | Correct input or client payload. |
| `INTERNAL_ERROR` | 500 | Unhandled backend error. | Unexpected server failure. | Show generic failure and capture correlation id. | Yes, after short delay or manual retry. | Retry later or contact support with correlation id. |

## Global UX Rules

- 400 usually means client/request shape problem. Do not auto-retry unchanged.
- 401 means authentication/session problem. Try one refresh where possible, then
  send the user to login.
- 403 means authenticated but not allowed, or business access is denied. Do not
  repeat automatically unless the user changes role/workspace/support context.
- 404 means the resource is absent or intentionally hidden as not found. Refresh
  parent lists and leave the detail screen.
- 409 means state changed, lifecycle conflict, idempotency conflict, or
  `expectedVersion` mismatch. Refetch before retrying.
- 422 means domain input is semantically invalid. Show field/domain guidance.
- 429 means rate-limited. Respect cooldown UX; do not retry immediately.

## Authentication And Session

| Code | HTTP | When it occurs | Meaning | Frontend behavior | Retry | User action |
| --- | --- | --- | --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | Missing/invalid bearer token, missing active session, or auth required by idempotency context. | User is not authenticated for this request. | Attempt one refresh if refresh credential exists; otherwise route to login. | Yes, once after refresh. | Log in again. |
| `AUTH_TOKEN_EXPIRED` | 401 | JWT verification reports expired token. | Access token expired. | Refresh once, then retry original request. | Yes, after refresh. | Log in if refresh fails. |
| `AUTH_TOKEN_INVALID` | 401 | JWT verification fails for reasons other than expiry. | Access token cannot be trusted. | Clear auth state and route to login. | No. | Log in again. |
| `REFRESH_TOKEN_INVALID` | 401 | Refresh token missing, invalid, revoked, or unusable. | Session cannot be refreshed. | Clear auth state and route to login. | No. | Log in again. |
| `REFRESH_TOKEN_REUSE_DETECTED` | 401 | Refresh token rotation detects reuse. | Session may be compromised or stale. | Clear all local auth state and force login. | No. | Log in again; product may warn user. |
| `AUTH_SESSION_RESTRICTED` | 403 | Restricted session calls a route that does not allow restricted auth. | Account/session must complete required verification. | Route user to verification flow or block restricted action. | No. | Verify login identifier. |
| `TWO_FACTOR_REQUIRED` | 403 | Platform or sensitive action requires MFA satisfaction. | User needs MFA/step-up. | Launch MFA/step-up flow, then retry user action after success. | Yes, after MFA. | Complete MFA. |
| `INVALID_CREDENTIALS` | 401 | Login identifiers/password/code invalid. | Authentication failed. | Show invalid credentials without confirming which field exists. | No. | Re-enter credentials. |
| `AUTH_RATE_LIMITED` | 429 | Auth flow rate limiting. | Too many attempts. | Show cooldown/rate-limit state. | Later only. | Wait before retry. |
| `AUTH_IDENTIFIER_REQUIRED`, `AUTH_IDENTIFIER_INVALID`, `INVALID_PHONE_NUMBER` | 400/422 | Login/register/identifier normalization rejects missing or malformed identifier. | Identifier is missing or malformed. | Show field-level validation. | No. | Correct identifier. |
| `AUTH_IDENTIFIER_CONFLICT` | 409 | Email/phone or identity uniqueness conflict. | Identifier already belongs to another user/identity. | Show conflict state. | No. | Use another identifier or sign in. |
| `MFA_SETUP_REQUIRED`, `MFA_NOT_CONFIGURED`, `MFA_ALREADY_CONFIGURED`, `MFA_CODE_INVALID`, `MFA_CHALLENGE_INVALID`, `AUTH_CHALLENGE_INVALID`, `AUTH_CHALLENGE_NOT_VERIFIABLE` | 401/403/409 | MFA setup/login/step-up state is invalid for request. | MFA state is missing, stale, or incorrect. | Restart MFA step or show invalid code depending code. | Usually no; restart challenge if stale. | Enter valid MFA code or restart setup. |
| `AUTH_RESET_TOKEN_INVALID` | 401/409 | Password reset token invalid or expired. | Reset link cannot be used. | Show reset-link expired/invalid. | No. | Request new reset link. |
| `AUTH_ORIGIN_REQUIRED`, `AUTH_ORIGIN_DENIED` | 403 | Refresh/cookie origin enforcement denies request. | Client origin is not allowed for refresh-cookie flow. | Surface session failure; capture correlation id. | No from same origin. | Use allowed client/origin. |

## Authorization, Scope, Workspace, And Permission

| Code | HTTP | When it occurs | Meaning | Frontend behavior | Retry | User action |
| --- | --- | --- | --- | --- | --- | --- |
| `PERMISSION_DENIED` | 403 | Access-control or module service denies permission. | Actor lacks permission in current context. | Hide/disable action after denial; refresh access if permission state may have changed. | No, unless access changed. | Ask admin for access. |
| `PERMISSION_UNKNOWN` | 403/422 | Unknown permission key reaches access-control/permissions service. | Client or docs used an invalid permission key. | Treat as integration bug and log with correlation id. | No. | None; developer fix. |
| `SCOPE_DENIED` | 403 | Permission exists but requested scope/resource is not allowed. | Actor cannot access requested branch/relationship/resource. | Keep user in current context and explain unavailable scope if known; refresh list. | No. | Choose allowed branch/relationship. |
| `SCOPE_RESOURCE_REQUIRED` | 403/422 | Scoped permission needs resource ids but request lacks them. | Scope request is incomplete. | Treat as client integration bug or validation feedback. | No. | Select required resource. |
| `SCOPE_RESOURCE_NOT_FOUND` | 404 | Scope resource id is invalid/not found. | Branch/relationship/scope resource is absent or not in workspace. | Refresh parent lists and clear stale selection. | No. | Select valid resource. |
| `SCOPE_RESOURCE_LIMIT_EXCEEDED` | 403/422 | Too many branch/specific-trainee resource ids in access query. | Request exceeds access-control limits. | Reduce query resource count. | No. | Narrow filters. |
| `PLATFORM_MEMBERSHIP_REQUIRED`, `WORKSPACE_MEMBERSHIP_REQUIRED` | 403 | Actor lacks active membership for context. | User cannot access platform/workspace. | Remove context from available switcher after refresh. | No. | Ask admin for membership. |
| `PLATFORM_MEMBERSHIP_NOT_FOUND`, `WORKSPACE_MEMBERSHIP_NOT_FOUND` | 404 | Membership id missing/stale/not found. | Target membership no longer exists or is hidden. | Refresh membership list; leave detail page. | No. | Select current membership. |
| `WORKSPACE_INACTIVE` | 409 | Workspace exists but is not active. | Workspace cannot be used for normal flows. | Stop workspace flows; show workspace inactive/unavailable. | No. | Switch workspace or contact admin/support. |
| `WORKSPACE_NOT_FOUND`, `BRANCH_NOT_FOUND`, `RELATIONSHIP_NOT_FOUND`, `USER_NOT_FOUND` | 404 | Path/body id is invalid, absent, or hidden. | Resource is unavailable. | Refresh parent list and leave stale detail. | No. | Select valid resource. |
| `DELEGATION_DENIED` | 403 | Permission grant/profile delegation is not allowed. | Actor cannot delegate requested permission/scope. | Show permission management denial. | No. | Use an authorized admin. |
| `PERMISSION_CONTEXT_INVALID`, `PERMISSION_SCOPE_INVALID`, `PERMISSION_SCOPE_RESOURCE_INVALID`, `PERMISSION_SCOPE_RESOURCE_REQUIRED` | 422 | Permission profile/grant body uses invalid context/scope/resources. | Permission configuration is semantically invalid. | Show field/domain validation in permission UI. | No. | Correct scope/profile payload. |
| `PERMISSION_PROFILE_DUPLICATE`, `PERMISSION_PROFILE_ARCHIVE_INVALID`, `PERMISSION_PROFILE_PERMISSION_DUPLICATE`, `ACCESS_GRANT_DUPLICATE` | 409 | Profile/access mutation conflicts with existing state. | Permission profile/access command cannot apply as sent. | Refetch profiles/member access before retry. | After refetch only. | Resolve duplicate or state conflict. |
| `PERMISSION_PROFILE_VERSION_CONFLICT`, `WORKSPACE_MEMBERSHIP_ACCESS_VERSION_CONFLICT`, `PLATFORM_MEMBERSHIP_ACCESS_VERSION_CONFLICT` | 409 | `expectedVersion`/`accessVersion` is stale. | Permission/access state changed. | Refetch latest access/profile version and ask user to reapply. | After refetch only. | Reapply changes. |

## Idempotency

These codes are emitted only on routes that call the idempotency service. The
frontend must not infer idempotency solely from OpenAPI.

| Code | HTTP | When it occurs | Meaning | Frontend behavior | Retry | User action |
| --- | --- | --- | --- | --- | --- | --- |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Idempotent command route receives no non-blank `Idempotency-Key`. | Required idempotency header missing. | Treat as client integration bug; generate a key for command routes. | Retry with a generated key. | Retry action after client fix. |
| `IDEMPOTENCY_ACTOR_REQUIRED` | 401 | Actor-scoped idempotent command lacks actor id. | Command cannot associate idempotency to actor. | Treat like auth/session failure. | After auth context is restored. | Log in/retry. |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same actor/route/key used with a different request fingerprint. | Key was reused for a different command payload. | Do not retry with same key. Generate a new key only if user intentionally starts a new command. | No for same command. | Confirm and submit again as a new action if desired. |
| `IDEMPOTENCY_REQUEST_IN_PROGRESS` | 409 | Original request with same key is still processing. | Backend has not completed first attempt. | Keep pending state; poll/read resource or retry same request later with same key. | Yes, same key after delay. | Wait. |
| `IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED` | 409 | Previous attempt with same key failed. | Stored idempotent attempt cannot replay success. | Stop retry loop. Use new key only for deliberate new attempt. | Not with same key. | Retry action as new attempt. |
| `IDEMPOTENCY_CONFLICT` | 409 | Idempotency record disappeared/changed during resolution. | Command state changed unexpectedly. | Retry same command with same key once after short delay; capture correlation id if repeated. | Yes, same key once. | Wait/retry. |
| `IDEMPOTENCY_COMPLETION_CONFLICT` | 409 | Processing record changed before completion write. | Backend command state changed during completion. | Refetch resource state; do not blindly resubmit. | After refetch only. | Review resulting state. |

Successful idempotency replay returns the stored original response; it is not an
error. The frontend should treat replayed success as success.

## Concurrency And `expectedVersion`

All version conflicts use 409. The code identifies the aggregate or command.

| Code family | HTTP | When it occurs | Meaning | Frontend behavior | Retry | User action |
| --- | --- | --- | --- | --- | --- | --- |
| `*_VERSION_CONFLICT` | 409 | Request body `expectedVersion`/revision/accessVersion is stale. Examples: `COACHING_RELATIONSHIP_VERSION_CONFLICT`, `PROGRAM_VERSION_CONFLICT`, `WORKOUT_*`, `NUTRITION_PLAN_VERSION_CONFLICT`, `CHECKIN_*_VERSION_CONFLICT`, `FILE_VERSION_CONFLICT`, `DOCUMENT_VERSION_CONFLICT`, `SUBSCRIPTION_VERSION_CONFLICT`, `SUPPORT_*_VERSION_CONFLICT`, `WORKSPACE_DELETION_VERSION_CONFLICT`. | Resource changed since frontend read it. | Refetch latest entity, show conflict/reapply UX, and submit with new version only after user confirms. | Not automatically with stale body. | Reapply changes. |
| `*_REVISION_CONFLICT` | 409 | Revisioned template/plan/program command collides with existing revision. | Revision already changed or duplicate revision exists. | Refetch revision list/detail and ask user to reapply. | After refetch only. | Reapply changes. |
| `*_CONFLICT` | 409 | Domain uniqueness/state conflict. Examples: `BRANCH_CODE_CONFLICT`, `FOOD_NAME_CONFLICT`, `EXERCISE_NAME_CONFLICT`, `ACTIVE_PROGRAM_CONFLICT`, `ACTIVE_NUTRITION_PLAN_CONFLICT`, `WORKOUT_ALREADY_IN_PROGRESS`. | Command conflicts with existing active/unique state. | Show domain-specific conflict and refresh related list/detail. | Usually no; after user changes input/state. | Resolve duplicate/active-state conflict. |

## Validation And Domain Input

| Code family | HTTP | When it occurs | Meaning | Frontend behavior | Retry | User action |
| --- | --- | --- | --- | --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Route schema rejects request. | Payload/query/path shape is invalid. | Show field errors when possible; otherwise generic invalid request. | No. | Correct request/input. |
| `*_REQUIRED` | 400/422 | Domain-required field missing. Examples: `AUTH_IDENTIFIER_REQUIRED`, `PRIMARY_TRAINER_REQUIRED`, `FILE_NAME_REQUIRED`, `SUBJECT_REQUIRED`, `SUPPORT_REASON_REQUIRED`, `DESTINATION_RELATIONSHIP_VERSION_REQUIRED`. | User/client omitted required domain value. | Show field-level required validation. | No. | Fill missing field. |
| `*_INVALID` | 400/409/422 | Domain input or transition invalid. Examples: `CHECKIN_RECURRENCE_INVALID`, `DAILY_TRACKING_DATE_INVALID`, `LEAD_INVALID_TRANSITION`, `SUBSCRIPTION_TRIAL_INVALID`, `WORKSPACE_DELETION_INVALID_TRANSITION`. | Command cannot be applied with supplied values/state. | Show domain-specific correction. Refresh state if lifecycle-related. | No, unless state refreshed and input changed. | Correct input or choose valid transition. |
| `*_UNSUPPORTED` | 422 | Backend explicitly does not support requested option. Examples: `HOME_BRANCH_UNSUPPORTED`, `ACTIVE_PROGRAM_TOPOLOGY_CHANGE_UNSUPPORTED`, `SUBSCRIPTION_EFFECTIVE_FROM_UNSUPPORTED`. | Product/backend does not support that request path. | Hide unsupported control if possible; show unavailable action. | No. | Choose supported option. |
| `CURSOR_INVALID` | 422 | Cursor cannot be decoded or no longer matches expected list context. | Pagination cursor is invalid/stale. | Reset list pagination to first page with same filters. | Yes, from first page. | None. |
| `AUDIT_DATE_RANGE_INVALID`, `CHECKIN_TIMEZONE_INVALID`, `DAILY_TRACKING_DATE_INVALID` | 422 | Date/time/range/timezone input invalid. | Calendar/range input does not satisfy backend rules. | Show date/range validation. | No. | Correct date/range/timezone. |

## Not Found

| Code family | HTTP | When it occurs | Meaning | Frontend behavior | Retry | User action |
| --- | --- | --- | --- | --- | --- | --- |
| `*_NOT_FOUND` | 404 | Requested resource id is invalid, absent, no longer in scope, or hidden. Examples: `WORKSPACE_NOT_FOUND`, `RELATIONSHIP_NOT_FOUND`, `PROGRAM_NOT_FOUND`, `WORKOUT_NOT_FOUND`, `FILE_NOT_FOUND`, `EXPORT_NOT_FOUND`, `SUPPORT_SESSION_NOT_FOUND`. | Resource is unavailable in current context. | Leave detail view, refresh parent list, and show missing/unavailable state. | No, unless resource may be created asynchronously. | Select an existing item. |
| `REFERRAL_CODE_NOT_FOUND` | 404 | Trainee referral join code is invalid/absent. | Referral cannot be joined. | Show invalid referral state. | No. | Ask for valid referral. |
| `UPLOAD_OBJECT_NOT_FOUND` | 404 | Confirming upload cannot find object in storage. | External object upload did not complete where expected. | Keep upload as failed/pending; ask user to upload again. | Yes, after re-upload. | Re-upload file. |

## Quota, Entitlement, Subscription, And Billing

| Code | HTTP | When it occurs | Meaning | Frontend behavior | Retry | User action |
| --- | --- | --- | --- | --- | --- | --- |
| `FEATURE_NOT_AVAILABLE` | 403 | Entitlement check denies feature not enabled in current terms. | Plan does not include feature. | Show plan/feature unavailable state. | No. | Upgrade/change plan or disable feature. |
| `SUBSCRIPTION_FROZEN` | 403 | Entitlement check denies write/action because lifecycle only allows read or action is blocked. | Workspace subscription state prevents action. | Show frozen/subscription-blocked state; avoid repeating write. | No until subscription changes. | Resolve billing/subscription. |
| `STORAGE_LIMIT_EXCEEDED` | 403 | Storage quota missing/exceeded or storage unavailable. | Upload/storage quota reached. | Block upload and show storage quota message. | No until quota changes or smaller file. | Free storage/upgrade/reduce file. |
| `TRAINEE_LIMIT_EXCEEDED`, `STAFF_LIMIT_EXCEEDED` | 403 | Usage reservation for active trainee/staff exceeds plan limit. | Seat/relationship quota reached. | Block activation/invite and show quota guidance. | No until quota changes. | Upgrade or deactivate another user/relationship. |
| `STORAGE_ACCOUNTING_CONFLICT`, `TRAINEE_USAGE_RELEASE_INVALID`, `WORKSPACE_USAGE_NOT_FOUND` | 403/409/404 | Usage accounting state is missing or changed. | Billing/usage state needs refresh or backend support. | Refetch billing/usage; capture correlation id if repeated. | After refresh only. | Retry or contact support. |
| `SUBSCRIPTION_NOT_FOUND`, `SUBSCRIPTION_PLAN_NOT_FOUND`, `SUBSCRIPTION_PLAN_VERSION_NOT_FOUND`, `PAYMENT_NOT_FOUND` | 404 | Commercial resource missing/stale. | Billing resource is unavailable. | Refresh billing/payment/plan lists. | No. | Select current resource. |
| `SUBSCRIPTION_PLAN_KEY_CONFLICT`, `SUBSCRIPTION_PLAN_VERSION_CONFLICT`, `SUBSCRIPTION_VERSION_CONFLICT`, `PAYMENT_REVIEW_CONFLICT` | 409 | Plan/subscription/payment state changed or conflicts. | Commercial command cannot apply as sent. | Refetch commercial resource and ask user to reapply. | After refetch only. | Reapply with latest version/state. |

## Lifecycle And State Conflicts

| Code family | HTTP | When it occurs | Meaning | Frontend behavior | Retry | User action |
| --- | --- | --- | --- | --- | --- | --- |
| Relationship lifecycle codes such as `COACHING_RELATIONSHIP_STATUS_INVALID`, `RELATIONSHIP_NOT_ACTIVE`, `RELATIONSHIP_NOT_PROGRESS_OPEN`, `RELATIONSHIP_NOT_NUTRITION_OPEN` | 409/422 | Relationship action incompatible with current relationship status. | Relationship lifecycle has moved or domain is closed. | Refresh relationship detail and disable invalid action. | After refresh only. | Choose valid action for current status. |
| Training/workout lifecycle codes such as `PROGRAM_NOT_ACTIVE`, `PROGRAM_DAY_NOT_CURRENT`, `PROGRAM_DAY_NOT_EXECUTABLE`, `WORKOUT_ALREADY_COMPLETED`, `WORKOUT_ABANDONED`, `WORKOUT_NOT_IN_PROGRESS` | 409/422 | Program/workout command incompatible with current state. | Workout/program state changed or selected day is invalid. | Refresh workout/program progress and update controls. | After refresh only. | Continue from current state. |
| Nutrition lifecycle codes such as `NUTRITION_PLAN_STATUS_INVALID`, `ACTIVE_NUTRITION_PLAN_CONFLICT`, `FOOD_ARCHIVED` | 409/422 | Nutrition plan/food state prevents command. | Selected item or plan state is invalid. | Refresh nutrition plan/food list and disable invalid action. | After refresh/input change. | Pick active item or resolve active plan. |
| Check-in lifecycle codes such as `CHECKIN_NOT_SUBMITTABLE`, `CHECKIN_NOT_REVIEWABLE`, `CHECKIN_ALREADY_SUBMITTED`, `CHECKIN_ALREADY_REVIEWED`, `CHECKIN_ASSIGNMENT_INACTIVE` | 409/422 | Check-in instance/assignment status no longer permits command. | Check-in state changed. | Refresh check-in detail/list and show current state. | After refresh only. | Follow current check-in status. |
| File lifecycle codes such as `UPLOAD_INTENT_EXPIRED`, `UPLOAD_INTENT_NOT_PENDING`, `UPLOAD_ALREADY_CONFIRMED`, `FILE_NOT_AVAILABLE`, `FILE_RESTORE_INVALID` | 409/422 | File/upload state no longer permits command. | Upload/file lifecycle changed. | Refresh file/upload state; restart upload if needed. | New upload for expired/failed intents. | Re-upload or use current file action. |
| Export lifecycle codes such as `ACTIVE_EXPORT_EXISTS`, `EXPORT_NOT_READY`, `EXPORT_ARTIFACT_NOT_READY`, `EXPORT_GENERATION_FAILED`, `EXPORT_CLAIM_STALE` | 409 | Export already active, unavailable, failed, or worker claim stale. | Export lifecycle is not ready for requested action. | Poll/list export status; show failed state if generation failed. | Poll/retry download when ready; recreate only after failure if allowed. | Wait or request new export. |

## Files And Uploads

| Code | HTTP | When it occurs | Meaning | Frontend behavior | Retry | User action |
| --- | --- | --- | --- | --- | --- | --- |
| `FILE_TOO_LARGE` | 422 | Upload intent body exceeds file size constraints. | File exceeds backend limit. | Show file size validation before upload. | No. | Pick smaller file. |
| `UNSUPPORTED_FILE_TYPE` | 422 | Upload intent/document file type not supported. | File type is not allowed. | Show accepted types. | No. | Pick supported file. |
| `CHECKSUM_INVALID`, `UPLOAD_CHECKSUM_NOT_VERIFIABLE`, `UPLOAD_OBJECT_MISMATCH` | 422 | Upload confirmation checksum/object metadata does not match expectation. | Uploaded object does not match reservation. | Mark upload failed; require new upload intent/object upload. | Yes, new intent/upload. | Re-upload file. |
| `UPLOAD_INTENT_EXPIRED` | 409/422 | Confirming an expired upload intent. | Reservation is too old. | Request a new upload intent. | Yes, new intent. | Re-upload. |
| `DOCUMENT_FILE_ALREADY_USED`, `GENERATED_FILE_ALREADY_EXISTS` | 409 | File/document uniqueness conflict. | File is already attached/generated. | Refresh document/file list. | No unless user chooses another file. | Select another file or use existing. |
| `FORBIDDEN` | 403 | File service denies access without more specific code. | Actor cannot perform file operation. | Treat as permission denial. | No. | Ask for access. |

## Support Access

| Code | HTTP | When it occurs | Meaning | Frontend behavior | Retry | User action |
| --- | --- | --- | --- | --- | --- | --- |
| `SUPPORT_WORKSPACE_DENIED` | 403 | Support session workspace does not match or workspace support cannot access route. | Support context is invalid for target workspace. | Stop using support header for that workspace; return to session picker. | No. | Select/start correct support session. |
| `SUPPORT_EFFECTIVE_MEMBERSHIP_REQUIRED` | 403 | `USER_CONTEXT` support lacks valid active effective membership. | Cannot evaluate tenant-user access. | Show effective user unavailable. | No. | Choose valid effective user/session. |
| `SUPPORT_WRITE_NOT_WHITELISTED`, `SUPPORT_READ_ONLY` | 403 | Support context attempts non-whitelisted write/read-only forbidden action. | Support session mode does not permit mutation. | Disable mutation controls in support mode. | No. | Use normal tenant user or different policy/session if allowed. |
| `SUPPORT_SENSITIVE_DENIED`, `SUPPORT_SENSITIVE_FILE_DENIED` | 403 | Support tries sensitive data/file access without platform sensitive permission/session allowance. | Sensitive support gate failed. | Hide sensitive data/download and show restricted support access. | No. | Request proper support permission/session. |
| `SUPPORT_SESSION_INVALID`, `SUPPORT_SESSION_NOT_ACTIVE`, `SUPPORT_SESSION_EXPIRED`, `SUPPORT_SESSION_ACTOR_MISMATCH`, `SUPPORT_SESSION_PARENT_MISMATCH`, `SUPPORT_SESSION_PARENT_INVALID`, `SUPPORT_SESSION_IP_MISMATCH`, `SUPPORT_SESSION_WORKSPACE_MISMATCH` | 403 | `x-support-session-id` is invalid for actor/request/workspace/IP/status. | Support header cannot be used. | Clear support context and force session refresh/start. | No with same session. | Start/select valid support session. |
| `SUPPORT_SESSION_NOT_FOUND`, `SUPPORT_POLICY_NOT_FOUND` | 404/403 | Support session/policy missing or hidden. | Support resource is unavailable. | Refresh support list and clear stale selection. | No. | Select current policy/session. |
| `SUPPORT_POLICY_*_INVALID`, `SUPPORT_POLICY_TARGETS_REQUIRED`, `SUPPORT_POLICY_SESSION_TYPES_REQUIRED`, `SUPPORT_REASON_REQUIRED` | 422 | Support policy/request body is semantically invalid. | Support admin/request input invalid. | Show field/domain validation. | No. | Correct support form. |
| `SUPPORT_POLICY_VERSION_CONFLICT`, `SUPPORT_SESSION_VERSION_CONFLICT` | 409 | Support policy/session expected version stale. | Support resource changed. | Refetch and ask user to reapply. | After refetch only. | Reapply with latest version. |

## Retention, Deletion, And Export Restrictions

| Code | HTTP | When it occurs | Meaning | Frontend behavior | Retry | User action |
| --- | --- | --- | --- | --- | --- | --- |
| `SUPPORT_ACCESS_FORBIDDEN`, `EXPORT_SUPPORT_FORBIDDEN` | 403 | Support context attempts retention/deletion/export operation that forbids support. | Operation cannot be performed in support context. | Hide/disable operation while support header active. | No. | Use authorized non-support actor. |
| `WORKSPACE_DELETION_NOT_ELIGIBLE`, `WORKSPACE_DELETION_DOCUMENTS_REMAIN`, `WORKSPACE_DELETION_FILES_REMAIN`, `WORKSPACE_DELETION_EXPORTS_REMAIN`, `WORKSPACE_DELETION_RETAINED_EVIDENCE_MISSING`, `WORKSPACE_DELETION_VERIFICATION_FAILED` | 409/422 | Deletion lifecycle prerequisites fail. | Workspace deletion cannot proceed yet. | Show blocking prerequisites and refresh deletion detail. | After prerequisites change. | Resolve listed blocker. |
| `WORKSPACE_DELETION_ALREADY_ACTIVE`, `WORKSPACE_DELETION_APPROVED`, `WORKSPACE_DELETION_LOCKED`, `WORKSPACE_DELETION_LOCK_CONFLICT`, `WORKSPACE_DELETION_LOCK_MISSING`, `WORKSPACE_DELETION_ELIGIBILITY_CHANGED`, `WORKSPACE_DELETION_COMPLETION_CONFLICT`, `WORKSPACE_DELETION_VERSION_CONFLICT` | 409 | Deletion lifecycle or lock state changed. | Deletion command is stale or invalid for current state. | Refetch deletion detail/list; do not repeat stale command. | After refetch only. | Continue from current deletion state. |
| `WORKSPACE_DELETION_NOT_FOUND` | 404 | Deletion request missing/stale. | Deletion request no longer exists/visible. | Refresh deletion queue and leave detail. | No. | Select current request. |

## Module-Specific Common Families

Use these families to build local copy and action states without hard-coding
every current code in the component layer.

| Family | Typical HTTP | Frontend meaning | Frontend response |
| --- | --- | --- | --- |
| `*_NOT_FOUND` | 404 | Target resource stale, absent, hidden, or outside current scope. | Refresh parent list and leave detail. |
| `*_VERSION_CONFLICT` / `*_REVISION_CONFLICT` | 409 | Stale `expectedVersion`/revision/accessVersion. | Refetch entity, ask user to reapply. |
| `*_CONFLICT` | 409 | Uniqueness, active-state, lifecycle, or accounting conflict. | Refresh related state; prompt user to resolve conflict. |
| `*_INVALID` | 400/409/422 | Domain input or transition invalid. | Show domain validation or current-state mismatch. |
| `*_REQUIRED` | 400/422 | Required domain value missing. | Show required field/action guidance. |
| `*_ARCHIVED` / `*_INACTIVE` | 409/422 | Resource is archived/inactive for the requested command. | Disable action and refresh current state. |

## Frontend Implementation Guidance

- Centralize handling by `error.code` first, then by HTTP status fallback.
- Preserve `correlationId` in logs, bug reports, and support handoff.
- Do not treat all 403s as permissions. Some 403s are entitlement, quota, or
  support-mode denials.
- Do not auto-retry 409s except the documented idempotency in-progress/conflict
  cases. Most 409s need a refetch.
- Do not retry stale `expectedVersion` bodies automatically.
- Treat cursor errors as pagination reset, not page-level fatal errors.
- Treat support-session errors as support-context invalidation and stop sending
  `x-support-session-id` until a fresh session is selected.
- For upload errors, restart the upload lifecycle from a new intent unless the
  code clearly says the object is merely not ready and the UX permits retry.

## Locked-Stage Protection

- No Stage 2-18 implementation was modified.
- No error codes, handlers, schemas, routes, services, migrations, tests,
  permissions, OpenAPI artifacts, configuration, generated artifacts, or runtime
  behavior were changed.
- This catalog documents existing behavior only. Any future mismatch between UX
  desire and backend behavior must be handled by a separate authorized
  implementation issue.
