# V1 State Machine And Status Reference

Issue: V1-DOC-04 / GitHub #4

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Depends on:

- `docs/v1/backend-module-inventory.md`
- `docs/v1/module-business-flows.md`
- `docs/v1/cross-module-workflows.md`

## Source Of Truth

This reference is grounded in the locked Stage 18 backend implementation. Type
files define the status values; route/service/repository/job code defines the
implemented transitions. Tests were used as supporting evidence, especially for
concurrency and job-driven lifecycle behavior.

This document does not create new statuses or normalize surprising behavior. If a
status exists in a type but no public transition was found, it is documented that
way.

## Shared Rules

- Public lifecycle commands are permission-gated by the owning route/service.
- Many lifecycle commands require `expectedVersion`; stale versions fail with a
  conflict and do not partially update state.
- Commands wrapped by `container.idempotency.runInTransaction` also require
  `Idempotency-Key`.
- Most state-changing commands write audit and/or outbox in the same transaction
  as the domain write.
- Notification side effects are generally asynchronous: source service writes an
  outbox event, then the worker notification handler creates notifications and
  deliveries.
- Worker-driven transitions are run by `src/worker/main.ts` through job runners
  and leases.

## Auth / Identity

### User Status

Entity: `UserDocument`

Source: `src/modules/identity/identity.types.ts`

Statuses: `PENDING_ACTIVATION`, `ACTIVE`, `SUSPENDED`, `LOCKED`,
`DEACTIVATED`.

| Transition | Trigger | Actor | Side effects |
| --- | --- | --- | --- |
| create `ACTIVE` | normal registration/user creation | public user or service | session/refresh token may be created by auth flow |
| create `PENDING_ACTIVATION` | lead conversion / owner activation preparation | platform lead conversion service | owner activation invitation created |
| `PENDING_ACTIVATION` -> `ACTIVE` | owner activation completion or invited owner activation | owner user | password may be set; workspace/membership activation can occur in same flow |

Forbidden or not exposed: no public V1 transition was found from `ACTIVE` to
`SUSPENDED`, `LOCKED`, or `DEACTIVATED`. Those statuses exist in the type and can
be checked by auth/access code, but the inventory did not identify route-backed
lifecycle commands for them.

Audit/outbox/notifications: user activation participates in owner activation
audit/outbox through Leads/Workspace flows. Auth security events are written for
auth operations.

### Auth Session Status

Entity: `AuthSessionDocument`

Source: `src/modules/auth/auth.types.ts`,
`src/modules/auth/auth.repositories.ts`

Statuses: `ACTIVE`, `REVOKED`, `EXPIRED`.

| Transition | Trigger | Actor | Side effects |
| --- | --- | --- | --- |
| create `ACTIVE` | registration/login/MFA login/refresh session creation | auth service | refresh token created |
| `ACTIVE` -> `REVOKED` | logout, password reset, MFA disable, refresh-token reuse, session-family revocation | user or auth service | refresh tokens for session/family revoked |

Forbidden or not exposed: `EXPIRED` exists in the type, but repository evidence
uses expiry timestamps for session validity and explicit revocation for
invalidation. No public command was found that writes session status `EXPIRED`.

Concurrency/idempotency: refresh-token rotation enforces single-use semantics.

### Refresh Token Status

Entity: `AuthRefreshTokenDocument`

Statuses: `CURRENT`, `CONSUMED`, `REVOKED`.

| Transition | Trigger | Actor | Side effects |
| --- | --- | --- | --- |
| create `CURRENT` | login/register/refresh | auth service | linked to session |
| `CURRENT` -> `CONSUMED` | successful refresh rotation | user | replacement refresh token created |
| `CURRENT` or `CONSUMED` -> `REVOKED` | logout, password reset, MFA disable, refresh-token reuse | user or auth service | session family can be revoked |

Forbidden: refresh with a non-current, consumed, revoked, or expired token fails.

### MFA Method Status

Entity: `AuthMfaMethodDocument`

Statuses: `PENDING`, `ACTIVE`, `DISABLED`.

| Transition | Trigger | Actor | Side effects |
| --- | --- | --- | --- |
| create `PENDING` | TOTP setup | authenticated user | challenge/secret generated |
| `PENDING` -> `ACTIVE` | TOTP confirm | authenticated user | recovery codes stored |
| `ACTIVE` -> `DISABLED` | MFA disable | authenticated user with MFA proof/recovery | user sessions revoked |

