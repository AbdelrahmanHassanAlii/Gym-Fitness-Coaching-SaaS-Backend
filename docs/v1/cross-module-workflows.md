# V1 Cross-Module Workflow Guide

Issue: V1-DOC-03 / GitHub #3

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Depends on:

- `docs/v1/backend-module-inventory.md`
- `docs/v1/module-business-flows.md`

## Source Of Truth

This guide documents cross-module workflows implemented by the locked Stage 18
backend. Source code, route definitions, schemas, services, repositories,
permission registry/access-control code, tests, migrations, worker registration,
audit/outbox code, and the V1 module inventory are authoritative over generated
OpenAPI, earlier planning docs, and previous summaries.

This guide is not the full state-machine reference, permission matrix, frontend
API integration guide, or error catalog. Later V1 issues own those artifacts.

## Shared Cross-Module Runtime

- Fastify route handlers validate request shape and attach request context.
- `registerSupportAccessContext` resolves `x-support-session-id` before route
  handlers where support access is configured.
- `requireAuth`, `requireAccess`, or service-level access checks authorize the
  actor before domain writes.
- Idempotent commands use `container.idempotency.runInTransaction` or
  `runInTransactionForActor`; not every mutating route is idempotency-wrapped.
- Transactional domain writes use `UnitOfWork` / MongoDB transactions.
- Business audit and outbox writes are usually performed inside the same
  transaction as the domain write.
- `src/worker/main.ts` runs the outbox processor plus subscription, check-in,
  file, export, notification, retention, and support-access jobs.
- Outbox handlers registered in the worker are notification handlers and trainee
  relationship reconciliation handlers.

## Confirmed Workflows

### 1. Platform Workspace Creation -> Owner Membership -> Access

**Trigger:** `POST /api/v1/platform/workspaces`.

**Actor:** Authenticated platform actor with platform workspace-management access.

**Preconditions:** Target owner user exists and is `ACTIVE`; platform actor passes
platform access checks.

**Modules involved:** Workspace / Platform / Branches / Memberships, Auth /
Identity, Permissions / Access Control, Audit, transactional outbox.

**Sequence:**

1. Route authenticates the actor and calls workspace application service.
2. Service resolves platform access and target owner user.
3. `UnitOfWork.withTransaction` creates the workspace.
4. Service creates an active owner workspace membership with `GYM_OWNER` for gym
   workspaces or `TRAINER` for independent trainer workspaces.
5. Service writes `WorkspaceCreated` business audit.
6. Service writes `WorkspaceCreated` outbox event with owner membership id.
7. Route returns safe workspace and owner membership DTOs.

**Transaction boundaries:** Workspace creation, owner membership creation, audit,
and outbox write occur in one transaction.

**Data written:** `workspaces`, `workspace_memberships`, `audit_events`,
`outbox_events`.

**Data read:** Target `users`, platform membership/access state.

**Events/outbox:** `WorkspaceCreated`.

**Notifications:** No notification registry entry was found for
`WorkspaceCreated`; the outbox event is still persisted for registered handlers.

**Audit:** `WorkspaceCreated`.

**Failure behavior:** Inactive/missing owner user fails before transaction writes;
transaction rollback applies if audit/outbox or a domain write fails.

**Idempotency:** The direct platform workspace creation service is not wrapped in
the central idempotency service.

**Concurrency:** Repository uniqueness and transaction semantics protect
workspace/membership creation. No public `expectedVersion` is used.

**Frontend sequence:** Platform admin screen selects an active owner user -> sends
workspace create request -> displays returned workspace and owner membership.

### 2. Public Lead Capture -> Lead Conversion -> Owner Activation

**Trigger:** `POST /api/v1/public/leads`, then
`POST /api/v1/platform/leads/:leadId/convert`, then
`POST /api/v1/public/owner-activations/complete` or invitation acceptance for
owner activation.

**Actor:** Public lead submitter, platform lead/commercial actor, then owner
activation user.

**Preconditions:** Lead is in a conversion-eligible state; platform actor has lead
conversion permissions and any needed commercial override permissions; activation
token and verification challenge are valid.

**Modules involved:** Leads / Owner Activation, Auth / Identity, Workspace /
Platform / Branches / Memberships, Permissions / Access Control, Subscriptions /
Payments / Entitlements, Audit, transactional outbox.

**Sequence:**

1. Public lead submission validates input, creates/updates lead state, and writes
   lead audit/outbox.
2. Platform conversion route uses idempotency for conversion requests.
3. Lead service resolves or creates pending owner identity.
4. Service creates a `PENDING_ACTIVATION` workspace from lead data.
5. Service ensures the owner system profile and creates invited owner membership.
6. Service creates an `OWNER_ACTIVATION` invitation with token digest.
7. Commercial service starts a trial or creates a pending activation subscription
   intent.
8. Lead is marked converted using `expectedVersion`.
9. Service writes `LeadConverted` audit/outbox and `OwnerActivationRequired`
   outbox.
10. Owner activation verifies token/challenge, activates identity/workspace/
    membership, and activates the pending commercial intent where applicable.

