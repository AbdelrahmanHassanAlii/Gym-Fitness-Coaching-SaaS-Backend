# V1 QA And Integration Scenario Catalog

Issue: V1-QA-01 / GitHub #19

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Backend root inspected: `apps/backend`

## Source Of Truth

The locked Stage 18 backend implementation is authoritative over this QA
catalog, generated artifacts, previous summaries, and planning notes. Repository
code, tests, migrations, and repository-grounded V1 docs win when they disagree
with this document.

This document is a QA scenario design only. It does not implement automated
tests, seed code, source changes, migrations, OpenAPI changes, product features,
database writes, or runtime behavior.

## Evidence Used

- `docs/v1/module-business-flows.md`
- `docs/v1/cross-module-workflows.md`
- `docs/v1/permission-access-matrix.md`
- `docs/v1/frontend-api-integration-guide.md`
- `docs/v1/frontend-error-ux-catalog.md`
- `docs/v1/frontend-pagination-cursor-contract.md`
- `docs/v1/frontend-timezone-analytics-contract.md`
- `docs/v1/frontend-file-document-integration-guide.md`
- `docs/v1/frontend-notification-integration-guide.md`
- `docs/v1/frontend-support-access-guide.md`
- `docs/v1/seed-dataset-specification.md`

## Usage

Each scenario is intended for manual QA, frontend integration checks, or future
automated integration tests after V1-DATA-03 implements deterministic seed data.

The `Seed fixture` column references aliases defined by
`docs/v1/seed-dataset-specification.md`. If a fixture is unavailable in an early
seed implementation, the scenario should be marked blocked instead of inventing
data that violates V1 invariants.

## Common Assumptions

- Actor sessions are authenticated unless the scenario is explicitly about auth.
- Workspace context is selected through the documented `/api/v1` workspace routes.
- Support scenarios send `x-support-session-id`; non-support scenarios do not.
- `relationshipId` means the coaching relationship id, not trainee user id.
- `Idempotency-Key` is sent only for routes proven idempotency-wrapped by route
  and service evidence.
- `expectedVersion`, `version`, `revision`, or `accessVersion` values come from
  the latest read response or seed manifest.
- Denied scenarios should verify both the HTTP/error response and the absence of
  unintended persistence changes.

## Scenario Matrix

