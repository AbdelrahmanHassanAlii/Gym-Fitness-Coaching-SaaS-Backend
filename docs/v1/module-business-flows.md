# V1 Module Business Flow Guide

Issue: V1-DOC-02 / GitHub #2

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Depends on: `docs/v1/backend-module-inventory.md`

## Source Of Truth

This guide documents actual request-to-persistence flows from the locked Stage 18
backend implementation. Route files, schemas, services, repositories, permission
registry/access-control code, tests, migrations, worker registration, audit/outbox
code, and the V1 module inventory are authoritative over generated OpenAPI,
earlier planning docs, and previous summaries.

This guide is intentionally not the full state-machine reference, permission
matrix, frontend API guide, or error catalog. Later V1 issues own those artifacts.

## Shared Flow Terms

- **Actor:** The authenticated user or public caller initiating a request.
- **User:** Identity record in `users`.
- **Platform membership:** Platform-level membership used for platform admin
  context.
- **Workspace membership:** Membership of a user in a workspace.
- **Relationship:** Coaching relationship record in `coaching_relationships`;
  `relationshipId` is not the trainee user id.
- **Support context:** Request context derived from `x-support-session-id` by the
  global support pre-handler before route handlers run.
- **Transaction:** MongoDB transaction through `UnitOfWork`. Mutations wrapped by
  `container.idempotency.runInTransaction` complete domain writes, audit/outbox,
  and idempotency state together.
- **CAS:** `expectedVersion` checks against document `version`, `revision`, or
  access version fields.

## Shared Request Pipeline

Most V1 API requests follow this shape:

1. Fastify route receives request and validates schema.
2. Request context plugin provides correlation, actor/session, workspace/support
   context, IP, and user agent.
3. `registerSupportAccessContext` resolves `x-support-session-id` when present.
4. `requireAuth` enforces session/user requirements unless the route is public.
5. `requireAccess` or service-level access checks resolve platform/workspace,
   branch, relationship, SELF, assigned, and support-sensitive permissions.
6. Application service performs domain eligibility, entitlement, validation, and
   lifecycle checks.
7. Mutations either run directly or inside `UnitOfWork`; idempotent commands also
   require `Idempotency-Key`.
8. Repository methods write/read MongoDB collections and enforce CAS where used.
9. Mutations write audit and/or outbox events where implemented.
10. Route returns DTO-like response body and status.

## 1. Auth / Identity

### Business Purpose

Provides identity, credentials, sessions, refresh tokens, verification,
password-reset, MFA/TOTP, and security events.

### Actors

Public registrant, logging-in user, authenticated user, user completing MFA or
verification/reset challenge.

### Preconditions

Public auth commands require valid request schema and configured auth secrets.
Authenticated MFA/status commands require an active session, with restricted
sessions allowed only on routes that explicitly opt in.

### Main Entities

`UserDocument`, `AuthSessionDocument`, `AuthRefreshTokenDocument`,
`AuthChallengeDocument`, `AuthMfaMethodDocument`, `AuthRateLimitDocument`,
`AuthSecurityEventDocument`.

### Lifecycle / State Machine

Users are `PENDING_ACTIVATION`, `ACTIVE`, or `DISABLED`. Sessions are `ACTIVE`,
`REVOKED`, or `EXPIRED`. Refresh tokens are `CURRENT`, `CONSUMED`, or `REVOKED`.
MFA methods are `PENDING`, `ACTIVE`, or `DISABLED`.

### Create Flow

Registration:
actor submits `/api/v1/auth/register` -> public schema validation -> identifier
normalization -> duplicate and password checks -> user/session/refresh-token
writes -> verification challenge where applicable -> web clients receive refresh
cookie while mobile clients receive refresh token in JSON.

MFA setup:
authenticated actor -> `requireAuth` -> TOTP secret/challenge creation -> pending
MFA method persisted -> setup response returned; confirmation consumes challenge
and activates method.

### Read Flow

`GET /api/v1/auth/mfa` uses `requireAuth({ allowRestricted: true })` and returns
MFA status from auth repositories. Login and refresh read users, sessions, MFA
methods, rate limits, challenges, and refresh tokens.

### Update Flow

Refresh consumes the current refresh token and issues a new token/session state.
Verification consumes email/phone challenge. Password reset consumes reset
challenge and updates password hash. MFA recovery-code regeneration replaces
stored recovery-code digests.

### Delete / Archive Flow

Logout clears web refresh cookie when present and revokes/invalidates the current
session context. MFA disable marks method disabled rather than removing records.

### Important Commands

Register, login, MFA login verify, TOTP setup/confirm, step-up start/verify,
regenerate recovery codes, disable MFA, refresh, logout, verify email/phone,
resend verification, forgot/reset password.

### Important Queries

MFA status and internal credential/session/challenge lookups.

### Permission Rules

Public auth routes do not use workspace permission grants. Authenticated commands
use `requireAuth`; platform/workspace access control begins after authentication in
other modules.

### Scope Rules

Auth is user/session scoped. It does not resolve branch or relationship scopes.

### Validation Rules

Identifier normalization, password rules, challenge purpose/attempt limits,
client transport, cookie origin checks for web refresh, and MFA code/recovery-code
validation are enforced by auth services.

### Concurrency / Idempotency

Refresh tokens and challenges are single-use. Tests cover refresh replay,
challenge consumption, recovery-code consumption, and family revocation on replay.
Public auth routes are not wrapped in the central idempotency service.

### Audit / Outbox

Auth writes security events to `auth_security_events`. It does not register a
domain outbox handler.

### Notifications

No notification outbox mapping is registered directly for Auth.

### Files / Documents

None.

### Retention / Export

Auth/identity records can be read by export/deletion processors as part of
workspace/user evidence, but Auth does not own Stage 17 export routes.

### Error Scenarios

Invalid credentials, restricted/pending users, invalid/expired challenge, replayed
refresh token, MFA required, invalid MFA code, rate limit, and cookie-origin
failure.

### Frontend Implications

Web clients must use refresh cookies for web auth; mobile/API clients use refresh
token JSON. MFA login can return a challenge instead of tokens. Restricted sessions
can access only allowed auth routes.

### Example End-to-End Scenario

User logs in with MFA enabled -> public login route validates credentials -> auth
service returns `mfaChallengeToken` without session -> user posts MFA code -> auth
service consumes challenge, creates session and refresh token -> route sets web
cookie or returns mobile refresh token -> frontend receives access-token response.

## 2. Workspace / Platform / Branches / Memberships

### Business Purpose

Owns tenant structure, current user/workspace discovery, platform memberships,
workspace memberships, branches, staff invitations, and branch assignments.

### Actors

Platform admin, owner, manager, staff member, invited user, support effective actor
where support context is active.

### Preconditions

Authenticated session. Platform routes require platform membership and platform
permissions. Workspace routes require active workspace membership and workspace
state allowed by access control.

### Main Entities

`WorkspaceDocument`, `PlatformMembershipDocument`,
`WorkspaceMembershipDocument`, `BranchDocument`,
`MembershipBranchAssignmentDocument`, `InvitationDocument`, `UserDocument`.

### Lifecycle / State Machine

Workspace: `PENDING_ACTIVATION`, `ACTIVE`, `RESTRICTED`, `SUSPENDED`, `ARCHIVED`.
Platform membership: `ACTIVE`, `SUSPENDED`, `ENDED`. Workspace membership:
`INVITED`, `ACTIVE`, `SUSPENDED`, `ENDED`, `ARCHIVED`. Branch: `ACTIVE`,
`ARCHIVED`. Invitation: `PENDING`, `ACCEPTED`, `EXPIRED`, `REVOKED`,
`SUPERSEDED`.

