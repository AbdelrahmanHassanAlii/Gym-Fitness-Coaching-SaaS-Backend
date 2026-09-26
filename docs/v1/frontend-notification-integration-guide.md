# V1 Notification Integration Guide

Issue: V1-FE-09 / GitHub #14

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Backend root inspected: `apps/backend`

## Source Of Truth

The locked Stage 18 backend implementation is authoritative over generated
OpenAPI, previous summaries, and this document. Route files, schemas, services,
repositories, tests, migrations, and existing V1 docs win when they disagree with
generated artifacts.

This guide is frontend-facing. It documents the implemented V1 notification
contract only. It does not change notification creation, delivery workers,
schemas, routes, preferences, migrations, tests, OpenAPI, permissions, or runtime
behavior.

## Evidence Used

- `src/modules/notifications/notification.routes.ts`
- `src/modules/notifications/notification.schemas.ts`
- `src/modules/notifications/notification.service.ts`
- `src/modules/notifications/notification.repository.ts`
- `src/modules/notifications/notification.registry.ts`
- `src/modules/notifications/notification.types.ts`
- `src/modules/notifications/notification.jobs.ts`
- `src/modules/notifications/notification.outbox-handlers.ts`
- `src/modules/notifications/notification.templates.ts`
- `src/core/messaging/email.provider.ts`
- `src/core/messaging/push.provider.ts`
- `src/worker/main.ts`
- `src/migrations/019-stage14-notifications.ts`
- `test/stage14-notifications.test.ts`
- `test/stage15-audit.test.ts`
- `test/stage16-support-access.test.ts`
- `docs/v1/frontend-api-integration-guide.md`
- `docs/v1/frontend-pagination-cursor-contract.md`
- `docs/v1/frontend-error-ux-catalog.md`
- `docs/v1/frontend-feature-api-map.md`

## Contract Summary

V1 notifications are created by backend domain events, not by a public frontend
"create notification" API.

The frontend-facing notification surface is current-user scoped:

1. List the signed-in user's in-app notifications.
2. Mark one notification read.
3. Mark all current unread notifications read.
4. Read and update current-user notification preferences.
5. Register or revoke push devices for the current user.

Email and push delivery state is processed by backend workers. V1 does not expose
a public endpoint for delivery status, delivery retry history, push device list,
or unread counts.

All routes are under `/api/v1/me/...`, require authentication, and operate on
the effective authenticated user. They do not take `workspaceId` as a path
parameter. Workspace relevance appears on individual notification DTOs when the
source event belongs to a workspace.

## Route Inventory

| Method | Path | Purpose | Idempotency | Concurrency |
| --- | --- | --- | --- | --- |
| `GET` | `/api/v1/me/notifications` | List current-user in-app notifications. | No. | Cursor continuation. |
| `POST` | `/api/v1/me/notifications/:notificationId/read` | Mark one owned notification as read. | No route wrapper; operation is idempotent by behavior. | None. |
| `POST` | `/api/v1/me/notifications/read-all` | Mark all current unread notifications read up to a server cutoff. | No route wrapper; repeated calls are safe. | Server cutoff protects future notifications. |
| `GET` | `/api/v1/me/notification-preferences` | Read current-user notification preferences. | No. | None. |
| `PUT` | `/api/v1/me/notification-preferences` | Replace preference state with optimistic concurrency. | No route wrapper. | Requires `expectedVersion`. |
| `POST` | `/api/v1/me/push-devices` | Register or refresh a push device token. | No route wrapper; upsert by user/token fingerprint. | Token uniqueness can reassign tokens. |
| `DELETE` | `/api/v1/me/push-devices/:deviceId` | Revoke one owned push device. | No route wrapper. | None. |

The notification routes are not wrapped in the generic idempotency middleware.
Do not send or rely on `Idempotency-Key` for these routes. This matters because
the generated OpenAPI exporter broadly marks mutating routes with optional
`Idempotency-Key`; notification behavior must be derived from route/service
evidence, not from that broad generated metadata.

## Notification DTO

Notification list and read responses return safe notification DTOs:

