# V1 Permission and Access Matrix

Issue: V1-DOC-05 / GitHub #5

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Backend root inspected: `apps/backend`

## Source Of Truth

This matrix is grounded in the locked Stage 18 backend implementation. The
permission registry, access-control service, permission service, route guards,
services, repositories, tests, and migrations are authoritative over previous
planning summaries, generated artifacts, and this document's own examples.

If a later document disagrees with implementation, the implementation wins. If an
implementation detail appears surprising, document it and do not silently
normalize it during V1 documentation work.

This document is the V1 source for permission and access behavior. It is not the
frontend API guide, error catalog, or full business-flow guide.

## Evidence Checked

- `src/modules/permissions/permission.registry.ts`
- `src/modules/permissions/permission.types.ts`
- `src/modules/permissions/permission.service.ts`
- `src/modules/permissions/permission.routes.ts`
- `src/core/access-control/access-control.service.ts`
- `src/core/access-control/access-control.types.ts`
- `src/core/access-control/access-control.middleware.ts`
- `src/modules/support-access/support-access.service.ts`
- route and service permission usage under `src/modules/**`
- existing V1 docs in `docs/v1/`

## Actors And Terms

| Term | Implementation meaning |
| --- | --- |
| Platform Admin | A platform membership with a platform permission profile or explicit platform grants. The default `Platform Super Admin` profile allows every registered platform-context permission. |
| Owner | Workspace membership role/profile `GYM_OWNER`. The default owner profile allows broad workspace operations but does not allow every registered workspace permission. |
| Manager | Workspace membership role/profile `GYM_MANAGER`. Query access narrows manager workspace-wide access to active branch assignments unless the manager is also owner. |
| Trainer | Workspace membership role/profile `TRAINER`. Query access can expand to assigned trainees. |
| Assistant Trainer | Workspace membership role/profile `ASSISTANT_TRAINER`. Query access can expand to assigned trainees, with a narrower default profile than trainer. |
| Nutritionist | Workspace membership role/profile `NUTRITIONIST`. Query access can expand to assigned trainees for nutrition/adherence domains. |
| Trainee | Workspace membership role/profile `TRAINEE`. Query access can expand to `SELF`. |
| Workspace Support | Support session context without an effective tenant membership. It is read-only and only whitelists read/download/billing-read permissions. |
| USER_CONTEXT | Support session context with an effective tenant membership. Authorization evaluates the effective membership's profiles/grants and also applies support-sensitive gates. |
| Permission profile | Stored permission baseline assigned to a platform or workspace membership. Only active, context-matching profiles contribute. |
| Explicit grant | Stored `ALLOW` or `DENY` override for a platform/workspace membership, permission, scope, and optional expiration. |
| Relationship id | The coaching relationship id. `relationshipId != trainee userId`. Relationship-scoped access must use the relationship id. |

## Registered Scopes

The implementation registers these permission scope types:

| Scope | Resource ids | Implementation behavior |
| --- | --- | --- |
| `WORKSPACE` | none | Broad baseline scope. Platform permissions also use this scope value in platform context. |
| `BRANCH` | required branch ids | Branch ids must be active and in the workspace. Route-level structural scope can require the actor's active branch assignment unless `requiresAssignment` is explicitly false. |
| `MULTIPLE_BRANCHES` | required branch ids | Same resource validation as `BRANCH`. Query access treats it as branch atoms with lower specificity than `BRANCH`. |
| `SPECIFIC_TRAINEES` | required coaching relationship ids | Relationship ids must exist in the workspace where the relationship repository is wired. These ids are relationship ids, not trainee user ids. |
| `ASSIGNED_TRAINEES` | none | Grants assigned-trainee query visibility. Query access also expands this for `TRAINER`, `ASSISTANT_TRAINER`, and `NUTRITIONIST` roles when a workspace baseline allows the permission. |
| `SELF` | none | Grants own-trainee query visibility. Query access also expands this for `TRAINEE` role when a workspace baseline allows the permission. |

## Decision Rules

### Profile Fallback And Explicit Grants