### Create Flow

Workspace creation:
platform actor -> `requireAuth` -> platform `platform_workspaces.manage` ->
schema validation -> `WorkspaceApplicationService.createWorkspace` -> repository
writes workspace, default branch/membership structures as implemented -> audit and
outbox where service emits them -> response.

Staff invitation:
workspace actor -> `staff.invite` -> entitlement staff-slot reservation inside
transaction -> invitation/user or pending membership records -> audit/outbox ->
invitation response.

Branch creation:
workspace actor -> `branches.create` -> service validation -> `branches` write ->
audit/outbox -> response.

### Read Flow

`/me` and `/me/workspaces` use authenticated identity/session. Workspace, branch,
membership, and branch-assignment reads use `requireAccess` with read permissions
and branch scope when route includes `branchId`.

### Update Flow

Workspace and branch updates use route-level access checks, schema validation, and
repository update methods. Platform membership `suspend`, `reactivate`, and `end`
are loop-registered commands guarded by `platform_users.manage`.

### Delete / Archive Flow

Branches are archived through `/branches/:branchId/archive`. Invitations can be
revoked. Memberships are ended/suspended rather than physically deleted by these
routes.

### Important Commands

Create workspace, manage platform memberships, update workspace, create/update/
archive branch, invite/revoke/accept invitation, assign/unassign branches.

### Important Queries

Current user, my workspaces, platform memberships, workspace details, branches,
workspace memberships, membership branch assignments.

### Permission Rules

Uses `requireAccess` with platform or workspace context. Important permissions
include `platform_users.*`, `platform_workspaces.manage`, `workspace.*`,
`branches.*`, `staff.*`, and `staff.branches.manage`.

### Scope Rules

Branch detail/update/archive uses branch-scoped access when `branchId` is present.
Membership branch assignments also require branch/member eligibility in services.

### Validation Rules

Schema validation, active workspace/membership checks, branch workspace matching,
invitation token/purpose, staff quota, duplicate membership/invitation handling,
and branch archived-state checks.

### Concurrency / Idempotency

Staff invitation acceptance is idempotent through `runInTransaction` and
`Idempotency-Key`. Several lifecycle updates use CAS access-version or document
version checks in repositories.

### Audit / Outbox

Workspace, membership, branch, invitation, and branch assignment mutations write
business audit and outbox events. Trainee handlers consume relevant membership and
branch-assignment events.

### Notifications

Workspace events can reach notification handling when registered event types
match, such as permission profile replacement or support/retention-related events.

### Files / Documents

None directly.

### Retention / Export

Workspace state drives export/deletion boundaries. Workspace deletion and
retention are owned by Stage 17.

### Error Scenarios

Unauthenticated, platform MFA/membership failure, permission denial, branch
scope denial, inactive/restricted workspace denial, duplicate invitation,
quota exceeded, expected-version conflict, not found.

### Frontend Implications

Frontend must load `/me` and `/me/workspaces` before workspace-specific screens.
Branch-scoped staff users may see only eligible branches. Invitation accept is a
state-changing command and can require idempotency.

### Example End-to-End Scenario

Owner invites staff -> auth -> support context if any -> workspace access check
for `staff.invite` -> entitlement reserves staff slot -> transaction creates
invitation/membership state -> audit/outbox writes -> response returns invitation
metadata.

## 3. Permissions / Access Control

### Business Purpose

Centralizes permission definitions, profiles, grants, effective access, and
runtime authorization decisions for platform and workspace modules.

### Actors

Platform admin, owner/manager with staff permission management, target platform or
workspace member, support effective actor.

### Preconditions

Authenticated actor with `platform_permissions.manage` for platform permission
management or `staff.permissions.manage` for workspace permission management.

### Main Entities

`PermissionDefinitionDocument`, `PermissionProfileDocument`,
`AccessGrantDocument`.

### Lifecycle / State Machine

Permission definitions are active system definitions. Permission profiles are
`ACTIVE` or `ARCHIVED`. Grants have effect, scope, and optional expiration.

### Create Flow

Profile creation:
actor -> auth -> platform/workspace permission-management check -> schema
validation -> permissions validated against registry -> `permission_profiles`
write -> audit/outbox -> response.

Grant replacement:
actor -> auth/access -> grant payload validation -> replace grants for target
membership -> audit/outbox -> response.

### Read Flow

Definition list reads registry-seeded definitions. Profile, grants, and effective
access endpoints read profile/grant collections and membership context. Effective
access calls central evaluator.

### Update Flow

Profile patches update name/permissions with validation. Membership profile
replacement changes assigned profile ids and emits outbox for downstream
eligibility reconciliation.

### Delete / Archive Flow

Profile archive marks profile archived; archived profiles cannot authorize.
Grants are replaced rather than individually deleted by public routes.

### Important Commands

Create/update/archive profile, replace member profiles, replace member explicit
access grants.

### Important Queries

List definitions, list profiles, read grants, effective-access inspection.

### Permission Rules

The module manages permissions but is also protected by them:
`staff.permissions.manage` and `platform_permissions.manage`.

### Scope Rules

Allowed scope types include `SELF`, `ASSIGNED_TRAINEES`, `SPECIFIC_TRAINEES`,
`BRANCH`, `MULTIPLE_BRANCHES`, and `WORKSPACE` for workspace permissions. Platform
permissions use platform context. Relationship scope uses coaching relationship id.

### Validation Rules

Unknown permission keys are rejected; archived profiles cannot authorize; expired
grants are ignored; profile/grant scope must be valid for permission context.

### Concurrency / Idempotency

Profile and grant operations use repository writes and access versions where
implemented. Public permission-management routes are not generally wrapped in the
central idempotency service.

### Audit / Outbox

Permission mutations write audit and outbox events. `MembershipPermissionProfilesReplaced`
is consumed by trainee reconciliation and notifications.

### Notifications

Notification registry includes `MembershipPermissionProfilesReplaced`.

### Files / Documents

None.

### Retention / Export

Permission profiles and grants affect export visibility only through access rules;
Stage 17 owns export/deletion.

### Error Scenarios

Unknown permission, archived profile, permission denial, inactive membership,
scope/resource mismatch, DENY precedence, expired grant ignored.

### Frontend Implications

Frontend must distinguish effective access from assigned profiles/grants. DENY can
override ALLOW, and relationship ids are not trainee user ids.

### Example End-to-End Scenario

Owner replaces a trainer's profiles -> auth -> workspace access check
`staff.permissions.manage` -> validate profile ids and membership workspace ->
transaction updates membership/profile assignment -> audit/outbox
`MembershipPermissionProfilesReplaced` -> trainee reconciliation may later adjust
primary eligibility.

## 4. Subscriptions / Payments / Entitlements

### Business Purpose

Owns commercial plans, plan versions, subscriptions, manual payments, workspace
usage, quota reservations, and entitlement checks used by product modules.

### Actors

Platform subscription admin, platform admin, owner/manager submitting payment,
worker processing commercial jobs.

### Preconditions

Authenticated actor. Workspace billing routes require workspace billing
permissions. Platform commercial routes require plan/subscription/payment
permissions.

### Main Entities

`SubscriptionPlanDocument`, `SubscriptionPlanVersionDocument`,
`SubscriptionDocument`, `SubscriptionTermDocument`, `WorkspaceUsageDocument`,
`ManualPaymentDocument`.

### Lifecycle / State Machine

Subscription lifecycle includes `PENDING_ACTIVATION`, `TRIAL`, `ACTIVE`,
`GRACE_PERIOD`, `FROZEN`, `EXPIRED`, `CANCELLED`. Payment status is `PENDING`,
`APPROVED`, or `REJECTED`.

### Create Flow

