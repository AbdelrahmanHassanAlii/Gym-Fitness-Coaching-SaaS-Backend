# V1 Time, Date, Timezone, and Analytics Bucket Contract

Issue: V1-FE-07 / GitHub #12

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Backend root inspected: `apps/backend`

## Source Of Truth

The locked Stage 18 backend implementation is authoritative over generated
OpenAPI, previous summaries, and this document. Route files, schemas, services,
repositories, tests, migrations, and existing V1 docs win when they disagree with
generated artifacts.

This document is frontend-facing. It documents implemented V1 behavior for
dates, timestamps, timezones, date ranges, local calendar days, and analytics
buckets. It does not change analytics logic, timezone logic, schemas, routes,
services, tests, migrations, OpenAPI, or runtime behavior.

## Evidence Used

- `src/modules/analytics/analytics.routes.ts`
- `src/modules/analytics/analytics.schemas.ts`
- `src/modules/analytics/analytics.service.ts`
- `src/modules/analytics/analytics.repository.ts`
- `src/modules/progress/progress.schemas.ts`
- `src/modules/progress/progress.service.ts`
- `src/modules/checkins/checkin.schemas.ts`
- `src/modules/checkins/checkin.service.ts`
- `src/modules/workspaces/workspace.schemas.ts`
- `src/modules/workspaces/workspace.service.ts`
- `test/stage18-dashboards-analytics.test.ts`
- `test/stage12-checkins.test.ts`
- `test/stage11-progress.test.ts`
- `docs/v1/frontend-api-integration-guide.md`
- `docs/v1/frontend-feature-api-map.md`
- `docs/v1/frontend-error-ux-catalog.md`
- `docs/v1/frontend-pagination-cursor-contract.md`

## Global Frontend Rules

- Treat API timestamps as instants. The backend serializes most instant fields
  with `Date#toISOString()`, so frontend code should expect UTC ISO strings such
  as `2026-03-08T05:00:00.000Z`.
- Treat date-only values as local calendar dates in `YYYY-MM-DD` format only
  where a route explicitly documents date-only behavior.
- Analytics `from` and `to` query values may be either date-only strings or
  timezone-qualified instant strings. Naive date-time strings are rejected.
- Analytics ranges are half-open: events at `from` are included and events at
  `to` are excluded.
- Analytics and dashboards resolve calendar boundaries using the workspace
  timezone stored on the workspace, not the authenticated user's timezone.
- Branches can store a timezone, but Stage 18 analytics uses workspace timezone
  for range parsing and buckets. Do not derive analytics buckets from branch
  timezone.
- Support headers and permissions do not change time semantics. A support
  session sees the same workspace-local calendar behavior as the effective
  tenant actor.

## Timestamp Contract

| Area | Frontend contract |
| --- | --- |
| Response instants | Backend DTOs usually return ISO UTC strings for instants, for example `generatedAt`, `startedAt`, `completedAt`, `measuredAt`, `submittedAt`, `reviewedAt`, `periodStartAt`, `periodEndAt`, `opensAt`, `dueAt`, `from`, and `to`. |
| Request instants | Schemas often accept strings and service code parses them with `new Date(...)`. Send ISO strings with `Z` or an explicit numeric offset for portable behavior. |
| Naive date-times in analytics | Analytics rejects date-time strings without `Z` or `+/-HH:mm` using `FROM_TIMEZONE_REQUIRED` or `TO_TIMEZONE_REQUIRED`. |
| Date display | Convert instants to the viewer's desired display timezone only in UI. Do not send locale-formatted dates back to the API. |
| Sorting | Timestamp-based pages use backend-defined timestamp ordering. Do not re-sort pages client-side before storing cursors. |

## Workspace Timezone

Workspace creation and update accept a `timezone` string. Stage 18 analytics
validates the stored workspace timezone with `Intl.DateTimeFormat`. If the
workspace timezone is missing or invalid, analytics/dashboard reads fail with
`WORKSPACE_TIMEZONE_INVALID`.

The workspace timezone is used by:

- dashboard default ranges;
- relationship analytics default ranges;
- date-only analytics `from` and `to` parsing;
- day, week, and month analytics bucket boundaries;
- daily tracking trainee edit window calculation through the Progress module.