**Transaction boundaries:** Conversion runs inside the idempotency transaction.
Owner activation uses transaction boundaries across identity, invitation,
workspace membership, workspace, subscription, audit, and outbox writes.

**Data written:** `leads`, `users`, `workspaces`, `workspace_memberships`,
`invitations`, permission profile assignments, subscription collections,
`audit_events`, `outbox_events`.

**Data read:** Lead, identity, workspace profile definitions, plan/version,
subscription/usage state.

**Events/outbox:** `LeadCreated`, `LeadUpdated`, `LeadStatusChanged`,
`LeadConverted`, `OwnerActivationRequired`, `OwnerActivated`.

**Notifications:** No notification registry entry was found for lead/owner
activation events in Stage 18.

**Audit:** Lead create/update/status/convert, owner activation reissue, and owner
activation completion write audit evidence.

**Failure behavior:** Invalid lead state, stale `expectedVersion`, invalid
activation token/challenge, inactive user/workspace, subscription failure, audit
failure, or outbox failure aborts the operation.

**Idempotency:** Lead conversion is idempotency-wrapped. Public lead creation and
some lead state changes have their own route behavior; later FE documentation must
derive route-by-route idempotency from routes, not OpenAPI alone.

**Concurrency:** Lead version protects conversion/status updates; subscription
and owner activation writes are transactional.

**Frontend sequence:** Public capture form submits lead -> platform lead view
converts with idempotency key and current lead version -> frontend shows owner
activation token delivery state -> owner completes activation -> workspace becomes
usable.

**Important correction:** No backend evidence was found for a "lead -> trainee"
conversion workflow. Implemented lead conversion creates workspace/owner
activation, not a coaching relationship.

### 3. Staff Invitation Acceptance -> Membership -> Branch Assignments

**Trigger:** `POST /api/v1/workspaces/:workspaceId/staff/invitations`, followed
by `POST /api/v1/invitations/accept`.

**Actor:** Workspace owner/manager or authorized staff inviter, then invited user.

**Preconditions:** Inviter has staff invitation access; staff quota is available;
invited user owns the verified invitation email/phone; workspace is active for
staff invitation acceptance.

**Modules involved:** Workspace / Platform / Branches / Memberships,
Subscriptions / Payments / Entitlements, Permissions / Access Control, Audit,
transactional outbox, Notifications where registered events apply.

**Sequence:**

1. Inviter request passes workspace access and entitlement checks.
2. Service creates or supersedes invitation state and reserves staff slot where
   implemented.
3. Invitation accept authenticates the invited user.
4. Service hashes token and reloads pending invitation.
5. Service verifies user owns invitation identifier.
6. Transaction creates or reactivates membership from invitation.
7. For each invitation branch id, service verifies active branch and creates
   active branch assignment.
8. Invitation is marked accepted.
9. Service writes membership activation audit/outbox.

**Transaction boundaries:** Invitation creation and acceptance each use
transactional service flows. Acceptance writes membership, branch assignments,
invitation state, audit, and outbox together.

**Data written:** `invitations`, `workspace_memberships`,
`membership_branch_assignments`, `workspace_usage` where staff quota is reserved,
`audit_events`, `outbox_events`.

**Data read:** User, workspace, invitation, branches, memberships, subscription
usage/limits.

**Events/outbox:** `StaffInvited`, `StaffMembershipActivated`,
`StaffInvitationRevoked`.

**Notifications:** The notification registry contains entries for some membership
and permission events, but no dedicated `StaffInvited` entry was found.

**Audit:** Staff invitation, acceptance, revocation, and branch assignment
changes write audit.

**Failure behavior:** Invalid/expired token, identifier mismatch, inactive
workspace, inactive/archived branch, quota failure, or audit/outbox failure blocks
acceptance.

**Idempotency:** Invitation acceptance route is idempotency-wrapped in the
workspace routes.

**Concurrency:** Invitation pending state and branch/membership writes happen in a
transaction; membership access versions are used by related staff/permission
updates.

**Frontend sequence:** Staff admin creates invitation -> sends/uses token outside
backend -> invited user signs in/verifies contact -> frontend submits token with
idempotency key -> workspace appears in `/me/workspaces`.

### 4. Membership / Branch / Permission Changes -> Relationship Eligibility

**Trigger:** Staff branch assignment/unassignment or permission profile/access
replacement.

**Actor:** Owner/manager/staff permission administrator.

**Preconditions:** Active workspace membership for actor; target membership and
branch are in the same workspace; actor has staff branch or permission-management
access.

**Modules involved:** Workspace / Platform / Branches / Memberships, Permissions
/ Access Control, Trainee Relationships, Audit, transactional outbox, worker
outbox processor.

**Sequence:**

1. Route authorizes workspace branch or permission-management action.
2. Service validates target membership, branch, profile, or grants.
3. Transaction writes branch assignment or permission/profile state.
4. Service writes audit/outbox event.
5. Worker `OutboxProcessor` dispatches registered trainee outbox handlers.
6. Trainee service reconciles trainer eligibility where handler/event indicates a
   primary trainer might no longer be valid.
7. Relationship state can move to needs reassignment when eligibility is lost.

**Transaction boundaries:** The staff/permission mutation has its own
transaction. Downstream trainee reconciliation is asynchronous in a later outbox
handler transaction.

