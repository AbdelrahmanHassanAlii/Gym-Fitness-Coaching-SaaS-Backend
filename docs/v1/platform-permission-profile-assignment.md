# Platform permission-profile assignment V1

Existing Platform members only. This milestone adds assignment state, an ACTIVE profile selector, and assignment replacement. Explicit-grant product editing, profile CRUD expansion, creation/invitation, global account search, Platform Operations, WEB-022, WEB-023, Web and Mobile remain deferred.

## Routes and authority

- `GET /api/v1/platform/users/:userId/permission-profile-assignment`
- `PUT /api/v1/platform/users/:userId/permission-profile-assignment`
- `GET /api/v1/platform/permission-profile-selector?limit=50&cursor=...`

All require `platform_permissions.manage`, unrestricted authentication, MFA, an ACTIVE actor account and ACTIVE Platform membership. Neither `platform_users.manage` nor `platform_users.read` substitutes for or accompanies this authority. Workspace roles confer none. Route headers and service context explicitly reject support with `SUPPORT_ACCESS_FORBIDDEN` before target lookup. Current actor authorization is repeated before completed idempotency replay and inside changing transactions. Responses use `Cache-Control: private, no-store`.

GET accepts ACTIVE/SUSPENDED/ENDED target memberships. Unknown accounts and accounts without a Platform membership return `USER_NOT_FOUND`. State includes only userId, membership id/status/management version, and sorted profile id/name/status. Archived profiles retain their names. Missing or foreign-context references are UNAVAILABLE with null names. Historical references are never truncated: 10,000 are accepted, 10,001 fail with `PLATFORM_AUTHORITY_EVALUATION_LIMIT_EXCEEDED`.

The selector includes ACTIVE Platform profiles, including system defaults. Its strict items expose only id/name. Stable cursor pagination by the unique ACTIVE Platform name uses no skip; page limit is 1..100 (default 50). Selection does not guarantee delegability to a target. Cursor payloads are opaque transport values, validated before use.

## Replacement, revisions and replay

PUT strictly requires `{ expectedVersion, profileIds }` and a nonblank `Idempotency-Key`. expectedVersion is an integer 0..Number.MAX_SAFE_INTEGER; profileIds contains 0..20 lowercase ObjectIds. Normalized duplicate IDs conflict with `PERMISSION_PROFILE_DUPLICATE`. IDs are sorted lexicographically: order has no authority meaning. The idempotency identity is the real actor userId and concrete PUT route; fingerprint is `{ userId, body: { expectedVersion, profileIds: sortedNormalizedIds } }`.

The target membership and underlying account must be ACTIVE. Membership and account failures have distinct codes: `PLATFORM_PERMISSION_TARGET_MEMBERSHIP_INACTIVE` and `PLATFORM_MEMBERSHIP_TARGET_ACCOUNT_INACTIVE`. Authenticated self assignment is forbidden with `PLATFORM_PERMISSION_SELF_MUTATION_FORBIDDEN`, including the legacy HTTP assignment path.

The new CAS uses membership `version`, ACTIVE status and identity. Stale versions return `PLATFORM_MEMBERSHIP_VERSION_CONFLICT`, including stale no-ops. A changing command atomically increments version and accessVersion once. accessVersion remains the authority-freshness counter and is omitted from the new DTO. A fresh validated no-op performs no membership write, revision increment, assignment audit or outbox; transactional idempotency completion still commits. Empty sets are allowed subject to all security and recovery checks.

The legacy `PUT /api/v1/platform/memberships/:membershipId/permission-profiles` retains its accessVersion expectedVersion interpretation and legacy response fields. Production wiring adapts it to the same transaction-bound hardened command. Trusted internal repository/bootstrap writes remain non-HTTP; no profile-name/role-key bypass is offered.

## Delegation and transaction security

Every proposed profile permission entry must remain delegable, including DENY entries. Shared evaluation reuses the canonical effective-access decision function and permission metadata. For every NONE/DENY-to-ALLOW transition, the actor must cover the resulting scope. All canonical Platform scope types are considered, including `audit.sensitive.read`. Explicit resource atoms, full grant resource sets and a remainder atom cover individual and combined requests; narrow actor DENYs cannot hide inside broad authority.

Before/after state includes ACTIVE assigned profiles and unchanged explicit grants with scope applicability, specificity and expiry. Relevant future expiration instants are checked, so a temporary target DENY cannot conceal a persistent increase. Persistent increases require durable actor authority: expiring ALLOW grants are excluded while currently applicable DENYs remain; durable coverage is required now and at each exposure boundary. Expired grants do not apply. Failure is `DELEGATION_DENIED`.

All security-sensitive mutation reads use the transaction session: actor session/account/membership, profile definitions/status, target account/membership, explicit grants, delegation inputs and recovery inputs. The shared authority serialization guard forces retries to reload/re-authorize. It independently protects the last durable holders of `platform_users.manage` and `platform_permissions.manage`.

Authenticated Platform profile permission update and archive evaluate every assigned membership before/after the changed definition. Removing or archiving a DENY-bearing profile cannot expose another ALLOW without delegable authority. Name-only changes preserve existing no-revision-churn behavior.

Each input category (profiles, grants, entries, resource atoms, scopes and expiry boundaries) is bounded at 10,000. Fanout members and aggregate references are bounded too. A command shares a 1,000,000-unit work budget covering loaded inputs and decisions across all affected members. Limits fail closed; no silent truncation occurs. Recovery evaluation keeps its independent locked bounds.

## Facts, indexes and deferred work

A changing assignment emits one `MembershipPermissionProfilesReplaced` audit and one outbox fact. Safe metadata includes userId, membershipId, previous/new sorted IDs, added/removed IDs, previous/new management versions and command identity. No names, emails, raw definitions or tokens are recorded. Replay and no-op emit none. Valid Platform facts are informational for Workspace reconciliation/notification handlers; malformed Platform facts fail validation.

Migration 028 remains unchanged and last: the nonunique, nonpartial, nonsparse `platform_memberships_permission_profile_ids` index on `{ permissionProfileIds: 1 }` serves all-status reverse fanout and revision propagation. Capacity checks, transaction requirements and recovery guards remain separate. No Migration 029, historical document rewrite, cleanup or truncation is added.

## Errors

Strict OpenAPI responses document 400/401/403/404/409/500 and exact codes. Security precedence is authentication/restricted/MFA, support, actor authority, request/header validation, guard and transactional reauthorization, target lookup, self, revision, ACTIVE/account state, duplicates/profile eligibility, comparison/delegation, CAS, audit/outbox/idempotency completion, recovery check, commit. Existing transactional idempotency conflict/recovery codes are preserved.