The check-in module uses each check-in assignment recurrence timezone, which may
be different from the workspace timezone. Assignment recurrence timezones are
also validated as IANA timezones and invalid values fail with
`CHECKIN_TIMEZONE_INVALID`.

## Date-Only Values

| Context | Format | Meaning | Backend behavior |
| --- | --- | --- | --- |
| Analytics `from` / `to` | `YYYY-MM-DD` | Local midnight in the workspace timezone. | Converted to the corresponding UTC instant before querying. |
| Daily tracking path `:localDate` | `YYYY-MM-DD` | A workspace-local adherence day. | Invalid formats or impossible dates fail with `DAILY_TRACKING_DATE_INVALID`. |
| Daily tracking response `localDate` | `YYYY-MM-DD` | The stored tracking day. | Returned with `timezoneAtEntry`, the workspace timezone at write time. |
| Daily tracking trainee edit window | `YYYY-MM-DD` | Today or yesterday in current workspace timezone. | Trainee self edits outside today/yesterday fail with `DAILY_TRACKING_EDIT_WINDOW_EXPIRED`. |
| Check-in period key | `YYYY-Www` | ISO week key in the assignment recurrence timezone. | Generated server-side; frontend should display it, not construct it. |

Frontend code should not infer date-only semantics for arbitrary string fields.
Use date-only input only for routes documented as date-only capable.

## Analytics Range Contract

Analytics routes:

- `GET /api/v1/workspaces/:workspaceId/dashboard/trainer`
- `GET /api/v1/workspaces/:workspaceId/dashboard/gym`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/dashboard`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/analytics/training`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/analytics/progress`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/analytics/nutrition`
- `GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/analytics/adherence`

Dashboard routes do not expose `from` and `to` query parameters. They use the
same default range helper as analytics: from the start of the workspace-local
day 29 local days before request time through the current instant.

Relationship analytics routes accept optional `from` and `to`:

| Input case | Behavior |
| --- | --- |
| `from` omitted | Defaults to the start of the workspace-local day 29 local days before request time. |
| `to` omitted | Defaults to the current instant. |
| `from=YYYY-MM-DD` | Converts that workspace-local date at local midnight into a UTC instant. |
| `to=YYYY-MM-DD` | Converts that workspace-local date at local midnight into a UTC instant. |
| `from` or `to` with `Z` or offset | Parses as that exact instant. |
| `to <= from` | Fails with `DATE_RANGE_INVALID`. |
| local day span greater than 366 | Fails with `DATE_RANGE_TOO_LARGE`. |

The response `range` object is authoritative for rendering:

```json
{
  "from": "2026-03-08T05:00:00.000Z",
  "to": "2026-03-09T04:00:00.000Z",
  "timezone": "America/New_York"
}
```

Use the returned `range.timezone` in chart labels and explanations.

## DST Behavior

Stage 18 tests verify DST-sensitive analytics behavior. For a workspace timezone
of `America/New_York`, the date-only range `from=2026-03-08&to=2026-03-09`
serializes as:

```json
{
  "from": "2026-03-08T05:00:00.000Z",
  "to": "2026-03-09T04:00:00.000Z",
  "timezone": "America/New_York"
}
```

That day is 23 hours because the local clock springs forward. The backend
includes measurements at the `from` instant and excludes measurements at the
`to` instant.

Check-in tests verify weekly recurrence boundaries across spring-forward,
fall-back, ISO year boundaries, and ISO week 53. For example, a New York weekly
period starting `2026-03-02T05:00:00.000Z` ends at
`2026-03-09T04:00:00.000Z`, while a fall-back period starting
`2026-10-26T04:00:00.000Z` ends at `2026-11-02T05:00:00.000Z`.

Frontend guidance:

- Do not assume local days are always 24 hours.
- Do not add `24 * 60 * 60 * 1000` to create local calendar days in frontend
  analytics code.
- Prefer server-provided `from`, `to`, `periodStartAt`, `periodEndAt`, and
  `dueAt` values for chart windows and schedule displays.

## Analytics Granularity

| Route | `granularity` values | Default | Notes |
| --- | --- | --- | --- |
| `/analytics/training` | `day`, `week` | `day` | Buckets workout session events and program progress events. |
| `/analytics/progress` | `none`, `day`, `week`, `month` | `none` | `none` returns no buckets. Points are still paginated. |
| `/analytics/nutrition` | `day`, `week` | `day` | Buckets daily tracking entries by their `localDate`. |
| `/analytics/adherence` | `day`, `week` | `day` | Merges available training, check-in, nutrition, and water bucket rows by key. |

