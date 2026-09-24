# V1 Frontend Feature/API Mapping

Issue: V1-FE-04 / GitHub #9

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Backend root inspected: `apps/backend`

## Source Of Truth

The locked Stage 18 backend implementation is authoritative over generated
OpenAPI, previous summaries, and this document. Route files, schemas, services,
permission/access-control code, tests, migrations, and existing V1 docs win when
they disagree with generated artifacts.

This document maps frontend feature areas and user journeys to backend API call
sequences. It does not design new UI, introduce new product behavior, or replace
the route-level frontend API guide in `frontend-api-integration-guide.md`.

## Evidence Used

- `docs/v1/frontend-api-integration-guide.md`
- `docs/v1/permission-access-matrix.md`
- `docs/v1/backend-module-inventory.md`
- `docs/v1/module-business-flows.md`
- `docs/v1/cross-module-workflows.md`
- `docs/v1/state-machine-status-reference.md`
- `src/api/health.routes.ts`
- `src/modules/**/**.routes.ts`
- `src/modules/**/**.schemas.ts`
- `src/modules/permissions/permission.registry.ts`
- `src/core/access-control/access-control.service.ts`
- `src/modules/support-access/support-access.service.ts`

## Global Frontend Sequence

Every authenticated feature starts from the same backend contract:

1. Authenticate through `/api/v1/auth/*`.
2. Load `GET /api/v1/me`.
3. Load `GET /api/v1/me/workspaces`.
4. Select a workspace and persist `workspaceId` client-side.
5. For workspace features, pass `workspaceId` in route paths.
6. For support mode, pass `x-support-session-id` only after a support session is
   started and selected.
7. For relationship features, use the coaching `relationshipId`; do not use the
   trainee user id as a relationship id.
8. For mutations with `expectedVersion`, read the latest entity first and send
   the version/revision/accessVersion returned by the API.
9. For routes backed by idempotency wrappers, send a unique `Idempotency-Key` per
   user command and reuse it only for exact retry of the same request.

Common loading and error behavior:

- First page loads should show loading while the primary read request is in
  flight.
- Empty 200 responses are valid empty states.
- 401 should trigger one refresh attempt where a refresh credential exists.
- 403 should be treated as permission/scope denial, not as missing data.
- Version conflicts require refetch before retry.
- Quota, entitlement, frozen subscription, inactive workspace, and lifecycle
  errors are business denials even when permission was allowed.

## Feature Map

### Authentication And Session

| Concern | Contract |
| --- | --- |
| Use cases | Register, login, MFA login, refresh session, logout, verify email/phone, resend verification, password reset, manage MFA. |
| APIs required | `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/mfa/login/verify`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, verification/password routes, authenticated MFA routes under `/api/v1/auth/mfa*`. |
| Sequence | Login/register -> handle token or MFA challenge -> complete MFA if required -> call `GET /api/v1/me` -> call `GET /api/v1/me/workspaces`. |
| Data dependencies | Access token, optional refresh cookie/token, MFA challenge id/code where returned, current user, accessible workspaces. |
| Permissions | Public routes use route auth options; authenticated MFA routes require bearer auth. |
| Empty/loading | Workspaces can be empty for users with no active workspace access. |
| Pagination | None. |
| Optimistic/concurrency | Do not optimistically assume profile/workspace access after auth; load it. |
| Error/forbidden states | Invalid credentials, MFA required, restricted auth, verification conflicts, rate limits, refresh failure. |
| Role differences | Role-specific behavior begins after workspace/platform membership is loaded. |

### Workspace Selection And Current User

| Concern | Contract |
| --- | --- |
| Use cases | Current user shell, workspace picker, profile update. |
| APIs required | `GET /api/v1/me`, `PATCH /api/v1/me`, `GET /api/v1/me/workspaces`. |
| Sequence | Authenticated shell -> load current user -> load workspaces -> select active workspace -> route user into platform or workspace context. |
| Data dependencies | `userId`, available workspace memberships, selected `workspaceId`, membership id when exposed to the frontend. |
| Permissions | Bearer auth; workspace routes later require active workspace and membership. |
| Empty/loading | Show workspace loading until `/me/workspaces` resolves; empty workspaces means no workspace-scoped feature should be called. |
| Pagination | None. |
| Optimistic/concurrency | Profile update should wait for API success before assuming persisted values. |
| Error/forbidden states | `AUTH_REQUIRED`, inactive/missing membership on later workspace calls, restricted auth. |
| Role differences | Platform admins can enter platform flows; workspace members enter workspace flows; trainees use relationship-scoped SELF flows after relationship discovery. |