Forbidden: disabled methods do not reactivate through a documented public
transition; setup creates a new pending/active flow.

## Workspace / Platform / Memberships

### Platform Membership Status

Entity: `PlatformMembershipDocument`

Statuses: `ACTIVE`, `SUSPENDED`, `ENDED`.

| Transition | Trigger | Actor | Side effects |
| --- | --- | --- | --- |
| create `ACTIVE` | platform membership creation | platform admin | audit/outbox |
| `ACTIVE` -> `SUSPENDED` | suspend platform membership route | platform admin | audit/outbox |
| `SUSPENDED` -> `ACTIVE` | reactivate platform membership route | platform admin | audit/outbox |
| `ACTIVE` or `SUSPENDED` -> `ENDED` | end platform membership route | platform admin | audit/outbox |

Forbidden: ended platform memberships are terminal in repository transition
patterns.

### Workspace Status

Entity: `WorkspaceDocument`

Statuses: `PENDING_ACTIVATION`, `ACTIVE`, `RESTRICTED`, `SUSPENDED`,
`ARCHIVED`.

| Transition | Trigger | Actor | Side effects |
| --- | --- | --- | --- |
| create `ACTIVE` | platform workspace creation | platform admin | owner membership created |
| create `PENDING_ACTIVATION` | lead conversion | platform lead actor | owner activation invitation/subscription state created |
| `PENDING_ACTIVATION` -> `ACTIVE` | owner activation completion | owner user | owner membership active; subscription intent activated |
| `ACTIVE` -> `RESTRICTED` | workspace deletion approval | platform deletion admin | deletion lock recorded |
| `RESTRICTED` -> `ARCHIVED` | deletion processor completion | retention worker | live-data deletion/tombstone fields written |

Forbidden or not exposed: `SUSPENDED` exists but no route-backed transition was
identified in V1 docs/source scans. Restricted workspaces are denied by many
tenant routes.

### Workspace Membership Status

Entity: `WorkspaceMembershipDocument`

Statuses: `INVITED`, `ACTIVE`, `SUSPENDED`, `ENDED`, `ARCHIVED`.

| Transition | Trigger | Actor | Side effects |
| --- | --- | --- | --- |
| create `INVITED` | staff/owner invitation | inviter/platform flow | invitation created |
| create `ACTIVE` | direct owner workspace creation or ensured trainee membership | service | usage can be reserved |
| `INVITED` -> `ACTIVE` | invitation acceptance / owner activation | invited user | invitation accepted, audit/outbox |
| `SUSPENDED` or `ENDED` -> `ACTIVE` | invitation reactivation path | invited user/service | membership roles/profile refreshed |
| `ACTIVE` -> `ENDED` | relationship end can remove trainee membership contribution; staff lifecycle commands can end | service/admin | engagement period closed |

Forbidden or not exposed: no first-class archive route for memberships was
identified in V1 route inventory.

### Membership Branch Assignment Active Flag

Entity: `MembershipBranchAssignmentDocument.active`

States: `true`, `false`.

Allowed: branch assignment creates active rows; unassign ends an active assignment
by setting it inactive and recording `endedAt`. No reactivation command was
identified; reassignment creates or reuses active assignment semantics through the
workspace service.

### Branch Status

Entity: `BranchDocument`

Statuses: `ACTIVE`, `ARCHIVED`.

Allowed: create `ACTIVE`; `ACTIVE` -> `ARCHIVED` through branch archive route.

Forbidden: archived branches do not reactivate through a documented V1 route.

### Invitation Status

Entity: `InvitationDocument`

Statuses: `PENDING`, `ACCEPTED`, `EXPIRED`, `REVOKED`, `SUPERSEDED`.

| Transition | Trigger | Actor | Side effects |
| --- | --- | --- | --- |
| create `PENDING` | owner/staff/trainee invitation | platform/workspace service | token digest stored |
| `PENDING` -> `ACCEPTED` | invitation acceptance | invited user | membership/relationship activation can occur |
| `PENDING` -> `REVOKED` | revoke invitation | authorized staff | audit/outbox |
| `PENDING` -> `SUPERSEDED` | supersede pending invitation for same identifier | invitation service | replacement invitation created |
| `PENDING` -> `EXPIRED` | type value exists; repository queries exclude expired pending invitations by `expiresAt` | time-based eligibility | no explicit writer found in scanned repository methods |