The backend does not authorize directly from role names. Roles usually assign
system default profiles, and those active profiles supply the profile baseline.
Custom active profiles can supply additional profile entries. Explicit grants are
stored separately and can override profile baseline when their permission, context,
expiration, and scope apply.

Fallback behavior is:

1. No matching active profile entry and no applicable active explicit grant means
   default deny.
2. A profile `ALLOW` can authorize when there is no stronger applicable explicit
   grant and no profile `DENY`.
3. A profile `DENY` denies before profile `ALLOW`.
4. An applicable explicit grant overrides profile baseline at the strongest
   matching scope specificity.
5. At the same strongest explicit-grant specificity, `DENY` wins over `ALLOW`.
6. Expired grants are ignored.

### Command Authorization

`AccessControlService.authorize` is used by route guards and service-level
authorization:

1. The request must have `ctx.userId` and `ctx.authSessionId`.
2. Unknown permission keys fail with `PERMISSION_UNKNOWN`.
3. Platform context requires active platform membership.
4. Workspace context requires an active workspace and active workspace membership,
   except support context has special handling.
5. Only active, context-matching permission profiles contribute a profile
   baseline.
6. Profile `DENY` beats profile `ALLOW`.
7. Active explicit grants that match the permission and requested scope can
   override profile baseline.
8. The most specific applicable explicit grant wins using this order:
   `SELF` > `SPECIFIC_TRAINEES` > `BRANCH` > `MULTIPLE_BRANCHES` >
   `ASSIGNED_TRAINEES` > `WORKSPACE`.
9. If multiple strongest grants tie, `DENY` wins.
10. No profile and no applicable grant means default deny.

### Query Access

`resolveWorkspaceQueryAccess` is used by list/dashboard/analytics style reads that
need a visibility envelope:

1. The workspace must exist and be `ACTIVE`.
2. The effective membership must be `ACTIVE`.
3. Requested branch ids must reference active branches.
4. Requested relationship ids must reference relationships in the workspace where
   relationship lookup is available.
5. Empty resource lists for branch, multi-branch, or specific-trainee grants are
   rejected.
6. Branch and relationship resource lists are bounded by request limits
   (`maxBranches` default 100, `maxSpecificTrainees` default 500).
7. Profile baseline can provide workspace-level allowance.
8. Explicit workspace `DENY` blocks workspace-wide allowance.
9. Branch and relationship grants are reduced to per-id atoms; higher specificity
   wins and same-specificity `DENY` wins for each atom.
10. Managers who are not owners are narrowed to active branch assignments when
    they would otherwise be workspace-wide.
11. Trainer, assistant trainer, and nutritionist query access is not pure
    workspace-wide unless the member is also owner or manager.
12. Allowed query output can include workspace-wide, assigned-trainee, self,
    branch include/exclude, and relationship include/exclude visibility.

Branch atom behavior:

- `BRANCH` and `MULTIPLE_BRANCHES` grants are decomposed into branch ids.
- For each branch id, the highest-specificity grant wins.
- If specificity ties for a branch id, `DENY` wins.
- Manager query access intersects branch allows with active branch assignments.

Relationship atom behavior:

- `SPECIFIC_TRAINEES` grants are decomposed into coaching relationship ids.
- For each relationship id, the highest-specificity grant wins.
- If specificity ties for a relationship id, `DENY` wins.
- `relationshipId != trainee userId`; frontend and QA fixtures must use the
  coaching relationship id when exercising relationship-scoped permissions.

SELF behavior:

- `SELF` does not mean "any resource owned by this user".
- In relationship modules it means the trainee's own coaching relationship after
  the service/access query has mapped the authenticated user to the relationship's
  `traineeUserId`.

## Support Access Rules

Support context is resolved from `x-support-session-id` before route-level access:

| Context | Authorization behavior |
| --- | --- |
| `WORKSPACE_SUPPORT` | Requires the support session workspace to match the requested workspace. Only read/download and billing-read permissions are whitelisted. Mutations fail with `SUPPORT_WRITE_NOT_WHITELISTED`. |
| `USER_CONTEXT` | Requires an effective active workspace membership. Normal workspace authorization is evaluated for that effective membership. |

