# V1 Seed Dataset Specification

Issue: V1-DATA-02 / GitHub #17

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Backend root inspected: `apps/backend`

## Source Of Truth

The locked Stage 18 backend implementation is authoritative over this dataset
plan, generated artifacts, previous summaries, and earlier planning notes.
Repository code, tests, migrations, and the V1 documentation created from them
win when they disagree with this document.

This document is a dataset specification only. It does not implement seed code,
scripts, fixtures, database writes, tests, migrations, configuration, generated
artifacts, or production behavior.

## Out Of Scope

V1-DATA-02 does not authorize:

- seed CLI implementation;
- package script changes;
- source code changes;
- migrations or indexes;
- tests or generated fixtures;
- database writes;
- OpenAPI regeneration;
- production data modification;
- route, permission, schema, service, or repository behavior changes.

Any implementation discrepancy discovered later must be documented and resolved
against the locked repository behavior, not silently fixed during dataset work.

## Evidence Used

- `docs/v1/backend-module-inventory.md`
- `docs/v1/module-business-flows.md`
- `docs/v1/cross-module-workflows.md`
- `docs/v1/permission-access-matrix.md`
- `docs/v1/frontend-api-integration-guide.md`
- `docs/v1/frontend-pagination-cursor-contract.md`
- `docs/v1/frontend-timezone-analytics-contract.md`
- `docs/v1/frontend-file-document-integration-guide.md`
- `docs/v1/frontend-notification-integration-guide.md`
- `docs/v1/frontend-support-access-guide.md`
- `docs/v1/deterministic-seed-architecture.md`
- Stage-local test fixtures in `test/stage8-training.test.ts` and
  `test/stage16-support-access.test.ts`

## Relationship To V1-DATA-01

V1-DATA-01 defines the future seed architecture, guard model, deterministic id
scheme, manifest shape, insertion dependency order, and invariant checks.

V1-DATA-02 defines the concrete dataset profiles that V1-DATA-03 should later
implement through that architecture:

- SMALL for fast local frontend development.
- REALISTIC for normal frontend and manual QA work.
- STRESS for pagination, cursor stability, aggregation, and batch-performance
  validation.

The future implementation must keep the V1-DATA-01 non-production guard, database
allowlist, namespace rules, deterministic ids, rerun strategy, and manifest
format. V1-DATA-02 does not authorize seed implementation.

V1-DATA-03 implements the first seed system as a manifest-first non-production
CLI. The CLI materializes deterministic fixture ids, known logins, scenario
aliases, target counts, and QA references in `seed_manifests` and optional
manifest JSON output. It intentionally does not directly insert high-volume
business-domain records into locked Stage 2-18 collections.

## Dataset Names

The seed CLI designed in V1-DATA-01 should accept exactly these dataset names:

| Dataset | Intended use | Default namespace example |
| --- | --- | --- |
| `SMALL` | Fast local development and smoke checks. | `v1-small` |
| `REALISTIC` | Normal frontend development and manual QA. | `v1-realistic` |
| `STRESS` | Pagination, cursor, aggregation, and batch validation. | `v1-stress` |

## Common Dataset Rules

All datasets must:

- use deterministic ObjectIds from namespace, dataset, entity kind, and logical
  key;
- use fake deterministic identities only;
- expose known login identities and selected known ids in the manifest;
- include at least one active workspace and one restricted/inactive workspace;
- include a multi-branch workspace;
- include owner, manager, trainer, assistant trainer, nutritionist, trainee, and
  support actors where the dataset size allows;
- keep `relationshipId` distinct from trainee user id in every fixture;
- avoid cross-workspace relationships, branch assignments, subscriptions, files,
  notifications, and support sessions;
- seed pagination anchors for modules whose frontend routes are cursor-based;
- include timezone-sensitive records around local day, week, month, and DST
  boundaries;
- mark fake file storage references as non-production and safe;
- avoid due worker records unless they are explicitly scenario fixtures.

## Fixed Time Model

Use the V1-DATA-01 fixed seed clock:

```text
seedNow = 2026-01-15T10:00:00.000Z
workspaceTimezone = Africa/Cairo
```

Dataset timestamps should be named offsets from `seedNow`.

Required calendar anchors:

| Alias | Timestamp intent |
| --- | --- |
| `today.local` | Current workspace-local day containing `seedNow`. |
| `yesterday.local` | Previous workspace-local day. |
| `week.current` | Current workspace-local week bucket. |
| `week.previous` | Previous workspace-local week bucket. |
| `month.current` | Current workspace-local month bucket. |
| `month.previous` | Previous workspace-local month bucket. |
| `year.boundary` | Records around December/January. |
| `dst.reference` | Stable records documenting that Africa/Cairo workspace calendars must be computed by timezone-aware code. |

## Known Credentials

All datasets should expose these login aliases when the corresponding actor is
present:

| Alias | Email pattern | Role intent |
| --- | --- | --- |
| `platform.support_admin` | `support.admin@seed.<namespace>.local` | Platform support/admin actor. |
| `workspace.owner_active` | `owner.active@seed.<namespace>.local` | Active workspace owner. |
| `workspace.manager_branch_a` | `manager.branch-a@seed.<namespace>.local` | Manager scoped to one branch. |
| `workspace.trainer_primary` | `trainer.primary@seed.<namespace>.local` | Primary trainer with assigned relationships. |
| `workspace.trainer_secondary` | `trainer.secondary@seed.<namespace>.local` | Trainer with narrower assignments. |
| `workspace.assistant_active` | `assistant.active@seed.<namespace>.local` | Assistant trainer. |
| `workspace.nutritionist_active` | `nutritionist.active@seed.<namespace>.local` | Nutritionist. |
| `workspace.mixed_role` | `mixed.role@seed.<namespace>.local` | Staff actor with multiple profiles/grants. |
| `trainee.self_active` | `trainee.self@seed.<namespace>.local` | Trainee exercising SELF behavior. |
| `trainee.self_restricted` | `trainee.restricted@seed.<namespace>.local` | Trainee blocked by inactive/restricted context. |

Recommended password for all seed users:

```text
SeedPass123!
```

The manifest must print the email aliases and password note, but never password
hashes or session tokens.

## Dataset Size Summary

Quantities are concrete targets. Implementations may create a few additional
internal support records, audit records, idempotency receipts, or outbox rows
when using application services, but the manifest should report both target
business counts and actual inserted counts.

| Category | SMALL | REALISTIC | STRESS |
| --- | ---: | ---: | ---: |
| Workspaces | 3 | 4 | 6 |
| Branches | 5 | 12 | 30 |
| Users | 18 | 84 | 360 |
| Workspace memberships | 20 | 90 | 420 |
| Platform memberships | 2 | 4 | 8 |
| Leads | 8 | 60 | 1,000 |
| Trainee relationships | 24 | 220 | 2,400 |
| Programs/templates/assigned programs | 10 | 100 | 1,000 |
| Workout sessions | 60 | 1,500 | 50,000 |
| Personal record events | 12 | 250 | 10,000 |
| Nutrition plans/revisions | 12 | 160 | 3,000 |
| Nutrition daily logs | 60 | 1,800 | 75,000 |
| Progress measurements | 100 | 2,000 | 100,000 |
| Progress photos | 12 | 160 | 4,000 |
| Check-in instances | 40 | 800 | 25,000 |
| Files/documents | 15 | 250 | 5,000 |
| Notifications | 40 | 1,000 | 100,000 |
| Notification deliveries | 60 | 1,500 | 120,000 |
| Payments | 8 | 80 | 2,000 |
| Export requests/artifacts | 4 | 20 | 250 |
| Support sessions/access requests | 5 | 24 | 500 |
| Deletion/retention fixtures | 4 | 16 | 200 |

## Technical Realism Notes

These volumes are realistic for the repository's MongoDB architecture if
V1-DATA-03 implements batched writes and avoids one giant transaction for STRESS.

STRESS intentionally concentrates volume in append-heavy or cursor-heavy
collections:

- workout sessions;
- progress measurements;
- check-in instances;
- nutrition daily logs;
- notifications and deliveries;
- file metadata.

The STRESS dataset should not replay every record through public application
services. Use services for representative side-effect-heavy flows and direct
repository/database inserts for high-volume historical facts, followed by the
V1-DATA-01 invariant checks.

## Workspace Composition

### SMALL

| Alias | State | Branches | Purpose |
| --- | --- | ---: | --- |
| `workspace.active_main` | active | 2 | Primary gym for day-to-day frontend flows. |
| `workspace.multi_branch` | active | 2 | Branch-scope and manager-scope checks. |
| `workspace.restricted` | restricted/inactive fixture | 1 | Denial, frozen, and restricted workspace behavior. |

