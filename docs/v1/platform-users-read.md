# Platform Users read contracts

V1 is a read-only directory of Platform members: accounts linked to a
`platform_memberships` record. It does not enumerate all system accounts.
Workspace memberships, gym roles and coaching relationships confer no Platform access.

## Routes and authority

- `GET /api/v1/platform/users`
- `GET /api/v1/platform/users/:userId`

Both require an authenticated, unrestricted session, MFA, an ACTIVE actor Platform
membership and effective PLATFORM `platform_users.read` ALLOW. Existing permission
evaluation is reused. Support context is explicitly rejected with
`403 SUPPORT_ACCESS_FORBIDDEN` before target lookup, including at service entry.
Successful reads have `Cache-Control: private, no-store`.

## Directory

Query: `q?`, `platformMembershipStatus?`, `cursor?`, `limit?` (default 50, range 1–100).
Unknown query properties and invalid enum/limit values return 400 VALIDATION_FAILED.
`q` is an exact full email (trimmed and lowercased with existing email validation) or
an exact 24-hex user ObjectId. Blank search means no search. No name, prefix, phone,
regex or fuzzy search exists. Invalid nonempty search returns
422 PLATFORM_USER_SEARCH_INVALID. Schema-length violations return 400.

`platformMembershipStatus` accepts ACTIVE, SUSPENDED, ENDED. No account-status filter.
Order is membership `_id DESC`, not user ID or account creation time. Cursor is an
opaque lowercase 24-hex membership ID; `_id < cursor`, limit+1 eligible rows, no
offset. Invalid cursor returns 422 CURSOR_INVALID. Filter/search must remain fixed
when navigating pages. Pagination is a live view, not a snapshot.

The database query joins allowlisted account fields and excludes dangling account
references before limiting. `nextCursor` comes from the last returned membership
only when an additional eligible row exists. Exact search uses indexed account
lookup then unique membership-by-user lookup, applying the same filter/cursor.

Response: `{ data: rows, meta: { nextCursor: string|null, hasMore: boolean } }`.
Row: `{ id, displayName?, email?, status, createdAt, platformMembership: { status } }`.
`id` is user ID; `displayName` is trimmed firstName + space + lastName, omitted if
empty. Email retains the canonical optional email value, not normalizedEmail.

## Detail and status semantics

Strict lowercase user ObjectId parameter; malformed ID returns 400 VALIDATION_FAILED.
Unknown account, dangling membership, or account without Platform membership returns
404 USER_NOT_FOUND. No null membership or out-of-scope account disclosure.

Response: `{ data: { id, displayName?, email?, status, createdAt, updatedAt,
platformMembership: { id, status, createdAt, updatedAt, suspendedAt?, endedAt? } } }`.
Dates are ISO strings. Every response object is strict and explicitly serialized.

Top-level status is account status: PENDING_ACTIVATION, ACTIVE, SUSPENDED, LOCKED,
DEACTIVATED. Nested status is membership status: ACTIVE, SUSPENDED, ENDED. All member
statuses are readable; membership ACTIVE is not a promise of effective access.

## Privacy and exclusions

No phone/normalized identifiers, verification timestamps, locale/timezone, credentials,
MFA/security/session data, workspace memberships/roles/ownerships, relationships,
coaching/health/nutrition data, documents or payments. No profiles, grants, effective
permissions or accessVersion. Database projections avoid loading credential fields.
No mutation, duplicate store, projection collection or persistent cache is added.
Existing legacy membership/permission and locked Workspace contracts remain intact.

## Index and verification

026-platform-user-directory-indexes adds only
`platform_memberships_status_id: { status: 1, _id: -1 }`; rerunning up is safe.
001–025 are unchanged. Unfiltered traversal uses `_id_` backwards; status traversal
uses the compound index. These index choices are explicit query hints. Exact email
uses the string-compatible partial unique normalized-email index; ID and joins use
users `_id_`; membership lookup uses platform_memberships_user_unique.

Run focused migration, directory, detail and query-plan tests with a local Mongo
replica set selected through MONGODB_URI. The query-plan test prepares a unique test
database with 1500 skewed memberships and dangling references, calls the read-only
verifier, validates all eligible pages and removes that isolated database.
`scripts/verify-platform-user-directory-plans.ts` can independently inspect an
existing fixture database selected by PLATFORM_USER_PLAN_DB (prefix
platform_user_plans_). It only reads, uses executionStats, and rejects collection
scans, foreign collection scans, blocking sorts or unexpected indexes.

All-system directory, Platform member/account mutations, permission administration,
credential/MFA/session actions, Platform Operations, WEB-022, WEB-023 and Mobile are deferred.