Invalid values fail with `GRANULARITY_INVALID`.

## Bucket Boundaries

Analytics bucket windows are computed from the workspace timezone:

| Granularity | Bucket key | Window |
| --- | --- | --- |
| `day` | `YYYY-MM-DD` | Workspace-local midnight through next workspace-local midnight. |
| `week` | `YYYY-MM-DD` | Workspace-local Monday through next workspace-local Monday. The key is the Monday local date. |
| `month` | `YYYY-MM` | First workspace-local day of the month through first day of the next month. |

Bucket responses include `from` and `to` as UTC ISO strings. Those are the
actual bucket boundaries; render them as the source of truth.

Buckets are sparse. The backend emits buckets only when there is at least one
underlying event or entry for the metric/series in that bucket. It does not fill
missing empty days, weeks, or months. Frontend charts that need empty intervals
should fill them client-side using the returned range and timezone, but should
not manufacture backend counts.

## Training Analytics Time Semantics

Training analytics uses the parsed half-open range for:

- workout summary counts;
- program progress event counts;
- personal record counts;
- training series buckets.

Workout events are included when started, completed, or abandoned in the range.
For series bucketing, a workout uses:

- `completedAt` when status is `COMPLETED`;
- `abandonedAt` when status is `ABANDONED`;
- `startedAt` otherwise.

Program progress events use `occurredAt`. Personal record counts use
`occurredAt`, and `latestPr` is the latest achieved PR overall, not limited by
the requested range.

## Progress Analytics Time Semantics

Progress analytics uses `measuredAt` for the range, sorting, pagination, and
bucket assignment. Points are sorted by `measuredAt` ascending with `_id` as a
tie-breaker. The `limit` defaults to 100 and is capped at 500.

`summary.firstInWindow` and `summary.latestInWindow` are limited to the parsed
range. `summary.latest` is the latest measurement before `range.to`, so it may
also be inside the window when the latest visible measurement is in range.

Progress buckets include the latest visible measurement per bucket. If multiple
measurements share the same `measuredAt`, the larger id wins as the bucket
latest. Stage 18 tests verify pagination beyond 500 points and day/week/month
buckets selecting the latest visible measurement.

## Nutrition Analytics Time Semantics

Nutrition analytics converts the parsed instant range into workspace-local
date strings and queries daily tracking entries where:

- `localDate >= localDate(range.from, workspace timezone)`;
- `localDate < localDate(range.to, workspace timezone)`.

This means nutrition analytics is day-record based, not instant-event based.
Series buckets are built from each entry's `localDate` at workspace-local
midnight. A bucket appears only if at least one daily tracking entry exists for
that bucket.

Nutrition adherence rates are stored as percentages in daily tracking and
reported as ratios in analytics. Water averages are rounded to two decimals;
water adherence is capped at 1 when a positive target exists.

## Adherence Analytics Time Semantics

Adherence analytics uses the same parsed range and granularity as its component
analytics. It combines:

- training summary and training buckets when the actor can see training;
- check-in summary and check-in buckets when the actor can see check-ins;
- nutrition and water summaries and buckets when the actor can see nutrition.

The merged `series` is keyed by the component bucket key. Missing components for
a bucket are simply absent from that bucket row.

## Check-In Time Semantics

Check-in assignments have their own weekly recurrence timezone:

```json
{
  "frequency": "WEEKLY",
  "dayOfWeek": 5,
  "timezone": "America/New_York"
}
```

If `dayOfWeek` is omitted during assignment creation, the backend derives it
from `startedAt` in the assignment timezone. Existing generated instances keep
their original `timezone` and `dayOfWeek` even if the assignment recurrence is
later updated.

Generated instances include:

- `periodKey` as an ISO week key;
- `periodStartAt`;
- `periodEndAt`;
- `opensAt`;
- `dueAt`;
- `timezone`;
- `dayOfWeek`.

Use those returned fields directly for schedule display. Do not reconstruct
check-in periods from frontend date arithmetic.

## Daily Tracking Time Semantics

Daily tracking routes use `:localDate` as a date-only path parameter. The value
must be a valid `YYYY-MM-DD` date. On write, the backend stores
`timezoneAtEntry` from the workspace timezone at the time of the request.

