# V1 Backend Module Inventory

Issue: V1-DOC-01 / GitHub #1

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Branch inspected: `main`

Backend root inspected: `apps/backend`

## Source Of Truth

This inventory is grounded in the locked Stage 18 backend implementation. Source code,
route definitions, schema/type files, permission registry/access-control code, tests,
migrations, and the worker registration are authoritative over earlier planning docs,
generated OpenAPI artifacts, and previous discovery summaries.

If an existing document disagrees with implementation, the implementation wins. This
inventory records module boundaries only; downstream issues own detailed business
flows, state-machine references, frontend integration contracts, and permission
matrices.

## Backend V1 Feature-Complete Boundary

Backend V1 is feature-complete through Stage 18. Stages 2-18 are locked and must not
be reopened by documentation work.

This means:

- Implemented backend functionality is the REST API, application services,
  repositories, access-control behavior, transactions, outbox/events, workers, and
  migrations present at the locked commit.
- Documentation work remains pending for business flows, frontend integration,
  status references, permission matrix, seed-data design, QA scenarios, and release
  handoff.
- Frontend implementation is not implied complete by this backend inventory.
- Seed/test-data implementation is not present as a first-class production seed
  framework; test-local fixtures exist in backend tests.
- Release-readiness work remains pending.

## Classification

### First-Class V1 Business Modules

The confirmed V1 backend business modules are:

1. Auth / Identity
2. Workspace / Platform / Branches / Memberships
3. Permissions / Access Control
4. Subscriptions / Payments / Entitlements
5. Leads / Owner Activation
6. Trainee Relationships
7. Training
8. Workouts / PRs
9. Nutrition
10. Progress
11. Check-ins
12. Files / Documents
13. Notifications
14. Audit
15. Support Access
16. Exports / Retention / Deletion
17. Dashboards / Analytics

No additional first-class V1 business module was found beyond these route-registered
modules. `identity` and `platform` have repositories/types but are used as part of
Auth / Identity and Workspace / Platform rather than separately route-registered
business modules.

### Cross-Cutting Infrastructure

These are important runtime infrastructure, not standalone business modules:

- `UnitOfWork` / MongoDB transactions
- `AppError` and centralized error handling
- request context plugin and auth middleware
- idempotency service and `idempotency_records`
- transactional outbox writer/processor and `outbox_events`
- `JobLeaseManager` and `job_leases`
- storage provider abstraction / S3-compatible provider
- email and push provider abstractions
- OpenAPI generation/export tooling
- configuration, logger, migrations runner, health route

These should be documented where relevant to module behavior, but frontend and QA
work should not treat them as separate business modules.

### Generated And Documentation Artifacts

- `docs/apidog/openapi.json` is a generated/exported artifact. It is not treated as
  authoritative unless verified against current route/schema implementation.
- Existing root `docs/Phase *.md` files are product/design documentation. They are
  useful context but not authoritative when they diverge from implementation.

## Stage To Module Mapping

| Stage | Implemented ownership |
| --- | --- |
| Stage 1 | Foundation/infrastructure only: MongoDB indexes, project structure, config, logging, error primitives. No separate business module is route-registered from Stage 1. |
| Stage 2 | Auth / Identity: registration, login, refresh/logout, email/phone verification, password reset, MFA/TOTP, sessions, challenges, rate limits, security events. |
| Stage 3 | Workspace / Platform / Branches / Memberships foundation: current user, platform memberships, workspaces, branches, workspace memberships, invitations, branch assignments. |
| Stage 4 | Permissions / Access Control: permission definitions, profiles, grants, effective access, DENY precedence, scopes, branch and relationship-aware access checks. |
| Stage 5 | Subscriptions / Payments / Entitlements: plans, plan versions, subscriptions, terms, manual payments, workspace usage, quota/feature gates, idempotent commercial commands. |
| Stage 6 | Leads / Owner Activation: public leads, platform lead operations, lead conversion, owner activation completion/reissue. |
| Stage 7 | Trainee Relationships: coaching relationships, trainee invitations/referrals, primary trainer, assistant trainer, nutritionist assignments, trainee migration. |
| Stage 8 | Training: exercises, program templates/revisions, assigned programs/revisions, activation, completion/archive, program progress. |
| Stage 9 | Workouts / PRs: workout sessions, start/current/list/patch/complete/abandon/correct, skip/defer progress, personal records and PR events. |
| Stage 10 | Nutrition: foods, platform/system foods, nutrition plans/revisions, activation, completion/archive. |
| Stage 11 | Progress: metric definitions, measurements, progress photo metadata, health profile, coaching notes, adherence config, daily tracking. |
| Stage 12 | Check-ins: templates/revisions, assignments, generated instances, submit/review, due/overdue/skipped behavior. |
| Stage 13 | Files / Documents: upload intents, file metadata, generated file intents, business documents, signed URLs, confirmation, delete/restore/purge. |
| Stage 14 | Notifications: notifications, preferences, deliveries, push devices, event-driven notification creation/delivery. |
| Stage 15 | Audit: audit event persistence/query APIs and sensitive-read audit convention. |
| Stage 16 | Support Access: portal access policies, support access requests, support sessions, `x-support-session-id` effective actor context. |
| Stage 17 | Exports / Retention / Deletion: workspace export requests/artifacts, retention warnings, workspace deletion lifecycle and processors. |
| Stage 18 | Dashboards / Analytics: trainer/gym/relationship dashboards and relationship analytics for training/progress/nutrition/adherence. |

## Module Inventory

### 1. Auth / Identity

**Stage:** Stage 2

**Business purpose:** Provides user identity, credentials, login/session lifecycle,
verification, password reset, and MFA enforcement.

