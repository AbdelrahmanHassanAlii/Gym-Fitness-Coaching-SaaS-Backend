# V1 OpenAPI Export Verification

Issue: V1-FE-01 / GitHub #6

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Backend root inspected: `apps/backend`

## Source Of Truth

The locked Stage 18 backend implementation is authoritative over generated
OpenAPI artifacts, previous summaries, and this report. Route files, schemas,
access-control code, services, tests, and migrations win when they disagree with
OpenAPI output.

This issue verifies export behavior and classifies drift/gaps. It does not change
API implementation, route schemas, permission behavior, tests, migrations, or the
checked-in Apidog artifact.

## Exporter

| Item | Value |
| --- | --- |
| Package script | `openapi:emit` |
| Command used | `pnpm.cmd run openapi:emit` from `apps/backend` |
| Script | `scripts/export-openapi.ts` |
| App builder | `src/api/build-app.ts` |
| Swagger plugin | `@fastify/swagger` registered in `buildApp` |
| Output path | `D:/Hasssan/Edara/Gym & Fitness Coaching SaaS/docs/apidog/openapi.json` |
| Variable output path | `D:/Hasssan/Edara/Gym & Fitness Coaching SaaS/docs/apidog/global-variables.example.json` |

The exporter builds the Fastify app with a stub container, calls `app.ready()`,
calls `app.swagger()`, normalizes the document, then writes the root-level Apidog
files.

Important implementation detail: `apps/backend` is the backend git repository
root, but the Apidog files live outside that git root under the workspace root
`docs/apidog`. For this verification, the current Apidog files were snapshotted,
the exporter was run, generated output was inspected, and the original Apidog
files were restored.

## Export Run

The exporter completed successfully and printed:

```text
Wrote 233 endpoints to D:\Hasssan\Edara\Gym & Fitness Coaching SaaS\docs\apidog\openapi.json
Wrote Apidog variable examples to D:\Hasssan\Edara\Gym & Fitness Coaching SaaS\docs\apidog\global-variables.example.json
```

Artifact hashes:

| Artifact | Before / restored SHA-256 | Generated SHA-256 |
| --- | --- | --- |
| `docs/apidog/openapi.json` | `DF2364270CB566DB313C18ED67C09DD033A94850773498B3D197E5AADA1CB014` | `864CF57F25950CB8DDF97F58F3CD3C678DD535C884F35A5ADB324FDC166BF2C2` |
| `docs/apidog/global-variables.example.json` | `52D23803101922B7528A8DBA4D03A6648EDD63093EF827D7ED22EF3630D40C49` | regenerated during export, then restored |

No regenerated OpenAPI or Apidog variable artifact is committed by this issue.

## Route Coverage

Generated OpenAPI operation count:

| Metric | Count |
| --- | ---: |
| Paths | 197 |
| Operations | 233 |
| `GET` operations | 78 |
| `POST` operations | 121 |
| `PUT` operations | 10 |
| `PATCH` operations | 17 |
| `DELETE` operations | 7 |

Operations by OpenAPI tag:

| Tag | Count |
| --- | ---: |
| Analytics | 7 |
| Audit | 2 |
| Auth | 17 |
| Branches | 8 |
| Check-Ins | 13 |
| Exports | 4 |
| Files | 9 |
| Health | 2 |
| Invitations | 3 |
| Leads | 9 |
| Me | 10 |
| Memberships | 5 |
| Nutrition | 15 |
| Owner activations | 1 |
| Payments | 6 |
| Permissions | 16 |
| Platform | 5 |
| Progress | 17 |
| Retention | 5 |
| Subscriptions | 15 |
| Support | 11 |
| Trainees | 18 |
| Training | 21 |
| Workouts | 11 |
| Workspaces | 3 |

Source route check:

- Static source search found 228 `app.get/post/put/patch/delete` route-registration
  call sites under `src/api` and `src/modules`.
- Generated OpenAPI has 233 operations.
- The 5-operation difference is accounted for by loop-registered routes:
  - `src/modules/workspaces/workspace.routes.ts`: platform membership
    `suspend`, `reactivate`, `end` routes.
  - `src/modules/subscriptions/subscription.routes.ts`: subscription
    `upgrade`, `downgrade` routes.

Result: every currently registered route was represented in the freshly generated
OpenAPI output. No missing route was found in the generated output.

