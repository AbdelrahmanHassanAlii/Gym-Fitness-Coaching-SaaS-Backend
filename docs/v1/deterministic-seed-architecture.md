# V1 Deterministic Seed Architecture

Issue: V1-DATA-01 / GitHub #16

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Backend root inspected: `apps/backend`

## Source Of Truth

The locked Stage 18 backend implementation is authoritative over generated
OpenAPI, previous summaries, and this document. Route files, schemas, services,
repositories, tests, migrations, and existing V1 docs win when they disagree with
generated artifacts.

This document is a seed-system architecture design only. It does not implement
seed code, scripts, fixtures, source changes, migrations, tests, configuration,
database writes, or generated artifacts.

## Evidence Used

- `package.json`
- `src/config/config.ts`
- `src/config/config.types.ts`
- `src/bootstrap/app-container.ts`
- `src/cli/db-migrate.ts`
- `src/cli/db-migrate-status.ts`
- `src/cli/platform-admin-create.ts`
- `src/migrations/migration-runner.ts`
- `src/core/auth/password-hasher.ts`
- `src/core/database/unit-of-work.ts`
- `src/core/idempotency/idempotency.service.ts`
- `src/modules/permissions/permission.registry.ts`
- `test/stage8-training.test.ts`
- `test/stage16-support-access.test.ts`
- `docs/v1/backend-module-inventory.md`
- `docs/v1/permission-access-matrix.md`
- `docs/v1/frontend-api-integration-guide.md`
- `docs/v1/frontend-file-document-integration-guide.md`
- `docs/v1/frontend-notification-integration-guide.md`
- `docs/v1/frontend-support-access-guide.md`

## Current Repository Seed Status

V1-DATA-03 adds the first V1 seed tooling under `src/seeds/v1` and
`src/cli/v1-seed.ts`.

Repository evidence:

- `package.json` exposes `db:seed:v1`.
- `src/cli/v1-seed.ts` implements the non-production seed CLI.
- `src/seeds/v1` implements guard checks, deterministic ids, manifest building,
  namespace reset for `seed_manifests`, migration verification, and manifest
  emission.
- `src/cli` contains migration status/run commands and
  `platform-admin-create.ts` in addition to the V1 seed CLI.
- Backend tests contain stage-local helper functions such as `seedGym`,
  `seedWorkspaceUser`, `seedSensitiveSourceFixture`, `seedActiveSubscription`,
  and `seedPolicy`. These helpers are useful implementation evidence, but they
  are not reused directly by the V1 seed CLI.

The V1-DATA-03 implementation is manifest-first: it creates deterministic fixture
ids and known login/scenario aliases, verifies migrations, enforces
non-production guards, and writes/upserts a `seed_manifests` record. It does not
modify locked Stage 2-18 business behavior or directly insert business-domain
fixtures into existing production collections.

## Goals

The seed system should eventually produce deterministic, realistic, coherent V1
datasets for:

- frontend development;
- manual QA;
- integration testing;
- permission/access scenario validation;
- pagination and performance validation;
- release-readiness demonstrations.

It must support SMALL, REALISTIC, and STRESS dataset sizes, but exact quantities
and record catalogs are owned by V1-DATA-02.

## Non-Goals

V1-DATA-01 does not authorize:

- seed implementation;
- package script changes;
- source code changes;
- migration changes;
- tests;
- database writes;
- production data modification;
- OpenAPI regeneration;
- commits to generated artifacts.

The future implementation issue must not silently change locked Stage 2-18
business behavior to make seeding easier.

## Proposed File And Command Shape

V1-DATA-03 should add seed implementation under a clearly non-production path:

```text
apps/backend/src/cli/v1-seed.ts
apps/backend/src/seeds/v1/
```

Recommended internal structure:

