# V1 Pagination and Cursor Contract

Issue: V1-FE-06 / GitHub #11

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Backend root inspected: `apps/backend`

## Source Of Truth

The locked Stage 18 backend implementation is authoritative over generated
OpenAPI, previous summaries, and this document. Route files, schemas, services,
repositories, tests, migrations, and existing V1 docs win when they disagree with
generated artifacts.

This document is frontend-facing. Cursors must be treated as opaque tokens even
when this contract describes their conceptual ordering. Do not decode, construct,
or mutate cursor values in frontend code.

## Evidence Used

- `src/modules/**/**.routes.ts`
- `src/modules/**/**.schemas.ts`
- `src/modules/**/**.service.ts`
- `src/modules/**/**.repository.ts`
- `docs/v1/frontend-api-integration-guide.md`
- `docs/v1/frontend-feature-api-map.md`
- `docs/v1/frontend-error-ux-catalog.md`

## Global Rules

- A continuation request must reuse the same route, path parameters, and filters
  that produced the cursor.
- Changing filters, category, range, branch, relationship, unread flag, metric,
  or sort context invalidates the previous cursor.
- The frontend must not decode cursor strings. Store and replay them only.
- Invalid cursors usually return `CURSOR_INVALID` with HTTP 422. Analytics uses
  more specific cursor codes for some sections, such as
  `PROGRESS_CURSOR_INVALID`, `ATTENTION_CURSOR_INVALID`, and
  `ACTIVITY_CURSOR_INVALID`.
- Reset invalid cursor failures by clearing the cursor and loading the first
  page with the intended filters.
- `limit` is bounded by route schema or service code. Values above the maximum
  are rejected by schema or clamped by service depending route.
- Some implemented list responses expose `nextCursor` without reliable
  `hasMore`. For those routes, stop when the returned item count is lower than
  requested limit or when a follow-up page returns no data.

## Response Shape Families

| Family | Shape | Frontend notes |
| --- | --- | --- |
| Standard meta page | `{ data: [...], meta: { nextCursor, hasMore } }` | Use `hasMore` when present. Continue with `meta.nextCursor`. |
| Page object | `{ data: [...], page: { nextCursor } }` | Used by notifications. No `hasMore`; continue only while `nextCursor` is non-null. |
| Page info object | `{ data: [...], pageInfo: { nextCursor, hasMore } }` | Used by documents. Use `pageInfo`. |
| Bare page | `{ data: [...], nextCursor }` or `{ items: [...], nextCursor }` | Used by several domain lists. No `hasMore`; use returned cursor only. |
| Embedded section page | Section object contains `items`, `hasMore`, `nextCursor`, and sometimes `count`. | Used by dashboard/analytics categories. Cursor is bound to the section/category. |
| Fixed list | `{ data: [...], meta: { nextCursor: null, hasMore: false } }` or array-like DTO | Route returns a bounded list and is not cursor-paginated. |

## Cursor Types

| Cursor type | Conceptual ordering | Frontend treatment |
| --- | --- | --- |
| ObjectId cursor | Continue after the last returned id. | Opaque string; usually route query field is `cursor` or `after`. |
| ISO timestamp cursor | Continue after/before a timestamp. | Opaque string; used by leads. Keep filters stable because id tie-breaker is not part of the public cursor. |
| ISO timestamp plus id cursor | Continue by timestamp with id tie-breaker. | Opaque string; used by progress/check-ins/files documents. |
| Base64url JSON cursor | Encodes timestamp/id or name/id ordering. | Opaque string; used by audit, notifications, exports, analytics sections. |
| Category-bound cursor | Cursor includes or is valid only for one category. | Store per category. Do not reuse across dashboard categories. |

## Paginated API Inventory

### Leads

| Route | Cursor input | Output | Limit | Ordering/tie-breaker | Filters bound to cursor | Invalid cursor |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/platform/leads` | `cursor` as ISO timestamp | `meta.nextCursor`, `meta.hasMore` | default 25, max 100 | `createdAt`; no frontend-visible id tie-breaker | `status`, `customerInterest` | Schema requires date-time format; malformed cursor is request validation. |

Frontend note: because the cursor is a timestamp only, keep the same filters and
avoid merging pages from different filters.

### Notifications

| Route | Cursor input | Output | Limit | Ordering/tie-breaker | Filters bound to cursor | Invalid cursor |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/me/notifications` | `cursor` | `page.nextCursor` | default 50, max 100 | newest first by `createdAt`, `_id` tie-breaker | `unread` | `CURSOR_INVALID` 422 |

Frontend note: response does not include `hasMore`. Continue only when
`page.nextCursor` is non-null.

### Audit