**Data written:** `membership_branch_assignments`, `permission_profiles`,
`access_grants`, membership profile/access versions, `audit_events`,
`outbox_events`, and possibly `coaching_relationships` /
`trainee_staff_assignments` during reconciliation.

**Data read:** Memberships, branches, permission profiles/grants, relationships,
assignments.

**Events/outbox:** Workspace branch assignment events and
`MembershipPermissionProfilesReplaced`; trainee handlers are registered in
`src/worker/main.ts`.

**Notifications:** Notification registry includes
`MembershipPermissionProfilesReplaced` and `TraineeNeedsReassignment`.

**Audit:** Both original staff/permission change and trainee reconciliation write
audit where implemented.

**Failure behavior:** The initiating request can succeed even if asynchronous
outbox processing has not yet reconciled relationships. Handler failures remain
eventual-consistency failures for retry/inspection.

**Idempotency:** Permission/branch operations are generally not all
idempotency-wrapped. Later frontend documentation must verify each route.

**Concurrency:** Permission profile/grant replacement uses expected version or
access version. Trainee reconciliation uses relationship versions.

**Frontend sequence:** Staff admin changes permissions/branches -> UI refreshes
effective access and affected trainee lists after the write -> downstream
relationship reassignment/notifications may appear after worker processing.

### 5. Trainee Invitation / Referral -> Coaching Relationship -> Staff Assignment

**Trigger:** Trainee invitation creation/reissue/acceptance, referral join, or
workspace staff acceptance of a pending relationship.

**Actor:** Authorized staff inviter/approver, trainee user, worker for downstream
handlers.

**Preconditions:** Active workspace; trainee slot entitlement available;
relationship does not already exist in an incompatible state; branch/home branch
and primary trainer are eligible.

**Modules involved:** Trainee Relationships, Workspace / Platform / Branches /
Memberships, Auth / Identity, Subscriptions / Payments / Entitlements,
Permissions / Access Control, Audit, transactional outbox, Notifications.

**Sequence:**

1. Staff invitation flow creates `TRAINEE_INVITATION` with home branch and
   proposed primary trainer context.
2. Trainee acceptance authenticates user and validates verified invitation
   identifier.
3. Service verifies active workspace and existing relationship state.
4. Service ensures trainee membership and reserves trainee slot.
5. Service creates or activates coaching relationship.
6. Service assigns primary trainer in the same transaction when configured.
7. Invitation is accepted.
8. Service writes `TraineeActivated` audit/outbox.
9. Referral join creates a `PENDING` relationship for later staff acceptance.

**Transaction boundaries:** Invitation acceptance and pending acceptance use
transactional service flows. Relationship, membership, assignment, entitlement,
invitation, audit, and outbox writes are grouped.

**Data written:** `invitations`, `workspace_memberships`,
`coaching_relationships`, `trainee_staff_assignments`, `workspace_usage`,
`audit_events`, `outbox_events`.

**Data read:** Workspace, user, invitation, branch, membership, trainer
eligibility, subscription usage/limits.

**Events/outbox:** `TraineeInvited`, `TraineeActivated`,
`TraineeRelationshipRequested`, `TraineeNeedsReassignment`, assignment/lifecycle
events emitted by trainee service.

**Notifications:** Registry includes `TraineeNeedsReassignment`; other trainee
events may persist without a notification entry.

**Audit:** Relationship request/activation/assignment/lifecycle changes write
audit.

**Failure behavior:** Existing active relationship, inactive workspace, invalid
branch, invalid primary trainer, quota conflict, stale relationship version, or
outbox/audit failure blocks the transaction.

**Idempotency:** Several trainee mutation routes are idempotency-wrapped,
including invitation/pending relationship commands in routes. Route-by-route
frontend contract is deferred to FE issues.

**Concurrency:** Relationship `version` / `expectedVersion` protects lifecycle
and assignment changes.

**Frontend sequence:** Staff invites trainee or trainee enters referral code ->
trainee accepts or request remains pending -> staff accepts pending relationship
with expected version -> trainee profile becomes active and assigned staff views
include it.

### 6. Program Activation -> Progress Initialization -> Workout Execution

**Trigger:** Program draft/revision creation followed by
`POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/activate`.

**Actor:** Trainer/assistant/authorized staff with program activation access.

**Preconditions:** Relationship training lifecycle is active; entitlement allows
training writes; program is `DRAFT`; expected version matches; revision has at
least one executable day; exercise snapshots are still usable.

**Modules involved:** Training, Trainee Relationships, Workspace / Memberships,
Subscriptions / Entitlements, Permissions / Access Control, Workouts / PRs,
Audit, transactional outbox, Notifications.

**Sequence:**

1. Route authenticates actor and calls training service.
2. Service loads relationship and authorizes `ProgramsActivate`.
3. Entitlement service checks training write access.
4. Service pre-reads any active program for conflict detection.
5. Transaction guards relationship training lifecycle.
6. Service validates draft program, version, revision, executable days, and
   exercise usability.
7. If an active program exists, service guards no in-progress workout transition,
   replaces the active program, and writes replacement audit/outbox.