```text
src/seeds/v1/
  seed-config.ts
  seed-ids.ts
  seed-clock.ts
  seed-guards.ts
  seed-cleanup.ts
  seed-runner.ts
  seed-manifest.ts
  seed-passwords.ts
  modules/
    identity.seed.ts
    workspace.seed.ts
    permissions.seed.ts
    commercial.seed.ts
    relationships.seed.ts
    training.seed.ts
    workouts.seed.ts
    nutrition.seed.ts
    progress.seed.ts
    checkins.seed.ts
    files.seed.ts
    notifications.seed.ts
    support.seed.ts
    retention-export.seed.ts
```

Recommended package script for V1-DATA-03:

```json
{
  "db:seed:v1": "bun src/cli/v1-seed.ts"
}
```

The seed CLI should follow existing CLI patterns:

- call `loadConfig()`;
- create a container via `createAppContainer(config)`;
- close `container.database` in `finally`;
- return non-zero exit code for guard/validation failures;
- print a concise JSON summary/manifest to stdout;
- avoid interactive prompts.

## Required CLI Options

The future CLI should require explicit intent:

```text
bun src/cli/v1-seed.ts \
  --dataset SMALL \
  --namespace v1-dev \
  --reset-namespace \
  --allow-non-production
```

Recommended options:

| Option | Required | Meaning |
| --- | --- | --- |
| `--dataset SMALL|REALISTIC|STRESS` | yes | Selects dataset scale. Exact quantities belong to V1-DATA-02. |
| `--namespace <name>` | yes | Logical namespace used in stable ids, emails, names, and cleanup markers. |
| `--allow-non-production` | yes | Human-explicit guard acknowledging data writes. |
| `--reset-namespace` | no | Deletes/replaces records owned by the namespace before insert. |
| `--dry-run` | no | Builds manifest and validates guard/dependency plan without writes. |
| `--emit-manifest <path>` | no | Writes known ids/logins/scenario records for QA/frontend use. |
| `--seed <integer|string>` | no | Optional secondary logical seed; default should be stable per namespace/dataset. |

The CLI should reject unknown options rather than silently ignoring them.

## Non-Production Guard

The seed system must fail closed unless all guards pass.

Required guards:

1. `config.env !== 'production'`.
2. `process.env.NODE_ENV !== 'production'`.
3. `--allow-non-production` is present.
4. Database name is allowlisted.
5. Database URI is allowlisted.
6. Namespace is provided and matches a safe pattern.
7. Production-like hostnames, Atlas production clusters, or reserved database
   names are denied.

Recommended database allowlist:

- `config.mongo.dbName` must start with one of:
  - `gym_seed_`
  - `gym_dev_`
  - `gym_qa_`
  - `gym_test_`
- or exactly match an explicitly supplied environment allowlist such as
  `SEED_DATABASE_ALLOWLIST`.

Recommended URI guard:

- allow localhost and known local Docker hostnames by default:
  - `localhost`
  - `127.0.0.1`
  - `host.docker.internal`
  - `mongo`
  - `mongodb`
- require explicit `SEED_URI_ALLOWLIST` for any other host.

The guard should run before any cleanup or insert.

## Seed Namespace

Every seed-owned record should be traceable to a namespace.

Recommended namespace rules:

- Pattern: `^[a-z0-9][a-z0-9_-]{1,40}$`.
- Include namespace in user emails, workspace names, branch names, support
  references, export descriptions, and audit/request metadata where the schema
  allows it.
- Store a seed manifest record in a dedicated collection such as
  `seed_manifests` only in non-production seed databases.
- Do not add seed-only fields to production business documents unless the schema
  already accepts generic metadata and V1-DATA-03 explicitly verifies no behavior
  changes.

Suggested manifest record:

```json
{
  "_id": "deterministicObjectId",
  "namespace": "v1-dev",
  "dataset": "SMALL",
  "seedVersion": "v1",
  "lockedBaseline": "d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "logicalSeed": "v1-dev:SMALL",
  "recordCounts": {},
  "knownIds": {},
  "knownLogins": []
}
```

## Deterministic IDs

Use deterministic ObjectIds derived from namespace, dataset, entity kind, and
logical key.