| Route | Cursor input | Output | Limit | Ordering/tie-breaker | Filters bound to cursor | Invalid cursor |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/audit` | `cursor` | `meta.nextCursor`, `meta.hasMore` | default 50, max 100 | newest first by `occurredAt`, `_id` tie-breaker | audit filters, workspace id, sensitive visibility | `CURSOR_INVALID` 422 |
| `GET /api/v1/platform/audit` | `cursor` | `meta.nextCursor`, `meta.hasMore` | default 50, max 100 | newest first by `occurredAt`, `_id` tie-breaker | audit filters, sensitive visibility | `CURSOR_INVALID` 422 |

### Training

These routes use ObjectId continuation. Response shape is
`{ data, meta: { nextCursor, hasMore: false } }`; implementation does not fetch
`limit + 1`, so `hasMore` is always false even when another page may exist.

| Route | Cursor input | Limit | Ordering/tie-breaker | Filters bound to cursor | Invalid cursor |
| --- | --- | --- | --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/exercises` | `cursor` | max 100 by schema | repository list order after `_id` | `includeArchived`, workspace, actor private/gym visibility | `CURSOR_INVALID` |
| `GET /api/v1/platform/exercises` | `cursor` | max 100 by schema | repository list order after `_id` | `includeArchived`, platform/system scope | `CURSOR_INVALID` |
| `GET /api/v1/workspaces/:workspaceId/program-templates` | `cursor` | max 100 by schema | repository list order after `_id` | `includeArchived`, workspace | `CURSOR_INVALID` |
| `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/programs` | `cursor` | max 100 by schema | repository list order after `_id` | workspace, relationship | `CURSOR_INVALID` |

Frontend continuation rule: request next pages while `nextCursor` exists and the
previous page returned `limit` items; stop on an empty page or a short page.

### Workouts And Personal Records

These routes use ObjectId continuation and return
`{ data, meta: { nextCursor, hasMore: false } }`.

| Route | Cursor input | Limit | Ordering/tie-breaker | Filters bound to cursor | Invalid cursor |
| --- | --- | --- | --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/workouts` | `cursor` | default 50; schema max 100 | repository list order after `_id` | workspace, relationship | `CURSOR_INVALID` |
| `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/personal-records` | `cursor` | default 50; schema max 100 | repository list order after `_id` | workspace, relationship | `CURSOR_INVALID` |
| `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/personal-record-events` | `cursor` | default 50; schema max 100 | repository list order after `_id` | workspace, relationship | `CURSOR_INVALID` |

### Nutrition

These routes use ObjectId continuation. Response shape is
`{ data, nextCursor }`; there is no `hasMore`.

| Route | Cursor input | Limit | Ordering/tie-breaker | Filters bound to cursor | Invalid cursor |
| --- | --- | --- | --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/foods` | `cursor` | max 100 by schema | repository list order after `_id` | `includeArchived`, workspace, actor private/gym visibility | `CURSOR_INVALID` |
| `GET /api/v1/platform/foods` | `cursor` | max 100 by schema | repository list order after `_id` | `includeArchived`, platform/system scope | `CURSOR_INVALID` |
| `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/nutrition-plans` | `cursor` | max 100 by schema | repository list order after `_id` | workspace, relationship | `CURSOR_INVALID` |

### Progress, Photos, Notes, And Metric Definitions

| Route | Cursor input | Output | Limit | Ordering/tie-breaker | Filters bound to cursor | Invalid cursor |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/metric-definitions` | `cursor` ObjectId | bare `nextCursor` | max 100 by schema | repository list order after `_id` | `includeArchived`, workspace, actor visibility | `CURSOR_INVALID` |
| `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/measurements` | `cursor` timestamp/id | bare `nextCursor` | max 100 by schema | measurement date with `_id` tie-breaker | `metricDefinitionId`, workspace, relationship | `CURSOR_INVALID` |
| `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/progress-photos` | `cursor` timestamp/id | bare `nextCursor` | max 100 by schema | captured date with `_id` tie-breaker | workspace, relationship, actor visibility | `CURSOR_INVALID` |
| `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/notes` | `cursor` ObjectId | bare `nextCursor` | max 100 by schema | repository list order after `_id` | workspace, relationship, actor visibility | `CURSOR_INVALID` |

No route in this group returns `hasMore`. Continue using the general short-page
rule.

### Check-ins

| Route | Cursor input | Output | Limit | Ordering/tie-breaker | Filters bound to cursor | Invalid cursor |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/checkin-templates` | `cursor` ObjectId | bare `nextCursor` | max 100 by schema | repository list order after `_id` | `includeArchived`, workspace | `CURSOR_INVALID` |
| `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkin-assignments` | `cursor` ObjectId | bare `nextCursor` | max 100 by schema | repository list order after `_id` | workspace, relationship | `CURSOR_INVALID` |
| `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/checkins` | `cursor` dueAt/id | bare `nextCursor` | max 100 by schema | due date with `_id` tie-breaker | workspace, relationship | `CURSOR_INVALID` |

### Files And Documents

