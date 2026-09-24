# V1 OpenAPI Curation And Metadata Gap Report

Issue: V1-FE-02 / GitHub #7

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Backend root inspected: `apps/backend`

## Source Of Truth

The locked Stage 18 backend implementation is authoritative over OpenAPI,
generated artifacts, previous summaries, and this report. Route files, schemas,
access-control code, services, repositories, tests, migrations, and the V1
documentation artifacts win when they disagree with generated OpenAPI output.

This report classifies OpenAPI curation work only. It does not edit the OpenAPI
generator, route schemas, source code, tests, migrations, or
`docs/apidog/openapi.json`.

## Evidence Used

- `docs/v1/openapi-export-verification.md`
- `scripts/export-openapi.ts`
- `src/api/build-app.ts`
- route files under `src/modules/**`
- schema files under `src/modules/**`
- V1 module, flow, status, and permission documentation under `docs/v1/`

V1-FE-01 established these key facts:

- `pnpm.cmd run openapi:emit` works from `apps/backend`.
- Fresh export represents 233 operations across 197 paths.
- The existing root `docs/apidog/openapi.json` artifact has 188 operations.
- Fresh export adds 45 operations and removes none.
- No missing route was found in freshly generated OpenAPI.
- OpenAPI metadata is incomplete for auth, workspace/support context,
  pagination, errors, idempotency, and `expectedVersion`.

## Curation Decision

OpenAPI should be treated as a generated route/schema baseline, not as the sole
frontend integration contract.

Recommended V1 approach:

1. Keep OpenAPI as the machine-readable operation/schema inventory.
2. Curate it only where metadata can be generated without changing locked runtime
   behavior.
3. Put behavioral contracts that OpenAPI cannot safely encode into V1 frontend
   guides:
   - authentication and session refresh
   - workspace selection and membership behavior
   - permission/scope behavior
   - support session behavior
   - idempotency requirements
   - `expectedVersion` semantics
   - pagination/cursor semantics
   - error/UX handling
   - file and notification lifecycle details

Do not make API implementation changes simply to make OpenAPI look cleaner.

## Gap Categories

| Category | Meaning | V1 treatment |
| --- | --- | --- |
| Documentation-only | Existing implementation already defines behavior, but OpenAPI cannot fully explain it. | Document in V1 frontend guides. |
| Generator metadata improvement | OpenAPI could be improved by exporter/schema metadata without changing API behavior. | Future docs/tooling issue only; not part of V1-FE-02. |
| Possible future implementation issue | Machine-readable accuracy would require source/schema/route changes, new standardized DTO schemas, or new metadata conventions. | Separate authorized implementation issue only. |

## Gap Matrix

### 1. Stale Root Apidog Artifact

Finding:

- Existing root `docs/apidog/openapi.json`: 188 operations.
- Fresh generated output from locked implementation: 233 operations.
- Difference: 45 operations added, 0 removed.

Classification:

- Documentation-only for V1-FE-02.
- Generator/artifact publication task for a future issue if the team wants
  `docs/apidog/openapi.json` updated.

Recommended action:

- Do not edit `docs/apidog/openapi.json` during V1-FE-02.
- V1-FE-03 should warn frontend engineers that the current checked artifact may
  be stale unless regenerated through the locked exporter.
- V1-FE-02 records that fresh export route coverage is complete.

Not a runtime issue:

- No source route is missing from fresh generation.
- No API behavior change is required.

### 2. Authentication Metadata

Finding:

- `src/api/build-app.ts` defines global bearer security.
- Route files use route-level `security: []` for public routes.
- Fresh generation had 221 of 233 operations without operation-level `security`
  override.
- Global bearer security alone does not explain public auth, refresh, cookie
  refresh, restricted sessions, MFA, or step-up behavior.

Classification:

- Documentation-only: auth/session behavior must be explained in V1-FE-03.
- Generator metadata improvement: exporter or route metadata could surface a
  route auth classification such as public, authenticated, platform, workspace,
  support-context-compatible.

Possible future implementation issue:

- Only if the team wants standardized route metadata annotations beyond Fastify
  schema fields. This should not change runtime behavior.

Required V1 documentation:

- How to authenticate.
- How refresh works.
- Which auth routes are public.
- How restricted sessions behave.
- How MFA and step-up affect frontend flows.

### 3. Workspace Context

Finding:

- Workspace context is often visible through `workspaceId` path params.
- OpenAPI does not explain active workspace checks, active membership checks,
  branch assignment narrowing, relationship scope, SELF behavior, or subscription
  entitlement gates.

Classification:

- Documentation-only for workspace selection, active membership, branch,
  relationship, and SELF semantics.
- Generator metadata improvement if route schemas later add custom OpenAPI
  descriptions for workspace context.