### Workspace Administration

| Concern | Contract |
| --- | --- |
| Use cases | Create workspace from platform, view/update workspace, manage branches. |
| APIs required | `POST /api/v1/platform/workspaces`, `GET /api/v1/workspaces/:workspaceId`, `PATCH /api/v1/workspaces/:workspaceId`, branch routes under `/api/v1/workspaces/:workspaceId/branches`. |
| Sequence | Platform admin creates workspace or user selects workspace -> load workspace detail -> load branches -> create/update/archive branch as allowed. |
| Data dependencies | `workspaceId`, `branchId`, current workspace status, active branch list. |
| Permissions | `platform_workspaces.manage`, `workspace.read`, `workspace.update`, `branches.read`, `branches.create`, `branches.update`, `branches.archive`. |
| Empty/loading | Branch list can be empty in new workspaces; render an empty branch state without calling member/relationship branch filters until branches exist. |
| Pagination | Branch list follows backend list contract where available; keep filters stable across cursor requests. |
| Optimistic/concurrency | Branch/workspace mutations should prefer server response over optimistic local mutation. Use `expectedVersion` where body schema requires it. |
| Error/forbidden states | Inactive workspace, branch archived/inactive, missing branch assignment, permission denial. |
| Role differences | Owner has broad workspace access; non-owner manager visibility can narrow to assigned branches; platform admin workspace creation is platform context. |

### Staff, Memberships, Invitations, And Branch Assignments

| Concern | Contract |
| --- | --- |
| Use cases | Staff directory, invite staff, accept invitation, revoke invitation, suspend/reactivate/end staff membership, assign staff to branches. |
| APIs required | `/api/v1/workspaces/:workspaceId/memberships*`, `/api/v1/workspaces/:workspaceId/staff/invitations`, `/api/v1/invitations/accept`, `/api/v1/workspaces/:workspaceId/invitations/:invitationId/revoke`, membership branch assignment routes. |
| Sequence | Load memberships -> load member detail when needed -> invite or lifecycle command -> refresh membership list/detail -> adjust branch assignments from member detail. |
| Data dependencies | `workspaceId`, `membershipId`, `invitationId`, `branchId`, invite token for acceptance, latest membership/access version for permission edits. |
| Permissions | `staff.read`, `staff.invite`, `staff.manage`, `staff.invites.revoke`, `staff.branches.manage`; permission edit flows use `staff.permissions.manage`. |
| Empty/loading | Staff list can be empty except current owner/member; invitations are not guaranteed to appear in list unless route supports them. |
| Pagination | Membership list can be filtered/listed; keep branch/status filters with cursor requests. |
| Optimistic/concurrency | Lifecycle and branch assignment commands should refresh member detail after success. Invitation acceptance uses idempotency. |
| Error/forbidden states | Quota/entitlement denial on invite, inactive membership, invalid/expired invitation, branch assignment loss. |
| Role differences | Owner/manager staff access differs by profile/grants. Managers can be branch-narrowed; trainers/assistants/nutritionists generally do not manage staff by default. |

### Permissions And Effective Access