8. Service activates the draft program.
9. Service creates program progress at first executable sequence and writes
   `INITIALIZED` progress event.
10. Service writes `ProgramActivated` audit/outbox.

**Transaction boundaries:** Replacement, activation, progress initialization,
audit, and outbox occur inside the activation transaction.

**Data written:** `programs`, `program_progress`, `program_progress_events`,
`audit_events`, `outbox_events`.

**Data read:** Relationship, program, program revision, active program, exercises,
actor membership, entitlement state.

**Events/outbox:** `ProgramReplaced`, `ProgramActivated`, `ProgramUpdated`.

**Notifications:** Notification registry includes `ProgramActivated` and
`ProgramUpdated`.

**Audit:** Program replacement/activation/update audit events are written.

**Failure behavior:** Inactive/ended relationship lifecycle, no executable day,
stale version, competing active program, in-progress workout for active program,
unusable exercise, entitlement denial, audit/outbox failure.

**Idempotency:** Activation route is idempotency-wrapped in training routes.

**Concurrency:** Program `version` / `expectedVersion` and active-program conflict
checks protect activation.

**Frontend sequence:** Staff edits draft/revision -> activates with
`expectedVersion` and idempotency key -> frontend reads current program/progress
and starts workout execution from progress current day.

### 7. Workout Completion -> Program Progress -> Personal Records -> Analytics

**Trigger:** `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/complete`.

**Actor:** Trainee SELF or authorized staff, depending on workout permission and
relationship scope.

**Preconditions:** Relationship workout lifecycle is open; entitlement allows
training writes; workout is not completed/abandoned; workout version matches; the
workout day is the current program progress day.

**Modules involved:** Workouts / PRs, Training, Trainee Relationships,
Progress/analytics source data, Permissions / Access Control, Subscriptions /
Entitlements, Audit, transactional outbox, Notifications, Dashboards / Analytics.

**Sequence:**

1. Route authorizes relationship-scoped `WorkoutsComplete`.
2. Service asserts training write entitlement.
3. Transaction guards relationship workout lifecycle.
4. Service loads workout and rejects completed/abandoned state.
5. Repository marks workout completed using expected version.
6. Service loads program progress and validates current day sequence.
7. Service loads program revision and computes next executable day.
8. Training repository advances progress and writes progress event.
9. Service recalculates personal records from workout actuals and writes PR
   events where achievements change.
10. Service writes `WorkoutCompleted` audit/outbox.
11. Analytics later reads workout/progress/PR collections at request time.

**Transaction boundaries:** Workout completion, progress advancement, PR
recalculation, audit, and outbox are inside one transaction.

**Data written:** `workout_sessions`, `program_progress`,
`program_progress_events`, `personal_record_events`, `audit_events`,
`outbox_events`.

**Data read:** Relationship, workout, program progress, program revision,
exercise history/PR sources, entitlement state.

**Events/outbox:** `WorkoutCompleted`, `WorkoutCorrected` for corrections.

**Notifications:** Notification registry includes `WorkoutCompleted` and
`WorkoutCorrected`.

**Audit:** `WorkoutCompleted`; corrections write `WorkoutCorrected`.

**Failure behavior:** Completed/abandoned workout, missing progress/revision, day
not current, stale workout version, entitlement/access denial, or audit/outbox
failure rolls back.

**Idempotency:** Workout completion route is idempotency-wrapped.

**Concurrency:** Workout version and progress version protect completion and
progress advancement.

**Frontend sequence:** Workout screen patches actuals as needed -> complete with
expected version and idempotency key -> refresh program progress, PRs, and
dashboard/analytics reads.

### 8. Nutrition Plan Activation -> Daily Tracking / Adherence / Analytics

**Trigger:** Nutrition plan creation/revision followed by
`POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans/:planId/activate`.

**Actor:** Nutritionist, trainer, or authorized staff with nutrition plan
activation access.

**Preconditions:** Relationship nutrition lifecycle is open; entitlement allows
nutrition writes; plan is `DRAFT`; expected version matches; responsible staff
and food references remain eligible.

**Modules involved:** Nutrition, Trainee Relationships, Progress daily tracking,
Subscriptions / Entitlements, Permissions / Access Control, Audit, transactional
outbox, Notifications, Dashboards / Analytics.

**Sequence:**

1. Route/service authorizes relationship-scoped `NutritionPlansActivate`.
2. Entitlement service checks nutrition write access.
3. Service pre-reads any active plan for conflict detection.
4. Transaction guards nutrition lifecycle.
5. Service validates draft plan, version, responsible membership, current
   revision, and referenced foods.
6. Existing active plan is replaced if the same pre-existing active plan is still
   current.
7. Service activates the draft plan.
8. Service writes audit and `NutritionPlanActivated` outbox payload with
   relationship, plan, revision, and replaced plan id when applicable.
9. Daily tracking and analytics read active plan/revision and tracking entries
   later.

**Transaction boundaries:** Active plan replacement, activation, audit, and outbox
are in one transaction.

**Data written:** `nutrition_plans`, `audit_events`, `outbox_events`.

**Data read:** Relationship, nutrition plan/revision, foods, responsible
membership, active plan, daily tracking in later reads.