| ID | Scenario | Actor | Workspace / branch / relationship | Initial state | Action | Expected result | Permission decision | Side effects | Audit / outbox | Seed fixture |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| QA-001 | Owner sees all branches | `workspace.owner_active` | `workspace.active_main`; all branches; any relationship | Owner membership active with owner profile. | Open gym dashboard, branch list, staff/relationship lists, and relationship dashboard. | All workspace branches and eligible workspace records are visible. | ALLOW through owner workspace-wide grants. | Read-only; no state change. | Sensitive relationship dashboard reads can write sensitive audit where documented; no outbox. | `owner.active`, `workspace.active_main`, `branch.main`, `branch.downtown`, `relationship.active.primary_trainer` |
| QA-002 | Manager branch scope | `workspace.manager_branch_a` | `workspace.multi_branch`; `branch.main`; `relationship.branch_a` | Manager has branch assignment and profile access only for branch A. | List trainees/relationships and open branch dashboard for assigned and unassigned branches. | Assigned branch records are visible; other branch records are hidden or denied. | ALLOW for assigned branch atoms; DENY/filtered for other branches. | Read-only. | Sensitive dashboard/analytics reads can write audit; no outbox. | `manager.branch_a`, `permission.manager.branch_allow`, `relationship.branch_a` |
| QA-003 | Trainer assigned relationship | `workspace.trainer_primary` | `workspace.active_main`; `relationship.active.primary_trainer` | Trainer is assigned as primary trainer to the relationship. | Read relationship profile, current training program, workouts, progress, check-ins, and training analytics. | Assigned relationship data loads. | ALLOW through assigned/specific relationship access. | Read-only unless test performs a mutation. | Sensitive progress/check-in/analytics reads can write audit; no outbox for reads. | `trainer.primary`, `relationship.active.primary_trainer` |
| QA-004 | Assistant trainer restrictions | `workspace.assistant_active` | `workspace.active_main`; `relationship.active.assistant_assigned` | Assistant is assigned to relationship. | Attempt allowed workout/progress reads, then attempt owner/trainer-only mutation. | Allowed reads succeed; restricted mutation fails. | ALLOW for assistant-granted permissions; DENY for unavailable command permission. | Failed mutation writes nothing. | Allowed sensitive reads may audit; denied mutation should not emit domain outbox. | `assistant.active`, `relationship.active.assistant_assigned` |
| QA-005 | Nutritionist scope | `workspace.nutritionist_active` | `workspace.nutrition_focus`; `relationship.active.nutrition_only` | Nutritionist assigned to nutrition-only relationship. | Read nutrition plan/logs and nutrition analytics; attempt training mutation. | Nutrition data loads; training mutation denied. | ALLOW for nutrition permissions; DENY for training mutation. | Failed training mutation writes nothing. | Nutrition reads normally no outbox; sensitive analytics may audit. | `nutritionist.active`, `relationship.active.nutrition_only`, `nutrition.plan.active` |
| QA-006 | Trainee SELF scope | `trainee.self_active` | `workspace.active_main`; `relationship.self.active` | Trainee has active membership and own relationship. | Read own dashboard/progress/check-ins, then try another trainee relationship id. | Own SELF data loads; other relationship is denied/not visible. | ALLOW through SELF only for own relationship id; DENY for unrelated relationship. | Read-only. | Sensitive self reads can audit where service writes sensitive audit; no outbox. | `trainee.self_active`, `relationship.self.active` |
| QA-007 | DENY overrides ALLOW | `staff.explicit_deny` | `workspace.active_main`; target relationship from fixture | Actor has broad profile ALLOW plus explicit DENY for a permission/scope. | Attempt the denied capability and compare with a still-allowed capability. | Denied capability fails even though broad profile would otherwise allow it. | DENY precedence wins at strongest applicable specificity. | Denied command writes nothing. | No domain outbox for denied command; auth denial may be visible through error logging only. | `permission.explicit_deny_over_allow`, `staff.explicit_deny` |
| QA-008 | Scoped DENY inside broad ALLOW | `staff.mixed_role` | `workspace.multi_branch`; denied branch or relationship | Actor has broad branch/workspace ALLOW and a more specific scoped DENY. | Query list and open denied branch/relationship detail. | Allowed scopes remain visible; denied atom is filtered or rejected. | Scoped DENY wins for matching atom. | Read-only. | Sensitive allowed reads may audit; denied read should not leak resource details. | `permission.scoped_deny_inside_allow`, `relationship.branch_b_denied` |
| QA-009 | Branch assignment loss | `workspace.manager_branch_a` or `trainer.secondary` | `workspace.multi_branch`; previously assigned branch | Branch assignment has been removed or outbox reconciliation fixture exists. | Refresh access and relationship list. | Removed branch relationships disappear or commands are denied; frontend refreshes cached permissions. | DENY after branch atom is absent/removed. | No mutation in QA read; if branch removal was seeded, downstream relationship eligibility has already been reconciled or is marked eventual. | Original branch assignment change writes audit/outbox; this read has no outbox. | `permission.branch_assignment_removed` |
| QA-010 | Inactive workspace | `workspace.owner_active` or restricted trainee | `workspace.restricted`; any branch/relationship | Workspace is inactive/restricted fixture. | Attempt normal workspace read or mutation. | Request fails with workspace inactive/restricted error; frontend exits workspace flow. | DENY before normal business flow. | Writes nothing. | No domain outbox. | `workspace.restricted`, `permission.restricted_workspace` |
| QA-011 | Frozen subscription | Workspace owner | Workspace with `commercial.subscription.frozen` | Workspace has frozen/expired commercial state. | Attempt entitlement-gated relationship/training/file action. | Capability is blocked by subscription/entitlement, not by role permission. | Permission may ALLOW; entitlement gate DENIES. | Writes nothing unless service records failed attempt internally. | No business outbox for blocked command. | `commercial.subscription.frozen` |
| QA-012 | Quota conflict near limit | Owner or manager | Active workspace with quota near limit | Usage is one record below staff/trainee/storage quota. | Create/invite/upload one allowed item, then attempt one more beyond quota. | First action succeeds; second fails with quota error. | Permission ALLOW; quota gate decides failure. | First action reserves usage and writes domain data; second writes nothing. | Successful action writes module audit/outbox where documented; quota failure does not emit success event. | `commercial.quota.near_limit`, `commercial.quota.exceeded` |
| QA-013 | Idempotency replay | Authorized actor for an idempotency-wrapped command | Any eligible workspace/relationship | Command route requires `Idempotency-Key`; same key and same body will be replayed. | Submit command, repeat with same `Idempotency-Key` and identical body. | Second response returns stored/replayed result without duplicate business record. | ALLOW for both attempts. | Only one logical domain mutation exists. | First execution writes audit/outbox; replay must not duplicate side effects. | `idempotency replay target` from manifest edge cases |
| QA-014 | Idempotency mismatch | Same actor as QA-013 | Same resource | Idempotency key already used for different body. | Repeat command with same `Idempotency-Key` and changed body. | Request fails with idempotency mismatch/conflict. | Initial command ALLOW; mismatch rejected by idempotency layer. | No second mutation. | No duplicate audit/outbox for changed replay. | `idempotency mismatch target` |
| QA-015 | expectedVersion conflict | Authorized editor | Versioned resource such as relationship/program/check-in/file/support/deletion | Manifest exposes stale and current version values. | Submit update using stale `expectedVersion`, then refetch and retry with current value if scenario allows. | Stale update returns version conflict; current version update succeeds only if still valid. | Permission ALLOW; CAS rejects stale write. | Stale write changes nothing; valid retry writes normal mutation. | Valid retry writes audit/outbox where module does; stale conflict does not emit success event. | `stale expectedVersion conflict target`, `valid expectedVersion update target` |
| QA-016 | Support-sensitive denial | `platform.support_admin` | `workspace.support_target`; sensitive relationship/file | Active support session lacks required sensitive platform permission or session allowance. | Send `x-support-session-id` and read sensitive progress/check-in/medical document/download. | Request fails with support-sensitive denial. | Workspace support may be valid; sensitive gate DENIES. | Writes nothing except denial/log behavior; no signed URL. | Sensitive access audit should not record successful read/download. | `support.session.sensitive_denied`, `file.medical_document.sensitive` |
| QA-017 | Support-sensitive allowed read | `platform.support_admin` | `workspace.support_target`; sensitive relationship/file | Active support session has required sensitive permission/allowance. | Send `x-support-session-id` and read sensitive analytics or download sensitive file. | Sensitive data/read URL is returned. | ALLOW through support session plus support-sensitive gate. | Read/download URL generated as documented. | Sensitive access audit is written; no business outbox for read. | `support.session.sensitive_allowed`, `relationship.file_sensitive` |
| QA-018 | Read-only support mutation denial | `platform.support_admin` | `workspace.support_target`; active read-only support session | Support session mode is read-only or mutation not whitelisted. | Attempt workspace mutation with `x-support-session-id`. | Mutation fails with support read-only/write-not-whitelisted error. | DENY by support access layer before domain write. | No domain mutation. | No domain outbox; support audit/session evidence remains unchanged except possible denied access evidence. | `support.session.active_read_only` |
| QA-019 | Progress over 500 pagination | Owner/trainer/trainee SELF with access | `relationship.pagination.progress_500_plus` | Relationship has more than 500 progress measurements. | Page through progress list/analytics points using returned cursors and stable filters. | All pages load in backend order with no duplicates or skipped records. | ALLOW through relationship scope. | Read-only. | Sensitive progress analytics/read can audit; no outbox. | `pagination.progress_500_plus`, `progress.measurement.pagination_anchor_500` |
| QA-020 | Category-bound analytics cursors | Authorized analytics actor | Relationship analytics fixture | Analytics endpoint returns category-specific cursors. | Request one analytics category page, then incorrectly reuse cursor with another category/filter. | Correct cursor continues; wrong category/filter cursor fails/reset behavior follows frontend cursor contract. | Permission ALLOW; cursor validation rejects invalid context. | Read-only. | Sensitive analytics read may audit for successful requests; no outbox. | `pagination.analytics_category_bound`, `relationship.timezone.boundary` |
| QA-021 | File checksum mismatch | Authorized uploader | Relationship/file subject fixture | Upload intent/reservation exists; object metadata/checksum differs from expected. | Confirm upload with mismatched SHA-256 or object metadata. | Confirmation fails with checksum/object mismatch; frontend requires new upload intent. | Permission ALLOW; file verification denies confirmation. | Upload intent remains unconfirmed/failed according to file lifecycle; no active file created. | Upload intent audit exists; no document-upload outbox for failed confirmation. | `file.upload.checksum_mismatch_fixture` |
| QA-022 | Storage quota exceeded | Authorized uploader | Workspace with storage quota exceeded | Workspace storage usage exceeds or lacks available quota. | Request upload intent or confirm upload that would exceed storage quota. | Request fails with storage quota error. | Permission may ALLOW; quota/storage gate DENIES. | No new active file and no committed storage usage. | No document-upload outbox. | `commercial.quota.exceeded`, `file.upload.reserved` |
| QA-023 | Notification retry and cancel | Current notification recipient or worker fixture | Personal notification inbox | Deliveries include retryable failure, terminal failure, and cancelled states. | List notifications/deliveries if exposed; run/poll worker in isolated QA if scenario does worker validation. | Read/unread state is separate from delivery state; retry/cancel fixtures display expected state. | User can read own notifications; worker uses delivery lease/provider logic. | Mark-read changes notification read state only. | Notification deliveries originate from outbox handlers; mark-read generally no business outbox. | `notification.delivery.failed_retryable`, `notification.delivery.cancelled` |
| QA-024 | Export lifecycle | Workspace owner/exporter | Active workspace with export fixtures | Export permissions present; no active conflicting export unless scenario tests conflict. | Create export with idempotency key, list status, simulate/observe ready artifact, request download URL. | Export moves through pending/processing/ready or seeded completed state; download available only when ready. | ALLOW for owner/export permission; support context forbidden. | Export request/artifact and generated file metadata are created for successful flow. | Export create/ready/failed lifecycle writes audit/outbox and can notify requester. | `export.request.completed`, `export.artifact.downloadable` |
| QA-025 | Deletion lifecycle | Platform deletion admin | Restricted/deletion fixture workspace | Workspace deletion request exists in scheduled/pending state with expectedVersion. | Read deletion detail, approve/postpone/cancel according to fixture state. | Valid transition succeeds; invalid/stale transition fails. | ALLOW through platform deletion permission; support context forbidden. | Successful transition updates deletion request only as allowed. | Deletion lifecycle writes audit/outbox and can notify. | `deletion.request.scheduled`, `deletion.request.cancelled` |
| QA-026 | Retention warning | Owner or platform/admin actor depending route | Workspace with retention warning fixture | Retention warning is active or expired. | Read billing/retention/deletion-related surface and attempt blocked operation if applicable. | Warning is visible where route exposes it; restricted operation follows retention/deletion rules. | Permission may ALLOW; retention lifecycle may restrict operation. | Read-only unless transition scenario is run. | Retention/deletion events can write audit/outbox/notifications when lifecycle changes. | `retention.warning.active`, `retention.warning.expired` |
| QA-027 | Timezone and DST analytics behavior | Authorized analytics actor | `relationship.timezone.boundary`; workspace timezone fixture | Records exist around local day/week/month and DST-reference boundaries. | Request relationship analytics with date-only `[from,to)` ranges and timezone-qualified instants. | Buckets use workspace timezone; naive datetime input is rejected; date-only ranges map to local midnight boundaries. | ALLOW through relationship analytics permission. | Read-only. | Sensitive analytics reads can audit; no outbox. | `relationship.timezone.boundary`, `pagination.analytics_category_bound` |
| QA-028 | Inactive membership denial | `staff.inactive_membership` | Active workspace with inactive actor membership | User exists but membership is inactive. | Attempt workspace route that active role would otherwise allow. | Request is denied before business operation. | DENY due inactive membership. | Writes nothing. | No domain outbox. | `permission.inactive_membership` |
| QA-029 | Relationship id versus trainee user id | Trainer/owner with relationship access | `relationship.self.active` and trainee user id | Manifest exposes both trainee user id and relationship id. | Call relationship-scoped route once with relationship id and once with trainee user id. | Relationship id works if allowed; trainee user id fails/not found/denied according to route behavior. | ALLOW only for valid relationship resource id. | Read-only. | Sensitive successful reads can audit; failed lookup must not leak unrelated data. | `relationship.self.active` |
| QA-030 | Restricted workspace support denial | `platform.support_admin` | `workspace.restricted` with denied support policy/session | Support policy/session cannot access target workspace. | Send `x-support-session-id` for denied workspace. | Request fails with support workspace/session denial; frontend clears support context. | DENY by support context validation. | No domain mutation. | No successful sensitive-read audit; support session/request evidence remains. | `support.policy.workspace_denied`, `support.session.expired` |