| Route | Cursor input | Output | Limit | Ordering/tie-breaker | Filters bound to cursor | Invalid cursor |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents` | `cursor` createdAt/id | `pageInfo.nextCursor`, `pageInfo.hasMore` | request default 50; schema max 100 | created date with `_id` tie-breaker | workspace, relationship, actor visibility | `CURSOR_INVALID` |

Implementation note: `pageInfo.hasMore` is computed as `documents.length >= 50`,
not against the requested limit. Treat `nextCursor` as the primary continuation
signal.

### Exports

| Route | Cursor input | Output | Limit | Ordering/tie-breaker | Filters bound to cursor | Invalid cursor |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/exports` | `cursor` | `meta.nextCursor`, `meta.hasMore` | default 50, max 100 | requested date with `_id` tie-breaker | workspace id | malformed cursor can throw decode error; frontend should reset on 400/500-style failure and report correlation id |

Implementation note: `meta.hasMore` is currently always false even when
`meta.nextCursor` is present. Use `nextCursor` as the continuation signal.

### Retention / Deletion

| Route | Cursor input | Output | Limit | Ordering/tie-breaker | Filters bound to cursor | Invalid cursor |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/platform/workspace-deletions` | `after` ObjectId | `nextCursor` | default 50, max 100 | repository list order after `_id` | platform deletion list | invalid `after` is treated as `WORKSPACE_DELETION_NOT_FOUND` |

This route uses `after`, not `cursor`.

### Analytics And Dashboards

Analytics embeds paginated sections inside dashboard/analytics responses. These
cursors are category-bound and must be stored independently per category.

| Route/section | Cursor input | Output | Limit | Ordering/tie-breaker | Category/filter binding | Invalid cursor |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/dashboard/gym` branch breakdown | `branchCursor`, `branchLimit` | `branchBreakdown.nextCursor`, `branchBreakdown.hasMore` | default 25, max 100 | branch name with `_id` tie-breaker | workspace, optional `branchId`; `branchCursor` is not allowed when `branchId` is set | `CURSOR_INVALID`; `BRANCH_CURSOR_NOT_ALLOWED` |
| Gym/trainer dashboard `needsAttention` | `attentionCategory`, `attentionCursor`, `attentionLimit` | category page `nextCursor`, `hasMore`, optional `count` | default 5, max 20 | category-specific: check-ins use due date/id; relationship categories use ObjectId | `attentionCategory` is required when sending `attentionCursor` | `ATTENTION_CURSOR_INVALID`, `ATTENTION_CATEGORY_INVALID`, `ATTENTION_CURSOR_REQUIRES_CATEGORY` |
| Gym dashboard `recentActivity` | `activityCategory`, `activityCursor`, `activityLimit` | category page `nextCursor`, `hasMore` | default 5, max 20 | event timestamp with `_id` tie-breaker | owner-only pure workspace scope; `activityCategory` is required when sending `activityCursor` | `ACTIVITY_CURSOR_INVALID`, `ACTIVITY_CATEGORY_INVALID`, `ACTIVITY_CURSOR_REQUIRES_CATEGORY`, `RECENT_ACTIVITY_NOT_ALLOWED` |
| `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/analytics/progress` points | `cursor`, `limit` | `page.nextCursor`, `page.hasMore` | default 100, max 500 | measured date with `_id` tie-breaker | relationship, metric, `from`, `to`, `granularity` | `PROGRESS_CURSOR_INVALID` |

Non-progress relationship analytics routes use date ranges and buckets but do not
currently expose cursor pagination.

## Fixed Or Non-Cursor Lists

These routes are list-like but not cursor-paginated in the locked implementation:

| Route/family | Behavior |
| --- | --- |
| `GET /api/v1/workspaces/:workspaceId/relationships` | Returns `{ data, meta: { nextCursor: null, hasMore: false } }`; no cursor query schema. |
| Workspace/platform staff and branch lists | No cursor query contract in route schemas. |
| Subscription plan/payment lists | Return fixed/bounded lists with `nextCursor: null`, `hasMore: false` where wrapped. |
| Support policies/sessions | Repository uses fixed limits; no frontend cursor contract. |
| Current/detail routes such as current workout, health profile, dashboards without category cursor, relationship dashboard | Not list pagination routes. |

## Frontend Continuation Algorithm

1. Keep one pagination state object per route plus filter set.
2. For category-bound dashboard sections, keep one pagination state per category.
3. Send the route's documented cursor field (`cursor`, `after`,
   `branchCursor`, `attentionCursor`, or `activityCursor`).
4. Append results only if the request used the same filters/range/category.
5. Stop when the documented `hasMore` is false and there is no `nextCursor`.
6. For routes with no reliable `hasMore`, continue only if `nextCursor` exists
   and the last page length was at least the requested limit.
7. On `CURSOR_INVALID` or category-specific cursor invalid errors, discard the
   cursor and reload the first page. Do not reuse a cursor after a filter change.

## Locked-Stage Protection

- No Stage 2-18 implementation was modified.
- No cursor implementation, routes, schemas, services, repositories, migrations,
  tests, OpenAPI artifacts, configuration, generated artifacts, or runtime
  behavior were changed.
- This contract documents existing behavior only, including non-uniform response
  shapes and known `hasMore` limitations.