**Events/outbox:** `NutritionPlanActivated`, `NutritionPlanUpdated`.

**Notifications:** Notification registry includes `NutritionPlanActivated` and
`NutritionPlanUpdated`.

**Audit:** `NutritionPlanReplaced`, `NutritionPlanActivated`.

**Failure behavior:** Invalid status/version, competing active plan, ineligible
responsible staff, unusable foods, relationship lifecycle closed, entitlement
denial, audit/outbox failure.

**Idempotency:** Nutrition activation route is idempotency-wrapped.

**Concurrency:** Plan `version` / `expectedVersion` and active-plan conflict
checks protect activation.

**Frontend sequence:** Nutritionist edits draft/revision -> activates with
expected version and idempotency key -> frontend reads active plan plus daily
tracking/adherence analytics.

### 9. Check-In Generation -> Notification -> Submission -> Review

**Trigger:** Check-in assignment creation plus worker
`CheckInJobRunner.runDueJobs`, followed by submit/review routes.

**Actor:** System worker, trainee SELF, authorized reviewing staff.

**Preconditions:** Active assignment/template/revision; workspace can produce
tenant data; relationship check-in lifecycle is open; submitter is trainee SELF;
reviewer is not trainee SELF.

**Modules involved:** Check-ins, Trainee Relationships, Workspace, Permissions /
Access Control, Subscriptions / Entitlements, Audit, transactional outbox,
Notifications.

**Sequence:**

1. Check-in assignment exists for relationship/template.
2. Worker calls `generateDueInstances`.
3. For each candidate assignment, transaction guards assignment, workspace, and
   relationship.
4. Service creates `UPCOMING`, `DUE`, or `OVERDUE` check-in instance for eligible
   period.
5. Service writes system audit and `CheckInDue` / `CheckInOverdue` outbox for due
   or overdue instances.
6. Outbox processor invokes notification handlers for registered check-in event
   types.
7. Trainee submits due/overdue instance through submit route with expected
   version.
8. Service validates SELF, responses, status, version, writes audit/outbox
   `CheckInSubmitted`.
9. Staff reviews submitted instance with expected version, writes audit/outbox
   `CheckInReviewed`.

**Transaction boundaries:** Generation, submit, and review are separate
transactions. Notification creation is asynchronous after outbox processing.

**Data written:** `checkin_instances`, `notifications`,
`notification_deliveries`, `audit_events`, `outbox_events`.

**Data read:** Assignments, templates/revisions, relationship, workspace,
entitlement state, notification registry/preferences/recipients.

**Events/outbox:** `CheckInGenerated` audit only; `CheckInDue`,
`CheckInOverdue`, `CheckInSubmitted`, `CheckInReviewed` outbox.

**Notifications:** Registry includes `CheckInDue`, `CheckInOverdue`,
`CheckInSubmitted`, `CheckInReviewed`.

**Audit:** Generation, overdue transition, submit, and review write audit.

**Failure behavior:** Inactive workspace/relationship, no eligible period,
invalid status, stale version, non-SELF submit, trainee review attempt, invalid
responses, notification delivery provider failure. Delivery failure does not roll
back the already persisted source event.

**Idempotency:** Check-in submit route is idempotency-wrapped in routes; review
uses expected version but route-level idempotency must be verified in FE issues.

**Concurrency:** Check-in instance `version` / `expectedVersion` protects submit
and review.

**Frontend sequence:** Staff creates assignment -> frontend polls/list check-ins
or receives notification after worker -> trainee submits due/overdue instance ->
staff list shows submitted item -> staff reviews -> notification/read state
updates independently.

### 10. File / Document Upload -> Verification -> Notification / Download

**Trigger:** Upload intent route, external object upload, confirm route, optional
document route, download URL route.

**Actor:** Authorized workspace/relationship user; support actor where support
session is active.

**Preconditions:** File purpose/subject is authorized; storage quota is available;
object is uploaded to the exact reserved key; size/content type/checksum satisfy
intent; expected version matches.

**Modules involved:** Files / Documents, Storage provider, Workspace Usage /
Entitlements, Trainee Relationships, Permissions / Access Control, Support
Access, Audit, transactional outbox, Notifications, Exports where generated files
are used.

**Sequence:**

1. Actor creates upload intent; service authorizes purpose/subject and reserves
   storage quota.
2. Service writes upload intent and audit, then returns signed upload URL.
3. Client uploads object to storage provider.
4. Confirm route reloads intent, authorizes actor, checks pending status,
   `expectedVersion`, expiry, object existence, key, size, content type, and
   SHA-256 when provided.
5. Service creates active file, confirms intent, commits reserved storage usage,
   and writes audit.
6. Document creation links file/document metadata and emits `DocumentUploaded`
   where implemented.
7. Download URL route authorizes file/document access; sensitive downloads can
   require support-sensitive file access and write sensitive audit.

**Transaction boundaries:** Upload intent creation and confirmation run inside
route transactions. Object upload to external storage is outside the database
transaction. Download URL creation is a read plus signed URL/audit write.

**Data written:** `upload_intents`, `files`, `documents`,
`workspace_usage`, `audit_events`, `outbox_events` for document uploads.

