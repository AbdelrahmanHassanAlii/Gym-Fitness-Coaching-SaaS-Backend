# WEB-022 Backend support prerequisite

## Management authority

Dedicated `/api/v1/platform/support/**` routes require a current authenticated,
unrestricted, MFA-satisfied auth session, ACTIVE underlying user account, ACTIVE
Platform membership and the route's existing support permission. Inactive account
returns `AUTH_REQUIRED` (401), matching Platform management account semantics.
Inactive Platform membership returns `PLATFORM_MEMBERSHIP_INACTIVE` (403).

Any supplied `X-Support-Session-Id` on these management routes, including GET,
returns `SUPPORT_ACCESS_FORBIDDEN` (403) before support/target lookup. Management
and end/revoke requests must omit the support selector. This boundary is scoped
to support HTTP routes; generic Platform authorization is unchanged.

## Start and completed replay

`POST /api/v1/platform/support/access-requests` retains `support.sessions.start`
and its existing request/response DTO. It always acts as the authenticated user.
Every invocation is authorized before the idempotency service can replay.
Completed approved and denied acknowledgements cannot bypass current account,
auth-session, MFA, restriction, membership or permission checks.

Idempotency identity remains user ID, `support.access-requests.start`, trimmed
Idempotency-Key and stable body hash. Same-key/different-body conflicts remain.
Replays do not create or reactivate sessions. Stored start responses are historical
command acknowledgements: even an `ACTIVE` response may identify a terminal or
unusable session now. Optional fields can be null in BSON-backed replay responses.
Always validate current context before workspace entry.

## Selected current context

`GET /api/v1/me/support-context` requires the existing bearer authentication and
`X-Support-Session-Id`. No query/body session selection or server-wide selected
session state exists. Unknown query properties are rejected. Missing/malformed
headers fail schema validation with `VALIDATION_FAILED` (400).

The endpoint checks current ACTIVE account and current Platform start authority,
then reuses Stage 16 runtime resolution. The existing global runtime hook validates
the selector; the response boundary revalidates using the same resolver. There is
no weaker duplicated session/policy validator. Actor, parent auth session, MFA,
restriction, Platform membership/permission, ACTIVE session, expiry, current
policy constraints, IP and applicable target/effective-membership binding remain
authoritative. A workspace-bound target is required for this endpoint; legacy
unbound start callers are unchanged and cannot bootstrap here.

The endpoint does not require `support.sessions.read`, `platform_workspaces.manage`
or a native membership. It supports membership-free WORKSPACE_SUPPORT. V1 uses
WORKSPACE_SUPPORT + READ_ONLY with explicit target workspace, reason, optional
reference and 1–60 minute duration. Sensitive access is deferred from Web V1.
Existing USER_CONTEXT/WRITE_SUPPORT Backend types remain unchanged.

Successful shape, with no additional properties:

```json
{
  "data": {
    "supportSession": {
      "id": "0123456789abcdef01234567",
      "status": "ACTIVE",
      "version": 0,
      "contextType": "WORKSPACE_SUPPORT",
      "sessionType": "READ_ONLY",
      "startedAt": "2026-10-12T12:00:00.000Z",
      "expiresAt": "2026-10-12T12:30:00.000Z",
      "policyRevision": 0
    },
    "workspace": {
      "id": "abcdef0123456789abcdef01",
      "name": "Workspace",
      "type": "GYM",
      "status": "ACTIVE",
      "timezone": "Africa/Cairo",
      "defaultLanguage": "ar"
    }
  }
}
```

`defaultLanguage` is the canonical workspace field. `policyRevision` is the
captured session revision for context identity; runtime does not compare simple
revision equality. Current policy contents are reevaluated. All versions are
nonnegative safe integers; timestamps are UTC ISO instants. Workspace ID is
derived exclusively from the validated session target.

Success represents validation at request time, not a durable authorization lease
or a guarantee every workspace route is available. Downstream calls must keep
sending the header and remain subject to runtime and service-specific checks.
Terminal sessions never return a successful context or `usable:false` envelope.

Canonical runtime errors include `SUPPORT_SESSION_NOT_FOUND` for malformed IDs
outside this endpoint's stricter schema, `SUPPORT_SESSION_INVALID`,
`SUPPORT_POLICY_NOT_FOUND`, actor/parent/IP mismatch, parent-invalid, not-active,
expired, policy-disabled/not-yet-valid/expired, target/session/duration/sensitive
policy denials, workspace/IP-not-allowed, and effective-context invalidity. An
unbound/missing workspace fails with `SUPPORT_WORKSPACE_DENIED`. No new lifecycle
status, policy-archived error or already-active error is introduced.

## Privacy, caching and compatibility

Responses exclude auth-session identifiers, tokens, actor user ID, IP/allowlists,
policy snapshots, permissions/grants, credential state, unrelated PII, signed URLs,
reason/reference and notification internals. All dedicated support management and
current-context responses, including errors and replays, explicitly send
`Cache-Control: private, no-store`. There is no ETag or persistent selected-session
contract. Web should keep its selector and start intent in memory and purge
context-bound data on exit or runtime failure.

Current-context GET creates no ordinary lifecycle audit/outbox/notification event.
Existing Stage 16 security termination can still write its existing evidence.
Replay authorization failures do not fabricate a successful start event.
Expiry is rejected immediately regardless of background row-status updates.

Administrative session detail still requires `support.sessions.read`. End own
still requires `support.sessions.end_own` plus ownership, and revoke still requires
`support.sessions.revoke`; both retain session-version CAS with no new idempotency
requirement. Policy mutation/revocation semantics and start-versus-disable/archive
runtime fail-closed invariants are unchanged. No migration or permission added.

Policy management/directory, complete active-session listing and history are
deferred. The session list remains an incomplete latest-100 administrative view;
policy list remains unbounded. Neither is a new complete Web directory contract.