Plan creation:
platform actor -> auth -> `plans.create` -> idempotency wrapper -> transaction
creates `subscription_plans` -> response.

Manual payment:
workspace actor -> auth/access `billing.payments.create` -> idempotency wrapper
where route uses it -> service validates workspace/subscription -> creates
`manual_payments` -> audit/outbox -> response.

### Read Flow

Subscription, usage, payment, plan, and platform subscription reads use route-level
access checks and repository reads. Entitlement service reads subscriptions,
terms, and usage from downstream services.

### Update Flow

Plan update uses `expectedVersion`. Subscription start trial, upgrade, downgrade,
freeze, reactivate, cancel, and payment approve/reject run in idempotent
transactions and update subscription/term/payment records.

### Delete / Archive Flow

Plans are archived using expected version. Subscriptions are cancelled/frozen or
expired, not deleted by public routes.

### Important Commands

Create/update/archive plan, create plan version, start trial, change plan,
freeze/reactivate/cancel, create/approve/reject payment.

### Important Queries

Workspace subscription, workspace usage, workspace payments, platform plans,
platform payments, platform subscription by workspace.

### Permission Rules

Workspace billing routes use `billing.subscription.read`, `billing.usage.read`,
`billing.payments.*`. Platform routes use `plans.*`, `subscriptions.*`,
`payments.*`.

### Scope Rules

Billing workspace routes are workspace scoped. Platform commercial routes operate
from platform context and address workspaces by `workspaceId`.

### Validation Rules

Plan version eligibility, billing period, archived plan/version rejection,
subscription lifecycle constraints, payment status constraints, quota/feature
limits, expected version, and transaction consistency.

### Concurrency / Idempotency

Commercial mutation routes use `Idempotency-Key` with route/body fingerprints.
Workspace usage reservations are atomic and transactional. CAS protects plans,
payments, subscriptions, and terms.

### Audit / Outbox

Subscription and payment mutations write audit and outbox in the same transaction.
Tests cover rollback when audit/outbox/idempotency completion fails.

### Notifications

Notification registry includes subscription and payment-related events such as
`SubscriptionFrozen`.

### Files / Documents

Storage quota is tracked through `workspace_usage` and consumed by Files.

### Retention / Export

Retention/deletion can be triggered by expired subscriptions. Subscription changes
can cancel deletion in some flows.

### Error Scenarios

Subscription frozen, feature not available, trainee/staff/storage quota exceeded,
payment already final, plan archived, version conflict, idempotency mismatch or
in-progress duplicate.

### Frontend Implications

Frontend must treat billing reads as available even when product writes are
blocked. State-changing commercial commands should send `Idempotency-Key` and
`expectedVersion` where schema requires it.

### Example End-to-End Scenario

Platform admin approves a payment -> auth -> `payments.approve` -> idempotency
transaction -> payment CAS/status check -> subscription/term update -> audit and
outbox -> idempotency completion -> response with updated commercial state.

## 5. Leads / Owner Activation

### Business Purpose

Handles public lead capture, lead management, conversion, duplicate/merge
handling, owner activation, and initial workspace/commercial setup.

### Actors

Public prospect, platform sales/lead admin, owner activation user.

### Preconditions

Public lead and activation routes require valid tokens/body only. Platform lead
routes require platform membership and lead permissions.

### Main Entities

`LeadDocument`, pending/active `UserDocument`, `WorkspaceDocument`,
`InvitationDocument`, permission profile assignments, subscription/trial records.

### Lifecycle / State Machine

Lead statuses include `NEW`, `CONTACTED`, `QUALIFIED`, `ON_HOLD`, `CONVERTED`,
`LOST`, and `DUPLICATE`.

### Create Flow

Public lead:
public caller -> schema validation -> lead repository create -> response. No
workspace auth is involved.

Conversion:
platform actor -> auth -> `leads.convert` -> idempotency transaction -> lead
expectedVersion/source-state check -> creates pending owner/workspace/invitation
and subscription intent as implemented -> audit/outbox -> response with
activation data redacted for replay storage.

### Read Flow

Platform lead list/detail routes require `leads.read` and read from `leads` with
query filters.

### Update Flow

Lead metadata update and status changes require expected version. Owner activation
completion verifies token/challenge, records attempt, completes identity/workspace
activation, and starts commercial flow inside transaction.

### Delete / Archive Flow

No physical delete route. Leads can move to LOST/DUPLICATE or be merged.

### Important Commands

Create public lead, update lead, change status, convert lead, reissue owner
activation, mark duplicate, merge, complete owner activation.

### Important Queries

List/get platform leads.

### Permission Rules

Platform lead routes require `leads.read`, `leads.update`, `leads.convert`,
`leads.mark_duplicate`, or `leads.merge`.

### Scope Rules

Leads are platform scoped. Owner activation route is public-token scoped.

### Validation Rules

Lead status transition/source-state checks, expected version, token/challenge
checks, duplicate/merge target checks, workspace/subscription intent validation,
quota checks during activation.

### Concurrency / Idempotency

Convert, duplicate, merge, and owner activation completion are idempotent.
Owner activation uses a server-derived actor for public idempotency.

### Audit / Outbox

Lead conversion, activation, duplicate/merge, and reissue write audit/outbox where
implemented. Owner activation verification attempts persist even across aborted
activation transactions.

### Notifications

No dedicated lead notification registry entry was identified in Stage 14. Related
workspace/subscription events can still notify if registered.

### Files / Documents

None.

### Retention / Export

Converted leads connect to workspaces that later participate in export/deletion.
Lead records themselves are platform data.

### Error Scenarios

Invalid status transition, converted/duplicate metadata update, expected-version
conflict, invalid activation token, bounded invalid attempts, quota failure,
idempotency mismatch.

### Frontend Implications

Lead conversion and owner activation are multi-step. The frontend must not rely on
stored replay bodies to return secrets; activation/reissue tokens are sensitive and
handled specially.

### Example End-to-End Scenario

Sales admin converts a qualified lead -> auth -> platform lead permission ->
idempotency transaction -> lead CAS/source-state check -> create pending owner,
workspace, membership/invitation and subscription intent -> audit/outbox ->
response returns activation token once.

## 6. Trainee Relationships

### Business Purpose

Owns coaching relationship lifecycle, trainee invitations/referrals, primary
trainer assignment, assistant/nutritionist assignments, and trainee migration.

### Actors

Owner, manager, trainer, assistant trainer, nutritionist, trainee, invited user,
support effective actor.

### Preconditions

Authenticated actor. Workspace access and active relationship/workspace eligibility
are required. Write operations require active commercial write entitlement and
relationship state eligibility where applicable.

### Main Entities

`CoachingRelationshipDocument`, `TraineeStaffAssignmentDocument`,
`TraineeReferralCodeDocument`, `InvitationDocument`,
`WorkspaceMembershipDocument`.

### Lifecycle / State Machine

Relationship statuses are `PENDING`, `ACTIVE`, `NEEDS_REASSIGNMENT`, `ENDED`,
and `ARCHIVED`.

### Create Flow

Invite trainee:
workspace actor -> auth -> `trainees.invite` -> idempotency transaction ->
entitlement and trainee-slot reservation -> invitation/relationship/membership
state as implemented -> audit/outbox -> response.

Referral join:
trainee actor -> auth -> idempotency transaction -> referral validation ->
pending relationship created without active membership/quota until approval.

### Read Flow

List relationships uses `trainees.read` and query access. Detail read uses service
relationship authorization, so SELF/assigned/branch access can apply beyond route
metadata.

### Update Flow

Accept/reject/end/reactivate, home-branch change, primary trainer set/remove, and
assistant/nutritionist add/remove run through idempotent relationship command
helpers and CAS.