### REALISTIC

| Alias | State | Branches | Purpose |
| --- | --- | ---: | --- |
| `workspace.active_main` | active | 4 | Main gym with broad module coverage. |
| `workspace.multi_branch` | active | 5 | Branch, assignment, and analytics coverage. |
| `workspace.nutrition_focus` | active | 2 | Nutrition-heavy relationships and adherence. |
| `workspace.restricted` | restricted/inactive fixture | 1 | Workspace restriction, support, retention, and deletion checks. |

### STRESS

| Alias | State | Branches | Purpose |
| --- | --- | ---: | --- |
| `workspace.active_main` | active | 8 | High-volume primary gym. |
| `workspace.multi_branch` | active | 8 | Large branch fan-out and manager scope. |
| `workspace.nutrition_focus` | active | 5 | Nutrition/adherence aggregation pressure. |
| `workspace.progress_heavy` | active | 5 | Measurement and analytics pagination pressure. |
| `workspace.support_target` | active | 2 | Support-sensitive fixtures. |
| `workspace.restricted` | restricted/inactive fixture | 2 | Frozen/restricted/deletion lifecycle checks. |

## Branch Fixtures

Required branch aliases:

- `branch.main`
- `branch.downtown`
- `branch.women_only`
- `branch.rehab`
- `branch.nutrition_studio`
- `branch.inactive`

SMALL may include only the first five aliases across its three workspaces.
REALISTIC and STRESS should include all aliases, plus deterministic numbered
branches such as `branch.performance_01`.

## Staff And Membership Fixtures

Each dataset should include these staff aliases in `workspace.active_main`:

| Alias | Intended access coverage |
| --- | --- |
| `owner.active` | Workspace-wide owner visibility. |
| `manager.branch_a` | Branch-scoped manager access. |
| `manager.multi_branch` | Multiple branch assignments. |
| `trainer.primary` | Primary trainer relationship scope. |
| `trainer.secondary` | Secondary trainer and assignment transfer checks. |
| `assistant.active` | Assistant trainer limitations. |
| `nutritionist.active` | Nutrition-only and nutrition-assigned access. |
| `staff.mixed_role` | Combined role/profile/grant behavior. |
| `staff.explicit_deny` | DENY precedence over broad ALLOW. |
| `staff.inactive_membership` | Inactive membership denial. |

SMALL should include one actor per alias where possible, with `manager.multi_branch`
and `staff.mixed_role` allowed to be the same user if necessary. REALISTIC and
STRESS should keep them separate.

## Trainee And Relationship Fixtures

Required relationship aliases:

| Alias | Purpose |
| --- | --- |
| `relationship.active.primary_trainer` | Normal trainer-owned active relationship. |
| `relationship.active.assistant_assigned` | Assistant trainer access. |
| `relationship.active.nutrition_only` | Nutritionist-only relationship. |
| `relationship.active.multi_staff` | Primary trainer, assistant, and nutritionist all assigned. |
| `relationship.active.unassigned` | Unassigned case. |
| `relationship.inactive.ended` | Inactive relationship visibility and denial. |
| `relationship.branch_a` | Branch-restricted access. |
| `relationship.branch_b_denied` | Scoped-deny branch/relationship test. |
| `relationship.self.active` | Trainee SELF access. |
| `relationship.pagination.progress_500_plus` | Progress pagination and analytics anchor. |
| `relationship.timezone.boundary` | Local date/week/month bucket checks. |
| `relationship.file_sensitive` | Sensitive file/document checks. |
| `relationship.export_subject` | Export/deletion lifecycle coverage. |

Relationship counts by dataset:

| Relationship group | SMALL | REALISTIC | STRESS |
| --- | ---: | ---: | ---: |
| Active assigned training | 8 | 80 | 900 |
| Assistant trainer assigned | 3 | 30 | 300 |
| Nutrition-only | 3 | 30 | 300 |
| Multi-staff | 3 | 30 | 300 |
| Unassigned | 2 | 20 | 200 |
| Inactive/ended | 3 | 20 | 250 |
| Edge/pagination/timezone | 2 | 10 | 150 |
| Total | 24 | 220 | 2,400 |

## Commercial Fixtures

Required aliases:

- `commercial.plan.basic.active_version`
- `commercial.plan.pro.active_version`
- `commercial.plan.enterprise.active_version`
- `commercial.subscription.active_good_standing`
- `commercial.subscription.frozen`
- `commercial.subscription.expired`
- `commercial.payment.paid`
- `commercial.payment.pending`
- `commercial.payment.failed`
- `commercial.quota.near_limit`
- `commercial.quota.exceeded`

The active workspaces should have valid subscriptions and workspace usage.
The restricted workspace should exercise frozen/expired/subscription denial
without changing locked Stage 5 behavior.

## Training Fixtures

Required aliases:

- `training.exercise.squat`
- `training.exercise.bench_press`
- `training.exercise.deadlift`
- `training.exercise.treadmill_intervals`
- `training.template.strength_12_week`
- `training.template.weight_loss_8_week`
- `training.program.active`
- `training.program.draft`
- `training.program.completed`
- `training.program.archived`
- `training.assignment.current`
- `training.assignment.future`
- `training.assignment.completed`

Program and workout count guidance:

| Dataset | Programs/templates/assignments | Workout sessions |
| --- | ---: | ---: |
| SMALL | 10 | 60 |
| REALISTIC | 100 | 1,500 |
| STRESS | 1,000 | 50,000 |

Workout sessions must include completed, active/current, abandoned, skipped,
deferred, corrected, and PR-generating examples where the implementation supports
those states.

## Workout And PR Fixtures

Required aliases:

- `workout.current.in_progress`
- `workout.completed.with_pr`
- `workout.completed.no_pr`
- `workout.skipped`
- `workout.deferred`
- `workout.abandoned`
- `workout.corrected`
- `pr.squat_1rm`
- `pr.bench_volume`
- `pr.bodyweight_reps`

STRESS should distribute sessions across at least 180 local calendar days so
dashboard and relationship analytics can validate date range filtering and
bucket boundaries.

## Nutrition Fixtures

Required aliases:

- `nutrition.food.system_chicken_breast`
- `nutrition.food.workspace_local_meal`
- `nutrition.plan.active`
- `nutrition.plan.draft`
- `nutrition.plan.completed`
- `nutrition.plan.archived`
- `nutrition.revision.active`
- `nutrition.daily_log.good_adherence`
- `nutrition.daily_log.low_adherence`
- `nutrition.daily_log.missing_water`
- `nutrition.daily_log.over_target`

Nutrition daily logs should include water tracking and target variation. REALISTIC
and STRESS should include enough logs to support weekly/monthly adherence charts.

## Progress Fixtures

Required aliases:

- `progress.metric.body_weight`
- `progress.metric.waist`
- `progress.metric.body_fat`
- `progress.measurement.same_day_morning`
- `progress.measurement.same_day_evening`
- `progress.measurement.month_boundary_before`
- `progress.measurement.month_boundary_after`
- `progress.measurement.pagination_anchor_500`
- `progress.photo.verified`
- `progress.photo.pending`
- `progress.health_profile.active`
- `progress.coaching_note.visible_to_staff`
- `progress.adherence.good_week`
- `progress.adherence.bad_week`

Progress counts:

| Dataset | Measurements | Photos |
| --- | ---: | ---: |
| SMALL | 100 | 12 |
| REALISTIC | 2,000 | 160 |
| STRESS | 100,000 | 4,000 |

SMALL must include at least one relationship with more than 50 measurements.
REALISTIC must include at least one relationship with more than 500 measurements.
STRESS must include at least one relationship with more than 10,000 measurements.

## Check-In Fixtures

Required aliases:

- `checkin.template.weekly_progress`
- `checkin.template.nutrition_review`
- `checkin.assignment.active`
- `checkin.instance.upcoming`
- `checkin.instance.due`
- `checkin.instance.overdue`
- `checkin.instance.submitted`
- `checkin.instance.reviewed`
- `checkin.instance.skipped`

Check-in counts:

| Dataset | Instances |
| --- | ---: |
| SMALL | 40 |
| REALISTIC | 800 |
| STRESS | 25,000 |

The datasets should include due and overdue fixtures without requiring the worker
to mutate them during a normal frontend session.

## File And Document Fixtures

Required aliases:

- `file.profile_photo.verified`
- `file.progress_photo.verified`
- `file.inbody_report.verified`
- `file.medical_document.sensitive`
- `file.upload.pending`
- `file.upload.reserved`
- `file.upload.checksum_mismatch_fixture`
- `file.generated.export_artifact`
- `document.trainee_contract`
- `document.retention_notice`

File/document counts:

| Dataset | Files/documents |
| --- | ---: |
| SMALL | 15 |
| REALISTIC | 250 |
| STRESS | 5,000 |

Seeded files must use fake object keys and must not include real private content
or signed URLs in the manifest.

## Notification Fixtures

Required aliases:

- `notification.unread.checkin_due`
- `notification.read.workout_completed`
- `notification.delivery.pending`
- `notification.delivery.sent`
- `notification.delivery.failed_retryable`
- `notification.delivery.failed_terminal`
- `notification.delivery.cancelled`
- `notification.preference.email_off`
- `notification.preference.push_on`
- `notification.device.fake_active`

Notification counts:

| Dataset | Notifications | Deliveries |
| --- | ---: | ---: |
| SMALL | 40 | 60 |
| REALISTIC | 1,000 | 1,500 |
| STRESS | 100,000 | 120,000 |

STRESS should include at least one recipient with more than 10,000 notifications
to validate cursor pagination and unread/read filtering.

## Support Fixtures

Required aliases:

- `support.policy.workspace_enabled`
- `support.policy.workspace_denied`
- `support.request.pending`
- `support.request.approved`
- `support.request.denied`
- `support.session.active_read_only`
- `support.session.active_user_context`
- `support.session.expired`
- `support.session.sensitive_allowed`
- `support.session.sensitive_denied`

Support sessions must exercise `x-support-session-id`, `USER_CONTEXT`, effective
tenant actor resolution, support-sensitive permissions, and workspace support
denial. The seed data must not imply OpenAPI fully describes this behavior.

## Export, Retention, And Deletion Fixtures

Required aliases:

- `export.request.pending`
- `export.request.processing`
- `export.request.completed`
- `export.artifact.downloadable`
- `retention.warning.active`
- `retention.warning.expired`
- `deletion.request.scheduled`
- `deletion.request.cancelled`
- `deletion.request.completed_fixture`

Deletion fixtures must be safe. They should not cause automatic destructive
processing during normal frontend development unless the scenario explicitly runs
the relevant worker in an isolated non-production database.

## Audit Fixtures

Seeded audit events should support QA verification for:

- sensitive reads;
- support access;
- membership/profile/grant changes;
- file download;
- export request/download;
- deletion/retention lifecycle;
- payment/subscription manual actions.

Audit events should use fake actor ids and redacted details consistent with the
locked audit behavior.

## Leads And Owner Activation Fixtures

Required aliases:

- `lead.public.new`
- `lead.platform.contacted`
- `lead.platform.converted`
- `lead.platform.rejected`
- `owner_activation.pending`
- `owner_activation.completed`
- `owner_activation.expired`

Lead conversion fixtures should reference valid commercial/workspace entities
only where the implementation expects them.

## Permission And Denial Fixtures

Required aliases:

- `permission.owner.workspace_allow`
- `permission.manager.branch_allow`
- `permission.trainer.relationship_allow`
- `permission.trainee.self_allow`
- `permission.explicit_deny_over_allow`
- `permission.scoped_deny_inside_allow`
- `permission.branch_assignment_removed`
- `permission.relationship_unassigned`
- `permission.inactive_membership`
- `permission.restricted_workspace`

These fixtures should be represented in the manifest by actor alias, workspace,
branch, relationship, expected decision, and relevant permission string.

## Pagination And Cursor Fixtures

The manifest should expose stable pagination anchors:

| Alias | Dataset requirement |
| --- | --- |
| `pagination.progress_500_plus` | REALISTIC and STRESS; optional smaller count in SMALL. |
| `pagination.notifications_1000_plus` | REALISTIC and STRESS. |
| `pagination.workouts_month_range` | All datasets. |
| `pagination.checkins_status_filtered` | All datasets. |
| `pagination.files_category_bound` | REALISTIC and STRESS. |
| `pagination.analytics_category_bound` | REALISTIC and STRESS. |

Cursor internals must not be exposed. The manifest should expose record aliases
and filter sets that let QA reproduce stable list boundaries.

## Rerun And Cleanup Expectations

The concrete datasets in this document must remain compatible with the
V1-DATA-01 rerun modes:

- dry run;
- upsert;
- reset namespace;
- isolated database reset for strictly allowlisted seed/test databases.

Dataset builders should ensure each profile can be regenerated with the same
namespace and dataset name without creating duplicate logical records. Cleanup
must use the seed namespace, deterministic ids, and manifest-owned aliases. It
must never delete non-seed developer data from a non-isolated database.

STRESS cleanup should be batched in reverse dependency order and must avoid
loading all high-volume ids into memory at once.

## Edge-Case Record Catalog

Every dataset should include these edge cases where volume permits:

- stale `expectedVersion` conflict target;
- valid `expectedVersion` update target;
- idempotency replay target;
- idempotency mismatch target;
- quota near-limit workspace;
- quota exceeded workspace;
- file checksum mismatch target;
- pending upload older than normal confirmation window;
- support-sensitive allowed read;
- support-sensitive denial;
- read-only support mutation denial;
- inactive workspace denial;
- frozen/expired subscription denial;
- timezone local-day boundary;
- same-day duplicate measurement ordering;
- notification retry/cancel target;
- export completed artifact;
- retention warning;
- deletion scheduled fixture.

SMALL should include at least one fixture per category. REALISTIC and STRESS
should include multiple fixtures per category across different actors and
workspaces.

## Manifest Requirements

The future seed manifest should contain:

- dataset name, namespace, locked baseline, generated timestamp, and logical
  seed;
- target and actual record counts by module;
- known logins and shared password note;
- workspace ids and branch ids by alias;
- membership ids by actor alias;
- relationship ids by scenario alias;
- representative training, workout, nutrition, progress, check-in, file,
  notification, support, export, and deletion ids;
- pagination anchor aliases and recommended filter sets;
- expected permission decisions for permission fixtures;
- known version values for mutation/conflict scenarios;
- implementation warnings if a requested fixture is omitted because repository
  behavior does not support it.

## Insertion Order Mapping

V1-DATA-03 must implement these datasets using the V1-DATA-01 insertion order.

| V1-DATA-01 order | Dataset content |
| --- | --- |
| 1-4 | Guard, migrations, seed manifest, permission/profile verification. |
| 5-11 | Platform actors, workspaces, branches, memberships, profile assignments, grants, branch assignments. |
| 12 | Commercial plans, versions, subscriptions, payments, quota/usage fixtures. |
| 13 | Leads and owner activation fixtures. |
| 14 | Relationships, invitations/referrals, staff assignments, migrations. |
| 15-16 | Training programs, assignments, workout sessions, PRs. |
| 17 | Nutrition foods, plans, revisions, logs. |
| 18 | Progress metrics, measurements, photos, profiles, notes, adherence. |
| 19 | Check-in templates, assignments, instances, responses, reviews. |
| 20 | Files, upload intents, generated file metadata, documents. |
| 21 | Notifications, preferences, deliveries, devices. |
| 22 | Audit events needed by QA scenarios. |
| 23 | Support policies, requests, sessions, USER_CONTEXT fixtures. |
| 24 | Export, retention, and deletion fixtures. |
| 25-26 | Verify analytics source data and finalize manifest counts/known ids. |

## Referential Invariants

Dataset implementation must verify:

- every workspace-scoped record references an existing workspace;
- every branch-scoped record references a branch in the same workspace;
- every staff assignment references a valid membership in the same workspace;
- every trainee relationship references exactly one trainee user and one
  workspace membership;
- every relationship-scoped training, workout, nutrition, progress, check-in,
  file, notification, export, and analytics fixture references an existing
  relationship id;
- `relationshipId` is never equal to or substituted for trainee user id;
- every subscription/payment/quota fixture references valid workspace commercial
  records;
- every support session references valid support policy/request/session state and
  a valid effective actor where `USER_CONTEXT` is used;
- every file/document fixture respects subject, classification, status, and fake
  storage constraints;
- every deletion/retention fixture is safe for non-production and will not
  destroy unrelated developer data.

## Locked-Stage Protection

- This document does not modify Stage 2-18 locked behavior.
- This document does not reopen completed stages.
- This document does not add seed implementation.
- This document does not add package scripts, tests, migrations, source files,
  generated artifacts, database writes, routes, permissions, or schemas.
- Future implementation must document discrepancies instead of silently changing
  locked business behavior to fit this dataset plan.