## Permissions / Access Control

### Permission Definition State

Entity: `PermissionDefinitionDocument`

Statuses: `ACTIVE`, `DEPRECATED`.

Allowed: definitions are seeded/registered as active or deprecated. No public
route was found that transitions definition state.

### Permission Profile Status

Entity: `PermissionProfileDocument`

Statuses: `ACTIVE`, `ARCHIVED`.

Allowed: create `ACTIVE`; `ACTIVE` -> `ARCHIVED` through profile archive command
with `expectedVersion`.

Forbidden: system default profiles and archived profiles cannot be archived or
used as active authorizers. No restore transition was found.

## Subscriptions / Payments / Entitlements

### Subscription Plan Active Flag

Entity: `SubscriptionPlanDocument.active`

States: `true`, `false`.

Allowed: platform plan creation creates active plans; plan archive marks the plan
inactive with `expectedVersion`. No public reactivation transition was found.
Plan versions are immutable snapshots rather than lifecycle entities.

### Subscription Lifecycle Status

Entity: `SubscriptionDocument.lifecycleStatus`

Statuses: `PENDING_ACTIVATION`, `TRIAL`, `ACTIVE`, `GRACE_PERIOD`, `FROZEN`,
`EXPIRED`, `CANCELLED`.

| Transition | Trigger | Actor | Side effects |
| --- | --- | --- | --- |
| create/ensure `PENDING_ACTIVATION` | workspace/lead activation setup | commercial service | pending activation intent may be stored |
| `PENDING_ACTIVATION` -> `TRIAL` | start trial or owner activation of trial intent | platform actor/owner activation | terms snapshot; audit/outbox |
| `PENDING_ACTIVATION`, `TRIAL`, `ACTIVE`, `GRACE_PERIOD`, `FROZEN`, `EXPIRED` -> `ACTIVE` | payment approval, purchase/reactivation, upgrade/downgrade/admin override where transition set allows | platform payment/subscription actor | new terms snapshot; audit/outbox; can cancel pre-approval deletion |
| `TRIAL`, `ACTIVE`, `GRACE_PERIOD` -> `FROZEN` | freeze route or configured trial expiry action | platform actor or subscription job | `SubscriptionFrozen` outbox |
| `TRIAL` -> `GRACE_PERIOD` | subscription job when configured trial expiry action is grace | system worker | `TrialExpired` event/audit |
| `ACTIVE` or `GRACE_PERIOD` -> `EXPIRED` | subscription job due dates | system worker | retention later reads expired subscriptions |
| `PENDING_ACTIVATION`, `TRIAL`, `ACTIVE`, `GRACE_PERIOD`, `FROZEN`, `EXPIRED` -> `CANCELLED` | cancel route | platform actor | audit/outbox |

Forbidden: cancelled subscriptions are terminal for reactivation/upgrade/downgrade
in service constraints.

Concurrency/idempotency: commercial mutations use `expectedVersion` and many
routes are idempotency-wrapped.

Notifications: registry includes `SubscriptionFrozen`; other commercial events
may be outbox-only unless registered.

### Manual Payment Status

Entity: `ManualPaymentDocument`

Statuses: `PENDING`, `APPROVED`, `REJECTED`.

Allowed: create `PENDING`; `PENDING` -> `APPROVED`; `PENDING` -> `REJECTED`.

Forbidden: approved/rejected payments are terminal. Approval also activates or
updates subscription terms.

## Leads / Owner Activation

### Lead Status

Entity: `LeadDocument`

Statuses: `NEW`, `CONTACTED`, `QUALIFIED`, `ON_HOLD`, `CONVERTED`, `LOST`,
`DUPLICATE`.

Allowed transitions are repository/service constrained by command:

- Public lead create creates a lead in an initial status determined by service
  rules, with tests showing `NEW`.
- Status-change command changes non-terminal leads using `expectedVersion`.
- Conversion requires one of the conversion source statuses and writes
  `CONVERTED`.
- Mark duplicate writes `DUPLICATE` and stores previous status.
- Merge writes duplicate/merge fields and event data.

Forbidden: converted and duplicate leads reject metadata updates. Conversion from
non-conversion source statuses fails.

Side effects: conversion creates pending workspace, owner membership/invitation,
and subscription state.

## Trainee Relationships

### Coaching Relationship Status

Entity: `CoachingRelationshipDocument`