```json
{
  "id": "notificationId",
  "workspaceId": "workspaceId-or-omitted",
  "eventType": "DocumentUploaded",
  "notificationType": "DOCUMENT_UPLOADED",
  "category": "DOCUMENT",
  "title": "Document uploaded",
  "body": "A document was uploaded.",
  "payload": {
    "relationshipId": "relationshipId",
    "documentId": "documentId"
  },
  "readAt": null,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

Frontend-visible fields:

| Field | Meaning |
| --- | --- |
| `id` | Notification id. |
| `workspaceId` | Present when the source event belongs to a workspace. |
| `eventType` | Source outbox event type. |
| `notificationType` | User-facing notification type from the registry. |
| `category` | One of `TRAINING`, `WORKOUT`, `NUTRITION`, `CHECK_IN`, `DOCUMENT`, `RELATIONSHIP`, `SECURITY`, `SUBSCRIPTION`. |
| `title` / `body` | Rendered text from backend templates using user/workspace locale. |
| `payload` | Safe navigation identifiers only. |
| `readAt` | ISO timestamp when read, otherwise `null`. |
| `createdAt` | ISO timestamp used for display and cursor ordering. |

Safe payload keys are limited by implementation to:

- `relationshipId`
- `checkinId`
- `assignmentId`
- `templateId`
- `documentId`

The backend intentionally does not expose sensitive document details, storage
links, medical data, raw provider metadata, push tokens, or delivery errors in
notification DTOs.

## List Notifications

Request:

```http
GET /api/v1/me/notifications?limit=50&cursor=<opaque>&unread=true
Authorization: Bearer <token>
```

Query parameters:

| Parameter | Type | Implemented behavior |
| --- | --- | --- |
| `limit` | integer 1 through 100 | Defaults to 50. Service clamps to 1 through 100. |
| `cursor` | string | Opaque continuation cursor from `page.nextCursor`. |
| `unread` | boolean | `true` returns unread only. `false` behaves like omitting the filter. |

Response:

```json
{
  "data": [
    {
      "id": "notificationId",
      "eventType": "CheckInDue",
      "notificationType": "CHECK_IN_DUE",
      "category": "CHECK_IN",
      "title": "Check-in due",
      "body": "Your check-in is due.",
      "payload": {
        "relationshipId": "relationshipId",
        "checkinId": "checkinId"
      },
      "readAt": null,
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "page": {
    "nextCursor": "opaque-or-null"
  }
}
```

Pagination behavior:

- Ordering is newest first by `createdAt`, then `_id` descending as the stable
  tie-breaker.
- The cursor is base64url-encoded backend state, but the frontend must treat it
  as opaque.
- The response does not include `hasMore`.
- Continue only while `page.nextCursor` is not `null`.
- Changing `unread` or `limit` should reset pagination state and start from the
  first page.
- Malformed cursors fail with `CURSOR_INVALID`. JSON/base64 parse failures
  return HTTP 422; an otherwise parseable cursor with an invalid id can return
  HTTP 404 because the shared object-id helper maps invalid ids to the supplied
  error code with 404.

There is no dedicated unread-count route. A frontend notification badge can
derive a visible count from the unread list it has loaded, but an exact global
unread count is not exposed in V1.

## Read State

Unread means `readAt` is `null`.

### Mark One Read

```http
POST /api/v1/me/notifications/:notificationId/read
Authorization: Bearer <token>
```

Behavior:

- The notification must belong to the current user.
- If the notification is unread, the backend sets `readAt` and returns the
  updated notification.
- If the notification is already read, the backend returns the existing
  notification without failing.
- A missing, invalid, or other-user notification id returns
  `NOTIFICATION_NOT_FOUND`.

Frontend behavior:

- Optimistically marking a visible item read is safe if the UI can roll back on
  error.
- Repeating the request after a network retry is safe because the operation is
  idempotent by repository behavior.

### Mark All Read

```http
POST /api/v1/me/notifications/read-all
Authorization: Bearer <token>
```

Response:

```json
{
  "data": {
    "cutoffAt": "2026-01-01T00:00:00.000Z",
    "affectedCount": 12
  }
}
```

Behavior:

- The backend captures `cutoffAt` at request time.
- Only unread notifications with `createdAt <= cutoffAt` are marked read.
- Notifications created after the cutoff remain unread.
- The response reports the number of notifications changed by this request.

There is no mark-unread route in V1.

## Preferences

### Read Preferences

```http
GET /api/v1/me/notification-preferences
Authorization: Bearer <token>
```

Default response when no preference record exists:

```json
{
  "data": {
    "channels": {
      "email": true,
      "push": true,
      "inApp": true
    },
    "eventPreferences": {},
    "version": 0,
    "updatedAt": "1970-01-01T00:00:00.000Z"
  }
}
```

Fields:

| Field | Meaning |
| --- | --- |
| `channels.email` | Global opt-in for optional email deliveries. |
| `channels.push` | Global opt-in for optional push deliveries. |
| `channels.inApp` | Stored preference flag. Current V1 creation still creates in-app notifications when registry channels include `IN_APP`. |
| `eventPreferences` | Optional per-`notificationType` overrides. |
| `version` | Optimistic concurrency value for preference updates. |
| `updatedAt` | Last preference update; default preferences use Unix epoch. |

Important implementation behavior: preference checks are applied when processing
external `EMAIL` and `PUSH` deliveries for optional notification types. In-app
notifications are created during outbox handling and are not suppressed by
`channels.inApp` or per-event `inApp` flags in the locked implementation.
Document this behavior instead of "fixing" it in V1 docs.

### Update Preferences

```http
PUT /api/v1/me/notification-preferences
Authorization: Bearer <token>
Content-Type: application/json

{
  "expectedVersion": 0,
  "channels": {
    "email": true,
    "push": false,
    "inApp": true
  },
  "eventPreferences": {
    "CHECK_IN_DUE": {
      "email": false,
      "push": true,
      "inApp": true
    }
  }
}
```

Behavior:

- `expectedVersion` is required and must match the current preference version.
- If no preference record exists, `expectedVersion` must be `0`.
- `channels` is optional and partial; supplied keys merge with existing channel
  settings.
- `eventPreferences` is optional. When supplied, it replaces the whole
  `eventPreferences` map.
- Event preference keys must match `^[A-Z0-9_]+$`.
- Event preference channel keys must be one of `email`, `push`, or `inApp`.
- Successful updates increment `version` and write audit event
  `NotificationPreferencesUpdated`.
- If audit writing fails inside the transaction, preference changes roll back.

Concurrency:

- Stale versions fail with `NOTIFICATION_PREFERENCES_VERSION_CONFLICT` and HTTP
  409.
- On conflict, refetch preferences, reapply the user's intended changes to the
  latest object, and resubmit with the new `version`.

Mandatory notification entries bypass email/push preference opt-outs during
delivery processing. Optional entries honor global channel preferences and
per-event overrides for `EMAIL` and `PUSH`.

## Push Devices

### Register Push Device

```http
POST /api/v1/me/push-devices
Authorization: Bearer <token>
Content-Type: application/json

{
  "platform": "WEB",
  "provider": "fcm",
  "token": "provider-token",
  "label": "Chrome on Work Laptop"
}
```

Allowed platforms:

- `IOS`
- `ANDROID`
- `WEB`

Response status is 201:

```json
{
  "data": {
    "id": "deviceId",
    "platform": "WEB",
    "provider": "fcm",
    "status": "ACTIVE",
    "tokenFingerprint": "sha256-fingerprint",
    "lastSeenAt": "2026-01-01T00:00:00.000Z",
    "revokedAt": null
  }
}
```

Behavior:

- The raw push token is stored by the backend but never returned.
- The response exposes `tokenFingerprint` for correlation/debug display only.
- Re-registering the same token for the same user updates the existing device,
  sets status to `ACTIVE`, refreshes `lastSeenAt`, and clears `revokedAt`.
- Registering a token that is active for another user revokes the other user's
  active device and cancels pending/retrying deliveries for that old device with
  reason `PUSH_DEVICE_TOKEN_REASSIGNED`.
- `provider` schema requires at least one character, then the service stores the
  trimmed value. A whitespace-only provider is not rejected after trimming in the
  locked implementation.
- `token` must be non-empty and at most 4096 characters.
- `label` is optional and at most 120 characters.

There is no public V1 route to list registered push devices.

### Revoke Push Device

```http
DELETE /api/v1/me/push-devices/:deviceId
Authorization: Bearer <token>
```

Behavior:

- The device must belong to the current user.
- The backend sets status to `REVOKED` and `revokedAt`.
- Pending or retrying deliveries for the device are cancelled with reason
  `PUSH_DEVICE_REVOKED`.
- Missing or other-user devices return `PUSH_DEVICE_NOT_FOUND`.

Frontend behavior:

- Revoke the backend device when the browser/mobile app logs out from push,
  loses push permission permanently, or rotates away from an old token.
- Register the new token after provider token refresh.
- Because V1 has no list route, store the returned `deviceId` client-side if the
  app needs to revoke it later.

## Notification Creation Sources

The public frontend does not create notifications directly. Domain modules emit
outbox events, and the notification outbox handler
`notifications.stage14` creates in-app notifications and external delivery
records for registered events.

Registered V1 events:

| Source event | Notification type | Category | Channels | Mandatory | Main recipient behavior |
| --- | --- | --- | --- | --- | --- |
| `CheckInDue` | `CHECK_IN_DUE` | `CHECK_IN` | `IN_APP`, `EMAIL`, `PUSH` | No | Trainee on active or needs-reassignment relationship. |
| `CheckInOverdue` | `CHECK_IN_OVERDUE` | `CHECK_IN` | `IN_APP`, `EMAIL`, `PUSH` | No | Trainee on active or needs-reassignment relationship. |
| `CheckInSubmitted` | `CHECK_IN_SUBMITTED` | `CHECK_IN` | `IN_APP`, `EMAIL`, `PUSH` | No | Active assigned staff. |
| `CheckInReviewed` | `CHECK_IN_REVIEWED` | `CHECK_IN` | `IN_APP`, `EMAIL`, `PUSH` | No | Trainee on active or needs-reassignment relationship. |
| `DocumentUploaded` | `DOCUMENT_UPLOADED` | `DOCUMENT` | `IN_APP`, `EMAIL`, `PUSH` | No | Active assigned staff. |
| `WorkoutCompleted` | `WORKOUT_COMPLETED` | `WORKOUT` | `IN_APP`, `PUSH` | No | Active assigned staff. |
| `WorkoutCorrected` | `WORKOUT_CORRECTED` | `WORKOUT` | `IN_APP` | No | Active assigned staff. |
| `ProgramActivated` | `PROGRAM_ACTIVATED` | `TRAINING` | `IN_APP`, `EMAIL`, `PUSH` | No | Trainee. |
| `ProgramUpdated` | `PROGRAM_UPDATED` | `TRAINING` | `IN_APP`, `PUSH` | No | Trainee. |
| `NutritionPlanActivated` | `NUTRITION_PLAN_ACTIVATED` | `NUTRITION` | `IN_APP`, `EMAIL`, `PUSH` | No | Trainee. |
| `NutritionPlanUpdated` | `NUTRITION_PLAN_UPDATED` | `NUTRITION` | `IN_APP`, `PUSH` | No | Trainee. |
| `TraineeNeedsReassignment` | `TRAINEE_NEEDS_REASSIGNMENT` | `RELATIONSHIP` | `IN_APP`, `EMAIL` | No | Active owners and managers. |
| `MembershipPermissionProfilesReplaced` | `PERMISSION_CHANGED` | `SECURITY` | `IN_APP`, `EMAIL` | Yes | The membership's user. |
| `SubscriptionFrozen` | `SUBSCRIPTION_CHANGED` | `SUBSCRIPTION` | `IN_APP`, `EMAIL` | Yes | Active owners and managers. |
| `SupportSessionStarted` | `SUPPORT_SESSION_STARTED` | `SECURITY` | `IN_APP`, `EMAIL` | Yes | Active owners unless payload suppresses notification. |
| `SupportSessionEnded` | `SUPPORT_SESSION_ENDED` | `SECURITY` | `IN_APP` | Yes | Active owners unless payload suppresses notification. |
| `SupportSessionRevoked` | `SUPPORT_SESSION_REVOKED` | `SECURITY` | `IN_APP`, `EMAIL` | Yes | Active owners unless payload suppresses notification. |
| `SupportSessionExpired` | `SUPPORT_SESSION_EXPIRED` | `SECURITY` | `IN_APP` | Yes | Active owners unless payload suppresses notification. |
| `RetentionWarningDue` | `RETENTION_WARNING_DUE` | `SUBSCRIPTION` | `IN_APP`, `EMAIL` | Yes | Active owners. |
| `WorkspaceDeletionRequested` | `WORKSPACE_DELETION_REQUESTED` | `SUBSCRIPTION` | `IN_APP`, `EMAIL` | Yes | Active owners. |
| `WorkspaceDeletionPostponed` | `WORKSPACE_DELETION_POSTPONED` | `SUBSCRIPTION` | `IN_APP`, `EMAIL` | Yes | Active owners. |
| `WorkspaceDeletionCancelled` | `WORKSPACE_DELETION_CANCELLED` | `SUBSCRIPTION` | `IN_APP`, `EMAIL` | Yes | Active owners. |
| `WorkspaceDeletionApproved` | `WORKSPACE_DELETION_APPROVED` | `SECURITY` | `IN_APP`, `EMAIL` | Yes | Active owners. |
| `WorkspaceExportReady` | `WORKSPACE_EXPORT_READY` | `SECURITY` | `IN_APP`, `EMAIL` | Yes | Requested user from event payload or export record. |
| `WorkspaceExportFailed` | `WORKSPACE_EXPORT_FAILED` | `SECURITY` | `IN_APP` | Yes | Requested user from event payload or export record. |
| `WorkspaceExportExpired` | `WORKSPACE_EXPORT_EXPIRED` | `SECURITY` | `IN_APP` | Yes | Requested user from event payload or export record. |

Creation constraints:

- Recipients must be active users.
- Workspace staff recipients require active memberships.
- Relationship-scoped staff deliveries remain eligible only while the
  relationship is `ACTIVE` or `NEEDS_REASSIGNMENT` and the staff assignment is
  still active.
- Check-in due/overdue events use a stale policy: `CheckInDue` creates only if
  the check-in instance is still `DUE`; `CheckInOverdue` creates only if it is
  still `OVERDUE`.
- Support session events can suppress owner notifications when the outbox
  payload has `notificationRequired: false`.
- Duplicate outbox processing is deduped by source event, recipient, and
  notification type. Duplicate external deliveries are deduped by logical
  delivery key.

## Delivery Worker Behavior

Frontend users see in-app notification records immediately after the outbox
handler creates them. External email/push delivery is asynchronous.

Delivery statuses exist internally:

| Status | Meaning |
| --- | --- |
| `PENDING` | Delivery is waiting for the worker. |
| `RETRYING` | Prior attempt failed with a retryable error and a future retry time. |
| `SENT` | Provider send completed and delivery is terminal. |
| `FAILED` | Delivery is terminal due non-retryable error or max attempts. |
| `CANCELLED` | Delivery was intentionally cancelled before send or retry. |

Worker behavior:

- `NotificationJobRunner.runDueJobs()` processes due deliveries.
- The worker uses job lease key `notifications.delivery`.
- Default config is delivery batch size 25, claim window 60 seconds, and max
  attempts 5 when notification config is absent.
- Eligible deliveries are `PENDING` or `RETRYING` with no future
  `nextAttemptAt` and no active claim.
- Claim expiry allows later workers to recover abandoned claims.
- Retry delays are 1 minute, 5 minutes, 15 minutes, 1 hour, and 6 hours, then
  6 hours for later attempts.

Cancellation and failure behavior:

| Reason/code | Meaning |
| --- | --- |
| `REGISTRY_ENTRY_MISSING` | Source event no longer maps to a delivery channel. |
| `PREFERENCES_DISABLED` | Optional external delivery was disabled by current preferences. |
| `RECIPIENT_NOT_ELIGIBLE` | Membership, relationship, or assignment no longer allows delivery. |
| `PUSH_DEVICE_INACTIVE` | The delivery's push device is no longer active. |
| `PUSH_DEVICE_REVOKED` | User revoked the device before queued delivery sent. |
| `PUSH_DEVICE_INVALID` | Provider rejected the destination as invalid; backend revoked the device. |
| `PUSH_DEVICE_TOKEN_REASSIGNED` | Same push token was registered by another user. |
| provider error code | Delivery failed or will retry according to provider retryability and max attempts. |

Provider idempotency:

- Delivery records store a provider idempotency key and whether the provider
  reports idempotency support.
- The logging email provider supports idempotency in tests.
- The logging push provider does not report idempotency support in the locked
  implementation.
- Frontend code cannot observe or control delivery retries directly.

## Polling And Refresh Expectations

V1 has no WebSocket, Server-Sent Events, or notification subscription endpoint.
The frontend should use HTTP refresh patterns:

- Fetch the first notification page after login/session restore.
- Refetch or prepend-load after domain actions likely to emit notifications, if
  the current user can be a recipient.
- Refetch on app resume or tab focus after a stale interval.
- Refetch after a push notification is tapped/opened.
- Refetch the visible page after mark-one-read or mark-all-read if optimistic UI
  state could be stale.
- Keep separate pagination state for unread-only and all-notification views.

Do not poll external delivery state; no public route exposes it.

## Frontend UX Guidance

Notification center:

- Use `GET /api/v1/me/notifications` for both all and unread views.
- Show `readAt === null` as unread.
- Use `notificationType` and `category` for icon/group styling.
- Use `payload` ids only for navigation hints; always fetch the destination
  resource before rendering sensitive or current business state.
- Treat missing destination resources as stale notification targets and show a
  gentle "no longer available" state.

Preferences:

- Always read current preferences before showing settings.
- Submit the current `version` as `expectedVersion`.
- On version conflict, refetch and ask the user to retry or merge their change.
- Make clear that mandatory security/subscription/retention/export messages may
  still send externally even when optional channels are disabled.

Push:

- Register a device after the platform provider returns a valid token and the
  user has granted push permission.
- Re-register after provider token refresh.
- Revoke the backend device when the app intentionally disables push for that
  device and still knows the backend `deviceId`.
- Store raw push tokens only in platform push infrastructure; do not log them.

## Error Catalog

| Code | HTTP | When it occurs | Frontend behavior |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | Missing/invalid authenticated user context. | Reauthenticate or refresh session. |
| `VALIDATION_FAILED` or schema error | 400/422 | Query/body/param fails route schema, such as bad id length or invalid platform. | Fix request before retry. |
| `CURSOR_INVALID` | 422 or 404 | Notification list cursor is malformed; parse failures use 422 while parseable cursors with invalid ids can use 404. | Clear cursor and reload first page. |
| `NOTIFICATION_NOT_FOUND` | 404 | Notification id is invalid, missing, or not owned by current user. | Remove stale item or refresh list. |
| `NOTIFICATION_PREFERENCES_VERSION_CONFLICT` | 409 | Preference `expectedVersion` is stale. | Refetch preferences and resubmit intentional changes. |
| `NOTIFICATION_PREFERENCE_UNSUPPORTED` | 422 | Event preference key or channel key is unsupported by validation. | Use uppercase notification type keys and only `email`, `push`, `inApp`. |
| `PUSH_DEVICE_NOT_FOUND` | 404 | Device id is invalid, missing, or not owned by current user. | Clear local device id and stop retrying revoke. |
| `PUSH_DEVICE_REGISTRATION_CONFLICT` | 409 | Upsert failed unexpectedly under token uniqueness constraints. | Refetch/register again once; report if repeated. |

Provider delivery failures do not surface through public notification APIs in
V1. They are handled by worker retry/cancel/fail state.

## Security And Privacy

- Notification routes are current-user scoped; no workspace role permission is
  evaluated at route level.
- Source events still determine who receives notifications through active
  membership, relationship, assignment, owner/manager, and requested-user rules.
- Notification DTOs expose only safe payload ids.
- Document upload notifications do not expose signed URLs, raw storage details,
  medical content, or sensitive document fields.
- Push tokens are never returned and should not be logged by clients.
- Backend logging redacts push/auth/provider/invitation/activation/reset/signed
  URL secrets in the tested logging path.

## Non-Public/Internal Details

Frontend must not depend on:

- Mongo collection names or indexes.
- Raw outbox event documents.
- Worker lease keys or claim windows.
- Delivery status collections or provider message ids.
- Provider idempotency keys.
- Push token fingerprints as stable public identifiers beyond device response
  display/debug use.
- Internal template keys or template versions.
- Cursor encoding.

## Known Follow-Ups

UNVERIFIED — REQUIRES FOLLOW-UP: V1 stores `channels.inApp` and per-event
`inApp` preference flags, but the locked notification creation path does not use
them to suppress in-app notification records. This document records the actual
implementation. Any product decision to make in-app preferences suppress
in-app notification creation requires a future implementation issue.

UNVERIFIED — REQUIRES FOLLOW-UP: V1 exposes push device register/revoke but no
push device list route. A settings UI that needs cross-device management will
need a future product/API decision rather than inferring device state from
notifications.

## Locked-Stage Protection

- No Stage 2-18 implementation was modified.
- No notification routes, schemas, services, repositories, workers, providers,
  migrations, tests, OpenAPI artifacts, configuration, generated artifacts, or
  runtime behavior were changed.
- This guide documents existing behavior only, including stored-but-not-applied
  in-app preferences and backend-internal delivery state.