Support-sensitive platform permissions are separate gates:

| Workspace permission being accessed in support context | Required platform permission |
| --- | --- |
| `medical_documents.download` | `support.sensitive_files.read` |
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

Exports and retention/deletion service operations explicitly forbid support
context. Other modules can add service-level support restrictions beyond the
route guard.

## Restricted And Inactive Access

- `requireAuth` denies restricted sessions unless the route opts into
  `allowRestricted`.
- Workspace authorization denies inactive workspaces with `WORKSPACE_INACTIVE`.
- Workspace authorization denies inactive/missing workspace membership with
  `WORKSPACE_MEMBERSHIP_REQUIRED`.
- Support `USER_CONTEXT` requires an active effective membership; otherwise
  `SUPPORT_EFFECTIVE_MEMBERSHIP_REQUIRED`.
- Entitlement, subscription, quota, and deletion/retention checks are business
  gates layered after permission authorization in the owning services. A permission
  allow does not guarantee the command can mutate state.

## Default Profile Matrix

Legend:

- `Platform Super Admin` means the system profile permits all registered
  platform-context permissions.
- `Owner`, `Manager`, `Trainer`, `Assistant`, `Nutritionist`, and `Trainee` mean
  the registered workspace system profile includes the permission.
- Empty actor cells mean no default system profile grants the permission. Custom
  profiles or explicit grants can still authorize if valid for the context/scope.
- Support behavior is governed by the support rules above, not by a normal
  workspace profile.

### Platform Permissions

All platform permissions have allowed context `PLATFORM` and allowed scope
`WORKSPACE`, except `audit.sensitive.read`, which is also allowed in workspace
context and all workspace scopes.

| Permission | Default profile actors | Notes |
| --- | --- | --- |
| `platform_users.read` | Platform Super Admin | Platform membership read. |
| `platform_users.manage` | Platform Super Admin | Platform membership lifecycle. |
| `platform_permissions.manage` | Platform Super Admin | Platform permission profiles and grants. |
| `platform_workspaces.manage` | Platform Super Admin | Platform workspace administration. |
| `plans.read` | Platform Super Admin, Subscription Admin | Subscription plan read. |
| `plans.create` | Platform Super Admin, Subscription Admin | Plan create. |
| `plans.update` | Platform Super Admin, Subscription Admin | Plan update. |
| `plans.archive` | Platform Super Admin, Subscription Admin | Plan archive. |
| `plans.versions.create` | Platform Super Admin, Subscription Admin | Plan version create. |
| `subscriptions.read` | Platform Super Admin, Subscription Admin | Workspace subscription read. |
| `subscriptions.start_trial` | Platform Super Admin, Subscription Admin | Start trial. |
| `subscriptions.change_plan` | Platform Super Admin, Subscription Admin | Change plan. |
| `subscriptions.change_terms` | Platform Super Admin, Subscription Admin | Change terms. |
| `subscriptions.freeze` | Platform Super Admin, Subscription Admin | Freeze subscription. |
| `subscriptions.reactivate` | Platform Super Admin, Subscription Admin | Reactivate subscription. |
| `subscriptions.cancel` | Platform Super Admin, Subscription Admin | Cancel subscription. |
| `payments.read` | Platform Super Admin, Subscription Admin | Manual payment read. |
| `payments.approve` | Platform Super Admin, Subscription Admin | Manual payment approve. |
| `payments.reject` | Platform Super Admin, Subscription Admin | Manual payment reject. |
| `leads.read` | Platform Super Admin, Sales/Lead Admin | Lead read. |
| `leads.update` | Platform Super Admin, Sales/Lead Admin | Lead update. |
| `leads.convert` | Platform Super Admin, Sales/Lead Admin | Lead conversion. |
| `leads.mark_duplicate` | Platform Super Admin, Sales/Lead Admin | Duplicate marking. |
| `leads.merge` | Platform Super Admin, Sales/Lead Admin | Lead merge. |
| `support.policies.read` | Platform Super Admin | Support policy read. |
| `support.policies.create` | Platform Super Admin | Support policy create. |
| `support.policies.update` | Platform Super Admin | Support policy update. |
| `support.policies.disable` | Platform Super Admin | Support policy disable. |
| `support.policies.archive` | Platform Super Admin | Support policy archive. |
| `support.sessions.read` | Platform Super Admin | Support session read. |
| `support.sessions.start` | Platform Super Admin | Support session start. |
| `support.sessions.end_own` | Platform Super Admin | End own support session. |
| `support.sessions.revoke` | Platform Super Admin | Revoke support session. |
| `support.sensitive.read` | Platform Super Admin | Additional gate for sensitive reads through support context. |
| `support.sensitive_files.read` | Platform Super Admin | Additional gate for sensitive file download through support context. |
| `audit.platform.read` | Platform Super Admin | Platform audit query. |
| `audit.sensitive.read` | Platform Super Admin | Sensitive audit metadata gate; registered for platform and workspace contexts. |
| `system_exercises.read` | Platform Super Admin | System exercise read. |
| `system_exercises.create` | Platform Super Admin | System exercise create. |
| `system_exercises.update` | Platform Super Admin | System exercise update. |
| `system_exercises.archive` | Platform Super Admin | System exercise archive. |
| `system_foods.read` | Platform Super Admin | System food read. |
| `system_foods.create` | Platform Super Admin | System food create. |
| `system_foods.update` | Platform Super Admin | System food update. |
| `system_foods.archive` | Platform Super Admin | System food archive. |
| `deletion.read` | Platform Super Admin | Workspace deletion request read. |
| `deletion.approve` | Platform Super Admin | Workspace deletion approve. |
| `deletion.postpone` | Platform Super Admin | Workspace deletion postpone. |
| `deletion.cancel` | Platform Super Admin | Workspace deletion cancel. |