Statuses: `PENDING`, `ACTIVE`, `NEEDS_REASSIGNMENT`, `ENDED`, `ARCHIVED`.

| Transition | Trigger | Actor | Side effects |
| --- | --- | --- | --- |
| create `PENDING` | referral join | trainee | outbox `TraineeRelationshipRequested` |
| create `ACTIVE` | trainee invitation acceptance or direct activation | trainee/service | trainee membership, quota reservation, primary assignment |
| `PENDING` -> `ACTIVE` | accept pending | authorized staff | primary trainer assignment, audit/outbox |
| `PENDING` -> `ENDED` | reject pending | authorized staff | audit/outbox `TraineeRejected` |
| `ACTIVE` -> `NEEDS_REASSIGNMENT` | remove primary or eligibility reconciliation | staff/system handler | `TraineeNeedsReassignment` outbox |
| `NEEDS_REASSIGNMENT` -> `ACTIVE` | set primary / reassign | authorized staff | primary assignment created |
| `ACTIVE` or `NEEDS_REASSIGNMENT` -> `ENDED` | end relationship | authorized staff | active assignments closed, active program/nutrition/check-ins closed/skipped, trainee usage released |
| `ENDED` -> `ACTIVE` | reactivate relationship | authorized staff | quota reserved and primary/home branch validated |

Forbidden: archive status exists, but no route-backed archive transition was
identified in the V1 route inventory. Relationship state changes require
`expectedVersion`.

### Trainee Staff Assignment Active Flag

Entity: `TraineeStaffAssignmentDocument.active`

States: `true`, `false`.

Allowed: create active assignments; active -> inactive when primary/assistant/
nutritionist assignment is removed, replaced, or relationship ends.

### Trainee Referral Code Active Flag

Entity: `TraineeReferralCodeDocument.active`

States: `true`, `false`.

Referral code active state is used by referral join eligibility. The type exposes
the flag and optional expiry, but no dedicated public referral-code lifecycle
route was identified in the V1 route inventory.

## Training / Workouts / PRs

### Training Catalog Status

Entities: `ExerciseDocument`, `ProgramTemplateDocument`

Statuses: `ACTIVE`, `ARCHIVED`.

Allowed: create `ACTIVE`; `ACTIVE` -> `ARCHIVED` for non-system/default-eligible
records through archive commands with `expectedVersion`.

Forbidden: archived exercises/templates do not reactivate through documented V1
routes.

### Program Status

Entity: `ProgramDocument`

Statuses: `DRAFT`, `ACTIVE`, `REPLACED`, `COMPLETED`, `ARCHIVED`.

| Transition | Trigger | Actor | Side effects |
| --- | --- | --- | --- |
| create `DRAFT` | assign/create program | authorized staff | current revision created |
| `DRAFT` -> `ACTIVE` | activate program | authorized staff | progress initialized; audit/outbox |
| `ACTIVE` -> `REPLACED` | activate replacement program | authorized staff | old active ended, replacement active |
| `ACTIVE` -> `COMPLETED` | complete program or relationship end | authorized staff/service | ended/completed timestamps |
| `DRAFT`, `REPLACED`, `COMPLETED` -> `ARCHIVED` | archive program | authorized staff | archived timestamp |

Forbidden: active programs cannot be archived directly; completed/replaced/
archived programs cannot reactivate. Activation requires executable revision and
no conflicting active program/in-progress transition.

### Program Progress Event Type

Entity: `ProgramProgressEventDocument.type`

Values: `INITIALIZED`, `COMPLETED`, `SKIPPED`, `DEFERRED`, `RESET`,
`MANUAL_ADVANCE`.

Implemented writers found for `INITIALIZED`, workout `COMPLETED`, and workout
skip/defer events. `RESET` and `MANUAL_ADVANCE` exist in the type; no route-backed
writer was identified in the scanned V1 flows.

### Workout Status

Entity: `WorkoutSessionDocument`

Statuses: `IN_PROGRESS`, `COMPLETED`, `ABANDONED`.

Allowed: create/start `IN_PROGRESS`; `IN_PROGRESS` -> `COMPLETED`; `IN_PROGRESS`
-> `ABANDONED`. Completed workouts can be corrected but remain `COMPLETED`.

Forbidden: completed/abandoned workouts cannot be completed again; abandoned
workouts do not reactivate. Abandon-all can set in-progress sessions to
`ABANDONED` when program lifecycle closes.

