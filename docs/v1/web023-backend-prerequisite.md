# WEB-023 Backend security prerequisite

Baseline: `455523ac233e91258fd2b77aa6668865a5095e1a`. No new route, permission,
migration, retention policy, or lifecycle transition is introduced.

## Stage 17 response cache boundary

All four workspace export operations and five Platform deletion operations return
`Cache-Control: private, no-store`, including implicit HEAD responses and errors.
An `onSend` boundary is registered before authentication/support processing. It
classifies canonical matched route templates, including encoded static segments,
with exact raw-path fallback after stripping the query. Unrelated routes retain
their existing cache policy. WEB-022's support boundary is unchanged.

## Completed command replay

Export creation runs a current guard before idempotency resolution: authenticated
unrestricted session, support denial, native workspace membership and effective
`exports.workspace.create`, active workspace without deletion lock, and current
subscription eligibility. The original transactional mutation retains these checks.
Transaction reads run sequentially because MongoDB does not support concurrent
commands on a transaction session.

Deletion approval checks current authentication/restriction, support denial, MFA,
active Platform membership and effective `deletion.approve` before idempotency
resolution. The original mutation retains authorization too.

Both guards deny header-selected support even when a selector would not populate
resolved context. Existing support validation can reject earlier with its existing
error precedence. No Stage 16 support semantics change.

If currently allowed, replay returns the stored historical acknowledgement, not a
current resource read. Export replay does not check the active-export uniqueness
constraint as a new attempt. Approval replay does not rerun a transition, apply the
old expectedVersion to current state, claim subscriptions, restrict workspaces, or
terminate exports. Neither repeats audit/outbox writes. Availability denial leaves
the original completed idempotency record unchanged.

New acknowledgements on these two routes are normalized to JSON before storage,
preserving omitted optional response fields across BSON replay. Existing stored
acknowledgements remain unchanged. Response envelopes, keys/fingerprints, and
generic idempotency behavior are unchanged. Postpone/cancel remain CAS-only.

## Public export failure

Public failure is `{ code: string, retryable: false }`. `failure.message` is no
longer exposed by create/list/detail or other uses of the shared public mapper.
The mapper constructs the safe object explicitly. Internal records retain worker
diagnostics; no persisted schema change is required.

## Export downloads

The authenticated issuance endpoint remains authoritative for permissions, export
READY state, workspace availability and artifact availability. S3 GET signing keeps
attachment disposition and ZIP content type, and signs
`response-cache-control=private, no-store` inside the canonical query.

The requested deadline is `min(now + 2 minutes, export.expiresAt)`. Export callers
opt into hard-deadline signing, which rechecks time when signing, rounds down to
whole signature seconds, and returns the actual signed expiry. If less than one
full second remains, issuance is rejected rather than rounded upward. Elapsed or
unusable deadlines produce existing `EXPORT_NOT_READY`; no new HTTP error code.
The seven-day default READY TTL is unchanged.

`cacheControl` and `expiresAtIsHardDeadline` storage inputs are optional. Existing
Files/Documents upload/download behavior remains unchanged when they are absent.
Fake storage captures the inputs and models strict expiry for tests.

The response cache override requires provider-backed validation against the deployed
S3-compatible service. Local signature tests do not certify deployed headers,
download success, clock synchronization, proxy policy or storage revocation. This
is deployment/WEB-024 evidence. A presigned URL still grants storage access until
expiry/object removal; application permission changes do not revoke it immediately.
Expiry limits admission of new requests, not necessarily completion of an already
started transfer. Downloaded files and browser download history may persist.

## Deferred capabilities

- Export `meta.hasMore` remains false; Web must not promise complete history.
- Deletion cursor ordering remains unchanged; inventory limits must be truthful.
- No retention-state/warning inventory endpoint or policy editing.
- No Platform export endpoint or permission; exports remain native workspace scoped.
- No manual deletion-create, delete-now, restore, export cancellation or retry-job.
- Locked statuses, ZIP_JSON_V1, manifest version 1, active-export uniqueness,
  seven-day READY TTL and 180-day deletion eligibility defaults remain unchanged.

## Verification

Focused HTTP tests cover success/error cache policy, HEAD, encoded paths and
isolation, current-authority/availability loss on replay, historical responses,
duplication safety, support selectors and public privacy. Signing tests independently
recompute the signature with cache override, test deadline rounding/delay and prove
legacy options remain unchanged. Stage 13, Stage 16/WEB-022, idempotency and Stage 17
regressions remain required, followed by the canonical Backend suite and quality
checks. Tests use isolated disposable databases with the existing migrations only.