**Data read:** Workspace/relationship/membership/access state, upload intent,
storage object metadata, file/document metadata, support session if present.

**Events/outbox:** `DocumentUploaded` for business document upload. Export file
events are owned by export workflow.

**Notifications:** Notification registry includes `DocumentUploaded`.

**Audit:** Upload intent create, file confirm, file delete/restore/purge, document
operations, sensitive download URL issuance.

**Failure behavior:** Quota exceeded, object missing, checksum unavailable or
mismatch, size/content-type mismatch, stale version, expired intent, sensitive
support denial, or audit failure blocks confirmation/download.

**Idempotency:** Upload intent/confirm routes are idempotency-wrapped where route
uses `container.idempotency`; confirmation also requires intent version.

**Concurrency:** Upload intent and file `version` / `expectedVersion` protect
confirmation/delete/restore/document changes.

**Frontend sequence:** Request upload intent -> upload object using URL -> confirm
with expected version and checksum semantics -> create/read document metadata ->
request download URL only when needed.

### 11. Support Session -> Effective Actor -> Sensitive Access

**Trigger:** `POST /api/v1/platform/support/access-requests` to start a session,
then workspace requests containing `x-support-session-id`.

**Actor:** Platform support user; effective tenant user/member where session uses
`USER_CONTEXT`; workspace support context where applicable.

**Preconditions:** Active platform user/session; matching support policy;
workspace/user/membership eligibility; requested duration and sensitive flags
allowed by policy; runtime security checks pass.

**Modules involved:** Support Access, Platform / Workspaces / Memberships,
Permissions / Access Control, Auth / Identity, Files / Documents, Analytics /
Progress / Check-ins sensitive reads, Audit, transactional outbox, Notifications.

**Sequence:**

1. Platform support actor starts session through idempotency-wrapped route.
2. Service authorizes support session start, evaluates policy, records access
   request, and either returns denial or creates active support session.
3. Service writes audit and support session outbox event.
4. Later requests include `x-support-session-id`.
5. Global support pre-handler resolves session, policy, target workspace/user/
   effective membership, and writes support context into request context.
6. Module access checks evaluate `WORKSPACE_SUPPORT` or `USER_CONTEXT` behavior.
7. Sensitive data/file operations call support-sensitive gates and write audit.
8. Worker expires sessions through `SupportAccessJobRunner.expireSessions`.

**Transaction boundaries:** Session start writes request/session/audit/outbox in
the idempotency transaction. Downstream business reads/writes have their own
transaction rules.

**Data written:** `support_access_requests`, `support_sessions`,
`audit_events`, `outbox_events`; sensitive access audit for downstream reads.

**Data read:** Portal policies, platform membership, auth session, workspace,
target user/membership, support session.

**Events/outbox:** `SupportSessionStarted`, `SupportSessionEnded`,
`SupportSessionRevoked`, `SupportSessionExpired`.

**Notifications:** Notification registry includes support session started, ended,
revoked, and expired.

**Audit:** Denied requests, started sessions, ended/revoked/expired sessions, and
sensitive downstream access write audit evidence.

**Failure behavior:** Policy denial returns access-request denial response;
invalid/expired/revoked session denies runtime request; read-only/support
sensitive restrictions deny downstream actions; audit failure can fail closed for
sensitive paths.

**Idempotency:** Support session start is idempotency-wrapped.

**Concurrency:** Policy/session revisions protect support lifecycle updates.
Session status/expiry is rechecked at runtime.

**Frontend sequence:** Support portal starts session -> stores session id for
that support workspace/user context -> sends `x-support-session-id` on eligible
workspace requests -> stops sending it when session ends/expires/revokes.

### 12. Subscription Expiry -> Retention Warning -> Deletion Lifecycle

**Trigger:** Subscription jobs mark commercial lifecycle; retention worker jobs
process expired subscriptions after configured retention windows.

**Actor:** System worker, then platform deletion admin for approval/postpone/
cancel commands.

**Preconditions:** Subscription is `EXPIRED` with `expiredAt`; retention warning
or deletion eligibility window is reached; workspace remains active; no active
deletion request already exists.

**Modules involved:** Subscriptions / Payments / Entitlements, Retention /
Deletion, Exports, Files / Documents, Workspace, Audit, transactional outbox,
Notifications.

**Sequence:**

1. Subscription job updates commercial lifecycle to expired where due.
2. Retention worker `sendWarnings` finds expired subscriptions and creates
   warning markers for due offsets.
3. Warning transaction writes retention marker, audit, and `RetentionWarningDue`
   outbox.
4. Retention worker `createDeletionRequests` creates
   `PENDING_APPROVAL` deletion requests when eligibility is reached.
5. Platform deletion admin can approve, postpone, or cancel with expected
   version.
6. Approved deletions are claimed by worker for processing.
7. Deletion processor terminates active exports, marks files/documents, deletes
   tenant data in manifest targets, verifies no live workspace data, and finalizes
   tombstone/evidence.

**Transaction boundaries:** Warning, deletion request creation, admin lifecycle
commands, and deletion processor steps use separate transactions. Long deletion
processing is checkpointed.