Side effects: completion advances program progress, recalculates PRs, writes
audit/outbox, and can produce notifications.

### Personal Record Event Type

Entity: `PersonalRecordEventDocument.eventType`

Values: `ACHIEVED`, `ADJUSTED`, `RETRACTED`.

Transitions are event facts rather than entity status transitions. Workout
completion/correction recalculates records and writes event rows when values are
achieved, adjusted, or retracted.

## Nutrition

### Food Status

Entity: `FoodDocument`

Statuses: `ACTIVE`, `ARCHIVED`.

Allowed: create `ACTIVE`; `ACTIVE` -> `ARCHIVED` with `expectedVersion`.

Forbidden: no restore transition found.

### Nutrition Plan Status

Entity: `NutritionPlanDocument`

Statuses: `DRAFT`, `ACTIVE`, `REPLACED`, `COMPLETED`, `ARCHIVED`.

Allowed transitions match program status semantics:

- create `DRAFT`
- `DRAFT` -> `ACTIVE`
- `ACTIVE` -> `REPLACED` when a replacement plan activates
- `ACTIVE` -> `COMPLETED` through complete plan or relationship end
- `DRAFT`, `REPLACED`, `COMPLETED` -> `ARCHIVED`

Forbidden: active plans cannot be archived directly; archived/completed/replaced
plans cannot reactivate through documented V1 routes.

Side effects: activation/replacement/completion write audit/outbox; notification
registry includes nutrition plan activation/update events.

## Progress

### Metric Definition Status

Entity: `MetricDefinitionDocument`

Statuses: `ACTIVE`, `ARCHIVED`.

Allowed: create `ACTIVE`; `ACTIVE` -> `ARCHIVED` with `expectedVersion`.

Forbidden: archived definitions do not restore. Built-in/system definitions have
additional restrictions in service logic.

### Coaching Note Status

Entity: `CoachingNoteDocument`

Statuses: `ACTIVE`, `ARCHIVED`.

Allowed: create `ACTIVE`; `ACTIVE` -> `ARCHIVED` with `expectedVersion`.

Forbidden: no restore transition found.

### Measurement / Photo / Health / Daily Tracking Versioned Records

These records do not expose status enums. They use versioned create/update/
correction semantics and `expectedVersion` where applicable. Daily tracking is
date-keyed and versioned.

## Check-Ins

### Check-In Template Status

Entity: `CheckInTemplateDocument`

Statuses: `ACTIVE`, `ARCHIVED`.

Allowed: create `ACTIVE`; `ACTIVE` -> `ARCHIVED` with `expectedVersion` when no
blocking active assignment/revision race prevents it.

Forbidden: archived templates do not restore through a documented V1 route.

### Check-In Assignment Active Flag

Entity: `CheckInAssignmentDocument.active`

States: `true`, `false`.

Allowed: create active assignment; active -> inactive through assignment end or
relationship end. No reactivation command was identified; create a new assignment
instead.

### Check-In Instance Status

Entity: `CheckInInstanceDocument`

Statuses: `UPCOMING`, `DUE`, `SUBMITTED`, `REVIEWED`, `OVERDUE`, `SKIPPED`.

| Transition | Trigger | Actor | Side effects |
| --- | --- | --- | --- |
| create `UPCOMING` | generator when open time is in future | system worker | audit only until promoted |
| create `DUE` | generator when period is currently due | system worker | `CheckInDue` outbox |
| create `OVERDUE` | generator when due time already passed | system worker | `CheckInOverdue` outbox |
| `UPCOMING` -> `DUE` | promote upcoming job | system worker | audit/outbox `CheckInDue` |
| `DUE` -> `OVERDUE` | overdue job | system worker | audit/outbox `CheckInOverdue` |
| `DUE` or `OVERDUE` -> `SUBMITTED` | submit route | trainee SELF | audit/outbox `CheckInSubmitted` |
| `SUBMITTED` -> `REVIEWED` | review route | authorized staff | audit/outbox `CheckInReviewed` |
| `UPCOMING`, `DUE`, `OVERDUE` -> `SKIPPED` | relationship end | service | skip metadata reason `RELATIONSHIP_ENDED` |

Forbidden: reviewed/submitted/skipped instances do not go back to due states.
Submit/review require `expectedVersion` and reject stale or wrong-status updates.

## Files / Documents

### Upload Intent Status

Entity: `UploadIntentDocument`

