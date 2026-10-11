# Platform workspace subscription and live counts

These additive reads preserve the locked workspace detail, management-state,
tenant subscription reads, and existing Platform subscription GET. They add no
commercial mutations, provisioning, counters, tables, indexes, or migrations.

## Routes and authority

| GET route | Existing PLATFORM permission |
| --- | --- |
| `/api/v1/platform/workspaces/:workspaceId/subscription-summary` | `subscriptions.read` |
| `/api/v1/platform/workspaces/:workspaceId/counts` | `platform_workspaces.manage` |

Both require an authenticated, unrestricted session, MFA, an ACTIVE Platform
membership, and the specified permission. Existing effective permission
evaluation, including DENY precedence, remains unchanged. Workspace
memberships and gym roles confer no Platform authority. The permissions remain
separate: workspace management alone does not authorize commercial reads, and
commercial read permission alone does not authorize counts.

Resolved support context is explicitly rejected with
`403 SUPPORT_ACCESS_FORBIDDEN` before Platform authorization or business lookup.
Successful responses use `Cache-Control: private, no-store`.

Both accept existing workspaces in PENDING_ACTIVATION, ACTIVE, RESTRICTED,
SUSPENDED, and ARCHIVED states. Neither calls tenant authorization or requires
an ACTIVE target workspace.

## Subscription summary

```ts
{
  data: {
    workspaceId: string;
    subscription: null | {
      lifecycleStatus: "PENDING_ACTIVATION" | "TRIAL" | "ACTIVE" |
        "GRACE_PERIOD" | "FROZEN" | "EXPIRED" | "CANCELLED";
      startedAt: string | null;
      expiresAt: string | null;
      graceEndsAt: string | null;
      frozenAt: string | null;
      expiredAt: string | null;
      cancelledAt: string | null;
      currentTerms: null | {
        planId: string;
        planName: string;
        planVersionId: string;
        billingPeriod: "MONTHLY" | "YEARLY";
        effectiveFrom: string;
        effectiveTo: string | null;
      };
    };
  };
}
```

Dates are ISO strings; absent optional dates are null. A workspace without a
subscription returns HTTP 200 with `subscription: null`. An existing pending
subscription without a current-terms pointer returns `currentTerms: null`.
Pending activation intent is never presented as current terms.

Source traversal is workspace subscription → `currentTermsId` → terms matching
`_id`, `subscriptionId`, and `workspaceId` → `planVersionId` → referenced version
→ its `planId` → referenced plan. Catalog `currentVersionId`, date sorting,
payment history, audit, outbox, and usage do not determine the subscribed version.
Disabled/archived plans still resolve for existing subscriptions.

`planName` is current referenced-plan metadata, not a historical name snapshot.
`effectiveFrom` and `effectiveTo` describe subscription term validity, not
guaranteed invoice cycles. No separate trial dates, period dates,
cancel-at-period-end, or generic ended-at fields are invented.

Missing or mismatched pointed terms, a missing referenced plan version, or a
missing referenced plan fails with HTTP 500 and
`SUBSCRIPTION_SUMMARY_INTEGRITY_ERROR`. Absence is not fabricated for corrupt
references. The error contains no internal reference details.

The GET only uses pure repository reads. It does not call
`ensurePendingActivation`, usage ensure, audit, outbox, idempotency, or any write
helper. No internal subscription/term IDs, mutation versions, accessVersion,
features, limits, compliance, usage/reservations, pending intent, actor metadata,
payments, references/proofs, provider data, invoices, PII, memberships, role
arrays, permissions, or support/search internals are returned.

## Live counts

```ts
{
  data: {
    workspaceId: string;
    counts: {
      branches: { active: number };
      trainees: { active: number; needsReassignment: number };
      staff: { activeIncludingOwners: number };
    };
  };
}
```

All counts are nonnegative integers, scoped by workspaceId:

| Field | Authoritative predicate |
| --- | --- |
| `branches.active` | `branches.status = ACTIVE` |
| `trainees.active` | `coaching_relationships.status = ACTIVE` |
| `trainees.needsReassignment` | `coaching_relationships.status = NEEDS_REASSIGNMENT` |
| `staff.activeIncludingOwners` | ACTIVE `workspace_memberships` whose roles contain GYM_OWNER, GYM_MANAGER, TRAINER, ASSISTANT_TRAINER, or NUTRITIONIST |

Each qualifying membership counts once, including owner-only memberships and
memberships with multiple qualifying roles. Trainee-only memberships and INVITED,
SUSPENDED, ENDED, ARCHIVED memberships are excluded. Pending, ended, archived
relationships and archived branches are excluded. Assignment rows are never
joined, and trainee-role memberships are not used as coaching relationships.

Staff follows the Stage 18 definition including owners, not the Stage 5 quota
staff definition. ACTIVE and NEEDS_REASSIGNMENT remain separate counts.

Counts are live observations of current authoritative collections, not historical
snapshots. Archived workspaces can return nonzero surviving counts. Existing
retention deletion reduces counts, potentially to zero. Child statuses remain
authoritative; no workspace-status inference overrides them. The four reads run
concurrently and are not a transactionally consistent cross-collection snapshot.
No stored accounting (`workspace_usage`), persisted analytics, cached counters,
events, audit, or outbox reconstruction supplies these values. No identities or
PII are returned.

## Errors and schemas

Both routes document 200, 400, 401, 403, 404, and 500. Malformed ObjectId path
parameters return `400 VALIDATION_FAILED`; an unknown workspace returns
`404 WORKSPACE_NOT_FOUND`. Unavailable infrastructure returns the existing
Backend error envelope. Counts dependency unavailability uses
`500 WORKSPACE_COUNTS_UNAVAILABLE`.

Response objects have explicit schemas and `additionalProperties: false` at
every object level. The reads expose no management, subscription, accounting, or
authority version and accept no expectedVersion.

## Query-plan verification

Run `bun scripts/verify-platform-workspace-count-plans.ts` with the test
`MONGODB_URI`. The script uses a uniquely named disposable database, existing
migrations 001–025, and 12 workspaces with 200 documents per count collection per
workspace. It explains the unhinted match/group pipeline used by countDocuments
with executionStats and fails on COLLSCAN, blocking SORT, or absent index usage.
It drops only its own disposable database afterward.

Measured on MongoDB 7.0 during implementation:

| Count | Winning plan / existing index | Keys examined | Docs examined | Count |
| --- | --- | --- | --- | --- |
| Branches active | COUNT_SCAN / `branches_workspace_status` | 151 | 0 | 150 |
| Trainees active | COUNT_SCAN / `coaching_relationships_workspace_status_updated` | 51 | 0 | 50 |
| Needs reassignment | COUNT_SCAN / `coaching_relationships_workspace_status_updated` | 51 | 0 | 50 |
| Active staff including owners | GROUP → multikey IXSCAN with unique record deduplication / `memberships_active_staff_dashboard` | 321 | 0 | 107 |

No winning plan used COLLSCAN or blocking SORT. No hints or new indexes were
needed. Production optimizer choices remain dependent on installed indexes and
data distribution; the script is repeatable evidence, not a universal plan
guarantee. Migration 025 remains last.

## Deferred

Subscription mutations, billing/payment workflows, plan management UI, Platform
Users, Platform Operations, WEB-022, WEB-023, and Mobile changes remain deferred.