### Workspace Administration And Billing

All workspace permissions in this section have allowed context `WORKSPACE` and
allowed scopes `SELF`, `ASSIGNED_TRAINEES`, `SPECIFIC_TRAINEES`, `BRANCH`,
`MULTIPLE_BRANCHES`, and `WORKSPACE` unless a route/service requests a narrower
scope.

| Permission | Default profile actors | Access notes |
| --- | --- | --- |
| `workspace.read` | Owner | Workspace detail read. |
| `workspace.manage` | Owner | Workspace management. |
| `workspace.update` | Owner | Workspace update. |
| `billing.subscription.read` | Owner | Support workspace read-only whitelisted. |
| `billing.usage.read` | Owner | Support workspace read-only whitelisted. |
| `billing.payments.read` | Owner | Support workspace read-only whitelisted. |
| `billing.payments.create` | Owner | Permission allow still requires billing/payment service validation. |
| `branches.read` | Owner | Branch reads can be branch scoped. |
| `branches.manage` | Owner | Branch management umbrella permission. |
| `branches.create` | Owner | Branch create. |
| `branches.update` | Owner | Branch update; branch resource must be active when scoped. |
| `branches.archive` | Owner | Branch archive. |
| `staff.read` | Owner | Staff/member reads. |
| `staff.manage` | Owner | Staff lifecycle management. |
| `staff.invite` | Owner | Staff invite; service quota/entitlement applies. |
| `staff.invites.revoke` | Owner | Staff invitation revoke. |
| `staff.branches.manage` | Owner | Staff branch assignment management. |
| `staff.permissions.manage` | Owner | Workspace permission profiles, grants, and effective access inspection. |
| `audit.workspace.read` | Owner | Workspace audit query. |
| `exports.workspace.create` | Owner | Export create; support context forbidden in export service. |
| `exports.workspace.read` | Owner | Export read; support context forbidden in export service. |
| `exports.workspace.download` | Owner | Export download-url; support context forbidden in export service. |

### Trainees And Relationships