Statuses: `PENDING`, `CONFIRMED`, `EXPIRED`, `CANCELLED`.

Allowed: create `PENDING`; `PENDING` -> `CONFIRMED` after storage HEAD/size/type/
checksum verification; `PENDING` -> `EXPIRED` by file job. `CANCELLED` exists in
the type and is handled by orphan cleanup queries, but no public cancel route was
identified in V1.

Forbidden: confirmed/expired/cancelled intents cannot confirm again.

### Generated File Intent Status

Entity: `GeneratedFileIntentDocument`

Statuses: `PENDING`, `OBJECT_WRITTEN`, `FILE_CREATED`, `CLEANED`, `FAILED`.

Allowed: create `PENDING`; `PENDING` -> `OBJECT_WRITTEN` after generated export
object upload; -> `FILE_CREATED` after file metadata insert; `OBJECT_WRITTEN` or
`FAILED` -> `CLEANED` by cleanup; `OBJECT_WRITTEN` or `FAILED` -> `FAILED` on
cleanup failure.

### File Status

Entity: `FileDocument`

Statuses: `ACTIVE`, `SOFT_DELETED`, `PURGE_PENDING`, `PURGED`.

Allowed: create `ACTIVE`; `ACTIVE` -> `SOFT_DELETED` by delete command;
`SOFT_DELETED` -> `ACTIVE` by restore before purge eligibility; `SOFT_DELETED`
or `PURGE_PENDING` -> `PURGE_PENDING` by purge job/deletion lifecycle;
`PURGE_PENDING` -> `PURGED` after physical storage delete.

Forbidden: purged files are terminal. Restore after purge eligibility fails.

### Document Status

Entity: `BusinessDocument`

Statuses: `ACTIVE`, `DELETED`.

Allowed: create `ACTIVE`; `ACTIVE` -> `DELETED` through document delete or
workspace deletion. No restore transition was found.

## Notifications

### Notification Read State

Entity: `NotificationDocument.readAt`

States: unread when `readAt` is absent; read when `readAt` is set.

Allowed: unread -> read through mark-one/read-all. No unread transition was
identified.

### Notification Delivery Status

Entity: `NotificationDeliveryDocument`

Statuses: `PENDING`, `RETRYING`, `SENT`, `FAILED`, `CANCELLED`.

Allowed: create `PENDING`; `PENDING` or `RETRYING` is claimed by worker without
changing status; claimed delivery -> `SENT` on provider success; claimed delivery
-> `RETRYING` on retryable provider failure before max attempts; claimed delivery
-> `FAILED` when max attempts reached or failure is not retryable; claimed
delivery -> `CANCELLED` when registry entry, preferences, recipient eligibility,
or push device state invalidate delivery.

Forbidden: sent/failed/cancelled deliveries are terminal in repository logic.

### Push Device Status

Entity: `PushDeviceDocument.status`

Statuses: `ACTIVE`, `REVOKED`.

Allowed: register `ACTIVE`; `ACTIVE` -> `REVOKED` by device revoke, duplicate
token ownership change, invalid push destination, or user/device cleanup.

## Support Access

### Portal Access Policy Enabled / Archived State

Entity: `PortalAccessPolicyDocument`

State fields: `enabled` boolean, `archivedAt`.

Allowed: create enabled policy; update policy revision; disable policy sets
enabled false; archive policy sets archived timestamp. Disable/archive revokes
active sessions for that policy.

### Support Access Request Decision

Entity: `SupportAccessRequestDocument.decision`

Statuses: `APPROVED`, `DENIED`.

Allowed: decision is set at creation after policy evaluation. No transition after
creation was found.

### Support Session Status

Entity: `SupportSessionDocument`

Statuses: `ACTIVE`, `ENDED`, `EXPIRED`, `REVOKED`, `SECURITY_TERMINATED`.

| Transition | Trigger | Actor | Side effects |
| --- | --- | --- | --- |
| create `ACTIVE` | approved support session start | platform support actor | audit/outbox `SupportSessionStarted` |
| `ACTIVE` -> `ENDED` | end own session | session owner | audit/outbox |
| `ACTIVE` -> `REVOKED` | revoke session, disable/archive policy | platform support admin/service | audit/outbox |
| `ACTIVE` -> `EXPIRED` | support expiry job | system worker | audit/outbox |
| `ACTIVE` -> `SECURITY_TERMINATED` | runtime security mismatch | support resolver/service | fail-closed denial; audit where possible |