**Main domain entities:** `UserDocument`, `AuthSessionDocument`,
`AuthRefreshTokenDocument`, `AuthChallengeDocument`, `AuthMfaMethodDocument`,
`AuthRateLimitDocument`, `AuthSecurityEventDocument`.

**Persistence:** `users`, `auth_sessions`, `auth_refresh_tokens`,
`auth_challenges`, `auth_mfa_methods`, `auth_rate_limits`,
`auth_security_events`.

**Main API surface:**

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/mfa/login/verify`
- `GET /api/v1/auth/mfa`
- `POST /api/v1/auth/mfa/totp/setup`
- `POST /api/v1/auth/mfa/totp/confirm`
- `POST /api/v1/auth/mfa/step-up`
- `POST /api/v1/auth/mfa/step-up/verify`
- `POST /api/v1/auth/mfa/recovery-codes/regenerate`
- `POST /api/v1/auth/mfa/disable`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/verify-email`
- `POST /api/v1/auth/verify-phone`
- `POST /api/v1/auth/resend-verification`
- `POST /api/v1/auth/forgot-password`
- `POST /api/v1/auth/reset-password`

**Main operations:** register, login, complete MFA login, read MFA status, set up
and confirm TOTP, perform MFA step-up, regenerate recovery codes, disable MFA,
refresh access tokens, logout, verify email/phone, resend verification, request
and complete password reset.

**Permissions / access:** Public routes use route-level unauthenticated schemas.
Authenticated routes use `requireAuth`; some allow restricted sessions, such as
MFA status. This module is not governed by workspace permission grants for public
authentication commands.

**Major dependencies:** Identity repository, credential hashing/digests, password
hasher, JWT service, TOTP service, refresh-token service, request metadata, cookie
transport for web clients.

**Background / asynchronous behavior:** No worker was registered for Auth. Security
events are persisted synchronously by auth services.

**Important business constraints:** Registration requires a login identifier;
mobile and web refresh-token transports differ; refresh tokens rotate and are
single-use; replaying consumed refresh tokens can revoke a token family; pending
activation users cannot log in; MFA challenges and recovery codes are consumed
with attempt limits.

### 2. Workspace / Platform / Branches / Memberships

**Stage:** Stage 3

**Business purpose:** Owns multi-tenant workspace structure, platform memberships,
workspace memberships, branches, staff invitations, branch assignments, and current
user/workspace discovery.

**Main domain entities:** `WorkspaceDocument`, `PlatformMembershipDocument`,
`WorkspaceMembershipDocument`, `BranchDocument`,
`MembershipBranchAssignmentDocument`, `InvitationDocument`, `UserDocument`.

**Persistence:** `workspaces`, `platform_memberships`,
`workspace_memberships`, `branches`, `membership_branch_assignments`,
`invitations`, `users`.

**Main API surface:**

- `GET /api/v1/me`, `PATCH /api/v1/me`, `GET /api/v1/me/workspaces`
- `POST /api/v1/platform/workspaces`
- `GET /api/v1/platform/memberships`, `POST /api/v1/platform/memberships`
- `POST /api/v1/platform/memberships/:platformMembershipId/suspend`
- `POST /api/v1/platform/memberships/:platformMembershipId/reactivate`
- `POST /api/v1/platform/memberships/:platformMembershipId/end`
- `GET /api/v1/workspaces/:workspaceId`
- `PATCH /api/v1/workspaces/:workspaceId`
- `GET /api/v1/workspaces/:workspaceId/branches`
- `GET /api/v1/workspaces/:workspaceId/branches/:branchId`
- `PATCH /api/v1/workspaces/:workspaceId/branches/:branchId`
- `POST /api/v1/workspaces/:workspaceId/branches`
- `POST /api/v1/workspaces/:workspaceId/branches/:branchId/archive`
- `GET /api/v1/workspaces/:workspaceId/memberships`
- `GET /api/v1/workspaces/:workspaceId/memberships/:membershipId`
- `POST /api/v1/workspaces/:workspaceId/staff/invitations`
- `POST /api/v1/invitations/accept`
- `POST /api/v1/workspaces/:workspaceId/invitations/:invitationId/revoke`
- `GET /api/v1/workspaces/:workspaceId/memberships/:membershipId/branches`
- `POST /api/v1/workspaces/:workspaceId/memberships/:membershipId/branches/:branchId`
- `DELETE /api/v1/workspaces/:workspaceId/memberships/:membershipId/branches/:branchId`

**Main operations:** read/update current user, list user workspaces, create
workspaces, manage platform memberships, read/update workspaces, create/update/
archive branches, read memberships, invite/revoke/accept staff invitations, manage
membership branch assignments.

**Permissions / access:** Platform membership APIs require platform permissions.
Workspace/branch/staff APIs use centralized access control via workspace
permissions such as `workspace.read`, `workspace.update`, `branches.*`,
`staff.*`, and branch-scoped access where relevant.

**Major dependencies:** Auth request context, platform memberships, workspace
memberships, branch assignment access, permission profiles, subscription
entitlements/usage for staff limits, audit, outbox.

**Background / asynchronous behavior:** Writes business audit and outbox events for
membership/branch/profile changes. Some events are consumed by Trainee
Relationships for primary-trainer eligibility reconciliation.

**Important business constraints:** Active membership and workspace state are hard
access prerequisites; branch eligibility is enforced structurally; platform MFA is
a hard prerequisite for platform membership access; membership lifecycle changes
can affect downstream trainee assignment eligibility.

### 3. Permissions / Access Control

**Stage:** Stage 4

**Business purpose:** Centralizes permission definitions, system profiles, custom
profiles, grants, effective access inspection, and runtime authorization decisions.

**Main domain entities:** `PermissionDefinitionDocument`,
`PermissionProfileDocument`, `AccessGrantDocument`.

**Persistence:** `permission_definitions`, `permission_profiles`,
`access_grants`.