| Concern | Contract |
| --- | --- |
| Use cases | Permission catalog, platform/workspace permission profiles, explicit member access, effective access inspection. |
| APIs required | `GET /api/v1/permissions`, workspace profile/access routes under `/workspaces/:workspaceId/permission-profiles` and `/memberships/:membershipId/...`, platform profile/access routes under `/platform/permission-profiles` and `/platform/memberships/:membershipId/...`, `GET /api/v1/workspaces/:workspaceId/memberships/:membershipId/effective-access`. |
| Sequence | Load permission catalog -> load profiles/member access -> edit profile or member access with latest version -> reload effective access. |
| Data dependencies | Permission keys, profile ids, membership ids, `expectedVersion` or `accessVersion`, scope resource ids. |
| Permissions | `staff.permissions.manage` in workspace context; `platform_permissions.manage` in platform context. |
| Empty/loading | A member may have no custom explicit grants; profile fallback still applies. |
| Pagination | Permission catalog is not cursor-paginated. Profile/member lists follow route response where implemented. |
| Optimistic/concurrency | Do not optimistically apply permission updates; CAS conflicts require refetch of access version/profile version. |
| Error/forbidden states | DENY precedence, invalid scope resource ids, inactive profile, inactive membership, permission unknown. |
| Role differences | Role names are not the authorization contract; profiles and explicit grants are. Support context has separate behavior. |

### Trainees And Relationships

| Concern | Contract |
| --- | --- |
| Use cases | Relationship list/detail, invite trainee, accept/reject/end/reactivate relationship, assign home branch, trainer, assistant trainer, nutritionist, migrate trainee. |
| APIs required | `GET /api/v1/workspaces/:workspaceId/relationships`, `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId`, trainee invitation/referral routes, relationship lifecycle and assignment routes, `/api/v1/workspaces/:workspaceId/trainee-migrations`. |
| Sequence | Load relationship list with filters -> open relationship detail -> perform lifecycle/assignment command with latest `expectedVersion` -> reload relationship/detail/list. |
| Data dependencies | `workspaceId`, coaching `relationshipId`, trainee invitation/referral ids, staff membership ids, branch ids, latest relationship version. |
| Permissions | `trainees.read`, `trainees.invite`, `trainees.accept`, `trainees.reject`, `trainees.end`, `trainees.reactivate`, assignment manage permissions, migration permissions. |
| Empty/loading | Empty relationship list is valid and can differ by actor scope. Loading detail should be separate from list loading. |
| Pagination | Relationship list supports cursor/limit and filters; keep filters stable across continuation. |
| Optimistic/concurrency | Relationship lifecycle and assignment commands use `expectedVersion`; refetch on conflict. |
| Error/forbidden states | Relationship not visible by scope, inactive/terminal relationship state, quota/entitlement denial, invalid staff/branch assignment, permission denial. |
| Role differences | Owner/manager can have broader visibility; trainer/assistant/nutritionist can be limited to assignments; trainee SELF maps to their own relationship. |

### Training Library And Programs

| Concern | Contract |
| --- | --- |
| Use cases | Workspace exercises, platform exercises, program templates, relationship programs, program progress. |
| APIs required | Workspace exercise routes, platform exercise routes, `/workspaces/:workspaceId/program-templates*`, `/workspaces/:workspaceId/relationships/:relationshipId/programs*`, `GET /api/v1/workspaces/:workspaceId/programs/:programId/progress`. |
| Sequence | Load exercise/template library -> create or revise template/program -> activate program for relationship -> load program progress. |
| Data dependencies | `workspaceId`, `relationshipId`, exercise ids, template ids/revisions, `programId`, latest template/program versions. |
| Permissions | `exercises.*`, `system_exercises.*`, `program_templates.*`, `programs.*`. |
| Empty/loading | Empty exercise/template/program lists are valid. Program progress only exists for a program id returned by program routes. |
| Pagination | Library/template/program lists are paginated; preserve filters/search with cursor. |
| Optimistic/concurrency | Revisions/archive/activate/complete commands use expected versions where schema requires; use server response as source after mutations. |
| Error/forbidden states | Archived exercise/template, relationship inactive, entitlement denial, lifecycle conflict, version conflict. |
| Role differences | Platform exercise flows are platform-admin context; workspace training flows depend on workspace profile/scope and relationship visibility. |

### Workout Execution And Personal Records