Possible future implementation issue:

- Not required for V1 handoff. Runtime behavior already exists.

Required V1 documentation:

- V1-FE-03 API integration guide.
- V1-FE-04 frontend feature/API mapping.
- V1-FE-05 error catalog for `WORKSPACE_INACTIVE`,
  `WORKSPACE_MEMBERSHIP_REQUIRED`, scope denials, entitlement/quota denials.

### 4. Support Session Header

Finding:

- Fresh OpenAPI has 0 operations with an `x-support-session-id` parameter.
- Support context is resolved by `registerSupportAccessContext` before route
  handlers.
- Support behavior varies by `WORKSPACE_SUPPORT` versus `USER_CONTEXT`.
- Support-sensitive permissions are enforced by access-control and service code.

Classification:

- Documentation-only for V1 support behavior.
- Generator metadata improvement if the team later adds a reusable optional
  header parameter and applies it to support-compatible operations.

Possible future implementation issue:

- Not required for V1 handoff unless the team wants machine-readable support
  header metadata in OpenAPI.

Hard rule:

- Do not assume `x-support-session-id` behavior from OpenAPI alone.
- V1-FE-10 must derive the support contract from support access and
  access-control implementation.

### 5. Idempotency Metadata

Finding:

- The exporter adds optional `Idempotency-Key` metadata broadly to mutating routes.
- Fresh export had 155 mutating operations.
- 138 mutating operations had the `IdempotencyKeyHeader` reference.
- This does not equal the actual idempotency contract.
- Actual enforcement comes from route calls to
  `container.idempotency.runInTransaction` or
  `container.idempotency.runInTransactionForActor`.

Classification:

- Documentation-only for real frontend behavior in V1-FE-03.
- Generator metadata issue because current header injection is heuristic.
- Generator metadata improvement if exporter learns the actual route idempotency
  set or routes declare idempotency explicitly.

Possible future implementation issue:

- A route metadata convention could be introduced later, but V1 locked behavior
  must not be changed for this report.

Required V1 documentation:

- List exactly when `Idempotency-Key` is required.
- Document replay behavior, mismatch behavior, failed-attempt behavior, and safe
  retry guidance from `core/idempotency/idempotency.service.ts` and route wrappers.

### 6. `expectedVersion` Metadata

Finding:

- Fresh export includes `expectedVersion` in 86 mutating operation schemas.
- OpenAPI can show the field, but not the semantic owner of the version, the
  target aggregate, the repository compare-and-swap predicate, or conflict
  recovery behavior.

Classification:

- Documentation-only for frontend concurrency behavior.
- Generator metadata improvement if route/body descriptions later describe
  version ownership.

Possible future implementation issue:

- Not required for V1 behavior. A future schema-description pass could add
  descriptions without changing runtime behavior.

Required V1 documentation:

- V1-FE-03 must identify which commands require `expectedVersion`.
- V1-FE-05 must document conflict UX and retry rules.
- State-machine docs remain authoritative for valid lifecycle transitions.

### 7. Pagination And Cursor Metadata

Finding:

- Query schemas expose `cursor`, `limit`, and related fields on many list and
  dashboard routes.
- OpenAPI does not explain cursor encoding, ordering, category-bound cursors,
  filter binding, stable tie-breakers, invalid cursor behavior, or `hasMore`
  semantics.

Classification:

- Documentation-only for V1 frontend contract.
- Generator metadata improvement if route schemas later add richer descriptions.

Possible future implementation issue:

- Not required unless the team wants standardized cursor response schemas across
  all routes.

Required V1 documentation:

- V1-FE-06 must derive pagination from services/repositories, especially
  analytics category cursors, audit cursors, measurement/photo date-id cursors,
  notification cursors, and ObjectId cursors.

### 8. Error Responses

Finding:

- OpenAPI route schemas include some response status entries.
- V1-FE-01 found 17 operations without explicit 4xx response entries.
- Centralized `AppError`, access-control denials, idempotency failures,
  entitlement/quota failures, lifecycle conflicts, support restrictions, and
  retention/deletion restrictions are not fully represented by per-route OpenAPI
  responses.

Classification:

- Documentation-only for V1 error/UX behavior.
- Generator metadata improvement for common reusable error responses.
- Possible future implementation issue if the team wants every route schema to
  enumerate standardized errors.

Required V1 documentation:

- V1-FE-05 must be the frontend-facing error catalog.
- OpenAPI should not be the sole source for retry/user-action decisions.

### 9. Request And Response Examples

Finding:

- Route schemas define shapes, but examples are mostly absent.
- Many responses are declared as `{}` in route schemas, even where services return
  structured DTOs.

Classification:

- Documentation-only for V1 examples in frontend guides.
- Generator metadata improvement if examples can be added without runtime change.
- Possible future implementation issue if accurate response schemas must be added
  to route definitions.

Required V1 documentation:

- V1-FE-03 should include request/response examples for frontend-critical flows.
- V1-FE-04 should map feature screens to API call sequences and response needs.

### 10. Tags And Grouping

Finding:

- `buildApp` declares a tag list.
- Route schemas often declare tags.
- Exporter has a fallback `tagForPath`.
- Tag coverage exists, but grouping is not always the same as frontend feature
  grouping. For example, workspace, platform, billing, support, analytics, and
  relationship screens need feature-oriented grouping beyond OpenAPI tags.

Classification:

- Documentation-only for frontend feature/API mapping.
- Generator metadata improvement if tag normalization is desired.

Possible future implementation issue:

- Not required for V1 behavior.

Required V1 documentation:

- V1-FE-04 is the source for frontend screen/feature mapping, not OpenAPI tags.

### 11. Operation IDs

Finding:

- Exporter creates fallback operation IDs from method and path where operationId
  is missing.
- This provides broad operation IDs, but they are generated rather than curated
  domain names.

Classification:

- Generator metadata improvement.

Possible future implementation issue:

- Only if frontend code generation requires stable curated names. That should be
  a separate tooling/schema issue and must not change API behavior.

Required V1 documentation:

- Frontend docs should reference method/path as the stable contract, not generated
  operation IDs.

### 12. Permission And Scope Metadata

Finding:

- OpenAPI does not expose route permission requirements, branch scope,
  relationship scope, SELF behavior, support-sensitive gates, or entitlement
  overlays.
- Route guards and services are the implementation source.

Classification:

- Documentation-only.
- Generator metadata improvement only if future route annotations are added.

Possible future implementation issue:

- Not required for V1 handoff.

Required V1 documentation:

- `docs/v1/permission-access-matrix.md` is the access-control source.
- V1-FE-03 and V1-FE-04 must link permissions to API usage.

## Recommended Curation Plan

### Documentation-Only Work

Owned by upcoming V1 issues:

- V1-FE-03: frontend API integration guide.
- V1-FE-04: frontend feature/API mapping.
- V1-FE-05: error and UX response catalog.
- V1-FE-06: pagination and cursor contract.
- V1-FE-07: time/date/timezone and analytics bucket contract.
- V1-FE-08: file/document integration guide.
- V1-FE-09: notification integration guide.
- V1-FE-10: support access frontend guide.

Documentation-only gaps:

- auth/session/restricted-session behavior
- workspace/member/branch/relationship context
- support `x-support-session-id` behavior
- idempotency route-by-route requirements
- `expectedVersion` ownership and conflict UX
- pagination cursor semantics
- standardized frontend error actions
- examples and screen sequences
- permission/scope/entitlement overlays

### Generator Metadata Improvements

These are not authorized by V1-FE-02, but they are viable future tooling issues:

- Add optional reusable `x-support-session-id` header metadata where appropriate.
- Replace broad `Idempotency-Key` heuristic with route-declared idempotency
  metadata.
- Add reusable response components for common errors.
- Add route descriptions for workspace, support, entitlement, and scope behavior.
- Add schema descriptions for `expectedVersion`.
- Add operation descriptions and examples.
- Normalize operation IDs if frontend code generation depends on them.
- Add pagination response component descriptions.

### Possible Future Implementation Issues

These would require explicit authorization and should not be bundled into
documentation issues:

- Add complete response DTO schemas where routes currently use `{}`.
- Add route-level metadata conventions for permissions, idempotency, support
  compatibility, and frontend grouping.
- Add schema examples directly into route schema definitions.
- Change artifact publication workflow for `docs/apidog/openapi.json`.

None of these are required to preserve locked V1 backend behavior.

## Public Contract Boundary

OpenAPI can safely be used for:

- route inventory after running the locked exporter
- methods and paths
- path/query/body schema shapes where route schemas are explicit
- broad tags and generated operation IDs
- bearer security scheme existence

OpenAPI must not be the sole source for:

- whether authentication is required
- workspace selection rules
- support session behavior
- permission/scope behavior
- entitlement/quota gates
- idempotency requirements
- `expectedVersion` semantics
- cursor semantics
- error UX and retry decisions
- state transition eligibility

## Locked-Stage Protection

- No Stage 2-18 implementation was modified.
- No OpenAPI generator code was changed.
- No route schemas were changed.
- No root `docs/apidog/openapi.json` artifact was regenerated or committed.
- No tests, migrations, services, permissions, configuration, or source code were
  changed.
- Discrepancies are documented rather than fixed in locked implementation.