**Main API surface:**

- `GET /api/v1/permissions`
- `GET /api/v1/workspaces/:workspaceId/permission-profiles`
- `POST /api/v1/workspaces/:workspaceId/permission-profiles`
- `PATCH /api/v1/workspaces/:workspaceId/permission-profiles/:profileId`
- `POST /api/v1/workspaces/:workspaceId/permission-profiles/:profileId/archive`
- `PUT /api/v1/workspaces/:workspaceId/memberships/:membershipId/permission-profiles`
- `GET /api/v1/workspaces/:workspaceId/memberships/:membershipId/access`
- `PUT /api/v1/workspaces/:workspaceId/memberships/:membershipId/access`
- `GET /api/v1/workspaces/:workspaceId/memberships/:membershipId/effective-access`
- `GET /api/v1/platform/permission-profiles`
- `POST /api/v1/platform/permission-profiles`
- `PATCH /api/v1/platform/permission-profiles/:profileId`
- `POST /api/v1/platform/permission-profiles/:profileId/archive`
- `PUT /api/v1/platform/memberships/:membershipId/permission-profiles`
- `GET /api/v1/platform/memberships/:membershipId/access`
- `PUT /api/v1/platform/memberships/:membershipId/access`

**Main operations:** list definitions, create/update/archive profiles, replace
profile assignments, read/replace explicit grants, inspect effective access.

**Permissions / access:** The module uses its own management permissions:
`staff.permissions.manage` for workspace permissions and
`platform_permissions.manage` for platform permissions. Runtime access checks are
implemented by `AccessControlService` and `requireAccess`.

**Major dependencies:** Workspace/platform memberships, workspace/branch state,
membership branch assignments, coaching relationships for relationship-scoped
access, support access context for `WORKSPACE_SUPPORT` and `USER_CONTEXT`.

**Background / asynchronous behavior:** Permission profile replacement writes
audit/outbox events; trainee outbox handlers listen for
`MembershipPermissionProfilesReplaced` to reconcile primary trainer eligibility.

**Important business constraints:** DENY wins over ALLOW at equal or broader
applicable specificity; expired grants are ignored; archived profiles and unknown
database-only keys cannot authorize; branch atom normalization makes equal
specificity DENY deterministic; `relationshipId` scope is a coaching relationship
identifier, not a trainee user id.

### 4. Subscriptions / Payments / Entitlements

**Stage:** Stage 5

**Business purpose:** Owns commercial plans, plan versions, workspace
subscriptions, terms, manual payments, usage/quota accounting, and entitlement
gates used by product modules.

**Main domain entities:** `SubscriptionPlanDocument`,
`SubscriptionPlanVersionDocument`, `SubscriptionDocument`,
`SubscriptionTermDocument`, `WorkspaceUsageDocument`, `ManualPaymentDocument`.

**Persistence:** `subscription_plans`, `subscription_plan_versions`,
`subscriptions`, `subscription_terms`, `workspace_usage`, `manual_payments`.

**Main API surface:**

- `GET /api/v1/workspaces/:workspaceId/subscription`
- `GET /api/v1/workspaces/:workspaceId/subscription/usage`
- `POST /api/v1/workspaces/:workspaceId/payments`
- `GET /api/v1/workspaces/:workspaceId/payments`
- `GET /api/v1/platform/subscription-plans`
- `POST /api/v1/platform/subscription-plans`
- `GET /api/v1/platform/subscription-plans/:planId`
- `PATCH /api/v1/platform/subscription-plans/:planId`
- `POST /api/v1/platform/subscription-plans/:planId/versions`
- `POST /api/v1/platform/subscription-plans/:planId/archive`
- `GET /api/v1/platform/workspaces/:workspaceId/subscription`
- `POST /api/v1/platform/workspaces/:workspaceId/subscription/start-trial`
- `POST /api/v1/platform/workspaces/:workspaceId/subscription/upgrade`
- `POST /api/v1/platform/workspaces/:workspaceId/subscription/downgrade`
- `POST /api/v1/platform/workspaces/:workspaceId/subscription/freeze`
- `POST /api/v1/platform/workspaces/:workspaceId/subscription/reactivate`
- `POST /api/v1/platform/workspaces/:workspaceId/subscription/cancel`
- `GET /api/v1/platform/payments`
- `GET /api/v1/platform/payments/:paymentId`
- `POST /api/v1/platform/payments/:paymentId/approve`
- `POST /api/v1/platform/payments/:paymentId/reject`

**Main operations:** read subscription/usage/payments, create manual payments,
create/update/archive plans, create plan versions, start trial, upgrade/downgrade,
freeze/reactivate/cancel subscriptions, approve/reject payments.

**Permissions / access:** Workspace billing permissions govern workspace billing
routes. Platform `plans.*`, `subscriptions.*`, and `payments.*` permissions govern
commercial admin routes. Entitlement checks gate many downstream write operations.

**Major dependencies:** Workspaces, workspace memberships, access control, audit,
outbox, idempotency, retention for deletion cancellation behavior, trainee usage
and file storage usage counters.

**Background / asynchronous behavior:** `SubscriptionJobRunner` runs due jobs in
the worker with `JobLeaseManager`. Commercial mutations write audit/outbox events.

**Important business constraints:** Product writes are blocked for inactive or
frozen commercial states while billing reads remain available; quota reservations
are transactional; idempotent commands replay matching completed requests and
reject mismatches/in-progress duplicates; cancelled subscriptions cannot be
reactivated/upgraded/downgraded/activated by payment.

### 5. Leads / Owner Activation

**Stage:** Stage 6

**Business purpose:** Handles public lead capture, platform lead management,
conversion to workspace/owner activation, duplicate handling, merging, and owner
activation completion.