## Frontend Traceability

QA should trace scenario expectations to frontend contracts:

| Scenario group | Frontend guide |
| --- | --- |
| Permissions and scope | `docs/v1/permission-access-matrix.md`, `docs/v1/frontend-api-integration-guide.md` |
| Errors and retry behavior | `docs/v1/frontend-error-ux-catalog.md` |
| Pagination and cursors | `docs/v1/frontend-pagination-cursor-contract.md` |
| Timezone and analytics | `docs/v1/frontend-timezone-analytics-contract.md` |
| Files and checksums | `docs/v1/frontend-file-document-integration-guide.md` |
| Notifications | `docs/v1/frontend-notification-integration-guide.md` |
| Support access | `docs/v1/frontend-support-access-guide.md` |
| Seed aliases | `docs/v1/seed-dataset-specification.md` |

## Minimum Release Smoke Set

Before V1 handoff, run or manually verify at least:

- QA-001 through QA-008 for access scope coverage.
- QA-010 through QA-015 for workspace/commercial/idempotency/concurrency errors.
- QA-016 through QA-018 and QA-030 for support access.
- QA-019, QA-020, and QA-027 for pagination/timezone/analytics.
- QA-021 through QA-026 for files, notifications, export, deletion, and retention.

## V1-DATA-03 Fixture Requirements

The deterministic seed implementation should expose manifest entries for every
`Seed fixture` alias in the scenario matrix. If implementation cannot create a
fixture without violating locked behavior, it must:

1. omit the fixture;
2. record the omission in the seed manifest;
3. link the omission to the affected QA scenario id;
4. document the repository-backed reason.

## Locked-Stage Protection

- This document does not modify Stage 2-18 locked behavior.
- This document does not reopen completed stages.
- This document does not add tests, seed code, source files, migrations,
  generated artifacts, OpenAPI changes, database writes, routes, permissions, or
  schemas.
- Future QA execution must document discrepancies instead of silently changing
  locked business behavior to satisfy a scenario.