### Delete / Archive Flow

End relationship changes lifecycle and releases quota where appropriate. Archive
exists as a status but no general public delete route was identified.

### Important Commands

Invite, reissue invitation, referral join, accept, reject, end, reactivate, change
home branch, set/remove primary, add/remove assistant, add/remove nutritionist,
migrate trainee.

### Important Queries

List/read relationships.

### Permission Rules

Uses `trainees.*` and `trainees.assignments.*` permissions plus service-level
relationship guards.

### Scope Rules

Relationship scope uses coaching relationship id. Branch scope checks home branch
and staff branch assignments. SELF scope applies to trainee's own relationship.

### Validation Rules

Workspace/relationship id matching, status eligibility, active branch and
membership, primary trainer eligibility, duplicate assignment uniqueness,
expectedVersion, entitlement/trainee-slot checks.

### Concurrency / Idempotency

Relationship commands use `Idempotency-Key` and CAS. Quota reservations are
transactional. Reconciliation handlers are idempotent and batch-capable.

### Audit / Outbox

Relationship lifecycle and assignment mutations write audit/outbox. Outbox events
include reassignment/assignment signals and feed notification/reconciliation.

### Notifications

Notification registry includes `TraineeNeedsReassignment` and permission-profile
events that affect relationship eligibility.

### Files / Documents

Relationship id anchors documents, progress, training, nutrition, check-ins, and
analytics.

### Retention / Export

Relationship records are exported/deleted as workspace data in Stage 17 flows.

### Error Scenarios

Permission denial, cross-workspace relationship, inactive workspace, invalid
branch/primary trainer, duplicate assignment, quota exceeded, ended relationship,
expected-version conflict.

### Frontend Implications

The frontend must keep `relationshipId` separate from user id. Reassignment is a
first-class state that can preserve reads and block or narrow writes.

### Example End-to-End Scenario

Manager changes primary trainer -> auth -> workspace access for
`trainees.assignments.primary.manage` -> idempotency transaction -> relationship
CAS and branch/staff eligibility -> assignment update -> audit/outbox ->
relationship response.

## 7. Training

### Business Purpose

Owns exercise libraries, program templates, assigned programs, immutable revisions,
activation/replacement, completion/archive, and program progress.

### Actors

Owner, manager, trainer, assistant trainer or trainee for allowed reads, platform
admin for system exercises, support effective actor.

### Preconditions

Authenticated actor. Workspace/system exercise and program permissions. Active
workspace commercial entitlement for training writes. Relationship eligibility for
assigned programs.

### Main Entities

`ExerciseDocument`, `ProgramTemplateDocument`,
`ProgramTemplateRevisionDocument`, `ProgramDocument`, `ProgramRevisionDocument`,
`ProgramProgressDocument`, `ProgramProgressEventDocument`.

### Lifecycle / State Machine

Exercise/template training status is `ACTIVE` or `ARCHIVED`. Program status is
`DRAFT`, `ACTIVE`, `REPLACED`, `COMPLETED`, or `ARCHIVED`.

### Create Flow

Exercise/template/program creation:
actor -> auth -> `requireAccess` for relevant permission -> service entitlement
check -> validation of scope/content -> repository write -> audit/outbox where
implemented -> response.

Program activation:
actor -> auth/access -> idempotency transaction -> relationship guard ->
expectedVersion and content validation -> replace existing active program if any
-> initialize/preserve progress as implemented -> audit/outbox -> response.

### Read Flow

List/get exercises, templates, programs, and progress read repositories after
permission and entitlement read checks. System exercise reads use platform
permissions.

### Update Flow

Exercises update via patch. Templates/programs create immutable revisions.
Program activation/completion/archive use expectedVersion and lifecycle guards.

### Delete / Archive Flow

Exercises, templates, and programs use archive commands, not physical delete.

### Important Commands

Create/update/archive exercises, create/revise/archive templates, create/revise/
activate/complete/archive programs.

### Important Queries

List exercises, system exercises, templates, programs, program progress.

### Permission Rules

Workspace permissions: `exercises.*`, `program_templates.*`, `programs.*`.
Platform permissions: `system_exercises.*`.

### Scope Rules

Exercises can be system, gym, or private. Programs are relationship scoped.
Private exercise leakage is blocked in copies/revisions.

### Validation Rules

Name uniqueness, scope rules, archived/private exercise usability, immutable
revision topology, day topology, relationship state, entitlement feature `training`,
expectedVersion.

### Concurrency / Idempotency

Activation and some revision/progress commands use idempotency wrappers. CAS
protects exercises, templates, programs, and progress records.

### Audit / Outbox

Training mutations write audit/outbox. Notifications listen for `ProgramActivated`
and `ProgramUpdated`.

### Notifications

Program activation/update events can produce notifications.

### Files / Documents

None directly.

### Retention / Export

Training collections are workspace/relationship data for export/deletion.

### Error Scenarios

Archived exercise in new content, private exercise leakage, topology conflict,
relationship ended, subscription feature denied, expected-version conflict,
idempotency conflict.

### Frontend Implications

Program revisions are immutable snapshots. Activation is the key state-changing
command and should be treated as idempotent and conflict-prone.

### Example End-to-End Scenario

Trainer activates a draft program -> auth -> `programs.activate` relationship
access -> training write entitlement -> idempotency transaction -> expectedVersion
and exercise usability checks -> previous active program replaced -> progress
created -> audit/outbox -> response.

## 8. Workouts / PRs

### Business Purpose

Executes active training programs as workout sessions, tracks actuals, advances
program progress, supports skip/defer, and maintains personal records.

### Actors

Trainer, assistant trainer where allowed, trainee SELF, manager/owner read/correct
where allowed, support effective actor.

### Preconditions

Authenticated actor. Relationship-scoped workout permission. Active training
feature entitlement for writes. Active program/progress and eligible relationship
state for start/complete/skip/defer.

### Main Entities

`WorkoutSessionDocument`, `PersonalRecordDocument`,
`PersonalRecordEventDocument`, `ProgramProgressDocument`.

### Lifecycle / State Machine

Workout status is `IN_PROGRESS`, `COMPLETED`, or `ABANDONED`.

### Create Flow

Start workout:
actor -> auth -> `workouts.create` -> entitlement write check -> idempotency
transaction -> relationship/program/progress guard -> create one in-progress
workout snapshot -> audit/outbox -> response.

### Read Flow

Current/list/detail-like reads use `workouts.read`. Personal records and PR events
use `personal_records.read`. Repository reads are relationship scoped.

### Update Flow

Patch updates in-progress actuals by immutable exercise/set keys. Complete uses
expectedVersion, finalizes session, advances progress, and writes PR projections.
Corrections use expectedVersion and can adjust/retract PRs.

### Delete / Archive Flow

Workouts are abandoned instead of deleted. Skip/defer mutate program progress, not
workout deletion.

### Important Commands

Start, patch, complete, abandon, staff correction, skip current day, defer current
day.

### Important Queries

Current workout, workout history, personal records, personal record events.

### Permission Rules

Uses `workouts.*`, `workouts.day.skip`, `workouts.day.defer`, and
`personal_records.read`.

### Scope Rules

All workout routes are relationship scoped. Trainee SELF access is narrow; trainer
access is assigned; assistants have limited create/read behavior per tests.

### Validation Rules

Single live workout guard, active program/progress guard, immutable key validation,
relationship state, expectedVersion, feature entitlement, canonical PR unit rules.

### Concurrency / Idempotency

Start, complete, abandon, correction, skip, and defer use idempotency wrappers.
Repository CAS protects workout/progress transitions.

### Audit / Outbox