**Main domain entities:** `LeadDocument`, pending/active `UserDocument`,
`WorkspaceDocument`, `InvitationDocument`, subscription trial records created by
conversion/activation.

**Persistence:** `leads`, plus writes into `users`, `workspaces`,
`workspace_memberships`, `invitations`, permission profile assignments, and
subscription collections during conversion/activation.

**Main API surface:**

- `POST /api/v1/public/leads`
- `GET /api/v1/platform/leads`
- `GET /api/v1/platform/leads/:leadId`
- `PATCH /api/v1/platform/leads/:leadId`
- `POST /api/v1/platform/leads/:leadId/status`
- `POST /api/v1/platform/leads/:leadId/convert`
- `POST /api/v1/platform/leads/:leadId/owner-activation/reissue`
- `POST /api/v1/platform/leads/:leadId/mark-duplicate`
- `POST /api/v1/platform/leads/:leadId/merge`
- `POST /api/v1/public/owner-activations/complete`

**Main operations:** create public lead, list/read/update leads, change lead
status, convert lead, reissue owner activation, mark duplicate, merge duplicate,
complete owner activation.

**Permissions / access:** Public lead/activation routes are unauthenticated.
Platform routes require `leads.read`, `leads.update`, `leads.convert`,
`leads.mark_duplicate`, or `leads.merge`.

**Major dependencies:** Auth/identity, workspace creation, invitations,
permissions/profiles, subscriptions/trials/quotas, access control, audit, outbox,
idempotency.

**Background / asynchronous behavior:** Conversion and duplicate/merge operations
write audit/outbox events. No separate lead worker is registered.

**Important business constraints:** Only approved source states can convert;
converted and duplicate leads reject metadata updates; owner activation records
verification attempts outside the main transaction; activation tokens are not
stored raw; quota failures roll back activation writes and can be retried.

### 6. Trainee Relationships

**Stage:** Stage 7

**Business purpose:** Owns trainee coaching relationships, trainee invitations,
referrals, primary trainer assignment, assistant/nutritionist assignments, and
workspace-to-workspace trainee migration.

**Main domain entities:** `CoachingRelationshipDocument`,
`TraineeStaffAssignmentDocument`, `TraineeReferralCodeDocument`,
`InvitationDocument`, `WorkspaceMembershipDocument`.

**Persistence:** `coaching_relationships`, `trainee_staff_assignments`,
`referral_codes`, `invitations`, workspace membership/usage collections.

**Main API surface:**

- `GET /api/v1/workspaces/:workspaceId/relationships`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId`
- `POST /api/v1/workspaces/:workspaceId/trainee-invitations`
- `POST /api/v1/workspaces/:workspaceId/trainee-invitations/:invitationId/reissue`
- `POST /api/v1/referrals/:code/join`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/accept`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/reject`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/end`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/reactivate`
- `PUT /api/v1/workspaces/:workspaceId/relationships/:relationshipId/home-branch`
- `PUT /api/v1/workspaces/:workspaceId/relationships/:relationshipId/primary-trainer`
- `DELETE /api/v1/workspaces/:workspaceId/relationships/:relationshipId/primary-trainer`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/assistants`
- `DELETE /api/v1/workspaces/:workspaceId/relationships/:relationshipId/assistants/:membershipId`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutritionists`
- `DELETE /api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutritionists/:membershipId`
- `POST /api/v1/workspace-migrations/trainees`

**Main operations:** list/read relationships, invite trainee, reissue trainee
invitation, join referral, accept/reject/end/reactivate relationship, change home
branch, set/remove primary trainer, add/remove assistant trainers and
nutritionists, migrate independent trainee to gym workspace.

**Permissions / access:** Uses workspace access control and trainee permissions
such as `trainees.*` and `trainees.assignments.*`. Relationship detail uses
service-level relationship access checks in addition to authentication.

**Major dependencies:** Identity, workspaces, memberships, branches, branch
assignments, invitations, permission profiles, access control, entitlements and
usage quota, audit, outbox, training/nutrition/check-ins lifecycle ports.

**Background / asynchronous behavior:** Trainee outbox handlers process staff
membership ended, branch assignment ended, and permission profile replacement
events to reconcile primary eligibility. Relationship commands write audit/outbox
events.

**Important business constraints:** Active relationships count toward trainee
quota; primary removal can mark `NEEDS_REASSIGNMENT`; branch eligibility is
validated for assignments; ending a relationship triggers downstream lifecycle
handling in training/nutrition/check-ins; referral join creates pending state until
staff approval.

### 7. Training

**Stage:** Stage 8

**Business purpose:** Owns exercise libraries, program templates, assigned training
programs, immutable revisions, activation/replacement, completion/archive, and
program progress.

**Main domain entities:** `ExerciseDocument`, `ProgramTemplateDocument`,
`ProgramTemplateRevisionDocument`, `ProgramDocument`, `ProgramRevisionDocument`,
`ProgramProgressDocument`, `ProgramProgressEventDocument`.

**Persistence:** `exercises`, `program_templates`, `program_template_revisions`,
`programs`, `program_revisions`, `program_progress`,
`program_progress_events`.

**Main API surface:**

- `GET/POST /api/v1/workspaces/:workspaceId/exercises`
- `PATCH /api/v1/workspaces/:workspaceId/exercises/:exerciseId`
- `POST /api/v1/workspaces/:workspaceId/exercises/:exerciseId/archive`
- `GET/POST /api/v1/platform/exercises`
- `PATCH /api/v1/platform/exercises/:exerciseId`
- `POST /api/v1/platform/exercises/:exerciseId/archive`
- `GET/POST /api/v1/workspaces/:workspaceId/program-templates`
- `GET /api/v1/workspaces/:workspaceId/program-templates/:templateId`
- `POST /api/v1/workspaces/:workspaceId/program-templates/:templateId/revisions`
- `POST /api/v1/workspaces/:workspaceId/program-templates/:templateId/archive`
- `GET/POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/revisions`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/activate`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/complete`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/archive`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/progress`

**Main operations:** create/read/update/archive exercises, manage platform
exercise library, create/read/revise/archive templates, create/read/revise/activate
/complete/archive assigned programs, read program progress.

**Permissions / access:** Workspace training permissions govern workspace
exercises, templates, and programs. Platform system exercise permissions govern
platform exercises. Access control is relationship-scoped for assigned programs.

**Major dependencies:** Coaching relationships, memberships, access control,
entitlements, audit, outbox, workout lifecycle port.

**Background / asynchronous behavior:** No training worker is registered.
Activation/revision/completion writes audit/outbox events consumed by notifications.

**Important business constraints:** Revisions are immutable snapshots; active
program replacement is transactional; private/system/gym exercise scope is enforced;
archived/private exercise usability is revalidated; relationship end completes
active program and reactivation does not resume it.

### 8. Workouts / PRs

**Stage:** Stage 9

**Business purpose:** Executes active training programs as workout sessions,
captures actuals, advances program progress, tracks skip/defer decisions, and
maintains personal-record projections/events.

**Main domain entities:** `WorkoutSessionDocument`, `PersonalRecordDocument`,
`PersonalRecordEventDocument`, plus training progress documents.

**Persistence:** `workout_sessions`, `personal_records`,
`personal_record_events`, with reads/writes to training progress collections.

**Main API surface:**

- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts/start`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts/current`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts`
- `PATCH /api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/complete`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/abandon`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts/:workoutId/corrections`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/progress/skip`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs/:programId/progress/defer`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/personal-records`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/personal-record-events`

