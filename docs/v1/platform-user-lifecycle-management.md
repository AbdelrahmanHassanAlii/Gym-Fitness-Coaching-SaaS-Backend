# Platform User Lifecycle Management V1

Scope: existing Platform members only. Locked Platform Users directory/detail contracts are unchanged. Member creation, account candidates/invitations/security administration, new permission assignment/grant contracts, profile CRUD expansion, Platform Operations, WEB-022 and WEB-023 are deferred. No Web implementation is included.

## HTTP contract

| Method | Route |
| --- | --- |
| GET | `/api/v1/platform/users/:userId/management-state` |
| POST | `/api/v1/platform/users/:userId/suspend` |
| POST | `/api/v1/platform/users/:userId/reactivate` |
| POST | `/api/v1/platform/users/:userId/end` |

Each route requires an unrestricted authenticated session, MFA, an ACTIVE underlying actor account, an ACTIVE Platform membership and effective `platform_users.manage`. `platform_users.read`, `platform_permissions.manage` alone and workspace roles do not authorize these routes. Permissions management remains independently gated by `platform_permissions.manage`.

Support is explicitly forbidden by route and service checks. A narrow global support-hook recognition also rejects these paths. Neither valid nor invalid support headers resolve the management target or enable a support write. Authentication/restriction/MFA precede support denial; authority precedes target resolution. Unknown/malformed user IDs and accounts without a Platform membership return `404 USER_NOT_FOUND`.

POST body: exactly `{ "expectedVersion": 0 }`. The revision must be a nonnegative safe integer; strings, fractional values and extra fields are rejected before Fastify coercion/removal. A nonblank `Idempotency-Key` is required. Responses use `Cache-Control: private, no-store`.

All successful GET/POST responses are 200 with this strict DTO:

```json
{
  "data": {
    "userId": "000000000000000000000001",
    "platformMembership": {
      "id": "000000000000000000000002",
      "status": "ACTIVE",
      "version": 0,
      "suspendedAt": null,
      "endedAt": null
    }
  }
}
```

IDs are lowercase 24-character ObjectIds. Timestamps are ISO date-times or null and both keys are always present. Every response object forbids additional properties. No account identity, assigned profiles, grants, workspace data or `accessVersion` is exposed.

## Lifecycle and revisions

| Source | Suspend | Reactivate | End |
| --- | --- | --- | --- |
| ACTIVE | SUSPENDED | invalid | ENDED |
| SUSPENDED | invalid | ACTIVE | ENDED |
| ENDED | invalid | ACTIVE | invalid |

Repeated actions are invalid transitions, never successful no-ops. Reactivation requires the target account to be ACTIVE, preserves membership identity/profile assignments/explicit grants and clears both lifecycle timestamps. Current eligible profile contents and unexpired grants become effective again. End preserves `suspendedAt` when ending a suspended membership. Suspend/end do not revoke global sessions or tokens: subsequent Platform authorization checks observe the inactive membership; already-authorized requests are not canceled. ENDED is reversible through reactivate.

Membership `version` is the persisted management revision. New repository and development-seed memberships initialize it to zero. Lifecycle, profile assignment and explicit-grant replacement increment it together with existing `accessVersion` behavior. Assigned Platform profile permission changes/archive increment both revisions for affected active and inactive memberships. Name-only profile edits do not revise membership authority. `accessVersion` remains the authority freshness/decision revision and the legacy permission mutation CAS; it is not exposed as lifecycle CAS.

CAS includes membership identity, expected `version` and allowed source status. A same-version race has one winner; stale callers receive `409 PLATFORM_MEMBERSHIP_VERSION_CONFLICT`, without automatically replaying their intent. Refetch before a new intent and use a new idempotency key.

## Idempotency and transactions

Idempotency is scoped by real actor ID and method/normalized target ID/command. Its fingerprint includes target ID, command and exact body. The existing default retention is 24 hours. Completed retries replay the original status/body without new state or events. Replay reauthorizes the current actor before reading the stored result. Replay is a historical snapshot, so clients must refetch afterward.

Different fingerprints return `IDEMPOTENCY_KEY_REUSED`; processing requests return `IDEMPOTENCY_REQUEST_IN_PROGRESS`. Existing matching failed/stale-processing recovery semantics remain. Business state, both revisions, audit, outbox, shared guard and idempotency completion commit in the same MongoDB transaction. Guard verification runs before commit and rolls back completion and business writes if recovery authority would be depleted.

## Self-target and durable recovery authority

Authenticated lifecycle services reject every self-target command, including legacy routes, with `403 PLATFORM_MEMBERSHIP_SELF_MUTATION_FORBIDDEN`.

A shared `platform_authority_guards` document with `_id: management-authority` is written transactionally before sensitive mutations. Concurrent writers contend on this document and MongoDB retries them against a fresh snapshot. Counting holders followed by independent target writes is not used.