Workout mutations write audit/outbox. Completion/correction writes workout and PR
events; tests cover rollback of workout/progress/PR/audit/outbox/idempotency.

### Notifications

Notification registry includes `WorkoutCompleted` and `WorkoutCorrected`.

### Files / Documents

None directly.

### Retention / Export

Workout and PR data is relationship/workspace data for export/deletion.

### Error Scenarios

No active program, duplicate live start, relationship ended, needs reassignment
blocking new start, live workout blocking skip/defer, expected-version conflict,
feature denied.

### Frontend Implications

Workout execution needs optimistic conflict handling. Completion can affect
progress and PRs, so frontend should refresh workout/progress/PR views after
completion/correction.

### Example End-to-End Scenario

Trainee completes workout -> auth -> SELF relationship access -> training write
entitlement -> idempotency transaction -> workout expectedVersion check ->
actuals validated -> status completed -> progress advanced -> PR events updated
-> audit/outbox -> response.

## 9. Nutrition

### Business Purpose

Owns food libraries and assigned nutrition plans, including snapshots, calculated
macros, revisions, activation/replacement, completion, and archive behavior.

### Actors

Owner, trainer, nutritionist, manager/owner read/update where permitted, trainee
read, platform admin for system foods.

### Preconditions

Authenticated actor. Food/nutrition permissions. Nutrition feature entitlement for
writes. Relationship eligibility for plan operations.

### Main Entities

`FoodDocument`, `NutritionPlanDocument`, `NutritionPlanRevisionDocument`.

### Lifecycle / State Machine

Food status is `ACTIVE` or `ARCHIVED`. Nutrition plan status is `DRAFT`, `ACTIVE`,
`REPLACED`, `COMPLETED`, or `ARCHIVED`.

### Create Flow

Food or plan creation:
actor -> auth -> route access -> entitlement check -> service validates scope,
duplicates, responsible member, and content -> repository writes food/plan/revision
-> audit/outbox where implemented -> response.

Activation:
actor -> auth/access -> idempotency transaction -> relationship/responsible member
eligibility -> expectedVersion/content validation -> replaces current active plan
-> audit/outbox -> response.

### Read Flow

Food reads use workspace/platform food permissions. Nutrition plan reads use
relationship-scoped `nutrition.plans.read`.

### Update Flow

Foods patch metadata/nutrition values with expectedVersion. Plans create immutable
revisions; active plan edits are constrained by service logic.

### Delete / Archive Flow

Foods and nutrition plans are archived. Plans can also be completed.

### Important Commands

Create/update/archive foods, create/revise/activate/complete/archive nutrition
plans.

### Important Queries

List workspace foods, list platform foods, list/get relationship nutrition plans.

### Permission Rules

Workspace permissions include `foods.*` and `nutrition.plans.*`. Platform system
food routes use `system_foods.*`.

### Scope Rules

Foods can be system, gym, or private. Nutrition plans are relationship scoped and
nutritionist assignment can grant access.

### Validation Rules

Food duplicate/scope rules, unit-safe server macro calculation, immutable food
snapshots, archived food restrictions in new complete content, active responsible
membership, relationship state, feature entitlement, expectedVersion.

### Concurrency / Idempotency

Plan activation uses idempotency. Repository CAS protects food/plan transitions.

### Audit / Outbox

Nutrition mutations write audit/outbox. Notifications listen for
`NutritionPlanActivated` and `NutritionPlanUpdated`.

### Notifications

Activation/update can notify assigned users through outbox handlers.

### Files / Documents

Health food-allergy reads from Progress can be used by Nutrition through limited
permissions, but nutrition files are not owned here.

### Retention / Export

Nutrition collections are exported/deleted with workspace data.

### Error Scenarios

Archived food in active content, macro validation failure, ineligible responsible
member, feature denied, relationship ended, expected-version conflict.

### Frontend Implications

Frontend should treat revisions as snapshots and refresh active plan after
activation, completion, or archive. Macro totals are server-authoritative.

### Example End-to-End Scenario

Nutritionist activates a plan -> auth -> relationship-scoped
`nutrition.plans.activate` -> nutrition entitlement -> idempotency transaction ->
expectedVersion/content/responsible-member checks -> active plan replacement ->
audit/outbox -> response.

## 10. Progress

### Business Purpose

Captures body/progress metrics, measurements, progress photo metadata, health
profile, coaching notes, adherence configuration, and daily tracking.

### Actors

Trainee, trainer, assistant trainer, nutritionist for limited health/allergy
access, manager/owner, support effective actor.

### Preconditions

Authenticated actor. Relationship/workspace access and progress feature
entitlement. Sensitive reads must be allowed and auditable.

### Main Entities

`MetricDefinitionDocument`, `MeasurementEntryDocument`,
`ProgressPhotoEntryDocument`, `TraineeHealthProfileDocument`,
`CoachingNoteDocument`, `AdherenceConfigDocument`,
`DailyTrackingEntryDocument`.

### Lifecycle / State Machine

Metric definitions and coaching notes are `ACTIVE` or `ARCHIVED`.
Progress photo visibility is controlled separately. Health/adherence/daily tracking
records are singleton/date-keyed where implemented.

### Create Flow

Measurement create:
actor -> auth -> `measurements.create` -> entitlement write check ->
idempotency transaction -> metric/relationship/date validation -> repository
insert -> audit/outbox -> response.

Note/metric creation:
actor -> auth/access -> entitlement -> validation -> repository write ->
audit/outbox where implemented -> response.

### Read Flow

Metric/measurement/adherence reads use route access. Health profile, progress
photo, and notes routes use authenticated route and service-level sensitive
visibility/access checks. Sensitive reads write audit evidence.

### Update Flow

Metric, measurement, health profile, note, adherence config, and daily tracking
updates validate expectedVersion where required/optional and write through
repositories.

### Delete / Archive Flow

Metric definitions and notes are archived. Progress-photo delete routes are not
part of this module's implemented API surface in V1 route inventory; files module
owns file deletion.

### Important Commands

Create/update/archive metric definitions, create/update measurements, update health
profile, create/update/archive notes, configure adherence, update daily tracking.

### Important Queries

List metrics, measurements, progress photos, health profile, notes, adherence
config, daily tracking by local date.

### Permission Rules

Uses `metric_definitions.*`, `measurements.*`, `progress_photos.read`,
`health.*`, `health.food_allergies.read`, `notes.*`, and `adherence.*`.

### Scope Rules

Most records are relationship scoped. SELF, assigned, branch, and support-sensitive
rules are resolved by service/access-control code.

### Validation Rules

Metric immutable unit/value type, same-day measurement support, singleton health
profile, private/shared note visibility, enabled adherence metrics, workspace IANA
timezone, local date edit windows, expectedVersion.

### Concurrency / Idempotency

Measurement create uses idempotency. Repository CAS protects metric, measurement,
note, health, adherence, and daily tracking updates where expectedVersion is used.

### Audit / Outbox

Progress mutations write audit/outbox where implemented. Sensitive health/photo/
note reads write sensitive audit evidence and can fail closed.

### Notifications

No direct notification registry entry for measurements was identified. Downstream
analytics reads progress data.

### Files / Documents

Progress photo metadata references file data, but upload/download/delete lifecycle
is owned by Files.

### Retention / Export

Progress records are exported/deleted as workspace relationship data.

### Error Scenarios

Sensitive audit failure, invalid metric/date payload, disabled adherence metric,
outside edit window, relationship ended for writes, expected-version conflict,
feature denied.

### Frontend Implications

Frontend must use workspace-local dates for daily tracking and avoid assuming
photo metadata grants file access. Sensitive sections may be hidden or null based
on actor.

### Example End-to-End Scenario