**Main operations:** start workout, read current/list workouts, patch live actuals,
complete, abandon, staff-correct completed workout, skip/defer current program day,
read PR projections and PR events.

**Permissions / access:** Uses workspace access control with `workouts.*`,
`workouts.day.*`, and `personal_records.read`. Relationship scope is enforced.

**Major dependencies:** Training/program progress, coaching relationships,
memberships, access control, entitlements, audit, outbox.

**Background / asynchronous behavior:** No workout worker is registered. Completion
and corrections write audit/outbox events, including PR-related events used by
notifications and analytics.

**Important business constraints:** One live workout per relationship/program
context is enforced; completion advances progress and creates PR projections once;
abandon preserves partial actuals without progress/PR advancement; corrections can
adjust/retract PR projections; frozen/training-downgrade states block writes while
preserving reads.

### 9. Nutrition

**Stage:** Stage 10

**Business purpose:** Owns food libraries and assigned nutrition plans, including
macro calculations, immutable revisions, activation/replacement, completion, and
archive behavior.

**Main domain entities:** `FoodDocument`, `NutritionPlanDocument`,
`NutritionPlanRevisionDocument`.

**Persistence:** `foods`, `nutrition_plans`, `nutrition_plan_revisions`.

**Main API surface:**

- `GET/POST /api/v1/workspaces/:workspaceId/foods`
- `PATCH /api/v1/workspaces/:workspaceId/foods/:foodId`
- `POST /api/v1/workspaces/:workspaceId/foods/:foodId/archive`
- `GET/POST /api/v1/platform/foods`
- `PATCH /api/v1/platform/foods/:foodId`
- `POST /api/v1/platform/foods/:foodId/archive`
- `GET/POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans/:planId`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans/:planId/revisions`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans/:planId/activate`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans/:planId/complete`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans/:planId/archive`

**Main operations:** create/read/update/archive foods, manage platform foods,
create/read/revise/activate/complete/archive nutrition plans.

**Permissions / access:** Uses workspace nutrition/food permissions and platform
system food permissions. Relationship scope and nutritionist eligibility are
checked by services/access control.

**Major dependencies:** Coaching relationships, workspace memberships, access
control, entitlements, audit, outbox, progress health food allergies for limited
nutrition access.

**Background / asynchronous behavior:** No nutrition worker is registered.
Activation/revision writes audit/outbox events consumed by notifications.

**Important business constraints:** Macro calculation is server-authoritative;
food snapshots are immutable in revisions; archived alternative foods remain
historical but can block new complete-content validation; responsible membership
must be active and eligible at create/activation time.

### 10. Progress

**Stage:** Stage 11

**Business purpose:** Captures trainee progress data: metric definitions,
measurements, progress photo metadata, health profiles, coaching notes, adherence
configuration, and daily tracking.

**Main domain entities:** `MetricDefinitionDocument`,
`MeasurementEntryDocument`, `ProgressPhotoEntryDocument`,
`TraineeHealthProfileDocument`, `CoachingNoteDocument`,
`AdherenceConfigDocument`, `DailyTrackingEntryDocument`.

**Persistence:** `metric_definitions`, `measurement_entries`,
`progress_photo_entries`, `trainee_health_profiles`, `coaching_notes`,
`adherence_configs`, `daily_tracking_entries`.

**Main API surface:**

- `GET/POST /api/v1/workspaces/:workspaceId/metric-definitions`
- `PATCH /api/v1/workspaces/:workspaceId/metric-definitions/:metricDefinitionId`
- `POST /api/v1/workspaces/:workspaceId/metric-definitions/:metricDefinitionId/archive`
- `GET/POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/measurements`
- `PATCH /api/v1/workspaces/:workspaceId/relationships/:relationshipId/measurements/:measurementId`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/progress-photos`
- `GET/PUT /api/v1/workspaces/:workspaceId/relationships/:relationshipId/health-profile`
- `GET/POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/notes`
- `PATCH /api/v1/workspaces/:workspaceId/relationships/:relationshipId/notes/:noteId`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/notes/:noteId/archive`
- `GET/PUT /api/v1/workspaces/:workspaceId/relationships/:relationshipId/adherence-config`
- `GET/PUT /api/v1/workspaces/:workspaceId/relationships/:relationshipId/daily-tracking/:localDate`