## Checked-In Artifact Drift

The root checked-in-style Apidog artifact present before this verification had:

- 188 operations
- generated SHA-256
  `DF2364270CB566DB313C18ED67C09DD033A94850773498B3D197E5AADA1CB014`

Fresh generation from the locked implementation had:

- 233 operations
- generated SHA-256
  `864CF57F25950CB8DDF97F58F3CD3C678DD535C884F35A5ADB324FDC166BF2C2`

Classification: expected artifact drift. The existing root Apidog artifact is
stale relative to the locked implementation. No route was removed by fresh
generation; 45 operations are newly represented.

Operations present in fresh generation but absent from the existing artifact:

```text
DELETE /api/v1/me/push-devices/{deviceId}
DELETE /api/v1/workspaces/{workspaceId}/files/{fileId}
DELETE /api/v1/workspaces/{workspaceId}/relationships/{relationshipId}/documents/{documentId}
GET /api/v1/me/notification-preferences
GET /api/v1/me/notifications
GET /api/v1/platform/audit
GET /api/v1/platform/support/policies
GET /api/v1/platform/support/policies/{policyId}
GET /api/v1/platform/support/sessions
GET /api/v1/platform/support/sessions/{sessionId}
GET /api/v1/platform/workspace-deletions
GET /api/v1/platform/workspace-deletions/{deletionId}
GET /api/v1/workspaces/{workspaceId}/audit
GET /api/v1/workspaces/{workspaceId}/dashboard/gym
GET /api/v1/workspaces/{workspaceId}/dashboard/trainer
GET /api/v1/workspaces/{workspaceId}/exports
GET /api/v1/workspaces/{workspaceId}/exports/{exportId}
GET /api/v1/workspaces/{workspaceId}/relationships/{relationshipId}/analytics/adherence
GET /api/v1/workspaces/{workspaceId}/relationships/{relationshipId}/analytics/nutrition
GET /api/v1/workspaces/{workspaceId}/relationships/{relationshipId}/analytics/progress
GET /api/v1/workspaces/{workspaceId}/relationships/{relationshipId}/analytics/training
GET /api/v1/workspaces/{workspaceId}/relationships/{relationshipId}/dashboard
GET /api/v1/workspaces/{workspaceId}/relationships/{relationshipId}/documents
GET /api/v1/workspaces/{workspaceId}/relationships/{relationshipId}/documents/{documentId}
PATCH /api/v1/platform/support/policies/{policyId}
POST /api/v1/me/notifications/{notificationId}/read
POST /api/v1/me/notifications/read-all
POST /api/v1/me/push-devices
POST /api/v1/platform/support/access-requests
POST /api/v1/platform/support/policies
POST /api/v1/platform/support/policies/{policyId}/archive
POST /api/v1/platform/support/policies/{policyId}/disable
POST /api/v1/platform/support/sessions/{sessionId}/end
POST /api/v1/platform/support/sessions/{sessionId}/revoke
POST /api/v1/platform/workspace-deletions/{deletionId}/approve
POST /api/v1/platform/workspace-deletions/{deletionId}/cancel
POST /api/v1/platform/workspace-deletions/{deletionId}/postpone
POST /api/v1/workspaces/{workspaceId}/exports
POST /api/v1/workspaces/{workspaceId}/exports/{exportId}/download-url
POST /api/v1/workspaces/{workspaceId}/files/{fileId}/download-url
POST /api/v1/workspaces/{workspaceId}/files/{fileId}/restore
POST /api/v1/workspaces/{workspaceId}/files/upload-intents
POST /api/v1/workspaces/{workspaceId}/files/upload-intents/{uploadIntentId}/confirm
POST /api/v1/workspaces/{workspaceId}/relationships/{relationshipId}/documents
PUT /api/v1/me/notification-preferences
```

The drift corresponds to later V1 modules such as files/documents, exports,
notifications, support access, audit, retention/deletion, and analytics.

## Metadata Gap Classification

### Authentication Metadata

Classification: documentation metadata drift / OpenAPI metadata gap.

`buildApp` defines global bearer security. In the generated document, 221 of 233
operations do not define an operation-level `security` override. Public and
partially public auth/lead/activation routes therefore require frontend
documentation to derive actual auth behavior from route pre-handlers and service
code, not from global OpenAPI security alone.

### Workspace Context

Classification: documentation metadata gap.