| Concern | Contract |
| --- | --- |
| Use cases | Start workout, view current workout, list workouts, patch workout, complete/abandon/correct workout, skip/defer program day, view PRs. |
| APIs required | Workout routes under `/workspaces/:workspaceId/relationships/:relationshipId/workouts`, progress day skip/defer routes, personal record/PR event list routes. |
| Sequence | Open relationship/program context -> start or fetch current workout -> patch workout as user edits -> complete/abandon/correct with latest version -> reload current/list/progress/PRs. |
| Data dependencies | `workspaceId`, `relationshipId`, `workoutId`, `programId`/progress id where applicable, latest workout/progress version. |
| Permissions | `workouts.create`, `workouts.read`, `workouts.update`, `workouts.complete`, `workouts.abandon`, `workouts.correct`, `workouts.day.skip`, `workouts.day.defer`, `personal_records.read`. |
| Empty/loading | No current workout is a valid state. PR list can be empty. |
| Pagination | Workout history and PR routes use cursor/limit; keep relationship and filters stable. |
| Optimistic/concurrency | Patch/complete/abandon/correct/skip/defer require version-aware handling; retry only after refetch on conflict. |
| Error/forbidden states | No active program/day, workout already completed/abandoned, relationship inactive, permission/scope denial, version conflict. |
| Role differences | Trainee SELF can execute their own workouts when allowed; staff visibility follows assigned relationship/scope. |

### Nutrition

| Concern | Contract |
| --- | --- |
| Use cases | Workspace foods, platform foods, nutrition plans for relationship, revisions and activation. |
| APIs required | Workspace food routes, platform food routes, nutrition plan routes under `/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans`. |
| Sequence | Load food library -> create/revise plan for relationship -> activate plan -> read plan list/detail for relationship. |
| Data dependencies | `workspaceId`, `relationshipId`, food ids, nutrition plan ids, latest plan/food versions. |
| Permissions | `foods.*`, `system_foods.*`, `nutrition.plans.*`. |
| Empty/loading | Food and plan lists can be empty. |
| Pagination | Food and plan lists are paginated; preserve filters with cursor. |
| Optimistic/concurrency | Update/archive/revise/activate/complete commands should send expected version where schema requires. |
| Error/forbidden states | Archived food, inactive relationship, missing responsible nutritionist/permission, entitlement denial, version/lifecycle conflict. |
| Role differences | Nutritionist can be assigned relationship-scoped; trainer/assistant defaults differ from nutritionist permissions. Trainee SELF reads depend on profile/grants. |

### Progress, Health, Notes, Photos, And Adherence

| Concern | Contract |
| --- | --- |
| Use cases | Metric definitions, measurements, progress photos metadata, health profile, notes, adherence config, daily tracking. |
| APIs required | Metric definition routes, measurement routes, progress photo list, health profile get/put, note routes, adherence config/tracking routes. |
| Sequence | Load relationship detail -> load measurement/photo/notes/adherence pages -> create/update domain records -> reload affected page/detail. |
| Data dependencies | `workspaceId`, `relationshipId`, metric definition ids, measurement ids, note ids, local date for daily tracking, latest versions where required. |
| Permissions | `metric_definitions.*`, `measurements.*`, `progress_photos.read`, `health.read/update`, `notes.*`, `adherence.*`. |
| Empty/loading | Empty histories are valid; same-day and historical records can coexist depending route/domain rules. |
| Pagination | Measurements, photos, and notes are paginated; some use date/id cursor patterns. |
| Optimistic/concurrency | Notes/definitions/measurements/adherence writes should rely on server result; version conflicts require refetch. |
| Error/forbidden states | Sensitive support gate failure, relationship scope denial, invalid local date/range, archived metric, version conflict. |
| Role differences | Health/progress/photo reads can be support-sensitive. Trainee SELF, trainer assignment, and nutritionist assignment produce different visible relationship sets. |

### Check-ins

| Concern | Contract |
| --- | --- |
| Use cases | Check-in templates, assignments, instance list/detail, trainee submit, staff review. |
| APIs required | `/workspaces/:workspaceId/check-in-templates*`, `/relationships/:relationshipId/check-in-assignments*`, `/relationships/:relationshipId/check-ins*`. |
| Sequence | Staff loads/creates template -> assign template to relationship -> trainee/staff loads check-in instances -> trainee submits -> staff reviews -> reload instance/list. |
| Data dependencies | `workspaceId`, `relationshipId`, template id/revision, assignment id, check-in id, latest expected versions. |
| Permissions | `checkins.templates.*`, `checkins.assignments.*`, `checkins.assign`, `checkins.read`, `checkins.submit`, `checkins.review`. |
| Empty/loading | No assigned check-ins or no due instances are valid states. |
| Pagination | Template, assignment, and instance lists use cursor/limit. |
| Optimistic/concurrency | Submit/review/end/archive/revise flows require latest version; refetch on conflict. |
| Error/forbidden states | Not due/already submitted/reviewed/skipped, sensitive support gate, inactive relationship, version conflict. |
| Role differences | Trainee SELF submits own check-ins; staff reviews according to relationship visibility and permissions. |