**Main operations:** manage metric definitions, create/update measurements, list
photo metadata, read/update health profile, create/update/archive coaching notes,
read/configure adherence metrics, read/update daily tracking.

**Permissions / access:** Uses progress permissions such as
`metric_definitions.*`, `measurements.*`, `progress_photos.read`, `health.*`,
`notes.*`, and `adherence.*`. Some sensitive reads are authorized inside services
rather than via only route-level `requireAccess`.

**Major dependencies:** Coaching relationships, workspace timezone, workspace
memberships, access control, entitlements, audit, outbox, file metadata for photos.

**Background / asynchronous behavior:** No progress worker is registered. Progress
mutations write audit/outbox where implemented; sensitive reads write sensitive
audit evidence.

**Important business constraints:** Built-in BODY_WEIGHT metric is seeded by
migration; metric unit/value type are immutable; measurements support same-day
multiple entries and correction/archive boundaries; health profile is singleton;
private notes are author-isolated; daily tracking uses workspace IANA timezone and
edit windows.

### 11. Check-ins

**Stage:** Stage 12

**Business purpose:** Provides configurable check-in templates, recurring
assignments, generated instances, trainee submissions, review workflow, and due/
overdue automation.

**Main domain entities:** `CheckInTemplateDocument`,
`CheckInTemplateRevisionDocument`, `CheckInAssignmentDocument`,
`CheckInInstanceDocument`.

**Persistence:** `checkin_templates`, `checkin_template_revisions`,
`checkin_assignments`, `checkin_instances`.

**Main API surface:**

- `GET/POST /api/v1/workspaces/:workspaceId/checkin-templates`
- `GET /api/v1/workspaces/:workspaceId/checkin-templates/:templateId`
- `POST /api/v1/workspaces/:workspaceId/checkin-templates/:templateId/revisions`
- `POST /api/v1/workspaces/:workspaceId/checkin-templates/:templateId/archive`
- `GET/POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkin-assignments`
- `PATCH /api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkin-assignments/:assignmentId`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkin-assignments/:assignmentId/end`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkins`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkins/:checkinId`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkins/:checkinId/submit`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkins/:checkinId/review`

**Main operations:** create/read/revise/archive templates, create/read/update/end
assignments, generate/read instances, submit check-ins, review submitted check-ins.

**Permissions / access:** Uses `checkins.templates.*`, `checkins.assignments.*`,
`checkins.assign`, `checkins.read`, `checkins.submit`, and `checkins.review`.
Sensitive instance access requires relationship scope and check-in permissions.

**Major dependencies:** Coaching relationships, workspace timezone, workspace
memberships, access control, entitlements, audit, outbox, notifications.

**Background / asynchronous behavior:** `CheckInJobRunner` generates due instances
and marks due/overdue/skipped states using job leases. Check-in events feed
notifications through the outbox.

**Important business constraints:** Template revisions are immutable; recurrence
normalization uses timezone-aware period keys; first eligible period does not create
retroactive already-expired instances; self-only submission and response validation
are enforced; ended relationships stop generation and skip open instances.

### 12. Files / Documents

**Stage:** Stage 13

**Business purpose:** Handles upload reservations, signed upload/download URLs,
file metadata, upload confirmation, file deletion/restore/purge, and relationship
business documents including sensitive medical documents.

**Main domain entities:** `UploadIntentDocument`, `FileDocument`,
`GeneratedFileIntentDocument`, `BusinessDocument`.

**Persistence:** `upload_intents`, `generated_file_intents`, `files`,
`documents`.

**Main API surface:**

- `POST /api/v1/workspaces/:workspaceId/files/upload-intents`
- `POST /api/v1/workspaces/:workspaceId/files/upload-intents/:uploadIntentId/confirm`
- `POST /api/v1/workspaces/:workspaceId/files/:fileId/download-url`
- `DELETE /api/v1/workspaces/:workspaceId/files/:fileId`
- `POST /api/v1/workspaces/:workspaceId/files/:fileId/restore`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents`
- `POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents/:documentId`
- `DELETE /api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents/:documentId`

**Main operations:** create upload intent, confirm upload, create download URL,
soft-delete file, restore file, list/create/read/delete documents.

**Permissions / access:** Route layer requires authentication; file service
performs context authorization using files/documents/medical-document permissions
and support-sensitive gates. Sensitive file download maps to support-sensitive file
permission when support context is used.

**Major dependencies:** Storage provider, workspace usage/storage quotas,
coaching relationships, workspace memberships, access control, entitlements,
support access, audit, outbox, retention/export for generated artifacts.

**Background / asynchronous behavior:** `FileJobRunner` expires upload intents and
purges eligible files. Document upload writes outbox events consumed by
notifications.

**Important business constraints:** Upload requires reservation and confirmation;
S3-compatible storage enforces no-overwrite upload and authenticated HEAD
verification; SHA-256/size semantics are checked during confirmation; file quota is
reserved/committed/released transactionally; file deletion is soft-delete before
purge.

### 13. Notifications

**Stage:** Stage 14

**Business purpose:** Creates and delivers user notifications from domain events,
tracks read state, preferences, delivery attempts, and push device registration.

**Main domain entities:** `NotificationDocument`,
`NotificationPreferencesDocument`, `NotificationDeliveryDocument`,
`PushDeviceDocument`.

**Persistence:** `notifications`, `notification_preferences`,
`notification_deliveries`, `push_devices`, plus source event reads from
`outbox_events` and domain collections.

**Main API surface:**