Trainer creates measurement -> auth -> relationship-scoped
`measurements.create` -> progress entitlement -> idempotency transaction ->
metric/relationship/date validation -> measurement inserted -> audit/outbox ->
201 response.

## 11. Check-ins

### Business Purpose

Provides configurable check-in templates, recurring assignments, generated
instances, trainee submissions, trainer reviews, and due/overdue automation.

### Actors

Owner, trainer, manager, trainee SELF, support effective actor, worker.

### Preconditions

Authenticated actor. Check-in permissions and relationship scope. Check-in feature
entitlement for writes. Worker requires job leases.

### Main Entities

`CheckInTemplateDocument`, `CheckInTemplateRevisionDocument`,
`CheckInAssignmentDocument`, `CheckInInstanceDocument`.

### Lifecycle / State Machine

Templates are `ACTIVE` or `ARCHIVED`. Instances include `UPCOMING`, `DUE`,
`SUBMITTED`, `REVIEWED`, `OVERDUE`, and `SKIPPED`.

### Create Flow

Template/assignment create:
actor -> auth -> route `requireAccess` -> entitlement write -> idempotency
transaction -> validation -> repository writes template/revision or assignment ->
audit/outbox -> response.

Instance generation:
worker -> job lease -> due assignment scan -> period/timezone calculation ->
instance insert/update -> outbox events for due/overdue where implemented.

### Read Flow

Template, assignment, and instance reads use check-in read permissions and
relationship scope. Sensitive instance reads write sensitive audit evidence.

### Update Flow

Template revisions, assignment schedule updates, assignment end, submit, and review
validate expectedVersion and lifecycle eligibility. Submit/review use idempotent
transactions.

### Delete / Archive Flow

Templates are archived; assignments are ended; generated open instances can be
skipped by lifecycle/worker logic.

### Important Commands

Create/revise/archive template, create/update/end assignment, submit instance,
review instance.

### Important Queries

List/get templates, assignments, instances.

### Permission Rules

Uses `checkins.templates.*`, `checkins.assignments.*`, `checkins.assign`,
`checkins.read`, `checkins.submit`, and `checkins.review`.

### Scope Rules

Assignments and instances are relationship scoped. Trainee submission is self-only.
Review requires reviewer permission and relationship access.

### Validation Rules

Template field definitions, immutable revision pinning, recurrence normalization,
timezone validity, assignment eligibility, no retroactive expired first instance,
response validation, expectedVersion.

### Concurrency / Idempotency

Create/revise/archive/end/submit/review operations use idempotent wrappers.
Repositories enforce CAS.

### Audit / Outbox

Check-in mutations write audit/outbox. Sensitive reads write sensitive audit.
Outbox events drive notifications for due/overdue/submitted/reviewed.

### Notifications

Notification registry includes `CheckInDue`, `CheckInOverdue`,
`CheckInSubmitted`, and `CheckInReviewed`.

### Files / Documents

Check-in responses can be sensitive but file lifecycle is separate.

### Retention / Export

Check-in templates, assignments, and instances are workspace data for export and
deletion.

### Error Scenarios

Invalid recurrence/timezone, archived template, assignment ended, invalid response,
state conflict, relationship ended, feature denied, expected-version conflict.

### Frontend Implications

Frontend should pin displayed instances to their template revision and treat submit
and review as idempotent commands with version conflicts.

### Example End-to-End Scenario

Trainee submits due check-in -> auth -> service confirms SELF/submit eligibility
-> check-in entitlement -> idempotency transaction -> expectedVersion and response
validation -> instance `SUBMITTED` -> audit/outbox -> response.

## 12. Files / Documents

### Business Purpose

Handles upload reservations, signed upload/download URLs, object verification,
file metadata, confirmation, soft-delete/restore/purge, and relationship documents.

### Actors

Owner, trainer, trainee, assistant/nutritionist where document permissions allow,
support effective actor, file worker.

### Preconditions

Authenticated actor. File/document service-level authorization, storage quota, and
document entitlement. Object storage must be configured.

### Main Entities

`UploadIntentDocument`, `FileDocument`, `GeneratedFileIntentDocument`,
`BusinessDocument`.

### Lifecycle / State Machine

Upload intent: `PENDING`, `CONFIRMED`, `EXPIRED`, `CANCELLED`. File: `ACTIVE`,
`SOFT_DELETED`, `PURGE_PENDING`, `PURGED`. Document: `ACTIVE`, `DELETED`.
Generated file intent has its own pending/ready/failure lifecycle.

### Create Flow

Upload intent:
actor -> auth -> service authorizes file/document context -> storage quota
reservation -> idempotency transaction -> upload intent/file reservation metadata
write -> audit -> signed upload response.

Document create:
actor -> auth -> document permission -> relationship/file validation ->
idempotency transaction -> document write -> audit/outbox `DocumentUploaded` ->
response.

### Read Flow

Document list/detail and download-url routes call file service authorization.
Sensitive medical document reads/downloads map to medical/support-sensitive
permissions.

### Update Flow

Confirm upload:
actor -> auth -> idempotency transaction -> upload intent version/status check ->
storage HEAD/stat verification -> checksum/size validation -> file active/usage
commit -> audit -> response.

Restore file uses expectedVersion and service authorization.

### Delete / Archive Flow

File delete soft-deletes and later purge job handles purge. Document delete marks
document deleted. File restore reactivates within allowed state.

### Important Commands

Create upload intent, confirm upload, create download URL, delete/restore file,
create/delete document.

### Important Queries

List/get documents.

### Permission Rules

Service authorizes `documents.*`, `files.download`, `files.delete`,
`files.restore`, `medical_documents.*`, and support-sensitive equivalents.

### Scope Rules

Documents are relationship scoped. Files are workspace scoped with ownership/context
metadata. Support sessions can be `USER_CONTEXT` or support-sensitive.

### Validation Rules

Quota reservation, upload intent state/version, object existence, size and SHA-256
match, no overwrite, document category/classification, relationship ownership,
expectedVersion.

### Concurrency / Idempotency

All file/document mutations in routes use idempotency wrappers. CAS protects upload
intent, file, and document state.

### Audit / Outbox

File/document mutations write audit; document uploads write outbox for
notifications. File worker writes audit for expiration/purge.

### Notifications

Notification registry includes `DocumentUploaded`.

### Files / Documents

This module owns file/document lifecycle.

### Retention / Export

Exports generate file artifacts. Retention/deletion processors count/delete files
and documents according to Stage 17 rules.

### Error Scenarios

Upload object mismatch, checksum mismatch, quota exceeded, intent expired,
version conflict, sensitive access denial, missing object, purge/restore state
conflict.

### Frontend Implications

Frontend must follow reservation -> object upload -> confirmation. It must not
show a file as usable until confirmation succeeds. Sensitive downloads can be
denied even if metadata is visible.

### Example End-to-End Scenario

Trainer uploads an InBody document -> auth -> file service authorizes document
upload -> storage quota reserved -> upload intent returned -> frontend uploads
object -> confirm route verifies HEAD/sha/size -> commits file and document ->
audit/outbox -> response.

## 13. Notifications

### Business Purpose

Creates user notifications from outbox events, manages read state, preferences,
delivery attempts, and push devices.

### Actors

Authenticated user, notification worker, outbox processor.

### Preconditions

Authenticated user for `/me` routes. Registered outbox event types for automatic
notification creation. Delivery providers configured as logging providers in V1
container.

### Main Entities

`NotificationDocument`, `NotificationPreferencesDocument`,
`NotificationDeliveryDocument`, `PushDeviceDocument`.

### Lifecycle / State Machine

Delivery status is `PENDING`, `RETRYING`, `SENT`, `FAILED`, or `CANCELLED`.
Notifications have read/unread state through `readAt`.