### Files And Documents

| Concern | Contract |
| --- | --- |
| Use cases | Upload file, confirm upload, download file, delete/restore file, list/create/get/delete relationship documents. |
| APIs required | `/workspaces/:workspaceId/files/upload-intents`, upload confirm route, file download/delete/restore routes, document routes under `/relationships/:relationshipId/documents`. |
| Sequence | Request upload intent -> upload object to returned storage URL outside API -> confirm upload -> create/read document metadata -> request download URL -> delete/restore with expected version when required. |
| Data dependencies | `workspaceId`, `relationshipId`, `fileId`, `documentId`, storage upload result, checksum/SHA-256 confirmation data, expected version where required. |
| Permissions | `documents.upload`, `documents.*`, `files.download/delete/restore`, `medical_documents.*` where medical document routes apply. |
| Empty/loading | Empty document list is valid. Pending upload intent should not be shown as verified document unless confirmation succeeds. |
| Pagination | Document list is paginated; file lifecycle detail is not a cursor flow. |
| Optimistic/concurrency | Do not show upload as final until confirm succeeds. Delete/restore use expected version when schema requires. |
| Error/forbidden states | Upload quota exceeded, checksum mismatch, object missing/HEAD verification failure, sensitive file support denial, version conflict. |
| Role differences | Medical/sensitive document access requires narrower permissions; support file access needs `support.sensitive_files.read` for sensitive file download. |

### Notifications

| Concern | Contract |
| --- | --- |
| Use cases | Notification center, unread count/filter, mark read, mark all read, preferences, push-device registration. |
| APIs required | `GET /api/v1/me/notifications`, `POST /api/v1/me/notifications/:notificationId/read`, `POST /api/v1/me/notifications/read-all`, preference routes, push-device routes. |
| Sequence | Load notifications -> optionally filter unread -> mark one/all read -> reload list/count -> update preferences or register/delete push device. |
| Data dependencies | `notificationId`, preference version, push-device id/token. |
| Permissions | Bearer user context; notifications are current-user scoped. |
| Empty/loading | Empty notification list and zero unread are valid. |
| Pagination | Notification list uses cursor/limit and unread filter. |
| Optimistic/concurrency | Mark read can optimistically update unread UI only after successful response or with rollback. Preferences use `expectedVersion`. |
| Error/forbidden states | Notification not owned by user, device token invalid, preference version conflict. |
| Role differences | Notification contents vary by actor and backend events, but API is current-user scoped. |

### Subscriptions, Payments, Plans, And Usage

| Concern | Contract |
| --- | --- |
| Use cases | Workspace billing summary, usage/quota, manual payment creation, platform plan/version administration, subscription lifecycle, payment approval/rejection. |
| APIs required | Workspace billing routes under `/workspaces/:workspaceId/billing`, platform plan routes, platform subscription routes under `/platform/workspaces/:workspaceId/subscription`, platform payments routes. |
| Sequence | Workspace user loads subscription/usage/payments -> creates manual payment if permitted -> platform admin manages plans/subscriptions/payments -> workspace flows reload billing/usage after lifecycle change. |
| Data dependencies | `workspaceId`, plan id/version id, subscription version, payment id/version, quota/usage DTOs. |
| Permissions | `billing.subscription.read`, `billing.usage.read`, `billing.payments.read/create`, `plans.*`, `subscriptions.*`, `payments.*`. |
| Empty/loading | Payment history can be empty. Usage quotas can be absent/feature-denied depending subscription. |
| Pagination | Payment and plan lists follow backend list responses where implemented. |
| Optimistic/concurrency | Subscription/payment commands are idempotent where wrapped and versioned where schemas require; refetch billing after success. |
| Error/forbidden states | Feature unavailable, quota exceeded, frozen/canceled subscription, invalid plan version, payment lifecycle conflict, version conflict. |
| Role differences | Workspace billing reads are workspace context; platform plan/subscription/payment administration is platform context. |