- `GET /api/v1/me/notifications`
- `POST /api/v1/me/notifications/:notificationId/read`
- `POST /api/v1/me/notifications/read-all`
- `GET /api/v1/me/notification-preferences`
- `PUT /api/v1/me/notification-preferences`
- `POST /api/v1/me/push-devices`
- `DELETE /api/v1/me/push-devices/:deviceId`

**Main operations:** list notifications, mark one/read all, read/update
preferences, register/revoke push devices, process notification deliveries.

**Permissions / access:** Authenticated `me` routes; notification ownership is
derived from the authenticated user. Notification creation uses event recipient
resolution rather than user-facing permission routes.

**Major dependencies:** Outbox processor, identity, workspaces, memberships,
relationships, check-ins, exports, files/documents, subscriptions, support access,
retention/deletion, audit, email provider, push provider.

**Background / asynchronous behavior:** `registerNotificationOutboxHandlers`
registers handlers for notification event types. `NotificationJobRunner` processes
delivery retries/cancellations through job leases.

**Important business constraints:** Notification registry is code-versioned; no
receipt collection exists in Stage 14; duplicate handler keys fail deterministically;
delivery state supports pending/retrying/sent/failed/cancelled; preferences affect
delivery behavior.

### 14. Audit

**Stage:** Stage 15

**Business purpose:** Persists and exposes audit evidence for workspace/platform
operations and sensitive-resource reads.

**Main domain entities:** `AuditEventDocument`.

**Persistence:** `audit_events`.

**Main API surface:**

- `GET /api/v1/workspaces/:workspaceId/audit`
- `GET /api/v1/platform/audit`

**Main operations:** list workspace audit events, list platform audit events, write
audit evidence through shared audit writer from other modules, write sensitive
resource access records.

**Permissions / access:** Workspace audit API requires `audit.workspace.read`.
Platform audit API requires `audit.platform.read`. Sensitive audit metadata has
`audit.sensitive.read` in the permission registry.

**Major dependencies:** All auditable business modules, access control, request
context, sensitive-read conventions.

**Background / asynchronous behavior:** No audit worker is registered. Audit writes
are synchronous; tests show selected sensitive reads fail closed when audit evidence
cannot be written.

**Important business constraints:** Audit write failure can roll back sensitive or
business operations in modules that require audit as part of a transaction. Audit
query APIs support filters/pagination from schemas.

### 15. Support Access

**Stage:** Stage 16

**Business purpose:** Allows authorized platform support users to open controlled
workspace support sessions and access workspace resources through support context.

**Main domain entities:** `PortalAccessPolicyDocument`,
`SupportAccessRequestDocument`, `SupportSessionDocument`.

**Persistence:** `portal_access_policies`, `support_access_requests`,
`support_sessions`.

**Main API surface:**

- `GET /api/v1/platform/support/policies`
- `POST /api/v1/platform/support/policies`
- `GET /api/v1/platform/support/policies/:policyId`
- `PATCH /api/v1/platform/support/policies/:policyId`
- `POST /api/v1/platform/support/policies/:policyId/disable`
- `POST /api/v1/platform/support/policies/:policyId/archive`
- `POST /api/v1/platform/support/access-requests`
- `GET /api/v1/platform/support/sessions`
- `GET /api/v1/platform/support/sessions/:sessionId`
- `POST /api/v1/platform/support/sessions/:sessionId/end`
- `POST /api/v1/platform/support/sessions/:sessionId/revoke`

**Main operations:** list/create/read/update/disable/archive access policies,
start support sessions, list/read/end/revoke sessions, resolve
`x-support-session-id` into request context.

**Permissions / access:** Support service authorizes platform support permissions
inside the service. Support request context integrates with `AccessControlService`
for `WORKSPACE_SUPPORT` and `USER_CONTEXT`; support-sensitive reads require
support-sensitive permissions.

**Major dependencies:** Platform memberships, auth sessions, workspaces, workspace
memberships, access control, audit, outbox, files support-access port.

**Background / asynchronous behavior:** `SupportAccessJobRunner.expireSessions`
expires active sessions. Support session/policy events feed notifications.

**Important business constraints:** `x-support-session-id` is resolved by a global
pre-handler before route handlers; support workspace context and restricted
workspaces can be denied; read-only support and sensitive gates are enforced by
access-control/service logic.

### 16. Exports / Retention / Deletion

**Stage:** Stage 17

**Business purpose:** Provides workspace data export lifecycle, generated export
artifacts, retention warnings, and controlled workspace deletion lifecycle.

**Main domain entities:** `WorkspaceExportRequestDocument`,
`RetentionWarningMarkerDocument`, `WorkspaceDeletionRequestDocument`,
`GeneratedFileIntentDocument`, export-related `FileDocument`.

**Persistence:** `workspace_export_requests`, `retention_warning_markers`,
`workspace_deletion_requests`, plus generated files/documents and many domain
collections through deletion manifests.

**Main API surface:**

- `POST /api/v1/workspaces/:workspaceId/exports`
- `GET /api/v1/workspaces/:workspaceId/exports`
- `GET /api/v1/workspaces/:workspaceId/exports/:exportId`
- `POST /api/v1/workspaces/:workspaceId/exports/:exportId/download-url`
- `GET /api/v1/platform/workspace-deletions`
- `GET /api/v1/platform/workspace-deletions/:deletionId`
- `POST /api/v1/platform/workspace-deletions/:deletionId/approve`
- `POST /api/v1/platform/workspace-deletions/:deletionId/postpone`
- `POST /api/v1/platform/workspace-deletions/:deletionId/cancel`

**Main operations:** request/list/read/download workspace export; create generated
export artifact; expire exports; list/read/approve/postpone/cancel workspace
deletion requests; process retention warnings and deletions.