### Create Flow

Outbox event -> worker `OutboxProcessor` invokes notification handler ->
notification service resolves registry entries and recipients -> writes
notifications/deliveries according to preferences -> delivery worker later sends.

Push device registration:
user -> auth -> schema validation -> device record write -> 201 response.

### Read Flow

`GET /me/notifications` reads current user's notifications with query filters.
Preferences endpoint reads or initializes user preferences.

### Update Flow

Mark read/read-all updates current user's notification records. Preference PUT
validates expectedVersion and writes preferences. Delivery worker updates delivery
status.

### Delete / Archive Flow

Push device DELETE revokes/removes device association as implemented. Notifications
are marked read, not deleted by public routes.

### Important Commands

Mark notification read, mark all read, update preferences, register/revoke push
device, process deliveries.

### Important Queries

List notifications, get preferences.

### Permission Rules

`/me` routes require authentication; ownership is derived from authenticated user.
No workspace permission grant is needed to read personal notification inbox.

### Scope Rules

User scoped. Event recipient resolution can inspect workspace/relationship
membership and assignment state.

### Validation Rules

Notification id ownership, preference version, channel/category settings, push
device data, event source eligibility.

### Concurrency / Idempotency

Preference update uses expectedVersion. Event handling prevents duplicate handler
registration keys; delivery retries use worker logic and provider idempotency keys
where present.

### Audit / Outbox

Preference updates write audit. Notifications are generated by outbox events but
do not generally emit further business outbox events.

### Notifications

This module owns notification creation and delivery.

### Files / Documents

Document upload and export events can create notifications.

### Retention / Export

Notifications are user/workspace-adjacent data considered by export/deletion flows
where included in manifests.

### Error Scenarios

Notification not found/not owned, preference version conflict, invalid push device,
delivery provider failure, cancelled delivery, ineligible source event.

### Frontend Implications

Frontend should poll/list notifications and update read state. Delivery state is
not the same as notification read state.

### Example End-to-End Scenario

Check-in submitted -> check-in service writes outbox -> worker processes event ->
notification handler resolves trainer recipients -> notification/delivery rows
created -> delivery worker sends/logs -> trainer sees unread notification.

## 14. Audit

### Business Purpose

Persists and exposes audit evidence for business operations and sensitive-resource
reads.

### Actors

Platform admin, owner/authorized workspace auditor, services writing audit,
support effective actor.

### Preconditions

Audit query routes require authentication and audit read permission. Audit writes
require services to call `AuditWriter` successfully where write is part of the
operation contract.

### Main Entities

`AuditEventDocument`.

### Lifecycle / State Machine

Audit events are append-only evidence records; no public mutation lifecycle was
identified.

### Create Flow

Business service mutation -> transaction or direct service flow -> `audit.write`
with actor/workspace/entity/action metadata -> `audit_events` insert. Sensitive
read -> `writeSensitiveResourceAccess` -> audit insert before response.

### Read Flow

Workspace audit route -> auth -> `audit.workspace.read` -> query filters ->
repository list. Platform audit route -> auth -> `audit.platform.read` ->
repository list.

### Update Flow

None.

### Delete / Archive Flow

None through public audit routes.

### Important Commands

Audit writes are internal service commands.

### Important Queries

List workspace audit, list platform audit.

### Permission Rules

`audit.workspace.read`, `audit.platform.read`, and `audit.sensitive.read` for
sensitive metadata access.

### Scope Rules

Workspace audit is workspace scoped. Platform audit is platform scoped.
Sensitive-read audit includes effective actor and source resource context.

### Validation Rules

Query filter schemas, workspace/platform access, and sensitive-read resource
metadata conventions.

### Concurrency / Idempotency

Audit writes inside transactions roll back with the surrounding mutation. Audit
query routes are not idempotent commands.

### Audit / Outbox

Audit is the audit sink. It does not require outbox to persist audit rows.

### Notifications

Audit does not directly notify.

### Files / Documents

Sensitive file/document reads can write audit evidence.

### Retention / Export

Audit evidence can be retained as deletion evidence depending on Stage 17 logic.

### Error Scenarios

Permission denial, invalid filters, audit write failure. Some sensitive reads fail
closed when audit cannot be written.

### Frontend Implications

Audit screens are read-only and permission gated. Sensitive audit access may be
separately denied even for users with source resource access.

### Example End-to-End Scenario

Owner reads workspace audit -> auth -> workspace `audit.workspace.read` ->
repository query with filters/cursor -> events returned.

## 15. Support Access

### Business Purpose

Controls platform support access to workspaces through policies, access requests,
sessions, support effective actor context, and sensitive support gates.

### Actors

Platform support/admin user, support session holder, revoking admin, support
expiry worker, effective tenant actor.

### Preconditions

Authenticated platform user. Service-level support permissions and policy/session
eligibility. Support context requires `x-support-session-id`.

### Main Entities

`PortalAccessPolicyDocument`, `SupportAccessRequestDocument`,
`SupportSessionDocument`.

### Lifecycle / State Machine

Support sessions can be `ACTIVE`, `ENDED`, `EXPIRED`, `REVOKED`, or
`SECURITY_TERMINATED`.

### Create Flow

Policy create:
actor -> auth -> service authorizes `support.policies.create` -> validation ->
transaction writes policy -> audit/outbox -> response.

Start session:
actor -> auth -> service authorizes `support.sessions.start` -> idempotency
transaction -> policy/workspace/session eligibility -> access request/session write
-> audit/outbox -> response.

### Read Flow

Policy/session list/detail routes require auth; service authorizes platform
support read permissions. For non-support module routes, support context is
resolved globally before route-specific auth/access.

### Update Flow

Policy patch/disable/archive use expectedVersion. Session end/revoke use
expectedVersion and lifecycle checks.

### Delete / Archive Flow

Policies are disabled or archived. Sessions are ended, expired, revoked, or
security-terminated rather than deleted.

### Important Commands

Create/update/disable/archive policy, start session, end own session, revoke
session, expire sessions.

### Important Queries

List/get policies and support sessions.

### Permission Rules

Support service authorizes `support.policies.*`, `support.sessions.*`,
`support.sensitive.read`, and `support.sensitive_files.read`.

### Scope Rules

`x-support-session-id` can produce `WORKSPACE_SUPPORT` or `USER_CONTEXT`.
Support-sensitive mapping is enforced for medical documents, health, check-ins,
progress photos, and sensitive analytics paths.

### Validation Rules

Policy active window, workspace restrictions, platform membership/session, support
session status/expiry, expectedVersion, support-sensitive permission mapping.

### Concurrency / Idempotency

Session start is idempotent. Policy/session transitions use CAS. Expiry worker
uses job leases.

### Audit / Outbox

Policy/session changes write audit/outbox. Support sensitive access writes audit.

### Notifications

Notification registry includes support session started/ended/revoked/expired.

### Files / Documents

Files service receives support access port for sensitive file decisions.

### Retention / Export

Support session/policy data is platform/support evidence and can affect audit and
deletion visibility.

### Error Scenarios

Invalid/expired support session, workspace support denial, restricted workspace,
support-sensitive denial, read-only mutation denial, expected-version conflict.

### Frontend Implications

Frontend must send `x-support-session-id` only when operating inside a support
session. Support context is not fully described by OpenAPI and must be documented
from backend behavior.

### Example End-to-End Scenario

Support user reads sensitive document -> request includes `x-support-session-id`
-> pre-handler resolves session/effective actor -> file service maps sensitive
download to support-sensitive file permission -> audit written -> signed URL
returned or denial.

## 16. Exports / Retention / Deletion

### Business Purpose