Trainee self-updates are limited to today or yesterday in the current workspace
timezone. Staff corrections outside that window require the appropriate
permission and a correction reason. This edit-window behavior is verified by
Stage 11 progress tests, including workspace timezone and DST-sensitive cases.

## Frontend Rendering Guidance

- Display analytics charts using the returned `range.timezone` and bucket
  `key`, `from`, and `to`.
- Label day buckets by `key` for compact charts and use `from`/`to` in tooltips
  where precise DST-aware windows matter.
- Label week buckets as weeks starting on the `key` local Monday.
- Label month buckets by `YYYY-MM`.
- Preserve user-selected `from`, `to`, `granularity`, `metricDefinitionId`, and
  pagination cursor together. Changing any of them starts a new query.
- For date pickers that submit analytics date-only values, make clear that `to`
  is exclusive. To show a single local day, submit `from=<day>` and
  `to=<next day>`.
- For progress analytics, keep the paginated `points` list separate from
  `summary` and `buckets`; subsequent pages repeat the same summary for the same
  range and metric.

## Error Summary

| Code | HTTP | When it occurs | Frontend behavior |
| --- | --- | --- | --- |
| `FROM_TIMEZONE_REQUIRED` | 422 | Analytics `from` is a date-time string without `Z` or numeric offset. | Send a date-only value or a timezone-qualified instant. |
| `TO_TIMEZONE_REQUIRED` | 422 | Analytics `to` is a date-time string without `Z` or numeric offset. | Send a date-only value or a timezone-qualified instant. |
| `FROM_INVALID` | 422 | Analytics `from` cannot be parsed as a date. | Correct the date input. |
| `TO_INVALID` | 422 | Analytics `to` cannot be parsed as a date. | Correct the date input. |
| `DATE_RANGE_INVALID` | 422 | `to` is equal to or earlier than `from`. | Ask the user to choose an end after the start. |
| `DATE_RANGE_TOO_LARGE` | 422 | Analytics local-day span exceeds 366 days. | Ask the user to choose a shorter range. |
| `GRANULARITY_INVALID` | 422 | Unsupported analytics granularity. | Use the route-specific allowed values. |
| `WORKSPACE_TIMEZONE_INVALID` | 422 | Stored workspace timezone is missing/invalid for analytics/dashboard reads. | Block analytics display and ask an authorized user/admin to correct workspace settings. |
| `CHECKIN_TIMEZONE_INVALID` | 422 | Check-in recurrence timezone is invalid. | Require a valid IANA timezone before saving. |
| `DAILY_TRACKING_DATE_INVALID` | 422 | Daily tracking local date is malformed or impossible. | Correct the date-only route value. |
| `DAILY_TRACKING_EDIT_WINDOW_EXPIRED` | 409 | Trainee self-update is outside today/yesterday in workspace timezone. | Refetch, show the edit window restriction, and route staff corrections through staff UX. |

## Verified Examples

Workspace timezone `Africa/Cairo`:

```json
{
  "input": { "from": "2026-09-01", "to": "2026-09-02" },
  "range": {
    "from": "2026-08-31T21:00:00.000Z",
    "to": "2026-09-01T21:00:00.000Z",
    "timezone": "Africa/Cairo"
  }
}
```

Workspace timezone `America/New_York`, spring-forward day:

```json
{
  "input": { "from": "2026-03-08", "to": "2026-03-09" },
  "range": {
    "from": "2026-03-08T05:00:00.000Z",
    "to": "2026-03-09T04:00:00.000Z",
    "timezone": "America/New_York"
  }
}
```

Single-day analytics UI example:

```text
User selects: 2026-03-08
Frontend sends: from=2026-03-08&to=2026-03-09
Backend includes: events >= local 2026-03-08 00:00 and < local 2026-03-09 00:00
```

## Unverified Or Non-Contractual Details

- The exact internal algorithm used to convert local midnights into UTC instants
  is backend-internal. Frontend code should rely on returned `range`, bucket,
  and check-in schedule fields.
- OpenAPI does not fully describe these timezone semantics. Use this document
  plus the route-level guide rather than generated schema metadata alone.
- Analytics does not currently expose branch-timezone bucket modes. If product
  later needs branch-local analytics, that is new implementation work and is not
  part of locked V1 behavior.