### Leads And Owner Activation

| Concern | Contract |
| --- | --- |
| Use cases | Public lead capture, platform lead queue, lead detail/update/status, duplicate/merge, conversion, owner activation completion. |
| APIs required | `POST /api/v1/leads`, platform lead routes, `POST /api/v1/owner-activations/complete`. |
| Sequence | Public lead form submits -> platform user lists/reviews lead -> update/status/duplicate/merge as needed -> convert lead -> owner completes activation via token route. |
| Data dependencies | `leadId`, lead expected version, duplicate/merge target ids, owner activation token/body, resulting workspace/user/session data. |
| Permissions | Public lead create; platform lead operations use `leads.read/update/convert/mark_duplicate/merge`. |
| Empty/loading | Empty platform lead queue is valid. |
| Pagination | Platform lead list uses cursor/filters. |
| Optimistic/concurrency | Update/status/convert/duplicate/merge require latest expected version and idempotency where wrapped. |
| Error/forbidden states | Duplicate/merged/converted lifecycle conflicts, activation token invalid/expired, version conflict. |
| Role differences | Public lead submitter is unauthenticated; platform lead management requires platform membership/profile. |

### Support Access

| Concern | Contract |
| --- | --- |
| Use cases | Support policies, start support session, inspect effective actor/session, end/revoke session, use support context on workspace reads. |
| APIs required | `/api/v1/platform/support/policies*`, `/api/v1/platform/support/access-requests`, `/api/v1/platform/support/sessions/:sessionId*`, downstream workspace routes with `x-support-session-id`. |
| Sequence | Platform support user loads policy/session data -> starts access request -> receives session -> calls permitted workspace reads with `x-support-session-id` -> ends/revokes session -> stop sending support header. |
| Data dependencies | Policy id/version, session id/version, target workspace id, optional effective membership/user context. |
| Permissions | `support.policies.*`, `support.sessions.*`, `support.sensitive.read`, `support.sensitive_files.read`; downstream workspace permission depends on support mode. |
| Empty/loading | No active session is a valid state; workspace-support mode may show fewer features than user-context mode. |
| Pagination | Policy/session list behavior follows support routes where implemented. |
| Optimistic/concurrency | Policy/session lifecycle commands use expected version where required. |
| Error/forbidden states | Expired/revoked session, workspace mismatch, write forbidden in `WORKSPACE_SUPPORT`, missing sensitive support permission, effective membership required. |
| Role differences | Platform support actor differs from tenant effective actor. `USER_CONTEXT` uses effective tenant membership; `WORKSPACE_SUPPORT` is read-only whitelist. |

### Exports, Retention, And Deletion

| Concern | Contract |
| --- | --- |
| Use cases | Request workspace export, list export jobs, get export status, get export download URL, manage platform workspace deletion lifecycle. |
| APIs required | `/api/v1/workspaces/:workspaceId/exports*`, `/api/v1/platform/workspace-deletions*`. |
| Sequence | Request export -> poll/list export jobs -> get detail -> request download URL when ready. Platform deletion users list/detail deletion requests -> approve/postpone/cancel with expected version. |
| Data dependencies | `workspaceId`, export id, deletion request id/version, retention/deletion status. |
| Permissions | `exports.workspace.*`, platform `deletion.*`. |
| Empty/loading | Empty export history/deletion queue is valid. Pending export should remain in progress until status changes. |
| Pagination | Export and deletion lists are paginated where routes expose cursor/limit. |
| Optimistic/concurrency | Export request is asynchronous; do not assume completion after create. Deletion commands use expected version and lifecycle checks. |
| Error/forbidden states | Support context forbidden, retention lifecycle conflict, deletion status conflict, download unavailable until export ready. |
| Role differences | Workspace export is workspace context; deletion administration is platform context. |

### Dashboards And Analytics