Workspace context is encoded structurally in path parameters such as
`workspaceId`, but OpenAPI does not explain workspace selection behavior,
membership requirements, active workspace restrictions, support effective actors,
or branch/relationship scope semantics. V1-FE-03 must document these from route
guards, services, and the V1 permission matrix.

### Support Header

Classification: documentation metadata gap.

The generated document has 0 operations with an `x-support-session-id` parameter.
Support context is implemented by the global support access pre-handler and
support service behavior, not by per-route OpenAPI metadata. Frontend support
session behavior must be documented from implementation evidence.

### Pagination Metadata

Classification: partial schema coverage / frontend contract gap.

Query schemas expose common fields such as `cursor` and `limit` on many list
routes, but OpenAPI does not explain cursor formats, category-bound cursors,
stable ordering, filter binding, invalid cursor errors, or `hasMore` semantics.
V1-FE-06 must derive the pagination contract from services/repositories rather
than treating OpenAPI as sufficient.

### Error Responses

Classification: partial schema coverage / documentation metadata gap.

OpenAPI includes route-local response status declarations, but error coverage is
not complete or uniform. Fresh generation found 17 operations without an explicit
4xx response entry. Centralized errors, permission denials, idempotency errors,
expected-version conflicts, entitlement/quota errors, support denials, and
retention/deletion restrictions require a separate frontend error catalog.

### Idempotency

Classification: known generator metadata issue.

The exporter adds optional `Idempotency-Key` metadata broadly to mutating routes.
Fresh generation found:

- 155 mutating operations
- 138 mutating operations with the `IdempotencyKeyHeader` reference
- 17 mutating operations without the header reference

This does not equal the real idempotency contract. Actual idempotency is enforced
only where routes call `container.idempotency.runInTransaction` or
`runInTransactionForActor` through route-local wrappers. Frontend documentation
must derive idempotency requirements from route/service evidence, not blindly from
OpenAPI.

### `expectedVersion`

Classification: partial schema coverage / frontend contract gap.

Fresh generation includes `expectedVersion` in 86 mutating operation schemas.
However, OpenAPI does not explain which version field is being compared, which
repository/version counter owns it, allowed retry behavior, or lifecycle-specific
conflict semantics. V1-FE-03 and V1-FE-05 must document `expectedVersion` from
actual route body schemas, services, and repository CAS checks.

## Drift Summary

| Category | Finding | Classification |
| --- | --- | --- |
| Export command | `pnpm.cmd run openapi:emit` works and generates 233 endpoints. | Confirmed |
| Current root artifact | Existing `docs/apidog/openapi.json` has 188 operations. | Expected artifact drift |
| Fresh generated route coverage | 233 operations represented; no generated-output route gap found. | Confirmed |
| Missing in existing artifact | 45 operations absent from current artifact. | Expected artifact drift |
| Auth metadata | Global bearer security does not fully describe public/auth behavior. | Documentation metadata gap |
| Support metadata | `x-support-session-id` absent from generated operation parameters. | Documentation metadata gap |
| Idempotency metadata | Optional header added broadly to mutating routes. | Known generator metadata issue |
| Pagination metadata | Cursor fields exist but semantics are not documented by OpenAPI. | Frontend contract gap |
| Error metadata | Error responses are route-local and incomplete for frontend UX. | Frontend contract gap |
| `expectedVersion` metadata | Field appears in schemas but CAS semantics are not explained. | Frontend contract gap |

## Follow-Up Requirements

- V1-FE-02 should decide whether to regenerate/curate the Apidog artifact, improve
  metadata, or keep OpenAPI as a generated baseline plus separate frontend guides.
- V1-FE-03 must not rely on OpenAPI alone for authentication, workspace context,
  support context, idempotency, `expectedVersion`, permissions, or lifecycle
  errors.
- V1-FE-05 must build the frontend error/UX contract from route/service errors.
- V1-FE-06 must document pagination from service/repository cursor behavior.
- V1-FE-10 must document support access from `support-access` and
  access-control implementation, because OpenAPI does not encode the support
  session contract.

## Locked-Stage Protection

- No Stage 2-18 implementation was modified.
- No routes, schemas, services, permissions, migrations, tests, or configuration
  were changed.
- The root Apidog files were restored after verification and are not committed by
  this issue.
- This report documents discrepancies instead of changing API behavior or
  generated output.