Provides workspace export requests/artifacts and retention/deletion lifecycle for
expired/inactive workspaces.

### Actors

Workspace owner/authorized exporter, platform deletion admin, export worker,
retention worker.

### Preconditions

Authenticated actor. Export permissions for workspace export. Platform deletion
permissions for deletion lifecycle. Storage provider and worker configuration for
artifact generation.

### Main Entities

`WorkspaceExportRequestDocument`, `RetentionWarningMarkerDocument`,
`WorkspaceDeletionRequestDocument`, generated file intents/files.

### Lifecycle / State Machine

Export status is `PENDING`, `PROCESSING`, `READY`, `FAILED`, or `EXPIRED`.
Workspace deletion status includes `PENDING_APPROVAL`, `POSTPONED`, `CANCELLED`,
`APPROVED`, `PROCESSING`, `FAILED`, and `COMPLETED`.

### Create Flow

Export request:
actor -> auth -> service authorizes `exports.workspace.create` -> idempotency
transaction -> export request row -> audit/outbox `WorkspaceExportRequested` ->
response.

Retention/deletion request creation is worker/service driven from subscription and
retention policy conditions.

### Read Flow

Export list/detail/download URL uses export permissions. Deletion list/detail uses
platform deletion read permission in service.

### Update Flow

Export worker claims pending requests, aggregates data, writes generated artifact,
marks ready/failed, and emits audit/outbox. Deletion approve/postpone/cancel use
expectedVersion; approve route is idempotent.

### Delete / Archive Flow

Deletion processor removes live data per manifest and finalizes tombstone/evidence.
Exports expire rather than being manually deleted by public route.

### Important Commands

Create export, create export download URL, approve/postpone/cancel deletion,
worker process export, worker process retention/deletion.

### Important Queries

List/get exports, list/get workspace deletion requests.

### Permission Rules

Exports use `exports.workspace.*`. Deletion uses `deletion.read`,
`deletion.approve`, `deletion.postpone`, `deletion.cancel`.

### Scope Rules

Exports are workspace scoped. Deletion administration is platform scoped.

### Validation Rules

Export active request constraints, artifact state, deletion status transitions,
expectedVersion, retention policy windows, workspace/subscription state.

### Concurrency / Idempotency

Export create and deletion approve use idempotency. Export/deletion workers use
processing leases. Deletion transitions use expectedVersion.

### Audit / Outbox

Export and deletion lifecycle writes audit/outbox. Events feed notifications:
export ready/failed/expired and deletion requested/postponed/cancelled/approved.

### Notifications

Notification registry includes workspace export and deletion/retention events.

### Files / Documents

Exports create generated file artifacts through storage/files infrastructure.
Deletion removes or preserves file/document data based on manifest/evidence rules.

### Retention / Export

This module owns retention/export/deletion behavior.

### Error Scenarios

Export not ready, expired artifact, deletion state conflict, expected-version
conflict, idempotency missing/mismatch, storage failure, worker lease contention.

### Frontend Implications

Exports are asynchronous: request, poll/list/detail, then request download URL when
ready. Deletion actions require platform admin UI with version conflict handling.

### Example End-to-End Scenario

Owner requests export -> auth -> `exports.workspace.create` -> idempotency
transaction creates `PENDING` export -> worker claims it -> builds artifact and
file metadata -> marks `READY` -> outbox notifies requester -> frontend downloads.

## 17. Dashboards / Analytics

### Business Purpose

Provides read-time operational dashboards and analytics from persisted V1 domain
truth across relationships, training, workouts, nutrition, progress, check-ins,
documents, branches, and memberships.

### Actors

Owner, manager, trainer, assistant trainer, nutritionist, trainee SELF, support
effective actor.

### Preconditions

Authenticated actor. Analytics/dashboard permission and eligible workspace/
relationship scope. Restricted workspace and support workspace context can be
denied for Stage 18 routes.

### Main Entities

No dedicated analytics collection. Reads `coaching_relationships`,
`trainee_staff_assignments`, `membership_branch_assignments`, `branches`,
`workspace_memberships`, `workout_sessions`, `programs`,
`program_progress_events`, `personal_record_events`, `nutrition_plans`,
`nutrition_plan_revisions`, `measurement_entries`, `metric_definitions`,
`progress_photo_entries`, `daily_tracking_entries`, `checkin_instances`,
`documents`, and `workspaces`.

### Lifecycle / State Machine

Analytics has no persisted lifecycle. It derives from source module statuses such
as relationship status, workout status, check-in status, plan/program status, and
document status.

### Create Flow

None. Stage 18 analytics is read-time aggregation and does not create analytics
projection documents.

### Read Flow

Actor -> auth -> support context if present -> analytics service resolves access
with analytics permissions -> domain eligibility checks workspace/relationship/
branch/assignment visibility -> repository aggregation over source collections ->
sensitive audit for sensitive relationship dashboard/analytics access -> response.

### Update Flow

None.

### Delete / Archive Flow

None.

### Important Commands

No mutation commands.

### Important Queries

Trainer dashboard, gym dashboard, relationship dashboard, relationship training,
progress, nutrition, and adherence analytics.

### Permission Rules

Uses `dashboard.trainer.read`, `dashboard.gym.read`,
`dashboard.relationship.read`, `analytics.training.read`,
`analytics.progress.read`, `analytics.nutrition.read`, and
`analytics.adherence.read`.

### Scope Rules

Trainer dashboard is assignment rooted. Gym dashboard can be workspace, branch, or
multi-branch scoped. Relationship analytics supports SELF, assigned, specific
relationship, branch, and workspace scopes where allowed.

### Validation Rules

Workspace-local date ranges, timezone validity, relationship workspace match,
branch filter/cursor compatibility, category-bound cursor rules, sensitive section
visibility, actor component filters.

### Concurrency / Idempotency

Read-only; no idempotency keys or expectedVersion are used for analytics routes.

### Audit / Outbox

Sensitive analytics access writes sensitive audit evidence. No analytics outbox
events are emitted.

### Notifications

None directly.

### Files / Documents

Analytics reads document/photo metadata but does not grant download access or
change file state.

### Retention / Export

Analytics reads only current persisted data; retention/deletion can remove source
data and thereby change analytics results.

### Error Scenarios

Permission denial, branch/scope denial, restricted workspace, invalid timezone,
invalid cursor/filter pairing, cross-workspace relationship, sensitive audit
failure.

### Frontend Implications

Frontend must not assume dashboard fields are globally visible. Role/component
filters can return stable null/empty sections. Recent Activity and Needs Attention
pagination can be category-bound.

### Example End-to-End Scenario

Trainer opens trainer dashboard -> auth -> analytics service checks
`dashboard.trainer.read` and assigned relationship scope -> repository aggregates
assigned relationships, workouts, check-ins, and attention categories -> response
returns visible dashboard DTO without raw sensitive fields.

## Discrepancies And Corrections

- No new business modules were found beyond the 17 modules from V1-DOC-01.
- Analytics has no analytics projection collection in V1; it is read-time
  aggregation from source module collections.
- OpenAPI was not regenerated or used as the source of truth for this guide.
- Some sensitive routes use service-level authorization instead of only
  route-level `requireAccess`; this is documented rather than normalized.

## Evidence Checked

- `docs/v1/backend-module-inventory.md`
- `src/api/build-app.ts`
- `src/modules/**/**.routes.ts`
- `src/modules/**/**.service.ts`
- `src/modules/**/**.repository.ts`
- `src/modules/**/**.types.ts`
- `src/modules/permissions/permission.registry.ts`
- `src/core/access-control/access-control.service.ts`
- `src/worker/main.ts`
- Stage tests from `test/stage3-*` through `test/stage18-*`