**Data written:** `retention_warning_markers`,
`workspace_deletion_requests`, `workspace_export_requests`, file/document
metadata, many tenant collections during deletion, `audit_events`,
`outbox_events`.

**Data read:** Subscriptions, workspaces, active exports, file/payment proof
evidence, deletion manifest collections.

**Events/outbox:** `RetentionWarningDue`, `WorkspaceDeletionRequested`,
`WorkspaceDeletionPostponed`, `WorkspaceDeletionCancelled`,
`WorkspaceDeletionApproved`, `WorkspaceDeletionCompleted`.

**Notifications:** Notification registry includes retention warning and deletion
requested/postponed/cancelled/approved. It also includes export events affected by
deletion processing.

**Audit:** Retention warning emitted, deletion request/lifecycle commands,
deletion processing/completion.

**Failure behavior:** If subscription is no longer expired, workspace is not
active, active deletion exists, or expected version is stale, the worker/admin
command skips or fails. Deletion processing failures mark failed state for later
review/retry.

**Idempotency:** Deletion approve route explicitly requires `Idempotency-Key` and
uses idempotency transaction. Other retention commands use expected version.

**Concurrency:** Deletion request `version` / `expectedVersion`, worker claims,
and checkpoint state protect lifecycle transitions.

**Frontend sequence:** Platform admin watches retention/deletion list -> warnings
arrive via notifications -> admin approves/postpones/cancels with current version
and idempotency where required -> status updates as worker progresses.

### 13. Workspace Export Request -> Generated Artifact -> Download

**Trigger:** `POST /api/v1/workspaces/:workspaceId/exports`, export worker, then
download URL route.

**Actor:** Authorized workspace exporter, export worker.

**Preconditions:** No support session for export request/download; workspace is
active and not deletion locked; actor has export permissions and active
membership; subscription lifecycle allows export.

**Modules involved:** Exports, Files / Documents, Storage provider, Workspace,
Subscriptions, Permissions / Access Control, Audit, transactional outbox,
Notifications, Retention/Deletion.

**Sequence:**

1. Export create route uses idempotency transaction.
2. Service authorizes `exports.workspace.create`, checks workspace, membership,
   subscription export eligibility, and deletion lock.
3. Service creates `PENDING` export request, writes audit and
   `WorkspaceExportRequested` outbox.
4. Export worker claims pending export.
5. Worker creates generated file intent, writes archive to temporary ZIP, uploads
   object to storage, and creates generated file metadata.
6. Worker marks export `READY` with artifact id/size/SHA and expiry.
7. Worker writes `WorkspaceExportReady` audit/outbox.
8. Download route verifies export is ready/unexpired and artifact file is active,
   then returns signed sensitive download URL and writes audit.

**Transaction boundaries:** Export request creation is transactional. Artifact
creation includes external file/storage work followed by a transaction marking
ready. Download URL is read plus audit write.

**Data written:** `workspace_export_requests`, `generated_file_intents`,
`files`, storage object, `audit_events`, `outbox_events`.

**Data read:** Workspace, memberships, subscription, domain collections included
in archive, generated file metadata.

**Events/outbox:** `WorkspaceExportRequested`, `WorkspaceExportReady`,
`WorkspaceExportFailed`, `WorkspaceExportExpired`.

**Notifications:** Notification registry includes export ready, failed, and
expired. It does not list `WorkspaceExportRequested`.

**Audit:** Export requested, ready, expired, download URL issued.

**Failure behavior:** Support session forbidden, workspace deletion lock,
subscription not exportable, generation/storage failure, export not ready,
expired artifact, or missing file blocks flow.

**Idempotency:** Export creation is idempotency-wrapped.

**Concurrency:** Worker claim/lease semantics protect generation; export status
and artifact checks protect download.

**Frontend sequence:** User requests export with idempotency key -> frontend polls
list/detail -> notification may indicate ready -> frontend requests download URL
only after `READY`.

### 14. Domain Event -> Notification Creation -> Delivery Retry

**Trigger:** Any outbox event type registered in
`src/modules/notifications/notification.registry.ts`.

**Actor:** Source module service, outbox worker, notification delivery worker,
recipient user.

**Preconditions:** Source mutation successfully writes outbox event; event type
has registry entries; recipient resolution finds active users; preferences allow
channels.

**Modules involved:** Source domain module, transactional outbox, Notifications,
Auth / Identity, Workspace / Relationships for recipient resolution, email/push
providers.

**Sequence:**

1. Source service writes domain event to `outbox_events` in its transaction.
2. Worker `OutboxProcessor.processOne` dispatches event to notification handlers.
3. Notification service checks registry entries and whether event is still
   meaningful.
4. Service resolves recipients from event/workspace/relationship source.
5. Service inserts in-app notifications and email/push delivery records with
   dedupe/logical delivery keys.
6. Notification job acquires `notifications.delivery` lease and claims due
   delivery records.
7. Delivery worker calls provider and updates delivery status to sent, retrying,
   failed, or cancelled.

**Transaction boundaries:** Source event write is in source transaction.
Notification creation/delivery processing is asynchronous and independent.

**Data written:** `outbox_events`, `notifications`,
`notification_deliveries`, provider metadata/status fields.