Recommended helper for V1-DATA-03:

```text
objectId(namespace, dataset, kind, logicalKey) -> ObjectId
```

Implementation approach:

- Hash `v1|namespace|dataset|kind|logicalKey` with SHA-1 or SHA-256.
- Use the first 12 bytes for a MongoDB ObjectId.
- Keep a collision detector in the seed runner.
- Never call `new ObjectId()` for stable seeded business records.
- Runtime-generated records created through application services may receive
  generated ids only where exact ids are not needed by QA; prefer repository
  inserts for records that require known ids.

Known-id groups should include:

- platform support/admin user and membership;
- primary workspaces;
- branches;
- core staff memberships;
- core trainee users/memberships;
- representative relationship ids;
- representative program/session/check-in/file/notification/export ids;
- edge-case ids used by QA scenarios.

## Deterministic Clock

Use a fixed logical clock per dataset.

Recommended base:

```text
seedNow = 2026-01-15T10:00:00.000Z
workspaceTimezone = Africa/Cairo
```

Rules:

- Generate timestamps by named offsets from `seedNow`, not by `new Date()`.
- Keep local-day fixtures across day/week/month/DST boundaries where later
  dataset issues require them.
- Preserve `[from,to)` contracts for analytics ranges.
- Do not create records with impossible ordering, such as `reviewedAt` before
  `submittedAt`.

## Deterministic Credentials

The seed system must not use real personal data or secrets.

Recommended login pattern:

```text
owner.active@seed.v1-dev.local
manager.branch-a@seed.v1-dev.local
trainer.primary@seed.v1-dev.local
assistant.active@seed.v1-dev.local
nutritionist.active@seed.v1-dev.local
trainee.self@seed.v1-dev.local
support.admin@seed.v1-dev.local
```

Recommended password policy:

- Use one documented non-secret password for all seed users, such as
  `SeedPass123!`.
- Hash through `PasswordHasher` during implementation, not with a fake hash.
- Do not print password hashes.
- Never reuse real user emails, phone numbers, or push tokens.
- Mark emails verified where login should work immediately.

If the seed system creates auth sessions/tokens for test automation, those must
be optional and must not be stored in the manifest by default.

## Cleanup And Rerun Strategy

The seed system must be safely rerunnable.

Recommended modes:

| Mode | Behavior |
| --- | --- |
| Dry run | Validate guard, build manifest, calculate counts, write nothing. |
| Upsert | Insert/update seed-owned deterministic records while preserving non-seed data. |
| Reset namespace | Delete seed-owned records for the namespace, then insert fresh records. |
| Isolated database reset | Allowed only when database name passes strict seed/test allowlist. Drops or clears all non-migration collections before seeding. |

Preferred V1 strategy:

1. Require `--reset-namespace` for ordinary frontend/QA reruns.
2. Build a namespace deletion plan from the manifest plus deterministic id
   ranges/known ids.
3. Delete in reverse dependency order.
4. Insert in dependency order.
5. Recalculate/verify counts and referential integrity.

Do not run cleanup against arbitrary database names.

## Use Services Or Direct Inserts

The future implementation should combine services and direct repository/database
inserts deliberately.

Use application services when:

- the flow is idempotent and business side effects are required;
- the service owns complex counters, audit, outbox, or quota behavior;
- frontend/QA needs realistic state from a business command.

Use direct inserts when:

- creating high-volume STRESS data where service invocation would be too slow;
- seeding historical facts not exposed by public commands;
- creating edge states that the product can reach by jobs/workers but would be
  expensive to replay;
- deterministic ids are required and service APIs do not accept ids.

Direct inserts must be based on repository/domain types and migrations, and must
be followed by invariant checks.

Examples from tests:

- Stage 8 tests use service calls for workspace, membership, branch, and
  relationship setup, then direct inserts for commercial support records.
- Stage 16 tests directly insert support policies/sessions and sensitive source
  fixtures for targeted runtime cases.