| Permission | Default profile actors | Access notes |
| --- | --- | --- |
| `trainees.read` | Owner, Manager, Trainer, Assistant, Nutritionist, Trainee | Query access can be workspace, branch, assigned, specific relationship, or self. |
| `trainees.update` | Owner, Manager, Trainer | Relationship metadata update. |
| `trainees.invite` | Owner, Manager, Trainer | Invite trainee; quota and relationship eligibility apply. |
| `trainees.accept` | Owner, Manager, Trainer | Accept pending request. |
| `trainees.reject` | Owner, Manager, Trainer | Reject pending request. |
| `trainees.end` | Owner, Manager, Trainer | End relationship. |
| `trainees.reactivate` | Owner, Manager, Trainer | Reactivate ended relationship. |
| `trainees.assignments.primary.manage` | Owner, Manager, Trainer | Primary trainer assignment; service validates staff/branch/relationship eligibility. |
| `trainees.assignments.assistant.manage` | Owner, Manager, Trainer | Assistant trainer assignment. |
| `trainees.assignments.nutritionist.manage` | Owner, Manager, Trainer | Nutritionist assignment. |
| `trainees.migrate_out` | Owner, Trainer | Outbound trainee migration. |
| `trainees.migrate_in` | Owner, Manager | Inbound trainee migration. |

### Training And Workouts

| Permission | Default profile actors | Access notes |
| --- | --- | --- |
| `exercises.read` | Owner, Trainer | Exercise library read. |
| `exercises.create` | Owner, Trainer | Exercise create. |
| `exercises.update` | Owner, Trainer | Exercise update. |
| `exercises.archive` | Owner, Trainer | Exercise archive. |
| `programs.read` | Owner, Manager, Trainer, Assistant, Trainee | Relationship-scoped program read. |
| `programs.create` | Owner, Trainer | Program create. |
| `programs.update` | Owner, Manager, Trainer | Program update. |
| `programs.activate` | Owner, Trainer | Program activate. |
| `programs.complete` | Owner, Trainer | Program complete. |
| `programs.archive` | Owner, Trainer | Program archive. |
| `program_templates.read` | Owner, Trainer | Program template read. |
| `program_templates.create` | Owner, Trainer | Program template create. |
| `program_templates.update` | Owner, Trainer | Program template update. |
| `program_templates.archive` | Owner, Trainer | Program template archive. |
| `workouts.read` | Owner, Manager, Trainer, Assistant, Trainee | Relationship-scoped workout read. |
| `workouts.create` | Owner, Trainer, Assistant, Trainee | Start workout session. |
| `workouts.update` | Owner, Trainer, Trainee | Update workout actuals. |
| `workouts.complete` | Owner, Trainer, Trainee | Complete workout. |
| `workouts.abandon` | Owner, Trainer, Trainee | Abandon workout. |
| `workouts.correct` | Owner, Trainer | Correct completed workout. |
| `workouts.day.skip` | Owner, Trainer, Trainee | Skip training day. |
| `workouts.day.defer` | Owner, Trainer, Trainee | Defer training day. |
| `personal_records.read` | Owner, Manager, Trainer, Trainee | Personal record read. |

### Nutrition

| Permission | Default profile actors | Access notes |
| --- | --- | --- |
| `foods.read` | Owner, Manager, Trainer, Nutritionist | Food library read. |
| `foods.create` | Owner, Nutritionist | Food create. |
| `foods.update` | Owner, Nutritionist | Food update. |
| `foods.archive` | Owner, Nutritionist | Food archive. |
| `nutrition.plans.read` | Owner, Manager, Trainer, Nutritionist, Trainee | Relationship-scoped nutrition plan read. |
| `nutrition.plans.create` | Owner, Nutritionist | Nutrition plan create. |
| `nutrition.plans.update` | Owner, Manager, Trainer, Nutritionist | Nutrition plan update. |
| `nutrition.plans.activate` | Owner, Nutritionist | Nutrition plan activate. |
| `nutrition.plans.complete` | Owner, Nutritionist | Nutrition plan complete. |
| `nutrition.plans.archive` | Owner, Nutritionist | Nutrition plan archive. |
| `health.food_allergies.read` | Nutritionist | Limited health/allergy read for nutrition service. |