**Permissions / access:** Export service authorizes workspace export permissions:
`exports.workspace.create`, `exports.workspace.read`,
`exports.workspace.download`. Retention/deletion service uses platform deletion
permissions: `deletion.read`, `deletion.approve`, `deletion.postpone`,
`deletion.cancel`.

**Major dependencies:** Workspace, subscriptions, files/storage, access control,
audit, outbox, notification events, retention policy config, many domain
collections during export/deletion processing.

**Background / asynchronous behavior:** `ExportJobRunner` processes pending
exports; `RetentionJobRunner` processes retention warnings and deletion lifecycle;
both use job leases. Export/retention/deletion events feed notifications.

**Important business constraints:** Export creation is idempotent and transactional;
generated artifacts use storage/files infrastructure; deletion processor removes
explicit live-data manifest while preserving retained evidence; retention warnings
and deletion lifecycle are asynchronous and stateful.

### 17. Dashboards / Analytics

**Stage:** Stage 18

**Business purpose:** Provides operational dashboards and analytics derived from
the persisted V1 domain truth across relationships, training, workouts, nutrition,
progress, check-ins, documents, and workspace/branch state.

**Main domain entities:** No dedicated analytics collection. Analytics reads
relationships, assignments, branch assignments, branches, memberships, workouts,
programs, progress events, PR events, nutrition plans/revisions, measurements,
metric definitions, progress photos, daily tracking, check-ins, documents, and
workspaces.

**Persistence:** Read-only aggregation across `coaching_relationships`,
`trainee_staff_assignments`, `membership_branch_assignments`, `branches`,
`workspace_memberships`, `workout_sessions`, `programs`,
`program_progress_events`, `personal_record_events`, `nutrition_plans`,
`nutrition_plan_revisions`, `measurement_entries`, `metric_definitions`,
`progress_photo_entries`, `daily_tracking_entries`, `checkin_instances`,
`documents`, `workspaces`.

**Main API surface:**

- `GET /api/v1/workspaces/:workspaceId/dashboard/trainer`
- `GET /api/v1/workspaces/:workspaceId/dashboard/gym`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/dashboard`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/analytics/training`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/analytics/progress`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/analytics/nutrition`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/analytics/adherence`

**Main operations:** read trainer dashboard, read gym dashboard, read relationship
dashboard, read relationship analytics for training/progress/nutrition/adherence.

**Permissions / access:** Routes require authentication, then service-level
authorization through access control with analytics permissions:
`dashboard.trainer.read`, `dashboard.gym.read`,
`dashboard.relationship.read`, `analytics.training.read`,
`analytics.progress.read`, `analytics.nutrition.read`,
`analytics.adherence.read`. Support-sensitive mapping applies for sensitive
analytics reads.

**Major dependencies:** Access control, audit, workspaces, branches, memberships,
trainee relationships, training, workouts/PRs, nutrition, progress, check-ins,
files/documents, timezone utilities embedded in analytics service logic.

**Background / asynchronous behavior:** No analytics worker and no analytics
projection collection are registered. Analytics is read-time aggregation over
persisted V1 domain state. Sensitive analytics access writes audit evidence.

**Important business constraints:** Trainer dashboard is assignment-rooted; gym
dashboard branch counts respect branch visibility; recent activity is gated before
source queries; cursors can be category-bound; workspace timezone drives date-only
ranges and DST boundaries; restricted workspaces and support workspace context are
denied for Stage 18 routes.

## Supporting Route-Registered Infrastructure

### Health

`src/api/health.routes.ts` registers health endpoints and is infrastructure rather
than a business module. It is excluded from the 17-module business inventory.

### OpenAPI Export

`apps/backend/scripts/export-openapi.ts` can export OpenAPI to `docs/apidog`, but
the generated artifact is not treated as authoritative for this inventory. Later
frontend issues must verify generator output against route/service behavior before
using it as an integration source.

## Repository Evidence Checked

The inventory was based on:

- Route registration in `apps/backend/src/api/build-app.ts`
- Module route files under `apps/backend/src/modules/**`
- Application services and repositories under `apps/backend/src/modules/**`
- Domain type files under `apps/backend/src/modules/**/*.types.ts`
- Permission registry and access-control implementation under
  `apps/backend/src/modules/permissions` and `apps/backend/src/core/access-control`
- Worker registration in `apps/backend/src/worker/main.ts`
- Outbox handlers in notifications and trainee modules
- Migrations `001` through `023-stage18-dashboards-analytics.ts`
- Backend tests from auth foundation through `stage18-dashboards-analytics.test.ts`
- Existing root documentation under `docs/`

## Material Discrepancies / Corrections

- Previous planning summaries that imply no committed documentation exists are
  incorrect. Root `docs/Phase *.md` files and `docs/apidog/openapi.json` already
  exist. They are not the final V1 handoff inventory and remain secondary to
  implementation.
- The route inventory confirms 17 first-class V1 business modules, not a separate
  first-class `identity` or `platform` module. Those repositories/types support
  Auth / Identity and Workspace / Platform.
- `docs/apidog/openapi.json` exists, but this issue did not regenerate or validate
  it. Later frontend issues must not assume it is current.
- Health, request context, transactions, idempotency, outbox, storage providers,
  job leases, error handling, and OpenAPI export are cross-cutting/supporting
  infrastructure, not separate business modules.

## Unverified Items For Later Issues

- Exact frontend-facing request/response examples, cursor contracts, error
  catalog, and idempotency/expectedVersion route-by-route requirements are out of
  scope for V1-DOC-01 and belong to V1 frontend-contract issues.
- Full business flows and state-transition tables are out of scope for this
  inventory and belong to V1-DOC-02 through V1-DOC-04.
- The detailed permission/access matrix is out of scope for this inventory and
  belongs to V1-DOC-05.