**Data read:** Notification registry, identity users, workspace/default language,
preferences, push devices, event source collections for recipient resolution.

**Events/outbox:** Registered event types include check-ins, documents, workouts,
programs, nutrition, trainee reassignment, permission profile replacement,
subscription frozen, support session lifecycle, retention/deletion, and export
events.

**Notifications:** This workflow owns notification creation.

**Audit:** Source module owns source audit. Notification preference updates write
audit; delivery processing itself updates delivery records.

**Failure behavior:** Source transaction rollback prevents event creation.
Notification handler/provider failures do not rollback source business change and
are retried/cancelled according to delivery status logic.

**Idempotency:** Notification dedupe keys and delivery logical keys prevent
duplicate notification/delivery rows for the same event/recipient/type.

**Concurrency:** Delivery claiming and job leases protect delivery processing.

**Frontend sequence:** Frontend reads `/me/notifications`, marks read/read-all,
and separately observes source domain state. It should not assume external
delivery success equals in-app read state.

### 15. Dashboard / Analytics Aggregation From Source Modules

**Trigger:** Dashboard or analytics read routes.

**Actor:** Owner, manager, trainer, assistant trainer, nutritionist, trainee SELF,
or support effective actor where allowed.

**Preconditions:** Authenticated actor; dashboard/analytics permission; eligible
workspace/branch/relationship scope; valid cursor/range/query; sensitive audit
write succeeds when required.

**Modules involved:** Dashboards / Analytics, Permissions / Access Control,
Workspace / Branches / Memberships, Trainee Relationships, Training, Workouts /
PRs, Nutrition, Progress, Check-ins, Files / Documents, Audit.

**Sequence:**

1. Route authenticates actor and calls analytics service.
2. Service resolves workspace query access or relationship access through access
   control.
3. Service computes workspace timezone range/defaults.
4. Repository reads source collections for relationships, assignments, branches,
   memberships, workouts, programs/progress, PR events, nutrition plans/revisions,
   measurements, progress photos, daily tracking, check-ins, and documents.
5. Service writes sensitive audit for trainer/gym/relationship dashboard where
   implemented.
6. Service returns aggregated DTO. No analytics projection is written.

**Transaction boundaries:** Read-only aggregation; no business transaction for
analytics projection. Sensitive audit write is a separate audit write.

**Data written:** `audit_events` for sensitive analytics/dashboard reads.

**Data read:** Source module collections listed in the module inventory.

**Events/outbox:** None emitted by analytics reads.

**Notifications:** None directly.

**Audit:** Sensitive dashboard/analytics access writes audit.

**Failure behavior:** Permission/scope denial, invalid branch cursor pairing,
invalid category cursor, restricted workspace/support denial, invalid relationship
scope, or audit failure can fail the request.

**Idempotency:** Read-only; no idempotency key.

**Concurrency:** Results reflect current persisted source data at read time; no
snapshot/projection version is exposed.

**Frontend sequence:** Frontend selects dashboard/analytics screen -> sends
workspace/relationship/range/cursor query -> renders sections based on returned
visibility/null/empty values -> uses source module screens for mutation.

## Unverified Or Not Implemented Candidate Flows

These candidate flows were explicitly checked because they appeared in planning
examples or are easy to infer incorrectly:

- `UNVERIFIED — REQUIRES FOLLOW-UP`: A public lead converting directly into a
  trainee relationship. Repository evidence confirms lead conversion creates
  workspace/owner activation, not a coaching relationship.
- `UNVERIFIED — REQUIRES FOLLOW-UP`: A materialized analytics projection or
  analytics collection. Repository evidence confirms Stage 18 analytics is
  read-time aggregation over source collections.
- `UNVERIFIED — REQUIRES FOLLOW-UP`: Notification receipts separate from
  notification delivery/read state. Stage 14 types expose notifications,
  preferences, deliveries, and push devices; no receipt collection was found.
- `UNVERIFIED — REQUIRES FOLLOW-UP`: OpenAPI as a complete behavioral source for
  idempotency or support sessions. Source code confirms route/service behavior is
  authoritative; later FE issues must verify route-by-route contracts.

## Evidence Checked

- `docs/v1/backend-module-inventory.md`
- `docs/v1/module-business-flows.md`
- `src/api/build-app.ts`
- `src/worker/main.ts`
- `src/bootstrap/app-container.ts`
- `src/modules/workspaces/workspace.service.ts`
- `src/modules/leads/lead.service.ts`
- `src/modules/trainees/trainee.service.ts`
- `src/modules/training/training.service.ts`
- `src/modules/workouts/workout.service.ts`
- `src/modules/nutrition/nutrition.service.ts`
- `src/modules/checkins/checkin.service.ts`
- `src/modules/files/file.service.ts`
- `src/modules/support-access/support-access.service.ts`
- `src/modules/exports/export.service.ts`
- `src/modules/retention/retention.service.ts`
- `src/modules/notifications/notification.registry.ts`
- `src/modules/notifications/notification.service.ts`
- `src/modules/analytics/analytics.service.ts`
- `src/modules/**/**.routes.ts`
- `src/modules/**/**.repository.ts`
- `src/modules/**/**.types.ts`