The seed system should reuse these patterns conceptually but extract them into
deterministic, shared seed builders rather than copying stage-local test helpers.

## Insertion Dependency Order

The seed runner should insert records in this order:

1. Guard validation and optional namespace cleanup.
2. Run migrations or verify required migrations are applied.
3. Seed manifest placeholder with `IN_PROGRESS` state.
4. Permission definitions and system profiles are migration-owned; verify they
   exist rather than duplicating them.
5. Platform users and platform memberships.
6. Platform permission profile assignments and custom grants needed for support
   scenarios.
7. Workspaces.
8. Branches.
9. Workspace users and memberships.
10. Workspace permission profile assignments and explicit grants.
11. Branch assignments.
12. Subscriptions, terms, workspace usage, payments, plan/version fixtures.
13. Leads and owner activation fixtures where needed.
14. Trainee relationships, invitations/referrals, migrations, and staff
    assignments.
15. Training libraries, templates, programs, revisions, assignments, progress.
16. Workout sessions, workout days, personal records, PR events.
17. Nutrition foods, plans, revisions, daily logs/tracking.
18. Progress metric definitions, measurements, photos, health profiles, notes,
    adherence config/tracking.
19. Check-in templates, revisions, assignments, instances, responses/reviews.
20. Files, upload intents, file metadata, documents, generated file intents.
21. Notifications, preferences, deliveries, push devices.
22. Audit events required by QA scenarios.
23. Support policies, access requests, sessions.
24. Export requests/generated artifacts and retention/deletion fixtures.
25. Dashboard/analytics support records are not separate modules; verify source
    data is sufficient for Stage 18 dashboards/analytics.
26. Final manifest update with counts, known ids, known logins, and scenario
    aliases.

## Referential Integrity Checks

After seeding, run invariant checks before reporting success.

Required checks:

- Every workspace-scoped record references an existing workspace.
- Every branch id belongs to the same workspace as its membership/relationship.
- Every workspace membership references an existing user and workspace.
- Every coaching relationship references one trainee user, one trainee
  membership, and one workspace.
- Every relationship id used by training, workout, nutrition, progress,
  check-ins, files/documents, dashboards, analytics, or notifications exists.
- `relationshipId` is never confused with trainee user id.
- Every staff assignment references an active staff membership in the same
  workspace unless intentionally seeding inactive historical state.
- Every permission profile assignment references an active profile in the same
  context/workspace.
- Every subscription references valid terms and workspace usage.
- Every file/document relationship respects workspace, subject, status, and
  classification rules.
- Every notification recipient is an existing user.
- Every support `USER_CONTEXT` session references an active effective membership
  unless deliberately seeding an edge-case terminal/security state.
- Every export/deletion/retention fixture respects lifecycle status and
  generated file constraints.

Failures should abort with a clear error and leave the manifest marked failed
where possible.

## Seed Manifest And Known Records

The future seed command should emit a machine-readable manifest for frontend and
QA.

Recommended output:

```text
apps/backend/.seed-output/v1/<namespace>/<dataset>/manifest.json
```

Manifest sections:

- dataset metadata;
- login identities;
- workspace ids and names;
- branch ids and names;
- membership ids by actor/role;
- relationship ids by scenario;
- edge-case records;
- pagination anchors;
- support session ids;
- notification ids;
- file/document ids;
- export/deletion/retention ids;
- known `expectedVersion` values at seed completion.

Known record aliases should be stable and human-readable:

```json
{
  "relationships": {
    "active.primary_trainer": "64...",
    "nutrition_only": "64...",
    "inactive.ended": "64...",
    "pagination.progress_500_plus": "64..."
  }
}
```

## MongoDB Suitability

The repository uses MongoDB collections, ObjectIds, indexes, and transactions.
The proposed seed architecture is suitable for MongoDB if the implementation:

- runs migrations first or verifies migration status;
- uses deterministic ObjectIds for stable records;
- inserts in dependency order;
- batches high-volume inserts with `insertMany`;
- avoids one giant transaction for STRESS data;
- uses smaller transactions for strongly coupled records that must be atomic;
- relies on existing indexes for uniqueness and pagination behavior;
- avoids expensive worker replay for large historical datasets;
- marks generated/pending lifecycle records carefully so workers do not
  accidentally process unsafe fake storage records unless intended.

STRESS datasets should be designed with bounded memory and batched writes in
V1-DATA-02/V1-DATA-03.

## Non-Production Storage And Files

Seeded files/documents must not require real private user files.

Recommended approach:

- Use fake storage provider behavior in local/test environments where available.
- Seed file metadata and generated file metadata only with safe fake object keys.
- For pending upload states, seed metadata only when workers will not purge or
  mutate it unexpectedly, or explicitly set dates/statuses to safe values.
- Do not generate signed URLs in seed manifests.
- Do not store medical content beyond clearly fake scenario labels.

## Jobs And Workers

Seed data should be stable whether the worker is running or stopped.

Rules:

- Avoid due `PENDING` jobs unless the scenario explicitly needs worker
  processing.
- For due/overdue/expired scenarios, seed terminal or intentionally due records
  with names that make expected worker behavior clear.
- If the dataset includes records for outbox, notification delivery, exports,
  file purge, support expiry, subscription jobs, or retention jobs, mark them as
  scenario fixtures and document whether a worker is expected to process them.

## Idempotency And expectedVersion

Seeded mutation-ready records should include known version fields:

- `version`
- `revision`
- `accessVersion`
- module-specific expected-version fields

Manifest entries for QA should expose these values so tests can exercise:

- successful versioned update;
- stale `expectedVersion` conflict;
- idempotency replay;
- idempotency mismatch.

Do not pre-seed idempotency records for normal frontend flows unless a scenario
explicitly requires replay/mismatch testing.

## Data Privacy

Seed data must be fake and clearly marked.

Rules:

- Emails use `.local` or `.test` style seed domains.
- Phone numbers use reserved/example ranges only.
- Names are realistic but fictional.
- No real client names, real gym names, real medical information, real file
  contents, real push tokens, real provider ids, or real payment references.
- Support references use fake ticket ids such as `SUP-SEED-001`.
- Audit details must not include secrets; repository audit redaction rules still
  apply.

## Relationship With V1-DATA-02 And V1-DATA-03

V1-DATA-01 defines architecture only.

V1-DATA-02 should define:

- exact SMALL/REALISTIC/STRESS quantities;
- specific scenario records and aliases;
- known logins and credentials;
- exact workspace/branch/staff/trainee dataset composition;
- pagination and edge-case records.

V1-DATA-03 should implement:

- CLI/script;
- guards;
- deterministic id helpers;
- dataset builders;
- cleanup/reset;
- manifest emission;
- invariant checks;
- package script;
- seed documentation updates if needed.

## Implementation Risks For V1-DATA-03

Risks to address before implementation:

- Direct inserts can bypass service-maintained counters such as
  `workspace_usage`; seed builders must update counters deliberately.
- Direct inserts can bypass audit/outbox side effects; scenarios must decide
  whether audit/outbox evidence is needed.
- Password hashing through `Bun.password.hash` is intentionally non-deterministic
  at the hash-string level; deterministic login behavior is enough. Do not
  require identical password hash bytes across reruns.
- STRESS data volume can make a single transaction too large.
- Workers can mutate due fixtures if the worker process is running.
- Seed cleanup must not delete non-seed developer data.
- Future schema changes can invalidate direct inserts; invariant checks and
  repository-grounded builders reduce this risk.

## Locked-Stage Protection

- No Stage 2-18 implementation was modified.
- No seed implementation was added.
- No package scripts, source files, migrations, tests, OpenAPI artifacts,
  configuration, generated artifacts, or runtime behavior were changed.
- This document records the architecture for a future non-production seed system
  and explicitly separates design from implementation.