| Concern | Contract |
| --- | --- |
| Use cases | Trainer dashboard, gym dashboard, relationship dashboard, relationship training/progress/nutrition/adherence analytics. |
| APIs required | Dashboard routes under `/workspaces/:workspaceId/dashboard/*`, `/workspaces/:workspaceId/relationships/:relationshipId/dashboard`, relationship analytics routes. |
| Sequence | Resolve workspace/relationship context -> call dashboard endpoint with range/filter/cursor params -> render sections independently -> request next category/page cursor using same filters. |
| Data dependencies | `workspaceId`, optional `branchId`, `relationshipId`, date range, category cursors, workspace-local range semantics. |
| Permissions | `dashboard.trainer.read`, `dashboard.gym.read`, `dashboard.relationship.read`, `analytics.training.read`, `analytics.progress.read`, `analytics.nutrition.read`, `analytics.adherence.read`. |
| Empty/loading | Empty dashboard sections are valid. Render per-section loading if requesting category cursors independently. |
| Pagination | Some categories expose independent/category-bound cursors; do not reuse cursor across category or filter changes. |
| Optimistic/concurrency | Dashboards are read-only snapshots; refresh after mutations in training/workouts/nutrition/progress/check-ins that affect summaries. |
| Error/forbidden states | Branch/relationship scope denial, support-sensitive denial, inactive workspace, invalid range/cursor. |
| Role differences | Owner may see broader gym scope; manager can be branch-narrowed; trainer dashboard can be assigned-relationship scoped; trainee uses relationship dashboard when SELF applies. |

### Audit

| Concern | Contract |
| --- | --- |
| Use cases | Workspace audit log, platform audit log, sensitive audit inspection where allowed. |
| APIs required | `GET /api/v1/workspaces/:workspaceId/audit`, `GET /api/v1/platform/audit`. |
| Sequence | Select context -> call audit list with filters/cursor -> fetch next page with same filters. |
| Data dependencies | `workspaceId` for workspace audit, audit filters, cursor, sensitive audit permission for redacted fields. |
| Permissions | `audit.workspace.read`, `audit.platform.read`, `audit.sensitive.read` for sensitive metadata. |
| Empty/loading | Empty audit result is valid. |
| Pagination | Audit uses cursor/limit; cursor must remain bound to filters. |
| Optimistic/concurrency | Read-only; audit can lag only where source event is async. |
| Error/forbidden states | Permission denial, sensitive metadata redaction, invalid cursor/filter. |
| Role differences | Platform audit is platform context; workspace audit is tenant context. |

## Feature Dependencies

| Feature | Must load first | Common downstream refresh after mutation |
| --- | --- | --- |
| Workspace shell | Auth, `/me`, `/me/workspaces` | `/me/workspaces`, workspace detail. |
| Staff | Workspace detail, branches, memberships | Membership list/detail, effective access if visible. |
| Permissions | Permission catalog, member/profile detail | Effective access, member detail. |
| Relationships | Workspace, branches, staff assignments | Relationship detail/list. |
| Training | Relationship, exercises/templates | Program detail/progress, workout current. |
| Workouts | Relationship, active program/progress | Current workout, workout list, program progress, PRs. |
| Nutrition | Relationship, foods | Nutrition plan list/detail, adherence dashboard. |
| Progress | Relationship, metric definitions | Measurement/note/photo/adherence pages, analytics. |
| Check-ins | Templates, relationship assignments | Check-in instance list/detail, notifications. |
| Files | Relationship, upload intent | Document list/detail, file metadata. |
| Billing | Workspace subscription/usage | Billing summary, entitlement-sensitive feature availability. |
| Support | Platform support session | Session detail and downstream workspace read. |
| Exports/deletion | Workspace/platform context | Export/deletion status. |
| Dashboards/analytics | Workspace/relationship, date range | Dashboard/analytics refresh after domain mutations. |

## Locked-Stage Protection

- No Stage 2-18 implementation was modified.
- No routes, schemas, permissions, services, migrations, tests, OpenAPI artifacts,
  configuration, generated artifacts, or runtime behavior were changed.
- This document maps existing API behavior only. Missing UX decisions or
  implementation gaps must be documented in later issues rather than fixed here.