### Progress, Health, Notes, And Adherence

| Permission | Default profile actors | Access notes |
| --- | --- | --- |
| `metric_definitions.read` | Owner, Manager | Metric definition read. |
| `metric_definitions.create` | Owner | Metric definition create. |
| `metric_definitions.update` | Owner | Metric definition update. |
| `metric_definitions.archive` | Owner | Metric definition archive. |
| `measurements.read` | Owner, Manager, Trainer, Assistant, Trainee | Relationship-scoped measurement read. |
| `measurements.create` | Trainer, Trainee | Measurement create. |
| `measurements.update` | Trainee | Measurement correction/update. |
| `progress_photos.read` | Trainer, Assistant, Trainee | Support-sensitive when read through support context. |
| `progress_photos.create` |  | Registered permission; no default system profile grants it. |
| `progress_photos.update_visibility` |  | Registered permission; no default system profile grants it. |
| `progress_photos.delete` |  | Registered permission; no default system profile grants it. |
| `health.read` | Trainer, Trainee | Support-sensitive when read through support context. |
| `health.update` | Trainee | Health profile update. |
| `notes.read` | Trainer, Trainee | Coaching note read with visibility rules in service. |
| `notes.create` | Trainer | Note create. |
| `notes.update` | Trainer | Note update. |
| `notes.archive` | Trainer | Note archive. |
| `adherence.read` | Owner, Manager, Trainer, Assistant, Nutritionist, Trainee | Adherence read. |
| `adherence.configure` | Owner, Manager, Trainer | Adherence configuration. |
| `adherence.update` | Trainer, Trainee | Daily adherence update. |
| `adherence.correct` | Trainer | Historical adherence correction. |

### Check-ins

| Permission | Default profile actors | Access notes |
| --- | --- | --- |
| `checkins.templates.read` | Owner, Manager, Trainer | Template read. |
| `checkins.templates.create` | Owner, Trainer | Template create. |
| `checkins.templates.update` | Owner, Trainer | Immutable template revision creation. |
| `checkins.templates.archive` | Owner, Trainer | Template archive. |
| `checkins.assignments.read` | Owner, Manager, Trainer, Assistant, Trainee | Assignment read. |
| `checkins.assign` | Owner, Trainer | Assign check-ins. |
| `checkins.assignments.update` | Owner, Trainer | Assignment schedule update. |
| `checkins.assignments.end` | Owner, Trainer | Assignment end. |
| `checkins.read` | Owner, Manager, Trainer, Assistant, Trainee | Sensitive check-in instance/response read; support-sensitive. |
| `checkins.submit` | Trainee | Submit own check-in. |
| `checkins.review` | Trainer | Review submitted check-in. |

### Files And Documents

| Permission | Default profile actors | Access notes |
| --- | --- | --- |
| `documents.read` | Owner, Manager, Trainer, Assistant, Trainee | Document metadata read. |
| `documents.upload` | Owner, Manager, Trainer, Assistant, Trainee | Document upload intent/metadata flow; quota and file service checks apply. |
| `documents.delete` | Owner, Manager, Trainer, Trainee | Document delete. |
| `files.download` | Owner, Manager, Trainer, Assistant, Trainee | Support workspace read-only whitelisted. Sensitive file download has extra support gate. |
| `files.delete` | Owner, Manager, Trainer, Trainee | File delete. |
| `files.restore` | Owner, Manager, Trainer, Trainee | File restore. |
| `medical_documents.read` |  | Registered permission; no default system profile grants it. Support-sensitive. |
| `medical_documents.upload` |  | Registered permission; no default system profile grants it. |
| `medical_documents.download` |  | Registered permission; no default system profile grants it. Requires `support.sensitive_files.read` in support context. |

### Dashboards And Analytics

Analytics permissions have narrower registered scope sets than normal workspace
permissions:

- `dashboard.gym.read`: `WORKSPACE`, `BRANCH`, `MULTIPLE_BRANCHES`
- `dashboard.trainer.read`: `WORKSPACE`, `ASSIGNED_TRAINEES`,
  `SPECIFIC_TRAINEES`, `BRANCH`