Forbidden: terminal support session statuses do not reactivate. Runtime requests
with invalid/expired/revoked/security-terminated sessions are denied.

## Exports / Retention / Deletion

### Workspace Export Status

Entity: `WorkspaceExportRequestDocument`

Statuses: `PENDING`, `PROCESSING`, `READY`, `FAILED`, `EXPIRED`.

Allowed: create `PENDING`; `PENDING` or stale `PROCESSING` -> `PROCESSING` by
worker claim; `PROCESSING` -> `READY` after artifact generation; `PROCESSING` ->
`FAILED` on generation failure; `READY` -> `EXPIRED` by expiry job or workspace
deletion approval; `PENDING`/`PROCESSING` -> `FAILED` on deletion approval.

Forbidden: ready/failed/expired exports do not reprocess through public routes;
download requires `READY` and unexpired artifact.

### Retention Warning Status

Entity: `RetentionWarningMarkerDocument.status`

Status: `EMITTED`.

Allowed: warning markers are created directly as emitted by retention warning
job. No transitions were found.

### Workspace Deletion Status

Entity: `WorkspaceDeletionRequestDocument`

Statuses: `PENDING_APPROVAL`, `POSTPONED`, `CANCELLED`, `APPROVED`,
`PROCESSING`, `FAILED`, `COMPLETED`.

| Transition | Trigger | Actor | Side effects |
| --- | --- | --- | --- |
| create `PENDING_APPROVAL` | retention worker eligibility | system worker | audit/outbox `WorkspaceDeletionRequested` |
| `PENDING_APPROVAL` or `POSTPONED` -> `APPROVED` | approve route | platform deletion admin | subscription deletion lock, workspace `RESTRICTED`, active exports terminated |
| `PENDING_APPROVAL` or `POSTPONED` -> `POSTPONED` | postpone route | platform deletion admin | reviewAfter set |
| `PENDING_APPROVAL` or `POSTPONED` -> `CANCELLED` | cancel route or subscription reactivation before approval | platform admin/system | audit/outbox |
| `POSTPONED` -> `PENDING_APPROVAL` | review-postponed job when reviewAfter due | system worker | status/version update |
| `APPROVED`, `FAILED`, or stale `PROCESSING` -> `PROCESSING` | deletion worker claim | system worker | processing lease and attempt count |
| `PROCESSING` -> `FAILED` | deletion processor error | system worker | retryable failure metadata |
| `PROCESSING` -> `COMPLETED` | deletion processor finalization | system worker | workspace `ARCHIVED`, liveDataDeletedAt/tombstone evidence |

Forbidden: cancelled/completed deletion requests are terminal. Approved deletion
locks the workspace/subscription and blocks normal tenant operations.

### Deletion Checkpoint State

Entity: `DeletionCheckpoint.state`

Statuses: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`.

Allowed: checkpoints are initialized pending; deletion processor marks a step
running, completed, or failed with cursor/attempt data. Failed deletion requests
can be claimed again and resumed from checkpoint state.

## Dashboards / Analytics

Analytics has no dedicated persisted status enum and no analytics projection
lifecycle in V1. Stage 18 routes derive state from source module statuses:
relationship status, program/workout/nutrition/check-in/file/document statuses,
and workspace/branch/membership state. Analytics reads can write sensitive audit
but do not emit analytics status transitions.

## Statuses Found But Not Treated As Lifecycle Machines

These values are important enum-like contracts but are not lifecycle state
machines:

- Permission effects: `ALLOW`, `DENY`
- Permission scopes/contexts and subject types
- Billing periods and subscription term sources
- Training/nutrition/progress/check-in field/source/category enums
- File classifications, document categories, upload purposes, subject types, file
  origins
- Notification channels and categories
- Support target/context/session type values
- Export format/system code values
- Retention warning offset values and deletion checkpoint step ids

## Evidence Checked

- `src/modules/**/**.types.ts`
- `src/modules/**/**.repository.ts`
- `src/modules/**/**.service.ts`
- `src/modules/**/**.routes.ts`
- `src/modules/**/**.jobs.ts`
- `src/worker/main.ts`
- Stage tests from auth foundation through Stage 18 analytics
- `docs/v1/backend-module-inventory.md`
- `docs/v1/module-business-flows.md`
- `docs/v1/cross-module-workflows.md`