Before commit, the transaction must retain an ACTIVE account and ACTIVE Platform membership with durable effective authority for **each** independent permission: `platform_users.manage` and `platform_permissions.manage`. Different members can provide the two authorities. Eligible Platform profiles and explicit grants are evaluated by the same canonical evaluator used for runtime authorization. Profile names/role keys do not determine authority. Profile DENY beats profile ALLOW; applicable explicit grants override the profile baseline; equally specific explicit DENY beats ALLOW.

Durable rule: exclude every expiring explicit ALLOW, regardless of how far away its expiry is; retain currently applicable explicit DENY. Expired grants contribute nothing. Non-expiring ALLOW and eligible profile authority can provide recovery. This conservative rule prevents an expiring ALLOW from being the sole recovery path. Expiration of DENY can only remove a restriction; policy/profile/account changes require reevaluation. This is command protection, not a guarantee against unrelated external database edits or future global account administration.

Evaluation fails closed above 10,000 active memberships, aggregate assigned-profile references, eligible profiles, relevant grants or affected memberships in one profile update. Profile propagation validates safe revision capacity and is bounded in the same transaction. No new point-lookup compound indexes are required; membership `_id`/unique `userId`, account `_id`, guard `_id` and existing idempotency indexes suffice.

Production container repositories protect internal lifecycle/profile/grant writes too, creating a transaction when called without one. Unit test repositories with no guard injection are isolated test doubles. Bootstrap is a trusted operational flow: creating an empty membership does not remove authority; assigning its explicit recovery profile uses guarded repository mutation and must establish both durable authorities. Bootstrap does not bypass depletion checks or invent an administrator. Development seed tooling remains restricted to its existing non-production allowlisted databases and initializes revisions; it is not a production management interface.

## Migration and rollout

027 is `027-platform-user-lifecycle-management`, the last of 27 migrations. Migrations 001–026 are unchanged. It validates existing revisions, preserves valid values, backfills only absent versions to zero, initializes the shared guard deterministically and is rerunnable.

Any pre-existing Platform memberships require both durable recovery authorities. Depleted existing data causes an explicit verification failure; no administrator is created. Empty databases are explicitly unprovisioned and must be bootstrapped with an explicit eligible recovery profile before management mutations. Recover depleted deployments operationally before applying 027. Stop application writers during migration as with existing migration conventions; do not serve management routes before 027 succeeds. The gate/test runs apply migrations only to isolated test databases.

## Audit/outbox

Lifecycle event types remain `PlatformMembershipSuspended`, `PlatformMembershipReactivated` and `PlatformMembershipEnded`. Safe metadata records target IDs, command and previous/new status/version. Existing actor/correlation/IP/user-agent fields remain. No names/emails/secrets/tokens/free-text reason are added. Idempotent replay emits no new events; each successful new command inserts one committed audit and one committed outbox fact.

Worker handlers validate the lifecycle event type, `platform_membership` aggregate, ObjectId or canonical lowercase hex aggregate ID, and object payload with canonical string `userId` before acknowledging. Minimal historical `{ userId }` payloads remain valid; enriched management metadata is not required. Malformed facts reject through the existing outbox retry/failure mechanism and are not marked processed. Acknowledgment is informational, side-effect free and retry-safe, without notifications or session revocation. Outbox delivery is retryable; exactly-once external delivery is not promised. Existing unrelated event-consumer behavior is unchanged.

## Errors

Existing error envelope and correlation IDs remain:

| HTTP | Codes |
| --- | --- |
| 400 | `VALIDATION_FAILED`, `IDEMPOTENCY_KEY_REQUIRED` |
| 401 | `AUTH_REQUIRED` |
| 403 | `AUTH_SESSION_RESTRICTED`, `TWO_FACTOR_REQUIRED`, `PLATFORM_MEMBERSHIP_REQUIRED`, `PLATFORM_MEMBERSHIP_INACTIVE`, `PERMISSION_DENIED`, `SUPPORT_ACCESS_FORBIDDEN`, `PLATFORM_MEMBERSHIP_SELF_MUTATION_FORBIDDEN` |
| 404 | `USER_NOT_FOUND` |
| 409 | `PLATFORM_MEMBERSHIP_VERSION_CONFLICT`, `PLATFORM_MEMBERSHIP_TRANSITION_INVALID`, `PLATFORM_MEMBERSHIP_TARGET_ACCOUNT_INACTIVE`, `PLATFORM_LAST_MANAGEMENT_AUTHORITY_REQUIRED`, `PLATFORM_AUTHORITY_EVALUATION_LIMIT_EXCEEDED`, existing idempotency reuse/in-progress/recovery/completion conflict codes |
| 500 | `INTERNAL_ERROR` |

Domain precedence after request security/validation: target resolution, self-target, expected revision, transition/account eligibility, recovery authority, atomic commit. Lockout details identify only the protected permission, never other administrators.

Legacy lifecycle request/response shapes remain; self-target and depletion are newly denied for invariant safety. Legacy permission contracts retain `accessVersion` CAS and existing response shapes; their transactional internals propagate management revisions and shared lockout checks. Their broader delegation/assignment Web contract is deferred.