- relationship dashboards and relationship analytics: `WORKSPACE`, `SELF`,
  `ASSIGNED_TRAINEES`, `SPECIFIC_TRAINEES`, `BRANCH`

| Permission | Default profile actors | Access notes |
| --- | --- | --- |
| `dashboard.trainer.read` | Owner, Trainer | Support-sensitive. |
| `dashboard.gym.read` | Owner, Manager | Support-sensitive. |
| `dashboard.relationship.read` | Owner, Manager, Trainer, Assistant, Nutritionist, Trainee | Support-sensitive. |
| `analytics.training.read` | Owner, Manager, Trainer, Assistant, Trainee | Relationship analytics. |
| `analytics.progress.read` | Owner, Manager, Trainer, Assistant, Trainee | Support-sensitive in support context. |
| `analytics.nutrition.read` | Owner, Manager, Trainer, Nutritionist, Trainee | Support-sensitive in support context. |
| `analytics.adherence.read` | Owner, Manager, Trainer, Assistant, Nutritionist, Trainee | Support-sensitive in support context. |

## Management API Surface

Permission definitions are readable by any authenticated user:

- `GET /api/v1/permissions`

Workspace permission management requires `staff.permissions.manage`:

- `GET /api/v1/workspaces/:workspaceId/permission-profiles`
- `POST /api/v1/workspaces/:workspaceId/permission-profiles`
- `PATCH /api/v1/workspaces/:workspaceId/permission-profiles/:profileId`
- `POST /api/v1/workspaces/:workspaceId/permission-profiles/:profileId/archive`
- `PUT /api/v1/workspaces/:workspaceId/memberships/:membershipId/permission-profiles`
- `GET /api/v1/workspaces/:workspaceId/memberships/:membershipId/access`
- `PUT /api/v1/workspaces/:workspaceId/memberships/:membershipId/access`
- `GET /api/v1/workspaces/:workspaceId/memberships/:membershipId/effective-access`

Platform permission management requires `platform_permissions.manage`:

- `GET /api/v1/platform/permission-profiles`
- `POST /api/v1/platform/permission-profiles`
- `PATCH /api/v1/platform/permission-profiles/:profileId`
- `POST /api/v1/platform/permission-profiles/:profileId/archive`
- `PUT /api/v1/platform/memberships/:membershipId/permission-profiles`
- `GET /api/v1/platform/memberships/:membershipId/access`
- `PUT /api/v1/platform/memberships/:membershipId/access`

## Frontend-Facing Access Guidance

1. Do not infer capability from role name alone. Use backend-exposed current user,
   workspace membership, and effective access data where available.
2. Treat profile assignments as baseline only. Explicit grants can allow or deny,
   and active explicit grants can override profile baseline.
3. Treat `DENY` as stronger than `ALLOW` at the same most-specific level.
4. Preserve `relationshipId` separately from trainee user id. They are not the
   same identifier.
5. For manager views, branch assignment loss can shrink previously workspace-wide
   list/query visibility.
6. For trainer, assistant trainer, and nutritionist views, assigned-trainee access
   is expected for query reads where the permission and relationship assignment
   support it.
7. For trainee views, `SELF` means the trainee's own relationship, not arbitrary
   user-owned data in the workspace.
8. For support sessions, send `x-support-session-id` only inside an active support
   session and expect additional support-sensitive gates that OpenAPI may not fully
   describe.
9. Permission success does not bypass subscription/entitlement/quota, lifecycle,
   CAS, idempotency, retention/deletion, or file-state checks.

## Discrepancies And Notes

- The default `GYM_OWNER` profile is broad but not a literal allow-all workspace
  profile. Several registered permissions have no default workspace profile grant,
  including medical-document permissions and some progress-photo write/delete
  permissions.
- OpenAPI should not be treated as authoritative for idempotency or support
  session behavior. The access matrix is derived from registry/service evidence.
- No permission implementation was changed while producing this document.
